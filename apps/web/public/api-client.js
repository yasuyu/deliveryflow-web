(function expose(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DeliveryFlowApi = api;
}(typeof globalThis === 'object' ? globalThis : this, () => {
  const timeoutMs = 30_000;

  function networkError(code, cause) {
    const error = new Error(code === 'REQUEST_TIMEOUT'
      ? '通信が30秒以内に完了しませんでした。接続を確認し、しばらくして再試行してください。'
      : '通信結果を確認できませんでした。接続を確認して再試行してください。');
    error.code = code;
    error.network = true;
    error.cause = cause;
    return error;
  }

  // The deadline covers the response body as well as the response headers.
  async function readJson(url, options = {}, { deadline = Date.now() + timeoutMs, fetchImpl = globalThis.fetch } = {}) {
    if (deadline <= Date.now()) throw networkError('REQUEST_TIMEOUT');
    const controller = new AbortController();
    let timer;
    const expiry = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        reject(networkError('REQUEST_TIMEOUT'));
        controller.abort();
      }, Math.max(0, deadline - Date.now()));
    });
    try {
      return await Promise.race([
        (async () => {
          const response = await fetchImpl(url, { ...options, signal: controller.signal });
          const data = await response.json();
          return { response, data };
        })(),
        expiry,
      ]);
    } catch (error) {
      if (error.network) throw error;
      if (error instanceof TypeError || error instanceof SyntaxError) throw networkError('NETWORK_ERROR', error);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  function createPostClient({ getToken, makeKey = () => crypto.randomUUID(), read = readJson }) {
    // Unconfirmed keys stay in memory; the delivery queue owns durable retries.
    const pending = new Map();
    const identity = (url, body) => JSON.stringify([getToken(), url, body]);
    function keyFor(url, body = null) {
      const id = identity(url, body);
      if (!pending.has(id)) pending.set(id, makeKey());
      return pending.get(id);
    }
    async function post(url, body = null, { idempotencyKey = keyFor(url, body) } = {}) {
      const id = identity(url, body);
      pending.set(id, idempotencyKey);
      try {
        const { response, data } = await read(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${getToken()}`,
            'Idempotency-Key': idempotencyKey,
            ...(body ? { 'Content-Type': 'application/json' } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
        if (!response.ok) {
          const error = new Error(data.message || 'リクエストを処理できませんでした。');
          error.code = data.code || 'REQUEST_FAILED';
          error.status = response.status;
          throw error;
        }
        pending.delete(id);
        return data;
      } catch (error) {
        if (!error.network) pending.delete(id);
        throw error;
      }
    }
    return { post, keyFor, clear: () => pending.clear() };
  }

  return { timeoutMs, readJson, createPostClient };
}));
