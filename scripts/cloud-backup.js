const fs = require('node:fs/promises');
const path = require('node:path');
const { parseEnv, isDeepStrictEqual } = require('node:util');
const { randomUUID, randomBytes } = require('node:crypto');
const { runDocker, backupDatabase, restoreDatabase, validateArchive, validateRestoreName, checksum } = require('./postgresql-backup');
const { snapshotSql } = require('./verify-postgresql-backup');

const projectRoot = path.resolve(__dirname, '..');
const image = 'postgres:18-alpine';
const archiveDirectory = path.join(projectRoot, 'data', 'cloud-backups');
const localConfig = { POSTGRES_USER: 'deliveryflow_backup', POSTGRES_DB: 'postgres' };
const psqlArguments = ['--no-psqlrc', '--tuples-only', '--no-align', '--set=ON_ERROR_STOP=1'];

function parseArguments(args) {
  const [command, ...rest] = args;
  if (!['backup', 'restore', 'verify', 'stop'].includes(command)) throw new Error('backup、restore、verify、stopを指定してください。');
  const options = { command, envFile: '.env.neon.local' };
  const names = command === 'stop' ? {} : command === 'restore' ? { '--file': 'file', '--database': 'database' } : { '--env-file': 'envFile' };
  const seen = new Set();
  for (let index = 0; index < rest.length; index += 2) {
    const name = names[rest[index]];
    const value = rest[index + 1];
    if (!name || !value || value.startsWith('--') || seen.has(name)) throw new Error('引数を確認してください。接続URLは引数へ指定しません。');
    seen.add(name);
    options[name] = value;
  }
  if (command === 'restore' && !options.file) throw new Error('復元には --file を指定してください。');
  if (options.database) validateCloudRestoreName(options.database);
  return options;
}

function connectionConfig(values) {
  try {
    const url = new URL(values.DATABASE_URL_UNPOOLED || values.DIRECT_URL || values.DATABASE_URL);
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || url.hostname.includes('-pooler') || url.hash) throw new Error();
    const sslmode = url.searchParams.get('sslmode') || 'require';
    if (!['require', 'verify-ca', 'verify-full'].includes(sslmode)) throw new Error();
    const channelBinding = url.searchParams.get('channel_binding') || 'prefer';
    if (!['disable', 'prefer', 'require'].includes(channelBinding)) throw new Error();
    const config = {
      PGHOST: url.hostname, PGPORT: url.port || '5432',
      PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password),
      PGDATABASE: decodeURIComponent(url.pathname.slice(1)), PGSSLMODE: sslmode,
      PGCHANNELBINDING: channelBinding, PGCONNECT_TIMEOUT: '30',
      PGOPTIONS: '-c default_transaction_read_only=on',
    };
    if (!config.PGUSER || !config.PGPASSWORD || !config.PGDATABASE || Object.values(config).some((value) => /[\0\r\n]/.test(value))) throw new Error();
    if (![config.PGUSER, config.PGDATABASE].every((value) => /^[a-zA-Z_][a-zA-Z_0-9-]{0,62}$/.test(value))) throw new Error();
    return config;
  } catch {
    // URL parser errors include their input. Never propagate them.
    throw new Error('専用環境ファイルの直接接続URLとSSL設定を確認してください（pooler接続は使えません）。');
  }
}

async function loadConfig(envFile) {
  try {
    return connectionConfig(parseEnv(await fs.readFile(envFile, 'utf8')));
  } catch (error) {
    if (error.code) throw new Error('クラウド接続用の環境ファイルを読み込めません。');
    throw error;
  }
}

function createCloudRunner(config, docker = runDocker) {
  const flags = Object.keys(config).flatMap((key) => ['--env', key]);
  return (args, options = {}) => docker(['run', '--rm', '-i', ...flags, image, ...args], {
    ...options, env: { ...process.env, ...config },
  });
}

function createRestoreRunner(docker = runDocker) {
  const env = { ...process.env, CLOUD_RESTORE_PASSWORD: randomBytes(32).toString('hex') };
  return (args, options = {}) => docker(['compose', '-f', 'compose.cloud-backup.yaml', ...args], { ...options, env });
}

function validateCloudRestoreName(database) {
  validateRestoreName(database, localConfig.POSTGRES_DB);
  if (!database.startsWith('deliveryflow_restore_cloud_')) throw new Error('クラウド復元先は deliveryflow_restore_cloud_ で始まる新しいDB名にしてください。');
  return database;
}

async function backupCloud(config, run, directory = archiveDirectory) {
  const version = Number(await run(['psql', ...psqlArguments, '--command=SHOW server_version_num;']));
  if (!Number.isInteger(version) || version < 170000 || version >= 190000) throw new Error('このバックアップはPostgreSQL 17・18用です。接続先のバージョンを確認してください。');
  return backupDatabase({ POSTGRES_USER: config.PGUSER, POSTGRES_DB: config.PGDATABASE },
    (args, options) => run(args.slice(3).filter((arg) => !/^(--username=|--dbname=)/.test(arg)), options), directory, 'deliveryflow_cloud');
}

async function restoreCloud(file, run, database = `deliveryflow_restore_cloud_${Date.now()}_${randomUUID().slice(0, 8)}`) {
  validateCloudRestoreName(database);
  // Check the archive before starting a container or creating a DB.
  await validateArchive(file);
  await run(['up', '-d', '--wait', 'db']);
  return restoreDatabase(localConfig, run, file, database);
}

async function snapshot(query) {
  const result = JSON.parse(await query(snapshotSql));
  // pg_sequences does not expose is_called. Keep the exact next-ID state too.
  result.sequences = await Promise.all(result.sequences.map(async ({ name }) => {
    if (!/^[A-Za-z_][A-Za-z_0-9]*$/.test(name)) throw new Error('ID採番の名前を確認してください。');
    const state = JSON.parse(await query(`SELECT json_build_object('value', last_value, 'isCalled', is_called) FROM public."${name}";`));
    return { name, ...state };
  }));
  return result;
}

async function verifyCloudBackup(config, source, local, directory = archiveDirectory) {
  const sourceQuery = (sql) => source(['psql', ...psqlArguments, `--command=${sql}`]);
  const before = await snapshot(sourceQuery);
  const file = await backupCloud(config, source, directory);
  const restored = await restoreCloud(file, local);
  const localQuery = (sql) => local(['exec', '-T', 'db', 'psql', `--username=${localConfig.POSTGRES_USER}`,
    `--dbname=${restored.database}`, ...psqlArguments, `--command=${sql}`]);
  const after = await snapshot(sourceQuery);
  if (!isDeepStrictEqual(before, after)) throw new Error('検証中にクラウドDBが更新されました。バックアップは保持しています。配達操作を止めて検証し直してください。');
  const recovered = await snapshot(localQuery);
  if (!isDeepStrictEqual(before, recovered)) throw new Error('復元したデータが一致しません。バックアップと復元用DBは保持しています。');
  let refused = false;
  try { await restoreCloud(file, local, restored.database); } catch { refused = true; }
  if (!refused || !isDeepStrictEqual(recovered, await snapshot(localQuery))) throw new Error('既存の復元用DBの保護を確認できませんでした。');
  const report = { verifiedAt: new Date().toISOString(), archive: path.basename(file), sha256: await checksum(file),
    database: restored.database, counts: restored.counts, snapshot: recovered };
  await fs.writeFile(`${file}.verification.json`, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return { ...restored, file };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.command === 'stop') {
    await createRestoreRunner()(['stop', 'db']);
    console.log('クラウド復元用のローカルコンテナを停止しました。復元DBとバックアップは保持しています。');
    return;
  }
  if (options.command === 'restore') {
    const result = await restoreCloud(path.resolve(projectRoot, options.file), createRestoreRunner(), options.database);
    console.log(`新しいローカルDBへ復元しました: ${result.database}`);
    console.log(`配達員 ${result.counts.drivers}件 / 完了配達 ${result.counts.deliveries}件 / 加点履歴 ${result.counts.scoreEvents}件`);
    return;
  }
  const config = await loadConfig(path.resolve(projectRoot, options.envFile));
  const source = createCloudRunner(config);
  if (options.command === 'backup') {
    const file = await backupCloud(config, source);
    console.log(`クラウドバックアップを保存しました: data/cloud-backups/${path.basename(file)}`);
  } else {
    const result = await verifyCloudBackup(config, source, createRestoreRunner());
    console.log('クラウドバックアップ・新しいローカルDBへの復元検証が成功しました（全9テーブル・ID採番・認証情報・履歴・ポイントの一致）。');
    console.log(`クラウドバックアップ: data/cloud-backups/${path.basename(result.file)}`);
    console.log(`復元用DB: ${result.database}`);
    console.log(`配達員 ${result.counts.drivers}件 / 完了配達 ${result.counts.deliveries}件 / 加点履歴 ${result.counts.scoreEvents}件`);
  }
}

if (require.main === module) main().catch((error) => {
  console.error(error.code ? '設定ファイル・バックアップ・Dockerの起動状態を確認してください。' : error.message);
  process.exitCode = 1;
});

module.exports = { parseArguments, connectionConfig, loadConfig, createCloudRunner, createRestoreRunner,
  validateCloudRestoreName, backupCloud, restoreCloud, snapshot, verifyCloudBackup };
