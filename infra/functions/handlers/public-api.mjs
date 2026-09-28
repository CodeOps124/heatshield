// Lambda entry point: public, anonymous API (health, geocode, risk, guidance, agents).
// Guidance is written by Mira and reviewed by Lexi + Vera before anyone sees it.
import { createPublicApi } from '../lib/public-routes.mjs';
import { createWeatherClient } from '../lib/weather.mjs';
import { createGuidanceService } from '../lib/guidance.mjs';
import { createStore } from '../lib/store.mjs';
import { createAgentLog } from '../lib/agent-log.mjs';
import { createAgentsApi } from '../lib/agents-api.mjs';
import { createLanguageReviewer } from '../lib/agents/language-reviewer.mjs';
import { createSafetyReviewer } from '../lib/agents/safety-reviewer.mjs';
import { dynamo, converse, tables, models, reviewerModels } from '../lib/aws.mjs';
import { log } from '../lib/util.mjs';

const store = createStore({ db: dynamo, tables });
const agentLog = createAgentLog({ db: dynamo, table: tables.agentLog });

export const handler = createPublicApi({
  weather: createWeatherClient(),
  guidance: createGuidanceService({
    converse,
    cache: store.guidanceCache,
    models,
    log,
    agentLog,
    reviewers: {
      language: createLanguageReviewer({ converse, models: reviewerModels }),
      safety: createSafetyReviewer({ converse, models: reviewerModels }),
    },
  }),
  agentsApi: createAgentsApi({ agentLog }),
  version: process.env.APP_VERSION ?? 'dev',
  region: process.env.AWS_REGION,
});
