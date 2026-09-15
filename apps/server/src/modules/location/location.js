const earthRadiusMeters = 6_371_000;

function degreesToRadians(value) {
  return value * Math.PI / 180;
}

function distanceMeters(from, to) {
  const latitudeDelta = degreesToRadians(to.latitude - from.latitude);
  const longitudeDelta = degreesToRadians(to.longitude - from.longitude);
  const fromLatitude = degreesToRadians(from.latitude);
  const toLatitude = degreesToRadians(to.latitude);
  const a = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(fromLatitude) * Math.cos(toLatitude) * Math.sin(longitudeDelta / 2) ** 2;
  return Math.round(earthRadiusMeters * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

function locationStatus(driver) {
  if (driver.latitude === null || driver.longitude === null || !driver.locationUpdatedAt) return 'MISSING';
  return 'AVAILABLE';
}

function validateLocation({ latitude, longitude, accuracyMeters }) {
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
    return '緯度は-90以上90以下の数値で入力してください';
  }
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    return '経度は-180以上180以下の数値で入力してください';
  }
  if (accuracyMeters !== undefined
    && (!Number.isFinite(accuracyMeters) || accuracyMeters < 0 || accuracyMeters > 100_000)) {
    return '位置情報の精度は0以上100000以下の数値で入力してください';
  }
  return null;
}

module.exports = { distanceMeters, locationStatus, validateLocation };
