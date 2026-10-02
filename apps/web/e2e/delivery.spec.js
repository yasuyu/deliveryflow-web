const { test, expect } = require('@playwright/test');

test('登録から配達完了、履歴確認、退勤まで進められる', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  // Only the external basemap is replaced; all application APIs use the real server.
  await page.route('https://tile.openstreetmap.org/**', (route) => route.fulfill({
    contentType: 'image/png',
    body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==', 'base64'),
  }));
  await page.goto('/');
  await page.getByRole('tab', { name: '新規登録' }).click();
  const registration = page.locator('#registrationForm');
  await registration.getByLabel('配達員名').fill('E2E配達員');
  await registration.getByLabel('ログインPIN').fill('123456');
  await registration.getByRole('button', { name: '登録して始める' }).click();
  await expect(page.locator('#registrationCard')).toBeHidden();
  await expect(page.locator('#driverStatus')).toHaveText('退勤中');
  await expect(page.locator('#mapLifetimeScore')).toHaveText('0');

  await page.getByRole('button', { name: '稼働を開始する', exact: true }).click();
  await expect(page.locator('#driverStatus')).toHaveAttribute('data-status', 'IDLE');
  await page.getByRole('button', { name: 'オファーを確認する', exact: true }).click();
  await expect(page.locator('#driverStatus')).toHaveAttribute('data-status', 'OFFERED');
  await page.locator('#bottomSheetHandle').press('ArrowUp');
  const estimate = page.getByRole('region', { name: '配達の概要' })
    .locator('p').filter({ hasText: '見込み' }).locator('strong');
  await expect(estimate).toHaveText(/\+\d+pt/);
  const points = Number((await estimate.innerText()).match(/\+(\d+)/)[1]);
  expect(points).toBeGreaterThanOrEqual(100);

  await page.getByRole('button', { name: 'この配達を受諾する', exact: true }).click();
  await expect(page.locator('#actionGuidance')).toHaveText('店舗へ向かってください');
  await page.getByRole('button', { name: '受け取りました', exact: true }).click();
  await expect(page.locator('#actionGuidance')).toHaveText('配達先へ向かってください');
  await page.getByRole('button', { name: '配達完了しました', exact: true }).click();
  await expect(page.locator('#driverStatus')).toHaveAttribute('data-status', 'IDLE');
  await expect(page.locator('#mapLifetimeScore')).toHaveText(String(points));

  await page.getByRole('button', { name: 'スコアと配達実績を開く' }).click();
  await expect(page.locator('#completedDeliveryCount')).toHaveText('1');
  const history = page.locator('#deliveryHistory > li');
  await expect(history).toHaveCount(1);
  await expect(history.locator('.history-status')).toHaveText('完了');
  await expect(history.locator('.history-points')).toHaveText(`+${points} pt`);
  await page.reload();
  await expect(page.locator('#mapLifetimeScore')).toHaveText(String(points));
  await page.getByRole('button', { name: '退勤する', exact: true }).click();
  await expect(page.locator('#driverStatus')).toHaveText('退勤中');
  await page.locator('#bottomSheetHandle').press('End');
  await expect(page.getByRole('region', { name: '今回の勤務サマリー' })).toBeVisible();
  await expect(page.locator('#shiftSummaryDeliveries')).toHaveText('1件');
  await expect(page.locator('#shiftSummaryPoints')).toHaveText(`${points} pt`);
  expect(pageErrors).toEqual([]);
});
