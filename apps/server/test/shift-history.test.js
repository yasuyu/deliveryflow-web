const assert = require('node:assert/strict');
const { test } = require('node:test');
const { savedShiftSummary, savedReview, listShiftHistory } = require('../src/modules/shift-review/shift-history');

const summary = { startedAt: '2026-10-01T01:00:00.000Z', endedAt: '2026-10-01T02:00:00.000Z', durationSeconds: 3600, completedDeliveries: 2, pointsEarned: 260 };

test('履歴は保存済みの実績だけを返し、旧版の無料コメントは外部通信なしで補う', () => {
  const actual = savedShiftSummary(JSON.stringify({ accessToken: 'private', name: 'private', shiftSummary: { ...summary, secret: 'private' } }));
  assert.deepEqual(Object.keys(actual).sort(), [...Object.keys(summary), 'localFeedback'].sort());
  assert.match(actual.localFeedback, /260ポイント/);
  assert.equal(savedShiftSummary(JSON.stringify({ shiftSummary: { ...summary, localFeedback: '保存されたコメント' } })).localFeedback, '保存されたコメント');
});

test('サマリーのない旧版や壊れた保存データから勤務実績を推測しない', () => {
  for (const value of [null, '', '{', '{}', 'null', JSON.stringify({ shiftSummary: { ...summary, startedAt: null } }),
    JSON.stringify({ shiftSummary: { ...summary, endedAt: '2020-01-01' } }),
    ...['durationSeconds', 'completedDeliveries', 'pointsEarned'].flatMap((field) => [-1, 0.5, '2', Number.MAX_SAFE_INTEGER + 1].map((value) => JSON.stringify({ shiftSummary: { ...summary, [field]: value } })))]) {
    assert.equal(savedShiftSummary(value), null);
  }
});

test('保存済みのAI文章と状態だけを返し、欠損した結果は生成しない', () => {
  assert.equal(savedReview(null), null);
  assert.deepEqual(savedReview({ response: JSON.stringify({ status: 'AVAILABLE', feedback: '保存済み', secret: 'private' }) }), { status: 'AVAILABLE', feedback: '保存済み' });
  assert.equal(savedReview({ response: '{' }).status, 'UNAVAILABLE');
  assert.equal(savedReview({ response: '{"status":"AVAILABLE"}' }).status, 'UNAVAILABLE');
  assert.deepEqual(savedReview({ response: '{"status":"DISABLED","message":"private"}' }), { status: 'DISABLED', message: 'AIの振り返りは未設定です。' });
});

test('30秒を超えたAI生成中の記録は読み取りだけで中断表示にする', () => {
  const record = { response: '{"status":"PENDING"}', createdAt: new Date(0) };
  assert.equal(savedReview(record, 30_000).status, 'PENDING');
  assert.equal(savedReview(record, 30_001).status, 'UNAVAILABLE');
  assert.equal(record.response, '{"status":"PENDING"}');
});

test('旧版の記録だけのページでも次のカーソルを返し、有効な過去のサマリーへ進める', async () => {
  let query;
  const records = Array.from({ length: 21 }, (_, index) => ({ id: 100 - index, response: '{}' }));
  const client = { idempotencyKey: { async findMany(options) { query = options; return records; } } };
  const result = await listShiftHistory(client, 7, 101);
  assert.deepEqual(result, { shifts: [], pagination: { pageSize: 20, hasMore: true, nextCursor: 81 } });
  assert.deepEqual(query.where.id, { lt: 101 });
  assert.equal(query.where.driverId, 7);
  assert.equal(query.take, 21);
});
