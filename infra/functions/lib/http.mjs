/** API Gateway HTTP API (payload v2.0) helpers: JSON responses, body parsing, error mapping. */
import { ValidationError, log } from './util.mjs';
import { UpstreamError } from './weather.mjs';

export class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function json(status, body) {
  return {
    statusCode: status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
    body: JSON.stringify(body),
  };
}

export function parseBody(event) {
  if (!event.body) return {};
  const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
  if (raw.length > 8192) throw new HttpError(413, 'payload_too_large', 'Request body is too large');
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    return parsed;
  } catch {
    throw new HttpError(400, 'invalid_json', 'Request body must be a JSON object');
  }
}

export const header = (event, name) => event.headers?.[name.toLowerCase()] ?? null;

/**
 * Wrap a route table { "GET /api/x": async (event) => response } into a Lambda handler with
 * consistent error handling. Internal errors never leak stack traces to the client.
 */
export function router(routes) {
  return async (event) => {
    const route = routes[event.routeKey];
    if (!route) return json(404, { error: { code: 'not_found', message: 'No such route' } });
    try {
      return await route(event);
    } catch (err) {
      if (err instanceof HttpError) return json(err.status, { error: { code: err.code, message: err.message } });
      if (err instanceof ValidationError) return json(400, { error: { code: 'invalid_input', message: err.message } });
      if (err instanceof UpstreamError) {
        log.warn('upstream_error', { route: event.routeKey, message: err.message });
        return json(502, { error: { code: 'weather_unavailable', message: 'Weather data is temporarily unavailable. Please try again in a minute.' } });
      }
      log.error('unhandled_error', { route: event.routeKey, name: err.name, message: err.message, stack: err.stack });
      return json(500, { error: { code: 'internal', message: 'Something went wrong on our side.' } });
    }
  };
}
