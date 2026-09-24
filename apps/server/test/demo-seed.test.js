const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const projectRoot = path.resolve(__dirname, '../../..');
const databaseName = `deliveryflow-demo-seed-${randomUUID()}.db`;
const databasePath = path.join(projectRoot, 'prisma', databaseName);
process.env.DATABASE_URL = `file:./${databaseName}`;

const { PrismaClient } = require('../../../generated/client-v2');
const {
  demoCompetitors,
  demoStores,
  ensureHackathonDemo,
  resetHackathonDemoRankings,
} = require('../src/modules/demo/demo-fixtures');

let prisma;

before(async () => {
  const database = new DatabaseSync(databasePath);
  const migrationsDirectory = path.join(projectRoot, 'prisma/migrations');
  const migrationDirectories = (await fs.readdir(migrationsDirectory)).sort();
  for (const directory of migrationDirectories) {
    database.exec(await fs.readFile(path.join(migrationsDirectory, directory, 'migration.sql'), 'utf8'));
  }
  database.prepare('INSERT INTO "Store" ("name", "address") VALUES (?, ?)').run('既存店舗', '既存住所');
  database.prepare('INSERT INTO "Driver" ("name", "score") VALUES (?, ?)').run('山田 配達員', 321);
  database.close();
  prisma = new PrismaClient();
});

after(async () => {
  await prisma?.$disconnect();
  for (const suffix of ['', '-journal', '-wal', '-shm']) await fs.rm(databasePath + suffix, { force: true });
});

test('ハッカソン用デモデータを既存データを残して一度だけ追加する', async () => {
  await ensureHackathonDemo(prisma);
  await ensureHackathonDemo(prisma);

  assert.equal(await prisma.store.count({ where: { name: { in: demoStores.map((store) => store.name) } } }), 5);
  assert.equal(await prisma.store.count({ where: { name: '既存店舗' } }), 1);
  assert.equal(await prisma.driver.count({ where: { name: { in: demoCompetitors.map((driver) => driver.name) } } }), 5);
  assert.equal((await prisma.driver.findFirst({ where: { name: '山田 配達員' } })).score, 321);

  const expectedDeliveries = demoCompetitors.reduce((sum, driver) => sum + driver.points.length, 0);
  assert.equal(await prisma.assignment.count(), expectedDeliveries);
  assert.equal(await prisma.scoreEvent.count(), expectedDeliveries);

  for (const fixture of demoCompetitors) {
    const driver = await prisma.driver.findFirst({ where: { name: fixture.name } });
    assert.equal(driver.pinHash, null);
    assert.equal(driver.status, 'OFFLINE');
    assert.equal(driver.score, fixture.points.reduce((sum, points) => sum + points, 0));
  }

  const user = await prisma.driver.create({ data: { name: '保持する利用者', score: 321 } });
  const userOrder = await prisma.order.create({
    data: { storeId: (await prisma.store.findFirst({ where: { name: '既存店舗' } })).id, pickupName: '既存店舗', dropoffName: '保持する配達先', status: 'ASSIGNED' },
  });
  await prisma.assignment.create({ data: { orderId: userOrder.id, driverId: user.id } });
  const reset = await resetHackathonDemoRankings(prisma);
  assert.equal(reset.competitors, 5);
  assert.equal(reset.resetDeliveries, expectedDeliveries);
  assert.equal(await prisma.order.count({ where: { id: userOrder.id } }), 1);
  assert.equal((await prisma.driver.findUnique({ where: { id: user.id } })).score, 321);
  assert.equal(await prisma.scoreEvent.count(), expectedDeliveries);
});
