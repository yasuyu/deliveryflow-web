const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const net = require('node:net');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const projectRoot = path.resolve(__dirname, '..');
const children = new Set();
let interrupted = false;

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    interrupted = true;
    for (const child of children) child.kill();
  });
}

function start(script, args, env, stdio = 'inherit') {
  if (interrupted) throw new Error('E2E run interrupted');
  const child = spawn(process.execPath, [script, ...args], { cwd: projectRoot, env, stdio });
  children.add(child);
  child.once('exit', () => children.delete(child));
  return child;
}

async function run(script, args, env) {
  const [code, signal] = await once(start(script, args, env), 'exit');
  if (code !== 0) throw new Error(`${path.basename(script)} exited with ${signal || code}`);
}

async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const { port } = probe.address();
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function createDatabase(databasePath) {
  const database = new DatabaseSync(databasePath);
  try {
    const migrations = path.join(projectRoot, 'prisma/migrations');
    const directories = (await fs.readdir(migrations, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
    for (const directory of directories) {
      const entry = path.join(migrations, directory, 'migration.sql');
      database.exec(await fs.readFile(entry, 'utf8'));
    }
  } finally {
    database.close();
  }
}

async function waitForServer(server, url, getStartupError) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (getStartupError()) throw getStartupError();
    if (interrupted || server.exitCode !== null || server.signalCode !== null) {
      throw new Error('E2E server exited before becoming ready');
    }
    try {
      const response = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(500) });
      if (response.ok) return;
    } catch {
      // The server is still applying seed data or opening its listener.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('E2E server did not become ready');
}

async function main() {
  const dataDirectory = path.join(projectRoot, 'data');
  await fs.mkdir(dataDirectory, { recursive: true });
  const directory = await fs.mkdtemp(path.join(dataDirectory, 'e2e-'));
  let server;
  try {
    const port = await freePort();
    const env = {
      ...process.env,
      DATABASE_PROVIDER: 'sqlite',
      DATABASE_URL: `file:../data/${path.basename(directory)}/delivery.db`,
      PORT: String(port),
      OFFER_TTL_SECONDS: '30',
      OFFER_CANDIDATE_LIMIT: '3',
      SCORE_BONUS_SIMULATED_NOW: '2026-09-14T12:00:00+09:00',
      DEMO_RANKING_SEED: 'false',
      E2E_BASE_URL: `http://127.0.0.1:${port}`,
      E2E_DATABASE_PATH: path.join(directory, 'delivery.db'),
    };
    const prismaCli = path.join(projectRoot, 'node_modules/prisma/build/index.js');
    const clientExists = await fs.access(path.join(projectRoot, 'generated/client-v2/index.js'))
      .then(() => true, () => false);
    if (!clientExists) await run(prismaCli, ['generate'], env);
    await createDatabase(path.join(directory, 'delivery.db'));
    let startupError;
    server = start('apps/server/src/main.js', [], env, ['ignore', 'ignore', 'inherit']);
    server.once('error', (error) => { startupError = error; });
    await waitForServer(server, env.E2E_BASE_URL, () => startupError);
    await run(require.resolve('@playwright/test/cli'), ['test', ...process.argv.slice(2)], env);
  } finally {
    if (server && server.exitCode === null && server.signalCode === null) {
      const exited = once(server, 'exit');
      server.kill();
      await exited;
    }
    if (path.dirname(directory) !== dataDirectory) throw new Error('Unexpected E2E database directory');
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
