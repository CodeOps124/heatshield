/** Small shared helpers: structured logging, secure ids, input validation, concurrency. */
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

// ---------- structured JSON logs (queryable in CloudWatch Logs Insights) ----------
function emit(level, msg, fields) {
  const line = JSON.stringify({ level, msg, ...fields });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}
export const log = {
  info: (msg, fields = {}) => emit('info', msg, fields),
  warn: (msg, fields = {}) => emit('warn', msg, fields),
  error: (msg, fields = {}) => emit('error', msg, fields),
};

// ---------- ids & secrets ----------
/** URL-safe random id. 9 bytes -> 12 chars, 24 bytes -> 32 chars. */
export const newId = (bytes = 9) => randomBytes(bytes).toString('base64url');

/** We store only a SHA-256 of bearer secrets (admin keys, manage tokens), never the secret. */
export const hashSecret = (secret) => createHash('sha256').update(String(secret)).digest('hex');

export function secretMatches(secret, storedHash) {
  if (typeof secret !== 'string' || !secret || typeof storedHash !== 'string') return false;
  const a = Buffer.from(hashSecret(secret), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

// ---------- validation ----------
export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

/**
 * Strip control characters, bidi-override characters (text-spoofing), and markup-significant
 * characters; collapse whitespace; cap length. Zero-width joiners are KEPT — Hindi, Bengali and
 * Urdu names need them.
 */
export function cleanText(value, maxLen) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new ValidationError('Expected text');
  const cleaned = value
    .normalize('NFC')
    .replace(/\p{Cc}/gu, ' ')
    .replace(/[‪-‮⁦-⁩]/g, '')
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return null;
  return [...cleaned].slice(0, maxLen).join('');
}

export function parseCoord(value, kind) {
  const n = typeof value === 'number' ? value : Number.parseFloat(value);
  const limit = kind === 'lat' ? 90 : 180;
  if (!Number.isFinite(n) || n < -limit || n > limit) {
    throw new ValidationError(`${kind === 'lat' ? 'Latitude' : 'Longitude'} must be a number between -${limit} and ${limit}`);
  }
  return n;
}

const EMAIL_RE = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]{2,}$/;
export function parseEmail(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new ValidationError('Email must be text');
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !EMAIL_RE.test(email)) throw new ValidationError('That email address does not look valid');
  return email;
}

// ---------- concurrency ----------
/** Map with at most `limit` promises in flight (keeps upstream APIs happy). */
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next;
      next += 1;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** ASCII-only rendering for places where AWS requires it (SNS email subjects). */
export const toAscii = (s) =>
  String(s ?? '')
    .normalize('NFKD')
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
