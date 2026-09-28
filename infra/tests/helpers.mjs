/** Test doubles: an in-memory stand-in for the DynamoDB adapter, and forecast builders. */

const KEYS = {
  groups: ['groupId'],
  locations: ['locationId'],
  alerts: ['locationId', 'alertDate'],
  guidanceCache: ['cacheKey'],
  agentLog: ['pk', 'sk'],
};

function conditionalError() {
  const err = new Error('The conditional request failed');
  err.name = 'ConditionalCheckFailedException';
  return err;
}

/** Evaluates the handful of condition expressions store.mjs uses. */
function evaluate(condition, existing, values = {}) {
  return condition.split(/\s+OR\s+/).some((clause) => {
    const notExists = clause.match(/^attribute_not_exists\((\w+)\)$/);
    if (notExists) return !existing || existing[notExists[1]] === undefined;
    const lt = clause.match(/^(\w+) < (:\w+)$/);
    if (lt) return Boolean(existing) && existing[lt[1]] < values[lt[2]];
    throw new Error(`Fake DB cannot evaluate "${clause}"`);
  });
}

export function createFakeDb() {
  const data = { groups: new Map(), locations: new Map(), alerts: new Map(), guidanceCache: new Map(), agentLog: new Map() };
  const tables = { groups: 'groups', locations: 'locations', alerts: 'alerts', guidanceCache: 'guidanceCache', agentLog: 'agentLog' };
  const keyOf = (table, obj) => KEYS[table].map((k) => obj[k]).join('|');
  const clone = (x) => (x ? structuredClone(x) : null);

  const db = {
    data,
    async get({ table, key }) {
      return clone(data[table].get(keyOf(table, key)));
    },
    async put({ table, item, condition, values }) {
      const existing = data[table].get(keyOf(table, item));
      if (condition && !evaluate(condition, existing, values)) throw conditionalError();
      data[table].set(keyOf(table, item), clone(item));
    },
    async update({ table, key, names = {}, values }) {
      const existing = data[table].get(keyOf(table, key)) ?? { ...key };
      // Only supports the "SET a = :a, b = :b" form used by finalizeAlert.
      existing[names['#s'] ? 'status' : 'status'] = values[':s'];
      existing.messageId = values[':m'];
      existing.channel = values[':c'];
      existing.sentAt = values[':t'];
      data[table].set(keyOf(table, key), existing);
    },
    async delete({ table, key }) {
      data[table].delete(keyOf(table, key));
    },
    async query({ table, index, values, limit = 100, forward = true }) {
      let items = [...data[table].values()];
      if (table === 'agentLog') {
        items = items.filter((i) => i.pk === values[':p']).sort((a, b) => a.sk.localeCompare(b.sk) * (forward ? 1 : -1));
        return items.slice(0, limit).map(clone);
      }
      if (index === 'byGroup') items = items.filter((i) => i.groupId === values[':g']);
      else items = items.filter((i) => i.locationId === values[':l']);
      if (table === 'alerts') items.sort((a, b) => a.alertDate.localeCompare(b.alertDate) * (forward ? 1 : -1));
      return items.slice(0, limit).map(clone);
    },
    async scanAll({ table }) {
      return [...data[table].values()].map(clone);
    },
  };
  return { db, tables };
}

const pad = (n) => String(n).padStart(2, '0');

/** Local ISO hour strings starting at `start` ("YYYY-MM-DD"), `count` hours long. */
function hoursFrom(start, count) {
  const base = Date.parse(`${start}T00:00:00Z`);
  return Array.from({ length: count }, (_, i) => {
    const d = new Date(base + i * 3600_000);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:00`;
  });
}

/**
 * Build a normalized forecast (the shape weather.mjs produces).
 * @param {object} o
 * @param {number} o.nowHour  index of the current hour within day 1
 * @param {(i:number, hourOfDay:number) => number} o.temp  °C for hour index i
 * @param {(i:number, hourOfDay:number) => number} o.rh    % for hour index i
 */
export function makeForecast({ nowHour = 9, temp, rh, days = 4, start = '2026-07-01', uvMax = 9 }) {
  const times = hoursFrom(start, days * 24);
  const hourly = times.map((time, i) => ({ time, tempC: temp(i, i % 24), rh: rh(i, i % 24), uv: null }));
  const cur = hourly[nowHour];
  return {
    timezone: 'Test/Zone',
    utcOffsetSeconds: 0,
    current: { time: cur.time.replace(':00', ':15'), tempC: cur.tempC, rh: cur.rh, isDay: true },
    hourly,
    daily: Array.from({ length: days }, (_, d) => ({ date: times[d * 24].slice(0, 10), tMaxC: null, tMinC: null, uvMax })),
  };
}

/** Diurnal (cosine) curve: max at 15:00, min at 03:00. */
export const diurnal = (min, max) => (_i, h) => {
  const phase = Math.cos(((h - 15) / 24) * 2 * Math.PI);
  return min + ((max - min) * (phase + 1)) / 2;
};

export const silentLog = { info() {}, warn() {}, error() {} };

export function apiEvent(routeKey, { query, body, headers, pathParameters } = {}) {
  return {
    routeKey,
    queryStringParameters: query,
    pathParameters,
    headers: headers ?? {},
    body: body === undefined ? undefined : JSON.stringify(body),
    isBase64Encoded: false,
  };
}

export const parse = (res) => ({ status: res.statusCode, body: JSON.parse(res.body) });
