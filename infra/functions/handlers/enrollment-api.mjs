// Lambda entry point: groups, registrations, leader dashboard.
import { createEnrollmentApi } from '../lib/enrollment-routes.mjs';
import { createWeatherClient } from '../lib/weather.mjs';
import { createStore } from '../lib/store.mjs';
import { dynamo, notifier, tables } from '../lib/aws.mjs';

export const handler = createEnrollmentApi({
  store: createStore({ db: dynamo, tables }),
  notifier,
  weather: createWeatherClient(),
});
