/**
 * Bot entry point. Wires together config, logging, Instagram, command handling
 * and process lifecycle. Business logic lives in the imported modules.
 *
 * Exit codes:
 *   0  normal shutdown (SIGINT / SIGTERM)
 *   1  configuration error or unexpected fatal error
 *   2  Instagram needs manual action (checkpoint, 2FA, block, bad credentials, cooldown).
 *      Do not restart automatically; this exit code is meant for systemd RestartPreventExitStatus.
 *   3  transient startup failure (network); safe to retry later
 */
import { pathToFileURL } from 'node:url';
import { loadConfig } from './lib/config.js';
import { createLogger, serializeError } from './lib/logger.js';
import { SessionStore } from './lib/session-store.js';
import { AuthGuard } from './lib/auth-guard.js';
import { packageInfo } from './lib/package-info.js';
import { AuthCooldownError, AuthError, BotError, ConfigError } from './lib/errors.js';
import { InstagramConnection } from './instagram.js';
import { createCommandRegistry, createHandler } from './handler.js';
import { builtinCommands } from './commands/index.js';

export const EXIT = Object.freeze({ OK: 0, FATAL: 1, AUTH_REQUIRED: 2, TRANSIENT: 3 });

function exitCodeFor(err) {
  if (err instanceof ConfigError) return EXIT.FATAL;
  if (err instanceof AuthError || err instanceof AuthCooldownError) return EXIT.AUTH_REQUIRED;
  if (err instanceof BotError && err.code === 'TRANSIENT') return EXIT.TRANSIENT;
  return EXIT.FATAL;
}

export async function main() {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    // Config errors are printed to stderr directly, since the logger is not ready yet.
    console.error(err.message);
    process.exit(EXIT.FATAL);
  }

  const logger = createLogger({ level: config.logLevel });
  const startedAt = Date.now();
  logger.info({ name: packageInfo.name, version: packageInfo.version, node: process.version }, 'Starting bot');

  const sessionStore = new SessionStore({
    filePath: config.sessionFile,
    secret: config.sessionSecret,
    logger,
  });
  const authGuard = new AuthGuard({ filePath: config.authStateFile, logger });
  const ig = new InstagramConnection({
    username: config.username,
    password: config.password,
    sessionStore,
    authGuard,
    logger,
    loginCooldownMinutes: config.loginCooldownMinutes,
    pollIntervalMs: config.pollIntervalMs,
  });

  const registry = createCommandRegistry(builtinCommands);
  const handle = createHandler({
    prefix: config.prefix,
    registry,
    logger,
    services: {
      startedAt,
      getInstagramStatus: () => ig.getStatus(),
    },
  });

  let shuttingDown = false;
  async function shutdown(reason, exitCode = EXIT.OK) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ reason }, 'Shutting down');
    await ig.stop();
    process.exit(exitCode);
  }

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('uncaughtException', (err) => {
    logger.fatal({ err: serializeError(err) }, 'Uncaught exception');
    void shutdown('uncaughtException', EXIT.FATAL);
  });
  process.on('unhandledRejection', (reason) => {
    logger.error({ err: serializeError(reason) }, 'Unhandled promise rejection');
  });

  try {
    await ig.start();
  } catch (err) {
    logger.error({ code: err.code, err: serializeError(err) }, 'Could not start the Instagram connection');
    await ig.stop();
    process.exit(exitCodeFor(err));
  }

  ig.listen(async (message) => {
    const result = await handle({
      threadId: message.threadId,
      userId: message.userId,
      username: message.username,
      itemId: message.itemId,
      text: message.text,
      receivedAt: Date.now(),
    });
    if (result.handled && result.reply) {
      try {
        await ig.sendText(message.threadId, result.reply);
      } catch (err) {
        logger.error({ command: result.command, err: serializeError(err) }, 'Failed to send reply');
      }
    }
  });

  logger.info({ prefix: config.prefix, commands: registry.size }, 'Bot is running and listening for messages');
}

// Run only when executed directly (node src/index.js), not when imported by tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('Fatal startup error:', err.message);
    process.exit(EXIT.FATAL);
  });
}
