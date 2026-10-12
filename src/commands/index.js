/**
 * Built-in commands. To add one, create a module in this folder that default-exports
 * { name, aliases?, description, usage?, execute(ctx) } and add it to the list below.
 * `execute` receives { args, rawArgs, prefix, message, registry, services, now } and returns the reply text.
 */
import help from './help.js';
import ping from './ping.js';
import uptime from './uptime.js';
import info from './info.js';

export const builtinCommands = [help, ping, uptime, info];
