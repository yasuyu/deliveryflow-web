const { test, expect } = require('@playwright/test');
const { randomUUID } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { finishTestShift } = require('./shift-cleanup');

test.beforeEach(async ({ page }) => {
  await page.route('https://tile.openstreetmap.org/**', (route) => route.abort());
});

async function account(page, request, shifts = 1, feedback = null) {
  const registration = await (await request.post('/api/drivers', { data: { name: '勤務履歴E2E', pin: '123456' } })).json();
  const headers = { Authorization: `Bearer ${registration.accessToken}` };
  let key;
  for (let index = 0; index < shifts; index += 1) {
    expect((await request.post('/api/shifts/start', { headers: { ...headers, 'Idempotency-Key': randomUUID() } })).ok()).toBe(true);
    key = randomUUID();
    expect((await request.post('/api/shifts/end', { headers: { ...headers, 'Idempotency-Key': key } })).ok()).toBe(true);
  }
  if (feedback !== null) {
    // Seed the saved review before opening the browser and its automatic refresh.
    const database = new DatabaseSync(process.env.E2E_DATABASE_PATH);
    try {
      database.exec('PRAGMA busy_timeout = 5000');
      database.prepare('INSERT INTO IdempotencyKey (key, endpoint, driverId, response, statusCode, createdAt) VALUES (?, ?, ?, ?, ?, ?)')
        .run(key, '/api/shifts/review', registration.driver.id, JSON.stringify({ status: 'AVAILABLE', feedback }), 200, Date.now());
    } finally { database.close(); }
  }
  await page.addInitScript(({ accessToken, driver }) => {
    localStorage.setItem('deliveryFlowAccessToken', accessToken);
    localStorage.setItem('deliveryFlowDriverId', String(driver.id));
  }, registration);
  await page.goto('/');
  await expect(page.locator('#driverStatus')).toHaveAttribute('data-status', 'OFFLINE');
  return { registration, headers, key };
}

async function openHistory(page) {
  await page.getByRole('button', { name: 'スコアと配達実績を開く' }).click();
  await expect(page.locator('#shiftHistoryList li').first()).toBeVisible();
}

test('過去の勤務を再読み込み・再ログイン・次の勤務中も開ける', async ({ page, request }, testInfo) => {
  const { registration } = await account(page, request);
  await page.reload();
  await openHistory(page);
  await page.locator('#shiftHistoryList button').click();
  await expect(page.locator('#historicalShift')).toBeVisible();
  await expect(page.locator('#historicalShiftDeliveries')).toHaveText('0件');
  await expect(page.locator('#historicalShiftPoints')).toHaveText('0 pt');
  await expect(page.locator('#historicalShiftFeedback')).toContainText('完了した配達は0件');
  await page.screenshot({ path: testInfo.outputPath('shift-history.png') });
  await page.getByRole('button', { name: '設定を開く' }).click();
  await page.locator('#logoutButton').click();
  await expect(page.locator('#registrationCard')).toBeVisible();
  await page.locator('#loginForm [name="driverId"]').fill(String(registration.driver.id));
  await page.locator('#loginForm [name="pin"]').fill('123456');
  await page.locator('#loginForm button[type="submit"]').click();
  await expect(page.locator('#driverStatus')).toHaveAttribute('data-status', 'OFFLINE');
  await openHistory(page);
  await page.locator('#shiftHistoryList button').click();
  await expect(page.locator('#historicalShiftFeedback')).toContainText('完了した配達は0件');
  await page.locator('#returnToDelivery').click();
  await page.getByRole('button', { name: '稼働を開始する', exact: true }).click();
  try {
    await openHistory(page);
    await page.locator('#shiftHistoryList button').click();
    await expect(page.locator('#historicalShift')).toBeVisible();
    await expect(page.locator('#driverStatus')).toHaveAttribute('data-status', 'IDLE');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  } finally { await finishTestShift(page, request); }
});

test('勤務履歴と詳細の通信停止から再試行でき、ページ追加に失敗しても表示済みの履歴を残す', async ({ page, request }) => {
  await page.clock.install();
  await account(page, request, 21);
  let held;
  await page.route('**/api/shifts/history', (route) => { held = route; });
  await page.getByRole('button', { name: 'スコアと配達実績を開く' }).click();
  await expect.poll(() => Boolean(held)).toBe(true);
  await page.clock.fastForward(30_001);
  await expect(page.locator('#shiftHistoryError')).toContainText('30秒');
  await expect(page.locator('#shiftHistoryReload')).toBeEnabled();
  await held.abort();
  await page.unroute('**/api/shifts/history');
  await page.locator('#shiftHistoryReload').click();
  await expect(page.locator('#shiftHistoryList li')).toHaveCount(20);
  await page.route('**/api/shifts/history?cursor=*', (route) => route.abort());
  await page.locator('#shiftHistoryMore').click();
  await expect(page.locator('#shiftHistoryError')).toBeVisible();
  await expect(page.locator('#shiftHistoryList li')).toHaveCount(20);
  await page.unroute('**/api/shifts/history?cursor=*');
  await page.locator('#shiftHistoryMore').click();
  await expect(page.locator('#shiftHistoryList li')).toHaveCount(21);
  await expect(page.locator('#shiftHistoryMore')).toBeHidden();
  held = null;
  await page.route('**/api/shifts/history/*', (route) => { held = route; });
  await page.locator('#shiftHistoryList button').last().click();
  await expect.poll(() => Boolean(held)).toBe(true);
  await page.clock.fastForward(30_001);
  await expect(page.locator('#shiftHistoryError')).toContainText('30秒');
  await expect(page.locator('#shiftHistoryList button').last()).toBeEnabled();
  await held.abort();
  await page.unroute('**/api/shifts/history/*');
  await page.locator('#shiftHistoryList button').last().click();
  await expect(page.locator('#historicalShift')).toBeVisible();
});

test('保存済みのAI文章を再表示しても生成せず、HTMLを文字として表示する', async ({ page, request }) => {
  const feedback = '<img src=x onerror="window.historyXss=true">保存済みの振り返り';
  await account(page, request, 1, feedback);
  let calls = 0;
  await page.route('**/api/shifts/review', (route) => { calls += 1; return route.abort(); });
  await openHistory(page);
  await page.locator('#shiftHistoryList button').click();
  await expect(page.locator('#historicalShiftAi')).toHaveText(feedback);
  await page.locator('#historicalShiftReload').click();
  await expect(page.locator('#historicalShiftReload')).toBeEnabled();
  await expect(page.locator('#historicalShiftAi')).toHaveText(feedback);
  expect(await page.evaluate(() => window.historyXss)).toBeUndefined();
  expect(await page.locator('#historicalShiftAi img').count()).toBe(0);
  expect(calls).toBe(0);
});
