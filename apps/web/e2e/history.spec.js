const { test, expect } = require('@playwright/test');
const { DatabaseSync } = require('node:sqlite');

test('過去の履歴を追加し、失敗時の再試行・自動更新・絞り込みに対応する', async ({ page, request }, testInfo) => {
  const registration = await request.post('/api/drivers', { data: { name: '履歴E2E', pin: '135790' } });
  const { driver } = await registration.json();
  const database = new DatabaseSync(process.env.E2E_DATABASE_PATH);
  const ids = [];
  try {
    database.exec('BEGIN');
    const store = database.prepare('SELECT id FROM "Store" ORDER BY id LIMIT 1').get();
    const at = new Date('2026-09-01T12:00:00+09:00').getTime();
    for (let i = 0; i < 45; i += 1) {
      const order = database.prepare('INSERT INTO "Order" ("storeId", "pickupName", "dropoffName", "status") VALUES (?, ?, ?, \'DELIVERED\')').run(store.id, '履歴受取', i < 21 ? `対象配送${i}` : `別の配送${i}`);
      const assignment = database.prepare('INSERT INTO "Assignment" ("orderId", "driverId", "acceptedAt", "pickedUpAt", "deliveredAt") VALUES (?, ?, ?, ?, ?)').run(order.lastInsertRowid, driver.id, at, at, at);
      ids.push(String(assignment.lastInsertRowid));
      database.prepare('INSERT INTO "ScoreEvent" ("driverId", "assignmentId", "points", "reason", "breakdown", "createdAt") VALUES (?, ?, 100, \'基本点\', ?, ?)').run(driver.id, assignment.lastInsertRowid, JSON.stringify([{ label: '基本点', points: 100 }]), at);
    }
    database.prepare('UPDATE "Driver" SET score = 4500 WHERE id = ?').run(driver.id);
    database.exec('COMMIT');
  } finally {
    database.close();
  }
  await page.route('https://tile.openstreetmap.org/**', (route) => route.abort());
  await page.goto('/');
  await page.getByRole('tab', { name: 'ログイン', exact: true }).click();
  await page.locator('#loginForm [name="driverId"]').fill(String(driver.id));
  await page.locator('#loginForm [name="pin"]').fill('135790');
  await page.locator('#loginForm button[type="submit"]').click();
  await page.getByRole('button', { name: 'スコアと配達実績を開く' }).click();
  const items = page.locator('#deliveryHistory > li');
  const more = page.getByRole('button', { name: 'さらに読み込む', exact: true });
  await expect(items).toHaveCount(20);
  await expect(page.locator('#historyResultCount')).toHaveText('条件に一致 45件（20件表示）');
  await expect(more).toBeVisible();
  await more.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('history-load-more.png') });

  let failNext = true;
  let cursorRequests = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  await page.route('**/api/deliveries/history?**', async (route) => {
    if (!new URL(route.request().url()).searchParams.has('cursor')) return route.continue();
    cursorRequests += 1;
    if (failNext) {
      failNext = false;
      return route.fulfill({ status: 503, json: { code: 'UNAVAILABLE', message: 'test' } });
    }
    await gate;
    return route.continue();
  });
  await more.click();
  await expect(page.locator('#historyLoadError')).toBeVisible();
  await expect(items).toHaveCount(20);
  await expect(more).toBeEnabled();
  await more.click();
  await expect(page.locator('#historyLoadMore')).toBeDisabled();
  await page.locator('#historyLoadMore').dispatchEvent('click');
  release();
  await expect(items).toHaveCount(40);
  expect(cursorRequests).toBe(2);
  await expect(page.locator('#historyLoadError')).toBeHidden();
  await more.click();
  await expect(items).toHaveCount(45);
  await expect(page.locator('#historyLoadMore')).toBeHidden();
  const loaded = await items.evaluateAll((nodes) => nodes.map((node) => node.dataset.assignmentId));
  expect(loaded).toEqual([...ids].reverse());
  await expect(items.first().locator('.history-breakdown')).toContainText('基本点 +100');

  // A real state notification triggers the same refresh as delivery updates.
  const accessToken = await page.evaluate(() => localStorage.getItem('deliveryFlowAccessToken'));
  const refreshResponse = page.waitForResponse((response) => response.url().includes('/api/deliveries/history?') && new URL(response.url()).searchParams.get('cursor') === ids[5]);
  const notification = await request.post('/api/simulator/weather', {
    headers: { Authorization: `Bearer ${accessToken}`, 'Idempotency-Key': `history-refresh-${driver.id}` },
    data: { condition: 'CLEAR' },
  });
  expect(notification.ok()).toBeTruthy();
  await refreshResponse;
  await expect(items).toHaveCount(45);
  await expect(page.locator('#historyLoadMore')).toBeHidden();

  const filters = page.locator('#historyFilterForm');
  await filters.locator('[name="query"]').fill('対象配送');
  await filters.locator('[name="from"]').fill('2026-09-01');
  await filters.locator('[name="to"]').fill('2026-09-01');
  await filters.getByRole('button', { name: '絞り込む', exact: true }).click();
  await expect(items).toHaveCount(20);
  await expect(page.locator('#historyResultCount')).toHaveText('条件に一致 21件（20件表示）');
  await more.click();
  await expect(items).toHaveCount(21);
  await expect(page.locator('#historyLoadMore')).toBeHidden();
  await filters.locator('[name="query"]').fill('該当なし');
  await filters.getByRole('button', { name: '絞り込む', exact: true }).click();
  await expect(page.locator('#historyResultCount')).toHaveText('条件に一致 0件（0件表示）');
  await expect(page.locator('#historyLoadMore')).toBeHidden();
  await filters.getByRole('button', { name: 'リセット', exact: true }).click();
  await expect(items).toHaveCount(20);
  await expect(page.locator('#historyResultCount')).toHaveText('条件に一致 45件（20件表示）');
  await expect(more).toBeVisible();
});
