const assert = require('node:assert/strict');
const test = require('node:test');
const { distanceMeters, locationStatus, validateLocation } = require('../src/modules/location/location');

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

test('現在地は5分以内だけ新しいと判定する', () => {
  const now = new Date('2026-09-14T12:00:00Z');
  const driver = { latitude: 35, longitude: 135, locationUpdatedAt: new Date(now - 5 * 60 * 1000) };
  assert.equal(locationStatus(driver, now), 'FRESH');
  driver.locationUpdatedAt = new Date(now - 5 * 60 * 1000 - 1);
  assert.equal(locationStatus(driver, now), 'STALE');
  assert.equal(locationStatus({ latitude: null, longitude: null, locationUpdatedAt: null }, now), 'MISSING');
});

test('緯度・経度・精度の範囲を検証する', () => {
  assert.equal(validateLocation({ latitude: 35, longitude: 135, accuracyMeters: 12 }), null);
  assert.match(validateLocation({ latitude: 91, longitude: 135 }), /緯度/);
  assert.match(validateLocation({ latitude: 35, longitude: -181 }), /経度/);
  assert.match(validateLocation({ latitude: 35, longitude: 135, accuracyMeters: -1 }), /精度/);
});
