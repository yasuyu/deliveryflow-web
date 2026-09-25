(function exposeOfflineActions(root) {
  const STORAGE_PREFIX = 'deliveryFlowOfflineActionsV1:';
  const MAX_QUEUE_LENGTH = 10;
  const definitions = {
    accept: { label: 'オファーの受諾', resource: 'offers', operation: 'accept' },
    pickup: { label: '荷物の受取', resource: 'assignments', operation: 'pickup' },
    complete: { label: '配達の完了', resource: 'assignments', operation: 'complete' },
  };

  function parseAction(action) {
    const match = /^(accept|pickup|complete):(\d+)$/.exec(String(action || ''));
    if (!match) return null;
    const [, kind, resourceId] = match;
    return { kind, resourceId, ...definitions[kind] };
  }

  function create(action, { idempotencyKey, now = Date.now() } = {}) {
    const parsed = parseAction(action);
    if (!parsed || typeof idempotencyKey !== 'string' || !idempotencyKey.trim()) return null;
    return {
      action: `${parsed.kind}:${parsed.resourceId}`,
      kind: parsed.kind,
      resourceId: parsed.resourceId,
      idempotencyKey: idempotencyKey.trim(),
      createdAt: new Date(now).toISOString(),
      status: 'pending',
      error: null,
    };
  }

  function endpoint(entry) {
    const parsed = parseAction(entry?.action);
    if (!parsed) throw new Error('送信待ち操作の形式が正しくありません。');
    return `/api/${parsed.resource}/${parsed.resourceId}/${parsed.operation}`;
  }

  function label(entry) {
    return definitions[entry?.kind]?.label || '配達操作';
  }

  function storageKey(driverId) {
    if (!/^\d+$/.test(String(driverId || ''))) throw new Error('配達員IDが必要です。');
    return `${STORAGE_PREFIX}${driverId}`;
  }

  function normalize(entry) {
    const parsed = parseAction(entry?.action);
    if (!parsed || typeof entry.idempotencyKey !== 'string' || !entry.idempotencyKey.trim()) return null;
    const createdAt = new Date(entry.createdAt);
    if (!Number.isFinite(createdAt.getTime())) return null;
    const status = entry.status === 'blocked' ? 'blocked' : 'pending';
    return {
      action: `${parsed.kind}:${parsed.resourceId}`,
      kind: parsed.kind,
      resourceId: parsed.resourceId,
      idempotencyKey: entry.idempotencyKey.trim(),
      createdAt: createdAt.toISOString(),
      status,
      error: status === 'blocked' && entry.error ? {
        code: String(entry.error.code || 'REQUEST_FAILED'),
        message: String(entry.error.message || 'サーバーの状態と一致しませんでした。'),
      } : null,
    };
  }

  function load(storage, driverId) {
    try {
      const stored = JSON.parse(storage.getItem(storageKey(driverId)) || '[]');
      if (!Array.isArray(stored)) return [];
      return stored.map(normalize).filter(Boolean).slice(0, MAX_QUEUE_LENGTH);
    } catch {
      return [];
    }
  }

  function save(storage, driverId, entries) {
    const normalized = entries.map(normalize).filter(Boolean).slice(0, MAX_QUEUE_LENGTH);
    if (normalized.length) storage.setItem(storageKey(driverId), JSON.stringify(normalized));
    else storage.removeItem(storageKey(driverId));
    return normalized;
  }

  function enqueue(storage, driverId, entries, entry) {
    const normalized = normalize(entry);
    if (!normalized) throw new Error('この操作はオフライン保存できません。');
    const existing = entries.find((item) => item.action === normalized.action);
    if (existing) return { entries: save(storage, driverId, entries), entry: existing, added: false };
    if (entries.length >= MAX_QUEUE_LENGTH) throw new Error('送信待ち操作が上限に達しました。接続後に再送してください。');
    const next = save(storage, driverId, [...entries, normalized]);
    return { entries: next, entry: normalized, added: true };
  }

  function errorDetails(error) {
    return {
      code: String(error?.code || 'REQUEST_FAILED'),
      message: String(error?.message || 'サーバーの状態と一致しませんでした。'),
    };
  }

  async function flush(entries, send) {
    const remaining = entries.map(normalize).filter(Boolean);
    const completed = [];
    while (remaining.length) {
      const current = remaining[0];
      if (current.status === 'blocked') return { completed, remaining, reason: 'blocked' };
      try {
        await send(current, endpoint(current));
        completed.push(current);
        remaining.shift();
      } catch (error) {
        if (error?.network === true) return { completed, remaining, reason: 'network' };
        remaining[0] = { ...current, status: 'blocked', error: errorDetails(error) };
        return { completed, remaining, reason: 'blocked' };
      }
    }
    return { completed, remaining, reason: 'complete' };
  }

  function retry(entries) {
    return entries.map((entry) => ({ ...entry, status: 'pending', error: null }));
  }

  const api = { create, endpoint, enqueue, flush, label, load, retry, save, storageKey };
  root.DeliveryFlowOfflineActions = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
}(typeof window === 'undefined' ? globalThis : window));
