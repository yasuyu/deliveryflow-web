const { test, expect } = require('@playwright/test');

test('退勤後のAI振り返りは生成中と結果を表示し、HTMLを実行しない', async ({ page }, testInfo) => {
  await page.route('https://tile.openstreetmap.org/**', (route) => route.abort());
  let requests = 0;
  const feedback = '今回の勤務、お疲れさまでした。配達0件でも、勤務の流れを確認できたことは次の学びにつながります。'.repeat(3) + '<img src=x onerror=alert(1)>';
  await page.route('**/api/shifts/review', async (route) => {
    const body = route.request().postDataJSON();
    expect(body.shiftEndKey).toMatch(/^[a-f0-9-]{36}$/);
    requests += 1;
    await route.fulfill({ json: requests === 1 ? { status: 'PENDING' } : { status: 'AVAILABLE', feedback } });
  });
  await page.goto('/');
  await page.getByRole('tab', { name: '新規登録' }).click();
  await page.locator('#registrationForm').getByLabel('配達員名').fill('AI振り返りE2E');
  await page.locator('#registrationForm').getByLabel('ログインPIN').fill('123456');
  await page.getByRole('button', { name: '登録して始める' }).click();
  await page.getByRole('button', { name: '稼働を開始する', exact: true }).click();
  await page.getByRole('button', { name: '退勤する', exact: true }).click();
  await expect(page.locator('#bottomSheet')).toHaveAttribute('data-sheet-state', 'expanded');
  await expect(page.locator('#shiftSummaryDeliveries')).toBeInViewport({ ratio: 1 });
  await expect(page.locator('#shiftReviewButton')).toBeInViewport({ ratio: 1 });
  const button = page.locator('#shiftReviewButton');
  await button.click();
  await expect(button).toBeDisabled();
  await expect(page.locator('#shiftReviewText')).toHaveText(feedback);
  await expect(page.locator('#shiftReviewText img')).toHaveCount(0);
  expect(requests).toBe(2);
  await page.setViewportSize({ width: 320, height: 640 });
  await page.locator('#bottomSheetHandle').press('End');
  await page.locator('#shiftReviewText').scrollIntoViewIfNeeded();
  const box = await page.locator('.shift-review').boundingBox();
  expect(box.x + box.width).toBeLessThanOrEqual(320);
  await page.screenshot({ path: testInfo.outputPath('ai-shift-review-narrow.png') });
  await page.getByRole('button', { name: '稼働を開始する', exact: true }).click();
  await expect(page.locator('#lastShiftSummary')).toBeHidden();
});

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
  await expect(page.locator('#offerDeadline')).toHaveText(/残り\s*(?:[12]?\d|30)秒/);
  await expect(page.locator('#offerCountdownProgress')).toHaveAttribute('max', '30');
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
  await expect(elevation.locator('.elevation-stop').first()).toHaveText('現在地0 m');
  await expect(elevation.locator('.elevation-stop').last()).toContainText('配達先');
  await expect(elevation.locator('.elevation-distance-label')).toHaveText('道路沿いの距離（参考）');
  const routePreview = page.locator('.route-preview');
  await expect(routePreview.locator('h3')).toHaveText('経路プレビュー（直線距離）');
  await expect(routePreview.locator('.route-preview__segment span')).toHaveText([/直線 約/, /直線 約/]);
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
  const startStop = await elevation.locator('.elevation-stop').first().boundingBox();
  const endStop = await elevation.locator('.elevation-stop').last().boundingBox();
  expect(startStop.x + startStop.width).toBeLessThanOrEqual(endStop.x);
  expect(endStop.x + endStop.width).toBeLessThanOrEqual(narrowGraph.x + narrowGraph.width);
  await page.screenshot({ path: testInfo.outputPath('elevation-profile-narrow.png') });
  await routePreview.locator('h3').scrollIntoViewIfNeeded();
  const previewHeading = await routePreview.locator('h3').boundingBox();
  expect(previewHeading.x + previewHeading.width).toBeLessThanOrEqual(320);
  await page.screenshot({ path: testInfo.outputPath('route-preview-narrow.png') });
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
  await expect(elevation.locator('.elevation-stop').first()).toHaveText('店舗0 m');
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
  await expect(page.locator('#bottomSheet')).toHaveAttribute('data-sheet-state', 'expanded');
  await expect(page.locator('#shiftSummaryDeliveries')).toBeInViewport({ ratio: 1 });
  await expect(page.locator('#shiftReviewButton')).toBeInViewport({ ratio: 1 });
  await expect(page.getByRole('region', { name: '今回の勤務サマリー' })).toBeVisible();
  await expect(page.locator('#shiftSummaryDeliveries')).toHaveText('1件');
  await expect(page.locator('#shiftSummaryPoints')).toHaveText(`${points} pt`);
  await page.locator('#shiftReviewButton').click();
  await expect(page.locator('#shiftReviewText')).toHaveText('AIの振り返りは未設定です。');
  await expect(page.locator('#shiftReviewButton')).toBeDisabled();
  expect(pageErrors).toEqual([]);
});

test('スコアの期間を明示し、辞退して退勤は確認後だけ実行する', async ({ page, request }, testInfo) => {
  await page.route('https://tile.openstreetmap.org/**', (route) => route.fulfill({
    contentType: 'image/png',
    body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==', 'base64'),
  }));
  await page.goto('/');
  await page.getByRole('tab', { name: '新規登録' }).click();
  const registration = page.locator('#registrationForm');
  await registration.getByLabel('配達員名').fill('UI確認配達員');
  await registration.getByLabel('ログインPIN').fill('123456');
  await registration.getByRole('button', { name: '登録して始める' }).click();
  await expect(page.locator('#driverStatus')).toHaveText('退勤中');
  const score = page.locator('.ride-score');
  await expect(score.locator('span').first()).toHaveText('14日間0');
  await score.click();
  await expect(page.locator('.score-summary p').first()).toContainText('14日間のスコア');
  await page.getByRole('button', { name: '配達画面に戻る', exact: true }).click();
  await page.getByRole('button', { name: '稼働を開始する', exact: true }).click();
  await page.getByRole('button', { name: 'オファーを確認する', exact: true }).click();
  await expect(page.locator('#driverStatus')).toHaveAttribute('data-status', 'OFFERED');

  const viewport = page.viewportSize();
  await page.setViewportSize({ width: 320, height: 640 });
  const scoreBounds = await score.boundingBox();
  const statusBounds = await page.locator('.ride-status__text').boundingBox();
  const menuBounds = await page.locator('.ride-menu').boundingBox();
  expect(scoreBounds.x).toBeGreaterThanOrEqual(statusBounds.x + statusBounds.width);
  expect(scoreBounds.x + scoreBounds.width).toBeLessThanOrEqual(menuBounds.x);
  expect(menuBounds.x + menuBounds.width).toBeLessThanOrEqual(320);
  await page.screenshot({ path: testInfo.outputPath('score-period-narrow.png') });
  await page.setViewportSize(viewport);

  const sent = [];
  page.on('request', (outgoing) => {
    if (outgoing.method() === 'POST') sent.push(new URL(outgoing.url()).pathname);
  });
  const end = page.getByRole('button', { name: '辞退して退勤', exact: true });
  const cancellation = page.waitForEvent('dialog');
  const cancelClick = end.click();
  const cancelDialog = await cancellation;
  expect(cancelDialog.type()).toBe('confirm');
  expect(cancelDialog.message()).toContain('このオファーを辞退して退勤しますか？');
  expect(cancelDialog.message()).toContain('新しいオファーの受付も終了');
  await cancelDialog.dismiss();
  await cancelClick;
  expect(sent).not.toContain('/api/shifts/end');
  await expect(page.locator('#driverStatus')).toHaveAttribute('data-status', 'OFFERED');
  await expect(page.getByRole('button', { name: 'この配達を受諾する', exact: true })).toBeEnabled();
  const accessToken = await page.evaluate(() => localStorage.getItem('deliveryFlowAccessToken'));
  const headers = { Authorization: `Bearer ${accessToken}` };
  const unchanged = await request.get('/api/dashboard', { headers });
  const unchangedBody = await unchanged.json();
  expect(unchangedBody.driver.status).toBe('OFFERED');
  expect(unchangedBody.offer.status).toBe('PENDING');

  let unexpectedDialogs = 0;
  const dismissUnexpected = (dialog) => { unexpectedDialogs += 1; return dialog.dismiss(); };
  page.on('dialog', dismissUnexpected);
  await page.getByRole('button', { name: '辞退する', exact: true }).click();
  await expect(page.locator('#driverStatus')).toHaveAttribute('data-status', 'IDLE');
  page.off('dialog', dismissUnexpected);
  expect(unexpectedDialogs).toBe(0);
  expect(sent.some((pathname) => /\/offers\/\d+\/reject$/.test(pathname))).toBe(true);
  expect(sent).not.toContain('/api/shifts/end');

  await page.getByRole('button', { name: 'オファーを確認する', exact: true }).click();
  await expect(page.locator('#driverStatus')).toHaveAttribute('data-status', 'OFFERED');
  await page.screenshot({ path: testInfo.outputPath('score-period-and-shift-confirm.png') });
  await page.setViewportSize({ width: 320, height: 568 });
  const confirmation = page.waitForEvent('dialog');
  const confirmClick = end.click();
  const confirmDialog = await confirmation;
  expect(confirmDialog.type()).toBe('confirm');
  await confirmDialog.accept();
  await confirmClick;
  await expect(page.locator('#driverStatus')).toHaveText('退勤中');
  await expect(page.locator('#bottomSheet')).toHaveAttribute('data-sheet-state', 'expanded');
  await expect(page.locator('#shiftSummaryDeliveries')).toBeInViewport({ ratio: 1 });
  await expect(page.locator('#shiftSummaryPoints')).toBeInViewport({ ratio: 1 });
  await expect(page.locator('#shiftReviewButton')).toBeInViewport({ ratio: 1 });
  await page.screenshot({ path: testInfo.outputPath('shift-summary-short-screen.png') });
  expect(sent.filter((pathname) => pathname === '/api/shifts/end')).toHaveLength(1);
  const ended = await request.get('/api/dashboard', { headers });
  const endedBody = await ended.json();
  expect(endedBody.driver.status).toBe('OFFLINE');
  expect(endedBody.offer).toBeNull();
});
