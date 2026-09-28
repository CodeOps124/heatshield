/**
 * Enrollment + community-leader endpoints (the Community-lane story).
 *
 *   POST   /api/groups                              create a group -> admin key (shown once)
 *   GET    /api/groups/{groupId}                    public group name (for the join page)
 *   GET    /api/groups/{groupId}/dashboard          leader view   [x-admin-key]
 *   DELETE /api/groups/{groupId}/members/{id}       leader removes a member [x-admin-key]
 *   POST   /api/locations                           register a person/place (optionally into a group)
 *   GET    /api/locations/{locationId}              personal page  [x-manage-token]
 *   DELETE /api/locations/{locationId}              delete my data [x-manage-token]
 *
 * Auth model (deliberately minimal for a hackathon, but not naive): unguessable bearer
 * secrets (192-bit) issued once, stored only as SHA-256 hashes, compared in constant time,
 * sent in headers (the frontend keeps them in the URL #fragment, which browsers never send
 * to servers or leak via Referer).
 */
import { assessRisk, PROFILES, TIERS } from './heat.mjs';
import { isLanguage } from './languages.mjs';
import { roundCoord } from './weather.mjs';
import { HttpError, json, parseBody, header, router } from './http.mjs';
import { MAX_GROUP_MEMBERS } from './store.mjs';
import {
  ValidationError, cleanText, parseCoord, parseEmail, newId, hashSecret, secretMatches, mapLimit, log,
} from './util.mjs';

const ID_RE = /^[A-Za-z0-9_-]{8,40}$/;

function pathId(event, name) {
  const id = event.pathParameters?.[name];
  if (!id || !ID_RE.test(id)) throw new HttpError(404, 'not_found', 'Not found');
  return id;
}

/** Live risk for many locations, fetching each distinct ~1 km grid cell only once. */
async function riskForMany(weather, locations) {
  const cells = [...new Set(locations.map((l) => `${l.lat},${l.lon}`))];
  const forecasts = new Map();
  await mapLimit(cells, 6, async (cell) => {
    const [lat, lon] = cell.split(',').map(Number);
    try {
      forecasts.set(cell, await weather.getForecast(lat, lon));
    } catch (err) {
      log.warn('dashboard_forecast_failed', { cell, message: err.message });
    }
  });
  return locations.map((l) => {
    const f = forecasts.get(`${l.lat},${l.lon}`);
    return f ? assessRisk(f, l.profile) : null;
  });
}

function summarizeRisk(risk) {
  if (!risk) return null;
  return {
    localTime: risk.localTime,
    tier: risk.current.tier,
    tempC: risk.current.tempC,
    heatIndexC: risk.current.heatIndexC,
    heatIndexApplies: risk.current.heatIndexApplies,
    peak: risk.peak24h,
    rising: risk.trend.rising,
    riskWindow: risk.riskWindow,
    shouldAlert: risk.alert.shouldAlert,
    levelTier: risk.alert.levelTier,
    outlook: risk.outlook,
  };
}

export function createEnrollmentApi({ store, notifier, weather, now = () => Date.now() }) {
  async function requireGroupAdmin(event) {
    const groupId = pathId(event, 'groupId');
    const group = await store.getGroup(groupId);
    if (!group || !secretMatches(header(event, 'x-admin-key'), group.adminKeyHash)) {
      // Same response for "no such group" and "wrong key": do not reveal which groups exist.
      throw new HttpError(403, 'forbidden', 'This dashboard link is not valid.');
    }
    return group;
  }

  async function requireOwner(event) {
    const locationId = pathId(event, 'locationId');
    const location = await store.getLocation(locationId);
    if (!location || !secretMatches(header(event, 'x-manage-token'), location.manageTokenHash)) {
      throw new HttpError(403, 'forbidden', 'This link is not valid.');
    }
    return location;
  }

  async function removeLocation(location) {
    if (location.subscriptionArn) {
      try {
        await notifier.unsubscribe(location.subscriptionArn);
      } catch (err) {
        log.warn('unsubscribe_failed', { locationId: location.locationId, message: err.message });
      }
    }
    await store.deleteAlertsFor(location.locationId);
    await store.deleteLocation(location.locationId);
  }

  return router({
    'POST /api/groups': async (event) => {
      const body = parseBody(event);
      const name = cleanText(body.name, 60);
      if (!name) throw new ValidationError('Give your group a name');
      const groupId = newId(9);
      const adminKey = newId(24);
      await store.createGroup({
        groupId,
        name,
        adminKeyHash: hashSecret(adminKey),
        createdAt: new Date(now()).toISOString(),
      });
      log.info('group_created', { groupId });
      return json(201, { groupId, name, adminKey });
    },

    'GET /api/groups/{groupId}': async (event) => {
      const group = await store.getGroup(pathId(event, 'groupId'));
      if (!group) throw new HttpError(404, 'not_found', 'This invite link is not valid.');
      return json(200, { groupId: group.groupId, name: group.name, readOnly: Boolean(group.readOnly) });
    },

    'GET /api/groups/{groupId}/dashboard': async (event) => {
      const group = await requireGroupAdmin(event);
      const members = (await store.listGroupMembers(group.groupId)).slice(0, MAX_GROUP_MEMBERS);
      const [risks, lastAlerts] = await Promise.all([
        riskForMany(weather, members),
        mapLimit(members, 10, (m) => store.getLastAlert(m.locationId).catch(() => null)),
      ]);

      const rows = members.map((m, i) => ({
        locationId: m.locationId,
        name: m.name,
        placeName: m.placeName,
        countryCode: m.countryCode ?? null,
        profile: m.profile,
        profileLabel: PROFILES[m.profile]?.label ?? m.profile,
        alertTier: PROFILES[m.profile]?.alertTier ?? null,
        language: m.language,
        hasEmailAlerts: Boolean(m.subscriptionArn),
        joinedAt: m.createdAt,
        risk: summarizeRisk(risks[i]),
        lastAlert: lastAlerts[i]
          ? {
              date: lastAlerts[i].alertDate,
              tier: lastAlerts[i].tier,
              status: lastAlerts[i].status,
              channel: lastAlerts[i].channel ?? null,
              sentAt: lastAlerts[i].sentAt ?? lastAlerts[i].claimedAt ?? null,
            }
          : null,
      }));

      const byTier = Object.fromEntries(TIERS.map((t) => [t, 0]));
      let needAttention = 0;
      for (const r of rows) {
        if (r.risk) byTier[r.risk.tier] += 1;
        if (r.risk?.shouldAlert) needAttention += 1;
      }

      return json(200, {
        group: { groupId: group.groupId, name: group.name, createdAt: group.createdAt, readOnly: Boolean(group.readOnly) },
        summary: { members: rows.length, needAttention, byTier },
        members: rows,
        generatedAt: new Date(now()).toISOString(),
      });
    },

    'DELETE /api/groups/{groupId}/members/{locationId}': async (event) => {
      const group = await requireGroupAdmin(event);
      if (group.readOnly) throw new HttpError(403, 'read_only', 'This demo group is read-only.');
      const location = await store.getLocation(pathId(event, 'locationId'));
      if (!location || location.groupId !== group.groupId) throw new HttpError(404, 'not_found', 'Member not found');
      await removeLocation(location);
      log.info('member_removed_by_leader', { groupId: group.groupId, locationId: location.locationId });
      return json(200, { deleted: true });
    },

    'POST /api/locations': async (event) => {
      const body = parseBody(event);
      const name = cleanText(body.name, 40);
      if (!name) throw new ValidationError('Please add a name or nickname');
      const placeName = cleanText(body.placeName, 80);
      if (!placeName) throw new ValidationError('Please choose a place');
      const countryCode = cleanText(body.countryCode, 2);
      const lat = roundCoord(parseCoord(body.lat, 'lat'));
      const lon = roundCoord(parseCoord(body.lon, 'lon'));
      const profile = body.profile;
      if (!Object.hasOwn(PROFILES, profile)) throw new ValidationError('Please choose a risk profile');
      const language = body.language ?? 'en';
      if (!isLanguage(language)) throw new ValidationError('Please choose a supported language');
      const email = parseEmail(body.email);

      let groupId = null;
      if (body.groupId) {
        if (typeof body.groupId !== 'string' || !ID_RE.test(body.groupId)) throw new ValidationError('Invalid group');
        const group = await store.getGroup(body.groupId);
        if (!group) throw new HttpError(404, 'not_found', 'This invite link is not valid.');
        if (group.readOnly) throw new HttpError(403, 'read_only', 'This demo group is read-only and cannot take new members.');
        const members = await store.listGroupMembers(group.groupId);
        if (members.length >= MAX_GROUP_MEMBERS) {
          throw new HttpError(409, 'group_full', `This group already has ${MAX_GROUP_MEMBERS} members.`);
        }
        groupId = group.groupId;
      }

      const locationId = newId(12);
      const manageToken = newId(24);
      let subscriptionArn = null;
      if (email) subscriptionArn = await notifier.subscribeEmail(email, locationId);

      const item = {
        locationId,
        name,
        placeName,
        countryCode: countryCode ? countryCode.toUpperCase() : null,
        lat,
        lon,
        profile,
        language,
        manageTokenHash: hashSecret(manageToken),
        createdAt: new Date(now()).toISOString(),
      };
      if (groupId) item.groupId = groupId; // sparse GSI: only grouped locations are indexed
      if (subscriptionArn) item.subscriptionArn = subscriptionArn;
      await store.createLocation(item);
      log.info('location_registered', { locationId, groupId, profile, language, email: Boolean(email) });

      return json(201, { locationId, manageToken, emailConfirmationSent: Boolean(subscriptionArn) });
    },

    'GET /api/locations/{locationId}': async (event) => {
      const loc = await requireOwner(event);
      let emailStatus = 'none';
      if (loc.subscriptionArn) {
        emailStatus = await notifier.subscriptionStatus(loc.subscriptionArn).catch(() => 'unknown');
      }
      const [group, lastAlert] = await Promise.all([
        loc.groupId ? store.getGroup(loc.groupId) : null,
        store.getLastAlert(loc.locationId),
      ]);
      return json(200, {
        location: {
          locationId: loc.locationId,
          name: loc.name,
          placeName: loc.placeName,
          countryCode: loc.countryCode,
          lat: loc.lat,
          lon: loc.lon,
          profile: loc.profile,
          language: loc.language,
          createdAt: loc.createdAt,
          emailStatus,
          group: group ? { groupId: group.groupId, name: group.name } : null,
        },
        lastAlert: lastAlert
          ? { date: lastAlert.alertDate, tier: lastAlert.tier, status: lastAlert.status, sentAt: lastAlert.sentAt ?? null }
          : null,
      });
    },

    'DELETE /api/locations/{locationId}': async (event) => {
      const loc = await requireOwner(event);
      await removeLocation(loc);
      log.info('location_deleted_by_owner', { locationId: loc.locationId });
      return json(200, { deleted: true });
    },
  });
}
