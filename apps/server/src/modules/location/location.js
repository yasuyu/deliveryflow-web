const earthRadiusMeters = 6_371_000;
const coordinatePrecision = 3;
const locationRetentionMilliseconds = 12 * 60 * 60 * 1000;
const locationSources = { demo: 'DEMO', device: 'DEVICE' };
const demoLocation = {
  label: '京都市役所付近（デモ）',
  latitude: 35.011,
  longitude: 135.768,
};

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

function roundCoordinate(value) {
  const factor = 10 ** coordinatePrecision;
  return Math.round(value * factor) / factor;
}

function locationHasExpired(driver, now = new Date()) {
  if (!driver.locationUpdatedAt) return false;
  return now.getTime() - new Date(driver.locationUpdatedAt).getTime() >= locationRetentionMilliseconds;
}

function locationStatus(driver, now = new Date()) {
  if (driver.latitude === null || driver.longitude === null || !driver.locationUpdatedAt) return 'MISSING';
  if (locationHasExpired(driver, now)) return 'MISSING';
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

function normalizedLocation(input) {
  const source = input.source || locationSources.device;
  if (source === locationSources.demo) {
    return { ...demoLocation, source: locationSources.demo, accuracyMeters: null };
  }
  if (source !== locationSources.device) return null;
  const validationMessage = validateLocation(input);
  if (validationMessage) return { validationMessage };
  return {
    source: locationSources.device,
    latitude: roundCoordinate(input.latitude),
    longitude: roundCoordinate(input.longitude),
    accuracyMeters: input.accuracyMeters === undefined
      ? null
      : Math.max(Math.round(input.accuracyMeters), 100),
  };
}

module.exports = {
  demoLocation,
  distanceMeters,
  locationHasExpired,
  locationRetentionMilliseconds,
  locationSources,
  locationStatus,
  normalizedLocation,
  roundCoordinate,
  validateLocation,
};
