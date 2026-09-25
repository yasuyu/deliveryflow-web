const japanUtcOffsetMilliseconds = 9 * 60 * 60 * 1000;

const scoreRuleCodes = {
  completed: 'DELIVERY_COMPLETED',
  distance: 'DELIVERY_DISTANCE',
  rain: 'WEATHER_RAIN',
  lateNight: 'TIME_LATE_NIGHT',
};

const includedDistanceMeters = 500;
const distanceStepMeters = 250;
const pointsPerDistanceStep = 10;
const maximumDistanceBonusPoints = 100;

function distanceBonusPoints(pickupToDropoffMeters) {
  if (!Number.isFinite(pickupToDropoffMeters) || pickupToDropoffMeters <= includedDistanceMeters) return 0;
  const steps = Math.ceil((pickupToDropoffMeters - includedDistanceMeters) / distanceStepMeters);
  return Math.min(steps * pointsPerDistanceStep, maximumDistanceBonusPoints);
}

function isLateNight(date) {
  const japanTime = new Date(date.getTime() + japanUtcOffsetMilliseconds);
  const hour = japanTime.getUTCHours();
  return hour >= 22 || hour < 5;
}

function buildScoreSnapshot(rules, {
  weatherCondition = 'CLEAR',
  at = new Date(),
  pickupToDropoffMeters = null,
} = {}) {
  const rulesByCode = new Map(rules.filter((rule) => rule.active).map((rule) => [rule.code, rule]));
  const completedRule = rulesByCode.get(scoreRuleCodes.completed);
  if (!completedRule) throw new Error('DELIVERY_COMPLETED score rule is unavailable');

  const selectedRules = [completedRule];
  const distancePoints = distanceBonusPoints(pickupToDropoffMeters);
  if (distancePoints) {
    const distanceKilometers = (pickupToDropoffMeters / 1000).toFixed(1);
    selectedRules.push({
      code: scoreRuleCodes.distance,
      label: `距離ボーナス（${distanceKilometers}km）`,
      points: distancePoints,
    });
  }
  if (weatherCondition === 'RAIN' && rulesByCode.has(scoreRuleCodes.rain)) {
    selectedRules.push(rulesByCode.get(scoreRuleCodes.rain));
  }
  if (isLateNight(at) && rulesByCode.has(scoreRuleCodes.lateNight)) {
    selectedRules.push(rulesByCode.get(scoreRuleCodes.lateNight));
  }

  const breakdown = selectedRules.map(({ code, label, points }) => ({ code, label, points }));
  return {
    estimatedPoints: breakdown.reduce((total, item) => total + item.points, 0),
    breakdown,
  };
}

function parseBreakdown(value) {
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

module.exports = {
  buildScoreSnapshot,
  distanceBonusPoints,
  isLateNight,
  parseBreakdown,
  scoreRuleCodes,
};
