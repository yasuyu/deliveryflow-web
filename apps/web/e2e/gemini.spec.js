const { test, expect } = require('@playwright/test');

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
    await expect(page.locator('#localShiftFeedback')).toHaveText(free);
    await expect(page.locator('#shiftSummaryDeliveries')).toHaveText('0件');
    await expect(page.locator('#shiftSummaryPoints')).toHaveText('0 pt');
    await expect(page.locator('#driverStatus')).toHaveAttribute('data-status', 'OFFLINE');
  });
}
