const assert = require('node:assert/strict');
const test = require('node:test');
const {
  demoLocation,
  locationRetentionMilliseconds,
  locationSources,
  distanceMeters,
  locationStatus,
  normalizedLocation,
  roundCoordinate,
  validateLocation,
} = require('../src/modules/location/location');

test('2点間の直線距離をメートル単位で計算する', () => {
  assert.equal(distanceMeters(
    { latitude: 35, longitude: 135 },
    { latitude: 35, longitude: 135 },
  ), 0);
  const oneDegreeAtEquator = distanceMeters(
    { latitude: 0, longitude: 0 },
    { latitude: 0, longitude: 1 },
  );
  assert.ok(oneDegreeAtEquator >= 111_190 && oneDegreeAtEquator <= 111_200);
});

test('保持期間内の現在地を利用できる', () => {
  const now = new Date();
  const driver = {
    latitude: 35,
    longitude: 135,
    locationUpdatedAt: new Date(now.getTime() - 5 * 60 * 1000),
  };
  assert.equal(locationStatus(driver, now), 'AVAILABLE');
  assert.equal(locationStatus({ latitude: null, longitude: null, locationUpdatedAt: null }), 'MISSING');
});

test('端末位置を約100m単位に丸め、デモ位置と区別する', () => {
  assert.equal(roundCoordinate(35.011623), 35.012);
  assert.deepEqual(normalizedLocation({ source: locationSources.demo }), {
    ...demoLocation,
    source: locationSources.demo,
    accuracyMeters: null,
  });
  assert.deepEqual(normalizedLocation({
    source: locationSources.device,
    latitude: 35.011623,
    longitude: 135.768456,
    accuracyMeters: 8,
  }), {
    source: locationSources.device,
    latitude: 35.012,
    longitude: 135.768,
    accuracyMeters: 100,
  });
});

test('最終更新から12時間が経過した位置は利用しない', () => {
  const now = new Date('2026-09-25T12:00:00Z');
  const current = {
    latitude: 35.011,
    longitude: 135.768,
    locationUpdatedAt: new Date(now.getTime() - locationRetentionMilliseconds + 1),
  };
  assert.equal(locationStatus(current, now), 'AVAILABLE');
  assert.equal(locationStatus({
    ...current,
    locationUpdatedAt: new Date(now.getTime() - locationRetentionMilliseconds),
  }, now), 'MISSING');
});

test('緯度・経度・精度の範囲を検証する', () => {
  assert.equal(validateLocation({ latitude: 35, longitude: 135, accuracyMeters: 12 }), null);
  assert.match(validateLocation({ latitude: 91, longitude: 135 }), /緯度/);
  assert.match(validateLocation({ latitude: 35, longitude: -181 }), /経度/);
  assert.match(validateLocation({ latitude: 35, longitude: 135, accuracyMeters: -1 }), /精度/);
});
