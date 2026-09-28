// Lambda entry point: scheduled alert loop (EventBridge Scheduler, hourly).
// Manual demo trigger:  aws lambda invoke --function-name <AlertCheckFunction> \
//   --cli-binary-format raw-in-base64-out --payload '{"forceLocationId":"<id>"}' out.json
import { runAlertCheck } from '../lib/alert-runner.mjs';
import { createWeatherClient } from '../lib/weather.mjs';
import { createGuidanceService } from '../lib/guidance.mjs';
import { createStore } from '../lib/store.mjs';
import { dynamo, converse, notifier, tables, models } from '../lib/aws.mjs';
import { log } from '../lib/util.mjs';

const store = createStore({ db: dynamo, tables });
const weather = createWeatherClient();
const guidance = createGuidanceService({ converse, cache: store.guidanceCache, models, log });

export const handler = async (event = {}) =>
  runAlertCheck({
    store,
    weather,
    guidance,
    notifier,
    log,
    siteUrl: process.env.SITE_URL,
    forceLocationId: typeof event.forceLocationId === 'string' ? event.forceLocationId : null,
  });
