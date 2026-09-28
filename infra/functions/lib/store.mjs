/**
 * Domain data access for HeatShield, written against a tiny generic adapter
 * (`get/put/query/delete/update/scanAll`) so the logic is testable without AWS.
 * The DynamoDB implementation of the adapter lives in aws.mjs.
 *
 * Tables
 *   Groups         PK groupId                         a community leader's group
 *   Locations      PK locationId   GSI byGroup(groupId) one person / place being watched
 *   Alerts         PK locationId   SK alertDate        one row per person per local day (dedupe)
 *   GuidanceCache  PK cacheKey                         Bedrock output cache (TTL)
 *
 * PII minimisation: we never store email addresses (the SNS subscription holds them), never
 * store exact coordinates (rounded to ~1 km), and store only hashes of bearer secrets.
 */

export const MAX_GROUP_MEMBERS = 200;
const ALERT_TTL_DAYS = 30;

export function createStore({ db, tables, nowSeconds = () => Math.floor(Date.now() / 1000) }) {
  return {
    // ---------------- groups ----------------
    createGroup: (group) =>
      db.put({ table: tables.groups, item: group, condition: 'attribute_not_exists(groupId)' }),

    getGroup: (groupId) => db.get({ table: tables.groups, key: { groupId } }),

    listAllGroups: () => db.scanAll({ table: tables.groups }),

    // ---------------- locations ----------------
    createLocation: (location) =>
      db.put({ table: tables.locations, item: location, condition: 'attribute_not_exists(locationId)' }),

    getLocation: (locationId) => db.get({ table: tables.locations, key: { locationId } }),

    deleteLocation: (locationId) => db.delete({ table: tables.locations, key: { locationId } }),

    listGroupMembers: (groupId) =>
      db.query({
        table: tables.locations,
        index: 'byGroup',
        keyCondition: 'groupId = :g',
        values: { ':g': groupId },
        limit: MAX_GROUP_MEMBERS + 1,
      }),

    listAllLocations: () => db.scanAll({ table: tables.locations }),

    // ---------------- alerts ----------------
    getLastAlert: async (locationId) => {
      const items = await db.query({
        table: tables.alerts,
        keyCondition: 'locationId = :l',
        values: { ':l': locationId },
        limit: 1,
        forward: false,
      });
      return items[0] ?? null;
    },

    /**
     * Atomically claim the right to alert this person today at this tier. Succeeds only if no
     * alert exists for (locationId, localDate) or the stored one was for a LOWER tier — so a
     * person gets at most one alert per tier escalation per day, even if two scheduler runs
     * overlap. Returns false when someone already holds the claim.
     */
    claimAlert: async ({ locationId, alertDate, tier, tierRank, forced = false }) => {
      try {
        await db.put({
          table: tables.alerts,
          item: {
            locationId,
            alertDate,
            tier,
            tierRank,
            status: 'sending',
            forced,
            claimedAt: nowSeconds(),
            expiresAt: nowSeconds() + ALERT_TTL_DAYS * 86400,
          },
          condition: forced ? undefined : 'attribute_not_exists(alertDate) OR tierRank < :r',
          values: forced ? undefined : { ':r': tierRank },
        });
        return true;
      } catch (err) {
        if (err.name === 'ConditionalCheckFailedException') return false;
        throw err;
      }
    },

    finalizeAlert: ({ locationId, alertDate, status, messageId = null, channel }) =>
      db.update({
        table: tables.alerts,
        key: { locationId, alertDate },
        update: 'SET #s = :s, messageId = :m, channel = :c, sentAt = :t',
        names: { '#s': 'status' },
        values: { ':s': status, ':m': messageId, ':c': channel, ':t': nowSeconds() },
      }),

    /** Undo a claim when delivery failed, so the next scheduled run retries. */
    releaseAlert: ({ locationId, alertDate }) => db.delete({ table: tables.alerts, key: { locationId, alertDate } }),

    deleteAlertsFor: async (locationId) => {
      const items = await db.query({
        table: tables.alerts,
        keyCondition: 'locationId = :l',
        values: { ':l': locationId },
        limit: 100,
      });
      await Promise.all(items.map((a) => db.delete({ table: tables.alerts, key: { locationId, alertDate: a.alertDate } })));
    },

    // ---------------- guidance cache ----------------
    guidanceCache: {
      get: (cacheKey) => db.get({ table: tables.guidanceCache, key: { cacheKey } }),
      put: (entry) => db.put({ table: tables.guidanceCache, item: entry }),
    },
  };
}
