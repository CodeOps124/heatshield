// Lambda entry point: groups, registrations, leader dashboard (incl. Kai's check-in plan).
import { createEnrollmentApi } from '../lib/enrollment-routes.mjs';
import { createWeatherClient } from '../lib/weather.mjs';
import { createStore } from '../lib/store.mjs';
import { createAgentLog } from '../lib/agent-log.mjs';
import { dynamo, notifier, tables, invokeCoordinator } from '../lib/aws.mjs';

export const handler = createEnrollmentApi({
  store: createStore({ db: dynamo, tables }),
  notifier,
  weather: createWeatherClient(),
  agentLog: createAgentLog({ db: dynamo, table: tables.agentLog }),
  requestPlan: invokeCoordinator,
});
