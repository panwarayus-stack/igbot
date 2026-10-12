/**
 * Application error types. Each carries a stable `code` that can be logged
 * and checked without relying on message text.
 */

export class BotError extends Error {
  constructor(message, { code = 'BOT_ERROR', cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = new.target.name;
    this.code = code;
  }
}

/** Invalid or missing configuration (.env). */
export class ConfigError extends BotError {
  constructor(message) {
    super(message, { code: 'CONFIG_ERROR' });
  }
}

/** Instagram refused or interrupted authentication (password, checkpoint, 2FA, block...). */
export class AuthError extends BotError {
  constructor(message, { code }) {
    super(message, { code });
  }
}

/** A login was skipped because a previous authentication failure is still cooling down. */
export class AuthCooldownError extends BotError {
  constructor({ code, retryAfter }) {
    super(
      `Login is paused after a previous failure (${code}). Retry after ${retryAfter}. ` +
        'Resolve the account issue in the official Instagram app, then run "npm run auth:reset".',
      { code: 'AUTH_COOLDOWN' },
    );
    this.failureCode = code;
    this.retryAfter = retryAfter;
  }
}
