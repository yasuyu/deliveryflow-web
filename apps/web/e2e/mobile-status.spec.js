const { test, expect } = require('@playwright/test');
const { finishTestShift } = require('./shift-cleanup');

test('初回ログイン・再読み込み・表示領域の移動後も勤務状態とメニューが見える', async ({ page, request, isMobile }, testInfo) => {
  // Desktop emulation cannot open the iOS keyboard. Keep its vertical viewport
  // offset after login, and dispatch the same scroll event Safari emits on return.
  await page.addInitScript((offsetTop) => {
    window.testViewportTop = offsetTop;
    Object.defineProperty(window.visualViewport, 'offsetTop', {
      get: () => window.testViewportTop,
    });
  }, isMobile ? 160 : 0);
  // An opaque basemap also checks that Leaflet tiles cannot cover the status card.
  await page.route('https://tile.openstreetmap.org/**', (route) => route.fulfill({
    contentType: 'image/svg+xml',
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#a2ba91"/></svg>',
  }));
  const registration = await request.post('/api/drivers', {
    data: { name: '上部表示E2E', pin: '123456' },
  });
  expect(registration.ok()).toBe(true);
  const { driver } = await registration.json();
  await page.goto('/');
  await page.getByRole('tab', { name: 'ログイン', exact: true }).click();
  await page.locator('#loginForm').getByLabel('配達員ID').fill(String(driver.id));
  await page.locator('#loginForm').getByLabel('ログインPIN').fill('123456');
  await page.getByRole('button', { name: 'ログインして始める' }).click();
  await expect(page.locator('#driverStatus')).toHaveText('退勤中');
  await expect(page.locator('.leaflet-tile-loaded').first()).toBeVisible();

  async function expectStatusAccessible() {
    await expect.poll(() => page.evaluate(() => {
      const card = document.querySelector('.ride-status');
      const bounds = card.getBoundingClientRect();
      const viewport = window.visualViewport;
      return bounds.top >= viewport.offsetTop + 6
        && bounds.bottom <= viewport.offsetTop + viewport.height
        && bounds.left >= viewport.offsetLeft
        && bounds.right <= viewport.offsetLeft + viewport.width;
    })).toBe(true);
    for (const selector of ['#driverStatus', '.ride-score', '.ride-menu']) {
      // WebKit can round the intersection ratio just below 1 at fractional pixels.
      await expect(page.locator(selector)).toBeInViewport({ ratio: 0.999 });
      await expect.poll(() => page.locator(selector).evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        return element.contains(document.elementFromPoint(
          bounds.x + bounds.width / 2, bounds.y + bounds.height / 2,
        ));
      })).toBe(true);
    }
  }

  await expectStatusAccessible();
  await page.getByRole('button', { name: '稼働を開始する', exact: true }).click();
  await expect(page.locator('#driverStatus')).toHaveAttribute('data-status', 'IDLE');
  await page.reload();
  await expect(page.locator('#driverStatus')).toHaveAttribute('data-status', 'IDLE');
  await expectStatusAccessible();
  await page.locator('.ride-menu').click();
  await expect(page.locator('#bottomSheet')).toHaveAttribute('data-sheet-view', 'settings');
  await page.getByRole('button', { name: '配達画面に戻る', exact: true }).click();
  await page.evaluate(() => {
    window.testViewportTop = 0;
    window.visualViewport.dispatchEvent(new Event('scroll'));
  });
  await expectStatusAccessible();
  await page.screenshot({ path: testInfo.outputPath('mobile-status-visible.png') });
  await page.locator('#bottomSheetHandle').press('ArrowDown');
  await page.locator('#bottomSheetHandle').press('ArrowDown');
  await expect(page.locator('#bottomSheet')).toHaveAttribute('data-sheet-state', 'collapsed');
  await page.setViewportSize({ width: 320, height: 568 });
  await page.evaluate(() => {
    window.testViewportTop = 100;
    window.visualViewport.dispatchEvent(new Event('resize'));
  });
  await expectStatusAccessible();
  // Later tests share this temporary DB and select the nearest three drivers.
  await finishTestShift(page, request);
});
