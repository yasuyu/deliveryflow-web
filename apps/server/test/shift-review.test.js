const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createShiftFeedback, createLocalShiftFeedback } = require('../src/modules/shift-review/shift-review');
const summary = { durationSeconds: 5460, completedDeliveries: 3, pointsEarned: 390, name: '送信しない氏名', latitude: 35 };
const completed = (text) => ({ candidates: [{ finishReason: 'STOP', content: { parts: [
  { thought: true, text: '内部の思考は表示しない' }, { text },
] } }] });
const configured = (options = {}) => createShiftFeedback({ apiKey: 'test-key', freeTierConfirmed: true, ...options });

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

test('Geminiへ集計値だけを送り、固定モデル・サーバー側キー・出力上限を使用する', async () => {
  let captured;
  const service = configured({ fetchImpl: async (url, options) => {
    captured = { url, ...options };
    return Response.json(completed('お疲れさまでした。無理のないペースを大切にしましょう。'));
  } });
  const result = await service.generate(summary);
  assert.equal(result.status, 'AVAILABLE');
  assert.equal(captured.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent');
  assert.equal(captured.headers['x-goog-api-key'], 'test-key');
  assert.equal(captured.url.includes('test-key'), false);
  assert.equal(captured.redirect, 'error');
  const payload = JSON.parse(captured.body);
  assert.deepEqual(JSON.parse(payload.contents[0].parts[0].text), { durationMinutes: 91, completedDeliveries: 3, pointsEarned: 390 });
  assert.deepEqual(payload.generationConfig, { candidateCount: 1, maxOutputTokens: 600, thinkingConfig: { thinkingLevel: 'MINIMAL' } });
  assert.equal(payload.tools, undefined);
  assert.equal(payload.cachedContent, undefined);
  assert.equal(payload.serviceTier, undefined);
  assert.equal(result.feedback.includes('内部の思考'), false);
  assert.equal(captured.body.includes(summary.name), false);
});

test('キー未設定では外部通信せず、空の勤務も扱える', async () => {
  const service = configured({ apiKey: ' ', fetchImpl: () => { throw new Error('must not call'); } });
  assert.equal(service.configured, false);
  assert.equal((await service.generate({ durationSeconds: 0, completedDeliveries: 0, pointsEarned: 0 })).status, 'DISABLED');
});

test('モデルの上書きを使わず、長い出力をUnicode文字境界で240文字以下に制限する', async () => {
  const service = configured({ model: 'paid-model', fetchImpl: async (url) => {
    assert.equal(url.includes('paid-model'), false);
    return Response.json(completed('🚲'.repeat(300)));
  } });
  const result = await service.generate(summary);
  assert.equal(Array.from(result.feedback).length, 240);
  assert.equal(result.feedback.endsWith('…'), true);
});

for (const status of [401, 429, 500]) {
  test(`Gemini HTTP ${status}は診断やキーを公開せず、再試行・別APIへの切替をしない`, async () => {
    let calls = 0;
    const service = configured({ fetchImpl: async () => {
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
  const service = configured({ timeoutMilliseconds: 5, fetchImpl: (_, { signal }) => new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, 1000);
    signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('secret test-key')); }, { once: true });
  }) });
  assert.equal((await service.generate(summary)).status, 'UNAVAILABLE');
});

test('空出力、未完了、拒否、壊れたJSON、キーを含む出力は生成失敗として扱う', async () => {
  for (const data of [completed(''), completed('test-key'), {},
    { candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: '途中の文章' }] } }] },
    { candidates: [{ finishReason: 'SAFETY' }] },
    { ...completed('表示しない'), promptFeedback: { blockReason: 'SAFETY' } },
    { candidates: [{ finishReason: 'STOP', content: { parts: [{ thought: true, text: '思考のみ' }] } }] },
  ]) {
    const service = configured({ fetchImpl: async () => Response.json(data) });
    assert.equal((await service.generate(summary)).status, 'UNAVAILABLE');
  }
  const broken = configured({ fetchImpl: async () => new Response('not-json') });
  assert.equal((await broken.generate(summary)).status, 'UNAVAILABLE');
});

test('無料プランの確認が明示的にtrueでない限り、キーがあっても通信しない', async () => {
  let calls = 0;
  for (const freeTierConfirmed of [false, 'true', 'false', 1, null]) {
    const service = createShiftFeedback({ apiKey: 'test-key', freeTierConfirmed, fetchImpl: () => { calls += 1; throw new Error('must not call'); } });
    assert.equal(service.configured, false);
    assert.equal((await service.generate(summary)).status, 'DISABLED');
  }
  assert.equal(calls, 0);
});

test('OpenAIの旧キー・モデルやGeminiのモデル環境変数では有料APIを有効化しない', async (t) => {
  const names = ['OPENAI_API_KEY', 'OPENAI_MODEL', 'GEMINI_API_KEY', 'GEMINI_MODEL', 'GEMINI_FREE_TIER_CONFIRMED'];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  t.after(() => {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  });
  process.env.OPENAI_API_KEY = 'paid-key';
  process.env.OPENAI_MODEL = 'paid-model';
  process.env.GEMINI_MODEL = 'paid-model';
  delete process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_FREE_TIER_CONFIRMED;
  const blocked = createShiftFeedback({ fetchImpl: () => { throw new Error('must not call'); } });
  assert.equal(blocked.configured, false);
  assert.equal((await blocked.generate(summary)).status, 'DISABLED');
  process.env.GEMINI_API_KEY = 'test-key';
  for (const flag of ['false', 'TRUE', '1', ' true ']) {
    process.env.GEMINI_FREE_TIER_CONFIRMED = flag;
    assert.equal(createShiftFeedback().configured, false);
  }
  process.env.GEMINI_FREE_TIER_CONFIRMED = 'true';
  const enabled = createShiftFeedback({ fetchImpl: async (url) => {
    assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent');
    return Response.json(completed('無料枠を確認したテスト応答'));
  } });
  assert.equal((await enabled.generate(summary)).status, 'AVAILABLE');
});
