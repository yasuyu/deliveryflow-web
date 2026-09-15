const { distanceMeters } = require('../location/location');

function nearestDrivers(drivers, store, limit) {
  return drivers
    .filter((driver) => Number.isFinite(driver.latitude) && Number.isFinite(driver.longitude))
    .map((driver) => ({
      ...driver,
      distanceToPickupMeters: distanceMeters(
        { latitude: driver.latitude, longitude: driver.longitude },
        { latitude: store.latitude, longitude: store.longitude },
      ),
    }))
    .sort((left, right) => left.distanceToPickupMeters - right.distanceToPickupMeters
      || left.id - right.id)
    .slice(0, limit);
}

module.exports = { nearestDrivers };
