/** !help [command] — list commands, or show details for one. */
export function formatCommandList(commands, prefix) {
  const lines = [`Available commands (prefix "${prefix}"):`];
  for (const cmd of commands) {
    lines.push(`${prefix}${cmd.name} — ${cmd.description}`);
  }
  lines.push(`Type ${prefix}help <command> for details.`);
  return lines.join('\n');
}

export function formatCommandDetail(cmd, prefix) {
  const lines = [`${prefix}${cmd.name} — ${cmd.description}`];
  lines.push(`Usage: ${cmd.usage ?? `${prefix}${cmd.name}`}`);
  if (cmd.aliases?.length) {
    lines.push(`Aliases: ${cmd.aliases.map((a) => prefix + a).join(', ')}`);
  }
  return lines.join('\n');
}

export default {
  name: 'help',
  aliases: ['commands'],
  description: 'Show available commands',
  usage: '!help [command]',
  async execute({ args, prefix, registry }) {
    const commands = registry.list();
    if (args.length === 0) {
      return formatCommandList(commands, prefix);
    }
    const target = registry.get(args[0].toLowerCase());
    if (!target) {
      return `No command named "${args[0]}". Type ${prefix}help to see all commands.`;
    }
    return formatCommandDetail(target, prefix);
  },
};
