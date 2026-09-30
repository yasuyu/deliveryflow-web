const assert = require('node:assert/strict');
const test = require('node:test');
const {
  buildGoogleMapsDirectionsUrl,
  formatDistance,
  renderRoutePreview,
  routeAction,
} = require('../public/route-preview');

const order = {
  store: { name: 'BKC カフェ' },
  pickupName: 'BKC カフェ',
  dropoffName: 'プリズムハウス 1号館',
};

test('経路プレビューに地点の順番と直線距離を表示する', () => {
  const html = renderRoutePreview(order, {
    toPickupMeters: 850,
    pickupToDropoffMeters: 1250,
  });
  assert.match(html, /現在地/);
  assert.match(html, /BKC カフェ/);
  assert.match(html, /プリズムハウス 1号館/);
  assert.match(html, /約850m/);
  assert.match(html, /約1\.3km/);
  assert.match(html, /実際の道路形状や所要時間は表していません/);
});

test('現在地がない場合は更新案内を表示する', () => {
  const html = renderRoutePreview(order, { toPickupMeters: null, pickupToDropoffMeters: 500 });
  assert.match(html, /未更新/);
  assert.match(html, /現在地を更新/);
  assert.match(html, /route-preview__segment--unavailable/);
  assert.match(html, /data-route-kind="offer-preview"/);
});

test('配達段階に応じてGoogle Mapsの道路経路確認とナビを切り替える', () => {
  assert.equal(routeAction('OFFERING').kind, 'offer-preview');
  assert.equal(routeAction('ASSIGNED').kind, 'pickup-navigation');
  assert.equal(routeAction('PICKED_UP').kind, 'dropoff-navigation');
  assert.match(renderRoutePreview({ ...order, status: 'ASSIGNED' }), /店舗までGoogle Mapsでナビ/);
  assert.match(renderRoutePreview({ ...order, status: 'PICKED_UP' }), /配達先までGoogle Mapsでナビ/);
});

test('Google Mapsの経路確認URLとナビURLを現在地なしで生成する', () => {
  const value = buildGoogleMapsDirectionsUrl(
    { latitude: 34.981, longitude: 135.962 },
    { waypoint: { latitude: 34.98, longitude: 135.96 } },
  );
  const url = new URL(value);
  assert.equal(url.origin, 'https://www.google.com');
  assert.equal(url.pathname, '/maps/dir/');
  assert.equal(url.searchParams.get('api'), '1');
  assert.equal(url.searchParams.get('destination'), '34.981,135.962');
  assert.equal(url.searchParams.get('waypoints'), '34.98,135.96');
  assert.equal(url.searchParams.get('travelmode'), 'bicycling');
  assert.equal(url.searchParams.get('origin'), null);
  assert.equal(url.searchParams.get('dir_action'), null);

  const navigationUrl = new URL(buildGoogleMapsDirectionsUrl(
    { latitude: 35, longitude: 135 },
    { navigate: true },
  ));
  assert.equal(navigationUrl.searchParams.get('dir_action'), 'navigate');
  assert.equal(navigationUrl.searchParams.get('waypoints'), null);
  assert.throws(() => buildGoogleMapsDirectionsUrl(
    { latitude: 91, longitude: 135 },
  ), /座標が正しくありません/);
});

test('地点名をHTMLとして解釈させない', () => {
  const html = renderRoutePreview({
    store: { name: '<script>store</script>' },
    pickupName: '<b>pickup</b>',
    dropoffName: 'A&B',
  }, {});
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;store&lt;\/script&gt;/);
  assert.match(html, /&lt;b&gt;pickup&lt;\/b&gt;/);
  assert.match(html, /A&amp;B/);
});

test('距離の表示単位を切り替える', () => {
  assert.equal(formatDistance(999), '約999m');
  assert.equal(formatDistance(1000), '約1.0km');
  assert.equal(formatDistance(null), '現在地を更新');
});
