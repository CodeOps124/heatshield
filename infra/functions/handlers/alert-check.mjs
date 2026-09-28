// Lambda entry point: scheduled alert loop (EventBridge Scheduler, hourly) — the deterministic
// "Dispatcher" worker. Alert guidance goes through the same Mira → Lexi + Vera review loop.
// Manual demo trigger:  aws lambda invoke --function-name <AlertCheckFunction> \
//   --cli-binary-format raw-in-base64-out --payload '{"forceLocationId":"<id>"}' out.json
import { runAlertCheck } from '../lib/alert-runner.mjs';
import { createWeatherClient } from '../lib/weather.mjs';
import { createGuidanceService } from '../lib/guidance.mjs';
import { createStore } from '../lib/store.mjs';
import { createAgentLog, recorded } from '../lib/agent-log.mjs';
import { createLanguageReviewer } from '../lib/agents/language-reviewer.mjs';
import { createSafetyReviewer } from '../lib/agents/safety-reviewer.mjs';
import { dynamo, converse, notifier, tables, models, reviewerModels } from '../lib/aws.mjs';
import { log } from '../lib/util.mjs';

const store = createStore({ db: dynamo, tables });
const agentLog = createAgentLog({ db: dynamo, table: tables.agentLog });
const weather = createWeatherClient();
const guidance = createGuidanceService({
  converse, cache: store.guidanceCache, models, log, agentLog,
  reviewers: {
    language: createLanguageReviewer({ converse, models: reviewerModels }),
    safety: createSafetyReviewer({ converse, models: reviewerModels }),
  },
});

export const handler = async (event = {}) => {
  const forceLocationId = typeof event.forceLocationId === 'string' ? event.forceLocationId : null;
  return recorded(agentLog, 'dispatch', forceLocationId ? 'manual' : 'schedule', async () => {
    const summary = await runAlertCheck({ store, weather, guidance, notifier, log, siteUrl: process.env.SITE_URL, forceLocationId });
    return {
      ...summary,
      outcome: summary.errors ? 'partial' : 'ok',
      summary: `Checked ${summary.checked}: ${summary.sent} emailed, ${summary.dashboardOnly} flagged for leaders, ${summary.quiet} in quiet hours, ${summary.belowThreshold} below threshold.`,
      detail: summary,
    };
  });
};
