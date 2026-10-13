const assert = require('node:assert/strict');
const test = require('node:test');
const { japanMonthWindow, monthlyPodium, createMonthlyAwardMaintenance } = require('../src/modules/score/monthly-awards');

test('月間称号の対象月は日本時間で年越し・月末を区切る', () => {
  const before = japanMonthWindow(new Date('2026-12-31T14:59:59Z'));
  const after = japanMonthWindow(new Date('2026-12-31T15:00:00Z'));
  assert.equal(before.label, '2026-12');
  assert.equal(after.label, '2027-01');
  assert.equal(before.endsAt.toISOString(), '2026-12-31T15:00:00.000Z');
  assert.equal(after.startsAt.toISOString(), before.endsAt.toISOString());
});

test('月間上位3位は同点全員へ付与し、次の順位を人数分空け、0点へ付与しない', () => {
  assert.deepEqual(monthlyPodium([
    { driverId: 5, points: 0 }, { driverId: 4, points: 10 }, { driverId: 3, points: 20 },
    { driverId: 2, points: 30 }, { driverId: 1, points: 30 },
  ]).map(({ driverId, rank, title }) => ({ driverId, rank, title })), [
    { driverId: 1, rank: 1, title: '月間チャンピオン' },
    { driverId: 2, rank: 1, title: '月間チャンピオン' },
    { driverId: 3, rank: 3, title: '月間トップ3' },
  ]);
  assert.deepEqual(monthlyPodium([{ driverId: 1, points: 0 }]), []);
});

test('月間確定は同月の通信と同時要求をまとめ、失敗後は再実行し翌月へ進む', async () => {
  let at = new Date('2026-10-13T00:00:00Z');
  let calls = 0;
  let fail = true;
  const client = {
    scoreEvent: { findFirst: async () => null },
  };
  const maintenance = createMonthlyAwardMaintenance(async (operation) => {
    calls++;
    if (fail) { fail = false; throw new Error('fixture rollback'); }
    await new Promise((resolve) => setTimeout(resolve, 10));
    return operation(client);
  }, { now: () => at });
  await assert.rejects(maintenance.onActivity());
  await Promise.all([maintenance.onActivity(), maintenance.onActivity()]);
  await maintenance.onActivity();
  assert.equal(calls, 2);
  at = new Date('2026-11-01T00:00:00+09:00');
  await maintenance.onActivity();
  assert.equal(calls, 3);
});
