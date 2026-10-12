import pino from 'pino';

/**
 * Paths that must never appear in logs. pino replaces their values with
 * "[REDACTED]". Keep this list in sync with anything holding secrets.
 */
export const REDACT_PATHS = [
  'password',
  '*.password',
  'IG_PASSWORD',
  'SESSION_SECRET',
  '*.SESSION_SECRET',
  'cookie',
  '*.cookie',
  'cookies',
  '*.cookies',
  'token',
  '*.token',
  'sessionid',
  '*.sessionid',
  'session',
  '*.session',
  'authorization',
  '*.authorization',
  'headers.cookie',
  'headers.authorization',
  '*.headers.cookie',
  '*.headers.authorization',
];

/**
 * @param {object} [options]
 * @param {string} [options.level='info']
 * @param {import('node:stream').Writable} [options.destination] defaults to stdout
 */
export function createLogger({ level = 'info', destination } = {}) {
  const options = {
    level,
    base: { service: 'igbot' },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
  };
  return destination ? pino(options, destination) : pino(options);
}

/**
 * Turn an error into a small, log-safe object. Only the error name, code and a
 * truncated message are kept; response bodies and cookies are never included.
 */
export function serializeError(err) {
  if (!err || typeof err !== 'object') {
    return { message: String(err).slice(0, 200) };
  }
  const out = { name: err.name ?? 'Error' };
  if (typeof err.code === 'string') out.code = err.code;
  if (typeof err.message === 'string') out.message = err.message.slice(0, 200);
  return out;
}
