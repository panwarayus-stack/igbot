import { formatDuration } from '../lib/format.js';

/** !uptime — how long the bot process has been running. */
export default {
  name: 'uptime',
  description: 'Show how long the bot has been running',
  usage: '!uptime',
  async execute({ services, now }) {
    if (typeof services.startedAt !== 'number') {
      return 'Uptime: unknown';
    }
    return `Uptime: ${formatDuration(now() - services.startedAt)}`;
  },
};
