const { test, expect } = require('@playwright/test');

test('退勤後の実績読込中でもAIボタンを押すと生成中と結果を表示する', async ({ page }, testInfo) => {
  await page.route('https://tile.openstreetmap.org/**', (route) => route.abort());
  let holdScore = false;
  let releaseScore;
  const scoreGate = new Promise((resolve) => { releaseScore = resolve; });
  let reviews = 0;
  const feedback = '今回の勤務、お疲れさまでした。次回も落ち着いて操作を確認しましょう。';
  let releaseReview;
  const reviewGate = new Promise((resolve) => { releaseReview = resolve; });
  await page.route('**/api/drivers/me/score', async (route) => {
    if (holdScore) await scoreGate;
    await route.continue();
  });
  await page.route('**/api/shifts/review', async (route) => {
    reviews++;
    expect(route.request().postDataJSON().shiftEndKey).toMatch(/^[a-f0-9-]{36}$/);
    await reviewGate;
    await route.fulfill({ json: { status: 'AVAILABLE', feedback } });
  });
  try {
    await page.goto('/');
    await page.getByRole('tab', { name: '新規登録' }).click();
    await page.locator('#registrationForm').getByLabel('配達員名').fill('AIボタン読込中確認');
    await page.locator('#registrationForm').getByLabel('ログインPIN').fill('123456');
    await page.getByRole('button', { name: '登録して始める' }).click();
    await page.getByRole('button', { name: '稼働を開始する', exact: true }).click();
    await expect(page.getByRole('button', { name: '退勤する', exact: true })).toBeEnabled();
    holdScore = true;
    await page.getByRole('button', { name: '退勤する', exact: true }).click();
    await page.locator('#bottomSheetHandle').press('End');
    await expect(page.locator('#lastShiftSummary')).toBeVisible();
    const button = page.locator('#shiftReviewButton');
    await button.scrollIntoViewIfNeeded();
    await expect(page.locator('#actions')).toHaveAttribute('aria-busy', 'true');
    await button.click();
    await expect(page.locator('#shiftReviewText')).toContainText('振り返りを生成しています');
    await expect(button).toBeDisabled();
    await expect.poll(() => reviews).toBe(1);
    releaseReview();
    await expect(page.locator('#shiftReviewText')).toHaveText(feedback);
    await expect(button).toBeDisabled();
    await expect(button).toHaveText('振り返り生成済み');
    releaseScore();
    await expect(page.locator('#actions')).toHaveAttribute('aria-busy', 'false');
    await expect(page.locator('#shiftReviewText')).toHaveText(feedback);
    expect(reviews).toBe(1);
    await page.screenshot({ path: testInfo.outputPath('ai-review-during-score-load.png') });
  } finally {
    releaseScore();
    releaseReview();
  }
});

for (const status of ['DISABLED', 'UNAVAILABLE']) {
  test(`AIが${status}でも無料の定型コメントと勤務実績を読める`, async ({ page }) => {
    await page.route('https://tile.openstreetmap.org/**', (route) => route.abort());
    if (status === 'UNAVAILABLE') {
      await page.route('**/api/shifts/review', (route) => route.fulfill({ json: {
        status, message: 'AIの振り返りを生成できませんでした。勤務実績は記録済みです。',
      } }));
    }
    await page.goto('/');
    await page.getByRole('tab', { name: '新規登録' }).click();
    await page.locator('#registrationForm').getByLabel('配達員名').fill('無料コメント確認');
    await page.locator('#registrationForm').getByLabel('ログインPIN').fill('123456');
    await page.getByRole('button', { name: '登録して始める' }).click();
    await page.getByRole('button', { name: '稼働を開始する', exact: true }).click();
    await page.getByRole('button', { name: '退勤する', exact: true }).click();
    await expect(page.locator('#localShiftFeedback')).toContainText('完了した配達は0件');
    const free = await page.locator('#localShiftFeedback').textContent();
    await expect(page.locator('#shiftReviewText')).toContainText('Gemini');
    await expect(page.locator('#shiftReviewText')).toContainText('Googleの製品改善');
    await page.locator('#shiftReviewButton').click();
    await expect(page.locator('#shiftReviewText')).toContainText(status === 'DISABLED' ? '無料プランの確認' : '勤務実績は記録済み');
    await expect(page.locator('#shiftReviewButton')).toBeDisabled();
    await expect(page.locator('#shiftReviewButton')).toHaveText(status === 'DISABLED' ? 'AIは利用できません' : '生成できませんでした');
    await expect(page.locator('#localShiftFeedback')).toHaveText(free);
    await expect(page.locator('#shiftSummaryDeliveries')).toHaveText('0件');
    await expect(page.locator('#shiftSummaryPoints')).toHaveText('0 pt');
    await expect(page.locator('#driverStatus')).toHaveAttribute('data-status', 'OFFLINE');
  });
}
