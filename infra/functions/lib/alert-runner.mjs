/**
 * Scheduled alert loop (EventBridge Scheduler -> this, hourly).
 *
 * For every registered location:
 *   1. fetch the forecast (one call per ~1 km grid cell, shared by everyone in it)
 *   2. assess risk for that person's profile
 *   3. skip quiet hours (21:00–05:59 local) — an early-warning at 3 a.m. helps nobody; the
 *      06:00 run warns about the afternoon peak before the day starts
 *   4. if the worst tier in the next 12 h reaches the profile's alert tier, atomically claim
 *      today's alert slot (one alert per tier escalation per local day), generate localized
 *      guidance (cached), and publish to SNS. Delivery failure releases the claim -> retried
 *      next hour.
 *
 * Manual trigger for demos/proof:  {"forceLocationId": "<id>"}  sends one alert now,
 * bypassing quiet hours and threshold; below-threshold sends are labelled as a TEST.
 */
import { assessRisk, tierRank, TIER_LABELS, PROFILES } from './heat.mjs';
import { toAscii, mapLimit } from './util.mjs';

const QUIET_START = 21;
const QUIET_END = 6;

const LABELS = {
  en: { todo: 'What to do', help: 'Get help now', now: 'Now', peak: 'Worst in the next 24 h', window: 'Risky hours' },
  es: { todo: 'Qué hacer', help: 'Pide ayuda ya si', now: 'Ahora', peak: 'Lo peor en las próximas 24 h', window: 'Horas de riesgo' },
  fr: { todo: 'Que faire', help: 'Demandez de l’aide si', now: 'Maintenant', peak: 'Pic dans les prochaines 24 h', window: 'Heures à risque' },
  pt: { todo: 'O que fazer', help: 'Peça ajuda já se', now: 'Agora', peak: 'Pior nas próximas 24 h', window: 'Horas de risco' },
};

const fmtC = (c) => `${Math.round(c)} °C (${Math.round((c * 9) / 5 + 32)} °F)`;

export function formatAlert({ location, risk, guidance, siteUrl, test = false }) {
  const L = LABELS[guidance.language] ?? LABELS.en;
  const tier = TIER_LABELS[risk.alert.levelTier];
  const place = toAscii(location.placeName) || 'your area';
  const subject = `${test ? '[TEST] ' : ''}HeatShield: ${tier} heat risk - ${place}`.slice(0, 99);

  const lines = [
    `HeatShield · ${location.placeName}`,
    '',
    guidance.headline,
    '',
    `${L.todo}:`,
    ...guidance.actions.map((a, i) => `  ${i + 1}. ${a}`),
    '',
    `${L.help}: ${guidance.seekHelp}`,
    '',
    '—',
    `${L.now}: ${TIER_LABELS[risk.current.tier]} · ${risk.current.heatIndexApplies ? `heat index ${fmtC(risk.current.heatIndexC)}` : `air ${fmtC(risk.current.tempC)}`}`,
    `${L.peak}: ${TIER_LABELS[risk.peak24h.tier]} around ${risk.peak24h.label}${risk.peak24h.isTomorrow ? ' (tomorrow)' : ''} · ${fmtC(risk.peak24h.heatIndexC)}`,
  ];
  if (risk.riskWindow) lines.push(`${L.window}: ${risk.riskWindow.label}`);
  lines.push(
    `Profile: ${PROFILES[location.profile]?.label ?? location.profile} (alerts from ${TIER_LABELS[risk.profile.alertTier]})`,
    '',
    test ? 'This is a TEST alert sent on request; current conditions may be below your alert level.' : '',
    'Guidance is AI-generated (Amazon Bedrock) from CDC/NIOSH public-health advice. It is not medical care.',
    'In an emergency, call your local emergency number.',
    guidance.languageFallback ? 'Guidance is shown in English because your language was temporarily unavailable.' : '',
    siteUrl ? `HeatShield: ${siteUrl}` : '',
  );
  return { subject, message: lines.filter((l, i, arr) => l !== '' || arr[i - 1] !== '').join('\n') };
}

export async function runAlertCheck({ store, weather, guidance, notifier, log, siteUrl, forceLocationId = null }) {
  const summary = { checked: 0, sent: 0, dashboardOnly: 0, quiet: 0, belowThreshold: 0, alreadyAlerted: 0, errors: 0 };

  let locations;
  if (forceLocationId) {
    const one = await store.getLocation(forceLocationId);
    if (!one) throw new Error(`No location ${forceLocationId}`);
    locations = [one];
  } else {
    locations = await store.listAllLocations();
  }

  const cells = [...new Set(locations.map((l) => `${l.lat},${l.lon}`))];
  const forecasts = new Map();
  await mapLimit(cells, 5, async (cell) => {
    const [lat, lon] = cell.split(',').map(Number);
    try {
      forecasts.set(cell, await weather.getForecast(lat, lon));
    } catch (err) {
      summary.errors += 1;
      log.warn('alert_forecast_failed', { cell, message: err.message });
    }
  });

  await mapLimit(locations, 5, async (location) => {
    const forecast = forecasts.get(`${location.lat},${location.lon}`);
    if (!forecast) return;
    summary.checked += 1;
    const forced = location.locationId === forceLocationId;
    try {
      const risk = assessRisk(forecast, location.profile);
      const quiet = risk.localHour >= QUIET_START || risk.localHour < QUIET_END;
      if (!forced && quiet) {
        summary.quiet += 1;
        return;
      }
      if (!forced && !risk.alert.shouldAlert) {
        summary.belowThreshold += 1;
        return;
      }

      const alertDate = risk.localTime.slice(0, 10);
      const tier = risk.alert.levelTier;
      const claimed = await store.claimAlert({
        locationId: location.locationId, alertDate, tier, tierRank: tierRank(tier), forced,
      });
      if (!claimed) {
        summary.alreadyAlerted += 1;
        return;
      }

      if (!location.subscriptionArn) {
        // Nobody to email (e.g. a member enrolled by a leader without contact details):
        // record the alert so it shows on the leader's dashboard.
        await store.finalizeAlert({ locationId: location.locationId, alertDate, status: 'dashboard_only', channel: 'dashboard' });
        summary.dashboardOnly += 1;
        log.info('alert_recorded_dashboard_only', { locationId: location.locationId, tier, forced });
        return;
      }

      try {
        const g = await guidance.getGuidance(risk, location.language);
        const { subject, message } = formatAlert({
          location, risk, guidance: g, siteUrl, test: forced && !risk.alert.shouldAlert,
        });
        const messageId = await notifier.publishAlert({ locationId: location.locationId, subject, message });
        await store.finalizeAlert({ locationId: location.locationId, alertDate, status: 'sent', messageId, channel: 'email' });
        summary.sent += 1;
        log.info('alert_sent', { locationId: location.locationId, tier, messageId, guidanceSource: g.source, forced });
      } catch (err) {
        await store.releaseAlert({ locationId: location.locationId, alertDate });
        throw err;
      }
    } catch (err) {
      summary.errors += 1;
      log.error('alert_failed', { locationId: location.locationId, name: err.name, message: err.message });
    }
  });

  log.info('alert_check_complete', summary);
  return summary;
}
