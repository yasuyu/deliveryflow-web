// Only the isolated idle-mode tests load this observer. Never record SQL or parameters.
const fs = require('node:fs');
const client = require('../../generated/client-v2');
const OriginalPrismaClient = client.PrismaClient;
client.PrismaClient = class extends OriginalPrismaClient {
  constructor(options) {
    super({ ...options, log: [{ emit: 'event', level: 'query' }] });
    this.$on('query', () => fs.appendFileSync(process.env.DELIVERYFLOW_TEST_QUERY_LOG, 'query\n'));
  }
};

// Speed up real server timers so a regression cannot hide behind a five-minute wait.
const originalSetInterval = global.setInterval;
global.setInterval = (callback, milliseconds, ...args) => originalSetInterval(
  callback, [300_000, 30_000].includes(milliseconds) ? 50 : milliseconds, ...args,
);
