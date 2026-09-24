const statusText = {
  OFFLINE: '退勤中',
  IDLE: 'オファー待機中',
  OFFERED: 'オファー確認中',
  BUSY: '配達中',
};

const message = document.querySelector('#message');
const registrationMessage = document.querySelector('#registrationMessage');
const actions = document.querySelector('#actions');
const detail = document.querySelector('#deliveryDetail');
const card = document.querySelector('#deliveryCard');
const registrationCard = document.querySelector('#registrationCard');
const registrationForm = document.querySelector('#registrationForm');
const loginForm = document.querySelector('#loginForm');
const authTabs = document.querySelectorAll('[data-auth-view]');
const loginPanel = document.querySelector('#loginPanel');
const registrationPanel = document.querySelector('#registrationPanel');
const workflow = document.querySelector('#workflow');
const shiftCard = document.querySelector('#shiftCard');
const completedDeliveryCount = document.querySelector('#completedDeliveryCount');
const lastDeliveredAt = document.querySelector('#lastDeliveredAt');
const deliveryHistoryList = document.querySelector('#deliveryHistory');
const historyFilterForm = document.querySelector('#historyFilterForm');
const historyFilterReset = document.querySelector('#historyFilterReset');
const historyResultCount = document.querySelector('#historyResultCount');
const currentScore = document.querySelector('#currentScore');
const lifetimeScore = document.querySelector('#lifetimeScore');
const scoreEvents = document.querySelector('#scoreEvents');
const currentTitle = document.querySelector('#currentTitle');
const nextTitle = document.querySelector('#nextTitle');
const titleProgress = document.querySelector('#titleProgress');
const monthlyRankingList = document.querySelector('#monthlyRanking');
const currentRankingList = document.querySelector('#currentRanking');
const lifetimeRankingList = document.querySelector('#lifetimeRanking');
const currentRankingMe = document.querySelector('#currentRankingMe');
const lifetimeRankingMe = document.querySelector('#lifetimeRankingMe');
const monthlyRankingMe = document.querySelector('#monthlyRankingMe');
const weatherSimulatorForm = document.querySelector('#weatherSimulatorForm');
const weatherCondition = document.querySelector('#weatherCondition');
const weatherSimulatorStatus = document.querySelector('#weatherSimulatorStatus');
const updateLocationButton = document.querySelector('#updateLocation');
const locationStatusElement = document.querySelector('#locationStatus');
const realtimeStatus = document.querySelector('#realtimeStatus');
const bottomSheet = document.querySelector('#bottomSheet');
const bottomSheetHandle = document.querySelector('#bottomSheetHandle');
const bottomSheetHandleLabel = document.querySelector('#bottomSheetHandleLabel');
const sheetContent = document.querySelector('#sheetContent');
const sheetTabs = document.querySelectorAll('[data-sheet-view]');
const logoutButton = document.querySelector('#logoutButton');
const actionGuidance = document.querySelector('#actionGuidance');
const actionDestination = document.querySelector('#actionDestination');
const offerDeadline = document.querySelector('#offerDeadline');
const compactDelivery = document.querySelector('#compactDelivery');
const deliveryMap = DeliveryFlowMap.create({
  canvas: document.querySelector('#deliveryMap'), consent: document.querySelector('#mapConsent'),
  tools: document.querySelector('#mapTools'), note: document.querySelector('#mapNote'),
  error: document.querySelector('#mapError'), toggle: document.querySelector('#toggleMap'),
});
document.querySelector('#enableMap').addEventListener('click', () => deliveryMap.enable());
document.querySelector('#fitMap').addEventListener('click', () => deliveryMap.overview());
document.querySelector('#toggleMap').addEventListener('click', () => {
  if (deliveryMap.isEnabled()) {
    deliveryMap.disable();
    return;
  }
  setSheetView('delivery');
  setBottomSheetState('collapsed');
  deliveryMap.enable();
  bottomSheetHandle.focus({ preventScroll: true });
});
let sheetView = 'delivery';
let currentDeliveryKey = null;
let offerHasExpired = false;
const sheetScrollPositions = { delivery: 0, activity: 0, settings: 0 };
let driverToken = localStorage.getItem('deliveryFlowAccessToken');
let authView = localStorage.getItem('deliveryFlowDriverId') ? 'login' : 'register';
let state;
let currentBrowserLocation = null;
let displayedOrder = null;
let historyState = { summary: { completedDeliveries: 0, lastDeliveredAt: null }, deliveries: [] };
let scoreState = {
  currentScore: 0,
  lifetimeScore: 0,
  windowDays: 14,
  title: { current: { name: 'ルーキー' }, next: null, progressPercent: 0 },
  recentEvents: [],
};
let rankingState = {
  monthly: { leaders: [], me: null },
  current: { leaders: [], me: null },
  lifetime: { leaders: [], me: null },
};
let isLoading = false;
let realtimeSocket = null;
let realtimeReconnectTimer = null;
let realtimeReconnectAttempt = 0;
let lastRealtimeSequence = -1;
let realtimeRefreshQueued = false;
let lastSuccessfulRefreshAt = 0;
let pageIsUnloading = false;
let refreshPromise = null;
let bottomSheetState = 'collapsed';
let bottomSheetDrag = null;
let suppressBottomSheetClick = false;

function bottomSheetSnapHeights() {
  const viewportHeight = window.visualViewport?.height || window.innerHeight;
  return DeliveryFlowBottomSheet.calculateSnapHeights(viewportHeight, {
    mobile: window.matchMedia('(max-width: 700px), (max-height: 520px)').matches,
    minimumContentHeight: Math.ceil(Math.max(shiftCard.scrollHeight + 1, shiftCard.getBoundingClientRect().height)
      + bottomSheetHandle.getBoundingClientRect().height + 2),
  });
}

function setBottomSheetState(nextState, { announce = false } = {}) {
  const snapHeights = bottomSheetSnapHeights();
  bottomSheetState = nextState;
  bottomSheet.style.setProperty('--sheet-height', `${snapHeights[nextState]}px`);
  bottomSheet.dataset.sheetState = nextState;
  workflow.dataset.sheetState = nextState;
  deliveryMap.refitAfterResize();
  bottomSheetHandle.setAttribute('aria-expanded', String(nextState !== 'collapsed'));
  const labels = {
    collapsed: '上にドラッグして詳細を表示',
    medium: '上下にドラッグして表示範囲を調整',
    expanded: '下にドラッグして地図を広く表示',
  };
  bottomSheetHandleLabel.textContent = labels[nextState];
  bottomSheetHandle.setAttribute('aria-label', `${labels[nextState]}。クリックでも切り替え、上下キーで調整できます`);
  const navigation = document.querySelector('#sheetNavigation');
  const focusIsInContent = sheetContent.contains(document.activeElement) || navigation.contains(document.activeElement);
  navigation.inert = nextState === 'collapsed';
  sheetContent.inert = nextState === 'collapsed';
  if (announce || (nextState === 'collapsed' && focusIsInContent)) bottomSheetHandle.focus({ preventScroll: true });
}

function finishBottomSheetDrag(event) {
  if (!bottomSheetDrag || event.pointerId !== bottomSheetDrag.pointerId) return;
  const { startY, startState, currentHeight } = bottomSheetDrag;
  const movement = startY - event.clientY;
  let nextState = DeliveryFlowBottomSheet.nearestState(currentHeight, bottomSheetSnapHeights());
  if (Math.abs(movement) > 48) {
    nextState = DeliveryFlowBottomSheet.adjacentState(startState, movement > 0 ? 1 : -1);
  }
  suppressBottomSheetClick = bottomSheetDrag.moved;
  if (bottomSheetHandle.hasPointerCapture(event.pointerId)) {
    bottomSheetHandle.releasePointerCapture(event.pointerId);
  }
  bottomSheetDrag = null;
  setBottomSheetState(nextState);
}

bottomSheetHandle.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  const startHeight = bottomSheet.getBoundingClientRect().height;
  bottomSheetDrag = {
    pointerId: event.pointerId,
    startY: event.clientY,
    startHeight,
    currentHeight: startHeight,
    startState: bottomSheetState,
    moved: false,
  };
  bottomSheetHandle.setPointerCapture(event.pointerId);
  bottomSheet.dataset.sheetState = 'dragging';
});

bottomSheetHandle.addEventListener('pointermove', (event) => {
  if (!bottomSheetDrag || event.pointerId !== bottomSheetDrag.pointerId) return;
  const snapHeights = bottomSheetSnapHeights();
  const movement = bottomSheetDrag.startY - event.clientY;
  const height = Math.min(
    snapHeights.expanded,
    Math.max(snapHeights.collapsed, bottomSheetDrag.startHeight + movement),
  );
  bottomSheetDrag.currentHeight = height;
  bottomSheetDrag.moved ||= Math.abs(movement) > 6;
  bottomSheet.style.setProperty('--sheet-height', `${height}px`);
});

bottomSheetHandle.addEventListener('pointerup', finishBottomSheetDrag);
bottomSheetHandle.addEventListener('pointercancel', finishBottomSheetDrag);

bottomSheetHandle.addEventListener('click', () => {
  if (suppressBottomSheetClick) {
    suppressBottomSheetClick = false;
    return;
  }
  const nextState = bottomSheetState === 'collapsed' ? 'medium'
    : bottomSheetState === 'medium' ? 'expanded' : 'collapsed';
  setBottomSheetState(nextState, { announce: true });
});

bottomSheetHandle.addEventListener('keydown', (event) => {
  if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  if (event.key === 'Home') setBottomSheetState('collapsed', { announce: true });
  else if (event.key === 'End') setBottomSheetState('expanded', { announce: true });
  else setBottomSheetState(DeliveryFlowBottomSheet.adjacentState(
    bottomSheetState,
    event.key === 'ArrowUp' ? 1 : -1,
  ), { announce: true });
});

window.addEventListener('resize', () => setBottomSheetState(bottomSheetState));
window.visualViewport?.addEventListener('resize', () => setBottomSheetState(bottomSheetState));
new ResizeObserver(() => {
  if (!bottomSheetDrag && !workflow.classList.contains('hidden')) setBottomSheetState(bottomSheetState);
}).observe(shiftCard);
new ResizeObserver(() => {
  workflow.style.setProperty('--visible-sheet-height', `${Math.ceil(bottomSheet.getBoundingClientRect().height)}px`);
}).observe(bottomSheet);

function setSheetView(view, { focus = false } = {}) {
  sheetScrollPositions[sheetView] = sheetContent.scrollTop;
  sheetView = view;
  bottomSheet.dataset.sheetView = view;
  sheetTabs.forEach((tab) => {
    const selected = tab.dataset.sheetView === view;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    document.getElementById(tab.getAttribute('aria-controls')).classList.toggle('hidden', !selected);
    if (selected && focus) tab.focus({ preventScroll: true });
  });
  sheetContent.scrollTop = sheetScrollPositions[view];
}

sheetTabs.forEach((tab, index) => {
  tab.addEventListener('click', () => setSheetView(tab.dataset.sheetView));
  tab.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? sheetTabs.length - 1
      : (index + (event.key === 'ArrowRight' ? 1 : -1) + sheetTabs.length) % sheetTabs.length;
    setSheetView(sheetTabs[next].dataset.sheetView, { focus: true });
  });
});
document.querySelector('[data-open-settings]').addEventListener('click', () => setSheetView('settings', { focus: true }));
document.querySelectorAll('[data-open-view]').forEach((button) => {
  button.addEventListener('click', () => {
    setBottomSheetState('expanded');
    setSheetView(button.dataset.openView, { focus: true });
  });
});

function setMessage(text, kind = 'info', source = 'action') {
  message.textContent = text;
  message.className = `message message--${kind}`;
  message.hidden = !text;
  message.dataset.source = source;
}

function setRegistrationMessage(text = '') {
  registrationMessage.textContent = text;
  registrationMessage.classList.toggle('hidden', !text);
}

function setLoading(loading) {
  isLoading = loading;
  document.querySelectorAll('[data-action], button[type="submit"], #updateLocation, #historyFilterReset').forEach((element) => {
    element.disabled = loading || element.dataset.alwaysDisabled === 'true';
  });
  actions.setAttribute('aria-busy', String(loading));
  if (!loading && realtimeRefreshQueued && !refreshPromise) {
    realtimeRefreshQueued = false;
    queueMicrotask(() => refresh({ preserveMessage: true }));
  }
}

function setRealtimeStatus(status) {
  const labels = {
    connecting: 'リアルタイム接続中…',
    connected: 'リアルタイム接続',
    fallback: '自動更新で再接続中',
  };
  realtimeStatus.textContent = labels[status] || labels.fallback;
  realtimeStatus.dataset.status = status;
  realtimeStatus.classList.toggle('hidden', !driverToken);
}

function realtimeUrl() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/api/realtime`;
}

function queueRealtimeRefresh() {
  if (isLoading) {
    realtimeRefreshQueued = true;
    return;
  }
  refresh({ preserveMessage: true });
}

function scheduleRealtimeReconnect() {
  if (!driverToken || pageIsUnloading || realtimeReconnectTimer) return;
  const delay = Math.min(30_000, 1_000 * (2 ** realtimeReconnectAttempt));
  realtimeReconnectAttempt += 1;
  setRealtimeStatus('fallback');
  realtimeReconnectTimer = setTimeout(() => {
    realtimeReconnectTimer = null;
    connectRealtime();
  }, delay);
}

function disconnectRealtime() {
  clearTimeout(realtimeReconnectTimer);
  realtimeReconnectTimer = null;
  const socket = realtimeSocket;
  realtimeSocket = null;
  if (socket && socket.readyState < WebSocket.CLOSING) socket.close(1000, 'Client closed');
  realtimeStatus.classList.add('hidden');
}

function connectRealtime() {
  if (!driverToken || pageIsUnloading) return;
  if (realtimeSocket && realtimeSocket.readyState <= WebSocket.OPEN) return;

  setRealtimeStatus('connecting');
  const socket = new WebSocket(realtimeUrl(), [
    'deliveryflow.realtime.v1',
    `auth.${driverToken}`,
  ]);
  realtimeSocket = socket;

  socket.addEventListener('open', () => {
    if (socket !== realtimeSocket) return;
    realtimeReconnectAttempt = 0;
    setRealtimeStatus('connected');
  });

  socket.addEventListener('message', (event) => {
    if (socket !== realtimeSocket) return;
    try {
      const realtimeEvent = JSON.parse(event.data);
      if (!Number.isInteger(realtimeEvent.sequence)) return;
      if (realtimeEvent.type === 'realtime.connected') {
        lastRealtimeSequence = realtimeEvent.sequence;
        return;
      }
      if (realtimeEvent.sequence <= lastRealtimeSequence) return;
      lastRealtimeSequence = realtimeEvent.sequence;
      if (realtimeEvent.type === 'state.changed') queueRealtimeRefresh();
    } catch {
      socket.close(1003, 'Invalid event');
    }
  });

  socket.addEventListener('close', () => {
    if (socket !== realtimeSocket) return;
    realtimeSocket = null;
    scheduleRealtimeReconnect();
  });

  socket.addEventListener('error', () => {
    if (socket === realtimeSocket) setRealtimeStatus('fallback');
  });
}

async function request(url, body = null) {
  const idempotencyKey = crypto.randomUUID();
  const options = {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${driverToken}`,
      'Idempotency-Key': idempotencyKey,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(url, options);
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(`${data.code}: ${data.message}`);
      return data;
    } catch (error) {
      if (attempt === 1 || !(error instanceof TypeError)) throw error;
    }
  }
}

function formatJapanTime(value) {
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

function formatDistance(meters) {
  if (meters === null || meters === undefined) return '現在地を更新すると表示します';
  return meters < 1000 ? `約${meters}m` : `約${(meters / 1000).toFixed(1)}km`;
}

function setAuthView(view) {
  const showLogin = view === 'login';
  loginPanel.classList.toggle('hidden', !showLogin);
  registrationPanel.classList.toggle('hidden', showLogin);
  authTabs.forEach((tab) => {
    const selected = tab.dataset.authView === view;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
  });
  setRegistrationMessage();
}

function formatCoordinate(latitude, longitude) {
  return `${Number(latitude).toFixed(6)}, ${Number(longitude).toFixed(6)}`;
}

function formatCompactDistance(meters) {
  if (meters === null || meters === undefined) return '未取得';
  return meters < 1000 ? `${meters}m` : `${(meters / 1000).toFixed(1)}km`;
}

function deliveryProgressMarkup(status) {
  const stages = [
    { status: 'OFFERING', label: '内容確認' },
    { status: 'ASSIGNED', label: '店舗へ' },
    { status: 'PICKED_UP', label: '配達先へ' },
    { status: 'DELIVERED', label: '完了' },
  ];
  const currentIndex = stages.findIndex((stage) => stage.status === status);
  const guidance = {
    OFFERING: '配達内容を確認してください',
    ASSIGNED: '店舗へ向かってください',
    PICKED_UP: '配達先へ向かってください',
    DELIVERED: '配達が完了しました',
  }[status] || '配達状況を確認してください';
  const steps = stages.map((stage, index) => {
    const stateClass = index < currentIndex
      ? ' delivery-progress__step--done'
      : index === currentIndex ? ' delivery-progress__step--current' : '';
    return `<li class="delivery-progress__step${stateClass}"${index === currentIndex ? ' aria-current="step"' : ''}>${stage.label}</li>`;
  }).join('');
  return `<section class="delivery-progress" aria-label="配達の進行状態">
    <p class="delivery-progress__guidance">${guidance}</p>
    <ol>${steps}</ol>
  </section>`;
}

function scoreBreakdownMarkup(estimatedPoints, scoreBreakdown = []) {
  if (estimatedPoints === null) return '';
  const rows = scoreBreakdown
    .map((item) => `<li><span>${DeliveryFlowUi.escapeHtml(item.label)}</span><strong>+${Number(item.points)} pt</strong></li>`)
    .join('');
  return `<dt>見込みスコア</dt><dd class="score-estimate"><strong>+${estimatedPoints}ポイント</strong><ul>${rows}</ul></dd>`;
}

function showOrder(
  order,
  extraLabel,
  extraValue,
  estimatedPoints = null,
  scoreBreakdown = [],
  routeDistance = {},
  matchedDistanceToPickupMeters = null,
) {
  card.classList.remove('hidden');
  displayedOrder = order;
  const statusLabel = {
    OFFERING: 'オファー確認中',
    ASSIGNED: '店舗へ移動中',
    PICKED_UP: '配達先へ移動中',
    DELIVERED: '配達完了',
  }[order.status] || order.status;
  const escape = DeliveryFlowUi.escapeHtml;
  DeliveryFlowUi.updateMarkup(detail, `${deliveryProgressMarkup(order.status)}
  <section class="delivery-summary" aria-label="配達の概要">
    <p><span>料金</span><strong>${Number(order.deliveryFeeYen).toLocaleString('ja-JP')}円</strong></p>
    <p><span>店舗まで（直線）</span><strong>${formatCompactDistance(routeDistance.toPickupMeters)}</strong></p>
    <p><span>店舗 → 届け先（直線）</span><strong>${formatCompactDistance(routeDistance.pickupToDropoffMeters)}</strong></p>
    ${estimatedPoints === null ? '' : `<p><span>見込み</span><strong>+${estimatedPoints}pt</strong></p>`}
  </section>
  <section class="delivery-stops" aria-label="受取場所と届け先">
    <div class="delivery-stop"><span class="delivery-stop__marker" aria-hidden="true">1</span><div><span class="delivery-stop__label">受取場所</span><strong>${escape(order.store.name)}</strong>${order.pickupName === order.store.name ? '' : `<p>${escape(order.pickupName)}</p>`}</div></div>
    <div class="delivery-stop"><span class="delivery-stop__marker" aria-hidden="true">2</span><div><span class="delivery-stop__label">届け先</span><strong>${escape(order.dropoffName)}</strong></div></div>
  </section>
  ${DeliveryFlowRoutePreview.renderRoutePreview(order, routeDistance, {
    canOpenCurrentRoute: Boolean(currentBrowserLocation),
  })}
  <details class="delivery-details">
    <summary>地点・注文の詳細</summary>
    <dl>
      <dt>店舗</dt><dd>${escape(order.store.name)}</dd>
      <dt>受取先</dt><dd>${escape(order.pickupName)}</dd>
      <dt>受取座標</dt><dd><code>${formatCoordinate(order.store.latitude, order.store.longitude)}</code></dd>
      <dt>届け先</dt><dd>${escape(order.dropoffName)}</dd>
      <dt>配達先座標</dt><dd><code>${formatCoordinate(order.dropoffLatitude, order.dropoffLongitude)}</code></dd>
      <dt>進行状態</dt><dd>${escape(statusLabel)}</dd>
      <dt>現在地 → 店舗</dt><dd>${formatDistance(routeDistance.toPickupMeters)}</dd>
      ${matchedDistanceToPickupMeters === null ? '' : `<dt>候補選定時の距離</dt><dd>${formatDistance(matchedDistanceToPickupMeters)}（直線）</dd>`}
      <dt>店舗 → 届け先</dt><dd>${formatDistance(routeDistance.pickupToDropoffMeters)}（直線）</dd>
      <dt>${escape(extraLabel)}</dt><dd>${escape(extraValue)}</dd>
      ${scoreBreakdownMarkup(estimatedPoints, scoreBreakdown)}
    </dl>
  </details>`, order.id);
}

function renderActionDock() {
  const view = DeliveryFlowUi.getActionView(state);
  actionGuidance.textContent = view.guidance;
  actionDestination.textContent = view.destination;
  actionDestination.classList.toggle('hidden', Boolean(displayedOrder));
  document.querySelector('#actionIcon').setAttribute('href', displayedOrder
    ? state.assignment?.pickedUpAt ? '#icon-pin' : '#icon-store' : '#icon-bike');
  compactDelivery.classList.toggle('hidden', !displayedOrder);
  DeliveryFlowUi.updateMarkup(compactDelivery, DeliveryFlowUi.renderCompactOrder(displayedOrder), displayedOrder?.id);
  document.querySelector('#rideGuidance').textContent = state.assignment
    ? state.assignment.pickedUpAt ? '配達先へ向かっています' : '店舗へ向かっています'
    : state.driver.status === 'OFFERED' ? '新しい配達が届いています'
      : state.driver.status === 'IDLE' ? '京都で、次の配達を。' : '今日も、安全な配達を。';
  offerDeadline.textContent = view.deadline;
  offerDeadline.classList.toggle('hidden', !view.deadline);
  offerDeadline.classList.toggle('offer-deadline--expired', view.expired);
  offerHasExpired = view.expired;
  DeliveryFlowUi.updateMarkup(actions, DeliveryFlowUi.renderActions(view));
  actions.querySelectorAll('button').forEach((element) => { element.disabled = isLoading; });
  logoutButton.disabled = isLoading || state.driver.status !== 'OFFLINE';
  logoutButton.dataset.alwaysDisabled = String(state.driver.status !== 'OFFLINE');
  document.querySelector('#logoutHint').textContent = state.driver.status === 'OFFLINE'
    ? 'この端末からログアウトできます。' : '勤務中です。退勤するとログアウトできます。';
}

function renderScore() {
  document.querySelector('#mapCurrentScore').textContent = String(scoreState.currentScore);
  document.querySelector('#mapLifetimeScore').textContent = String(scoreState.lifetimeScore);
  currentScore.textContent = String(scoreState.currentScore);
  lifetimeScore.textContent = String(scoreState.lifetimeScore);
  currentTitle.textContent = scoreState.title.current.name;
  titleProgress.value = scoreState.title.progressPercent;
  nextTitle.textContent = scoreState.title.next
    ? `次の「${scoreState.title.next.name}」まで、あと${scoreState.title.next.pointsNeeded}ポイント`
    : '最高ランクに到達しました。';
  scoreEvents.replaceChildren();
  if (!scoreState.recentEvents.length) {
    const item = document.createElement('li');
    item.className = 'score-events__empty';
    item.textContent = '配達を完了すると、ここに加点履歴が表示されます。';
    scoreEvents.append(item);
    return;
  }
  for (const event of scoreState.recentEvents) {
    const item = document.createElement('li');
    const reason = document.createElement('strong');
    const destination = document.createElement('span');
    const points = document.createElement('b');
    const breakdown = document.createElement('span');
    const time = document.createElement('time');
    reason.textContent = event.reason;
    destination.textContent = event.assignment.order.dropoffName;
    points.textContent = `+${event.points}`;
    breakdown.className = 'score-event-breakdown';
    breakdown.textContent = event.breakdown?.length
      ? event.breakdown.map((item) => `${item.label} +${item.points}`).join(' / ')
      : event.reason;
    time.dateTime = event.createdAt;
    time.textContent = formatJapanTime(event.createdAt);
    item.append(reason, destination, points, time, breakdown);
    scoreEvents.append(item);
  }
}

function renderRankingPeriod(period, list, meElement) {
  list.replaceChildren();
  const meLabels = period.me
    ? [period.me.monthlyTitle, period.me.lifetimeTitle].filter(Boolean)
    : [];
  meElement.textContent = period.me
    ? `あなたは ${period.me.rank}位 · ${period.me.score}ポイント${meLabels.length ? ` · ${meLabels.join(' · ')}` : ''}`
    : 'あなたの順位はまだありません。';

  for (const entry of period.leaders) {
    const item = document.createElement('li');
    const rank = document.createElement('strong');
    const name = document.createElement('span');
    const score = document.createElement('b');
    rank.textContent = `${entry.rank}位`;
    name.textContent = entry.name;
    score.textContent = `${entry.score} pt`;
    if (entry.isCurrentDriver) {
      item.className = 'ranking-list__current';
      name.textContent += '（あなた）';
    }
    if (entry.monthlyTitle) name.textContent += ` · ${entry.monthlyTitle}`;
    if (entry.lifetimeTitle) name.textContent += ` · ${entry.lifetimeTitle}`;
    item.append(rank, name, score);
    list.append(item);
  }
}

function renderRanking() {
  renderRankingPeriod(rankingState.monthly, monthlyRankingList, monthlyRankingMe);
  renderRankingPeriod(rankingState.current, currentRankingList, currentRankingMe);
  renderRankingPeriod(rankingState.lifetime, lifetimeRankingList, lifetimeRankingMe);
}

function renderHistory() {
  completedDeliveryCount.textContent = String(historyState.summary.completedDeliveries);
  lastDeliveredAt.textContent = historyState.summary.lastDeliveredAt
    ? `最終配達: ${formatJapanTime(historyState.summary.lastDeliveredAt)}`
    : 'まだ完了した配達はありません。';
  deliveryHistoryList.replaceChildren();
  historyResultCount.textContent = `条件に一致 ${historyState.summary.filteredDeliveries ?? historyState.deliveries.length}件（最大20件表示）`;

  if (!historyState.deliveries.length) {
    const item = document.createElement('li');
    item.className = 'history-empty';
    item.textContent = '条件に一致する配達はありません。';
    deliveryHistoryList.append(item);
    return;
  }

  for (const assignment of historyState.deliveries) {
    const item = document.createElement('li');
    const title = document.createElement('strong');
    const route = document.createElement('span');
    const time = document.createElement('time');
    const status = document.createElement('span');
    title.textContent = assignment.order.store.name;
    route.textContent = `${assignment.order.pickupName} → ${assignment.order.dropoffName}`;
    const occurredAt = assignment.deliveredAt || assignment.pickedUpAt || assignment.acceptedAt;
    time.dateTime = occurredAt;
    time.textContent = formatJapanTime(occurredAt);
    status.className = 'history-status';
    status.textContent = { ASSIGNED: '受諾済み', PICKED_UP: '受取済み', DELIVERED: '完了' }[assignment.order.status] || assignment.order.status;
    item.append(title, route, status, time);
    deliveryHistoryList.append(item);
  }
}

function render() {
  workflow.classList.toggle('workflow--active-delivery', Boolean(state.assignment || (state.driver.status === 'OFFERED' && state.offer)));
  if (state.driver.status === 'OFFLINE') currentBrowserLocation = null;
  document.querySelector('#driverStatus').textContent = statusText[state.driver.status];
  document.querySelector('#driverStatus').dataset.status = state.driver.status;
  document.querySelector('#driverName').textContent = state.driver.name;
  document.querySelector('#driverId').textContent = `配達員ID: ${state.driver.id}`;
  document.querySelector('#shiftStartedAt').textContent = state.driver.shiftStartedAt
    ? `稼働開始: ${formatJapanTime(state.driver.shiftStartedAt)}`
    : '現在は退勤中です';

  const activeOffer = state.driver.status === 'OFFERED' ? state.offer : null;
  const nextDeliveryKey = state.assignment ? `assignment:${state.assignment.id}` : activeOffer ? `offer:${activeOffer.id}` : null;
  if (nextDeliveryKey !== currentDeliveryKey) {
    sheetScrollPositions.delivery = 0;
    if (sheetView === 'delivery') sheetContent.scrollTop = 0;
    if (currentDeliveryKey !== null) setMessage('');
    currentDeliveryKey = nextDeliveryKey;
  }
  card.classList.toggle('hidden', !nextDeliveryKey);
  document.querySelector('#idleCard').classList.toggle('hidden', Boolean(nextDeliveryKey));
  document.querySelector('#idleHeading').textContent = state.driver.status === 'OFFLINE'
    ? '今日の配達を始めましょう' : '次のオファーを待っています';
  document.querySelector('#idleDescription').textContent = state.driver.status === 'OFFLINE'
    ? '準備ができたら、下のボタンから稼働を開始してください。'
    : 'オファーを確認すると、料金・受取場所・届け先がここに表示されます。';
  if (!nextDeliveryKey) {
    displayedOrder = null;
    DeliveryFlowUi.updateMarkup(detail, '', '');
  }
  renderScore();
  renderRanking();
  renderHistory();
  const currentWeather = state.simulator?.weatherCondition || 'CLEAR';
  if (document.activeElement !== weatherCondition) weatherCondition.value = currentWeather;
  weatherSimulatorStatus.textContent = `現在: ${currentWeather === 'RAIN' ? '雨' : '晴れ'}`;
  updateLocationButton.disabled = isLoading || state.driver.status === 'OFFLINE';
  updateLocationButton.dataset.alwaysDisabled = String(state.driver.status === 'OFFLINE');
  const locationLabels = {
    MISSING: '現在地はまだ保存されていません。',
    AVAILABLE: `現在地を利用できます（最終更新: ${formatJapanTime(state.location.updatedAt)}、精度 約${Math.round(state.location.accuracyMeters || 0)}m）。`,
  };
  locationStatusElement.textContent = state.driver.status === 'OFFLINE'
    ? '退勤中のため現在地は保持していません。'
    : locationLabels[state.location.status];

  if (state.driver.status === 'OFFERED' && state.offer) {
    showOrder(
      state.offer.order,
      'オファー期限',
      state.offer.expiresAt ? formatJapanTime(state.offer.expiresAt) : '期限なし',
      state.offer.estimatedPoints,
      state.offer.scoreBreakdown,
      state.offer.routeDistance,
      state.offer.distanceToPickupMeters,
    );
  }
  if (state.assignment) {
    const order = state.assignment.order;
    showOrder(
      order,
      '受諾時刻',
      formatJapanTime(state.assignment.acceptedAt),
      state.assignment.estimatedPoints,
      state.assignment.scoreBreakdown,
      state.assignment.routeDistance,
    );
  }
  renderActionDock();
  deliveryMap.update(displayedOrder);
}

async function refresh(options = {}) {
  if (refreshPromise) {
    realtimeRefreshQueued = true;
    return refreshPromise;
  }
  realtimeRefreshQueued = false;
  refreshPromise = performRefresh(options);
  try {
    return await refreshPromise;
  } finally {
    refreshPromise = null;
    if (realtimeRefreshQueued && !isLoading) {
      realtimeRefreshQueued = false;
      queueMicrotask(() => refresh({ preserveMessage: true }));
    }
  }
}

async function performRefresh({ preserveMessage = false } = {}) {
  if (!driverToken) {
    deliveryMap.disable();
    currentBrowserLocation = null;
    disconnectRealtime();
    loginForm.elements.driverId.value = localStorage.getItem('deliveryFlowDriverId') || '';
    if (registrationCard.classList.contains('hidden')) setAuthView(authView);
    registrationCard.classList.remove('hidden');
    workflow.classList.add('hidden');
    return;
  }
  try {
    const response = await fetch('/api/dashboard', {
      headers: { Authorization: `Bearer ${driverToken}` },
    });
    if (response.status === 401) {
      disconnectRealtime();
      localStorage.removeItem('deliveryFlowAccessToken');
      driverToken = null;
      return performRefresh();
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`${data.code}: ${data.message}`);
    state = data;
    registrationCard.classList.add('hidden');
    workflow.classList.remove('hidden');
    render();
    const historyParameters = new URLSearchParams(new FormData(historyFilterForm));
    const authenticatedHeaders = { Authorization: `Bearer ${driverToken}` };
    const [historyResponse, scoreResponse, rankingResponse] = await Promise.all([
      fetch(`/api/deliveries/history?${historyParameters}`, { headers: authenticatedHeaders }),
      fetch('/api/drivers/me/score', { headers: authenticatedHeaders }),
      fetch('/api/drivers/ranking', { headers: authenticatedHeaders }),
    ]);
    const [history, score, ranking] = await Promise.all([
      historyResponse.json().catch(() => ({})),
      scoreResponse.json().catch(() => ({})),
      rankingResponse.json().catch(() => ({})),
    ]);
    if (!historyResponse.ok) throw new Error(`${history.code}: ${history.message}`);
    if (!scoreResponse.ok) throw new Error(`${score.code}: ${score.message}`);
    if (!rankingResponse.ok) throw new Error(`${ranking.code}: ${ranking.message}`);
    historyState = history;
    scoreState = score;
    rankingState = ranking;
    lastSuccessfulRefreshAt = Date.now();
    renderScore();
    renderRanking();
    renderHistory();
    connectRealtime();
    if (message.dataset.source === 'refresh' || (!preserveMessage && message.classList.contains('message--info'))) setMessage('');
  } catch (error) {
    setMessage(`読み込みに失敗しました。${error.message}`, 'error', 'refresh');
  }
}

authTabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    authView = tab.dataset.authView;
    setAuthView(authView);
  });
  tab.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    authView = event.key === 'Home' ? 'login' : event.key === 'End' ? 'register'
      : authView === 'login' ? 'register' : 'login';
    setAuthView(authView);
    document.querySelector(`[data-auth-view="${authView}"]`).focus();
  });
});

registrationForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  authView = 'register';
  const { name, pin } = Object.fromEntries(new FormData(registrationForm));
  setRegistrationMessage('配達員を登録しています。');
  setLoading(true);
  try {
    const response = await fetch('/api/drivers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, pin }),
    });
    const registration = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(registration.message || '配達員を登録できませんでした。');
    driverToken = registration.accessToken;
    localStorage.setItem('deliveryFlowAccessToken', driverToken);
    localStorage.setItem('deliveryFlowDriverId', String(registration.driver.id));
    connectRealtime();
    setRegistrationMessage();
    await refresh({ preserveMessage: true });
    setMessage(`登録しました。あなたの配達員IDは ${registration.driver.id} です。`, 'success');
  } catch (error) {
    setRegistrationMessage(`登録に失敗しました。${error.message}`);
  } finally {
    setLoading(false);
  }
});

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  authView = 'login';
  const { driverId, pin } = Object.fromEntries(new FormData(loginForm));
  setRegistrationMessage('ログインしています。');
  setLoading(true);
  try {
    const response = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ driverId: Number(driverId), pin }),
    });
    const login = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(login.message || 'ログインできませんでした。');
    driverToken = login.accessToken;
    localStorage.setItem('deliveryFlowAccessToken', driverToken);
    localStorage.setItem('deliveryFlowDriverId', String(login.driver.id));
    connectRealtime();
    setRegistrationMessage();
    await refresh({ preserveMessage: true });
    setMessage('ログインしました。', 'success');
  } catch (error) {
    setRegistrationMessage(`ログインに失敗しました。${error.message}`);
  } finally {
    setLoading(false);
  }
});

async function handleAction(event) {
  const action = event.target.closest('button[data-action]')?.dataset.action;
  if (!action || isLoading) return;
  if (action.startsWith('accept:') && DeliveryFlowUi.getActionView(state).expired) {
    renderActionDock();
    setMessage('オファーの期限が切れました。最新の状況を確認してください。', 'error');
    return;
  }
  if (action === 'refresh') {
    setLoading(true);
    try { await refresh({ preserveMessage: true }); } finally { setLoading(false); }
    return;
  }
  const actionLabels = {
    start: '稼働開始', end: '退勤', offer: 'オファーの確認',
    accept: 'オファーの受諾', reject: 'オファーの辞退',
    pickup: '荷物の受取', complete: '配達の完了', logout: 'ログアウト',
  };
  const actionName = actionLabels[action.split(':')[0]];
  setLoading(true);
  setMessage(`${actionName}を処理しています。`, 'loading');
  try {
    let actionResult;
    if (action === 'start') await request('/api/shifts/start');
    if (action === 'end') await request('/api/shifts/end');
    if (action === 'offer') await request('/api/offers/current');
    if (action === 'logout') {
      await request('/api/logout');
      disconnectRealtime();
      localStorage.removeItem('deliveryFlowAccessToken');
      driverToken = null;
      authView = 'login';
      await refresh();
      return;
    }
    if (action.startsWith('accept:')) await request(`/api/offers/${action.split(':')[1]}/accept`);
    if (action.startsWith('reject:')) await request(`/api/offers/${action.split(':')[1]}/reject`);
    if (action.startsWith('pickup:')) await request(`/api/assignments/${action.split(':')[1]}/pickup`);
    if (action.startsWith('complete:')) actionResult = await request(`/api/assignments/${action.split(':')[1]}/complete`);
    await refresh({ preserveMessage: true });
    if (['offer', 'accept', 'pickup', 'complete'].includes(action.split(':')[0])) {
      setSheetView('delivery');
    }
    const awardDetails = actionResult?.scoreAward?.breakdown
      ?.map((item) => `${item.label} +${item.points}`).join(' / ');
    const completionMessage = action.startsWith('complete:') ? '配達が完了しました。' : `${actionName}が完了しました。`;
    setMessage(actionResult?.scoreAward
      ? `${completionMessage}${awardDetails}、合計 +${actionResult.scoreAward.points}ポイント獲得しました。`
      : completionMessage, 'success');
  } catch (error) {
    setMessage(`${actionName}に失敗しました。${error.message}`, 'error');
  } finally {
    setLoading(false);
  }
}
actions.addEventListener('click', handleAction);
logoutButton.addEventListener('click', handleAction);

weatherSimulatorForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  setLoading(true);
  setMessage('天候を更新しています。', 'loading');
  try {
    const result = await request('/api/simulator/weather', { condition: weatherCondition.value });
    await refresh({ preserveMessage: true });
    setMessage(result.message, 'success');
  } catch (error) {
    setMessage(`天候の更新に失敗しました。${error.message}`, 'error');
  } finally {
    setLoading(false);
  }
});

updateLocationButton.addEventListener('click', async () => {
  if (!navigator.geolocation || isLoading) {
    setMessage('このブラウザでは位置情報を利用できません。', 'error');
    return;
  }
  setLoading(true);
  setMessage('ブラウザの位置情報許可を確認しています。', 'loading');
  try {
    const position = await new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(
      resolve,
      reject,
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 0 },
    ));
    const response = await fetch('/api/drivers/me/location', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${driverToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        accuracyMeters: position.coords.accuracy,
      }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`${result.code}: ${result.message}`);
    currentBrowserLocation = {
      latitude: position.coords.latitude,
      longitude: position.coords.longitude,
    };
    await refresh({ preserveMessage: true });
    setMessage('現在地を更新し、店舗までの直線距離を再計算しました。', 'success');
  } catch (error) {
    const denied = error?.code === 1;
    setMessage(denied
      ? '位置情報が許可されませんでした。ブラウザのサイト設定から許可できます。'
      : `現在地を更新できませんでした。${error.message || '位置情報を取得できませんでした。'}`, 'error');
  } finally {
    setLoading(false);
    if (state) render();
  }
});

detail.addEventListener('click', (event) => {
  const routeButton = event.target.closest('button[data-route-kind]');
  if (!routeButton || !displayedOrder) return;
  const store = {
    latitude: displayedOrder.store.latitude,
    longitude: displayedOrder.store.longitude,
  };
  const dropoff = {
    latitude: displayedOrder.dropoffLatitude,
    longitude: displayedOrder.dropoffLongitude,
  };
  const includesCurrentLocation = routeButton.dataset.routeKind === 'current-pickup';
  const from = includesCurrentLocation ? currentBrowserLocation : store;
  const to = includesCurrentLocation ? store : dropoff;
  if (!from) {
    setMessage('この画面で現在地を更新してから、道路経路を開いてください。', 'error');
    return;
  }
  const dataDescription = includesCurrentLocation
    ? '現在地と店舗の座標'
    : 'デモ用の店舗と届け先の座標';
  const confirmed = window.confirm(
    `${dataDescription}をOpenStreetMapへ送信し、外部サイトを開きます。よろしいですか？`,
  );
  if (!confirmed) return;
  try {
    const routeUrl = DeliveryFlowRoutePreview.buildOsmDirectionsUrl(from, to);
    window.open(routeUrl, '_blank', 'noopener,noreferrer');
    setMessage('OpenStreetMapの道路経路を別タブで開きました。', 'success');
  } catch (error) {
    setMessage(error.message, 'error');
  }
});

historyFilterForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  setLoading(true);
  setMessage('配達履歴を絞り込んでいます。', 'loading');
  try {
    await refresh({ preserveMessage: true });
    setMessage('配達履歴を更新しました。', 'success');
  } finally {
    setLoading(false);
  }
});

historyFilterReset.addEventListener('click', async () => {
  historyFilterForm.reset();
  setLoading(true);
  try {
    await refresh({ preserveMessage: true });
    setMessage('絞り込み条件をリセットしました。', 'success');
  } finally {
    setLoading(false);
  }
});

window.addEventListener('beforeunload', () => {
  pageIsUnloading = true;
  disconnectRealtime();
});

setBottomSheetState(bottomSheetState);
refresh();
setInterval(() => {
  if (state?.offer && !isLoading && DeliveryFlowUi.getActionView(state).expired !== offerHasExpired) renderActionDock();
}, 1000);
setInterval(() => {
  const realtimeConnected = realtimeSocket?.readyState === WebSocket.OPEN;
  const safetyRefreshDue = Date.now() - lastSuccessfulRefreshAt >= 60_000;
  if (!isLoading && (!realtimeConnected || safetyRefreshDue)) refresh({ preserveMessage: true });
}, 10_000);

