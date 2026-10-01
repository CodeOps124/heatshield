// Lambda entry point: public, anonymous API (health, geocode, risk, guidance, agents).
// Guidance is written by Mira and reviewed by Lexi + Vera before anyone sees it.
import { createPublicApi } from '../lib/public-routes.mjs';
import { createWeatherClient } from '../lib/weather.mjs';
import { createGuidanceService } from '../lib/guidance.mjs';
import { createStore } from '../lib/store.mjs';
import { createAgentLog } from '../lib/agent-log.mjs';
import { createAgentsApi } from '../lib/agents-api.mjs';
import { createControl } from '../lib/control.mjs';
import { createGlossaryLoader } from '../lib/agents/coach.mjs';
import { createLanguageReviewer } from '../lib/agents/language-reviewer.mjs';
import { createSafetyReviewer } from '../lib/agents/safety-reviewer.mjs';
import { createSpeechService } from '../lib/speech.mjs';
import { createAskService, createAskLimiter } from '../lib/ask.mjs';
import { dynamo, converse, tables, models, reviewerModels, askModels, invokeAgent, synthesize, audioStore, counters } from '../lib/aws.mjs';
import { log } from '../lib/util.mjs';

const store = createStore({ db: dynamo, tables });
const agentLog = createAgentLog({ db: dynamo, table: tables.agentLog });
const control = createControl({ agentLog });
// The last good forecast of each cell is kept in the GuidanceCache table, so a short Open-Meteo outage serves it
// (marked stale, up to 3 hours old) instead of an error. Only the public API does this; alerts never use it.
const weather = createWeatherClient({ backup: store.guidanceCache, log });

const guidance = createGuidanceService({
    converse,
    cache: store.guidanceCache,
    models,
    log,
    agentLog,
    gate: () => control.generation('mira'), glossary: createGlossaryLoader({ agentLog }), // operator pause or the daily budget brake
    reviewers: {
      language: createLanguageReviewer({ converse, models: reviewerModels }),
      safety: createSafetyReviewer({ converse, models: reviewerModels }),
    },
});

export const handler = createPublicApi({
  weather,
  guidance,
  ask: createAskService({
    weather, guidance, agentLog, converse, models: askModels,
    gate: () => control.generation('ask'), // the AI kill switch and the daily budget
    limiter: createAskLimiter({ counter: counters }),
  }),
  agentsApi: createAgentsApi({ agentLog, control }),
  agentLog,
  control,
  runAgentNow: invokeAgent,
  speech: createSpeechService({ cache: store.guidanceCache, synthesize, storage: audioStore, gate: () => control.generation('voice'), agentLog }),
  version: process.env.APP_VERSION ?? 'dev',
  region: process.env.AWS_REGION,
});
