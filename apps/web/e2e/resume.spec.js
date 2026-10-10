const { test, expect } = require('@playwright/test');
const { DatabaseSync } = require('node:sqlite');
const { finishTestShift } = require('./shift-cleanup');

// Playwright cannot lock a physical phone. Dispatch its visibility/BFCache events;
// use real WebSockets, API changes, and actual browser network disconnection.
async function hidePage(page) {
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
  });
}

async function showPage(page) {
  const refreshed = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/dashboard' && response.status() === 200);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  });
  await refreshed;
}

test('中断から復帰すると状態と接続が戻り、オフライン完了を一度だけ加点する', async ({ page, context, request }) => {
  await page.route('https://tile.openstreetmap.org/**', (route) => route.abort());
  let reviewRequests = 0;
  page.on('request', (outgoing) => {
    if (new URL(outgoing.url()).pathname === '/api/shifts/review') reviewRequests += 1;
  });
  await page.goto('/');
  await page.getByRole('tab', { name: '新規登録' }).click();
  await page.locator('#registrationForm').getByLabel('配達員名').fill('復帰E2E');
  await page.locator('#registrationForm').getByLabel('ログインPIN').fill('123456');
  await page.getByRole('button', { name: '登録して始める' }).click();
  await page.getByRole('button', { name: '稼働を開始する', exact: true }).click();
  await page.getByRole('button', { name: 'オファーを確認する', exact: true }).click();
  const token = await page.evaluate(() => localStorage.getItem('deliveryFlowAccessToken'));
  const headers = { Authorization: `Bearer ${token}`, 'Idempotency-Key': 'resume-pickup' };
  const offered = await request.get('/api/dashboard', { headers });
  const offer = (await offered.json()).offer;
  await page.getByRole('button', { name: 'この配達を受諾する', exact: true }).click();
  const assigned = await request.get('/api/dashboard', { headers });
  const { assignment } = await assigned.json();
  await expect(page.locator('#realtimeStatus')).toHaveAttribute('data-status', 'connected');
  await hidePage(page);
  await expect(page.locator('#realtimeStatus')).toBeHidden();
  const pickup = await request.post(`/api/assignments/${assignment.id}/pickup`, { headers });
  expect(pickup.ok()).toBe(true);
  // A read already in flight may finish while hidden; assert the resumed state
  // after showPage has confirmed a fresh dashboard response.
  await showPage(page);
  await expect(page.locator('#actionGuidance')).toHaveText('配達先へ向かってください');
  await expect(page.locator('#realtimeStatus')).toHaveAttribute('data-status', 'connected');
  await expect(page.locator('#driverStatus')).toBeInViewport({ ratio: 0.999 });

  await context.setOffline(true);
  await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(false);
  await page.getByRole('button', { name: '配達完了しました', exact: true }).click();
  await expect(page.locator('#offlineQueueStatus')).toContainText('接続後に自動送信します');
  const queuedKeys = await page.evaluate(() => {
    const key = Object.keys(localStorage).find((name) => name.startsWith('deliveryFlowOfflineActionsV1:'));
    return key ? JSON.parse(localStorage.getItem(key)).map((entry) => entry.idempotencyKey) : [];
  });
  expect(queuedKeys).toHaveLength(1);
  await hidePage(page);
  await context.setOffline(false);
  await showPage(page);
  await expect(page.locator('#offlineQueueStatus')).toBeHidden();
  await expect(page.locator('#driverStatus')).toHaveAttribute('data-status', 'IDLE');
  await expect(page.locator('#mapLifetimeScore')).toHaveText(String(offer.estimatedPoints));
  const history = await request.get('/api/deliveries/history', { headers });
  const historyBody = await history.json();
  expect(historyBody.deliveries).toHaveLength(1);
  expect(historyBody.deliveries[0].scoreEvent.points).toBe(offer.estimatedPoints);
  const dashboard = await request.get('/api/dashboard', { headers });
  const driverId = (await dashboard.json()).driver.id;
  const database = new DatabaseSync(process.env.E2E_DATABASE_PATH);
  try {
    const storedKey = database.prepare('SELECT key FROM "IdempotencyKey" WHERE "driverId" = ? AND endpoint = ?').get(driverId, `/api/assignments/${assignment.id}/complete`);
    expect(storedKey.key).toBe(queuedKeys[0]);
    expect(database.prepare('SELECT count(*) AS count FROM "ScoreEvent" WHERE "assignmentId" = ?').get(assignment.id).count).toBe(1);
  } finally {
    database.close();
  }

  // A second foreground transition must not repeat the completed operation.
  await hidePage(page);
  await showPage(page);
  await expect(page.locator('#mapLifetimeScore')).toHaveText(String(offer.estimatedPoints));
  await page.getByRole('button', { name: '退勤する', exact: true }).click();
  await expect(page.locator('#localShiftFeedback')).toContainText('完了した配達は1件');
  await expect(page.locator('#localShiftFeedback')).toContainText(`${offer.estimatedPoints}ポイント`);
  expect(reviewRequests).toBe(0);
  await page.locator('#localShiftFeedback').scrollIntoViewIfNeeded();
  await expect(page.locator('#localShiftFeedback')).toBeInViewport({ ratio: 0.999 });
});

test('中断中に期限切れになったオファーと選択中の画面を復帰時に更新する', async ({ page, request }) => {
  await page.route('https://tile.openstreetmap.org/**', (route) => route.abort());
  const registration = await request.post('/api/drivers', { data: { name: '期限切れ復帰E2E', pin: '123456' } });
  const { driver, accessToken } = await registration.json();
  await page.addInitScript(({ token, id }) => {
    localStorage.setItem('deliveryFlowAccessToken', token);
    localStorage.setItem('deliveryFlowDriverId', String(id));
  }, { token: accessToken, id: driver.id });
  await page.goto('/');
  await page.getByRole('button', { name: '稼働を開始する', exact: true }).click();
  await page.getByRole('button', { name: 'オファーを確認する', exact: true }).click();
  await expect(page.locator('#driverStatus')).toHaveAttribute('data-status', 'OFFERED');
  await page.locator('.ride-menu').click();
  await hidePage(page);
  const database = new DatabaseSync(process.env.E2E_DATABASE_PATH);
  try {
    database.prepare('UPDATE "Offer" SET "expiresAt" = ? WHERE "driverId" = ? AND status = \'PENDING\'').run(Date.now() - 1000, driver.id);
  } finally {
    database.close();
  }
  await showPage(page);
  await expect(page.locator('#driverStatus')).toHaveAttribute('data-status', 'IDLE');
  await expect(page.locator('#bottomSheet')).toHaveAttribute('data-sheet-view', 'settings');
  await expect(page.locator('#bottomSheet')).toHaveAttribute('data-sheet-state', 'expanded');
  await page.getByRole('button', { name: '配達画面に戻る', exact: true }).click();
  await expect(page.getByRole('button', { name: 'この配達を受諾する', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'オファーを確認する', exact: true })).toBeEnabled();
  await finishTestShift(page, request);
});
