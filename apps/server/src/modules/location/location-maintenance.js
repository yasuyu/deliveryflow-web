const cleanupIntervalMilliseconds = 5 * 60 * 1000;

function databaseIdleModeFromEnv(value = process.env.DATABASE_IDLE_MODE) {
  if (value === undefined || value === '' || value === 'false') return false;
  if (value === 'true') return true;
  throw new Error('DATABASE_IDLE_MODE must be true or false');
}

function createLocationMaintenance({ idleMode, cleanup, onError, now = Date.now }) {
  let timer;
  let pending;
  let lastCleanupAt = -Infinity;

  async function run() {
    if (pending) return pending;
    pending = Promise.resolve().then(cleanup).then(() => { lastCleanupAt = now(); });
    try {
      await pending;
    } finally {
      pending = undefined;
    }
  }

  return {
    start() {
      if (idleMode || timer) return;
      timer = setInterval(() => { void run().catch(onError); }, cleanupIntervalMilliseconds);
      timer.unref();
    },
    stop() {
      clearInterval(timer);
      timer = undefined;
    },
    async onActivity() {
      if (idleMode && now() - lastCleanupAt >= cleanupIntervalMilliseconds) await run();
    },
  };
}

module.exports = { databaseIdleModeFromEnv, createLocationMaintenance };
