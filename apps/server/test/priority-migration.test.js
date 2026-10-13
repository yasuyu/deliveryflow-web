const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

test('称号・優先順位Migrationは旧データと既存の同時提示を保持し、新方式の複数提示だけを拒否する', async () => {
  const root = path.resolve(__dirname, '../../..');
  const file = path.join(root, 'prisma', `priority-migration-${randomUUID()}.db`);
  const db = new DatabaseSync(file);
  try {
    const folder = path.join(root, 'prisma/migrations');
    const names = (await fs.readdir(folder)).sort();
    for (const name of names.slice(0, -1)) db.exec(await fs.readFile(path.join(folder, name, 'migration.sql'), 'utf8'));
    db.exec(`
      INSERT INTO Driver (name, score, pinHash, accessTokenHash) VALUES ('既存確認', 500, 'fixture-pin', 'fixture-token');
      INSERT INTO Driver (name) VALUES ('既存候補');
      INSERT INTO Store (name, address) VALUES ('既存店舗', '架空');
      INSERT INTO "Order" (storeId, pickupName, dropoffName, status) VALUES (1, '店舗', '配達先', 'OFFERING');
      INSERT INTO Offer (orderId, driverId, status) VALUES (1, 1, 'PENDING'), (1, 2, 'PENDING');
      INSERT INTO IdempotencyKey (key, endpoint, driverId, response, statusCode) VALUES ('fixture', '/api/shifts/end', 1, '{"shiftSummary":{"pointsEarned":500}}', 200);
    `);
    const before = { drivers: db.prepare('SELECT * FROM Driver ORDER BY id').all(),
      keys: db.prepare('SELECT * FROM IdempotencyKey').all() };
    db.exec(await fs.readFile(path.join(folder, names.at(-1), 'migration.sql'), 'utf8'));
    assert.deepEqual(db.prepare('SELECT * FROM Driver ORDER BY id').all(), before.drivers);
    assert.deepEqual(db.prepare('SELECT * FROM IdempotencyKey').all(), before.keys);
    assert.deepEqual(db.prepare('SELECT status, priorityRank FROM Offer ORDER BY id').all().map(({ status, priorityRank }) => ({ status, priorityRank })), [
      { status: 'PENDING', priorityRank: null }, { status: 'PENDING', priorityRank: null },
    ]);
    db.prepare('UPDATE Offer SET priorityRank = 1 WHERE id = 1').run();
    assert.throws(() => db.prepare('UPDATE Offer SET priorityRank = 2 WHERE id = 2').run(), /UNIQUE/);
    assert.equal(db.prepare('SELECT count(*) AS n FROM MonthlyAward').get().n, 0);
  } finally { db.close(); await fs.rm(file, { force: true }); }
});
