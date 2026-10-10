const { createLocalShiftFeedback, unavailableReview } = require('./shift-review');

const pageSize = 20;

function savedShiftSummary(response) {
  try {
    const summary = JSON.parse(response).shiftSummary;
    if (!summary || typeof summary.startedAt !== 'string' || typeof summary.endedAt !== 'string'
      || !Number.isFinite(Date.parse(summary.startedAt)) || !Number.isFinite(Date.parse(summary.endedAt))
      || Date.parse(summary.endedAt) < Date.parse(summary.startedAt)
      || !['durationSeconds', 'completedDeliveries', 'pointsEarned'].every((field) => Number.isSafeInteger(summary[field]) && summary[field] >= 0)) return null;
    const result = {
      startedAt: summary.startedAt, endedAt: summary.endedAt,
      durationSeconds: summary.durationSeconds, completedDeliveries: summary.completedDeliveries, pointsEarned: summary.pointsEarned,
    };
    return { ...result, localFeedback: typeof summary.localFeedback === 'string' ? summary.localFeedback : createLocalShiftFeedback(result) };
  } catch {
    return null;
  }
}

function savedReview(record, now = Date.now()) {
  if (!record) return null;
  try {
    const review = JSON.parse(record.response);
    if (review.status === 'AVAILABLE' && typeof review.feedback === 'string') return { status: 'AVAILABLE', feedback: review.feedback };
    if (review.status === 'PENDING' && now - record.createdAt.getTime() <= 30_000) return { status: 'PENDING' };
    if (review.status === 'DISABLED') return { status: 'DISABLED', message: 'AIの振り返りは未設定です。' };
  } catch {
    // Invalid legacy responses must not expose the original stored payload.
  }
  return { ...unavailableReview };
}

async function listShiftHistory(client, driverId, cursor = null) {
  const records = await client.idempotencyKey.findMany({
    where: { driverId, endpoint: '/api/shifts/end', statusCode: 200, response: { not: null }, ...(cursor === null ? {} : { id: { lt: cursor } }) },
    select: { id: true, response: true }, orderBy: { id: 'desc' }, take: pageSize + 1,
  });
  const page = records.slice(0, pageSize);
  const shifts = page.flatMap((record) => {
    const summary = savedShiftSummary(record.response);
    if (!summary) return [];
    const { localFeedback, ...metrics } = summary;
    return [{ id: record.id, ...metrics }];
  });
  const hasMore = records.length > pageSize;
  return { shifts, pagination: { pageSize, hasMore, nextCursor: hasMore ? page.at(-1).id : null } };
}

async function getShiftHistory(client, driverId, id) {
  const record = await client.idempotencyKey.findFirst({
    where: { id, driverId, endpoint: '/api/shifts/end', statusCode: 200 }, select: { id: true, key: true, response: true },
  });
  const shiftSummary = record && savedShiftSummary(record.response);
  if (!shiftSummary) return null;
  const review = await client.idempotencyKey.findUnique({
    where: { key_endpoint_driverId: { key: record.key, endpoint: '/api/shifts/review', driverId } }, select: { response: true, createdAt: true },
  });
  return { id: record.id, shiftSummary, aiReview: savedReview(review) };
}

module.exports = { savedShiftSummary, savedReview, listShiftHistory, getShiftHistory };
