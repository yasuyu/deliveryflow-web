const { test, expect } = require('@playwright/test');

test('登録から配達完了、履歴確認、退勤まで進められる', async ({ page }, testInfo) => {
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
  const summary = page.getByRole('region', { name: '配達の概要' });
  const reward = summary.locator('p').filter({ has: page.getByText('報酬', { exact: true }) });
  await expect(reward).toBeVisible();
  await expect(reward.locator('strong')).toHaveText(/^[\d,]+円$/);
  await expect(summary.getByText('料金', { exact: true })).toHaveCount(0);
  const estimate = summary.locator('p').filter({ hasText: '見込み' }).locator('strong');
  await expect(estimate).toHaveText(/\+\d+pt/);
  const points = Number((await estimate.innerText()).match(/\+(\d+)/)[1]);
  expect(points).toBeGreaterThanOrEqual(100);

  const elevation = page.getByRole('region', { name: '経路の標高' });
  await page.locator('#bottomSheetHandle').press('End');
  await elevation.scrollIntoViewIfNeeded();
  await expect(elevation.locator('.elevation-line')).toHaveCount(1);
  await expect(elevation.locator('header')).toContainText('現在地 → 店舗 → 配達先');
  await expect(elevation.locator('.elevation-extrema dd')).toHaveCount(2);
  const graphBox = await elevation.locator('.elevation-chart').boundingBox();
  const valuesBox = await elevation.locator('.elevation-extrema').boundingBox();
  expect(valuesBox.x).toBeGreaterThanOrEqual(graphBox.x + graphBox.width);
  expect(valuesBox.x + valuesBox.width).toBeLessThanOrEqual(page.viewportSize().width);
  const line = await elevation.locator('.elevation-line').getAttribute('points');
  expect(line.split(' ').length).toBeGreaterThan(2);
  await page.screenshot({ path: testInfo.outputPath('elevation-profile.png') });
  const viewport = page.viewportSize();
  await page.setViewportSize({ width: 320, height: 640 });
  await elevation.scrollIntoViewIfNeeded();
  const narrowGraph = await elevation.locator('.elevation-chart').boundingBox();
  const narrowValues = await elevation.locator('.elevation-extrema').boundingBox();
  expect(narrowValues.x).toBeGreaterThanOrEqual(narrowGraph.x + narrowGraph.width);
  expect(narrowValues.x + narrowValues.width).toBeLessThanOrEqual(320);
  await page.screenshot({ path: testInfo.outputPath('elevation-profile-narrow.png') });
  await page.setViewportSize(viewport);

  const details = page.locator('.delivery-details');
  await details.locator('summary').click();
  await expect(details).toHaveAttribute('open', '');

  await page.getByRole('button', { name: 'この配達を受諾する', exact: true }).click();
  await expect(page.locator('#actionGuidance')).toHaveText('店舗へ向かってください');
  await expect(details).toHaveAttribute('open', '');
  await page.getByRole('button', { name: '受け取りました', exact: true }).click();
  await expect(page.locator('#actionGuidance')).toHaveText('配達先へ向かってください');
  await expect(details).toHaveAttribute('open', '');
  await expect(elevation.locator('header')).toContainText('店舗 → 配達先');
  await expect(elevation.locator('.elevation-pickup')).toHaveCount(0);
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
