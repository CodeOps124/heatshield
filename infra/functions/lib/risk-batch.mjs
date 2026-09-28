/** Live risk for many locations, fetching each distinct ~1 km grid cell only once. */
import { assessRisk } from './heat.mjs';
import { mapLimit, log } from './util.mjs';

export async function riskForMany(weather, locations) {
  const cells = [...new Set(locations.map((l) => `${l.lat},${l.lon}`))];
  const forecasts = new Map();
  await mapLimit(cells, 6, async (cell) => {
    const [lat, lon] = cell.split(',').map(Number);
    try {
      forecasts.set(cell, await weather.getForecast(lat, lon));
    } catch (err) {
      log.warn('batch_forecast_failed', { cell, message: err.message });
    }
  });
  return locations.map((l) => {
    const f = forecasts.get(`${l.lat},${l.lon}`);
    return f ? assessRisk(f, l.profile) : null;
  });
}
