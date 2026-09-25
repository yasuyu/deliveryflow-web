const assert = require('node:assert/strict');
const test = require('node:test');
const OfflineActions = require('../public/offline-actions');

function createStorage() {
  const values = new Map();
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
}

function entry(action, key) {
  return OfflineActions.create(action, {
    idempotencyKey: key,
    now: '2026-09-25T09:00:00.000Z',
  });
}

test('受諾・受取・完了だけを安全なAPIパスへ変換する', () => {
  assert.equal(OfflineActions.endpoint(entry('accept:12', 'accept-key')), '/api/offers/12/accept');
  assert.equal(OfflineActions.endpoint(entry('pickup:34', 'pickup-key')), '/api/assignments/34/pickup');
  assert.equal(OfflineActions.endpoint(entry('complete:34', 'complete-key')), '/api/assignments/34/complete');
  assert.equal(OfflineActions.create('reject:12', { idempotencyKey: 'reject-key' }), null);
  assert.equal(OfflineActions.create('complete:../logout', { idempotencyKey: 'invalid-key' }), null);
});

test('配達員ごとに操作を保存し、同じ操作の二重登録を防ぐ', () => {
  const storage = createStorage();
  const accept = entry('accept:12', 'same-key');
  const first = OfflineActions.enqueue(storage, 7, [], accept);
  const duplicate = OfflineActions.enqueue(storage, 7, first.entries, entry('accept:12', 'different-key'));

  assert.equal(first.added, true);
  assert.equal(duplicate.added, false);
  assert.equal(duplicate.entries.length, 1);
  assert.equal(OfflineActions.load(storage, 7)[0].idempotencyKey, 'same-key');
  assert.deepEqual(OfflineActions.load(storage, 8), []);
});

test('保存値が壊れていても不正な送信先として利用しない', () => {
  const storage = createStorage();
  storage.setItem(OfflineActions.storageKey(7), JSON.stringify([
    { ...entry('pickup:34', 'valid-key') },
    { action: 'complete:../../logout', idempotencyKey: 'bad-key', createdAt: '2026-09-25T09:00:00.000Z' },
    { action: 'accept:12', idempotencyKey: '', createdAt: 'invalid' },
  ]));

  const loaded = OfflineActions.load(storage, 7);
  assert.equal(loaded.length, 1);
  assert.equal(OfflineActions.endpoint(loaded[0]), '/api/assignments/34/pickup');
});

test('古い順に同じIdempotency-Keyで再送する', async () => {
  const entries = [entry('pickup:34', 'pickup-key'), entry('complete:34', 'complete-key')];
  const sent = [];
  const result = await OfflineActions.flush(entries, async (item, url) => {
    sent.push({ url, key: item.idempotencyKey });
  });

  assert.deepEqual(sent, [
    { url: '/api/assignments/34/pickup', key: 'pickup-key' },
    { url: '/api/assignments/34/complete', key: 'complete-key' },
  ]);
  assert.equal(result.reason, 'complete');
  assert.equal(result.completed.length, 2);
  assert.deepEqual(result.remaining, []);
});

test('通信切断では操作を残し、API競合では確認待ちにする', async () => {
  const entries = [entry('pickup:34', 'pickup-key'), entry('complete:34', 'complete-key')];
  const networkResult = await OfflineActions.flush(entries, async () => {
    const error = new Error('offline');
    error.network = true;
    throw error;
  });
  assert.equal(networkResult.reason, 'network');
  assert.equal(networkResult.remaining.length, 2);
  assert.equal(networkResult.remaining[0].status, 'pending');

  const conflictResult = await OfflineActions.flush(entries, async () => {
    const error = new Error('オファーの期限が切れています。');
    error.code = 'OFFER_ALREADY_TAKEN';
    throw error;
  });
  assert.equal(conflictResult.reason, 'blocked');
  assert.equal(conflictResult.remaining[0].status, 'blocked');
  assert.equal(conflictResult.remaining[0].error.code, 'OFFER_ALREADY_TAKEN');

  let blockedSendCount = 0;
  const stopped = await OfflineActions.flush(conflictResult.remaining, async () => {
    blockedSendCount += 1;
  });
  assert.equal(stopped.reason, 'blocked');
  assert.equal(blockedSendCount, 0);

  const retried = OfflineActions.retry(conflictResult.remaining);
  assert.equal(retried[0].status, 'pending');
  assert.equal(retried[0].idempotencyKey, 'pickup-key');
  const resumed = await OfflineActions.flush(retried, async () => {});
  assert.equal(resumed.reason, 'complete');
});
