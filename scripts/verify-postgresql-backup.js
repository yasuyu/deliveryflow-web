const path = require('node:path');
const { parseArguments, loadConfig, createDockerRunner, backupDatabase, restoreDatabase } = require('./postgresql-backup');

const tables = ['Driver', 'Store', 'Order', 'Offer', 'Assignment', 'ScoreRule', 'ScoreEvent', 'IdempotencyKey', '_prisma_migrations'];
const tableSnapshots = tables.map((table) => `'${table}', (SELECT json_build_object('count', count(*), 'digest', md5(coalesce(string_agg(to_jsonb(t)::text, E'\\n' ORDER BY t.id), ''))) FROM "${table}" t)`);
const snapshotSql = `SELECT json_build_object(${tableSnapshots.join(', ')}, 'sequences', (SELECT coalesce(json_agg(json_build_object('name', sequencename, 'value', last_value) ORDER BY sequencename), '[]') FROM pg_sequences WHERE schemaname = 'public'));`;

async function snapshot(config, run, database) {
  const json = await run(['exec', '-T', 'db', 'psql', `--username=${config.POSTGRES_USER}`, `--dbname=${database}`,
    '--no-psqlrc', '--tuples-only', '--no-align', '--set=ON_ERROR_STOP=1', `--command=${snapshotSql}`]);
  return JSON.parse(json);
}

async function verifyBackup(config, run) {
  const before = await snapshot(config, run, config.POSTGRES_DB);
  // Verification may target a separate Compose stack. Keep its archives out of
  // the regular backup directory so selecting the latest backup stays safe.
  const file = await backupDatabase(config, run, path.resolve(__dirname, '..', 'data', 'backup-verification'));
  const restored = await restoreDatabase(config, run, file);
  const after = await snapshot(config, run, config.POSTGRES_DB);
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('検証中に元DBが更新されました。バックアップは保持しています。配達操作を止めた状態で検証し直してください。');
  const recovered = await snapshot(config, run, restored.database);
  if (JSON.stringify(before) !== JSON.stringify(recovered)) throw new Error('復元したデータが一致しません。バックアップと復元用DBは保持しています。');
  let refused = false;
  try {
    await restoreDatabase(config, run, file, restored.database);
  } catch {
    refused = true;
  }
  if (!refused || JSON.stringify(recovered) !== JSON.stringify(await snapshot(config, run, restored.database))) {
    throw new Error('既存の復元用DBを保護できませんでした。検証結果を確認してください。');
  }
  return { file, database: restored.database, counts: restored.counts };
}

async function main() {
  const options = parseArguments(['backup', ...process.argv.slice(2)]);
  const envFile = path.resolve(__dirname, '..', options.envFile);
  const config = await loadConfig(envFile);
  const result = await verifyBackup(config, createDockerRunner(envFile));
  console.log('PostgreSQLバックアップ・新規DBへの復元検証が成功しました（全テーブル・ID採番・認証情報・実績の一致）。');
  console.log(`検証用バックアップ: data/backup-verification/${path.basename(result.file)}`);
  console.log(`復元用DB: ${result.database}`);
  console.log(`配達員 ${result.counts.drivers}件 / 完了配達 ${result.counts.deliveries}件 / 加点履歴 ${result.counts.scoreEvents}件`);
}

if (require.main === module) main().catch((error) => {
  console.error(error.code ? '設定・バックアップ・Dockerの起動状態を確認してください。' : error.message);
  process.exitCode = 1;
});

module.exports = { verifyBackup, snapshotSql };
