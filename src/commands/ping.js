/** !ping — measure how long the bot took to handle this message. */
export default {
  name: 'ping',
  description: 'Show bot response time',
  usage: '!ping',
  async execute({ message, now }) {
    if (typeof message.receivedAt !== 'number') {
      return 'Pong!';
    }
    const elapsed = Math.max(0, Math.round(now() - message.receivedAt));
    return `Pong! Response time: ${elapsed} ms`;
  },
};
