#!/usr/bin/env node
/**
 * Local development server — no AWS account needed.
 *   node scripts/dev-server.mjs            -> http://localhost:8787
 *
 * Serves frontend/ and routes /api/* through the SAME route handlers the Lambdas use, with:
 *   - real Open-Meteo weather (live data)
 *   - an in-memory store instead of DynamoDB (data is lost on restart)
 *   - Bedrock replaced by a stub that fails, so you see the static fallback guidance path
 *   - a console "notifier" instead of SNS
 * The deployed app on AWS uses DynamoDB, Bedrock and SNS for real.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicApi } from '../infra/functions/lib/public-routes.mjs';
import { createEnrollmentApi } from '../infra/functions/lib/enrollment-routes.mjs';
import { createWeatherClient } from '../infra/functions/lib/weather.mjs';
import { createGuidanceService } from '../infra/functions/lib/guidance.mjs';
import { createStore } from '../infra/functions/lib/store.mjs';
import { log } from '../infra/functions/lib/util.mjs';
import { createAgentLog } from '../infra/functions/lib/agent-log.mjs';
import { createAgentsApi } from '../infra/functions/lib/agents-api.mjs';
import { createFakeDb } from '../infra/tests/helpers.mjs';

const PORT = Number(process.env.PORT ?? 8787);
// HEATSHIELD_PROXY=https://<your-site> serves local frontend files but forwards /api/* to the live
// deployment — handy for working on the UI (e.g. Agent HQ) against real agent data.
const PROXY = process.env.HEATSHIELD_PROXY?.replace(/\/$/, '') ?? null;
const ROOT = fileURLToPath(new URL('../frontend/', import.meta.url));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };

const { db, tables } = createFakeDb();
const store = createStore({ db, tables });
const weather = createWeatherClient();
const guidance = createGuidanceService({
  converse: async () => { throw new Error('Bedrock is not available in local dev'); },
  cache: store.guidanceCache,
  models: ['local-stub'],
  log: { info() {}, warn() {}, error: log.error },
});
const notifier = {
  subscribeEmail: async (email, locationId) => { console.log(`[dev] would subscribe ${email} for ${locationId}`); return `arn:dev:${locationId}`; },
  unsubscribe: async (arn) => console.log(`[dev] would unsubscribe ${arn}`),
  subscriptionStatus: async () => 'pending',
  publishAlert: async ({ subject }) => { console.log(`[dev] would publish: ${subject}`); return 'dev-message'; },
};

const agentLog = createAgentLog({ db, table: tables.agentLog });
const publicApi = createPublicApi({
  weather, guidance, version: 'local-dev', region: 'local', agentLog,
  agentsApi: createAgentsApi({ agentLog }),
  runAgentNow: async (id) => ({ outcome: 'local', summary: `${id} runs on AWS only; start the dev server with HEATSHIELD_PROXY to use the live agents.` }),
});
const enrollmentApi = createEnrollmentApi({ store, notifier, weather, agentLog });

// Route table mirrors infra/template.yaml
const ROUTES = [
  ['GET', '/api/health', publicApi], ['GET', '/api/geocode', publicApi], ['GET', '/api/risk', publicApi], ['GET', '/api/guidance', publicApi],
  ['GET', '/api/agents', publicApi], ['POST', '/api/agents/{agentId}/run', publicApi],
  ['POST', '/api/groups', enrollmentApi], ['GET', '/api/groups/{groupId}', enrollmentApi], ['DELETE', '/api/groups/{groupId}', enrollmentApi],
  ['GET', '/api/groups/{groupId}/dashboard', enrollmentApi], ['POST', '/api/groups/{groupId}/plan', enrollmentApi],
  ['DELETE', '/api/groups/{groupId}/members/{locationId}', enrollmentApi],
  ['POST', '/api/locations', enrollmentApi], ['GET', '/api/locations/{locationId}', enrollmentApi], ['DELETE', '/api/locations/{locationId}', enrollmentApi],
];

function match(method, path) {
  for (const [m, pattern, handler] of ROUTES) {
    if (m !== method) continue;
    const names = [];
    const re = new RegExp(`^${pattern.replace(/\{(\w+)\}/g, (_, n) => { names.push(n); return '([^/]+)'; })}$`);
    const hit = path.match(re);
    if (hit) return { routeKey: `${m} ${pattern}`, handler, pathParameters: Object.fromEntries(names.map((n, i) => [n, decodeURIComponent(hit[i + 1])])) };
  }
  return null;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (url.pathname.startsWith('/api/') && PROXY) {
      let body;
      if (!['GET', 'HEAD'].includes(req.method)) { body = ''; for await (const chunk of req) body += chunk; }
      const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => ['content-type', 'x-admin-key', 'x-manage-token'].includes(k.toLowerCase())));
      const upstream = await fetch(`${PROXY}${url.pathname}${url.search}`, { method: req.method, headers, body: body || undefined });
      res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' });
      res.end(Buffer.from(await upstream.arrayBuffer()));
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      const route = match(req.method, url.pathname);
      if (!route) { res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":{"code":"not_found"}}'); return; }
      let body = '';
      for await (const chunk of req) body += chunk;
      const out = await route.handler({
        routeKey: route.routeKey,
        pathParameters: route.pathParameters,
        queryStringParameters: Object.fromEntries(url.searchParams),
        headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), v])),
        body: body || undefined,
        isBase64Encoded: false,
      });
      res.writeHead(out.statusCode, out.headers).end(out.body);
      return;
    }
    const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const file = normalize(join(ROOT, rel));
    if (!file.startsWith(normalize(ROOT))) { res.writeHead(403).end(); return; }
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(data);
  } catch (err) {
    if (err.code === 'ENOENT') { res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found'); return; }
    console.error(err);
    res.writeHead(500).end('Internal error');
  }
});

server.listen(PORT, () => console.log(`HeatShield dev server: http://localhost:${PORT}`));
