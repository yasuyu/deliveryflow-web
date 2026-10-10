// Loaded only by the API test child process; external AI traffic is always blocked.
const originalFetch = globalThis.fetch;
let calls = 0;

globalThis.fetch = async (url, options) => {
  const target = new URL(url);
  if (target.hostname === 'api.openai.com') throw new Error('Paid AI traffic is forbidden in tests');
  if (target.hostname !== 'generativelanguage.googleapis.com') {
    if (!['localhost', '127.0.0.1', '[::1]'].includes(target.hostname)) throw new Error('External traffic is forbidden in API tests');
    return originalFetch(url, options);
  }
  if (target.pathname !== '/v1beta/models/gemini-3.5-flash-lite:generateContent'
    || options.headers['x-goog-api-key'] !== 'test-only-gemini-key') throw new Error('Unexpected test AI request');
  calls += 1;
  if (process.env.DELIVERYFLOW_TEST_GEMINI_MODE === 'quota' && calls === 1) {
    return Response.json({ error: { message: 'test-only-gemini-key: quota exceeded' } }, { status: 429 });
  }
  const input = JSON.parse(JSON.parse(options.body).contents[0].parts[0].text);
  await new Promise((resolve) => setTimeout(resolve, 100));
  return Response.json({
    candidates: [{ finishReason: 'STOP', content: { parts: [{ text: `勤務${input.durationMinutes}分、配達${input.completedDeliveries}件、${input.pointsEarned}ポイント。お疲れさまでした。次回も無理のないペースを大切にしましょう。（テスト呼出${calls}）` }] } }],
  });
};
