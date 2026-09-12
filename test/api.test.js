const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const net = require('node:net');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const projectRoot = path.resolve(__dirname, '..');
const testDatabasePrefix = 'deliveryflow-test-';
const databaseName = `deliveryflow-test-${randomUUID()}.db`;
const databaseUrl = `file:./${databaseName}`;
const databasePath = path.join(projectRoot, 'prisma', databaseName);
let serverProcess;
let baseUrl;
let accessToken;

async function createTestDatabase() {
  const prismaDirectory = path.join(projectRoot, 'prisma');
  const existingFiles = await fs.readdir(prismaDirectory);
  await Promise.all(existingFiles
    .filter((fileName) => fileName.startsWith(testDatabasePrefix))
    .map((fileName) => fs.rm(path.join(prismaDirectory, fileName), { force: true })));

  const database = new DatabaseSync(databasePath);
  const migrationsDirectory = path.join(prismaDirectory, 'migrations');
  const migrationDirectories = (await fs.readdir(migrationsDirectory)).sort();

  for (const directory of migrationDirectories) {
    const migrationPath = path.join(migrationsDirectory, directory, 'migration.sql');
    database.exec(await fs.readFile(migrationPath, 'utf8'));
  }
  database.close();
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function waitForServer(url) {
  let lastError;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch(`${url}/api/dashboard`, {
        headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
      });
      if (response.status < 500) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw lastError || new Error('Server did not start in time');
}

async function request(pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, options);
  const body = await response.json();
  return { status: response.status, body };
}

function authenticatedPost(pathname, key) {
  return request(pathname, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Idempotency-Key': key,
    },
  });
}

before(async () => {
  await createTestDatabase();

  const port = await getFreePort();
  baseUrl = `http://127.0.0.1:${port}`;
  serverProcess = spawn(process.execPath, ['server.js'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      PORT: String(port),
      OFFER_TTL_SECONDS: '120',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitForServer(baseUrl);
  const registration = await request('/api/drivers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'テスト配達員', pin: '123456' }),
  });
  assert.equal(registration.status, 201);
  assert.equal(registration.body.driver.name, 'テスト配達員');
  assert.equal(registration.body.driver.accessTokenHash, undefined);
  assert.equal(registration.body.driver.pinHash, undefined);
  assert.match(registration.body.accessToken, /^[A-Za-z0-9_-]{43}$/);
  accessToken = registration.body.accessToken;
});

after(async () => {
  if (serverProcess && !serverProcess.killed) {
    serverProcess.kill();
    await once(serverProcess, 'exit');
  }
  await fs.rm(databasePath, { force: true });
  await fs.rm(`${databasePath}-journal`, { force: true });
  await fs.rm(`${databasePath}-wal`, { force: true });
  await fs.rm(`${databasePath}-shm`, { force: true });
});

test('配達の状態遷移をAPI経由で完了できる', async () => {
  const firstStart = await authenticatedPost('/api/shifts/start', 'start-shift');
  assert.equal(firstStart.status, 200);
  assert.equal(firstStart.body.status, 'IDLE');

  const repeatedStart = await authenticatedPost('/api/shifts/start', 'start-shift');
  assert.equal(repeatedStart.status, 200);
  assert.deepEqual(repeatedStart.body, firstStart.body);

  const offerResult = await authenticatedPost('/api/offers/current', 'show-offer');
  assert.equal(offerResult.status, 200);
  assert.equal(offerResult.body.status, 'PENDING');

  const accepted = await authenticatedPost(`/api/offers/${offerResult.body.id}/accept`, 'accept-offer');
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.driver.status, 'BUSY');
  assert.equal(accepted.body.assignment.order.status, 'ASSIGNED');

  const assignmentId = accepted.body.assignment.id;
  const pickedUp = await authenticatedPost(`/api/assignments/${assignmentId}/pickup`, 'pickup-order');
  assert.equal(pickedUp.status, 200);
  assert.equal(pickedUp.body.assignment.order.status, 'PICKED_UP');
  assert.notEqual(pickedUp.body.assignment.pickedUpAt, null);

  const completed = await authenticatedPost(`/api/assignments/${assignmentId}/complete`, 'complete-order');
  assert.equal(completed.status, 200);
  assert.equal(completed.body.driver.status, 'IDLE');
  assert.equal(completed.body.assignment, null);

  const history = await request('/api/deliveries/history', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  assert.equal(history.status, 200);
  assert.equal(history.body.summary.completedDeliveries, 1);
  assert.notEqual(history.body.summary.lastDeliveredAt, null);
  assert.equal(history.body.deliveries.length, 1);
  assert.equal(history.body.deliveries[0].order.status, 'DELIVERED');
  assert.notEqual(history.body.deliveries[0].deliveredAt, null);

  const matchingHistory = await request('/api/deliveries/history?status=DELIVERED&query=BKC&from=2000-01-01&to=2999-12-31', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  assert.equal(matchingHistory.status, 200);
  assert.equal(matchingHistory.body.summary.filteredDeliveries, 1);
  assert.deepEqual(matchingHistory.body.filters, {
    status: 'DELIVERED', query: 'BKC', from: '2000-01-01', to: '2999-12-31',
  });

  const emptyHistory = await request('/api/deliveries/history?query=存在しない配送先', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  assert.equal(emptyHistory.status, 200);
  assert.equal(emptyHistory.body.summary.completedDeliveries, 1);
  assert.equal(emptyHistory.body.summary.filteredDeliveries, 0);
  assert.deepEqual(emptyHistory.body.deliveries, []);

  const invalidHistory = await request('/api/deliveries/history?status=UNKNOWN', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  assert.equal(invalidHistory.status, 400);
  assert.equal(invalidHistory.body.code, 'VALIDATION_ERROR');

  const reversedDates = await request('/api/deliveries/history?from=2026-09-13&to=2026-09-12', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  assert.equal(reversedDates.status, 400);
  assert.equal(reversedDates.body.code, 'VALIDATION_ERROR');

  const otherDriver = await request('/api/drivers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '履歴分離確認配達員', pin: '246810' }),
  });
  const otherHistory = await request('/api/deliveries/history', {
    headers: { Authorization: `Bearer ${otherDriver.body.accessToken}` },
  });
  assert.equal(otherHistory.status, 200);
  assert.equal(otherHistory.body.summary.completedDeliveries, 0);
  assert.deepEqual(otherHistory.body.deliveries, []);
});

test('配達履歴を配送状態で絞り込める', async () => {
  const registration = await request('/api/drivers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '履歴絞り込み配達員', pin: '135790' }),
  });
  const token = registration.body.accessToken;
  const post = (pathname, key) => request(pathname, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Idempotency-Key': key },
  });
  await post('/api/shifts/start', 'filter-start');
  const offer = await post('/api/offers/current', 'filter-offer');
  await post(`/api/offers/${offer.body.id}/accept`, 'filter-accept');

  const assigned = await request('/api/deliveries/history?status=ASSIGNED', {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(assigned.status, 200);
  assert.equal(assigned.body.summary.filteredDeliveries, 1);
  assert.equal(assigned.body.deliveries[0].order.status, 'ASSIGNED');

  const delivered = await request('/api/deliveries/history?status=DELIVERED', {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(delivered.status, 200);
  assert.equal(delivered.body.summary.filteredDeliveries, 0);
  assert.deepEqual(delivered.body.deliveries, []);
});

test('認証なしでは配達員用APIを利用できない', async () => {
  const response = await request('/api/dashboard');
  assert.equal(response.status, 401);
  assert.equal(response.body.code, 'UNAUTHORIZED');
});

test('監視用エンドポイントはDB接続状況と安全なメトリクスを返す', async () => {
  const health = await request('/healthz');
  assert.equal(health.status, 200);
  assert.deepEqual(health.body, { status: 'ok', database: 'connected' });

  const metrics = await request('/metrics');
  assert.equal(metrics.status, 200);
  assert.equal(metrics.body.status, 'ok');
  assert.equal(typeof metrics.body.requests, 'number');
  assert.equal(typeof metrics.body.averageResponseMilliseconds, 'number');

  const requestIdResponse = await fetch(`${baseUrl}/healthz`);
  assert.match(requestIdResponse.headers.get('x-request-id'), /^[0-9a-f-]{36}$/);
});

test('配達員IDでは認証できず、安全な応答ヘッダーを返す', async () => {
  const response = await fetch(`${baseUrl}/api/dashboard`, {
    headers: { Authorization: 'Bearer 1' },
  });
  assert.equal(response.status, 401);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
});

test('1MBを超えるJSON本文は受け付けない', async () => {
  const response = await request('/api/drivers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'a'.repeat(1_000_001) }),
  });
  assert.equal(response.status, 413);
  assert.equal(response.body.code, 'PAYLOAD_TOO_LARGE');
});

test('ログアウト後は同じアクセストークンを利用できない', async () => {
  const registration = await request('/api/drivers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'ログアウト確認配達員', pin: '654321' }),
  });
  const driverId = registration.body.driver.id;
  const token = registration.body.accessToken;
  const logout = await request('/api/logout', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Idempotency-Key': 'logout-driver',
    },
  });
  assert.equal(logout.status, 200);

  const dashboard = await request('/api/dashboard', {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(dashboard.status, 401);

  const login = await request('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ driverId, pin: '654321' }),
  });
  assert.equal(login.status, 200);
  assert.notEqual(login.body.accessToken, token);

  const restoredDashboard = await request('/api/dashboard', {
    headers: { Authorization: `Bearer ${login.body.accessToken}` },
  });
  assert.equal(restoredDashboard.status, 200);
  assert.equal(restoredDashboard.body.driver.id, driverId);
});

test('誤ったPINではログインできない', async () => {
  const login = await request('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ driverId: 1, pin: '000000' }),
  });
  assert.equal(login.status, 401);
  assert.equal(login.body.code, 'INVALID_CREDENTIALS');
});

test('配達中はログアウトできない', async () => {
  const registration = await request('/api/drivers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '配達中ログアウト確認', pin: '112233' }),
  });
  const token = registration.body.accessToken;
  const post = (pathname, key) => request(pathname, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Idempotency-Key': key,
    },
  });
  await post('/api/shifts/start', 'busy-start');
  const offer = await post('/api/offers/current', 'busy-offer');
  await post(`/api/offers/${offer.body.id}/accept`, 'busy-accept');

  const logout = await post('/api/logout', 'busy-logout');
  assert.equal(logout.status, 409);
  assert.equal(logout.body.code, 'INVALID_STATE_TRANSITION');

  const dashboard = await request('/api/dashboard', {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(dashboard.status, 200);
  assert.equal(dashboard.body.driver.status, 'BUSY');
});

test('待機中はログアウトできず、先に退勤する必要がある', async () => {
  const registration = await request('/api/drivers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '待機中ログアウト確認', pin: '445566' }),
  });
  const token = registration.body.accessToken;
  const post = (pathname, key) => request(pathname, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Idempotency-Key': key,
    },
  });
  await post('/api/shifts/start', 'idle-logout-start');

  const logout = await post('/api/logout', 'idle-logout-attempt');
  assert.equal(logout.status, 409);
  assert.equal(logout.body.code, 'INVALID_STATE_TRANSITION');

  const endShift = await post('/api/shifts/end', 'idle-logout-end');
  assert.equal(endShift.status, 200);
  assert.equal(endShift.body.status, 'OFFLINE');

  const successfulLogout = await post('/api/logout', 'idle-logout-after-end');
  assert.equal(successfulLogout.status, 200);
});

test('PINを5回間違えるとログインを一時的に拒否する', async () => {
  const registration = await request('/api/drivers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'レート制限確認', pin: '778899' }),
  });
  const driverId = registration.body.driver.id;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const failedLogin = await request('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ driverId, pin: '000000' }),
    });
    assert.equal(failedLogin.status, 401);
  }

  const blockedLogin = await request('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ driverId, pin: '778899' }),
  });
  assert.equal(blockedLogin.status, 429);
  assert.equal(blockedLogin.body.code, 'TOO_MANY_LOGIN_ATTEMPTS');
});
