const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createShiftFeedback, createLocalShiftFeedback } = require('../src/modules/shift-review/shift-review');
const summary = { durationSeconds: 5460, completedDeliveries: 3, pointsEarned: 390, name: '送信しない氏名', latitude: 35 };
const completed = (text) => ({ status: 'completed', output: [
  { type: 'reasoning' },
  { type: 'message', content: [{ type: 'output_text', text }] },
] });

test('無料の定型振り返りは実績に触れ、0件・短い勤務・長い勤務を扱う', () => {
  const empty = createLocalShiftFeedback({ durationSeconds: 0, completedDeliveries: 0, pointsEarned: 0 });
  assert.match(empty, /1分未満/);
  assert.match(empty, /配達は0件/);
  assert.match(empty, /0ポイント/);
  assert.match(empty, /開始から退勤まで/);
  const regular = createLocalShiftFeedback(summary);
  assert.match(regular, /1時間31分/);
  assert.match(regular, /配達は3件/);
  assert.match(regular, /390ポイント/);
  assert.equal(regular.includes(summary.name), false);
  assert.ok(Array.from(regular).length >= 180 && Array.from(regular).length <= 240);
  const long = createLocalShiftFeedback({ ...summary, durationSeconds: 7200 });
  assert.match(long, /2時間0分/);
  assert.match(long, /休憩/);
  assert.equal(long, createLocalShiftFeedback({ ...summary, durationSeconds: 7200 }));
});

test('Responses APIへ集計値だけを送り、サーバー側キーと出力上限を使用する', async () => {
  let captured;
  const service = createShiftFeedback({ apiKey: 'test-key', fetchImpl: async (url, options) => {
    captured = { url, ...options };
    return Response.json(completed('お疲れさまでした。無理のないペースを大切にしましょう。'));
  } });
  const result = await service.generate(summary);
  assert.equal(result.status, 'AVAILABLE');
  assert.equal(captured.url, 'https://api.openai.com/v1/responses');
  assert.equal(captured.headers.Authorization, 'Bearer test-key');
  const payload = JSON.parse(captured.body);
  assert.deepEqual(JSON.parse(payload.input), { durationMinutes: 91, completedDeliveries: 3, pointsEarned: 390 });
  assert.equal(payload.model, 'gpt-4.1-mini');
  assert.equal(payload.store, false);
  assert.equal(payload.max_output_tokens, 600);
  assert.equal(captured.body.includes(summary.name), false);
});

test('キー未設定では外部通信せず、空の勤務も扱える', async () => {
  const service = createShiftFeedback({ apiKey: ' ', fetchImpl: () => { throw new Error('must not call'); } });
  assert.equal(service.configured, false);
  assert.equal((await service.generate({ durationSeconds: 0, completedDeliveries: 0, pointsEarned: 0 })).status, 'DISABLED');
});

test('設定モデルを使い、長い出力をUnicode文字境界で240文字以下に制限する', async () => {
  const service = createShiftFeedback({ apiKey: 'test-key', model: 'custom-model', fetchImpl: async (_, options) => {
    assert.equal(JSON.parse(options.body).model, 'custom-model');
    return Response.json(completed('🚲'.repeat(300)));
  } });
  const result = await service.generate(summary);
  assert.equal(Array.from(result.feedback).length, 240);
  assert.equal(result.feedback.endsWith('…'), true);
});

for (const status of [401, 429, 500]) {
  test(`OpenAI HTTP ${status}は診断やキーを公開せず、再試行しない`, async () => {
    let calls = 0;
    const service = createShiftFeedback({ apiKey: 'test-key', fetchImpl: async () => {
      calls += 1;
      return Response.json({ error: 'secret test-key' }, { status });
    } });
    const result = await service.generate(summary);
    assert.equal(result.status, 'UNAVAILABLE');
    assert.equal(JSON.stringify(result).includes('test-key'), false);
    assert.equal(calls, 1);
  });
}

test('タイムアウトで中断し、例外の秘密情報を返さない', async () => {
  const service = createShiftFeedback({ apiKey: 'test-key', timeoutMilliseconds: 5, fetchImpl: (_, { signal }) => new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, 1000);
    signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('secret test-key')); }, { once: true });
  }) });
  assert.equal((await service.generate(summary)).status, 'UNAVAILABLE');
});

test('空出力、未完了、拒否、壊れたJSON、キーを含む出力は生成失敗として扱う', async () => {
  for (const data of [completed(''), completed('test-key'), { status: 'incomplete' }, { status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal' }] }] }]) {
    const service = createShiftFeedback({ apiKey: 'test-key', fetchImpl: async () => Response.json(data) });
    assert.equal((await service.generate(summary)).status, 'UNAVAILABLE');
  }
  const broken = createShiftFeedback({ apiKey: 'test-key', fetchImpl: async () => new Response('not-json') });
  assert.equal((await broken.generate(summary)).status, 'UNAVAILABLE');
});
