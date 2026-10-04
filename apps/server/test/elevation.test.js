const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createElevationService, elevationProfile, sampleProfile } = require('../src/modules/elevation/elevation');
const { demoLocation } = require('../src/modules/location/location');
const { demoStores, demoDropoffs } = require('../src/modules/demo/demo-fixtures');
const { bicycleDirections, parseTile, tilePixel } = require('../../../scripts/build-elevation-data');
const { renderElevationProfile } = require('../../web/public/elevation-profile');

const driver = () => ({ ...demoLocation, locationUpdatedAt: new Date() });
const data = () => ({
  bounds: { south: 35, north: 35.02, west: 135.76, east: 135.78 },
  nodes: [[35.011, 135.768, 20], [35.011, 135.769, 40], [35.012, 135.769, 10], [35.013, 135.769, 25]],
  edges: [[0, 1], [1, 2], [2, 3]],
});
const order = () => ({ store: { latitude: 35.012, longitude: 135.769 }, dropoffLatitude: 35.013, dropoffLongitude: 135.769 });

test('道路順序、累積距離、途中の最高・最低と店舗位置を返す', () => {
  const profile = createElevationService(data()).profile(order(), driver());
  assert.equal(profile.status, 'AVAILABLE');
  assert.deepEqual(profile.points.map((point) => point.elevationMeters), [20, 40, 10, 25]);
  assert.equal(profile.points[0].distanceMeters, 0);
  assert.equal(profile.maximumMeters, 40);
  assert.equal(profile.minimumMeters, 10);
  assert.equal(profile.pickupDistanceMeters, profile.points[2].distanceMeters);
  assert.equal(profile.totalDistanceMeters, profile.points.at(-1).distanceMeters);
  assert.ok(profile.points.every((point, i, points) => !i || point.distanceMeters > points[i - 1].distanceMeters));
  assert.equal(JSON.stringify(profile).includes('latitude'), false);
  assert.equal(JSON.stringify(profile).includes('longitude'), false);
});

test('受取後は現在地なしで店舗から配達先までの標高を返す', () => {
  const service = createElevationService(data());
  const profile = service.profile(order(), {}, true);
  assert.equal(profile.stage, 'TO_DROPOFF');
  assert.deepEqual(profile.points.map((point) => point.elevationMeters), [10, 25]);
  assert.equal(profile.pickupDistanceMeters, 0);
  assert.equal(profile.maximumMeters, 25);
});

test('一方通行を逆走する経路や欠損標高を作らない', () => {
  const reverse = { store: { latitude: 35.011, longitude: 135.768 }, dropoffLatitude: 35.013, dropoffLongitude: 135.769 };
  const service = createElevationService(data());
  assert.equal(service.profile(reverse, { ...driver(), latitude: 35.012, longitude: 135.769 }).reason, 'ROUTE_NOT_FOUND');
  const missing = data();
  missing.nodes[1][2] = null;
  assert.equal(createElevationService(missing).profile(order(), driver()).reason, 'ELEVATION_MISSING');
});

test('現在地の欠損・期限切れ・対象外では明示した取得不可を返す', () => {
  const service = createElevationService(data());
  assert.equal(service.profile(order(), {}).reason, 'LOCATION_MISSING');
  assert.equal(service.profile(order(), { ...driver(), locationUpdatedAt: new Date(Date.now() - 13 * 3600_000) }).reason, 'LOCATION_MISSING');
  assert.equal(service.profile(order(), { ...driver(), latitude: 34.98 }).reason, 'OUTSIDE_COVERAGE');
  const disconnected = data();
  disconnected.edges = [[0, 1], [2, 3]];
  assert.equal(createElevationService(disconnected).profile(order(), driver()).reason, 'ROUTE_NOT_FOUND');
});

test('同一点の区間とキャッシュ再利用でも結果が変わらない', () => {
  const service = createElevationService(data());
  const same = { store: { ...demoLocation }, dropoffLatitude: demoLocation.latitude, dropoffLongitude: demoLocation.longitude };
  const profile = service.profile(same, driver());
  assert.equal(profile.status, 'AVAILABLE');
  assert.equal(profile.totalDistanceMeters, 0);
  assert.equal(profile.points.length, 1);
  assert.deepEqual(service.profile(same, driver()), profile);
});

test('最大200点で先頭・末尾・店舗とピーク・谷を残す', () => {
  const points = Array.from({ length: 2001 }, (_, i) => ({ distanceMeters: i * 20, elevationMeters: Math.sin(i) * 30 }));
  points[932].elevationMeters = 999;
  points[1284].elevationMeters = -40;
  const sample = sampleProfile(points, [932, 1284, 731]);
  assert.ok(sample.length <= 200);
  for (const index of [0, 2000, 932, 1284, 731]) assert.ok(sample.includes(points[index]));
  assert.ok(sample.every((point, i) => !i || point.distanceMeters > sample[i - 1].distanceMeters));
});

test('京都デモ全50経路と受取後の標高が有効で出典付きデータを使う', () => {
  for (const store of demoStores) {
    for (const dropoff of demoDropoffs) {
      const delivery = { store, dropoffLatitude: dropoff.latitude, dropoffLongitude: dropoff.longitude };
      for (const pickedUp of [false, true]) {
        const profile = elevationProfile(delivery, driver(), pickedUp);
        assert.equal(profile.status, 'AVAILABLE', `${store.name} → ${dropoff.name}`);
        assert.ok(profile.totalDistanceMeters > 0);
        assert.ok(profile.points.length <= 200);
        assert.equal(Math.min(...profile.points.map((point) => point.elevationMeters)), profile.minimumMeters);
        assert.equal(Math.max(...profile.points.map((point) => point.elevationMeters)), profile.maximumMeters);
      }
    }
  }
});

test('道路の自転車アクセスと方向タグを扱う', () => {
  assert.deepEqual(bicycleDirections({ highway: 'residential', oneway: 'yes' }), [1]);
  assert.deepEqual(bicycleDirections({ highway: 'residential', oneway: '-1' }), [-1]);
  assert.deepEqual(bicycleDirections({ highway: 'residential', oneway: 'yes', 'oneway:bicycle': 'no' }), [1, -1]);
  assert.deepEqual(bicycleDirections({ highway: 'motorway' }), []);
  assert.deepEqual(bicycleDirections({ highway: 'service', access: 'private' }), []);
  assert.deepEqual(bicycleDirections({ highway: 'footway', bicycle: 'designated' }), [1, -1]);
  assert.deepEqual(bicycleDirections({ highway: 'cycleway', bicycle: 'no' }), []);
});

test('地理院テキスト標高タイルの欠損・負標高と座標を扱う', () => {
  const values = Array(65536).fill('20.15');
  values[0] = 'e';
  values[1] = '-2.5';
  const parsed = parseTile(values.join(','));
  assert.equal(parsed[0], null);
  assert.equal(parsed[1], -2.5);
  assert.equal(parsed[2], 20.15);
  assert.throws(() => parseTile('20,30'), /dimensions/);
  assert.deepEqual(tilePixel(0, 0), { x: 8192, y: 8192, pixel: 0 });
});

test('ブラウザー表示は最高・最低を右の専用欄へ出し、不正値を描画しない', () => {
  const profile = createElevationService(data()).profile(order(), driver());
  const html = renderElevationProfile(profile);
  assert.match(html, /<polyline class="elevation-line" points="[\d., ]+"/);
  assert.match(html, /class="elevation-extrema".*<dt>最高<\/dt><dd>40.0 m<\/dd>.*<dt>最低<\/dt><dd>10.0 m<\/dd>/);
  assert.match(html, /OpenStreetMap contributors/);
  assert.match(html, /地理院タイルを加工/);
  assert.match(html, /class="elevation-distance-label">道路沿いの距離（参考）<\/p>/);
  assert.match(html, /class="elevation-stop"><strong>現在地<\/strong><span>0 m<\/span>/);
  assert.match(html, /class="elevation-stop"><strong>配達先<\/strong><span>[\d.]+ km<\/span>/);
  const afterPickup = renderElevationProfile(createElevationService(data()).profile(order(), {}, true));
  assert.match(afterPickup, /class="elevation-stop"><strong>店舗<\/strong><span>0 m<\/span>/);
  assert.doesNotMatch(afterPickup, /現在地/);
  assert.match(afterPickup, /道路沿いの距離（参考）/);
  assert.match(renderElevationProfile({ ...profile, maximumMeters: '<script>' }), /取得できません/);
  assert.match(renderElevationProfile({ status: 'UNAVAILABLE', reason: 'OUTSIDE_COVERAGE' }), /対象外/);
  assert.doesNotMatch(renderElevationProfile({ status: 'UNAVAILABLE', reason: '<script>' }), /<script>/);
});
