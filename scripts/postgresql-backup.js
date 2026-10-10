const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pipeline } = require('node:stream/promises');
const { createHash, randomUUID } = require('node:crypto');
const { parseEnv } = require('node:util');

const projectRoot = path.resolve(__dirname, '..');

function parseArguments(args) {
  const [command, ...rest] = args;
  if (!['backup', 'restore'].includes(command)) throw new Error('backup または restore を指定してください。');
  const options = { command, envFile: '.env.postgres' };
  const names = { '--env-file': 'envFile', '--file': 'file', '--database': 'database' };
  for (let index = 0; index < rest.length; index += 2) {
    const name = names[rest[index]];
    const value = rest[index + 1];
    if (!name || !value || value.startsWith('--') || (name !== 'envFile' && command !== 'restore')) {
      throw new Error('引数を確認してください。復元には --file、任意で --database を指定します。');
    }
    if (Object.hasOwn(options, name) && name !== 'envFile') throw new Error('同じ引数は1回だけ指定してください。');
    options[name] = value;
  }
  if (command === 'restore' && !options.file) throw new Error('復元するバックアップを --file で指定してください。');
  return options;
}

function validateRestoreName(name, sourceDatabase) {
  if (!/^deliveryflow_restore_[a-z0-9_]+$/.test(name) || name.length > 63 || name === sourceDatabase) {
    throw new Error('復元先は元DBと異なる deliveryflow_restore_ で始まる新しいDB名にしてください（英小文字・数字・_、63文字以内）。');
  }
  return name;
}

function resolveDocker() {
  if (process.env.DOCKER_BIN) return process.env.DOCKER_BIN;
  if (process.platform === 'win32') {
    const candidates = (process.env.PATH || '').split(path.delimiter).map((directory) => path.join(directory, 'docker.exe'));
    candidates.push(path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Docker', 'Docker', 'resources', 'bin', 'docker.exe'));
    const installed = candidates.find((candidate) => fs.existsSync(candidate));
    if (installed) return installed;
  }
  return 'docker';
}

function createDockerRunner(envFile) {
  return (args, options) => runDocker(['compose', '--env-file', envFile, ...args], options);
}

async function runDocker(args, { inputFile, outputFile, inputText, env = process.env } = {}) {
  const child = spawn(resolveDocker(), args, {
    cwd: projectRoot, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const result = new Promise((resolve, reject) => {
    child.once('error', () => reject(new Error('Dockerを起動できません。Docker DesktopとPATHを確認してください。')));
    child.stdin.once('error', () => reject(new Error('Dockerへの入力を送信できませんでした。')));
    child.once('close', (code) => code === 0 ? resolve() : reject(new Error('PostgreSQLの処理に失敗しました。DBの起動状態、復元先DBの重複、バックアップを確認してください。')));
  });
  // Provider diagnostics can include local paths or configuration. Do not echo them.
  child.stderr.resume();
  let stdout = '';
  const tasks = [result];
  if (outputFile) tasks.push(pipeline(child.stdout, fs.createWriteStream(outputFile, { flags: 'wx', mode: 0o600 })));
  else tasks.push((async () => {
    for await (const chunk of child.stdout) {
      stdout += chunk.toString('utf8');
      if (stdout.length > 1_000_000) throw new Error('PostgreSQLの出力が上限を超えました。');
    }
  })());
  if (inputFile) tasks.push(pipeline(fs.createReadStream(inputFile), child.stdin));
  else child.stdin.end(inputText);
  try {
    await Promise.all(tasks);
    return stdout.trim();
  } catch (error) {
    child.kill();
    await Promise.allSettled(tasks);
    // Stream errors must not expose filenames or environment values either.
    if (error.code) throw new Error('バックアップファイルまたはDockerとの通信を確認してください。');
    throw error;
  }
}

async function checksum(file) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function validateArchive(file, { checkDigest = true } = {}) {
  const handle = await fsp.open(file, 'r');
  try {
    const signature = Buffer.alloc(5);
    const { bytesRead } = await handle.read(signature, 0, 5, 0);
    if (bytesRead !== 5 || signature.toString('ascii') !== 'PGDMP') throw new Error('PostgreSQLのカスタム形式バックアップではありません。');
  } finally {
    await handle.close();
  }
  if (checkDigest) {
    const expected = (await fsp.readFile(`${file}.sha256`, 'utf8')).trim();
    if (!/^[a-f0-9]{64}$/.test(expected) || expected !== await checksum(file)) {
      throw new Error('バックアップのチェックサムが一致しません。復元は実行していません。');
    }
  }
}

function databaseCommand(config, tool, args) {
  return ['exec', '-T', 'db', tool, `--username=${config.POSTGRES_USER}`, ...args];
}

async function backupDatabase(config, run, outputDirectory = path.join(projectRoot, 'data', 'backups'), prefix = 'deliveryflow') {
  if (!/^[a-z_]+$/.test(prefix)) throw new Error('バックアップ名の設定を確認してください。');
  await fsp.mkdir(outputDirectory, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:.]/g, '');
  const file = path.join(outputDirectory, `${prefix}_${stamp}_${randomUUID().slice(0, 8)}.dump`);
  const partial = `${file}.partial`;
  await run(databaseCommand(config, 'pg_dump', [`--dbname=${config.POSTGRES_DB}`, '--format=custom']), { outputFile: partial });
  await validateArchive(partial, { checkDigest: false });
  await run(['exec', '-T', 'db', 'pg_restore', '--list'], { inputFile: partial });
  const digest = await checksum(partial);
  // COPYFILE_EXCL prevents overwriting an existing archive, including on Windows.
  await fsp.copyFile(partial, file, fs.constants.COPYFILE_EXCL);
  await fsp.writeFile(`${file}.sha256`, `${digest}\n`, { flag: 'wx', mode: 0o600 });
  await fsp.unlink(partial);
  return file;
}

async function restoreDatabase(config, run, file, database = `deliveryflow_restore_${Date.now()}_${randomUUID().slice(0, 8)}`) {
  validateRestoreName(database, config.POSTGRES_DB);
  await validateArchive(file);
  await run(['exec', '-T', 'db', 'pg_restore', '--list'], { inputFile: file });
  // createdb fails if the name exists. Never use --clean, --create, or DROP.
  await run(databaseCommand(config, 'createdb', ['--maintenance-db=postgres', '--template=template0', database]));
  await run(databaseCommand(config, 'pg_restore', [
    `--dbname=${database}`, '--no-owner', '--no-privileges', '--exit-on-error', '--single-transaction',
  ]), { inputFile: file });
  const counts = await run(databaseCommand(config, 'psql', [
    `--dbname=${database}`, '--no-psqlrc', '--tuples-only', '--no-align', '--set=ON_ERROR_STOP=1',
    '--command=SELECT json_build_object(\'drivers\', (SELECT count(*) FROM "Driver"), \'deliveries\', (SELECT count(*) FROM "Assignment" WHERE "deliveredAt" IS NOT NULL), \'scoreEvents\', (SELECT count(*) FROM "ScoreEvent"));',
  ]));
  return { database, counts: JSON.parse(counts) };
}

async function loadConfig(envFile) {
  const config = parseEnv(await fsp.readFile(envFile, 'utf8'));
  for (const key of ['POSTGRES_DB', 'POSTGRES_USER']) {
    if (!/^[a-zA-Z0-9_][a-zA-Z0-9_-]{0,62}$/.test(config[key] || '')) throw new Error(`${key}の設定を確認してください。`);
  }
  return config;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const envFile = path.resolve(projectRoot, options.envFile);
  const config = await loadConfig(envFile);
  const run = createDockerRunner(envFile);
  if (options.command === 'backup') {
    const file = await backupDatabase(config, run);
    console.log(`バックアップを保存しました: data/backups/${path.basename(file)}`);
  } else {
    const result = await restoreDatabase(config, run, path.resolve(projectRoot, options.file), options.database);
    console.log(`新しい復元用DBへ復元しました: ${result.database}`);
    console.log(`配達員 ${result.counts.drivers}件 / 完了配達 ${result.counts.deliveries}件 / 加点履歴 ${result.counts.scoreEvents}件`);
  }
}

if (require.main === module) main().catch((error) => {
  console.error(error.code ? '設定ファイルとバックアップファイルを確認してください。' : error.message);
  process.exitCode = 1;
});

module.exports = { parseArguments, validateRestoreName, validateArchive, checksum, backupDatabase, restoreDatabase, createDockerRunner, loadConfig, runDocker };
