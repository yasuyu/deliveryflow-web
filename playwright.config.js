const { defineConfig, devices } = require('@playwright/test');

if (!process.env.E2E_BASE_URL) {
  throw new Error('Run browser tests with npm run test:e2e to use an isolated database and server.');
}

module.exports = defineConfig({
  testDir: './apps/web/e2e',
  testMatch: '**/*.spec.js',
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  timeout: 30_000,
  reporter: 'list',
  use: {
    baseURL: process.env.E2E_BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'desktop-chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile-chromium', use: { ...devices['Pixel 7'] } },
    { name: 'iphone-webkit', testMatch: ['**/mobile-status.spec.js', '**/resume.spec.js'], use: { ...devices['iPhone 13'] } },
  ],
});
