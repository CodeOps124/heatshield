// Lambda entry points for the three scheduled agents: Sol (hourly), Kai (3-hourly / on demand),
// Otto (every 15 minutes). Every run — success or failure — is recorded for Agent HQ.
// Sol and Otto can also be run on demand by a visitor (POST /api/agents/{id}/run, with a global
// cooldown); those calls pass `budgetMs` so the run finishes inside the web request.
import { createWeatherClient } from '../lib/weather.mjs';
import { createStore } from '../lib/store.mjs';
import { createAgentLog, recorded } from '../lib/agent-log.mjs';
import { runSentinel, createClimateService } from '../lib/agents/sentinel.mjs';
import { runCoordinator } from '../lib/agents/coordinator.mjs';
import { runWatchdog } from '../lib/agents/watchdog.mjs';
import { dynamo, converse, tables, agentModels, logs, opsPublish } from '../lib/aws.mjs';
import { toAscii } from '../lib/util.mjs';

const store = createStore({ db: dynamo, tables });
const agentLog = createAgentLog({ db: dynamo, table: tables.agentLog });
const weather = createWeatherClient();

function deadlineFor(event, context, reserveMs = 8000) {
  const lambdaLeft = (context?.getRemainingTimeInMillis?.() ?? 120_000) - reserveMs;
  const budget = Number.isFinite(event?.budgetMs) ? Math.min(event.budgetMs, lambdaLeft) : lambdaLeft;
  return Date.now() + Math.max(10_000, budget);
}

export const sentinel = async (event = {}, context) => {
  const result = await recorded(agentLog, 'sol', event.trigger ?? 'schedule', () =>
    runSentinel({ store, weather, climate: createClimateService({ agentLog }), agentLog, converse, models: agentModels, deadline: deadlineFor(event, context) }));
  return { outcome: result.outcome, summary: result.summary };
};

export const coordinator = async (event = {}, context) => {
  const groupId = typeof event.groupId === 'string' ? event.groupId : null;
  const result = await recorded(agentLog, 'kai', event.trigger ?? 'schedule', () =>
    runCoordinator({ store, weather, agentLog, converse, models: agentModels, groupId, deadline: deadlineFor(event, context) }));
  return { outcome: result.outcome, summary: result.summary };
};

// Log groups are discovered by the stack's naming prefix rather than wired in by reference, which
// keeps Otto free of template references to the functions he watches (the public API can invoke
// Otto on demand without creating a CloudFormation dependency cycle).
let logGroupsCache = null;
async function discoverLogGroups() {
  if (logGroupsCache) return logGroupsCache;
  const names = await logs.listGroups(`/aws/lambda/${process.env.STACK_NAME}-`);
  const pick = (logical) => names.find((n) => n.includes(`-${logical}-`));
  logGroupsCache = Object.fromEntries(
    [['publicApi', 'PublicApiFunction'], ['enrollmentApi', 'EnrollmentApiFunction'], ['alertCheck', 'AlertCheckFunction']]
      .map(([key, logical]) => [key, pick(logical)])
      .filter(([, v]) => v),
  );
  return logGroupsCache;
}

export const watchdog = async (event = {}, context) => {
  // The scheduled event carries the public URL; on-demand runs reuse the last one seen.
  let siteUrl = typeof event.siteUrl === 'string' ? event.siteUrl : null;
  if (siteUrl) await agentLog.putState('otto', 'config', { siteUrl }).catch(() => {});
  else siteUrl = (await agentLog.getState('otto', 'config'))?.siteUrl;
  if (!siteUrl) throw new Error('Otto does not know the public URL yet (waiting for the first scheduled run)');

  const result = await recorded(agentLog, 'otto', event.trigger ?? 'schedule', async () =>
    runWatchdog({
      siteUrl,
      agentLog,
      logs,
      logGroups: await discoverLogGroups(),
      converse,
      models: agentModels,
      publish: (subject, message) => opsPublish(toAscii(subject).slice(0, 99), message),
      deadline: deadlineFor(event, context),
    }));
  return { outcome: result.outcome, summary: result.summary };
};
