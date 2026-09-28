// Lambda entry point: public, anonymous API (health, geocode, risk, guidance).
import { createPublicApi } from '../lib/public-routes.mjs';
import { createWeatherClient } from '../lib/weather.mjs';
import { createGuidanceService } from '../lib/guidance.mjs';
import { createStore } from '../lib/store.mjs';
import { dynamo, converse, tables, models } from '../lib/aws.mjs';
import { log } from '../lib/util.mjs';

const store = createStore({ db: dynamo, tables });

export const handler = createPublicApi({
  weather: createWeatherClient(),
  guidance: createGuidanceService({ converse, cache: store.guidanceCache, models, log }),
  version: process.env.APP_VERSION ?? 'dev',
  region: process.env.AWS_REGION,
});
