const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { randomBytes, randomUUID, createHash } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { japanMonthWindow } = require('../src/modules/score/monthly-awards');
const root = path.resolve(__dirname, '../../..');
const { PrismaClient } = require(path.join(root, 'generated/client-v2'));

async function fixture(t) {
  const name = `deliveryflow-priority-${randomUUID()}.db`;
  const file = path.join(root, 'prisma', name);
  const sqlite = new DatabaseSync(file);
  const migrations = path.join(root, 'prisma/migrations');
  for (const directory of (await fs.readdir(migrations)).sort()) {
    sqlite.exec(await fs.readFile(path.join(migrations, directory, 'migration.sql'), 'utf8'));
  }
  sqlite.close();
  const db = new PrismaClient({ datasources: { db: { url: `file:./${name}` } }, log: [] });
  const store = await db.store.create({ data: { name: '優先度テスト店舗', address: '架空', latitude: 35, longitude: 135 } });
  const drivers = [];
  for (let index = 0; index < 5; index++) {
    const token = randomBytes(32).toString('base64url');
    const driver = await db.driver.create({ data: {
      name: `候補${index}`, score: index === 0 ? 5_000_000 : 0,
      accessTokenHash: createHash('sha256').update(token).digest('hex'),
      latitude: 35, longitude: index === 3 ? 136 : 135,
      locationSource: 'DEVICE', locationUpdatedAt: new Date(),
    } });
    drivers.push({ ...driver, token });
  }
  async function awardPoints(driver, points, createdAt) {
    const order = await db.order.create({ data: { storeId: store.id, pickupName: '記録用店舗', dropoffName: '記録用配送先', status: 'DELIVERED' } });
    const assignment = await db.assignment.create({ data: { orderId: order.id, driverId: driver.id, deliveredAt: createdAt } });
    await db.scoreEvent.create({ data: { driverId: driver.id, assignmentId: assignment.id, points, reason: 'fixture', createdAt } });
  }
  const now = new Date();
  const previous = japanMonthWindow(new Date(japanMonthWindow(now).startsAt.getTime() - 1));
  const older = japanMonthWindow(new Date(previous.startsAt.getTime() - 1));
  for (const [index, points] of [[0, 10000], [2, 9000], [4, 8000]]) await awardPoints(drivers[index], points, new Date(previous.startsAt.getTime() + 3600000));
  for (const [index, points] of [[4, 500], [0, 100], [2, 50]]) await awardPoints(drivers[index], points, new Date(older.startsAt.getTime() + 3600000));
  await awardPoints(drivers[0], 100, now);
  await awardPoints(drivers[1], 500, now);
  await awardPoints(drivers[2], 100, now);
  await awardPoints(drivers[3], 999999, now);
  await awardPoints(drivers[0], 1000000, new Date(now.getTime() - 15 * 86400000));
  await awardPoints(drivers[0], 1000000, new Date(now.getTime() + 7 * 86400000));
  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  let server;
  async function start() {
    server = spawn(process.execPath, ['apps/server/src/main.js'], {
      cwd: root, env: { ...process.env, DATABASE_PROVIDER: 'sqlite', DATABASE_URL: `file:./${name}`,
        PORT: String(port), OFFER_CANDIDATE_LIMIT: '3', OFFER_TTL_SECONDS: '30',
        DEMO_RANKING_SEED: 'false', GEMINI_API_KEY: '', GEMINI_FREE_TIER_CONFIRMED: 'false' }, stdio: 'ignore',
    });
    for (let index = 0; index < 100; index++) {
      try { if ((await fetch(base + '/healthz')).ok) return; } catch {}
      if (server.exitCode !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('Priority fixture server did not start');
  }
  async function stop() {
    if (server && server.exitCode === null) { const done = once(server, 'exit'); server.kill(); await done; }
  }
  t.after(async () => {
    await stop(); await db.$disconnect();
    for (const suffix of ['', '-wal', '-shm', '-journal']) await fs.rm(file + suffix, { force: true });
  });
  await start();
  async function request(index, endpoint, method = 'GET', key = randomUUID(), payload) {
    const response = await fetch(base + endpoint, { method, headers: {
      Authorization: `Bearer ${drivers[index].token}`, 'Idempotency-Key': key, 'Content-Type': 'application/json',
    }, body: payload === undefined ? undefined : JSON.stringify(payload) });
    return { status: response.status, body: await response.json() };
  }
  async function active() {
    await db.driver.updateMany({ where: { id: { in: drivers.slice(0, 4).map(({ id }) => id) } },
      data: { status: 'IDLE', shiftStartedAt: new Date(), locationUpdatedAt: new Date(),
        latitude: 35.011, longitude: 135.768, locationSource: 'DEVICE' } });
    await db.driver.update({ where: { id: drivers[3].id }, data: { longitude: 136 } });
    const snapshot = await request(0, '/api/dashboard');
    assert.equal(snapshot.status, 200, JSON.stringify(snapshot.body));
    const offers = await db.offer.findMany({ where: { priorityRank: { not: null } }, orderBy: { priorityRank: 'asc' } });
    assert.deepEqual(offers.map(({ driverId }) => driverId), [drivers[1].id, drivers[0].id, drivers[2].id]);
    assert.deepEqual(offers.map(({ status }) => status), ['PENDING', 'QUEUED', 'QUEUED']);
    return offers;
  }
  return { db, drivers, request, active, start, stop, previous, older };
}

test('終了月の称号を蓄積し、今月は未確定、再起動後も履歴を変更しない', async (t) => {
  const f = await fixture(t);
  const first = await f.request(0, '/api/drivers/me/monthly-awards');
  assert.equal(first.status, 200);
  assert.deepEqual(first.body.awards.map(({ month, rank }) => [month, rank]), [[f.previous.label, 1], [f.older.label, 2]]);
  assert.equal((await f.request(1, '/api/drivers/me/monthly-awards')).body.awards.length, 0);
  const score = await f.request(0, '/api/drivers/me/score');
  assert.equal(score.body.bestMonthlyAward.title, '月間チャンピオン');
  await f.db.scoreEvent.updateMany({ where: { driverId: f.drivers[0].id, createdAt: { lt: f.previous.endsAt } }, data: { points: 1 } });
  await f.stop(); await f.start();
  assert.deepEqual((await f.request(0, '/api/drivers/me/monthly-awards')).body, first.body);
});

test('14日ポイントだけを使い、累計・古い点・未来点・遠い高得点者を候補順位から除く', async (t) => {
  const f = await fixture(t);
  const offers = await f.active();
  assert.equal((await f.request(0, '/api/dashboard')).body.offerWaiting, true);
  assert.equal((await f.request(0, '/api/offers/current', 'POST')).status, 404);
  assert.equal((await f.request(0, `/api/offers/${offers[1].id}/accept`, 'POST')).status, 409);
  const shown = await f.request(1, '/api/offers/current', 'POST');
  assert.equal(shown.status, 200);
  const key = randomUUID();
  const results = await Promise.all([f.request(1, `/api/offers/${shown.body.id}/accept`, 'POST', key),
    f.request(1, `/api/offers/${shown.body.id}/accept`, 'POST', key)]);
  assert.ok(results.every(({ status }) => status === 200));
  assert.deepEqual(results[0].body, results[1].body);
  assert.equal(await f.db.assignment.count({ where: { orderId: shown.body.orderId } }), 1);
  assert.equal(await f.db.offer.count({ where: { orderId: shown.body.orderId, status: 'WITHDRAWN' } }), 2);
});

test('表示する14日ポイントと今月ランキングも未来の実績を集計しない', async (t) => {
  const f = await fixture(t);
  const score = await f.request(0, '/api/drivers/me/score');
  assert.equal(score.body.currentScore, 100);
  assert.ok(score.body.recentEvents.every(({ createdAt }) => Date.parse(createdAt) <= Date.now()));
  const ranking = await f.request(0, '/api/drivers/ranking');
  assert.equal(ranking.body.current.me.score, 100);
  const previousPointsAreThisMonth = Date.now() - 15 * 86400000 >= japanMonthWindow().startsAt.getTime();
  assert.equal(ranking.body.monthly.me.score, previousPointsAreThisMonth ? 1000100 : 100);
});

test('今月0ポイントには暫定称号を表示せず、正の同点には同じ称号を表示する', async (t) => {
  const f = await fixture(t);
  const month = japanMonthWindow();
  await f.db.scoreEvent.updateMany({ where: { createdAt: { gte: month.startsAt } }, data: { points: 0 } });
  const empty = await f.request(0, '/api/drivers/ranking');
  assert.equal(empty.body.monthly.me.rank, 1);
  assert.equal(empty.body.monthly.me.monthlyTitle, null);
  const currentEvents = await f.db.scoreEvent.findMany({
    where: { driverId: { in: f.drivers.slice(0, 2).map(({ id }) => id) }, createdAt: { gte: month.startsAt, lte: new Date() } },
    orderBy: { createdAt: 'desc' },
  });
  for (const driver of f.drivers.slice(0, 2)) {
    const event = currentEvents.find(({ driverId }) => driverId === driver.id);
    await f.db.scoreEvent.update({ where: { id: event.id }, data: { points: 100 } });
  }
  const tied = await f.request(2, '/api/drivers/ranking');
  assert.equal(tied.body.monthly.me.rank, 3);
  assert.equal(tied.body.monthly.me.monthlyTitle, null);
  assert.deepEqual(tied.body.monthly.leaders.slice(0, 2).map(({ monthlyTitle }) => monthlyTitle), ['月間チャンピオン', '月間チャンピオン']);
});

test('辞退後は同じ注文を次候補へ渡し、待機順位は再起動で保持する', async (t) => {
  const f = await fixture(t);
  const offers = await f.active();
  await f.stop(); await f.start();
  assert.equal((await f.request(1, '/api/offers/current', 'POST')).status, 200);
  assert.equal((await f.request(1, '/api/simulator/weather', 'POST', randomUUID(), { condition: 'RAIN' })).status, 200);
  const snapshots = await f.db.offer.findMany({ where: { orderId: offers[0].orderId }, orderBy: { priorityRank: 'asc' } });
  assert.equal(snapshots[0].estimatedPoints, offers[0].estimatedPoints);
  assert.equal(snapshots[1].estimatedPoints, offers[1].estimatedPoints + 30);
  assert.equal(snapshots[2].estimatedPoints, offers[2].estimatedPoints + 30);
  assert.equal((await f.request(1, `/api/offers/${offers[0].id}/reject`, 'POST')).status, 200);
  const next = await f.request(0, '/api/offers/current', 'POST');
  assert.equal(next.status, 200);
  assert.equal(next.body.orderId, offers[0].orderId);
  assert.equal(next.body.priorityRank, 2);
});

test('期限切れと待機候補の退勤を処理し、次の有効候補へ提示する', async (t) => {
  const f = await fixture(t);
  const offers = await f.active();
  assert.equal((await f.request(0, '/api/shifts/end', 'POST')).status, 200);
  await f.db.offer.update({ where: { id: offers[0].id }, data: { expiresAt: new Date(Date.now() - 1000) } });
  const dashboard = await f.request(2, '/api/dashboard');
  assert.equal(dashboard.body.offer.id, offers[2].id);
  assert.equal(dashboard.body.offerWaiting, false);
  assert.equal((await f.request(2, '/api/offers/current', 'POST')).body.orderId, offers[0].orderId);
});

test('月間称号の履歴は本人だけに20件ずつ返し、不正なカーソルを拒否する', async (t) => {
  const f = await fixture(t);
  for (let index = 0; index < 21; index++) {
    const month = `2000-${String(index % 12 + 1).padStart(2, '0')}`;
    const label = `${2000 + Math.floor(index / 12)}-${month.slice(5)}`;
    const window = japanMonthWindow(new Date(label + '-15T00:00:00+09:00'));
    await f.db.monthlyAwardPeriod.create({ data: { month: label, startsAt: window.startsAt, endsAt: window.endsAt,
      awards: { create: { driverId: f.drivers[0].id, rank: 3, title: '月間トップ3', points: 10 } } } });
  }
  const first = await f.request(0, '/api/drivers/me/monthly-awards');
  assert.equal(first.body.awards.length, 20);
  const next = await f.request(0, `/api/drivers/me/monthly-awards?cursor=${first.body.pagination.nextCursor}`);
  assert.equal(next.body.awards.length, 3);
  assert.equal(next.body.pagination.hasMore, false);
  assert.equal(new Set([...first.body.awards, ...next.body.awards].map(({ id }) => id)).size, 23);
  assert.ok(first.body.awards.every((row) => !('driverId' in row) && !('accessTokenHash' in row)));
  const foreign = (await f.request(2, '/api/drivers/me/monthly-awards')).body.awards[0].id;
  assert.equal((await f.request(0, `/api/drivers/me/monthly-awards?cursor=${foreign}`)).status, 404);
  for (const value of ['', '0', '-1', 'abc']) assert.equal((await f.request(0, '/api/drivers/me/monthly-awards?cursor=' + value)).status, 400);
});
