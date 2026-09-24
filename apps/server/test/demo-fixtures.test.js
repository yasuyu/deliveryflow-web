const assert = require('node:assert/strict');
const test = require('node:test');
const {
  chooseDemoRoute,
  demoCompetitors,
  demoDropoffs,
  demoRouteKey,
  demoStores,
  scoreBreakdownForPoints,
} = require('../src/modules/demo/demo-fixtures');

test('京都の店舗・配達先・ランキング用配達員を十分な件数用意する', () => {
  assert.equal(demoStores.length, 5);
  assert.equal(demoDropoffs.length, 10);
  assert.equal(demoCompetitors.length, 5);
  assert.equal(new Set(demoStores.map((store) => store.name)).size, demoStores.length);
  assert.equal(new Set(demoDropoffs.map((dropoff) => dropoff.name)).size, demoDropoffs.length);
  for (const place of [...demoStores, ...demoDropoffs]) {
    assert.ok(place.latitude > 34.98 && place.latitude < 35.04);
    assert.ok(place.longitude > 135.72 && place.longitude < 135.80);
  }
});

test('直近の店舗・配達先の組み合わせを候補から外して再現可能に選べる', () => {
  const firstFive = demoDropoffs.slice(0, 5).map((dropoff) => demoRouteKey(demoStores[0].name, dropoff.name));
  const route = chooseDemoRoute(firstFive, () => 0);
  assert.equal(route.store.name, demoStores[0].name);
  assert.equal(route.dropoff.name, demoDropoffs[5].name);
  const last = chooseDemoRoute([], () => 1);
  assert.equal(last.store.name, demoStores.at(-1).name);
  assert.equal(last.dropoff.name, demoDropoffs.at(-1).name);
});

test('ランキング用の実績は実際の加点ルールの組み合わせだけを使う', () => {
  const supportedPoints = new Set([100, 130, 150, 180]);
  for (const competitor of demoCompetitors) {
    assert.ok(competitor.points.length > 0);
    for (const points of competitor.points) {
      assert.ok(supportedPoints.has(points));
      assert.equal(scoreBreakdownForPoints(points).reduce((sum, item) => sum + item.points, 0), points);
    }
  }
  assert.equal(demoCompetitors[0].points.reduce((sum, points) => sum + points, 0), 1580);
});
