const { distanceMeters } = require('../location/location');

// A missing timestamp means no offer has been recorded yet. Keep ID only as
// the final deterministic fallback when both waiting times are identical.
function compareOfferWait(left, right) {
  const leftTime = left.lastOfferedAt ? new Date(left.lastOfferedAt).getTime() : -Infinity;
  const rightTime = right.lastOfferedAt ? new Date(right.lastOfferedAt).getTime() : -Infinity;
  if (leftTime !== rightTime) return leftTime < rightTime ? -1 : 1;
  return left.id - right.id;
}

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
      || compareOfferWait(left, right))
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
    || a.distanceToPickupMeters - b.distanceToPickupMeters || compareOfferWait(a, b));
}

module.exports = { nearestDrivers, prioritizeCandidates };
