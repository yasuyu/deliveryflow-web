// Loaded only by the API test child process; real OpenAI traffic is always blocked.
const originalFetch = globalThis.fetch;
let calls = 0;
globalThis.fetch = async (url, options) => {
  if (url !== 'https://api.openai.com/v1/responses') return originalFetch(url, options);
  if (options.headers.Authorization !== 'Bearer test-only-openai-key') throw new Error('Unexpected test credential');
  calls += 1;
  const input = JSON.parse(JSON.parse(options.body).input);
  await new Promise((resolve) => setTimeout(resolve, 100));
  return Response.json({
    status: 'completed',
    output: [{ type: 'message', content: [{ type: 'output_text', text: `勤務${input.durationMinutes}分、配達${input.completedDeliveries}件、${input.pointsEarned}ポイント。お疲れさまでした。次回も無理のないペースを大切にしましょう。（テスト呼出${calls}）` }] }],
  });
};
