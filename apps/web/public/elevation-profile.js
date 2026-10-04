(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DeliveryFlowElevation = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function formatHeight(value) { return `${value.toFixed(1)} m`; }
  function renderElevationProfile(profile) {
    const reasons = {
      LOCATION_MISSING: '現在地を更新すると標高を確認できます。',
      OUTSIDE_COVERAGE: 'この経路は京都中心部の標高データ対象外です。',
      ROUTE_NOT_FOUND: '対象範囲内で道路経路を取得できません。',
      ELEVATION_MISSING: 'この経路の標高データが不足しています。',
    };
    const attribution = '<p class="elevation-source">道路: <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">© OpenStreetMap contributors</a> · 標高: <a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener noreferrer">地理院タイルを加工</a></p>';
    if (!profile || profile.status !== 'AVAILABLE') {
      return `<section class="elevation-profile" aria-label="経路の標高"><h3>経路の標高</h3><p class="elevation-unavailable">${reasons[profile?.reason] || '標高データを取得できません。'}</p></section>`;
    }
    const { points, minimumMeters: min, maximumMeters: max, totalDistanceMeters: total } = profile;
    if (!points?.length || ![min, max, total, profile.pickupDistanceMeters].every(Number.isFinite)
      || total < 0 || max < min || points.some((point) => !Number.isFinite(point.distanceMeters) || !Number.isFinite(point.elevationMeters))) {
      return renderElevationProfile(null);
    }
    const range = Math.max(10, max - min);
    const bottom = (min + max - range) / 2;
    const x = (meters) => 12 + Math.min(1, Math.max(0, meters / Math.max(1, total))) * 296;
    const y = (height) => 94 - (height - bottom) / range * 80;
    const line = points.map((point) => `${x(point.distanceMeters).toFixed(2)},${y(point.elevationMeters).toFixed(2)}`).join(' ');
    const pickupX = x(profile.pickupDistanceMeters).toFixed(2);
    const stage = profile.stage === 'TO_DROPOFF' ? '店舗 → 配達先' : '現在地 → 店舗 → 配達先';
    const startLabel = profile.stage === 'TO_DROPOFF' ? '店舗' : '現在地';
    return `<section class="elevation-profile" aria-label="経路の標高">
      <header><h3>経路の標高</h3><span>${stage}</span></header>
      <div class="elevation-layout">
        <div class="elevation-chart">
          <svg viewBox="0 0 320 112" role="img" aria-label="${stage}の標高。最高${formatHeight(max)}、最低${formatHeight(min)}">
            <path class="elevation-grid" d="M12 14H308 M12 54H308 M12 94H308" />
            <text class="elevation-axis" x="12" y="11">${formatHeight(bottom + range)}</text>
            <text class="elevation-axis" x="12" y="108">${formatHeight(bottom)}</text>
            ${profile.stage === 'TO_DROPOFF' ? '' : `<path class="elevation-pickup" d="M${pickupX} 14V94" />`}
            <polyline class="elevation-line" points="${line}" />
          </svg>
          <div class="elevation-distance"><span class="elevation-stop"><strong>${startLabel}</strong><span>0 m</span></span>${profile.stage === 'TO_DROPOFF' ? '<span aria-hidden="true"></span>' : '<span class="elevation-legend">店舗</span>'}<span class="elevation-stop"><strong>配達先</strong><span>${(total / 1000).toFixed(2)} km</span></span></div>
        </div>
        <dl class="elevation-extrema"><div><dt>最高</dt><dd>${formatHeight(max)}</dd></div><div><dt>最低</dt><dd>${formatHeight(min)}</dd></div></dl>
      </div>
      <p class="elevation-note">京都中心部・地表の参考値 · スコア加算なし</p>
      ${attribution}
      <p class="elevation-caveat">橋・トンネルの路面標高や通行規制は対象外</p>
    </section>`;
  }
  return { renderElevationProfile };
});
