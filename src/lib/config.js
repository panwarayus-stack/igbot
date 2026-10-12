import { resolve, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { z } from 'zod';
import { ConfigError } from './errors.js';

export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  BOT_PREFIX: z.string().min(1, 'BOT_PREFIX must not be empty').max(3).default('!'),
  IG_USERNAME: z
    .string({ error: 'IG_USERNAME is required' })
    .trim()
    .min(1, 'IG_USERNAME is required')
    .max(64),
  // Optional at parse time: only needed when no valid saved session exists.
  // Not trimmed, because passwords may legitimately contain spaces.
  IG_PASSWORD: z.string().max(256).default(''),
  SESSION_SECRET: z
    .string({ error: 'SESSION_SECRET is required' })
    .min(32, 'SESSION_SECRET must be at least 32 characters (generate one with: openssl rand -hex 32)'),
  DATA_DIR: z.string().min(1).default('data'),
  POLL_INTERVAL_MS: z.coerce
    .number({ invalid_type_error: 'POLL_INTERVAL_MS must be a number' })
    .int()
    .min(5000, 'POLL_INTERVAL_MS must be at least 5000')
    .max(600000)
    .default(10000),
  LOGIN_COOLDOWN_MINUTES: z.coerce
    .number({ invalid_type_error: 'LOGIN_COOLDOWN_MINUTES must be a number' })
    .int()
    .min(1)
    .max(10080)
    .default(60),
});

/** Drop empty-string values so that `KEY=` in .env behaves like "not set". */
function withoutEmptyValues(env) {
  return Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ''));
}

/**
 * Validate a raw environment object. Pure: no file or process access.
 * Error messages name the offending variable but never echo its value.
 * @param {Record<string, string | undefined>} env
 * @param {{ projectRoot?: string }} [options]
 */
export function parseConfig(env, { projectRoot = PROJECT_ROOT } = {}) {
  const result = envSchema.safeParse(withoutEmptyValues(env));
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || 'env'}: ${issue.message}`)
      .join('\n');
    throw new ConfigError(`Invalid configuration:\n${details}`);
  }
  const e = result.data;
  const dataDir = isAbsolute(e.DATA_DIR) ? e.DATA_DIR : resolve(projectRoot, e.DATA_DIR);

  return {
    nodeEnv: e.NODE_ENV,
    logLevel: e.LOG_LEVEL,
    prefix: e.BOT_PREFIX,
    username: e.IG_USERNAME,
    password: e.IG_PASSWORD,
    sessionSecret: e.SESSION_SECRET,
    pollIntervalMs: e.POLL_INTERVAL_MS,
    loginCooldownMinutes: e.LOGIN_COOLDOWN_MINUTES,
    dataDir,
    sessionFile: resolve(dataDir, 'session.enc'),
    authStateFile: resolve(dataDir, 'auth-state.json'),
  };
}

/**
 * Load `.env` from the project root (independent of the working directory),
 * then validate the process environment. Existing environment variables win over .env.
 */
export function loadConfig({ envPath = resolve(PROJECT_ROOT, '.env'), env = process.env } = {}) {
  dotenv.config({ path: envPath, quiet: true, processEnv: env });
  return parseConfig(env);
}
