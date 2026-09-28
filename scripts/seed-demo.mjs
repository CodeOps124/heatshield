#!/usr/bin/env node
/**
 * Seeds the public, READ-ONLY demo group through the live API (exactly the path a real leader
 * uses), then marks it read-only in DynamoDB and publishes /demo.json so the home page links to it.
 *   node scripts/seed-demo.mjs
 * Members are fictional people in real, hot places; forecasts are live. No emails are registered.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const outputs = JSON.parse(readFileSync(join(ROOT, '.deploy-outputs.json'), 'utf8'));
const cfgText = readFileSync(join(ROOT, 'infra', 'samconfig.toml'), 'utf8');
const get = (key) => cfgText.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, 'm'))?.[1];
const awsArgs = ['--region', get('region'), ...(get('profile') ? ['--profile', get('profile')] : [])];
const BASE = outputs.SiteUrl;

const MEMBERS = [
  { name: 'Asif (site crew)', placeName: 'Karachi, Pakistan', countryCode: 'PK', lat: 24.86, lon: 67.01, profile: 'outdoor_worker', language: 'ur' },
  { name: 'Mariam (delivery rider)', placeName: 'Dubai, United Arab Emirates', countryCode: 'AE', lat: 25.2, lon: 55.27, profile: 'outdoor_worker', language: 'ar' },
  { name: 'Dadi (lives alone)', placeName: 'New Delhi, India', countryCode: 'IN', lat: 28.61, lon: 77.21, profile: 'elderly', language: 'hi' },
  { name: 'Seu João', placeName: 'Cuiabá, Brazil', countryCode: 'BR', lat: -15.6, lon: -56.1, profile: 'elderly', language: 'pt' },
  { name: 'Rosa (farm crew)', placeName: 'Phoenix, United States', countryCode: 'US', lat: 33.45, lon: -112.07, profile: 'outdoor_worker', language: 'es' },
  { name: 'Tobi (age 3)', placeName: 'Lagos, Nigeria', countryCode: 'NG', lat: 6.45, lon: 3.39, profile: 'child', language: 'en' },
  { name: 'Lan', placeName: 'Ho Chi Minh City, Vietnam', countryCode: 'VN', lat: 10.82, lon: 106.63, profile: 'pregnant', language: 'vi' },
  { name: 'Kamal (heart condition)', placeName: 'Dhaka, Bangladesh', countryCode: 'BD', lat: 23.81, lon: 90.41, profile: 'chronic_condition', language: 'bn' },
  { name: 'Juma (port worker)', placeName: 'Mombasa, Kenya', countryCode: 'KE', lat: -4.04, lon: 39.67, profile: 'outdoor_worker', language: 'sw' },
  { name: 'Maria', placeName: 'Manila, Philippines', countryCode: 'PH', lat: 14.6, lon: 120.98, profile: 'general', language: 'tl' },
];

async function post(path, body) {
  const res = await fetch(`${BASE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${JSON.stringify(data)}`);
  return data;
}

const group = await post('/api/groups', { name: 'Global outreach network (demo)' });
console.log(`Created group ${group.groupId}`);
for (const m of MEMBERS) {
  const r = await post('/api/locations', { ...m, groupId: group.groupId });
  console.log(`  + ${m.name} (${m.placeName}) -> ${r.locationId}`);
}

// Lock it: the demo dashboard link is public, so nobody may add or remove members.
execFileSync('aws', [
  'dynamodb', 'update-item', '--table-name', outputs.GroupsTableName,
  '--key', JSON.stringify({ groupId: { S: group.groupId } }),
  '--update-expression', 'SET readOnly = :t',
  '--expression-attribute-values', JSON.stringify({ ':t': { BOOL: true } }),
  ...awsArgs,
], { stdio: 'inherit' });

const dashboardPath = `/group.html#g=${group.groupId}&k=${group.adminKey}`;
writeFileSync(join(ROOT, 'frontend', 'demo.json'), `${JSON.stringify({ groupId: group.groupId, dashboardPath }, null, 2)}\n`);
console.log(`\nDemo dashboard: ${BASE}${dashboardPath}`);
console.log('Now run: node scripts/deploy.mjs --site-only   (publishes demo.json)');
