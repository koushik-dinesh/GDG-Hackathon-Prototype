import { config } from '../config/index.js';

// Minimal structured (JSON lines) logger. Swap for pino later if needed.
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[config.logLevel];

// Field names whose values are never written to logs, at any depth. Masking by name is a safety
// net: callers still must not log secrets, tokens, payloads or provider responses.
const SENSITIVE_KEY = /token|secret|password|passwd|authorization|cookie|api.?key|private.?key|ciphertext|signature|^state$/i;
const MAX_DEPTH = 6;
export const REDACTED = '[REDACTED]';

/** Copy of `value` with sensitive fields masked. Errors become { name, message }. */
export function redact(value, depth = 0) {
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return '[…]';
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (value instanceof Date) return value;
  if (Buffer.isBuffer(value)) return REDACTED;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out = {};
  for (const [key, v] of Object.entries(value)) {
    out[key] = SENSITIVE_KEY.test(key) ? REDACTED : redact(v, depth + 1);
  }
  return out;
}

/** Masks the values of sensitive query parameters in a path or URL (e.g. ?state=…&token=…). */
export function redactUrl(url) {
  const q = url.indexOf('?');
  if (q === -1) return url;
  const params = new URLSearchParams(url.slice(q + 1));
  for (const key of [...params.keys()]) {
    if (SENSITIVE_KEY.test(key) || /^code$/i.test(key)) params.set(key, REDACTED);
  }
  return `${url.slice(0, q)}?${params}`;
}

function write(level, msg, fields = {}) {
  if (LEVELS[level] < threshold) return;
  const line = JSON.stringify({ time: new Date().toISOString(), level, msg, ...redact(fields) });
  (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line + '\n');
}

export const logger = {
  debug: (msg, fields) => write('debug', msg, fields),
  info: (msg, fields) => write('info', msg, fields),
  warn: (msg, fields) => write('warn', msg, fields),
  error: (msg, fields) => write('error', msg, fields),
};
