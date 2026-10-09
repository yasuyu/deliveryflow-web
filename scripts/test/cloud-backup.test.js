const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { checksum, runDocker } = require('../postgresql-backup');
const { parseArguments, connectionConfig, createCloudRunner, createRestoreRunner, restoreCloud,
  backupCloud, verifyCloudBackup, snapshot } = require('../cloud-backup');

const url = 'postgresql://backup_user:fake%40password@ep-example.neon.tech/neondb?sslmode=require&channel_binding=require&schema=public';
const config = connectionConfig({ DATABASE_URL_UNPOOLED: url });

async function temporary(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'deliveryflow-cloud-backup-test-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('deliveryflow-cloud-backup-test-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  return directory;
}

test('直接接続を優先し、SSL無効・pooler・不正URLを秘密情報を表示せず拒否する', () => {
  assert.equal(connectionConfig({ DATABASE_URL_UNPOOLED: url, DATABASE_URL: url.replace('ep-example', 'ep-example-pooler') }).PGHOST, config.PGHOST);
  assert.equal(connectionConfig({ DIRECT_URL: url }).PGPASSWORD, 'fake@password');
  assert.equal(connectionConfig({ DATABASE_URL: url }).PGOPTIONS, '-c default_transaction_read_only=on');
  for (const invalid of [undefined, 'fake-secret', url.replace('ep-example', 'ep-example-pooler'),
    url.replace('sslmode=require', 'sslmode=disable'), url.replace('/neondb?', '/postgresql%3A%2F%2Fbad?'),
    url.replace('fake%40password', '%0Asecret'), url.replace('postgresql:', 'https:')]) {
    assert.throws(() => connectionConfig({ DATABASE_URL: invalid }), (error) => {
      assert.match(error.message, /直接接続URL/);
      assert.ok(!error.message.includes('fake') && !error.message.includes('ep-example'));
      return true;
    });
  }
});

test('クラウド復元に接続先変更・上書き・削除用の引数を受け付けない', () => {
  assert.equal(parseArguments(['backup']).envFile, '.env.neon.local');
  assert.equal(parseArguments(['restore', '--file', 'a.dump']).command, 'restore');
  for (const args of [['restore'], ['restore', '--file', 'a', '--env-file', '.env.neon.local'],
    ['restore', '--file', 'a', '--database', 'deliveryflow'], ['restore', '--file', 'a', '--clean', 'true'],
    ['backup', '--env-file', 'a', '--env-file', 'b'], ['verify', '--database', 'neondb']]) {
    assert.throws(() => parseArguments(args));
  }
});

test('パスワード・接続URLはDockerの引数へ渡さず、復元用コンテナにクラウド認証情報を渡さない', async () => {
  let call;
  const docker = async (args, options) => { call = { args, options }; return ''; };
  await createCloudRunner(config, docker)(['pg_dump', '--format=custom']);
  assert.ok(!call.args.join(' ').includes('fake') && !call.args.join(' ').includes('neon.tech'));
  assert.equal(call.options.env.PGPASSWORD, config.PGPASSWORD);
  assert.equal(call.options.env.PGSSLMODE, 'require');
  assert.equal(call.options.env.PGOPTIONS, '-c default_transaction_read_only=on');
  await createRestoreRunner(docker)(['up', '-d', '--wait', 'db']);
  assert.deepEqual(call.args.slice(0, 3), ['compose', '-f', 'compose.cloud-backup.yaml']);
  assert.ok(!call.args.includes('--env-file'));
  assert.notEqual(call.options.env.CLOUD_RESTORE_PASSWORD, config.PGPASSWORD);
});

test('破損・不一致のクラウドバックアップはコンテナ起動前に拒否する', async (t) => {
  const file = path.join(await temporary(t), 'invalid.dump');
  let calls = 0;
  const run = async () => { calls += 1; };
  await fs.writeFile(file, 'not a dump');
  await assert.rejects(restoreCloud(file, run), /カスタム形式/);
  await fs.writeFile(file, 'PGDMPtest');
  await fs.writeFile(`${file}.sha256`, '0'.repeat(64));
  await assert.rejects(restoreCloud(file, run), /チェックサム/);
  assert.equal(calls, 0);
});

test('既存の復元DBを拒否し、部分復元や削除を実行しない', async (t) => {
  const file = path.join(await temporary(t), 'check.dump');
  await fs.writeFile(file, 'PGDMPtest');
  await fs.writeFile(`${file}.sha256`, await checksum(file));
  const tools = [];
  const run = async (args) => {
    tools.push(args[0] === 'up' ? 'up' : args[3]);
    if (args[3] === 'createdb') throw new Error('existing');
  };
  await assert.rejects(restoreCloud(file, run, 'deliveryflow_restore_cloud_existing'), /existing/);
  assert.deepEqual(tools, ['up', 'pg_restore', 'createdb']);
});

test('途中失敗は完成扱いにせず、バージョン不適合ではdumpを開始しない', async (t) => {
  const directory = await temporary(t);
  const run = async (args, options) => {
    if (args[0] === 'psql') return '180006';
    await fs.writeFile(options.outputFile, 'PGDMPpartial');
    throw new Error('failed');
  };
  await assert.rejects(backupCloud(config, run, directory), /failed/);
  assert.ok((await fs.readdir(directory)).every((name) => name.endsWith('.partial')));
  let calls = 0;
  await assert.rejects(backupCloud(config, async () => { calls += 1; return '190001'; }, directory), /バージョン/);
  assert.equal(calls, 1);
});

test('ID採番の未使用状態も比較に含め、不正な識別子ではSQLを実行しない', async () => {
  const result = await snapshot(async (sql) => sql.includes('pg_sequences')
    ? JSON.stringify({ sequences: [{ name: 'Driver_id_seq', value: null }] }) : JSON.stringify({ value: 1, isCalled: false }));
  assert.deepEqual(result.sequences, [{ name: 'Driver_id_seq', value: 1, isCalled: false }]);
  let calls = 0;
  await assert.rejects(snapshot(async () => { calls += 1; return JSON.stringify({ sequences: [{ name: 'bad";DROP' }] }); }), /名前/);
  assert.equal(calls, 1);
});

function fakeVerification(sourceChanged = false, restoreMismatch = false) {
  const original = { Driver: { count: 2, digest: 'abc' }, sequences: [] };
  let snapshotReads = 0;
  let created = false;
  const source = async (args, options) => {
    if (args[0] === 'pg_dump') { await fs.writeFile(options.outputFile, 'PGDMPtest'); return ''; }
    if (args[0] === 'pg_restore') return '';
    if (args.at(-1).includes('server_version_num')) return '180006';
    snapshotReads += 1;
    return JSON.stringify(sourceChanged && snapshotReads > 1 ? { ...original, Driver: { count: 3 } } : original);
  };
  const local = async (args) => {
    if (args[3] === 'createdb') { if (created) throw new Error('existing'); created = true; }
    if (args[3] === 'psql') return JSON.stringify(args.at(-1).includes('pg_sequences')
      ? restoreMismatch ? { ...original, Driver: { count: 1 } } : original
      : { drivers: 2, deliveries: 3, scoreEvents: 3 });
    return '';
  };
  return { source, local };
}

test('更新中・復元不一致では検証成功の記録を作らず、バックアップを保持する', async (t) => {
  for (const [changed, mismatch, message] of [[true, false, /更新/], [false, true, /一致/]]) {
    const directory = await temporary(t);
    const { source, local } = fakeVerification(changed, mismatch);
    await assert.rejects(verifyCloudBackup(config, source, local, directory), message);
    const files = await fs.readdir(directory);
    assert.equal(files.filter((name) => name.endsWith('.dump')).length, 1);
    assert.ok(!files.some((name) => name.endsWith('.verification.json')));
  }
});

test('照合・上書き拒否が成功したバックアップにだけ、秘密情報なしの検証記録を追加する', async (t) => {
  const directory = await temporary(t);
  const { source, local } = fakeVerification();
  const result = await verifyCloudBackup(config, source, local, directory);
  const report = await fs.readFile(`${result.file}.verification.json`, 'utf8');
  assert.equal(JSON.parse(report).sha256, await checksum(result.file));
  assert.ok(!report.includes('fake') && !report.includes('neon.tech'));
  assert.match(path.basename(result.file), /^deliveryflow_cloud_/);
});

test('Docker起動・ツール失敗の出力に含まれる秘密情報やパスをエラーへ載せない', async () => {
  const original = process.env.DOCKER_BIN;
  try {
    process.env.DOCKER_BIN = process.execPath;
    await assert.rejects(runDocker(['-e', 'console.error("fixture-secret-path");process.exit(1)']), (error) => {
      assert.ok(!error.message.includes('fixture-secret-path'));
      assert.match(error.message, /失敗|送信/);
      return true;
    });
    process.env.DOCKER_BIN = path.join(os.tmpdir(), 'deliveryflow-nonexistent-private-path', 'missing.exe');
    await assert.rejects(runDocker(['version'], { inputText: 'fixture-secret' }), (error) => {
      assert.ok(!error.message.includes('private-path') && !error.message.includes('fixture-secret'));
      return true;
    });
  } finally {
    if (original === undefined) delete process.env.DOCKER_BIN;
    else process.env.DOCKER_BIN = original;
  }
});
