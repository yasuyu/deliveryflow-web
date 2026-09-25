(function attachDeliveryUi(root) {
  const rendered = new WeakMap();
  function escapeHtml(value) {
    return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;');
  }

  function getActionView(state, now = Date.now()) {
    const view = { guidance: '今日の配達を始めましょう', destination: '準備ができたら稼働を開始してください。',
      primary: { label: '稼働を開始する', action: 'start' }, secondary: [], deadline: '', expired: false };
    if (state.assignment) {
      const { order, id, pickedUpAt } = state.assignment;
      return { ...view,
        guidance: pickedUpAt ? '配達先へ向かってください' : '店舗へ向かってください',
        destination: pickedUpAt ? order.dropoffName : order.store.name === order.pickupName
          ? order.store.name : `${order.store.name} · ${order.pickupName}`,
        primary: pickedUpAt
          ? { label: '配達完了しました', action: `complete:${id}` }
          : { label: '受け取りました', action: `pickup:${id}` },
      };
    }
    if (state.driver.status === 'OFFERED' && state.offer) {
      const { id, order, expiresAt } = state.offer;
      const timestamp = expiresAt ? new Date(expiresAt).getTime() : NaN;
      const expires = Number.isFinite(timestamp) ? timestamp : null;
      const expired = expires !== null && Number.isFinite(expires) && expires <= now;
      const deadline = expires === null ? '期限なし' : expired ? 'オファー期限切れ'
        : `期限 ${new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(expires)}`;
      return { ...view, guidance: expired ? '最新のオファーを確認してください' : 'この配達を引き受けますか？',
        destination: `${order.store.name} → ${order.dropoffName}`, deadline, expired,
        primary: expired ? { label: '最新の状況を確認する', action: 'refresh' }
          : { label: 'この配達を受諾する', action: `accept:${id}` },
        secondary: expired ? [] : [
          { label: '辞退する', action: `reject:${id}` },
          { label: '辞退して退勤', action: 'end' },
        ],
      };
    }
    if (state.driver.status === 'IDLE') {
      return { ...view, guidance: '新しいオファーを確認しましょう',
        destination: state.location?.status === 'MISSING'
          ? '設定から現在地を更新すると、店舗までの距離を確認できます。'
          : 'オファーの料金と行き先を確認して、配達を選べます。',
        primary: { label: 'オファーを確認する', action: 'offer' },
        secondary: [{ label: '退勤する', action: 'end' }],
      };
    }
    return view;
  }

  function renderActions(view, { loading = false } = {}) {
    const button = (item, primary = false) => `<button type="button" class="${primary ? 'action-primary' : 'button-secondary'}" data-action="${escapeHtml(item.action)}"${loading ? ' disabled' : ''}>${escapeHtml(item.label)}</button>`;
    return button(view.primary, true) + (view.secondary.length
      ? `<div class="action-secondary">${view.secondary.map((item) => button(item)).join('')}</div>` : '');
  }

  // Avoid replacing stable controls on every WebSocket or polling refresh.
  function updateMarkup(element, markup, key = '') {
    const previous = rendered.get(element);
    if (previous?.markup === markup && previous.key === String(key)) return;
    const sameItem = previous?.key === String(key);
    const open = sameItem && element.querySelector('details')?.open;
    const active = element.ownerDocument.activeElement;
    const focusKey = element.contains(active) && sameItem
      ? active.dataset.action || active.dataset.routeKind || (active.tagName === 'SUMMARY' ? 'summary' : null)
      : null;
    element.innerHTML = markup;
    rendered.set(element, { markup, key: String(key) });
    if (open && element.querySelector('details')) element.querySelector('details').open = true;
    if (focusKey) {
      const next = [...element.querySelectorAll('button, summary')].find((item) => (
        (item.dataset.action || item.dataset.routeKind || 'summary') === focusKey
      ));
      if (next && !next.disabled) next.focus({ preventScroll: true });
    }
  }

  function renderCompactOrder(order) {
    if (!order) return '';
    const coordinate = (lat, lng) => typeof lat === 'number' && typeof lng === 'number'
      && Number.isFinite(lat) && Number.isFinite(lng)
      ? lat.toFixed(4) + ', ' + lng.toFixed(4) : '座標未設定';
    const icon = (name) => '<svg class="ui-icon" aria-hidden="true"><use href="#icon-' + name + '"/></svg>';
    const row = (name, label, value, sub = '') => '<div class="compact-delivery__row"><dt>' + icon(name) + '<span>' + label
      + '</span></dt><dd><strong>' + escapeHtml(value) + '</strong>' + (sub ? '<small>' + escapeHtml(sub) + '</small>' : '') + '</dd></div>';
    return '<dl>' + row('store', '受け取り場所', order.pickupName || order.store.name, coordinate(order.store.latitude, order.store.longitude))
      + row('pin', '配達先', order.dropoffName, coordinate(order.dropoffLatitude, order.dropoffLongitude))
      + row('yen', '報酬', '¥' + Number(order.deliveryFeeYen).toLocaleString('ja-JP')) + '</dl>';
  }

  const rankingPeriods = ['monthly', 'current', 'lifetime'];
  function nextRankingPeriod(current, key) {
    const currentIndex = Math.max(0, rankingPeriods.indexOf(current));
    if (key === 'Home') return rankingPeriods[0];
    if (key === 'End') return rankingPeriods.at(-1);
    if (key === 'ArrowLeft') return rankingPeriods[(currentIndex - 1 + rankingPeriods.length) % rankingPeriods.length];
    if (key === 'ArrowRight') return rankingPeriods[(currentIndex + 1) % rankingPeriods.length];
    return rankingPeriods[currentIndex];
  }

  const api = {
    escapeHtml, getActionView, renderActions, updateMarkup, renderCompactOrder, nextRankingPeriod,
  };
  root.DeliveryFlowUi = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
}(typeof window === 'undefined' ? globalThis : window));
