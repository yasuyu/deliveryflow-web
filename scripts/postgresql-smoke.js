const assert = require('node:assert/strict');

const baseUrl = process.env.BASE_URL || 'http://127.0.0.1:3106';

async function waitForServer() {
  let lastError;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch(baseUrl);
      if (response.ok) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw lastError || new Error('PostgreSQL版アプリを確認できませんでした');
}

async function jsonRequest(pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, options);
  const body = await response.json();
  return { response, body };
}

async function main() {
  await waitForServer();

  const registration = await jsonRequest('/api/drivers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'CI PostgreSQL確認', pin: '246810' }),
  });
  assert.equal(registration.response.status, 201);
  assert.equal(registration.body.driver.accessTokenHash, undefined);
  assert.equal(registration.body.driver.pinHash, undefined);
  assert.match(registration.body.accessToken, /^[A-Za-z0-9_-]{43}$/);

  const dashboard = await jsonRequest('/api/dashboard', {
    headers: { Authorization: `Bearer ${registration.body.accessToken}` },
  });
  assert.equal(dashboard.response.status, 200);
  assert.equal(dashboard.body.driver.id, registration.body.driver.id);

  const logout = await jsonRequest('/api/logout', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${registration.body.accessToken}`,
      'Idempotency-Key': 'ci-postgresql-logout',
    },
  });
  assert.equal(logout.response.status, 200);

  const login = await jsonRequest('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ driverId: registration.body.driver.id, pin: '246810' }),
  });
  assert.equal(login.response.status, 200);
  assert.notEqual(login.body.accessToken, registration.body.accessToken);

  console.log('PostgreSQL smoke test passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
