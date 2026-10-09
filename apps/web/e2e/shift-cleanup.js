const { randomUUID } = require('node:crypto');
const { expect } = require('@playwright/test');

async function finishTestShift(page, request) {
  const token = await page.evaluate(() => localStorage.getItem('deliveryFlowAccessToken'));
  const response = await request.post('/api/shifts/end', {
    headers: { Authorization: `Bearer ${token}`, 'Idempotency-Key': randomUUID() },
  });
  expect(response.ok()).toBe(true);
  expect((await response.json()).status).toBe('OFFLINE');
}

module.exports = { finishTestShift };
