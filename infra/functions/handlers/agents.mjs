// Lambda entry points for the three scheduled agents: Sol (hourly), Kai (3-hourly / on demand),
// Otto (every 15 minutes). Every run — success or failure — is recorded for Agent HQ.
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
const deadlineFor = (context, reserveMs = 8000) => Date.now() + Math.max(10_000, (context?.getRemainingTimeInMillis?.() ?? 120_000) - reserveMs);

export const sentinel = async (event = {}, context) =>
  recorded(agentLog, 'sol', event.trigger ?? 'schedule', () =>
    runSentinel({ store, weather, climate: createClimateService({ agentLog }), agentLog, converse, models: agentModels, deadline: deadlineFor(context) }));

export const coordinator = async (event = {}, context) => {
  const groupId = typeof event.groupId === 'string' ? event.groupId : null;
  const result = await recorded(agentLog, 'kai', event.trigger ?? 'schedule', () =>
    runCoordinator({ store, weather, agentLog, converse, models: agentModels, groupId, deadline: deadlineFor(context) }));
  return { outcome: result.outcome, summary: result.summary };
};

export const watchdog = async (event = {}, context) =>
  recorded(agentLog, 'otto', event.trigger ?? 'schedule', () =>
    runWatchdog({
      siteUrl: process.env.SITE_URL,
      agentLog,
      logs,
      logGroups: {
        publicApi: `/aws/lambda/${process.env.PUBLIC_API_FUNCTION}`,
        enrollmentApi: `/aws/lambda/${process.env.ENROLLMENT_API_FUNCTION}`,
        alertCheck: `/aws/lambda/${process.env.ALERT_CHECK_FUNCTION}`,
      },
      converse,
      models: agentModels,
      publish: (subject, message) => opsPublish(toAscii(subject).slice(0, 99), message),
      deadline: deadlineFor(context),
    }));
