/**
 * Clear the saved session and the login cooldown, so the next start performs a fresh login.
 * Run this only after resolving any checkpoint, 2FA or block in the official Instagram app.
 *   npm run auth:reset
 */
import { rm } from 'node:fs/promises';
import { loadConfig } from '../src/lib/config.js';

const env = { ...process.env };
// Only the file paths are needed, so placeholder values are fine for the rest of the environment.
env.IG_USERNAME ||= 'placeholder';
env.SESSION_SECRET ||= 'placeholder-placeholder-placeholder-placeholder';

const config = loadConfig({ env });
await rm(config.sessionFile, { force: true });
await rm(config.authStateFile, { force: true });
console.log('Saved session and login cooldown cleared. The bot will log in again on next start.');
