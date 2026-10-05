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

  const headers = { Authorization: `Bearer ${registration.body.accessToken}` };
  const post = (pathname, key) => jsonRequest(pathname, {
    method: 'POST', headers: { ...headers, 'Idempotency-Key': key },
  });
  assert.equal((await post('/api/shifts/start', 'pg-elevation-start')).response.status, 200);
  assert.equal((await jsonRequest('/api/drivers/me/location', {
    method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: 'DEMO' }),
  })).response.status, 200);
  const offer = await post('/api/offers/current', 'pg-elevation-offer');
  assert.equal(offer.response.status, 200);
  const offered = await jsonRequest('/api/dashboard', { headers });
  const expectedAcceptanceSeconds = Number(process.env.EXPECTED_OFFER_TTL_SECONDS || '30');
  assert.equal(offer.body.acceptanceSeconds, expectedAcceptanceSeconds, 'Offer acceptance period does not match the expected configuration');
  assert.equal(offered.body.offer.acceptanceSeconds, expectedAcceptanceSeconds);
  assert.equal(offered.body.offer.elevationProfile.status, 'AVAILABLE');
  assert.equal(offered.body.offer.elevationProfile.stage, 'VIA_PICKUP');
  assert.ok(offered.body.offer.elevationProfile.points.length <= 200);
  const acceptResponses = await Promise.all([
    post(`/api/offers/${offer.body.id}/accept`, 'pg-elevation-accept'),
    post(`/api/offers/${offer.body.id}/accept`, 'pg-elevation-accept'),
  ]);
  const accepted = acceptResponses[0];
  assert.equal(accepted.response.status, 200);
  assert.equal(acceptResponses[1].response.status, 200);
  assert.deepEqual(accepted.body, acceptResponses[1].body);
  const assignmentId = accepted.body.assignment.id;
  assert.equal((await post(`/api/assignments/${assignmentId}/pickup`, 'pg-elevation-pickup')).response.status, 200);
  const pickedUp = await jsonRequest('/api/dashboard', { headers });
  assert.equal(pickedUp.body.assignment.elevationProfile.status, 'AVAILABLE');
  assert.equal(pickedUp.body.assignment.elevationProfile.stage, 'TO_DROPOFF');
  assert.equal(pickedUp.body.assignment.estimatedPoints, offer.body.estimatedPoints);
  const completeResponses = await Promise.all([
    post(`/api/assignments/${assignmentId}/complete`, 'pg-elevation-complete'),
    post(`/api/assignments/${assignmentId}/complete`, 'pg-elevation-complete'),
  ]);
  assert.equal(completeResponses[0].response.status, 200);
  assert.equal(completeResponses[1].response.status, 200);
  assert.deepEqual(completeResponses[0].body, completeResponses[1].body);
  assert.equal(completeResponses[0].body.driver.score, offer.body.estimatedPoints);
  const completedIds = [assignmentId];
  for (let i = 0; i < 20; i += 1) {
    const nextOffer = await post('/api/offers/current', `pg-history-offer-${i}`);
    assert.equal(nextOffer.response.status, 200);
    const nextAccepted = await post(`/api/offers/${nextOffer.body.id}/accept`, `pg-history-accept-${i}`);
    assert.equal(nextAccepted.response.status, 200);
    const id = nextAccepted.body.assignment.id;
    assert.equal((await post(`/api/assignments/${id}/pickup`, `pg-history-pickup-${i}`)).response.status, 200);
    assert.equal((await post(`/api/assignments/${id}/complete`, `pg-history-complete-${i}`)).response.status, 200);
    completedIds.push(id);
  }
  const history = await jsonRequest('/api/deliveries/history', { headers });
  assert.equal(history.response.status, 200);
  assert.equal(history.body.summary.filteredDeliveries, 21);
  assert.equal(history.body.deliveries.length, 20);
  assert.equal(history.body.pagination.hasMore, true);
  const older = await jsonRequest(`/api/deliveries/history?cursor=${history.body.pagination.nextCursor}`, { headers });
  assert.equal(older.response.status, 200);
  assert.equal(older.body.deliveries.length, 1);
  assert.deepEqual(older.body.pagination, { pageSize: 20, hasMore: false, nextCursor: null });
  assert.deepEqual([...history.body.deliveries, ...older.body.deliveries].map((item) => item.id), [...completedIds].reverse());
  assert.equal(older.body.deliveries[0].scoreEvent.points, offer.body.estimatedPoints);
  assert.deepEqual(older.body.deliveries[0].scoreEvent.breakdown, offer.body.scoreBreakdown);
  const endedShift = await post('/api/shifts/end', 'pg-elevation-end');
  assert.equal(endedShift.response.status, 200);
  // Opt in only in isolated CI/test stacks, never incur an unintended paid API call.
  if (process.env.EXPECTED_AI_REVIEW_STATUS) {
    const review = () => jsonRequest('/api/shifts/review', {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ shiftEndKey: 'pg-elevation-end', pointsEarned: 999999 }),
    });
    const results = await Promise.all([review(), review()]);
    assert.equal(results.every((result) => result.response.status === 200), true);
    const result = results.find((item) => item.body.status === process.env.EXPECTED_AI_REVIEW_STATUS);
    assert.ok(result, 'AI review did not have the expected status');
    assert.deepEqual((await review()).body, result.body);
    if (process.env.EXPECTED_AI_REVIEW_STATUS === 'AVAILABLE') {
      assert.match(result.body.feedback, new RegExp(`配達21件、${endedShift.body.shiftSummary.pointsEarned}ポイント`));
      assert.match(result.body.feedback, /テスト呼出1/);
    }
    assert.deepEqual((await post('/api/shifts/end', 'pg-elevation-end')).body, endedShift.body);
  }

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

  for (const alternative of ['end', 'reject']) {
    const raceDriver = await jsonRequest('/api/drivers', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'CI PostgreSQL同時操作確認', pin: '246810' }),
    });
    assert.equal(raceDriver.response.status, 201);
    const raceHeaders = { Authorization: `Bearer ${raceDriver.body.accessToken}` };
    const racePost = (pathname, key) => jsonRequest(pathname, {
      method: 'POST', headers: { ...raceHeaders, 'Idempotency-Key': `pg-race-${alternative}-${key}` },
    });
    assert.equal((await racePost('/api/shifts/start', 'start')).response.status, 200);
    assert.equal((await jsonRequest('/api/drivers/me/location', {
      method: 'PUT', headers: { ...raceHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'DEMO' }),
    })).response.status, 200);
    const raceOffer = await racePost('/api/offers/current', 'offer');
    assert.equal(raceOffer.response.status, 200);
    const results = await Promise.all([
      racePost(`/api/offers/${raceOffer.body.id}/accept`, 'accept'),
      racePost(alternative === 'end' ? '/api/shifts/end' : `/api/offers/${raceOffer.body.id}/reject`, 'alternative'),
    ]);
    assert.deepEqual(results.map((result) => result.response.status).sort(), [200, 409]);
    const latest = await jsonRequest('/api/dashboard', { headers: raceHeaders });
    assert.equal(latest.response.status, 200);
    if (latest.body.assignment) {
      assert.equal(latest.body.driver.status, 'BUSY');
      const id = latest.body.assignment.id;
      assert.equal((await racePost(`/api/assignments/${id}/pickup`, 'pickup')).response.status, 200);
      assert.equal((await racePost(`/api/assignments/${id}/complete`, 'complete')).response.status, 200);
    }
    if (latest.body.driver.status !== 'OFFLINE') assert.equal((await racePost('/api/shifts/end', 'end')).response.status, 200);
  }

  console.log('PostgreSQL smoke test passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
