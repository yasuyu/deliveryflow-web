(function attachDeliveryMap(root) {
  // Kyoto city centre. Stored orders keep their own coordinates, including older demos.
  const defaultCenter = [35.005, 135.768];
  function point(latitude, longitude) {
    return typeof latitude === 'number' && typeof longitude === 'number'
      && Number.isFinite(latitude) && Number.isFinite(longitude)
      && Math.abs(latitude) <= 85 && Math.abs(longitude) <= 180
      ? [latitude, longitude] : null;
  }
  function orderPoints(order) {
    return {
      pickup: point(order?.store?.latitude, order?.store?.longitude),
      dropoff: point(order?.dropoffLatitude, order?.dropoffLongitude),
    };
  }

  function routePlan(order, currentLocation, pickedUp = false) {
    const points = orderPoints(order);
    const current = point(currentLocation?.latitude, currentLocation?.longitude);
    const toPickupPath = !pickedUp && current && points.pickup ? [current, points.pickup] : [];
    const deliveryPath = points.pickup && points.dropoff
      ? [points.pickup, points.dropoff] : [];
    return { ...points, current, toPickupPath, deliveryPath };
  }

  function formatDistance(meters) {
    if (!Number.isFinite(meters)) return '';
    return meters < 1000 ? `約${Math.round(meters)}m` : `約${(meters / 1000).toFixed(1)}km`;
  }

  function create({ canvas, consent, tools, note, error, toggle }) {
    let map = null;
    let layer = null;
    let markers = null;
    let currentOrder = null;
    let currentOptions = {};
    let previousKey = '';
    let resizeTimer;
    let hasTileError = false;
    let showOverviewAfterResize = true;
    function overview() {
      if (!map) return;
      const rect = canvas.getBoundingClientRect();
      if (rect.height < 190) return;
      const plan = routePlan(currentOrder, currentOptions.currentLocation, currentOptions.pickedUp);
      const points = [
        ...(!currentOptions.pickedUp ? [plan.current] : []),
        plan.pickup,
        plan.dropoff,
      ].filter(Boolean);
      if (points.length) map.fitBounds(points, { paddingTopLeft: [rect.width > 700 ? 465 : 40, 105], paddingBottomRight: [70, 65], maxZoom: 16, animate: false });
      else map.setView(defaultCenter, 15, { animate: false });
    }
    function update(order, options = {}) {
      currentOrder = order;
      currentOptions = options;
      if (!map) return;
      const plan = routePlan(order, options.currentLocation, options.pickedUp);
      const points = { pickup: plan.pickup, dropoff: plan.dropoff };
      const key = JSON.stringify([order?.id, plan, options.pickupToDropoffMeters]);
      if (key === previousKey) return;
      previousKey = key;
      markers.clearLayers();
      if (plan.current) {
        const label = '現在地';
        const icon = root.L.divIcon({
          className: 'delivery-map-marker delivery-map-marker--current',
          html: '<span class="delivery-map-current-dot" aria-hidden="true"></span>',
          iconSize: [38, 38], iconAnchor: [19, 19],
        });
        root.L.marker(plan.current, { icon, title: label, alt: label })
          .bindTooltip(label).addTo(markers);
      }
      for (const [kind, coords] of Object.entries(points)) {
        if (!coords) continue;
        const label = kind === 'pickup' ? '受取場所' : '配達先';
        const icon = root.L.divIcon({
          className: 'delivery-map-marker delivery-map-marker--' + kind,
          html: '<svg class="ui-icon" aria-hidden="true"><use href="#icon-' + (kind === 'pickup' ? 'store' : 'pin') + '"/></svg>',
          iconSize: [38, 38], iconAnchor: [19, 19],
        });
        const tooltip = document.createElement('span');
        tooltip.textContent = label + ' · ' + (kind === 'pickup' ? order.store.name : order.dropoffName);
        root.L.marker(coords, { icon, title: tooltip.textContent, alt: label }).bindTooltip(tooltip).addTo(markers);
      }
      if (plan.toPickupPath.length) {
        root.L.polyline(plan.toPickupPath, { color: '#78958c', weight: 3, dashArray: '7 9', interactive: false }).addTo(markers);
      }
      if (plan.deliveryPath.length) {
        root.L.polyline(plan.deliveryPath, { color: '#2877c7', weight: 5, dashArray: '8 8', interactive: false }).addTo(markers);
      }
      const deliveryDistance = formatDistance(options.pickupToDropoffMeters);
      note.textContent = plan.deliveryPath.length
        ? `青い点線: 店舗 → 配達先（直線${deliveryDistance ? ` ${deliveryDistance}` : ''}）${plan.toPickupPath.length ? ' · 灰色: 現在地 → 店舗' : ''}`
        : plan.current ? '青い点: 更新した現在地' : '点線は直線 · 現在地を更新すると地図に表示';
      note.classList.toggle('hidden', !plan.current && !points.pickup && !points.dropoff);
      overview();
    }
    function enable() {
      if (map) return;
      if (!root.L) {
        error.textContent = '地図の表示機能を読み込めませんでした。ページを再読み込みしてください。';
        error.classList.remove('hidden');
        return;
      }
      consent.classList.add('hidden');
      tools.classList.remove('hidden');
      toggle.textContent = '地図の通信を停止する';
      const reducedMotion = root.matchMedia('(prefers-reduced-motion: reduce)').matches;
      map = root.L.map(canvas, { zoomControl: false, zoomAnimation: !reducedMotion, fadeAnimation: !reducedMotion, markerZoomAnimation: !reducedMotion });
      // Keep a valid initial view even while an expanded sheet is collapsing.
      map.setView(defaultCenter, 15, { animate: false });
      map.attributionControl.setPrefix(false);
      root.L.control.zoom({ position: 'bottomright', zoomInTitle: '拡大', zoomOutTitle: '縮小' }).addTo(map);
      // Browser caching and Referer are retained. No bulk/offline prefetch or current-location data.
      layer = root.L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors',
        minZoom: 5, maxZoom: 19, keepBuffer: 0, updateWhenIdle: true,
        referrerPolicy: 'strict-origin-when-cross-origin',
      });
      layer.on('loading', () => { hasTileError = false; });
      layer.on('tileerror', () => {
        hasTileError = true;
        error.textContent = '地図を読み込めません。接続を確認してください。配達操作は引き続き使えます。';
        error.classList.remove('hidden');
      });
      layer.on('load', () => { if (!hasTileError) error.classList.add('hidden'); });
      markers = root.L.layerGroup().addTo(map);
      previousKey = '';
      update(currentOrder, currentOptions);
      layer.addTo(map);
    }
    function disable() {
      clearTimeout(resizeTimer);
      if (map) map.remove();
      map = layer = markers = null;
      previousKey = '';
      consent.classList.remove('hidden');
      tools.classList.add('hidden');
      note.classList.add('hidden');
      error.classList.add('hidden');
      toggle.textContent = '実地図を表示する（外部通信）';
    }
    // Wait until the sheet settles before requesting tiles for the resized viewport.
    new ResizeObserver(() => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (!map || !canvas.getBoundingClientRect().height) return;
        map.invalidateSize({ pan: false });
        if (showOverviewAfterResize) overview();
        showOverviewAfterResize = false;
      }, 180);
    }).observe(canvas);
    return { enable, disable, update, overview, isEnabled: () => Boolean(map),
      refitAfterResize: () => { showOverviewAfterResize = true; } };
  }
  const api = { defaultCenter, formatDistance, orderPoints, routePlan, create };
  root.DeliveryFlowMap = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
}(typeof window === 'undefined' ? globalThis : window));
