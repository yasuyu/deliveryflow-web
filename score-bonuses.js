const japanUtcOffsetMilliseconds = 9 * 60 * 60 * 1000;

const scoreRuleCodes = {
  completed: 'DELIVERY_COMPLETED',
  rain: 'WEATHER_RAIN',
  lateNight: 'TIME_LATE_NIGHT',
};

function isLateNight(date) {
  const japanTime = new Date(date.getTime() + japanUtcOffsetMilliseconds);
  const hour = japanTime.getUTCHours();
  return hour >= 22 || hour < 5;
}

function buildScoreSnapshot(rules, { weatherCondition = 'CLEAR', at = new Date() } = {}) {
  const rulesByCode = new Map(rules.filter((rule) => rule.active).map((rule) => [rule.code, rule]));
  const completedRule = rulesByCode.get(scoreRuleCodes.completed);
  if (!completedRule) throw new Error('DELIVERY_COMPLETED score rule is unavailable');

  const selectedRules = [completedRule];
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

module.exports = { buildScoreSnapshot, isLateNight, parseBreakdown, scoreRuleCodes };
