const { performance } = require('node:perf_hooks');

const target = new URL(process.env.LOAD_TEST_URL || 'http://127.0.0.1:3000/healthz');
const requests = Number(process.env.LOAD_TEST_REQUESTS || 100);
const concurrency = Number(process.env.LOAD_TEST_CONCURRENCY || 10);

if (!['127.0.0.1', 'localhost', '::1'].includes(target.hostname)) {
  throw new Error('LOAD_TEST_URL は localhost / 127.0.0.1 / ::1 だけを指定できます');
}
if (!Number.isInteger(requests) || requests <= 0 || !Number.isInteger(concurrency) || concurrency <= 0) {
  throw new Error('LOAD_TEST_REQUESTS と LOAD_TEST_CONCURRENCY は正の整数で指定してください');
}

async function sendRequest() {
  const startedAt = performance.now();
  try {
    const response = await fetch(target);
    await response.arrayBuffer();
    return { ok: response.ok, status: response.status, milliseconds: performance.now() - startedAt };
  } catch (error) {
    return { ok: false, status: 'NETWORK_ERROR', milliseconds: performance.now() - startedAt, error: error.message };
  }
}

async function main() {
  console.log(`負荷試験開始: ${target.href}（${requests}件、同時${concurrency}件）`);
  const results = [];
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, requests) }, async () => {
    while (next < requests) {
      next += 1;
      results.push(await sendRequest());
    }
  });
  const startedAt = performance.now();
  await Promise.all(workers);
  const elapsedMilliseconds = performance.now() - startedAt;
  const successful = results.filter((result) => result.ok);
  const failed = results.filter((result) => !result.ok);
  const maximum = Math.max(...results.map((result) => result.milliseconds));
  const average = results.reduce((total, result) => total + result.milliseconds, 0) / results.length;

  console.log(JSON.stringify({
    target: target.href,
    requests,
    concurrency,
    successful: successful.length,
    failed: failed.length,
    elapsedMilliseconds: Number(elapsedMilliseconds.toFixed(2)),
    requestsPerSecond: Number((requests / (elapsedMilliseconds / 1000)).toFixed(2)),
    averageResponseMilliseconds: Number(average.toFixed(2)),
    maximumResponseMilliseconds: Number(maximum.toFixed(2)),
    failures: failed.slice(0, 5),
  }, null, 2));
  process.exitCode = failed.length ? 1 : 0;
}

main();
