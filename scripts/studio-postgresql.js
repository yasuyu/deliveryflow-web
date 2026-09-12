const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..');
const envPath = path.join(projectRoot, '.env.postgres');

function parseEnv(text) {
  const values = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

if (!fs.existsSync(envPath)) {
  throw new Error('.env.postgres がありません。.env.postgres.example から作成してください');
}

const config = parseEnv(fs.readFileSync(envPath, 'utf8'));
for (const name of ['POSTGRES_DB', 'POSTGRES_USER', 'POSTGRES_PASSWORD']) {
  if (!config[name]) throw new Error(`.env.postgres に ${name} を設定してください`);
}
const hostPort = Number(config.POSTGRES_HOST_PORT || 5433);
if (!Number.isInteger(hostPort) || hostPort <= 0 || hostPort > 65535) {
  throw new Error('POSTGRES_HOST_PORT は1〜65535の整数で指定してください');
}

const databaseUrl = new URL(`postgresql://127.0.0.1:${hostPort}/${config.POSTGRES_DB}`);
databaseUrl.username = config.POSTGRES_USER;
databaseUrl.password = config.POSTGRES_PASSWORD;
databaseUrl.searchParams.set('schema', 'public');
databaseUrl.searchParams.set('sslmode', 'disable');

console.log(`Prisma Studioを起動します: PostgreSQL 127.0.0.1:${hostPort}`);
const studio = spawn(process.execPath, [
  'node_modules/prisma/build/index.js',
  'studio',
  '--hostname', '127.0.0.1',
  '--port', '5555',
  '--browser', 'none',
], {
  cwd: projectRoot,
  env: {
    ...process.env,
    DATABASE_PROVIDER: 'postgresql',
    DATABASE_URL: databaseUrl.toString(),
  },
  stdio: 'inherit',
});

studio.on('error', (error) => {
  console.error(`Prisma Studioを起動できません: ${error.message}`);
  process.exitCode = 1;
});
studio.on('exit', (code, signal) => {
  if (signal) console.log(`Prisma Studioを終了しました (${signal})`);
  process.exitCode = code ?? 0;
});
