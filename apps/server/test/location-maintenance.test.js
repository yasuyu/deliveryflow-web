const assert = require('node:assert/strict');
const { test } = require('node:test');
const { databaseIdleModeFromEnv, createLocationMaintenance } = require('../src/modules/location/location-maintenance');

test('DB休止設定は明示的なtrueだけで有効になる', () => {
  assert.equal(databaseIdleModeFromEnv(''), false);
  assert.equal(databaseIdleModeFromEnv('false'), false);
  assert.equal(databaseIdleModeFromEnv('true'), true);
  assert.throws(() => databaseIdleModeFromEnv('invalid'), /DATABASE_IDLE_MODE/);
});

test('休止モードは利用していない間に定期削除を実行しない', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let calls = 0;
  const maintenance = createLocationMaintenance({ idleMode: true, cleanup: () => { calls += 1; } });
  maintenance.start();
  t.mock.timers.tick(24 * 60 * 60 * 1000);
  assert.equal(calls, 0);
  maintenance.stop();
});

test('通常モードは5分ごとに削除し、停止後は実行しない', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let calls = 0;
  const maintenance = createLocationMaintenance({ idleMode: false, cleanup: () => { calls += 1; }, onError: assert.fail });
  maintenance.start();
  maintenance.start();
  t.mock.timers.tick(5 * 60 * 1000);
  await new Promise(setImmediate);
  assert.equal(calls, 1);
  maintenance.stop();
  t.mock.timers.tick(5 * 60 * 1000);
  await new Promise(setImmediate);
  assert.equal(calls, 1);
});

test('利用再開時は同時リクエストの削除をまとめ、5分間は再実行しない', async () => {
  let clock = 0;
  let calls = 0;
  const maintenance = createLocationMaintenance({ idleMode: true, now: () => clock, cleanup: () => { calls += 1; } });
  await Promise.all([maintenance.onActivity(), maintenance.onActivity(), maintenance.onActivity()]);
  assert.equal(calls, 1);
  clock = 299_999;
  await maintenance.onActivity();
  assert.equal(calls, 1);
  clock = 300_000;
  await maintenance.onActivity();
  assert.equal(calls, 2);
});

test('削除失敗後も次の利用で再実行する', async () => {
  let calls = 0;
  const maintenance = createLocationMaintenance({
    idleMode: true,
    cleanup: () => { calls += 1; if (calls === 1) throw new Error('DB unavailable'); },
  });
  await assert.rejects(maintenance.onActivity(), /DB unavailable/);
  await maintenance.onActivity();
  assert.equal(calls, 2);
});

test('通常モードの利用では定期削除を追加実行しない', async () => {
  let calls = 0;
  const maintenance = createLocationMaintenance({ idleMode: false, cleanup: () => { calls += 1; } });
  await maintenance.onActivity();
  assert.equal(calls, 0);
});
