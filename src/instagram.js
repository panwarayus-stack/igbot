/**
 * Instagram connection layer.
 *
 * Responsibilities: session restore, login, expired-session recovery, error
 * classification, polling the direct inbox for incoming text messages, and sending
 * text replies. It knows nothing about commands.
 *
 * Deliberately NOT implemented: CAPTCHA solving, two-factor code handling and
 * checkpoint/challenge resolution. Those states stop the bot and need manual action
 * in the official Instagram app.
 */
import {
  IgApiClient,
  IgActionSpamError,
  IgCheckpointError,
  IgInactiveUserError,
  IgLoginBadPasswordError,
  IgLoginInvalidUserError,
  IgLoginRequiredError,
  IgLoginTwoFactorRequiredError,
  IgRequestsLimitError,
  IgSentryBlockError,
  IgUserHasLoggedOutError,
} from 'instagram-private-api';
import { AuthCooldownError, AuthError, BotError, ConfigError } from './lib/errors.js';
import { serializeError } from './lib/logger.js';

export const MAX_OUTGOING_TEXT = 1000;
const MAX_BACKOFF_MS = 5 * 60 * 1000;
const SESSION_SAVE_INTERVAL_MS = 60 * 60 * 1000;
const MIN_RELOGIN_INTERVAL_MS = 10 * 60 * 1000;

/**
 * Map a library error to a stable code and a handling kind:
 *  - 'session'   the saved session expired; a fresh login is appropriate
 *  - 'auth'      Instagram refused or flagged the account; stop and cool down
 *  - 'transient' network, rate limit or unknown; retry later with backoff
 * `cooldownMultiplier` scales the configured login cooldown.
 * @param {unknown} err
 */
export function classifyAuthError(err) {
  if (err instanceof IgLoginRequiredError || err instanceof IgUserHasLoggedOutError) {
    return { kind: 'session', code: 'SESSION_EXPIRED', cooldownMultiplier: 0 };
  }
  if (err instanceof IgCheckpointError) {
    return { kind: 'auth', code: 'CHECKPOINT_REQUIRED', cooldownMultiplier: 4 };
  }
  if (err instanceof IgLoginTwoFactorRequiredError) {
    return { kind: 'auth', code: 'TWO_FACTOR_REQUIRED', cooldownMultiplier: 2 };
  }
  if (err instanceof IgLoginBadPasswordError) {
    return { kind: 'auth', code: 'BAD_PASSWORD', cooldownMultiplier: 4 };
  }
  if (err instanceof IgLoginInvalidUserError) {
    return { kind: 'auth', code: 'INVALID_USER', cooldownMultiplier: 4 };
  }
  if (err instanceof IgInactiveUserError) {
    return { kind: 'auth', code: 'INACTIVE_USER', cooldownMultiplier: 4 };
  }
  if (err instanceof IgSentryBlockError || err instanceof IgActionSpamError) {
    return { kind: 'auth', code: 'ACCOUNT_BLOCKED', cooldownMultiplier: 6 };
  }
  if (err instanceof IgRequestsLimitError) {
    return { kind: 'transient', code: 'RATE_LIMITED', cooldownMultiplier: 0 };
  }
  return { kind: 'transient', code: 'UNKNOWN', cooldownMultiplier: 0 };
}

/**
 * Pick new text messages from direct-inbox threads.
 *
 * `baselines` maps threadId to the newest timestamp already handled (micro
 * seconds, as a BigInt). Threads without a baseline use `startMicros`, so history
 * from before the bot started is never replayed. Messages from `viewerId` (the
 * bot's own account) and non-text items are skipped. The baselines map is
 * updated in place.
 *
 * @param {object} args
 * @param {Array<any>} args.threads direct-inbox thread objects
 * @param {string|null} args.viewerId bot's own user id
 * @param {Map<string, bigint>} args.baselines
 * @param {bigint} args.startMicros
 * @returns {Array<{threadId: string, itemId: string, userId: string, username?: string, text: string, timestampMicros: bigint}>}
 */
export function collectNewMessages({ threads, viewerId, baselines, startMicros }) {
  const messages = [];
  for (const thread of threads ?? []) {
    const threadId = String(thread.thread_id);
    const baseline = baselines.get(threadId) ?? startMicros;
    let newest = baseline;

    const items = (thread.items ?? [])
      .map((item) => ({ item, ts: parseMicros(item.timestamp) }))
      .filter((entry) => entry.ts !== null)
      .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));

    for (const { item, ts } of items) {
      if (ts <= baseline) continue;
      if (ts > newest) newest = ts;
      const senderId = String(item.user_id);
      if (viewerId !== null && senderId === viewerId) continue;
      if (item.item_type !== 'text' || typeof item.text !== 'string') continue;
      const sender = (thread.users ?? []).find((u) => String(u.pk) === senderId);
      messages.push({
        threadId,
        itemId: String(item.item_id),
        userId: senderId,
        username: sender?.username,
        text: item.text,
        timestampMicros: ts,
      });
    }
    baselines.set(threadId, newest);
  }
  return messages;
}

function parseMicros(value) {
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

/** Connection states: disconnected -> connecting -> connected -> (auth_required | stopped). */
export class InstagramConnection {
  /**
   * @param {object} options
   * @param {string} options.username
   * @param {string} options.password
   * @param {import('./lib/session-store.js').SessionStore} options.sessionStore
   * @param {import('./lib/auth-guard.js').AuthGuard} options.authGuard
   * @param {import('pino').Logger} options.logger
   * @param {number} options.loginCooldownMinutes
   * @param {number} [options.pollIntervalMs=10000]
   * @param {() => any} [options.clientFactory] injectable for tests
   * @param {() => number} [options.now]
   */
  constructor({
    username,
    password,
    sessionStore,
    authGuard,
    logger,
    loginCooldownMinutes,
    pollIntervalMs = 10000,
    clientFactory = () => new IgApiClient(),
    now = () => Date.now(),
  }) {
    this.username = username;
    this.password = password;
    this.sessionStore = sessionStore;
    this.authGuard = authGuard;
    this.logger = logger;
    this.loginCooldownMs = loginCooldownMinutes * 60 * 1000;
    this.pollIntervalMs = pollIntervalMs;
    this.clientFactory = clientFactory;
    this.now = now;

    this.ig = null;
    this.state = 'disconnected';
    this.onMessage = null;
    this.baselines = new Map();
    this.startMicros = BigInt(now()) * 1000n;
    this.consecutiveFailures = 0;
    this.lastSessionSaveAt = 0;
    this.lastLoginAttemptAt = 0;
    this.timer = null;
    this.stopped = false;
  }

  getStatus() {
    return { state: this.state };
  }

  #setState(state) {
    this.state = state;
    this.logger.info({ state }, 'Instagram connection state changed');
  }

  #newClient() {
    const ig = this.clientFactory();
    // The device fingerprint is derived from the username, so it stays stable across restarts.
    ig.state.generateDevice(this.username);
    return ig;
  }

  #viewerId() {
    try {
      return String(this.ig.state.extractUserId());
    } catch {
      return null;
    }
  }

  /**
   * Restore the saved session if one exists. Otherwise, or if it has expired, log in once.
   * Throws AuthError / AuthCooldownError / ConfigError / BotError on failure.
   */
  async start() {
    this.#setState('connecting');
    const saved = await this.sessionStore.load();
    if (saved) {
      const ig = this.#newClient();
      try {
        await ig.state.deserialize(saved);
        await ig.account.currentUser();
        this.ig = ig;
        this.logger.info('Saved Instagram session restored');
        this.#setState('connected');
        return;
      } catch (err) {
        const c = classifyAuthError(err);
        if (c.kind === 'session') {
          this.logger.info('Saved session has expired; a new login is required');
          await this.sessionStore.clear();
        } else if (c.kind === 'auth') {
          await this.#handleAuthFailure(c);
        } else {
          this.#setState('disconnected');
          throw new BotError('Could not verify the saved session (network or Instagram error)', {
            code: 'TRANSIENT',
            cause: err,
          });
        }
      }
    }
    await this.login();
  }

  /** Perform one login attempt. Refuses to run during a cooldown. */
  async login() {
    const gate = await this.authGuard.check();
    if (!gate.allowed) {
      this.#setState('auth_required');
      throw new AuthCooldownError(gate);
    }
    if (!this.password) {
      throw new ConfigError(
        'IG_PASSWORD is not set and no valid saved session exists. Add the password to .env and restart.',
      );
    }

    this.lastLoginAttemptAt = this.now();
    this.#setState('connecting');
    const ig = this.#newClient();
    try {
      await ig.simulate.preLoginFlow().catch((err) => {
        this.logger.debug({ err: serializeError(err) }, 'Pre-login flow failed (non-fatal)');
      });
      await ig.account.login(this.username, this.password);
    } catch (err) {
      const c = classifyAuthError(err);
      if (c.kind === 'auth') {
        await this.#handleAuthFailure(c); // sets state auth_required
        throw new AuthError(`Login failed: ${c.code}`, { code: c.code });
      }
      this.#setState('disconnected');
      if (c.kind === 'session') {
        throw new AuthError(`Login failed: ${c.code}`, { code: c.code });
      }
      throw new BotError('Login failed due to a network or Instagram error', {
        code: 'TRANSIENT',
        cause: err,
      });
    }

    this.ig = ig;
    await ig.simulate.postLoginFlow().catch((err) => {
      this.logger.debug({ err: serializeError(err) }, 'Post-login flow failed (non-fatal)');
    });
    await this.authGuard.recordSuccess();
    await this.saveSession();
    this.logger.info('Logged in to Instagram');
    this.#setState('connected');
  }

  async #handleAuthFailure(c) {
    const multiplier = c.cooldownMultiplier || 1;
    await this.authGuard.recordFailure(c.code, this.loginCooldownMs * multiplier);
    this.#setState('auth_required');
    this.logger.error(
      { code: c.code },
      'Instagram requires manual action (checkpoint, 2FA, block or credential issue). The bot will not retry automatically.',
    );
  }

  async saveSession() {
    if (!this.ig) return;
    const json = JSON.stringify(await this.ig.state.serialize());
    await this.sessionStore.save(json);
    this.lastSessionSaveAt = this.now();
  }

  /**
   * Start polling for incoming messages. `onMessage` receives
   * { threadId, itemId, userId, username, text, timestampMicros } one by one.
   */
  listen(onMessage) {
    if (this.state !== 'connected') {
      throw new BotError('Cannot listen before the connection is established', { code: 'NOT_CONNECTED' });
    }
    this.onMessage = onMessage;
    this.stopped = false;
    this.#schedule(0);
  }

  #schedule(delayMs) {
    if (this.stopped) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.poll();
    }, delayMs);
  }

  /** One polling cycle. Exposed for tests. Errors are handled here and never escape. */
  async poll() {
    if (this.stopped || !this.ig) return;
    try {
      const threads = await this.ig.feed.directInbox().items();
      const messages = collectNewMessages({
        threads,
        viewerId: this.#viewerId(),
        baselines: this.baselines,
        startMicros: this.startMicros,
      });
      this.consecutiveFailures = 0;

      for (const message of messages) {
        try {
          await this.onMessage?.(message);
        } catch (err) {
          this.logger.error({ err: serializeError(err) }, 'Message handler failed');
        }
      }

      if (this.now() - this.lastSessionSaveAt > SESSION_SAVE_INTERVAL_MS) {
        await this.saveSession().catch((err) =>
          this.logger.warn({ err: serializeError(err) }, 'Periodic session save failed'),
        );
      }
      this.#schedule(this.pollIntervalMs);
    } catch (err) {
      await this.#handlePollError(err);
    }
  }

  async #handlePollError(err) {
    const c = classifyAuthError(err);

    if (c.kind === 'session') {
      this.logger.warn('Session expired while polling');
      await this.sessionStore.clear();
      if (this.now() - this.lastLoginAttemptAt < MIN_RELOGIN_INTERVAL_MS) {
        this.#setState('auth_required');
        this.logger.error('Session expired again shortly after login. Stopping to avoid a login loop.');
        return;
      }
      try {
        await this.login();
        this.consecutiveFailures = 0;
        this.#schedule(0);
      } catch (loginErr) {
        this.logger.error({ err: serializeError(loginErr) }, 'Re-login failed; polling stopped');
      }
      return;
    }

    if (c.kind === 'auth') {
      await this.#handleAuthFailure(c);
      return;
    }

    this.consecutiveFailures += 1;
    const delay = Math.min(this.pollIntervalMs * 2 ** this.consecutiveFailures, MAX_BACKOFF_MS);
    this.logger.warn(
      { code: c.code, consecutiveFailures: this.consecutiveFailures, retryInMs: delay, err: serializeError(err) },
      'Polling failed; retrying with backoff',
    );
    this.#schedule(delay);
  }

  /**
   * Send a text message to an existing thread. Long text is truncated to MAX_OUTGOING_TEXT.
   * @param {string} threadId
   * @param {string} text
   */
  async sendText(threadId, text) {
    if (this.state !== 'connected' || !this.ig) {
      throw new BotError('Not connected to Instagram', { code: 'NOT_CONNECTED' });
    }
    const body = String(text).slice(0, MAX_OUTGOING_TEXT);
    await this.ig.entity.directThread(String(threadId)).broadcastText(body);
  }

  /** Stop polling and persist the current session. Safe to call more than once. */
  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = null;
    try {
      await this.saveSession();
    } catch (err) {
      this.logger.warn({ err: serializeError(err) }, 'Could not save session on shutdown');
    }
    this.#setState('stopped');
  }
}
