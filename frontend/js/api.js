// Same-origin API client. The API sits behind CloudFront at /api/*, so there is no CORS and
// secrets travel only in request headers (never in URLs that reach a server log).
export class ApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export async function api(path, { method = 'GET', body, headers = {}, signal } = {}) {
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
    const fallback = res.status === 429 ? 'Too many requests right now. Please wait a moment and try again.' : `Request failed (${res.status})`;
    throw new ApiError(data?.error?.message ?? fallback, res.status, data?.error?.code);
  }
  return data;
}

export const qs = (params) =>
  new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')).toString();
