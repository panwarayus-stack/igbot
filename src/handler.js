/**
 * Command routing: parsing, validation, registry and dispatch.
 *
 * This module has no Instagram dependency. It takes plain message objects and
 * returns reply text, so it can be tested without credentials.
 */
import { z } from 'zod';
import { serializeError } from './lib/logger.js';

export const COMMAND_NAME_PATTERN = /^[a-z0-9_-]{1,32}$/;
export const DEFAULT_COMMAND_TIMEOUT_MS = 10000;

/** Shape of an incoming chat message, as passed from the Instagram layer. */
export const incomingMessageSchema = z.object({
  threadId: z.string().min(1).max(64),
  userId: z.string().min(1).max(64),
  username: z.string().max(64).optional(),
  itemId: z.string().max(128).optional(),
  text: z.string().max(4000),
  receivedAt: z.number().int().nonnegative().optional(),
});

/** Shape every command module must satisfy. */
export const commandSchema = z.object({
  name: z.string().regex(COMMAND_NAME_PATTERN, 'command name must be 1-32 chars of a-z, 0-9, _ or -'),
  aliases: z.array(z.string().regex(COMMAND_NAME_PATTERN)).default([]),
  description: z.string().min(1).max(200),
  usage: z.string().max(200).optional(),
  execute: z.custom((value) => typeof value === 'function', 'execute must be a function'),
});

/**
 * Parse "!name arg1 arg2" into { name, args, rawArgs }.
 * Returns null for non-commands, a bare prefix, or text that does not start with the prefix.
 * @param {string} text
 * @param {string} [prefix='!']
 */
export function parseCommand(text, prefix = '!') {
  if (typeof text !== 'string' || typeof prefix !== 'string' || prefix.length === 0) return null;
  const trimmed = text.trim();
  if (!trimmed.startsWith(prefix)) return null;
  const body = trimmed.slice(prefix.length).trim();
  if (body.length === 0) return null;
  const [rawName] = body.split(/\s+/);
  const rawArgs = body.slice(rawName.length).trim();
  return {
    name: rawName.toLowerCase(),
    args: rawArgs ? rawArgs.split(/\s+/) : [],
    rawArgs,
  };
}

/**
 * Registry of command modules. Names and aliases share one namespace.
 * @param {Array<object>} [commands]
 */
export function createCommandRegistry(commands = []) {
  const byName = new Map();
  const unique = new Set();

  function register(command) {
    const result = commandSchema.safeParse(command);
    if (!result.success) {
      const details = result.error.issues.map((i) => `${i.path.join('.') || 'command'}: ${i.message}`);
      throw new TypeError(`Invalid command module: ${details.join('; ')}`);
    }
    const cmd = result.data;
    const keys = [cmd.name, ...cmd.aliases];
    for (const key of keys) {
      if (byName.has(key)) {
        throw new Error(`Duplicate command name or alias: "${key}"`);
      }
    }
    for (const key of keys) byName.set(key, cmd);
    unique.add(cmd);
    return api;
  }

  function registerAll(list) {
    for (const command of list) register(command);
    return api;
  }

  const api = {
    register,
    registerAll,
    /** @returns {object | null} */
    get: (name) => byName.get(name) ?? null,
    /** Unique command objects, in registration order. */
    list: () => [...unique],
    get size() {
      return unique.size;
    },
  };

  return registerAll(commands);
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('Command timed out'), { code: 'TIMEOUT' })), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Build the message handler.
 *
 * The returned function never throws. It resolves to a result object:
 *   { handled: false, reason: 'invalid' | 'empty' | 'not_command' }
 *   { handled: true, command, reason: 'ok' | 'unknown' | 'error', reply }
 *
 * @param {object} options
 * @param {string} [options.prefix='!']
 * @param {ReturnType<typeof createCommandRegistry>} options.registry
 * @param {import('pino').Logger} options.logger
 * @param {object} [options.services] shared read-only services passed to commands (e.g. startedAt)
 * @param {() => number} [options.now]
 * @param {number} [options.commandTimeoutMs]
 */
export function createHandler({
  prefix = '!',
  registry,
  logger,
  services = {},
  now = () => Date.now(),
  commandTimeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
}) {
  return async function handle(rawMessage) {
    const parsed = incomingMessageSchema.safeParse(rawMessage);
    if (!parsed.success) {
      logger.warn(
        { issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), code: i.code })) },
        'Ignoring invalid incoming message',
      );
      return { handled: false, reason: 'invalid' };
    }
    const message = parsed.data;

    if (message.text.trim().length === 0) {
      return { handled: false, reason: 'empty' };
    }

    const command = parseCommand(message.text, prefix);
    if (!command) {
      return { handled: false, reason: 'not_command' };
    }

    const entry = registry.get(command.name);
    if (!entry) {
      const shown = COMMAND_NAME_PATTERN.test(command.name) ? command.name : 'unknown';
      logger.info({ command: shown, threadId: message.threadId }, 'Unknown command');
      return {
        handled: true,
        command: null,
        reason: 'unknown',
        reply: `Unknown command "${prefix}${shown}". Type ${prefix}help to see available commands.`,
      };
    }

    const started = now();
    const ctx = {
      args: command.args,
      rawArgs: command.rawArgs,
      prefix,
      message,
      registry,
      services,
      now,
    };

    try {
      const output = await withTimeout(Promise.resolve().then(() => entry.execute(ctx)), commandTimeoutMs);
      const reply = typeof output === 'string' ? output : String(output ?? '');
      logger.info(
        { command: entry.name, threadId: message.threadId, durationMs: now() - started },
        'Command executed',
      );
      return { handled: true, command: entry.name, reason: 'ok', reply };
    } catch (err) {
      logger.error(
        { command: entry.name, threadId: message.threadId, durationMs: now() - started, err: serializeError(err) },
        'Command failed',
      );
      return {
        handled: true,
        command: entry.name,
        reason: 'error',
        reply: 'Something went wrong while running that command. Please try again later.',
      };
    }
  };
}
