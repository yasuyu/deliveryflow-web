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

  function routePlan(order, currentLocation, pickedUp = false, offerPreview = false) {
    const points = orderPoints(order);
    const current = pickedUp ? null : point(currentLocation?.latitude, currentLocation?.longitude);
    const toPickupPath = !pickedUp && current && points.pickup ? [current, points.pickup] : [];
    const deliveryPath = (pickedUp || offerPreview) && points.pickup && points.dropoff
      ? [points.pickup, points.dropoff] : [];
    return { ...points, current, toPickupPath, deliveryPath };
  }

  function formatDistance(meters) {
    if (!Number.isFinite(meters)) return '';
    return meters < 1000 ? `約${Math.round(meters)}m` : `約${(meters / 1000).toFixed(1)}km`;
  }

  function visibleMapLayout(canvasRect = {}, sheetRect = null) {
    const width = Number(canvasRect.width) || 0;
    const height = Number(canvasRect.height) || 0;
    const top = Number.isFinite(canvasRect.top) ? canvasRect.top : 0;
    const bottom = Number.isFinite(canvasRect.bottom) ? canvasRect.bottom : top + height;
    const sheetTop = Number(sheetRect?.top);
    const overlap = width <= 700 && Number.isFinite(sheetTop)
      ? Math.min(height, Math.max(0, bottom - Math.max(top, sheetTop)))
      : 0;
    return {
      visibleHeight: Math.max(0, height - overlap),
      paddingBottom: Math.max(65, overlap + 65),
    };
  }

  function create({ canvas, sheet = null, consent = null, tools, note, error, toggle }) {
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
      const layout = visibleMapLayout(rect, sheet?.getBoundingClientRect());
      if (layout.visibleHeight < 190) return;
      const plan = routePlan(
        currentOrder,
        currentOptions.currentLocation,
        currentOptions.pickedUp,
        currentOptions.offerPreview,
      );
      const points = currentOptions.pickedUp
        ? [plan.pickup, plan.dropoff].filter(Boolean)
        : [plan.current, plan.pickup, ...(currentOptions.offerPreview ? [plan.dropoff] : [])].filter(Boolean);
      if (points.length) map.fitBounds(points, { paddingTopLeft: [rect.width > 700 ? 465 : 40, 105], paddingBottomRight: [70, layout.paddingBottom], maxZoom: 16, animate: false });
      else map.setView(defaultCenter, 15, { animate: false });
    }
    function update(order, options = {}) {
      currentOrder = order;
      currentOptions = options;
      if (!map) return;
      const plan = routePlan(order, options.currentLocation, options.pickedUp, options.offerPreview);
      const points = options.pickedUp
        ? { pickup: plan.pickup, dropoff: plan.dropoff }
        : { pickup: plan.pickup, ...(options.offerPreview ? { dropoff: plan.dropoff } : {}) };
      const key = JSON.stringify([order?.id, plan, options.toPickupMeters, options.pickupToDropoffMeters]);
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
      const routeNotes = [];
      const toPickupDistance = formatDistance(options.toPickupMeters);
      const deliveryDistance = formatDistance(options.pickupToDropoffMeters);
      if (plan.toPickupPath.length) {
        routeNotes.push(`灰色の点線: 現在地 → 店舗（直線${toPickupDistance ? ` ${toPickupDistance}` : ''}）`);
      }
      if (plan.deliveryPath.length) {
        routeNotes.push(`青い点線: 店舗 → 配達先（直線${deliveryDistance ? ` ${deliveryDistance}` : ''}）`);
      }
      note.textContent = routeNotes.join(' · ')
        || (plan.current ? '青い点: 更新した現在地' : '現在地を更新すると店舗までの直線を表示');
      note.classList.toggle('hidden', !plan.current && !points.pickup && !points.dropoff);
      overview();
    }
    function enable() {
      if (map) return true;
      if (!root.L) {
        error.textContent = '地図の表示機能を読み込めませんでした。ページを再読み込みしてください。';
        error.classList.remove('hidden');
        return false;
      }
      consent?.classList.add('hidden');
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
      return true;
    }
    function disable() {
      clearTimeout(resizeTimer);
      if (map) map.remove();
      map = layer = markers = null;
      previousKey = '';
      consent?.classList.remove('hidden');
      tools.classList.add('hidden');
      note.classList.add('hidden');
      error.classList.add('hidden');
      toggle.textContent = '実地図を再開する（外部通信）';
    }
    function scheduleRefit(delay = 180) {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (!map || !canvas.getBoundingClientRect().height) return;
        map.invalidateSize({ pan: false });
        if (showOverviewAfterResize) overview();
        showOverviewAfterResize = false;
      }, delay);
    }
    // Wait until layout changes settle before requesting tiles or refitting the route.
    new ResizeObserver(() => scheduleRefit()).observe(canvas);
    return { enable, disable, update, overview, isEnabled: () => Boolean(map),
      refitAfterResize: () => { showOverviewAfterResize = true; scheduleRefit(320); } };
  }
  const api = { defaultCenter, formatDistance, orderPoints, routePlan, visibleMapLayout, create };
  root.DeliveryFlowMap = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
}(typeof window === 'undefined' ? globalThis : window));
