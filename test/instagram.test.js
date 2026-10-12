import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import {
  IgCheckpointError,
  IgLoginBadPasswordError,
  IgLoginRequiredError,
  IgLoginTwoFactorRequiredError,
  IgRequestsLimitError,
  IgSentryBlockError,
} from 'instagram-private-api';
import {
  InstagramConnection,
  classifyAuthError,
  collectNewMessages,
} from '../src/instagram.js';
import { SessionStore } from '../src/lib/session-store.js';
import { AuthGuard } from '../src/lib/auth-guard.js';
import { AuthCooldownError, AuthError, ConfigError } from '../src/lib/errors.js';

const silent = pino({ level: 'silent' });
const SECRET = 'c'.repeat(40);

/** Build a library error object without making a network request. */
function libError(Cls, body = {}) {
  const response = {
    body,
    statusCode: 400,
    statusMessage: 'Bad Request',
    request: { method: 'POST', uri: { path: '/api/v1/test/' } },
  };
  return new Cls(response);
}

/** Minimal stand-in for IgApiClient covering only the surface InstagramConnection uses. */
function fakeClient(overrides = {}) {
  const client = {
    state: {
      generateDevice: vi.fn(),
      deserialize: vi.fn(async () => {}),
      serialize: vi.fn(async () => ({ cookies: '[]', deviceId: 'android-test' })),
      extractUserId: vi.fn(() => '999'),
    },
    account: {
      currentUser: vi.fn(async () => ({ pk: 999 })),
      login: vi.fn(async () => ({ pk: 999 })),
    },
    simulate: {
      preLoginFlow: vi.fn(async () => {}),
      postLoginFlow: vi.fn(async () => {}),
    },
    feed: { directInbox: vi.fn(() => ({ items: vi.fn(async () => []) })) },
    entity: { directThread: vi.fn(() => ({ broadcastText: vi.fn(async () => ({})) })) },
    ...overrides,
  };
  return client;
}

let dir;
let store;
let guard;
let now;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'igbot-ig-'));
  now = 1_700_000_000_000;
  store = new SessionStore({ filePath: join(dir, 'session.enc'), secret: SECRET, logger: silent });
  guard = new AuthGuard({ filePath: join(dir, 'auth.json'), logger: silent, now: () => now });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function connection({ client, password = 'pw', pollIntervalMs = 5000 } = {}) {
  return new InstagramConnection({
    username: 'example_user',
    password,
    sessionStore: store,
    authGuard: guard,
    logger: silent,
    loginCooldownMinutes: 60,
    pollIntervalMs,
    clientFactory: () => client,
    now: () => now,
  });
}

describe('classifyAuthError', () => {
  it('maps library errors to codes and handling kinds', () => {
    expect(classifyAuthError(libError(IgLoginRequiredError, { message: 'login_required' }))).toMatchObject({
      kind: 'session',
      code: 'SESSION_EXPIRED',
    });
    expect(classifyAuthError(libError(IgCheckpointError, { message: 'challenge_required' }))).toMatchObject({
      kind: 'auth',
      code: 'CHECKPOINT_REQUIRED',
    });
    expect(classifyAuthError(libError(IgLoginTwoFactorRequiredError))).toMatchObject({
      kind: 'auth',
      code: 'TWO_FACTOR_REQUIRED',
    });
    expect(classifyAuthError(libError(IgLoginBadPasswordError))).toMatchObject({ kind: 'auth', code: 'BAD_PASSWORD' });
    expect(classifyAuthError(libError(IgSentryBlockError))).toMatchObject({ kind: 'auth', code: 'ACCOUNT_BLOCKED' });
    expect(classifyAuthError(libError(IgRequestsLimitError))).toMatchObject({ kind: 'transient', code: 'RATE_LIMITED' });
    expect(classifyAuthError(new Error('ECONNRESET'))).toMatchObject({ kind: 'transient', code: 'UNKNOWN' });
  });
});

describe('collectNewMessages', () => {
  const thread = (id, items, users = [{ pk: 42, username: 'friend' }]) => ({
    thread_id: id,
    users,
    items,
  });
  const item = (id, userId, ts, text = 'hi', type = 'text') => ({
    item_id: id,
    user_id: userId,
    timestamp: String(ts),
    item_type: type,
    text,
  });

  it('does not replay history older than startMicros', () => {
    const baselines = new Map();
    const msgs = collectNewMessages({
      threads: [thread('t1', [item('a', 42, 100)])],
      viewerId: '999',
      baselines,
      startMicros: 200n,
    });
    expect(msgs).toEqual([]);
    expect(baselines.get('t1')).toBe(200n);
  });

  it('returns new incoming text messages in chronological order', () => {
    const baselines = new Map([['t1', 100n]]);
    const msgs = collectNewMessages({
      threads: [thread('t1', [item('b', 42, 300, 'second'), item('a', 42, 200, 'first')])],
      viewerId: '999',
      baselines,
      startMicros: 0n,
    });
    expect(msgs.map((m) => m.text)).toEqual(['first', 'second']);
    expect(msgs[0]).toMatchObject({ threadId: 't1', userId: '42', username: 'friend', itemId: 'a' });
    expect(baselines.get('t1')).toBe(300n);
  });

  it('skips the bot’s own messages, non-text items and already-seen items', () => {
    const baselines = new Map([['t1', 100n]]);
    const msgs = collectNewMessages({
      threads: [
        thread('t1', [
          item('own', 999, 150, 'my reply'),
          item('img', 42, 160, undefined, 'media'),
          item('dup', 42, 90, 'old'),
          item('ok', 42, 170, 'hello'),
        ]),
      ],
      viewerId: '999',
      baselines,
      startMicros: 0n,
    });
    expect(msgs.map((m) => m.itemId)).toEqual(['ok']);
  });

  it('handles threads that appear for the first time after startup', () => {
    const baselines = new Map();
    const msgs = collectNewMessages({
      threads: [thread('new', [item('x', 42, 500, 'new chat')])],
      viewerId: '999',
      baselines,
      startMicros: 400n,
    });
    expect(msgs.map((m) => m.text)).toEqual(['new chat']);
  });
});

describe('InstagramConnection.start', () => {
  it('restores a valid saved session without logging in', async () => {
    await store.save(JSON.stringify({ cookies: '[]' }));
    const client = fakeClient();
    const conn = connection({ client });
    await conn.start();
    expect(conn.getStatus().state).toBe('connected');
    expect(client.state.deserialize).toHaveBeenCalledOnce();
    expect(client.account.login).not.toHaveBeenCalled();
    expect(client.state.generateDevice).toHaveBeenCalledWith('example_user');
  });

  it('clears an expired session and performs one login', async () => {
    await store.save(JSON.stringify({ cookies: '[]' }));
    const client = fakeClient({
      account: {
        currentUser: vi.fn(async () => {
          throw libError(IgLoginRequiredError, { message: 'login_required' });
        }),
        login: vi.fn(async () => ({ pk: 999 })),
      },
    });
    const conn = connection({ client });
    await conn.start();
    expect(client.account.login).toHaveBeenCalledOnce();
    expect(client.account.login).toHaveBeenCalledWith('example_user', 'pw');
    expect(conn.getStatus().state).toBe('connected');
    // A fresh session was saved after login, and it is encrypted.
    expect(await store.load()).not.toBeNull();
  });

  it('refuses to log in when no password is configured', async () => {
    const client = fakeClient();
    const conn = connection({ client, password: '' });
    await expect(conn.start()).rejects.toBeInstanceOf(ConfigError);
    expect(client.account.login).not.toHaveBeenCalled();
  });

  it('stops after a bad password and does not retry on the next start', async () => {
    const client = fakeClient({
      account: {
        currentUser: vi.fn(),
        login: vi.fn(async () => {
          throw libError(IgLoginBadPasswordError, { error_type: 'bad_password' });
        }),
      },
    });
    const conn = connection({ client });
    await expect(conn.start()).rejects.toMatchObject({ code: 'BAD_PASSWORD' });
    expect(conn.getStatus().state).toBe('auth_required');
    expect(client.account.login).toHaveBeenCalledTimes(1);

    // Simulated restart with a fresh process: the persisted cooldown must block the attempt.
    const second = fakeClient();
    const conn2 = connection({ client: second });
    await expect(conn2.start()).rejects.toBeInstanceOf(AuthCooldownError);
    expect(second.account.login).not.toHaveBeenCalled();
  });

  it('does not attempt login for two-factor or checkpoint challenges', async () => {
    const client = fakeClient({
      account: {
        currentUser: vi.fn(),
        login: vi.fn(async () => {
          throw libError(IgLoginTwoFactorRequiredError);
        }),
      },
    });
    const conn = connection({ client });
    await expect(conn.start()).rejects.toBeInstanceOf(AuthError);
    expect(conn.getStatus().state).toBe('auth_required');
    expect(await guard.check()).toMatchObject({ allowed: false, code: 'TWO_FACTOR_REQUIRED' });
  });
});

describe('InstagramConnection polling and sending', () => {
  it('delivers only new incoming messages to the listener', async () => {
    const client = fakeClient();
    const conn = connection({ client });
    await conn.start();

    // First poll establishes the baseline; the history item is not delivered.
    client.feed.directInbox.mockReturnValue({
      items: vi.fn(async () => [
        { thread_id: 't1', users: [{ pk: 42, username: 'friend' }], items: [
          { item_id: 'old', user_id: 42, timestamp: '1', item_type: 'text', text: 'history' },
        ] },
      ]),
    });
    const received = [];
    conn.onMessage = async (m) => received.push(m);
    await conn.poll();
    expect(received).toEqual([]);

    const newer = String(BigInt(now) * 1000n + 5n);
    client.feed.directInbox.mockReturnValue({
      items: vi.fn(async () => [
        { thread_id: 't1', users: [{ pk: 42, username: 'friend' }], items: [
          { item_id: 'new', user_id: 42, timestamp: newer, item_type: 'text', text: '!ping' },
        ] },
      ]),
    });
    await conn.poll();
    expect(received.map((m) => m.text)).toEqual(['!ping']);
    conn.stop();
  });

  it('sends text through the thread entity and truncates long replies', async () => {
    const broadcastText = vi.fn(async () => ({}));
    const client = fakeClient({ entity: { directThread: vi.fn(() => ({ broadcastText })) } });
    const conn = connection({ client });
    await conn.start();
    await conn.sendText('t1', 'x'.repeat(5000));
    expect(client.entity.directThread).toHaveBeenCalledWith('t1');
    expect(broadcastText.mock.calls[0][0]).toHaveLength(1000);
    await conn.stop();
  });

  it('refuses to send when not connected', async () => {
    const conn = connection({ client: fakeClient() });
    await expect(conn.sendText('t1', 'hi')).rejects.toMatchObject({ code: 'NOT_CONNECTED' });
  });
});
