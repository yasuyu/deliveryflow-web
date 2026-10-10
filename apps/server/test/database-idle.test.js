const assert = require('node:assert/strict');
const { test } = require('node:test');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const net = require('node:net');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { WebSocket } = require('ws');

const projectRoot = path.resolve(__dirname, '../../..');

async function fixture(t, idleMode) {
  const name = `deliveryflow-idle-test-${randomUUID()}.db`;
  const databasePath = path.join(projectRoot, 'prisma', name);
  const queryLog = `${databasePath}.queries`;
  const database = new DatabaseSync(databasePath);
  const migrations = path.join(projectRoot, 'prisma/migrations');
  for (const directory of (await fs.readdir(migrations)).sort()) {
    database.exec(await fs.readFile(path.join(migrations, directory, 'migration.sql'), 'utf8'));
  }
  database.close();
  await fs.writeFile(queryLog, '');
  const port = await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const value = probe.address().port;
      probe.close((error) => error ? reject(error) : resolve(value));
    });
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ['--require', './scripts/test-support/database-query-log.cjs', 'apps/server/src/main.js'], {
    cwd: projectRoot,
    env: {
      ...process.env, DATABASE_PROVIDER: 'sqlite', DATABASE_URL: `file:./${name}`, PORT: String(port),
      DATABASE_IDLE_MODE: String(idleMode), DELIVERYFLOW_TEST_QUERY_LOG: queryLog,
      DEMO_RANKING_SEED: 'false', GEMINI_API_KEY: '', GEMINI_FREE_TIER_CONFIRMED: 'false',
    },
    stdio: 'ignore',
  });
  t.after(async () => {
    if (server.exitCode === null) {
      const exited = once(server, 'exit');
      server.kill();
      await exited;
    }
    for (const file of [databasePath, `${databasePath}-journal`, `${databasePath}-wal`, `${databasePath}-shm`, queryLog]) {
      await fs.rm(file, { force: true });
    }
  });
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      if ((await fetch(`${baseUrl}/healthz`)).ok) { ready = true; break; }
    } catch { /* Server is starting. */ }
    if (server.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(ready, true, 'Isolated server starts');
  return {
    baseUrl,
    databasePath,
    queries: async () => (await fs.readFile(queryLog, 'utf8')).split('\n').filter(Boolean).length,
    request: async (pathname, options) => {
      const response = await fetch(`${baseUrl}${pathname}`, options);
      return { status: response.status, body: await response.json() };
    },
  };
}

test('休止モードの監視・静的配信・WebSocket心拍はDBへ問い合わせず、明示的な接続確認はDBを検証する', async (t) => {
  const app = await fixture(t, true);
  const registration = await app.request('/api/drivers', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '休止確認', pin: '246810' }),
  });
  assert.equal(registration.status, 201);
  const socket = new WebSocket(app.baseUrl.replace('http:', 'ws:') + '/api/realtime',
    ['deliveryflow.realtime.v1', `auth.${registration.body.accessToken}`]);
  t.after(() => socket.terminate());
  const connected = once(socket, 'message');
  await once(socket, 'open');
  await connected;
  const before = await app.queries();
  const heartbeat = once(socket, 'ping');
  for (let attempt = 0; attempt < 3; attempt += 1) {
    assert.deepEqual(await app.request('/healthz'), { status: 200, body: { status: 'ok', database: 'not_checked' } });
    assert.equal((await app.request('/metrics')).status, 200);
    assert.equal((await fetch(app.baseUrl + '/')).status, 200);
  }
  await heartbeat;
  await new Promise((resolve) => setTimeout(resolve, 180));
  assert.equal(await app.queries(), before, 'No background or monitoring SQL');
  assert.deepEqual(await app.request('/readyz'), { status: 200, body: { status: 'ok', database: 'connected' } });
  assert.ok(await app.queries() > before);
  socket.close();
  await once(socket, 'close');
});

test('通常モードはDBを確認し、定期的な期限切れ位置の削除を維持する', async (t) => {
  const app = await fixture(t, false);
  assert.deepEqual(await app.request('/healthz'), { status: 200, body: { status: 'ok', database: 'connected' } });
  const before = await app.queries();
  await new Promise((resolve) => setTimeout(resolve, 180));
  assert.ok(await app.queries() > before, 'Normal mode still runs periodic cleanup');
});

test('休止中の期限切れ位置は次の認証済み利用で削除し、配達員・認証情報を保持する', async (t) => {
  const app = await fixture(t, true);
  const register = () => app.request('/api/drivers', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '位置保持確認', pin: '246810' }),
  });
  const first = await register();
  const second = await register();
  const db = new DatabaseSync(app.databasePath);
  try {
    const expired = Date.now() - 13 * 60 * 60 * 1000;
    db.prepare('UPDATE Driver SET latitude=35, longitude=135, locationSource=?, locationUpdatedAt=? WHERE id=?')
      .run('DEVICE', expired, second.body.driver.id);
    const storedBefore = db.prepare('SELECT * FROM Driver WHERE id=?').get(second.body.driver.id);
    const headers = { Authorization: `Bearer ${first.body.accessToken}` };
    assert.equal((await app.request('/api/dashboard', { headers })).status, 200);
    const storedAfter = db.prepare('SELECT * FROM Driver WHERE id=?').get(second.body.driver.id);
    assert.equal(storedAfter.latitude, null);
    assert.equal(storedAfter.longitude, null);
    assert.equal(storedAfter.locationSource, null);
    assert.equal(storedAfter.locationUpdatedAt, null);
    assert.equal(storedAfter.accessTokenHash, storedBefore.accessTokenHash);
    assert.equal(storedAfter.pinHash, storedBefore.pinHash);
    assert.equal(storedAfter.score, storedBefore.score);
    assert.equal((await app.request('/api/dashboard', { headers: { Authorization: `Bearer ${second.body.accessToken}` } })).status, 200);
    // A location can expire within the cleanup throttle window. Matching must still reject it.
    db.prepare('UPDATE Driver SET latitude=35.011, longitude=135.768, locationSource=?, locationUpdatedAt=? WHERE id=?')
      .run('DEMO', Date.now(), first.body.driver.id);
    db.prepare('UPDATE Driver SET status=?, shiftStartedAt=?, latitude=35, longitude=135, locationSource=?, locationUpdatedAt=? WHERE id=?')
      .run('IDLE', Date.now(), 'DEVICE', expired, second.body.driver.id);
    assert.equal((await app.request('/api/shifts/start', {
      method: 'POST', headers: { ...headers, 'Idempotency-Key': randomUUID() },
    })).status, 200);
    assert.ok(db.prepare('SELECT count(*) AS count FROM Offer WHERE driverId=?').get(first.body.driver.id).count > 0);
    assert.equal(db.prepare('SELECT count(*) AS count FROM Offer WHERE driverId=?').get(second.body.driver.id).count, 0);
  } finally {
    db.close();
  }
});
