const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('node:http');
const { once } = require('node:events');
const Api = require('../public/api-client');

test('応答前に止まった通信を中断し、待機を終える', async () => {
  let signal;
  await assert.rejects(Api.readJson('/stalled', {}, {
    deadline: Date.now() + 25,
    fetchImpl: async (url, options) => { signal = options.signal; return new Promise(() => {}); },
  }), (error) => error.code === 'REQUEST_TIMEOUT' && error.network);
  assert.equal(signal.aborted, true);
});

test('HTTPヘッダー受信後に本文が止まった実際のfetchも期限内に中断する', async () => {
  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.write('{"incomplete":');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  let headersReceived = false;
  try {
    await assert.rejects(Api.readJson(`http://127.0.0.1:${server.address().port}`, {}, {
      deadline: Date.now() + 1000,
      fetchImpl: async (url, options) => {
        const response = await fetch(url, options);
        headersReceived = true;
        return response;
      },
    }), (error) => error.code === 'REQUEST_TIMEOUT' && error.network);
    assert.equal(headersReceived, true);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('期限切れの読込は開始せず、正常応答とHTTPエラーの本文を返す', async () => {
  await assert.rejects(Api.readJson('/expired', {}, {
    deadline: Date.now() - 1, fetchImpl: () => { assert.fail('must not fetch'); },
  }), { code: 'REQUEST_TIMEOUT' });
  for (const status of [200, 409]) {
    const result = await Api.readJson('/ready', {}, {
      fetchImpl: async () => new Response(JSON.stringify({ status }), { status }),
    });
    assert.equal(result.response.status, status);
    assert.deepEqual(result.data, { status });
  }
});

test('通信切断や不完全なJSONを未確認の通信結果として扱う', async () => {
  for (const fetchImpl of [async () => { throw new TypeError('disconnected'); }, async () => new Response('{')]) {
    await assert.rejects(Api.readJson('/invalid', {}, { fetchImpl }), (error) => error.network === true);
  }
});

test('未確認の退勤を手動再送すると同じキーを使い、確定後の次の勤務には新しいキーを使う', async () => {
  const keys = [];
  let nextKey = 0;
  const client = Api.createPostClient({
    getToken: () => 'test-token', makeKey: () => `key-${++nextKey}`,
    read: async (url, options) => {
      keys.push(options.headers['Idempotency-Key']);
      if (keys.length === 1) throw Object.assign(new Error('timeout'), { network: true });
      return { response: { ok: true }, data: { shiftSummary: { completedDeliveries: 1 } } };
    },
  });
  await assert.rejects(client.post('/api/shifts/end'));
  const key = client.keyFor('/api/shifts/end');
  assert.equal(key, keys[0]);
  await client.post('/api/shifts/end', null, { idempotencyKey: key });
  await client.post('/api/shifts/end');
  assert.deepEqual(keys, ['key-1', 'key-1', 'key-2']);
});

test('キューのキーを保持し、HTTP拒否をネットワーク再送対象にしない', async () => {
  const keys = [];
  const client = Api.createPostClient({
    getToken: () => 'test-token', makeKey: () => 'new-key',
    read: async (url, options) => {
      keys.push(options.headers['Idempotency-Key']);
      return { response: { ok: false, status: 409 }, data: { code: 'INVALID_STATE', message: '状態不一致' } };
    },
  });
  await assert.rejects(client.post('/api/assignments/1/complete', null, { idempotencyKey: 'queued-key' }),
    (error) => error.status === 409 && error.code === 'INVALID_STATE' && !error.network);
  assert.equal(client.keyFor('/api/assignments/1/complete'), 'new-key');
  assert.deepEqual(keys, ['queued-key']);
});

test('別の配達員・別の操作に保留中のキーを使わず、ログイン時に保留キーを破棄する', async () => {
  let token = 'first-token';
  let nextKey = 0;
  const client = Api.createPostClient({ getToken: () => token, makeKey: () => `key-${++nextKey}` });
  assert.equal(client.keyFor('/api/shifts/start'), 'key-1');
  assert.equal(client.keyFor('/api/shifts/end'), 'key-2');
  token = 'second-token';
  assert.equal(client.keyFor('/api/shifts/start'), 'key-3');
  client.clear();
  assert.equal(client.keyFor('/api/shifts/start'), 'key-4');
});
