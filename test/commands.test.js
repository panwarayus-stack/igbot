import { describe, expect, it } from 'vitest';
import pino from 'pino';
import { createCommandRegistry, createHandler } from '../src/handler.js';
import { builtinCommands } from '../src/commands/index.js';
import { formatDuration } from '../src/lib/format.js';

const silent = pino({ level: 'silent' });

function setup({ now = 1_000_000, startedAt = 1_000_000 - 90_061_000, state = 'connected' } = {}) {
  const registry = createCommandRegistry(builtinCommands);
  const handle = createHandler({
    prefix: '!',
    registry,
    logger: silent,
    now: () => now,
    services: { startedAt, getInstagramStatus: () => ({ state }) },
  });
  return { handle, registry, now };
}

const msg = (text, receivedAt = 1_000_000) => ({ threadId: 't', userId: 'u', text, receivedAt });

describe('built-in commands', () => {
  it('registers help, ping, uptime and info', () => {
    const { registry } = setup();
    expect(registry.list().map((c) => c.name).sort()).toEqual(['help', 'info', 'ping', 'uptime']);
  });

  it('!ping reports response time from receipt to handling', async () => {
    const { handle } = setup({ now: 1_000_250 });
    const result = await handle(msg('!ping', 1_000_000));
    expect(result.reply).toBe('Pong! Response time: 250 ms');
  });

  it('!uptime formats the time since start', async () => {
    const { handle } = setup();
    const result = await handle(msg('!uptime'));
    expect(result.reply).toBe('Uptime: 1d 1h 1m 1s');
  });

  it('!info includes version, prefix and Instagram state, but no credentials', async () => {
    const { handle } = setup({ state: 'auth_required' });
    const { reply } = await handle(msg('!info'));
    expect(reply).toMatch(/^igbot v/);
    expect(reply).toMatch(/Command prefix: !/);
    expect(reply).toMatch(/Instagram: auth_required/);
    expect(reply).not.toMatch(/password|cookie|session/i);
  });

  it('!help lists every command', async () => {
    const { handle } = setup();
    const { reply } = await handle(msg('!help'));
    for (const name of ['help', 'ping', 'uptime', 'info']) {
      expect(reply).toContain(`!${name}`);
    }
  });

  it('!help <command> shows details, and reports unknown names', async () => {
    const { handle } = setup();
    expect((await handle(msg('!help ping'))).reply).toMatch(/Response time|ping/);
    expect((await handle(msg('!help ping'))).reply).toContain('Usage: !ping');
    expect((await handle(msg('!help zzz'))).reply).toMatch(/No command named "zzz"/);
  });

  it('aliases work (!commands, !about)', async () => {
    const { handle } = setup();
    expect((await handle(msg('!commands'))).command).toBe('help');
    expect((await handle(msg('!about'))).command).toBe('info');
  });
});

describe('formatDuration', () => {
  it('formats common durations and clamps invalid input', () => {
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(59_000)).toBe('59s');
    expect(formatDuration(61_000)).toBe('1m 1s');
    expect(formatDuration(3_600_000)).toBe('1h 0m 0s');
    expect(formatDuration(86_400_000)).toBe('1d 0h 0m 0s');
    expect(formatDuration(-5)).toBe('0s');
    expect(formatDuration(NaN)).toBe('0s');
  });
});
