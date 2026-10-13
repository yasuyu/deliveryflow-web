const { test, expect } = require('@playwright/test');
const { DatabaseSync } = require('node:sqlite');
const { japanMonthWindow } = require('../../server/src/modules/score/monthly-awards');

async function account(page, request, count = 0) {
  await page.route('https://tile.openstreetmap.org/**', (route) => route.abort());
  const registration = await (await request.post('/api/drivers', { data: { name: '月間称号履歴E2E', pin: '123456' } })).json();
  if (count) {
    const db = new DatabaseSync(process.env.E2E_DATABASE_PATH);
    try {
      db.exec('PRAGMA busy_timeout = 5000');
      let window = japanMonthWindow(new Date(japanMonthWindow().startsAt.getTime() - 1));
      for (let index = 0; index < count; index++) {
        db.prepare('INSERT OR IGNORE INTO MonthlyAwardPeriod (month, startsAt, endsAt, finalizedAt) VALUES (?, ?, ?, ?)')
          .run(window.label, window.startsAt.getTime(), window.endsAt.getTime(), Date.now());
        db.prepare('INSERT INTO MonthlyAward (driverId, month, rank, points, title, awardedAt) VALUES (?, ?, ?, ?, ?, ?)')
          .run(registration.driver.id, window.label, index === 0 ? 1 : 3, 100 + index,
            index === 0 ? '月間チャンピオン' : '月間トップ3', Date.now());
        window = japanMonthWindow(new Date(window.startsAt.getTime() - 1));
      }
    } finally { db.close(); }
  }
  await page.addInitScript(({ accessToken, driver }) => {
    localStorage.setItem('deliveryFlowAccessToken', accessToken);
    localStorage.setItem('deliveryFlowDriverId', String(driver.id));
  }, registration);
  await page.goto('/');
  await expect(page.locator('#driverStatus')).toHaveAttribute('data-status', 'OFFLINE');
  await page.getByRole('button', { name: 'スコアと配達実績を開く' }).click();
}

test('月間称号は最高称号と獲得月を表示し、過去21か月を再読み込み後も確認できる', async ({ page, request }, testInfo) => {
  await account(page, request, 21);
  await expect(page.locator('#bestMonthlyAward')).toContainText('月間チャンピオン');
  await expect(page.locator('#monthlyAwardsList li')).toHaveCount(20);
  await page.locator('#monthlyAwardsMore').click();
  await expect(page.locator('#monthlyAwardsList li')).toHaveCount(21);
  await expect(page.locator('#monthlyAwardsMore')).toBeHidden();
  const first = await page.locator('#monthlyAwardsList li').first().textContent();
  await page.reload();
  await page.getByRole('button', { name: 'スコアと配達実績を開く' }).click();
  await expect(page.locator('#monthlyAwardsList li')).toHaveCount(20);
  await expect(page.locator('#monthlyAwardsList li').first()).toHaveText(first);
  await page.locator('[aria-label="獲得した月間称号"]').scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('monthly-awards-history.png') });
});

test('称号履歴の読込失敗を表示し、再読み込みできる', async ({ page, request }) => {
  let fail = true;
  await page.route('**/api/drivers/me/monthly-awards*', (route) => fail
    ? route.fulfill({ status: 503, json: { message: 'テスト用通信失敗' } }) : route.continue());
  await account(page, request);
  await expect(page.locator('#monthlyAwardsError')).toContainText('称号履歴を読み込めませんでした');
  fail = false;
  await page.locator('#monthlyAwardsReload').click();
  await expect(page.locator('#monthlyAwardsError')).toBeHidden();
  await expect(page.locator('#monthlyAwardsStatus')).toContainText('まだ獲得した月間称号はありません');
});
