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

  function validCoordinate(point) {
    return Number.isFinite(point?.latitude)
      && point.latitude >= -90 && point.latitude <= 90
      && Number.isFinite(point?.longitude)
      && point.longitude >= -180 && point.longitude <= 180;
  }

  function buildGoogleMapsDirectionsUrl(destination, options = {}) {
    if (!validCoordinate(destination)
      || (options.origin && !validCoordinate(options.origin))
      || (options.waypoint && !validCoordinate(options.waypoint))) {
      throw new TypeError('経路を開くための座標が正しくありません。');
    }
    const url = new URL('https://www.google.com/maps/dir/');
    url.searchParams.set('api', '1');
    if (options.origin) {
      url.searchParams.set('origin', `${options.origin.latitude},${options.origin.longitude}`);
    }
    url.searchParams.set('destination', `${destination.latitude},${destination.longitude}`);
    url.searchParams.set('travelmode', 'bicycling');
    if (options.waypoint) {
      url.searchParams.set('waypoints', `${options.waypoint.latitude},${options.waypoint.longitude}`);
    }
    if (options.navigate) url.searchParams.set('dir_action', 'navigate');
    return url.toString();
  }

  function routeAction(status) {
    if (status === 'PICKED_UP') {
      return {
        kind: 'dropoff-navigation',
        label: '配達先までGoogle Mapsでナビ',
        description: '店舗と配達先のデモ座標をGoogle Mapsへ送信し、店舗から配達先へのナビを開きます。',
      };
    }
    if (status === 'ASSIGNED') {
      return {
        kind: 'pickup-navigation',
        label: '店舗までの経路をGoogle Mapsで開く',
        description: 'デモ位置の利用中は京都市役所付近から、端末位置の利用中はGoogle Maps側の現在地から店舗までの経路を開きます。スマートフォンではGoogle Mapsアプリからナビを開始できます。',
      };
    }
    return {
      kind: 'offer-preview',
      label: 'Google Mapsで道路経路を確認',
      description: 'デモ位置の利用中は京都市役所付近を出発地にし、店舗を経由して配達先へ向かう道路経路を開きます。',
    };
  }

  function renderRoutePreview(order, routeDistance = {}) {
    const locationAvailable = routeDistance.toPickupMeters !== null
      && routeDistance.toPickupMeters !== undefined;
    const unavailableClass = locationAvailable ? '' : ' route-preview__node--unavailable';
    const unavailableSegmentClass = locationAvailable ? '' : ' route-preview__segment--unavailable';
    const action = routeAction(order.status);
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
      <p class="route-preview__note">上の図は地点の順番と直線距離を示す模式図です。実際の道路形状や所要時間は表していません。</p>
      <div class="route-preview__external">
        <h4>道路経路とナビ</h4>
        <p>${action.description}</p>
        <button type="button" data-route-kind="${action.kind}">${action.label}</button>
        <small>端末や位置情報の状態によっては、ナビではなく経路プレビューが開きます。</small>
      </div>
    </section>`;
  }

  return {
    buildGoogleMapsDirectionsUrl,
    escapeHtml,
    formatDistance,
    renderRoutePreview,
    routeAction,
    validCoordinate,
  };
}));
