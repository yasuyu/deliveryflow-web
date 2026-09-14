const assert = require('node:assert/strict');
const test = require('node:test');
const { buildScoreSnapshot, isLateNight } = require('../src/modules/score/score-bonuses');

const rules = [
  { code: 'DELIVERY_COMPLETED', label: '配達完了', points: 100, active: true },
  { code: 'WEATHER_RAIN', label: '雨天ボーナス', points: 30, active: true },
  { code: 'TIME_LATE_NIGHT', label: '深夜ボーナス', points: 50, active: true },
];

test('深夜ボーナスは日本時間22時以上5時未満に適用する', () => {
  assert.equal(isLateNight(new Date('2026-09-14T21:59:59+09:00')), false);
  assert.equal(isLateNight(new Date('2026-09-14T22:00:00+09:00')), true);
  assert.equal(isLateNight(new Date('2026-09-15T04:59:59+09:00')), true);
  assert.equal(isLateNight(new Date('2026-09-15T05:00:00+09:00')), false);
});

test('雨天と深夜のボーナスを重ねて内訳を固定できる', () => {
  const snapshot = buildScoreSnapshot(rules, {
    weatherCondition: 'RAIN',
    at: new Date('2026-09-14T22:00:00+09:00'),
  });
  assert.equal(snapshot.estimatedPoints, 180);
  assert.deepEqual(snapshot.breakdown.map(({ code, points }) => ({ code, points })), [
    { code: 'DELIVERY_COMPLETED', points: 100 },
    { code: 'WEATHER_RAIN', points: 30 },
    { code: 'TIME_LATE_NIGHT', points: 50 },
  ]);
});

test('無効なボーナスルールは加点しない', () => {
  const snapshot = buildScoreSnapshot(
    rules.map((rule) => rule.code === 'WEATHER_RAIN' ? { ...rule, active: false } : rule),
    { weatherCondition: 'RAIN', at: new Date('2026-09-14T12:00:00+09:00') },
  );
  assert.equal(snapshot.estimatedPoints, 100);
  assert.deepEqual(snapshot.breakdown.map((item) => item.code), ['DELIVERY_COMPLETED']);
});
