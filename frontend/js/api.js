// Same-origin API client. The API sits behind CloudFront at /api/*, so there is no CORS and
// secrets travel only in request headers (never in URLs that reach a server log).
export class ApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function request(path, { method = 'GET', body, headers = {}, signal } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
      signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new ApiError('Could not reach HeatShield. Check your connection and try again.', 0, 'network');
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* non-JSON error page */
  }
  if (!res.ok) {
    const fallback = res.status === 429 ? 'Too many requests right now. Please wait a moment and try again.'
      : res.status === 503 ? 'HeatShield is busy right now. Please try again in a moment.'
        : `Request failed (${res.status})`;
    throw new ApiError(data?.error?.message ?? fallback, res.status, data?.error?.code);
  }
  return data;
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
});

// A read that AWS turned away for a moment is asked again, twice at most: Lambda answers 503 when the
// account's concurrency limit is reached (30 Sep: 13 plans requested at once, 3 refused), and API
// Gateway 429 when its rate limit is. HeatShield's own errors carry a code and are never retried,
// and nothing that changes data is sent twice.
export async function api(path, options = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await request(path, options);
    } catch (err) {
      const transient = err instanceof ApiError && (err.status === 503 || err.status === 429) && !err.code;
      if ((options.method ?? 'GET') !== 'GET' || !transient || attempt >= 2) throw err;
      await sleep([1500, 4000][attempt] + Math.random() * 500, options.signal);
    }
  }
}

export const qs = (params) =>
  new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')).toString();
