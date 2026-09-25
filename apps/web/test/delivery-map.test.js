const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { defaultCenter, orderPoints, routePlan } = require('../public/delivery-map');
const { renderCompactOrder } = require('../public/delivery-ui');

const order = {
  id: 1, pickupName: '三条ストア', dropoffName: '東山レジデンス', deliveryFeeYen: 877,
  store: { name: '三条ストア', latitude: 35.0093, longitude: 135.7684 },
  dropoffLatitude: 35.003, dropoffLongitude: 135.774,
};

test('地図は京都中心部から始め、注文の地点だけを扱う', () => {
  assert.deepEqual(defaultCenter, [35.005, 135.768]);
  assert.deepEqual(orderPoints(order), { pickup: [35.0093, 135.7684], dropoff: [35.003, 135.774] });
  assert.deepEqual(orderPoints(null), { pickup: null, dropoff: null });
  assert.deepEqual(orderPoints({ ...order, store: { latitude: null, longitude: '135' }, dropoffLatitude: Infinity }),
    { pickup: null, dropoff: null });
  assert.equal(orderPoints({ ...order, dropoffLatitude: 91 }).dropoff, null);
});

test('現在地と配達段階に合わせて地図上の直線を切り替える', () => {
  const current = { latitude: 35.012, longitude: 135.765 };
  const beforePickup = routePlan(order, current, false);
  assert.deepEqual(beforePickup.current, [35.012, 135.765]);
  assert.deepEqual(beforePickup.toPickupPath, [beforePickup.current, beforePickup.pickup]);
  assert.deepEqual(beforePickup.deliveryPath, [beforePickup.pickup, beforePickup.dropoff]);

  const afterPickup = routePlan(order, current, true);
  assert.deepEqual(afterPickup.toPickupPath, []);
  assert.deepEqual(afterPickup.deliveryPath, [afterPickup.pickup, afterPickup.dropoff]);

  const withoutLocation = routePlan(order, null, true);
  assert.deepEqual(withoutLocation.toPickupPath, []);
  assert.deepEqual(withoutLocation.deliveryPath, [withoutLocation.pickup, withoutLocation.dropoff]);
});

test('配達カードは実際の座標・報酬を表示し、注文名をHTMLとして扱わない', () => {
  const html = renderCompactOrder({ ...order, pickupName: '<img onerror=alert(1)>', dropoffName: 'A & B' });
  assert.match(html, /35.0093, 135.7684/);
  assert.match(html, /¥877/);
  assert.match(html, /&lt;img onerror=alert\(1\)&gt;/);
  assert.match(html, /A &amp; B/);
  assert.doesNotMatch(html, /<img/);
  assert.equal(renderCompactOrder(null), '');
});

test('地図通信は有効化後だけ開始し、更新で増殖せず、停止・再開できる', () => {
  const calls = { tiles: 0, fits: 0, views: 0, removed: 0, markers: [] };
  let canvasHeight = 500;
  const layer = { on() { return this; }, addTo() { return this; } };
  const map = { attributionControl: { setPrefix() {} }, fitBounds() { calls.fits++; },
    setView() { calls.views++; }, remove() { calls.removed++; }, invalidateSize() {} };
  const L = {
    map: () => map, control: { zoom: () => layer },
    tileLayer(url, options) { calls.tiles++; assert.equal(url, 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'); assert.equal(options.keepBuffer, 0); return layer; },
    layerGroup: () => ({ addTo() { return this; }, clearLayers() {} }),
    divIcon: options => options,
    marker(coords) { calls.markers.push(coords); return { bindTooltip: () => layer }; },
    polyline: () => layer,
  };
  const context = { window: { L, matchMedia: () => ({ matches: false }) },
    document: { createElement: () => ({ textContent: '' }) },
    ResizeObserver: class { observe() {} }, setTimeout, clearTimeout };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/delivery-map.js'), 'utf8'), context);
  const element = () => ({ classList: { add() {}, remove() {}, toggle() {} }, getBoundingClientRect: () => ({ height: canvasHeight }) });
  const controller = context.window.DeliveryFlowMap.create({
    canvas: element(), tools: element(), note: element(), error: element(), toggle: element(),
  });
  controller.update(order);
  assert.equal(calls.tiles, 0);
  assert.equal(controller.enable(), true);
  assert.equal(calls.tiles, 1);
  assert.equal(calls.markers.length, 2);
  controller.update({ ...order });
  controller.enable();
  assert.equal(calls.tiles, 1);
  assert.equal(calls.fits, 1);
  controller.disable();
  assert.equal(controller.isEnabled(), false);
  assert.equal(calls.removed, 1);
  canvasHeight = 100;
  controller.enable();
  assert.equal(calls.tiles, 2);
  assert.equal(calls.markers.length, 4);
  assert.equal(calls.views, 2, '短い地図領域で再開しても初期表示を設定する');
});
