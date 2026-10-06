const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { parseArguments, validateRestoreName, restoreDatabase, checksum, backupDatabase } = require('../postgresql-backup');

async function cleanup(directory) {
  const target = path.resolve(directory);
  assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
  assert.ok(path.basename(target).startsWith('deliveryflow-backup-test-'));
  await fs.rm(target, { recursive: true, force: true });
}

test('復元先の普段使うDB・既存DB名・引数混入・長い名前を拒否する', () => {
  for (const name of ['deliveryflow', 'postgres', 'deliveryflow_restore_live', 'deliveryflow_restore_a;DROP', '-x', `deliveryflow_restore_${'a'.repeat(64)}`]) {
    assert.throws(() => validateRestoreName(name, 'deliveryflow_restore_live'));
  }
  assert.equal(validateRestoreName('deliveryflow_restore_check_1', 'deliveryflow'), 'deliveryflow_restore_check_1');
  assert.throws(() => parseArguments(['restore']));
  assert.throws(() => parseArguments(['backup', '--database', 'deliveryflow']));
  assert.throws(() => parseArguments(['restore', '--file', 'a', '--clean', 'true']));
});

test('破損したバックアップではDockerもDB作成も実行しない', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'deliveryflow-backup-test-'));
  const file = path.join(directory, 'check.dump');
  let calls = 0;
  const run = () => { calls += 1; throw new Error('must not run'); };
  try {
    await fs.writeFile(file, 'not a dump');
    await assert.rejects(restoreDatabase({ POSTGRES_DB: 'deliveryflow' }, run, file), /カスタム形式/);
    await fs.writeFile(file, 'PGDMPtest');
    await fs.writeFile(`${file}.sha256`, `${'0'.repeat(64)}\n`);
    await assert.rejects(restoreDatabase({ POSTGRES_DB: 'deliveryflow' }, run, file), /チェックサム/);
    assert.equal(calls, 0);
  } finally {
    await cleanup(directory);
  }
});

test('DB名の重複で作成に失敗した場合は復元・削除を実行しない', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'deliveryflow-backup-test-'));
  const file = path.join(directory, 'check.dump');
  const tools = [];
  try {
    await fs.writeFile(file, 'PGDMPtest');
    await fs.writeFile(`${file}.sha256`, await checksum(file));
    const run = async (args) => {
      tools.push(args[3]);
      if (args[3] === 'createdb') throw new Error('already exists');
      return '';
    };
    await assert.rejects(restoreDatabase({ POSTGRES_DB: 'deliveryflow', POSTGRES_USER: 'deliveryflow' }, run, file, 'deliveryflow_restore_existing'), /already exists/);
    assert.deepEqual(tools, ['pg_restore', 'createdb']);
  } finally {
    await cleanup(directory);
  }
});

test('バックアップ失敗時は完成扱いのdump・チェックサムを作らない', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'deliveryflow-backup-test-'));
  try {
    const run = async (_, { outputFile }) => {
      await fs.writeFile(outputFile, 'PGDMPincomplete');
      throw new Error('dump failed');
    };
    await assert.rejects(backupDatabase({ POSTGRES_DB: 'deliveryflow', POSTGRES_USER: 'deliveryflow' }, run, directory), /dump failed/);
    const files = await fs.readdir(directory);
    assert.equal(files.length, 1);
    assert.ok(files[0].endsWith('.partial'));
  } finally {
    await cleanup(directory);
  }
});
