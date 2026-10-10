const { test, expect } = require('@playwright/test');
const { DatabaseSync } = require('node:sqlite');
const { finishTestShift } = require('./shift-cleanup');

test.beforeEach(async ({ page }) => {
  await page.clock.install();
  await page.route('https://tile.openstreetmap.org/**', (route) => route.abort());
});

async function signIn(page, request) {
  const response = await request.post('/api/drivers', { data: { name: '通信待機E2E', pin: '123456' } });
  const registration = await response.json();
  await page.addInitScript(({ accessToken, driver }) => {
    localStorage.setItem('deliveryFlowAccessToken', accessToken);
    localStorage.setItem('deliveryFlowDriverId', String(driver.id));
  }, registration);
  await page.goto('/');
  await expect(page.locator('#driverStatus')).toHaveAttribute('data-status', 'OFFLINE');
  await expect(page.locator('#mapLifetimeScore')).toHaveText('0');
  return { Authorization: `Bearer ${registration.accessToken}` };
}

test('ログインが止まっても入力を保持して待機を終え、手動でログインし直せる', async ({ page, request }) => {
  const registration = await (await request.post('/api/drivers', { data: { name: '再ログインE2E', pin: '123456' } })).json();
  let heldRoute;
  let attempts = 0;
  await page.route('**/api/login', (route) => { attempts += 1; heldRoute = route; });
  await page.goto('/');
  await page.getByRole('tab', { name: 'ログイン', exact: true }).click();
  await page.locator('#loginForm [name="driverId"]').fill(String(registration.driver.id));
  await page.locator('#loginForm [name="pin"]').fill('123456');
  await page.locator('#loginForm button[type="submit"]').click();
  await expect.poll(() => Boolean(heldRoute)).toBe(true);
  await page.clock.fastForward(30_001);
  await expect(page.locator('#registrationMessage')).toContainText('30秒');
  await expect(page.locator('#registrationMessage')).toContainText('同じ配達員IDとPIN');
  await expect(page.locator('#loginForm button[type="submit"]')).toBeEnabled();
  await expect(page.locator('#loginForm [name="driverId"]')).toHaveValue(String(registration.driver.id));
  await expect(page.locator('#loginForm [name="pin"]')).toHaveValue('123456');
  expect(attempts).toBe(1);
  await heldRoute.abort();
  await page.unroute('**/api/login');
  await page.locator('#loginForm button[type="submit"]').click();
  await expect(page.locator('#driverStatus')).toHaveAttribute('data-status', 'OFFLINE');
});

test('登録が止まっても自動でアカウントを増やさず、入力と操作可能なフォームを残す', async ({ page }) => {
  let attempts = 0;
  let heldRoute;
  await page.route('**/api/drivers', (route) => { attempts += 1; heldRoute = route; });
  await page.goto('/');
  await page.getByRole('tab', { name: '新規登録' }).click();
  await page.locator('#registrationForm [name="name"]').fill('未確認の登録');
  await page.locator('#registrationForm [name="pin"]').fill('123456');
  await page.locator('#registrationForm button[type="submit"]').click();
  await expect.poll(() => Boolean(heldRoute)).toBe(true);
  await page.clock.fastForward(30_001);
  await expect(page.locator('#registrationMessage')).toContainText('完了している可能性');
  await expect(page.locator('#registrationMessage')).toContainText('自動で再登録はしません');
  await expect(page.locator('#registrationForm button[type="submit"]')).toBeEnabled();
  await expect(page.locator('#registrationForm [name="name"]')).toHaveValue('未確認の登録');
  expect(attempts).toBe(1);
  await heldRoute.abort();
});

test('起動時と実績画面の読込停止から再読込できる', async ({ page, request }, testInfo) => {
  // Keep automatic polling out of this test so it exercises the manual button.
  await page.addInitScript(() => Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }));
  let heldRoute;
  await page.route('**/api/dashboard', (route) => { heldRoute = route; });
  const response = await request.post('/api/drivers', { data: { name: '再読込E2E', pin: '123456' } });
  const registration = await response.json();
  await page.addInitScript(({ accessToken, driver }) => {
    localStorage.setItem('deliveryFlowAccessToken', accessToken);
    localStorage.setItem('deliveryFlowDriverId', String(driver.id));
  }, registration);
  await page.goto('/');
  await expect.poll(() => Boolean(heldRoute)).toBe(true);
  await page.clock.fastForward(30_001);
  await expect(page.locator('#registrationMessage')).toContainText('30秒');
  await expect(page.locator('#registrationRetry')).toBeVisible();
  await heldRoute.abort();
  await page.unroute('**/api/dashboard');
  await page.evaluate(() => Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }));
  await page.locator('#registrationRetry').click();
  await expect(page.locator('#driverStatus')).toHaveAttribute('data-status', 'OFFLINE');
  await expect(page.locator('#mapLifetimeScore')).toHaveText('0');
  await page.getByRole('button', { name: 'スコアと配達実績を開く' }).click();
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.route('**/api/drivers/ranking', (route) => { heldRoute = route; });
  heldRoute = null;
  await page.locator('#historyFilterForm button[type="submit"]').click();
  await expect.poll(() => Boolean(heldRoute)).toBe(true);
  await page.clock.fastForward(30_001);
  await expect(page.locator('#connectionNotice')).toBeVisible();
  await expect(page.locator('#connectionMessage')).toContainText('30秒');
  await expect(page.locator('#connectionRetry')).toBeEnabled();
  await page.locator('#connectionRetry').scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('network-retry.png') });
  await heldRoute.abort();
  await page.unroute('**/api/drivers/ranking');
  await page.evaluate(() => Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }));
  await page.locator('#connectionRetry').click();
  await expect(page.locator('#connectionNotice')).toBeHidden();
  await expect(page.locator('#bottomSheet')).toHaveAttribute('data-sheet-view', 'activity');
});

test('保存済みの完了応答が届かなくても同じキーで再送し履歴と加点を一度だけ保存する', async ({ page, request }) => {
  const headers = await signIn(page, request);
  await page.getByRole('button', { name: '稼働を開始する', exact: true }).click();
  await page.getByRole('button', { name: 'オファーを確認する', exact: true }).click();
  await page.getByRole('button', { name: 'この配達を受諾する', exact: true }).click();
  await page.getByRole('button', { name: '受け取りました', exact: true }).click();
  const dashboard = await (await request.get('/api/dashboard', { headers })).json();
  const assignmentId = dashboard.assignment.id;
  const keys = [];
  let committed = false;
  let heldRoute;
  await page.route(`**/api/assignments/${assignmentId}/complete`, async (route) => {
    keys.push(route.request().headers()['idempotency-key']);
    // First automatic replay also loses its connection; the manual replay must
    // still use the original key and the already committed delivery.
    if (keys.length === 2) { await route.abort(); return; }
    const result = await route.fetch();
    expect(result.ok()).toBe(true);
    if (keys.length === 1) { heldRoute = route; committed = true; }
    else await route.fulfill({ response: result });
  });
  await page.getByRole('button', { name: '配達完了しました', exact: true }).click();
  await expect.poll(() => committed).toBe(true);
  await page.clock.fastForward(30_001);
  await expect(page.locator('#offlineQueueStatus')).toBeVisible();
  await expect(page.locator('#offlineQueueStatus [data-queue-action="retry"]')).toBeEnabled();
  await heldRoute.abort();
  await expect.poll(() => keys.length).toBe(2);
  await expect(page.locator('#offlineQueueStatus [data-queue-action="retry"]')).toBeEnabled();
  // A successful read during the retry cooldown must not immediately resend.
  await page.getByRole('button', { name: 'スコアと配達実績を開く' }).click();
  await page.locator('#historyFilterForm button[type="submit"]').click();
  await expect(page.locator('#historyFilterForm button[type="submit"]')).toBeEnabled();
  expect(keys).toHaveLength(2);
  await page.locator('#returnToDelivery').click();
  await page.locator('#offlineQueueStatus [data-queue-action="retry"]').click();
  await expect(page.locator('#offlineQueueStatus')).toBeHidden();
  expect(keys).toHaveLength(3);
  expect(new Set(keys).size).toBe(1);
  const history = await (await request.get('/api/deliveries/history', { headers })).json();
  expect(history.deliveries).toHaveLength(1);
  const database = new DatabaseSync(process.env.E2E_DATABASE_PATH);
  try {
    expect(database.prepare('SELECT count(*) AS count FROM "ScoreEvent" WHERE "assignmentId" = ?').get(assignmentId).count).toBe(1);
    const saved = database.prepare('SELECT key FROM "IdempotencyKey" WHERE "driverId" = ? AND endpoint = ?').get(dashboard.driver.id, `/api/assignments/${assignmentId}/complete`);
    expect(saved.key).toBe(keys[0]);
  } finally { database.close(); }
  await finishTestShift(page, request);
});

test('退勤の応答が届かなくても再確認で同じ勤務サマリーを取得し次の勤務を開始できる', async ({ page, request }) => {
  await signIn(page, request);
  await page.getByRole('button', { name: '稼働を開始する', exact: true }).click();
  let committed = false;
  let heldRoute;
  const keys = [];
  await page.route('**/api/shifts/end', async (route) => {
    keys.push(route.request().headers()['idempotency-key']);
    const result = await route.fetch();
    expect(result.ok()).toBe(true);
    if (keys.length === 1) { heldRoute = route; committed = true; }
    else await route.fulfill({ response: result });
  });
  await page.getByRole('button', { name: '退勤する', exact: true }).click();
  await expect.poll(() => committed).toBe(true);
  await page.clock.fastForward(30_001);
  await expect(page.locator('#requestRetry')).toHaveText('退勤の結果を再確認する');
  await expect(page.locator('#requestRetry')).toBeEnabled();
  await heldRoute.abort();
  await page.locator('#requestRetry').click();
  await expect(page.locator('#shiftSummaryDeliveries')).toHaveText('0件');
  await expect(page.locator('#driverStatus')).toHaveAttribute('data-status', 'OFFLINE');
  expect(keys).toHaveLength(2);
  expect(keys[1]).toBe(keys[0]);
  await page.getByRole('button', { name: '稼働を開始する', exact: true }).click();
  await expect(page.locator('#driverStatus')).toHaveAttribute('data-status', 'IDLE');
  await finishTestShift(page, request);
});
