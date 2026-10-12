import { describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import { parseCommand, createCommandRegistry, createHandler } from '../src/handler.js';

const silent = pino({ level: 'silent' });

const msg = (text, extra = {}) => ({ threadId: 't1', userId: 'u1', text, receivedAt: 1000, ...extra });

describe('parseCommand', () => {
  it('parses name and arguments', () => {
    expect(parseCommand('!ping', '!')).toEqual({ name: 'ping', args: [], rawArgs: '' });
    expect(parseCommand('  !Help   ping  pong ', '!')).toEqual({
      name: 'help',
      args: ['ping', 'pong'],
      rawArgs: 'ping  pong',
    });
  });

  it('returns null for non-commands, a bare prefix, or empty input', () => {
    expect(parseCommand('hello', '!')).toBeNull();
    expect(parseCommand('!', '!')).toBeNull();
    expect(parseCommand('!   ', '!')).toBeNull();
    expect(parseCommand('', '!')).toBeNull();
    expect(parseCommand(undefined, '!')).toBeNull();
  });

  it('supports other prefixes', () => {
    expect(parseCommand('.ping', '.')?.name).toBe('ping');
    expect(parseCommand('!ping', '.')).toBeNull();
  });
});

describe('createCommandRegistry', () => {
  const cmd = (name, extra = {}) => ({
    name,
    description: `${name} command`,
    execute: async () => `${name}!`,
    ...extra,
  });

  it('registers commands and resolves aliases', () => {
    const reg = createCommandRegistry([cmd('ping', { aliases: ['p'] })]);
    expect(reg.get('ping').name).toBe('ping');
    expect(reg.get('p').name).toBe('ping');
    expect(reg.get('missing')).toBeNull();
    expect(reg.list()).toHaveLength(1);
  });

  it('rejects duplicate names and aliases', () => {
    expect(() => createCommandRegistry([cmd('a'), cmd('a')])).toThrow(/Duplicate/);
    expect(() => createCommandRegistry([cmd('a', { aliases: ['b'] }), cmd('b')])).toThrow(/Duplicate/);
  });

  it('rejects invalid command modules', () => {
    expect(() => createCommandRegistry([{ name: 'Bad Name', description: 'x', execute() {} }])).toThrow(
      /Invalid command module/,
    );
    expect(() => createCommandRegistry([{ name: 'ok', description: 'x' }])).toThrow(/execute/);
  });
});

describe('createHandler', () => {
  const registry = createCommandRegistry([
    {
      name: 'echo',
      description: 'echo',
      execute: ({ rawArgs }) => rawArgs || 'nothing',
    },
    {
      name: 'boom',
      description: 'throws',
      execute: () => {
        throw new Error('secret internal detail');
      },
    },
    {
      name: 'slow',
      description: 'never finishes',
      execute: () => new Promise(() => {}),
    },
  ]);

  it('ignores empty and non-command messages without replying', async () => {
    const handle = createHandler({ registry, logger: silent });
    expect(await handle(msg('   '))).toEqual({ handled: false, reason: 'empty' });
    expect(await handle(msg('just chatting'))).toEqual({ handled: false, reason: 'not_command' });
  });

  it('rejects structurally invalid messages', async () => {
    const handle = createHandler({ registry, logger: silent });
    expect((await handle({ threadId: '', userId: 'u', text: '!echo' })).reason).toBe('invalid');
    expect((await handle({ threadId: 't', userId: 'u' })).reason).toBe('invalid');
    expect((await handle(null)).reason).toBe('invalid');
  });

  it('runs a command and returns its reply', async () => {
    const handle = createHandler({ registry, logger: silent });
    expect(await handle(msg('!echo hello world'))).toEqual({
      handled: true,
      command: 'echo',
      reason: 'ok',
      reply: 'hello world',
    });
  });

  it('answers unknown commands gracefully', async () => {
    const handle = createHandler({ registry, logger: silent });
    const result = await handle(msg('!nope'));
    expect(result.reason).toBe('unknown');
    expect(result.reply).toMatch(/Unknown command "!nope"/);
  });

  it('hides internal error details from users and does not throw', async () => {
    const handle = createHandler({ registry, logger: silent });
    const result = await handle(msg('!boom'));
    expect(result.reason).toBe('error');
    expect(result.reply).not.toMatch(/secret internal detail/);
  });

  it('times out slow commands', async () => {
    const handle = createHandler({ registry, logger: silent, commandTimeoutMs: 20 });
    const result = await handle(msg('!slow'));
    expect(result.reason).toBe('error');
  });

  it('passes services and a clock to commands', async () => {
    const spy = vi.fn(() => 'ok');
    const reg = createCommandRegistry([{ name: 'spy', description: 's', execute: spy }]);
    const handle = createHandler({ registry: reg, logger: silent, services: { a: 1 }, now: () => 5 });
    await handle(msg('!spy x'));
    const ctx = spy.mock.calls[0][0];
    expect(ctx.services).toEqual({ a: 1 });
    expect(ctx.args).toEqual(['x']);
    expect(ctx.now()).toBe(5);
  });
});
