import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import pino from 'pino';
import { SessionStore } from '../src/lib/session-store.js';
import { AuthGuard } from '../src/lib/auth-guard.js';

const silent = pino({ level: 'silent' });
const SECRET = 'a'.repeat(40);

let dir;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'igbot-test-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('SessionStore', () => {
  it('round-trips plaintext through encryption', async () => {
    const store = new SessionStore({ filePath: join(dir, 'session.enc'), secret: SECRET, logger: silent });
    await store.save('{"cookies":"sessionid=abc"}');
    expect(await store.load()).toBe('{"cookies":"sessionid=abc"}');
  });

  it('never writes the plaintext to disk and uses owner-only permissions', async () => {
    const file = join(dir, 'session.enc');
    const store = new SessionStore({ filePath: file, secret: SECRET, logger: silent });
    await store.save('{"cookies":"sessionid=SUPER_SECRET_VALUE"}');
    const raw = await readFile(file, 'utf8');
    expect(raw).not.toContain('SUPER_SECRET_VALUE');
    expect(raw).not.toContain('sessionid');
    const mode = (await stat(file)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('returns null when no session exists', async () => {
    const store = new SessionStore({ filePath: join(dir, 'none.enc'), secret: SECRET, logger: silent });
    expect(await store.load()).toBeNull();
  });

  it('returns null (does not throw) for a different secret or a corrupted file', async () => {
    const file = join(dir, 'session.enc');
    await new SessionStore({ filePath: file, secret: SECRET, logger: silent }).save('data');
    const wrong = new SessionStore({ filePath: file, secret: 'b'.repeat(40), logger: silent });
    expect(await wrong.load()).toBeNull();

    await writeFile(file, 'not json');
    expect(await new SessionStore({ filePath: file, secret: SECRET, logger: silent }).load()).toBeNull();
  });

  it('clear() removes the file and is idempotent', async () => {
    const file = join(dir, 'session.enc');
    const store = new SessionStore({ filePath: file, secret: SECRET, logger: silent });
    await store.save('x');
    await store.clear();
    await store.clear();
    expect(await store.load()).toBeNull();
  });

  it('refuses a weak secret', () => {
    expect(() => new SessionStore({ filePath: 'x', secret: 'short', logger: silent })).toThrow(TypeError);
  });
});

describe('AuthGuard', () => {
  it('blocks login during the cooldown and allows it afterwards', async () => {
    let now = 1_000_000;
    const guard = new AuthGuard({ filePath: join(dir, 'auth.json'), logger: silent, now: () => now });
    expect((await guard.check()).allowed).toBe(true);

    await guard.recordFailure('BAD_PASSWORD', 60_000);
    const blocked = await guard.check();
    expect(blocked.allowed).toBe(false);
    expect(blocked.code).toBe('BAD_PASSWORD');

    now += 61_000;
    expect((await guard.check()).allowed).toBe(true);
  });

  it('stores only the failure code and timestamps', async () => {
    const file = join(dir, 'auth.json');
    const guard = new AuthGuard({ filePath: file, logger: silent });
    await guard.recordFailure('CHECKPOINT_REQUIRED', 1000);
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    expect(Object.keys(parsed.failure).sort()).toEqual(['at', 'code', 'retryAfter']);
  });

  it('recordSuccess() clears the cooldown', async () => {
    const guard = new AuthGuard({ filePath: join(dir, 'auth.json'), logger: silent });
    await guard.recordFailure('BAD_PASSWORD', 60_000);
    await guard.recordSuccess();
    expect((await guard.check()).allowed).toBe(true);
  });
});
