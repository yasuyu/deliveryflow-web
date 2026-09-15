(function registerRoutePreview(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.DeliveryFlowRoutePreview = api;
}(typeof globalThis === 'object' ? globalThis : this, () => {
  function escapeHtml(value) {
    return String(value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function formatDistance(meters) {
    if (meters === null || meters === undefined) return '現在地を更新';
    return meters < 1000 ? `約${Math.round(meters)}m` : `約${(meters / 1000).toFixed(1)}km`;
  }

  function renderRoutePreview(order, routeDistance = {}) {
    const locationAvailable = routeDistance.toPickupMeters !== null
      && routeDistance.toPickupMeters !== undefined;
    const unavailableClass = locationAvailable ? '' : ' route-preview__node--unavailable';
    const unavailableSegmentClass = locationAvailable ? '' : ' route-preview__segment--unavailable';
    return `<section class="route-preview" aria-labelledby="routePreviewHeading">
      <div class="route-preview__heading">
        <h3 id="routePreviewHeading">経路プレビュー</h3>
        <span>外部通信なし</span>
      </div>
      <div class="route-preview__track" role="img" aria-label="現在地から店舗を経由して届け先へ向かう模式図">
        <div class="route-preview__node${unavailableClass}"><span class="route-preview__dot">現在</span><b>現在地</b><small>${locationAvailable ? '更新済み' : '未更新'}</small></div>
        <div class="route-preview__segment${unavailableSegmentClass}"><span>${formatDistance(routeDistance.toPickupMeters)}</span></div>
        <div class="route-preview__node"><span class="route-preview__dot">受取</span><b>${escapeHtml(order.store.name)}</b><small>${escapeHtml(order.pickupName)}</small></div>
        <div class="route-preview__segment"><span>${formatDistance(routeDistance.pickupToDropoffMeters)}</span></div>
        <div class="route-preview__node route-preview__node--destination"><span class="route-preview__dot">完了</span><b>届け先</b><small>${escapeHtml(order.dropoffName)}</small></div>
      </div>
      <p class="route-preview__note">地点の順番と直線距離を示す模式図です。実際の道路形状や所要時間は表していません。</p>
    </section>`;
  }

  return { escapeHtml, formatDistance, renderRoutePreview };
}));
