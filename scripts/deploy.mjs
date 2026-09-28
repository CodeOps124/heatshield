#!/usr/bin/env node
/**
 * One-command deploy (Windows / macOS / Linux):
 *   node scripts/deploy.mjs                 full: test -> lint -> sam build -> sam deploy -> upload site -> smoke test
 *   node scripts/deploy.mjs --site-only     re-upload the frontend only
 *
 * Reads infra/samconfig.toml (stack name, region, profile) and infra/params.json (stack parameters).
 * Writes .deploy-outputs.json (stack outputs; git-ignored) and frontend/version.json (build marker).
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const INFRA = join(ROOT, 'infra');
const args = new Set(process.argv.slice(2));
const isWin = process.platform === 'win32';

function run(cmd, cmdArgs, { cwd = ROOT, capture = false } = {}) {
  console.log(`\n$ ${cmd} ${cmdArgs.join(' ')}`);
  const out = execFileSync(cmd, cmdArgs, {
    cwd,
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    encoding: 'utf8',
    // aws.exe / sam.exe resolve without a shell; npm is a .cmd shim on Windows and needs one.
    // (A shell would also mangle JSON arguments, so it is used for npm only.)
    shell: isWin && cmd === 'npm',
  });
  return capture ? out.trim() : '';
}

function samconfig() {
  const text = readFileSync(join(INFRA, 'samconfig.toml'), 'utf8');
  const get = (key) => text.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, 'm'))?.[1];
  return { stack: get('stack_name'), region: get('region'), profile: get('profile') };
}

const cfg = samconfig();
const awsArgs = ['--region', cfg.region, ...(cfg.profile ? ['--profile', cfg.profile] : [])];

function gitVersion() {
  try {
    const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
    const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).trim() ? '-dirty' : '';
    return `${sha}${dirty}`;
  } catch {
    return 'unversioned';
  }
}

function stackOutputs() {
  const json = run('aws', ['cloudformation', 'describe-stacks', '--stack-name', cfg.stack, '--query', 'Stacks[0].Outputs', '--output', 'json', ...awsArgs], { capture: true });
  return Object.fromEntries(JSON.parse(json).map((o) => [o.OutputKey, o.OutputValue]));
}

const version = gitVersion();

if (!args.has('--site-only')) {
  if (!args.has('--skip-tests')) run('npm', ['test']);
  run('sam', ['validate', '--lint'], { cwd: INFRA });
  run('sam', ['build'], { cwd: INFRA });
  const params = JSON.parse(readFileSync(join(INFRA, 'params.json'), 'utf8'));
  const overrides = Object.entries({ ...params, AppVersion: version }).map(([k, v]) => `${k}=${v}`);
  run('sam', ['deploy', '--no-fail-on-empty-changeset', '--parameter-overrides', ...overrides], { cwd: INFRA });
}

const outputs = stackOutputs();
writeFileSync(join(ROOT, '.deploy-outputs.json'), `${JSON.stringify({ ...outputs, version, deployedAt: new Date().toISOString() }, null, 2)}\n`);
writeFileSync(join(ROOT, 'frontend', 'version.json'), `${JSON.stringify({ version, builtAt: new Date().toISOString() })}\n`);

const bucket = `s3://${outputs.SiteBucketName}`;
// Short cache lifetimes (no hashed filenames) + a CloudFront invalidation on every deploy.
run('aws', ['s3', 'sync', 'frontend', bucket, '--delete', '--exclude', '*.html', '--exclude', '*.json', '--cache-control', 'public, max-age=300', ...awsArgs]);
run('aws', ['s3', 'sync', 'frontend', bucket, '--exclude', '*', '--include', '*.html', '--include', '*.json', '--cache-control', 'public, max-age=60', ...awsArgs]);
run('aws', ['cloudfront', 'create-invalidation', '--distribution-id', outputs.DistributionId, '--paths', '/*', '--query', 'Invalidation.{Id:Id,Status:Status}', '--output', 'json', ...awsArgs]);

// Smoke test against the PUBLIC URL (what judges hit), not the raw API endpoint.
const health = await fetch(`${outputs.SiteUrl}/api/health`).then((r) => r.json()).catch((e) => ({ error: e.message }));
const home = await fetch(outputs.SiteUrl).then((r) => r.status).catch((e) => e.message);
console.log('\nSmoke test');
console.log(`  ${outputs.SiteUrl}/            -> ${home}`);
console.log(`  ${outputs.SiteUrl}/api/health  -> ${JSON.stringify(health)}`);
console.log(`\nLive: ${outputs.SiteUrl}   (version ${version})`);
if (home !== 200 || !health.ok) {
  console.error('Smoke test FAILED — the ship gate is not green. (A brand-new CloudFront distribution can take a few minutes; re-run with --site-only.)');
  process.exit(1);
}
