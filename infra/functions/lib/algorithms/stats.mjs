/** Small, dependency-free statistics used by the agents. */

/** Ordinary least squares y = a + b·x. Returns slope, intercept and R². */
export function linearRegression(xs, ys) {
  const pts = xs.map((x, i) => [x, ys[i]]).filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
  const n = pts.length;
  if (n < 2) return { slope: 0, intercept: pts[0]?.[1] ?? 0, r2: 0, n };
  const mx = pts.reduce((s, [x]) => s + x, 0) / n;
  const my = pts.reduce((s, [, y]) => s + y, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (const [x, y] of pts) {
    sxy += (x - mx) * (y - my);
    sxx += (x - mx) ** 2;
    syy += (y - my) ** 2;
  }
  const slope = sxx === 0 ? 0 : sxy / sxx;
  const intercept = my - slope * mx;
  const r2 = sxx === 0 || syy === 0 ? 0 : (sxy * sxy) / (sxx * syy);
  return { slope, intercept, r2, n };
}

/**
 * Exponentially weighted moving average + variance (West 1979 / Finch 2009 incremental form),
 * the basis of an EWMA control chart. State is a plain object so it can be persisted.
 */
export function ewmaUpdate(state, x, alpha = 0.2) {
  if (!state || !Number.isFinite(state.mean)) return { mean: x, variance: 0, n: 1 };
  const diff = x - state.mean;
  const incr = alpha * diff;
  return {
    mean: state.mean + incr,
    variance: (1 - alpha) * (state.variance + diff * incr),
    n: (state.n ?? 0) + 1,
  };
}

/**
 * Control-chart test: is x more than k standard deviations above the EWMA mean?
 * Needs a minimum history, and ignores deviations smaller than `floor` (e.g. a 30 ms wobble on a
 * 200 ms endpoint is not an incident even if the variance is tiny).
 */
export function ewmaAnomaly(state, x, { k = 3, minSamples = 8, floor = 0 } = {}) {
  if (!state || (state.n ?? 0) < minSamples) return { anomaly: false, z: 0, reason: 'warming_up' };
  const sd = Math.sqrt(Math.max(state.variance, 0));
  const excess = x - state.mean;
  const z = sd > 0 ? excess / sd : excess > 0 ? Infinity : 0;
  return { anomaly: z > k && excess > floor, z: Number.isFinite(z) ? Math.round(z * 10) / 10 : 99, reason: 'ewma' };
}

export const logistic = (z) => 1 / (1 + Math.exp(-z));
