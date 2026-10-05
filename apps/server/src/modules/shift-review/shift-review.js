const unavailableReview = Object.freeze({
  status: 'UNAVAILABLE',
  message: 'AIの振り返りを生成できませんでした。勤務実績は記録済みです。',
});

function createShiftFeedback({ apiKey = process.env.OPENAI_API_KEY, model = process.env.OPENAI_MODEL || 'gpt-4.1-mini', fetchImpl = fetch, timeoutMilliseconds = 15_000 } = {}) {
  const key = apiKey?.trim();
  return {
    configured: Boolean(key),
    async generate(summary) {
      if (!key) return { status: 'DISABLED', message: 'AIの振り返りは未設定です。' };
      try {
        const response = await fetchImpl('https://api.openai.com/v1/responses', {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(timeoutMilliseconds),
          body: JSON.stringify({
            model,
            store: false,
            max_output_tokens: 600,
            instructions: 'あなたは学習用配達アプリの振り返りアシスタントです。提示された勤務実績だけをもとに、日本語180〜220文字程度の短いフィードバックをプレーンテキストで返してください。努力をねぎらい、実績に触れ、次回に向けた具体的で無理のない提案を1つ添えてください。配達0件でも否定しないでください。速度競争や危険運転を勧めず、実績から分からない天候、走行距離、運転の安全性、他人との比較を捏造しないでください。見出しやMarkdownは不要です。',
            input: JSON.stringify({
              durationMinutes: Math.round(summary.durationSeconds / 60),
              completedDeliveries: summary.completedDeliveries,
              pointsEarned: summary.pointsEarned,
            }),
          }),
        });
        if (!response.ok) return { ...unavailableReview };
        const data = await response.json();
        if (data.status !== 'completed') return { ...unavailableReview };
        const text = (data.output || []).filter((item) => item.type === 'message')
          .flatMap((item) => item.content || []).filter((item) => item.type === 'output_text')
          .map((item) => item.text).join('\n').replace(/\s+/gu, ' ').trim();
        // Never return provider diagnostics or an accidentally echoed credential.
        if (!text || text.includes(key)) return { ...unavailableReview };
        const characters = Array.from(text);
        const feedback = characters.length > 240 ? `${characters.slice(0, 239).join('')}…` : text;
        return { status: 'AVAILABLE', feedback };
      } catch {
        // Network errors can contain headers/provider bodies: do not log or expose them.
        return { ...unavailableReview };
      }
    },
  };
}

module.exports = { createShiftFeedback, unavailableReview };
