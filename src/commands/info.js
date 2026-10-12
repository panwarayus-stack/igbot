import { packageInfo } from '../lib/package-info.js';
import { formatDuration } from '../lib/format.js';

/** !info — bot version, runtime and connection status. Does not expose credentials or account details. */
export default {
  name: 'info',
  aliases: ['about'],
  description: 'Show bot information',
  usage: '!info',
  async execute({ prefix, services, now }) {
    const status = services.getInstagramStatus?.() ?? {};
    const lines = [
      `${packageInfo.name} v${packageInfo.version}`,
      `Runtime: Node.js ${process.version} on ${process.platform}/${process.arch}`,
      `Command prefix: ${prefix}`,
      `Instagram: ${status.state ?? 'unknown'}`,
    ];
    if (typeof services.startedAt === 'number') {
      lines.push(`Uptime: ${formatDuration(now() - services.startedAt)}`);
    }
    return lines.join('\n');
  },
};
