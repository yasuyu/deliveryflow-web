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

function prioritizeCandidates(candidates, recentScores, bestMonthlyRanks) {
  return candidates.map((candidate) => {
    const points = recentScores.get(candidate.id) || 0;
    const rank = bestMonthlyRanks.get(candidate.id);
    const titleValue = rank >= 1 && rank <= 3 ? 4 - rank : 0;
    // Divide by 100 to obtain the displayed weighting units:
    // recentPoints / 100 + titleValue - distanceMeters / 100.
    return { ...candidate, priority: points + titleValue * 100 - candidate.distanceToPickupMeters };
  }).sort((a, b) => b.priority - a.priority
    || a.distanceToPickupMeters - b.distanceToPickupMeters || a.id - b.id);
}

module.exports = { nearestDrivers, prioritizeCandidates };
