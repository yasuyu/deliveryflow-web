const assert = require('node:assert/strict');
const test = require('node:test');
const { nearestDrivers, prioritizeCandidates } = require('../src/modules/matching/matching');

const store = { latitude: 35, longitude: 135 };

test('店舗から近い順に指定人数の配達員を選ぶ', () => {
  const candidates = nearestDrivers([
    { id: 30, latitude: 35, longitude: 135.03, locationUpdatedAt: new Date('2020-01-01') },
    { id: 10, latitude: 35, longitude: 135.01, locationUpdatedAt: new Date('2026-09-15') },
    { id: 20, latitude: 35, longitude: 135.02, locationUpdatedAt: new Date('2025-01-01') },
  ], store, 2);

  assert.deepEqual(candidates.map((candidate) => candidate.id), [10, 20]);
  assert.ok(candidates[0].distanceToPickupMeters < candidates[1].distanceToPickupMeters);
});

test('近いn人に絞った後、14日ポイントと獲得済み月間称号で順位を決める', () => {
  const near = nearestDrivers([
    { id: 1, latitude: 35, longitude: 135, score: 999999 },
    { id: 2, latitude: 35, longitude: 135 },
    { id: 3, latitude: 35, longitude: 135 },
    { id: 4, latitude: 35, longitude: 136 },
  ], store, 3);
  const ranked = prioritizeCandidates(near, new Map([[1, 100], [2, 500], [3, 100], [4, 999999]]),
    new Map([[1, 1], [3, 2]]));
  assert.deepEqual(ranked.map(({ id }) => id), [2, 1, 3]);
  assert.deepEqual(ranked.map(({ priority }) => priority), [500, 400, 300]);
});

test('距離・月間称号の重みと、同評価なら距離・IDの順を守る', () => {
  const ranked = prioritizeCandidates([
    { id: 4, distanceToPickupMeters: 400 }, { id: 2, distanceToPickupMeters: 100 },
    { id: 1, distanceToPickupMeters: 100 }, { id: 3, distanceToPickupMeters: 0 },
  ], new Map([[4, 500], [2, 200], [1, 200]]), new Map([[3, 3]]));
  assert.deepEqual(ranked.map(({ id }) => id), [3, 1, 2, 4]);
  assert.ok(ranked.every(({ priority }) => priority === 100));
});

test('現在地の更新時刻は候補順位に使わず、同距離ならID順にする', () => {
  const candidates = nearestDrivers([
    { id: 2, latitude: 35, longitude: 135.01, locationUpdatedAt: new Date('2026-09-15') },
    { id: 1, latitude: 35, longitude: 135.01, locationUpdatedAt: new Date('2020-01-01') },
    { id: 3, latitude: null, longitude: null, locationUpdatedAt: null },
  ], store, 3);

  assert.deepEqual(candidates.map((candidate) => candidate.id), [1, 2]);
});
