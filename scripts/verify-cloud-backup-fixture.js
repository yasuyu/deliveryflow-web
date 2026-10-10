const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createRestoreRunner, verifyCloudBackup } = require('./cloud-backup');

async function main() {
  const local = createRestoreRunner();
  await local(['up', '-d', '--wait', 'db']);
  const database = `deliveryflow_restore_cloud_fixture_${randomUUID().slice(0, 8)}`;
  await local(['exec', '-T', 'db', 'createdb', '--username=deliveryflow_backup', '--template=template0', database]);
  const migrations = path.resolve(__dirname, '..', 'prisma', 'migrations-postgresql');
  const directories = (await fs.readdir(migrations, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  const statements = await Promise.all(directories.map((directory) => fs.readFile(path.join(migrations, directory, 'migration.sql'), 'utf8')));
  // This DB is newly created for this run. Dummy credentials never authenticate a user.
  statements.push(`
CREATE TABLE "_prisma_migrations" (id TEXT PRIMARY KEY, checksum TEXT NOT NULL);
INSERT INTO "_prisma_migrations" VALUES ('fixture', 'fixture-checksum');
INSERT INTO "Driver" (name, "pinHash", "accessTokenHash", score) VALUES ('バックアップ検証用 🛵', 'fixture-pin-hash', 'fixture-token-hash', 150);
INSERT INTO "Store" (name, address) VALUES ('検証用店舗', '架空の住所');
INSERT INTO "Order" ("storeId", "pickupName", "dropoffName", status) VALUES (1, '検証用店舗', '検証用配達先', 'DELIVERED');
INSERT INTO "Assignment" ("orderId", "driverId", "deliveredAt") VALUES (1, 1, NOW());
INSERT INTO "ScoreEvent" ("driverId", "assignmentId", points, reason, breakdown) VALUES (1, 1, 150, 'fixture', '[{"label":"日本語","points":150}]');
INSERT INTO "IdempotencyKey" (key, endpoint, "driverId", response, "statusCode") VALUES ('fixture', '/api/shifts/end', 1, '{"shiftSummary":{"pointsEarned":150}}', 200);
`);
  await local(['exec', '-T', 'db', 'psql', '--username=deliveryflow_backup', `--dbname=${database}`, '--no-psqlrc', '--set=ON_ERROR_STOP=1'],
    { inputText: statements.join('\n') });
  // Run the same dump/restore/verification on a local PG18 source, without cloud credentials.
  const source = (args, options) => local(['exec', '-T', 'db', args[0], '--username=deliveryflow_backup', `--dbname=${database}`, ...args.slice(1)], options);
  const result = await verifyCloudBackup({ PGUSER: 'deliveryflow_backup', PGDATABASE: database }, source, local,
    path.resolve(__dirname, '..', 'data', 'cloud-backup-verification'));
  if (result.counts.drivers !== 1 || result.counts.deliveries !== 1 || result.counts.scoreEvents !== 1) throw new Error('検証用データの件数が一致しません。');
  console.log('PostgreSQL 18のクラウドバックアップ処理・全9テーブル・未使用シーケンスを含むID採番・既存DB保護を確認しました。');
  console.log(`検証用バックアップ: data/cloud-backup-verification/${path.basename(result.file)}`);
  console.log(`復元用DB: ${result.database}`);
}

if (require.main === module) main().catch((error) => {
  console.error(error.code ? '検証用の設定・Dockerの起動状態を確認してください。' : error.message);
  process.exitCode = 1;
});
