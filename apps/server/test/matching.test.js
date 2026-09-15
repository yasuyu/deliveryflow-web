const assert = require('node:assert/strict');
const test = require('node:test');
const { nearestDrivers } = require('../src/modules/matching/matching');

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

test('現在地の更新時刻は候補順位に使わず、同距離ならID順にする', () => {
  const candidates = nearestDrivers([
    { id: 2, latitude: 35, longitude: 135.01, locationUpdatedAt: new Date('2026-09-15') },
    { id: 1, latitude: 35, longitude: 135.01, locationUpdatedAt: new Date('2020-01-01') },
    { id: 3, latitude: null, longitude: null, locationUpdatedAt: null },
  ], store, 3);

  assert.deepEqual(candidates.map((candidate) => candidate.id), [1, 2]);
});
