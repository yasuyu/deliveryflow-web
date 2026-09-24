const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const net = require('node:net');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { WebSocket } = require('ws');

const projectRoot = path.resolve(__dirname, '../../..');
const testDatabasePrefix = 'deliveryflow-test-';
const databaseName = `deliveryflow-test-${randomUUID()}.db`;
const databaseUrl = `file:./${databaseName}`;
const databasePath = path.join(projectRoot, 'prisma', databaseName);
let serverProcess;
let baseUrl;
let accessToken;
let primaryDriverId;

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
  database.prepare('INSERT INTO "Store" ("name", "address") VALUES (?, ?)').run('BKC 既存店舗', '既存の学習用店舗');
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

function updateLocation(token, latitude = 35.009, longitude = 135.768) {
  return request('/api/drivers/me/location', {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ latitude, longitude, accuracyMeters: 8 }),
  });
}

before(async () => {
  await createTestDatabase();

  const port = await getFreePort();
  baseUrl = `http://127.0.0.1:${port}`;
  serverProcess = spawn(process.execPath, ['apps/server/src/main.js'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      PORT: String(port),
      OFFER_TTL_SECONDS: '120',
      OFFER_CANDIDATE_LIMIT: '3',
      SCORE_BONUS_SIMULATED_NOW: '2026-09-14T12:00:00+09:00',
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
  primaryDriverId = registration.body.driver.id;
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

test('認証済みWebSocketへ状態変更を順序付きで通知する', async () => {
  const socket = new WebSocket(
    `${baseUrl.replace('http:', 'ws:')}/api/realtime`,
    ['deliveryflow.realtime.v1', `auth.${accessToken}`],
  );
  const connectedMessage = once(socket, 'message');
  await once(socket, 'open');
  const [connectedData] = await connectedMessage;
  const connected = JSON.parse(connectedData.toString());
  assert.equal(socket.protocol, 'deliveryflow.realtime.v1');
  assert.equal(connected.type, 'realtime.connected');
  assert.equal(Number.isInteger(connected.sequence), true);

  const changedMessage = once(socket, 'message');
  const weather = await request('/api/simulator/weather', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': 'realtime-weather-clear',
    },
    body: JSON.stringify({ condition: 'CLEAR' }),
  });
  assert.equal(weather.status, 200);
  const [changedData] = await changedMessage;
  const changed = JSON.parse(changedData.toString());
  assert.equal(changed.type, 'state.changed');
  assert.equal(changed.reason, 'simulator.updated');
  assert.equal(changed.sequence > connected.sequence, true);

  socket.close();
  await once(socket, 'close');
});

test('無効なアクセストークンのWebSocket接続を拒否する', async () => {
  const socket = new WebSocket(
    `${baseUrl.replace('http:', 'ws:')}/api/realtime`,
    ['deliveryflow.realtime.v1', `auth.${'x'.repeat(43)}`],
  );
  const statusCode = await new Promise((resolve, reject) => {
    socket.once('unexpected-response', (_request, response) => {
      response.resume();
      resolve(response.statusCode);
    });
    socket.once('open', () => reject(new Error('無効なWebSocket接続が開かれました')));
    socket.once('error', reject);
  });
  assert.equal(statusCode, 401);
});

test('配達の状態遷移をAPI経由で完了できる', async () => {
  const firstStart = await authenticatedPost('/api/shifts/start', 'start-shift');
  assert.equal(firstStart.status, 200);
  assert.equal(firstStart.body.status, 'IDLE');

  const repeatedStart = await authenticatedPost('/api/shifts/start', 'start-shift');
  assert.equal(repeatedStart.status, 200);
  assert.deepEqual(repeatedStart.body, firstStart.body);
  const located = await updateLocation(accessToken);
  assert.equal(located.status, 200);

  const offerResult = await authenticatedPost('/api/offers/current', 'show-offer');
  assert.equal(offerResult.status, 200);
  assert.equal(offerResult.body.status, 'PENDING');
  assert.equal(offerResult.body.order.deliveryFeeYen, 500);
  assert.equal(typeof offerResult.body.order.store.latitude, 'number');
  assert.equal(typeof offerResult.body.order.store.longitude, 'number');
  assert.equal(typeof offerResult.body.order.dropoffLatitude, 'number');
  assert.equal(typeof offerResult.body.order.dropoffLongitude, 'number');
  assert.equal(offerResult.body.estimatedPoints, 100);
  assert.deepEqual(offerResult.body.scoreBreakdown, [
    { code: 'DELIVERY_COMPLETED', label: '配達完了', points: 100 },
  ]);

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
  assert.equal(completed.body.driver.score, 100);
  assert.equal(completed.body.assignment, null);
  assert.equal(completed.body.scoreAward.points, 100);
  assert.equal(completed.body.scoreAward.reason, '配達完了');
  assert.deepEqual(completed.body.scoreAward.breakdown, [
    { code: 'DELIVERY_COMPLETED', label: '配達完了', points: 100 },
  ]);

  const repeatedCompletion = await authenticatedPost(`/api/assignments/${assignmentId}/complete`, 'complete-order');
  assert.equal(repeatedCompletion.status, 200);
  assert.deepEqual(repeatedCompletion.body, completed.body);

  const score = await request('/api/drivers/me/score', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  assert.equal(score.status, 200);
  assert.equal(score.body.currentScore, 100);
  assert.equal(score.body.lifetimeScore, 100);
  assert.equal(score.body.windowDays, 14);
  assert.equal(score.body.recentEvents.length, 1);
  assert.equal(score.body.recentEvents[0].points, 100);
  assert.deepEqual(score.body.recentEvents[0].breakdown, completed.body.scoreAward.breakdown);
  assert.equal(score.body.recentEvents[0].assignment.order.status, 'DELIVERED');

  const history = await request('/api/deliveries/history', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  assert.equal(history.status, 200);
  assert.equal(history.body.summary.completedDeliveries, 1);
  assert.notEqual(history.body.summary.lastDeliveredAt, null);
  assert.equal(history.body.deliveries.length, 1);
  assert.equal(history.body.deliveries[0].order.status, 'DELIVERED');
  assert.notEqual(history.body.deliveries[0].deliveredAt, null);

  const matchingHistory = await request('/api/deliveries/history?status=DELIVERED&query=' + encodeURIComponent('三条') + '&from=2000-01-01&to=2999-12-31', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  assert.equal(matchingHistory.status, 200);
  assert.equal(matchingHistory.body.summary.filteredDeliveries, 1);
  assert.deepEqual(matchingHistory.body.filters, {
    status: 'DELIVERED', query: '三条', from: '2000-01-01', to: '2999-12-31',
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

  const otherScore = await request('/api/drivers/me/score', {
    headers: { Authorization: `Bearer ${otherDriver.body.accessToken}` },
  });
  assert.equal(otherScore.status, 200);
  assert.equal(otherScore.body.currentScore, 0);
  assert.equal(otherScore.body.lifetimeScore, 0);
  assert.deepEqual(otherScore.body.recentEvents, []);

  const tiedDriver = await request('/api/drivers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '同点確認配達員', pin: '112233' }),
  });
  const ranking = await request('/api/drivers/ranking', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  assert.equal(ranking.status, 200);
  assert.equal(ranking.body.windowDays, 14);
  assert.equal(ranking.body.limit, 10);
  assert.equal(ranking.body.tiePolicy, 'competition');
  assert.deepEqual(ranking.body.current.leaders.map(({ name, score, rank }) => ({ name, score, rank })), [
    { name: 'テスト配達員', score: 100, rank: 1 },
    { name: '山田 配達員', score: 0, rank: 2 },
    { name: '履歴分離確認配達員', score: 0, rank: 2 },
    { name: '同点確認配達員', score: 0, rank: 2 },
  ]);
  assert.equal(ranking.body.current.me.rank, 1);
  assert.equal(ranking.body.current.me.isCurrentDriver, true);
  assert.equal(ranking.body.lifetime.me.score, 100);
  assert.match(ranking.body.month.label, /^\d{4}-\d{2}$/);
  assert.equal(ranking.body.monthly.me.monthlyTitle, '月間チャンピオン');
  assert.equal(
    ranking.body.monthly.leaders.filter((entry) => entry.rank === 2).every(
      (entry) => entry.monthlyTitle === '月間準優勝',
    ),
    true,
  );

  const otherRanking = await request('/api/drivers/ranking', {
    headers: { Authorization: `Bearer ${tiedDriver.body.accessToken}` },
  });
  assert.equal(otherRanking.status, 200);
  assert.equal(otherRanking.body.current.me.rank, 2);
  assert.equal(otherRanking.body.current.me.isCurrentDriver, true);

  const database = new DatabaseSync(databasePath);
  const addMonthlyEvent = (driverId, points, suffix) => {
    const occurredAt = Date.now();
    const order = database.prepare(
      'INSERT INTO "Order" ("storeId", "pickupName", "dropoffName", "status") VALUES (1, ?, ?, \'DELIVERED\')',
    ).run(`月間受取${suffix}`, `月間配送${suffix}`);
    const assignment = database.prepare(
      'INSERT INTO "Assignment" ("orderId", "driverId", "acceptedAt", "pickedUpAt", "deliveredAt") VALUES (?, ?, ?, ?, ?)',
    ).run(order.lastInsertRowid, driverId, occurredAt, occurredAt, occurredAt);
    database.prepare(
      'INSERT INTO "ScoreEvent" ("driverId", "assignmentId", "points", "reason", "createdAt") VALUES (?, ?, ?, \'月間順位テスト\', ?)',
    ).run(driverId, assignment.lastInsertRowid, points, occurredAt);
  };
  addMonthlyEvent(otherDriver.body.driver.id, 60, 'A');
  addMonthlyEvent(tiedDriver.body.driver.id, 20, 'B');
  const podiumRanking = await request('/api/drivers/ranking', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  assert.deepEqual(
    podiumRanking.body.monthly.leaders.slice(0, 3).map(
      ({ name, rank, monthlyTitle }) => ({ name, rank, monthlyTitle }),
    ),
    [
      { name: 'テスト配達員', rank: 1, monthlyTitle: '月間チャンピオン' },
      { name: '履歴分離確認配達員', rank: 2, monthlyTitle: '月間準優勝' },
      { name: '同点確認配達員', rank: 3, monthlyTitle: '月間トップ3' },
    ],
  );

  const titleCases = [
    { score: 499, current: 'ルーキー', next: 'ブロンズ', pointsNeeded: 1, progressPercent: 99 },
    { score: 500, current: 'ブロンズ', next: 'シルバー', pointsNeeded: 1000, progressPercent: 0 },
    { score: 2999, current: 'シルバー', next: 'ゴールド', pointsNeeded: 1, progressPercent: 99 },
    { score: 3000, current: 'ゴールド', next: null, pointsNeeded: null, progressPercent: 100 },
  ];
  for (const titleCase of titleCases) {
    database.prepare('UPDATE Driver SET score = ? WHERE id = ?').run(titleCase.score, primaryDriverId);
    const titledScore = await request('/api/drivers/me/score', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    assert.equal(titledScore.body.title.current.name, titleCase.current);
    assert.equal(titledScore.body.title.next?.name || null, titleCase.next);
    assert.equal(titledScore.body.title.next?.pointsNeeded || null, titleCase.pointsNeeded);
    assert.equal(titledScore.body.title.progressPercent, titleCase.progressPercent);
  }
  database.prepare('UPDATE Driver SET score = 100 WHERE id = ?').run(primaryDriverId);
  database.close();
});

test('店舗に近い3人へ同じオファーを送り、最初の受諾で残りを取り下げる', async () => {
  const drivers = [];
  const locations = [
    [35.0093, 135.7684],
    [35.0093, 135.7694],
    [35.0093, 135.7704],
    [35.0093, 136.1],
  ];

  for (let index = 0; index < locations.length; index += 1) {
    const registration = await request('/api/drivers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: `距離候補配達員${index + 1}`, pin: `65432${index}` }),
    });
    assert.equal(registration.status, 201);
    const token = registration.body.accessToken;
    const post = (pathname, key) => request(pathname, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Idempotency-Key': key },
    });
    await post('/api/shifts/start', `nearest-start-${index}`);
    const located = await updateLocation(token, ...locations[index]);
    assert.equal(located.status, 200);
    drivers.push({ ...registration.body.driver, token, post });
  }

  const database = new DatabaseSync(databasePath);
  database.prepare('UPDATE Driver SET locationUpdatedAt = ? WHERE id = ?')
    .run(new Date('2020-01-01T00:00:00Z').getTime(), drivers[1].id);

  const firstOffer = await drivers[0].post('/api/offers/current', 'nearest-show-first');
  assert.equal(firstOffer.status, 200);
  assert.equal(firstOffer.body.distanceToPickupMeters, 0);
  const secondOffer = await drivers[1].post('/api/offers/current', 'nearest-show-second');
  assert.equal(secondOffer.status, 200);
  assert.equal(secondOffer.body.orderId, firstOffer.body.orderId);

  const offers = database.prepare(
    'SELECT driverId, status, distanceToPickupMeters FROM Offer WHERE orderId = ? ORDER BY distanceToPickupMeters, driverId',
  ).all(firstOffer.body.orderId);
  assert.equal(offers.length, 3);
  assert.deepEqual(offers.map((offer) => offer.driverId), drivers.slice(0, 3).map((driver) => driver.id));
  assert.equal(offers.some((offer) => offer.driverId === drivers[3].id), false);
  assert.equal(offers.every((offer) => offer.status === 'PENDING'), true);

  const accepted = await drivers[0].post(`/api/offers/${firstOffer.body.id}/accept`, 'nearest-accept');
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.driver.status, 'BUSY');

  const settledOffers = database.prepare(
    'SELECT driverId, status FROM Offer WHERE orderId = ? ORDER BY driverId',
  ).all(firstOffer.body.orderId);
  assert.deepEqual(settledOffers.map((offer) => offer.status), ['ACCEPTED', 'WITHDRAWN', 'WITHDRAWN']);
  const secondDriver = database.prepare('SELECT status FROM Driver WHERE id = ?').get(drivers[1].id);
  assert.equal(secondDriver.status, 'IDLE');
  database.close();

  const assignmentId = accepted.body.assignment.id;
  await drivers[0].post(`/api/assignments/${assignmentId}/pickup`, 'nearest-pickup');
  await drivers[0].post(`/api/assignments/${assignmentId}/complete`, 'nearest-complete');
  for (let index = 0; index < drivers.length; index += 1) {
    const ended = await drivers[index].post('/api/shifts/end', `nearest-end-${index}`);
    assert.equal(ended.status, 200);
  }
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
  await updateLocation(token, 34.981, 135.962);
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

test('勤務中だけ現在地を保持して距離を返し、退勤時に消去する', async () => {
  const registration = await request('/api/drivers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '現在地確認配達員', pin: '864209' }),
  });
  const token = registration.body.accessToken;
  const locationHeaders = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  const offlineUpdate = await request('/api/drivers/me/location', {
    method: 'PUT', headers: locationHeaders,
    body: JSON.stringify({ latitude: 34.98, longitude: 135.96, accuracyMeters: 8 }),
  });
  assert.equal(offlineUpdate.status, 409);
  assert.equal(offlineUpdate.body.code, 'INVALID_STATE_TRANSITION');

  await request('/api/shifts/start', {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Idempotency-Key': 'location-start' },
  });
  const invalid = await request('/api/drivers/me/location', {
    method: 'PUT', headers: locationHeaders,
    body: JSON.stringify({ latitude: 91, longitude: 135.96 }),
  });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.code, 'VALIDATION_ERROR');

  const updated = await request('/api/drivers/me/location', {
    method: 'PUT', headers: locationHeaders,
    body: JSON.stringify({ latitude: 34.98, longitude: 135.96, accuracyMeters: 8 }),
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.status, 'AVAILABLE');
  assert.equal(updated.body.accuracyMeters, 8);
  assert.notEqual(updated.body.updatedAt, null);

  const dashboard = await request('/api/dashboard', { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(dashboard.body.location.status, 'AVAILABLE');
  assert.equal(typeof dashboard.body.offer.routeDistance.toPickupMeters, 'number');
  assert.equal(typeof dashboard.body.offer.routeDistance.pickupToDropoffMeters, 'number');
  assert.equal(dashboard.body.driver.latitude, undefined);

  const staleDatabase = new DatabaseSync(databasePath);
  staleDatabase.prepare('UPDATE Driver SET locationUpdatedAt = ? WHERE id = ?')
    .run(Date.now() - 5 * 60 * 1000 - 1, registration.body.driver.id);
  staleDatabase.close();
  const oldLocationDashboard = await request('/api/dashboard', { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(oldLocationDashboard.body.location.status, 'AVAILABLE');
  assert.equal(typeof oldLocationDashboard.body.offer.routeDistance.toPickupMeters, 'number');

  await request('/api/drivers/me/location', {
    method: 'PUT', headers: locationHeaders,
    body: JSON.stringify({ latitude: 34.98, longitude: 135.96, accuracyMeters: 8 }),
  });

  const ended = await request('/api/shifts/end', {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Idempotency-Key': 'location-end' },
  });
  assert.equal(ended.status, 200);
  const afterEnd = await request('/api/dashboard', { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(afterEnd.body.location.status, 'MISSING');
  assert.equal(afterEnd.body.location.updatedAt, null);

  const database = new DatabaseSync(databasePath);
  const stored = database.prepare(
    'SELECT latitude, longitude, locationAccuracyMeters, locationUpdatedAt FROM Driver WHERE id = ?',
  ).get(registration.body.driver.id);
  database.close();
  assert.equal(stored.latitude, null);
  assert.equal(stored.longitude, null);
  assert.equal(stored.locationAccuracyMeters, null);
  assert.equal(stored.locationUpdatedAt, null);
});

test('認証なしでは配達員用APIを利用できない', async () => {
  const response = await request('/api/dashboard');
  assert.equal(response.status, 401);
  assert.equal(response.body.code, 'UNAUTHORIZED');

  const ranking = await request('/api/drivers/ranking');
  assert.equal(ranking.status, 401);
  assert.equal(ranking.body.code, 'UNAUTHORIZED');

  const weather = await request('/api/simulator/weather', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'unauthorized-weather' },
    body: JSON.stringify({ condition: 'RAIN' }),
  });
  assert.equal(weather.status, 401);
  assert.equal(weather.body.code, 'UNAUTHORIZED');

  const location = await request('/api/drivers/me/location', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ latitude: 35, longitude: 135 }),
  });
  assert.equal(location.status, 401);
  assert.equal(location.body.code, 'UNAUTHORIZED');
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

test('経路プレビューのブラウザースクリプトを配信する', async () => {
  const response = await fetch(`${baseUrl}/route-preview.js`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^application\/javascript/);
  assert.match(await response.text(), /renderRoutePreview/);
});

test('ボトムシートのブラウザースクリプトを配信する', async () => {
  const response = await fetch(`${baseUrl}/bottom-sheet.js`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^application\/javascript/);
  assert.match(await response.text(), /calculateSnapHeights/);
});

test('配達操作のブラウザースクリプトを配信しホーム画面から読み込む', async () => {
  const response = await fetch(`${baseUrl}/delivery-ui.js`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^application\/javascript/);
  assert.match(await response.text(), /DeliveryFlowUi/);

  const homepage = await fetch(baseUrl);
  assert.equal(homepage.status, 200);
  const html = await homepage.text();
  assert.match(html, /<script\s+src="\/delivery-ui\.js"><\/script>/);
  assert.ok(html.indexOf('src="/delivery-ui.js"') < html.indexOf('src="/app.js"'));
});

test('実地図ライブラリをローカル配信し、外部画像の許可先を限定する', async () => {
  for (const asset of ['/vendor/leaflet.js', '/vendor/leaflet.css', '/delivery-map.js']) {
    const response = await fetch(baseUrl + asset);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), asset.endsWith('.css') ? /^text\/css/ : /^application\/javascript/);
    assert.ok((await response.text()).length > 100);
  }
  const page = await fetch(baseUrl);
  const csp = page.headers.get('content-security-policy');
  assert.match(csp, /img-src 'self' data: https:\/\/tile.openstreetmap.org;/);
  assert.match(csp, /script-src 'self';/);
  assert.equal(page.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
  const html = await page.text();
  assert.ok(html.indexOf('src="/delivery-map.js"') < html.indexOf('src="/app.js"'));
  assert.doesNotMatch(html, /<img[^>]*tile.openstreetmap.org/);
});

test('京都のデモ店舗を追加しても既存店舗の座標は変更しない', () => {
  const database = new DatabaseSync(databasePath);
  const old = database.prepare('SELECT * FROM Store WHERE name = ?').get('BKC 既存店舗');
  assert.equal(old.latitude, 34.981);
  assert.equal(old.longitude, 135.962);
  const kyoto = database.prepare('SELECT * FROM Store WHERE name = ?').get('三条デリバリーストア（デモ）');
  assert.equal(kyoto.latitude, 35.0093);
  assert.equal(kyoto.longitude, 135.7684);
  const order = database.prepare('SELECT * FROM "Order" WHERE storeId = ? LIMIT 1').get(kyoto.id);
  assert.ok(order.dropoffLatitude > 35 && order.dropoffLatitude < 35.01);
  assert.ok(order.dropoffLongitude > 135.77 && order.dropoffLongitude < 135.78);
  database.close();
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
  await updateLocation(token, 34.982, 135.963);
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

test('雨天ボーナスの見込みと完了後の内訳を固定し二重加点しない', async () => {
  const registration = await request('/api/drivers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '雨天ボーナス確認', pin: '135790' }),
  });
  const token = registration.body.accessToken;
  const post = (pathname, key, body = null) => request(pathname, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Idempotency-Key': key,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  const weather = await post('/api/simulator/weather', 'rain-weather', { condition: 'RAIN' });
  assert.equal(weather.status, 200);
  assert.equal(weather.body.weatherCondition, 'RAIN');

  await post('/api/shifts/start', 'rain-start');
  await updateLocation(token, 34.983, 135.964);
  const offer = await post('/api/offers/current', 'rain-offer');
  assert.equal(offer.body.estimatedPoints, 130);
  assert.deepEqual(offer.body.scoreBreakdown.map((item) => item.code), [
    'DELIVERY_COMPLETED',
    'WEATHER_RAIN',
  ]);

  const accepted = await post(`/api/offers/${offer.body.id}/accept`, 'rain-accept');
  const assignmentId = accepted.body.assignment.id;
  assert.equal(accepted.body.assignment.estimatedPoints, 130);

  await post('/api/simulator/weather', 'rain-clear-after-accept', { condition: 'CLEAR' });
  await post(`/api/assignments/${assignmentId}/pickup`, 'rain-pickup');
  const completed = await post(`/api/assignments/${assignmentId}/complete`, 'rain-complete');
  assert.equal(completed.body.scoreAward.points, 130);
  assert.deepEqual(completed.body.scoreAward.breakdown, offer.body.scoreBreakdown);

  const repeated = await post(`/api/assignments/${assignmentId}/complete`, 'rain-complete');
  assert.deepEqual(repeated.body, completed.body);

  const score = await request('/api/drivers/me/score', {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(score.body.lifetimeScore, 130);
  assert.equal(score.body.recentEvents.length, 1);
  assert.deepEqual(score.body.recentEvents[0].breakdown, offer.body.scoreBreakdown);
});

