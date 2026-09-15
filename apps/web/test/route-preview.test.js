const assert = require('node:assert/strict');
const test = require('node:test');
const { buildOsmDirectionsUrl, formatDistance, renderRoutePreview } = require('../public/route-preview');

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
  assert.doesNotMatch(html, /data-route-kind="current-pickup"/);
  assert.match(html, /data-route-kind="pickup-dropoff"/);
});

test('この画面で現在地を更新した場合だけ現在地からの外部経路ボタンを表示する', () => {
  const html = renderRoutePreview(order, {}, { canOpenCurrentRoute: true });
  assert.match(html, /data-route-kind="current-pickup"/);
  assert.match(html, /OpenStreetMapへ送信/);
});

test('OpenStreetMapの自動車向け経路URLを生成する', () => {
  const value = buildOsmDirectionsUrl(
    { latitude: 34.98, longitude: 135.96 },
    { latitude: 34.981, longitude: 135.962 },
  );
  const url = new URL(value);
  assert.equal(url.origin, 'https://www.openstreetmap.org');
  assert.equal(url.pathname, '/directions');
  assert.equal(url.searchParams.get('engine'), 'fossgis_osrm_car');
  assert.equal(url.searchParams.get('route'), '34.98,135.96;34.981,135.962');
  assert.throws(() => buildOsmDirectionsUrl(
    { latitude: 91, longitude: 135 },
    { latitude: 35, longitude: 135 },
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
