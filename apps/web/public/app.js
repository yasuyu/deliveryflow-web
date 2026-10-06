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
const historyLoadMore = document.querySelector('#historyLoadMore');
const historyLoadError = document.querySelector('#historyLoadError');
const currentScore = document.querySelector('#currentScore');
const lifetimeScore = document.querySelector('#lifetimeScore');
const currentTitle = document.querySelector('#currentTitle');
const nextTitle = document.querySelector('#nextTitle');
const titleProgress = document.querySelector('#titleProgress');
const monthlyRankingList = document.querySelector('#monthlyRanking');
const currentRankingList = document.querySelector('#currentRanking');
const lifetimeRankingList = document.querySelector('#lifetimeRanking');
const currentRankingMe = document.querySelector('#currentRankingMe');
const lifetimeRankingMe = document.querySelector('#lifetimeRankingMe');
const monthlyRankingMe = document.querySelector('#monthlyRankingMe');
const rankingPeriodTabs = [...document.querySelectorAll('[data-ranking-period]')];
const rankingPeriodPanels = [...document.querySelectorAll('[data-ranking-panel]')];
const weatherSimulatorForm = document.querySelector('#weatherSimulatorForm');
const weatherCondition = document.querySelector('#weatherCondition');
const weatherSimulatorStatus = document.querySelector('#weatherSimulatorStatus');
const useDemoLocationButton = document.querySelector('#useDemoLocation');
const updateLocationButton = document.querySelector('#updateLocation');
const locationStatusElement = document.querySelector('#locationStatus');
const realtimeStatus = document.querySelector('#realtimeStatus');
const bottomSheet = document.querySelector('#bottomSheet');
const bottomSheetHandle = document.querySelector('#bottomSheetHandle');
const bottomSheetHandleLabel = document.querySelector('#bottomSheetHandleLabel');
const sheetContent = document.querySelector('#sheetContent');
const sheetViewBar = document.querySelector('#sheetViewBar');
const sheetViewTitle = document.querySelector('#sheetViewTitle');
const returnToDelivery = document.querySelector('#returnToDelivery');
const sheetPanels = {
  delivery: document.querySelector('#deliveryPanel'),
  activity: document.querySelector('#activityPanel'),
  settings: document.querySelector('#settingsPanel'),
};
const logoutButton = document.querySelector('#logoutButton');
const actionGuidance = document.querySelector('#actionGuidance');
const actionDestination = document.querySelector('#actionDestination');
const offerCountdown = document.querySelector('#offerCountdown');
const offerDeadline = document.querySelector('#offerDeadline');
const offerCountdownProgress = document.querySelector('#offerCountdownProgress');
const compactDelivery = document.querySelector('#compactDelivery');
const offlineQueueStatus = document.querySelector('#offlineQueueStatus');
const lastShiftSummary = document.querySelector('#lastShiftSummary');
const shiftSummaryDuration = document.querySelector('#shiftSummaryDuration');
const shiftSummaryDeliveries = document.querySelector('#shiftSummaryDeliveries');
const shiftSummaryPoints = document.querySelector('#shiftSummaryPoints');
const shiftReviewText = document.querySelector('#shiftReviewText');
const shiftReviewButton = document.querySelector('#shiftReviewButton');
const deliveryMap = DeliveryFlowMap.create({
  canvas: document.querySelector('#deliveryMap'),
  sheet: bottomSheet,
  tools: document.querySelector('#mapTools'), note: document.querySelector('#mapNote'),
  error: document.querySelector('#mapError'), toggle: document.querySelector('#toggleMap'),
});
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
let mapStartedForSession = false;
const sheetScrollPositions = { delivery: 0, activity: 0, settings: 0 };
let driverToken = localStorage.getItem('deliveryFlowAccessToken');
let authView = localStorage.getItem('deliveryFlowDriverId') ? 'login' : 'register';
let state;
let currentBrowserLocation = null;
let displayedOrder = null;
let displayedRouteDistance = null;
let historyState = { summary: { completedDeliveries: 0, lastDeliveredAt: null }, deliveries: [] };
let appliedHistoryFilters = new URLSearchParams(new FormData(historyFilterForm)).toString();
let historyPageCount = 1;
let historyRevision = 0;
let historyLoading = false;
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
let offlineQueue = [];
let offlineQueueFlushing = false;
let offlineQueueNotice = '';
let bottomSheetState = 'collapsed';
let activeRankingPeriod = 'monthly';
let bottomSheetDrag = null;
let suppressBottomSheetClick = false;
let autoAdvancingOfferId = null;
let completedShiftSummary = null;

function syncVisualViewportLayout() {
  const layout = DeliveryFlowBottomSheet.visualViewportLayout(window.visualViewport, window.innerWidth);
  workflow.style.setProperty('--visual-viewport-width', `${layout.width}px`);
  workflow.style.setProperty('--visual-viewport-center-x', `${layout.centerX}px`);
  workflow.style.setProperty('--visual-viewport-offset-top', `${layout.offsetTop}px`);
}

function bottomSheetSnapHeights() {
  const viewportHeight = window.visualViewport?.height || window.innerHeight;
  const handleHeight = Math.ceil(bottomSheetHandle.getBoundingClientRect().height + 2);
  return DeliveryFlowBottomSheet.calculateSnapHeights(viewportHeight, {
    mobile: window.matchMedia('(max-width: 700px), (max-height: 520px)').matches,
    minimumContentHeight: Math.ceil(Math.max(shiftCard.scrollHeight + 1, shiftCard.getBoundingClientRect().height)
      + handleHeight),
    minimumHandleHeight: handleHeight,
  });
}

function setBottomSheetState(nextState, { announce = false } = {}) {
  syncVisualViewportLayout();
  const snapHeights = bottomSheetSnapHeights();
  bottomSheetState = nextState;
  bottomSheet.style.setProperty('--sheet-height', `${snapHeights[nextState]}px`);
  bottomSheet.dataset.sheetState = nextState;
  workflow.dataset.sheetState = nextState;
  deliveryMap.refitAfterResize();
  bottomSheetHandle.setAttribute('aria-expanded', String(nextState !== 'minimized'));
  const labels = {
    minimized: '上にドラッグしてシートを表示',
    collapsed: '上にドラッグして詳細を表示',
    medium: '上下にドラッグして表示範囲を調整',
    expanded: '下にドラッグして地図を広く表示',
  };
  bottomSheetHandleLabel.textContent = labels[nextState];
  bottomSheetHandle.setAttribute('aria-label', `${labels[nextState]}。クリックでも切り替え、上下キーで調整できます`);
  const contentIsHidden = nextState === 'minimized' || nextState === 'collapsed';
  const focusIsInContent = sheetContent.contains(document.activeElement)
    || sheetViewBar.contains(document.activeElement)
    || shiftCard.contains(document.activeElement);
  sheetViewBar.inert = contentIsHidden;
  sheetContent.inert = contentIsHidden;
  shiftCard.inert = nextState === 'minimized';
  if (announce || (contentIsHidden && focusIsInContent)) bottomSheetHandle.focus({ preventScroll: true });
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
    Math.max(snapHeights.minimized, bottomSheetDrag.startHeight + movement),
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
  const currentIndex = DeliveryFlowBottomSheet.states.indexOf(bottomSheetState);
  const nextState = DeliveryFlowBottomSheet.states[(currentIndex + 1) % DeliveryFlowBottomSheet.states.length];
  setBottomSheetState(nextState, { announce: true });
});

bottomSheetHandle.addEventListener('keydown', (event) => {
  if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  if (event.key === 'Home') setBottomSheetState('minimized', { announce: true });
  else if (event.key === 'End') setBottomSheetState('expanded', { announce: true });
  else setBottomSheetState(DeliveryFlowBottomSheet.adjacentState(
    bottomSheetState,
    event.key === 'ArrowUp' ? 1 : -1,
  ), { announce: true });
});

function handleViewportResize() {
  syncVisualViewportLayout();
  setBottomSheetState(bottomSheetState);
}
window.addEventListener('resize', handleViewportResize);
window.visualViewport?.addEventListener('resize', handleViewportResize);
window.visualViewport?.addEventListener('scroll', syncVisualViewportLayout);
syncVisualViewportLayout();
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
  Object.entries(sheetPanels).forEach(([name, panel]) => {
    const selected = name === view;
    panel.classList.toggle('hidden', !selected);
    panel.setAttribute('aria-hidden', String(!selected));
  });
  const isDelivery = view === 'delivery';
  sheetViewBar.classList.toggle('hidden', isDelivery);
  sheetViewTitle.textContent = view === 'activity' ? '実績・ランキング' : view === 'settings' ? '設定' : '';
  sheetContent.scrollTop = sheetScrollPositions[view];
  if (focus) {
    (isDelivery ? sheetPanels.delivery : returnToDelivery)
      .focus({ preventScroll: true });
  }
}
document.querySelector('[data-open-settings]').addEventListener('click', () => setSheetView('settings', { focus: true }));
returnToDelivery.addEventListener('click', () => setSheetView('delivery', { focus: true }));
document.querySelectorAll('[data-open-view]').forEach((button) => {
  button.addEventListener('click', () => {
    setBottomSheetState('expanded');
    setSheetView(button.dataset.openView, { focus: true });
  });
});

function setRankingPeriod(period, { focus = false } = {}) {
  activeRankingPeriod = rankingPeriodTabs.some((tab) => tab.dataset.rankingPeriod === period)
    ? period : 'monthly';
  rankingPeriodTabs.forEach((tab) => {
    const selected = tab.dataset.rankingPeriod === activeRankingPeriod;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    if (selected && focus) tab.focus({ preventScroll: true });
  });
  rankingPeriodPanels.forEach((panel) => {
    const selected = panel.dataset.rankingPanel === activeRankingPeriod;
    panel.hidden = !selected;
    panel.setAttribute('aria-hidden', String(!selected));
  });
}

rankingPeriodTabs.forEach((tab) => {
  tab.addEventListener('click', () => setRankingPeriod(tab.dataset.rankingPeriod));
  tab.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    setRankingPeriod(DeliveryFlowUi.nextRankingPeriod(activeRankingPeriod, event.key), { focus: true });
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

function queueDriverId() {
  return state?.driver?.id || localStorage.getItem('deliveryFlowDriverId');
}

function loadOfflineQueue() {
  const driverId = queueDriverId();
  offlineQueue = driverId ? DeliveryFlowOfflineActions.load(localStorage, driverId) : [];
  return offlineQueue;
}

function saveOfflineQueue(entries) {
  const driverId = queueDriverId();
  offlineQueue = driverId ? DeliveryFlowOfflineActions.save(localStorage, driverId, entries) : [];
  return offlineQueue;
}

function enqueueOfflineAction(entry) {
  const driverId = queueDriverId();
  if (!driverId) throw new Error('配達員を確認できないため操作を保存できません。');
  const result = DeliveryFlowOfflineActions.enqueue(localStorage, driverId, offlineQueue, entry);
  offlineQueue = result.entries;
  offlineQueueNotice = 'ログイン情報や現在地は保存していません。';
  return result;
}

function renderOfflineQueueStatus() {
  offlineQueueStatus.replaceChildren();
  offlineQueueStatus.className = 'offline-queue';
  if (!offlineQueue.length) {
    offlineQueueStatus.classList.add('hidden');
    return;
  }
  const first = offlineQueue[0];
  const blocked = first.status === 'blocked';
  const label = DeliveryFlowOfflineActions.label(first);
  const text = document.createElement('p');
  if (offlineQueueFlushing) {
    text.textContent = `保存した${label}を送信しています（残り${offlineQueue.length}件）。`;
    offlineQueueStatus.dataset.status = 'sending';
  } else if (blocked) {
    text.textContent = `${label}を送信できませんでした。${first.error?.message || '最新の配達状況を確認してください。'}`;
    offlineQueueStatus.dataset.status = 'blocked';
  } else {
    text.textContent = `${label}を端末に保存しました。接続後に自動送信します（${offlineQueue.length}件）。`;
    offlineQueueStatus.dataset.status = navigator.onLine ? 'waiting' : 'offline';
  }
  offlineQueueStatus.append(text);
  if (blocked) {
    const controls = document.createElement('div');
    controls.className = 'offline-queue__actions';
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'button-secondary';
    retry.dataset.queueAction = 'retry';
    retry.textContent = '最新状態で再送する';
    const discard = document.createElement('button');
    discard.type = 'button';
    discard.className = 'button-secondary';
    discard.dataset.queueAction = 'discard';
    discard.textContent = 'この操作を取り消す';
    controls.append(retry, discard);
    offlineQueueStatus.append(controls);
  }
  if (offlineQueueNotice) {
    const notice = document.createElement('small');
    notice.textContent = offlineQueueNotice;
    offlineQueueStatus.append(notice);
  }
}

function setLoading(loading) {
  isLoading = loading;
  document.querySelectorAll('[data-action], [data-location-action], button[type="submit"], #historyFilterReset').forEach((element) => {
    element.disabled = loading || element.dataset.alwaysDisabled === 'true';
  });
  actions.setAttribute('aria-busy', String(loading));
  if (state) renderActionDock();
  renderOfflineQueueStatus();
  historyLoadMore.disabled = loading || historyLoading;
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

async function request(url, body = null, { idempotencyKey = crypto.randomUUID() } = {}) {
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
      if (!response.ok) {
        const error = new Error(data.message || 'リクエストを処理できませんでした。');
        error.code = data.code || 'REQUEST_FAILED';
        error.status = response.status;
        throw error;
      }
      return data;
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      if (attempt === 1) {
        const networkError = new Error('サーバーへ接続できません。');
        networkError.network = true;
        networkError.cause = error;
        throw networkError;
      }
    }
  }
}

async function flushOfflineQueue() {
  if (!driverToken || !offlineQueue.length || offlineQueueFlushing || !navigator.onLine) {
    renderOfflineQueueStatus();
    return;
  }
  offlineQueueFlushing = true;
  offlineQueueNotice = '';
  setLoading(true);
  try {
    const result = await DeliveryFlowOfflineActions.flush(offlineQueue, (entry, url) => (
      request(url, null, { idempotencyKey: entry.idempotencyKey })
    ));
    saveOfflineQueue(result.remaining);
    if (result.reason === 'complete') {
      offlineQueueNotice = `${result.completed.length}件の操作を送信しました。`;
      await refresh({ preserveMessage: true });
      setMessage(`${result.completed.length}件のオフライン操作を送信しました。`, 'success');
    } else if (result.reason === 'blocked') {
      offlineQueueNotice = 'サーバー側の状態を確認してから、再送または取り消しを選んでください。';
      await refresh({ preserveMessage: true });
    }
  } finally {
    offlineQueueFlushing = false;
    setLoading(false);
    renderOfflineQueueStatus();
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
    <header class="delivery-progress__heading">
      <span>今回の配達 · ステップ ${Math.max(1, currentIndex + 1)}/4</span>
      <h2>${guidance}</h2>
    </header>
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
  elevationProfile = null,
) {
  card.classList.remove('hidden');
  displayedOrder = order;
  displayedRouteDistance = routeDistance;
  const statusLabel = {
    OFFERING: 'オファー確認中',
    ASSIGNED: '店舗へ移動中',
    PICKED_UP: '配達先へ移動中',
    DELIVERED: '配達完了',
  }[order.status] || order.status;
  const escape = DeliveryFlowUi.escapeHtml;
  DeliveryFlowUi.updateMarkup(detail, `${deliveryProgressMarkup(order.status)}
  <section class="delivery-summary" aria-label="配達の概要">
    <p><span>報酬</span><strong>${Number(order.deliveryFeeYen).toLocaleString('ja-JP')}円</strong></p>
    <p><span>店舗まで（直線）</span><strong>${formatCompactDistance(routeDistance.toPickupMeters)}</strong></p>
    <p><span>店舗 → 届け先（直線）</span><strong>${formatCompactDistance(routeDistance.pickupToDropoffMeters)}</strong></p>
    ${estimatedPoints === null ? '' : `<p><span>見込み</span><strong>+${estimatedPoints}pt</strong></p>`}
  </section>
  <section class="delivery-stops" aria-label="受取場所と届け先">
    <div class="delivery-stop"><span class="delivery-stop__marker" aria-hidden="true">1</span><div><span class="delivery-stop__label">受取場所</span><strong>${escape(order.store.name)}</strong>${order.pickupName === order.store.name ? '' : `<p>${escape(order.pickupName)}</p>`}</div></div>
    <div class="delivery-stop"><span class="delivery-stop__marker" aria-hidden="true">2</span><div><span class="delivery-stop__label">届け先</span><strong>${escape(order.dropoffName)}</strong></div></div>
  </section>
  ${DeliveryFlowElevation.renderElevationProfile(elevationProfile)}
  ${DeliveryFlowRoutePreview.renderRoutePreview(order, routeDistance)}
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
  offerCountdown.classList.toggle('hidden', !view.countdown);
  if (view.countdown) {
    offerCountdownProgress.max = view.countdown.durationSeconds;
    offerCountdownProgress.value = view.countdown.progressValue;
    offerCountdownProgress.setAttribute('aria-valuetext', view.expired
      ? '受付終了' : `残り${view.countdown.remainingSeconds}秒`);
  }
  offerCountdown.classList.toggle('offer-countdown--urgent', Boolean(view.countdown?.urgent));
  offerDeadline.classList.toggle('offer-deadline--expired', view.expired);
  DeliveryFlowUi.updateMarkup(actions, DeliveryFlowUi.renderActions(view));
  actions.querySelectorAll('button').forEach((element) => {
    element.disabled = isLoading || offlineQueue.length > 0;
  });
  logoutButton.disabled = isLoading || state.driver.status !== 'OFFLINE';
  logoutButton.dataset.alwaysDisabled = String(state.driver.status !== 'OFFLINE');
  document.querySelector('#logoutHint').textContent = state.driver.status === 'OFFLINE'
    ? 'この端末からログアウトできます。' : '勤務中です。退勤するとログアウトできます。';
  renderOfflineQueueStatus();
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
}

function renderRankingPeriod(period, list, meElement) {
  list.replaceChildren();
  const meLabels = period.me
    ? [period.me.monthlyTitle, period.me.lifetimeTitle].filter(Boolean)
    : [];
  meElement.textContent = period.me
    ? `あなたの順位: ${period.me.rank}位 · ${period.me.score}ポイント${meLabels.length ? ` · ${meLabels.join(' · ')}` : ''}`
    : 'あなたの順位はまだありません。';

  for (const entry of period.leaders) {
    const item = document.createElement('li');
    const rank = document.createElement('strong');
    const driver = document.createElement('span');
    const name = document.createElement('span');
    const badges = document.createElement('span');
    const score = document.createElement('b');
    item.dataset.rank = String(entry.rank);
    rank.className = 'ranking-rank';
    driver.className = 'ranking-driver';
    name.className = 'ranking-driver__name';
    badges.className = 'ranking-driver__badges';
    rank.textContent = `${entry.rank}位`;
    name.textContent = entry.name;
    score.textContent = `${entry.score} pt`;
    if (entry.isCurrentDriver) {
      item.className = 'ranking-list__current';
      name.textContent += '（あなた）';
    }
    for (const title of [entry.monthlyTitle, entry.lifetimeTitle].filter(Boolean)) {
      const badge = document.createElement('small');
      badge.textContent = title;
      badges.append(badge);
    }
    driver.append(name, badges);
    item.append(rank, driver, score);
    list.append(item);
  }
  if (!period.leaders.length) {
    const empty = document.createElement('li');
    empty.className = 'ranking-empty';
    empty.textContent = 'この期間のランキングはまだありません。';
    list.append(empty);
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
  historyResultCount.textContent = `条件に一致 ${historyState.summary.filteredDeliveries ?? historyState.deliveries.length}件（${historyState.deliveries.length}件表示）`;
  historyLoadMore.classList.toggle('hidden', !historyState.pagination?.hasMore);
  historyLoadMore.disabled = isLoading || historyLoading;

  if (!historyState.deliveries.length) {
    const item = document.createElement('li');
    item.className = 'history-empty';
    item.textContent = '条件に一致する配達はありません。';
    deliveryHistoryList.append(item);
    return;
  }

  for (const assignment of historyState.deliveries) {
    const item = document.createElement('li');
    item.dataset.assignmentId = assignment.id;
    const title = document.createElement('strong');
    const route = document.createElement('span');
    const time = document.createElement('time');
    const status = document.createElement('span');
    const points = document.createElement('b');
    const breakdown = document.createElement('span');
    title.textContent = assignment.order.store.name;
    route.className = 'history-route';
    route.textContent = `${assignment.order.pickupName} → ${assignment.order.dropoffName}`;
    const occurredAt = assignment.deliveredAt || assignment.pickedUpAt || assignment.acceptedAt;
    time.dateTime = occurredAt;
    time.className = 'history-time';
    time.textContent = formatJapanTime(occurredAt);
    status.className = 'history-status';
    status.textContent = { ASSIGNED: '受諾済み', PICKED_UP: '受取済み', DELIVERED: '完了' }[assignment.order.status] || assignment.order.status;
    points.className = 'history-points';
    points.textContent = assignment.scoreEvent ? `+${assignment.scoreEvent.points} pt` : '加点前';
    breakdown.className = 'history-breakdown';
    breakdown.textContent = assignment.scoreEvent?.breakdown?.length
      ? assignment.scoreEvent.breakdown.map((entry) => `${entry.label} +${entry.points}`).join(' / ')
      : assignment.order.status === 'DELIVERED' ? '加点履歴なし' : '配達完了後に加点されます';
    item.append(title, route, status, time, points, breakdown);
    deliveryHistoryList.append(item);
  }
}

function render() {
  workflow.classList.toggle('workflow--active-delivery', Boolean(state.assignment || (state.driver.status === 'OFFERED' && state.offer)));
  if (state.driver.status === 'OFFLINE' || state.location.status === 'MISSING') currentBrowserLocation = null;
  if (state.location.source === 'DEMO' && state.location.coordinates) {
    currentBrowserLocation = state.location.coordinates;
  }
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
    : 'オファーを確認すると、報酬・受取場所・届け先がここに表示されます。';
  const showShiftSummary = state.driver.status === 'OFFLINE' && completedShiftSummary;
  lastShiftSummary.classList.toggle('hidden', !showShiftSummary);
  if (showShiftSummary) {
    shiftSummaryDuration.textContent = DeliveryFlowUi.formatShiftDuration(completedShiftSummary.durationSeconds);
    shiftSummaryDeliveries.textContent = `${completedShiftSummary.completedDeliveries}件`;
    shiftSummaryPoints.textContent = `${completedShiftSummary.pointsEarned} pt`;
    renderShiftReview();
  }
  if (!nextDeliveryKey) {
    displayedOrder = null;
    displayedRouteDistance = null;
    DeliveryFlowUi.updateMarkup(detail, '', '');
  }
  renderScore();
  renderRanking();
  renderHistory();
  const currentWeather = state.simulator?.weatherCondition || 'CLEAR';
  if (document.activeElement !== weatherCondition) weatherCondition.value = currentWeather;
  weatherSimulatorStatus.textContent = `現在: ${currentWeather === 'RAIN' ? '雨' : '晴れ'}`;
  for (const button of [useDemoLocationButton, updateLocationButton]) {
    button.disabled = isLoading || state.driver.status === 'OFFLINE';
    button.dataset.alwaysDisabled = String(state.driver.status === 'OFFLINE');
  }
  const locationLabels = {
    MISSING: '現在地はまだ保存されていません。',
    AVAILABLE: state.location.source === 'DEMO'
      ? `${state.location.label || '京都市内'}を利用中です。個人の現在地は取得していません。`
      : `約100m単位に丸めた端末位置を利用中です（最終更新: ${formatJapanTime(state.location.updatedAt)}、精度 約${Math.round(state.location.accuracyMeters || 100)}m）。`,
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
      state.offer.elevationProfile,
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
      null,
      state.assignment.elevationProfile,
    );
  }
  renderActionDock();
  deliveryMap.update(displayedOrder, {
    currentLocation: currentBrowserLocation,
    pickedUp: Boolean(state.assignment?.pickedUpAt),
    offerPreview: Boolean(activeOffer),
    toPickupMeters: displayedRouteDistance?.toPickupMeters,
    pickupToDropoffMeters: displayedRouteDistance?.pickupToDropoffMeters,
  });
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

async function fetchHistoryPage(filters, token, cursor = null) {
  const parameters = new URLSearchParams(filters);
  if (cursor !== null) parameters.set('cursor', cursor);
  const response = await fetch(`/api/deliveries/history?${parameters}`, { headers: { Authorization: `Bearer ${token}` } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${data.code}: ${data.message}`);
  return data;
}

async function fetchVisibleHistory(filters, token, pageCount) {
  let result = await fetchHistoryPage(filters, token);
  for (let page = 1; page < pageCount && result.pagination.hasMore; page += 1) {
    const next = await fetchHistoryPage(filters, token, result.pagination.nextCursor);
    result = { ...next, deliveries: [...result.deliveries, ...next.deliveries] };
  }
  return result;
}

function resetHistory() {
  historyRevision += 1;
  historyPageCount = 1;
  appliedHistoryFilters = new URLSearchParams(new FormData(historyFilterForm)).toString();
  historyState = { summary: { completedDeliveries: 0, lastDeliveredAt: null }, deliveries: [] };
  historyLoadError.classList.add('hidden');
  renderHistory();
}

async function performRefresh({ preserveMessage = false } = {}) {
  if (!driverToken) {
    resetHistory();
    mapStartedForSession = false;
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
      completedShiftSummary = null;
      return performRefresh();
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`${data.code}: ${data.message}`);
    state = data;
    loadOfflineQueue();
    registrationCard.classList.add('hidden');
    workflow.classList.remove('hidden');
    if (!mapStartedForSession) mapStartedForSession = deliveryMap.enable();
    render();
    const historyRequestRevision = historyRevision;
    const token = driverToken;
    const authenticatedHeaders = { Authorization: `Bearer ${driverToken}` };
    const [history, scoreResponse, rankingResponse] = await Promise.all([
      fetchVisibleHistory(appliedHistoryFilters, token, historyPageCount),
      fetch('/api/drivers/me/score', { headers: authenticatedHeaders }),
      fetch('/api/drivers/ranking', { headers: authenticatedHeaders }),
    ]);
    const [score, ranking] = await Promise.all([
      scoreResponse.json().catch(() => ({})),
      rankingResponse.json().catch(() => ({})),
    ]);
    if (!scoreResponse.ok) throw new Error(`${score.code}: ${score.message}`);
    if (!rankingResponse.ok) throw new Error(`${ranking.code}: ${ranking.message}`);
    if (historyRevision === historyRequestRevision && driverToken === token) historyState = history;
    scoreState = score;
    rankingState = ranking;
    lastSuccessfulRefreshAt = Date.now();
    renderScore();
    renderRanking();
    renderHistory();
    connectRealtime();
    if (message.dataset.source === 'refresh' || (!preserveMessage && message.classList.contains('message--info'))) setMessage('');
    if (offlineQueue[0]?.status === 'pending' && navigator.onLine && !offlineQueueFlushing) {
      queueMicrotask(flushOfflineQueue);
    }
    return true;
  } catch (error) {
    setMessage(`読み込みに失敗しました。${error.message}`, 'error', 'refresh');
    return false;
  }
}

async function autoAdvanceExpiredOffer() {
  if (!DeliveryFlowUi.shouldAutoAdvanceOffer(state, Date.now(), {
    online: navigator.onLine,
    loading: isLoading,
    queuedActions: offlineQueue.length,
    advancingOfferId: autoAdvancingOfferId,
  })) return;

  const expiredOfferId = state.offer.id;
  autoAdvancingOfferId = expiredOfferId;
  setLoading(true);
  setMessage('受付時間が終了しました。次のオファーを探しています。', 'loading');
  try {
    const refreshed = await refresh({ preserveMessage: true });
    if (!refreshed) return;
    if (state?.driver.status !== 'IDLE') {
      if (state?.driver.status === 'OFFERED' && state.offer?.id !== expiredOfferId) {
        setMessage('次のオファーを表示しました。', 'success');
      } else if (state?.driver.status === 'OFFERED' && state.offer?.id === expiredOfferId) {
        // The browser timer can reach zero just before the server clock does.
        // Allow the next one-second tick to confirm expiry again.
        autoAdvancingOfferId = null;
        setMessage('受付時間を確認しています。', 'loading');
      }
      return;
    }
    await request('/api/offers/current');
    const nextOfferLoaded = await refresh({ preserveMessage: true });
    if (!nextOfferLoaded) return;
    setSheetView('delivery');
    if (state?.driver.status === 'OFFERED' && state.offer?.id !== expiredOfferId) {
      setMessage('次のオファーを表示しました。30秒以内に確認してください。', 'success');
    } else {
      setMessage('配達状況を更新しました。', 'info');
    }
  } catch (error) {
    if (error.status === 404) {
      setMessage('現在受け取れる次のオファーはありません。しばらくお待ちください。', 'info');
    } else if (error.network) {
      setMessage('通信が切れたため自動更新を停止しました。接続後に最新の状況を確認してください。', 'error');
    } else {
      setMessage(`次のオファーを表示できませんでした。${error.message}`, 'error');
    }
  } finally {
    setLoading(false);
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
    completedShiftSummary = null;
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
    completedShiftSummary = null;
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
  const button = event.target.closest('button[data-action]');
  const action = button?.dataset.action;
  if (!action || isLoading) return;
  if (button.dataset.confirm && !window.confirm(button.dataset.confirm)) return;
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
  const queueEntry = DeliveryFlowOfflineActions.create(action, { idempotencyKey: crypto.randomUUID() });
  setLoading(true);
  setMessage(`${actionName}を処理しています。`, 'loading');
  try {
    let actionResult;
    if (action === 'start') {
      await request('/api/shifts/start');
      completedShiftSummary = null;
      const demoResult = await saveLocation({ source: 'DEMO' });
      currentBrowserLocation = demoResult.coordinates;
    }
    if (action === 'end') {
      const shiftEndKey = crypto.randomUUID();
      actionResult = await request('/api/shifts/end', null, { idempotencyKey: shiftEndKey });
      completedShiftSummary = actionResult.shiftSummary || null;
      if (completedShiftSummary) completedShiftSummary.shiftEndKey = shiftEndKey;
    }
    if (action === 'offer') await request('/api/offers/current');
    if (action === 'logout') {
      await request('/api/logout');
      disconnectRealtime();
      localStorage.removeItem('deliveryFlowAccessToken');
      driverToken = null;
      completedShiftSummary = null;
      authView = 'login';
      await refresh();
      return;
    }
    if (action.startsWith('reject:')) await request(`/api/offers/${action.split(':')[1]}/reject`);
    if (queueEntry) {
      try {
        if (!navigator.onLine) {
          const offlineError = new Error('ブラウザーがオフラインです。');
          offlineError.network = true;
          throw offlineError;
        }
        actionResult = await request(
          DeliveryFlowOfflineActions.endpoint(queueEntry),
          null,
          { idempotencyKey: queueEntry.idempotencyKey },
        );
      } catch (error) {
        if (!error.network) throw error;
        enqueueOfflineAction(queueEntry);
        setSheetView('delivery');
        setMessage(`${actionName}を端末に保存しました。接続後に自動送信します。`, 'success');
        renderActionDock();
        return;
      }
    }
    await refresh({ preserveMessage: true });
    if (action === 'end' && completedShiftSummary) {
      setSheetView('delivery');
      setBottomSheetState('expanded');
      // Keep the summary above the fixed action dock, even on short screens.
      sheetContent.scrollTop += lastShiftSummary.getBoundingClientRect().top
        - sheetContent.getBoundingClientRect().top;
    }
    if (['offer', 'accept', 'pickup', 'complete'].includes(action.split(':')[0])) {
      setSheetView('delivery');
    }
    const awardDetails = actionResult?.scoreAward?.breakdown
      ?.map((item) => `${item.label} +${item.points}`).join(' / ');
    const completionMessage = action === 'end' && completedShiftSummary
      ? `退勤しました。配達 ${completedShiftSummary.completedDeliveries}件、${completedShiftSummary.pointsEarned}ポイントを記録しました。`
      : action.startsWith('complete:') ? '配達が完了しました。' : `${actionName}が完了しました。`;
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
function renderShiftReview() {
  const review = completedShiftSummary?.aiReview;
  shiftReviewText.textContent = review?.feedback || review?.message
    || '勤務時間・配達件数・ポイントをOpenAIへ送り、約200文字の振り返りを生成します。';
  shiftReviewButton.disabled = ['PENDING', 'AVAILABLE', 'DISABLED', 'UNAVAILABLE'].includes(review?.status);
  shiftReviewButton.textContent = review?.status === 'PENDING' ? '振り返りを生成中…' : 'AIで振り返る';
}

shiftReviewButton.addEventListener('click', async () => {
  const summary = completedShiftSummary;
  if (!summary?.shiftEndKey || shiftReviewButton.disabled || isLoading) return;
  const token = driverToken;
  summary.aiReview = { status: 'PENDING', message: '振り返りを生成しています…' };
  renderShiftReview();
  try {
    // Polling retrieves the saved result; it never starts a second OpenAI call.
    for (let attempt = 0; attempt < 32; attempt += 1) {
      if (summary !== completedShiftSummary || token !== driverToken) return;
      const review = await request('/api/shifts/review', { shiftEndKey: summary.shiftEndKey });
      if (summary !== completedShiftSummary || token !== driverToken) return;
      summary.aiReview = review.status === 'PENDING'
        ? { ...review, message: '振り返りを生成しています…' } : review;
      renderShiftReview();
      if (review.status !== 'PENDING') return;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    summary.aiReview = { message: '結果の取得を中断しました。ボタンで保存済みの結果を確認できます。' };
  } catch {
    summary.aiReview = { message: 'サーバーへ接続できませんでした。ボタンで結果を確認できます。勤務実績は記録済みです。' };
  }
  if (summary === completedShiftSummary && token === driverToken) renderShiftReview();
});
logoutButton.addEventListener('click', handleAction);
offlineQueueStatus.addEventListener('click', async (event) => {
  const queueAction = event.target.closest('button[data-queue-action]')?.dataset.queueAction;
  if (!queueAction || isLoading || !offlineQueue.length) return;
  if (queueAction === 'retry') {
    if (!navigator.onLine) {
      setMessage('まだオフラインです。接続を確認してから再送してください。', 'error');
      return;
    }
    saveOfflineQueue(DeliveryFlowOfflineActions.retry(offlineQueue));
    offlineQueueNotice = '同じIdempotency-Keyで再送します。';
    await flushOfflineQueue();
    return;
  }
  if (queueAction === 'discard') {
    const discarded = offlineQueue[0];
    saveOfflineQueue(offlineQueue.slice(1));
    offlineQueueNotice = '';
    setMessage(`${DeliveryFlowOfflineActions.label(discarded)}の送信待ちを取り消しました。`, 'success');
    renderActionDock();
    await refresh({ preserveMessage: true });
  }
});

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

async function saveLocation(location) {
  const response = await fetch('/api/drivers/me/location', {
    method: 'PUT',
    headers: { Authorization: `Bearer ${driverToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(location),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${result.code}: ${result.message}`);
  return result;
}

useDemoLocationButton.addEventListener('click', async () => {
  if (isLoading) return;
  setLoading(true);
  setMessage('京都のデモ位置へ切り替えています。', 'loading');
  try {
    const result = await saveLocation({ source: 'DEMO' });
    currentBrowserLocation = result.coordinates;
    await refresh({ preserveMessage: true });
    setMessage('京都市役所付近のデモ位置へ切り替えました。個人の現在地は使用していません。', 'success');
  } catch (error) {
    setMessage(`デモ位置へ切り替えられませんでした。${error.message}`, 'error');
  } finally {
    setLoading(false);
    if (state) render();
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
    const roundedLocation = {
      latitude: Math.round(position.coords.latitude * 1000) / 1000,
      longitude: Math.round(position.coords.longitude * 1000) / 1000,
    };
    await saveLocation({
      source: 'DEVICE',
      ...roundedLocation,
      accuracyMeters: Math.max(position.coords.accuracy, 100),
    });
    currentBrowserLocation = {
      latitude: roundedLocation.latitude,
      longitude: roundedLocation.longitude,
    };
    await refresh({ preserveMessage: true });
    setMessage('約100m単位に丸めた現在地を保存し、店舗までの直線距離を再計算しました。', 'success');
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
  const routeKind = routeButton.dataset.routeKind;
  const demoOrigin = state.location.source === 'DEMO' ? currentBrowserLocation : undefined;
  const routeOptions = routeKind === 'offer-preview'
    ? { origin: demoOrigin, destination: dropoff, waypoint: store, navigate: false }
    : routeKind === 'pickup-navigation'
      ? { origin: demoOrigin, destination: store, navigate: true }
      : { origin: store, destination: dropoff, navigate: true };
  const dataDescription = routeKind === 'offer-preview'
    ? state.location.source === 'DEMO'
      ? '京都市役所付近のデモ位置、デモ用の店舗と配達先の座標'
      : 'デモ用の店舗と配達先の座標'
    : routeKind === 'pickup-navigation'
      ? state.location.source === 'DEMO'
        ? '京都市役所付近のデモ位置とデモ用の店舗座標'
        : 'デモ用の店舗座標'
      : 'デモ用の店舗と配達先の座標';
  const locationNotice = state.location.source === 'DEMO' || routeKind === 'dropoff-navigation'
    ? ''
    : '現在地はDeliveryFlowから送信せず、Google Maps側の現在地を使います。';
  const confirmed = window.confirm(
    `${dataDescription}をGoogle Mapsへ送信し、外部サイトを開きます。${locationNotice}よろしいですか？`,
  );
  if (!confirmed) return;
  try {
    const routeUrl = DeliveryFlowRoutePreview.buildGoogleMapsDirectionsUrl(
      routeOptions.destination,
      {
        origin: routeOptions.origin,
        waypoint: routeOptions.waypoint,
        navigate: routeOptions.navigate,
      },
    );
    window.open(routeUrl, '_blank', 'noopener,noreferrer');
    setMessage(routeOptions.navigate
      ? 'Google Mapsのナビを別タブで開きました。'
      : 'Google Mapsの道路経路を別タブで開きました。', 'success');
  } catch (error) {
    setMessage(error.message, 'error');
  }
});

historyFilterForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  resetHistory();
  setLoading(true);
  setMessage('配達履歴を絞り込んでいます。', 'loading');
  try {
    if (refreshPromise) await refreshPromise;
    if (await refresh({ preserveMessage: true })) setMessage('配達履歴を更新しました。', 'success');
  } finally {
    setLoading(false);
  }
});

historyFilterReset.addEventListener('click', async () => {
  historyFilterForm.reset();
  resetHistory();
  setLoading(true);
  try {
    if (refreshPromise) await refreshPromise;
    if (await refresh({ preserveMessage: true })) setMessage('絞り込み条件をリセットしました。', 'success');
  } finally {
    setLoading(false);
  }
});

historyLoadMore.addEventListener('click', async () => {
  if (isLoading || historyLoading || !historyState.pagination?.hasMore) return;
  historyLoading = true;
  setLoading(true);
  historyLoadMore.textContent = '読み込み中...';
  historyLoadError.classList.add('hidden');
  deliveryHistoryList.setAttribute('aria-busy', 'true');
  try {
    if (refreshPromise) await refreshPromise;
    const revision = historyRevision;
    const token = driverToken;
    if (!token || !historyState.pagination?.hasMore) return;
    const next = await fetchHistoryPage(appliedHistoryFilters, token, historyState.pagination.nextCursor);
    if (historyRevision !== revision || driverToken !== token) return;
    const loadedIds = new Set(historyState.deliveries.map((assignment) => assignment.id));
    historyState = { ...next, deliveries: [...historyState.deliveries, ...next.deliveries.filter((assignment) => !loadedIds.has(assignment.id))] };
    historyPageCount += 1;
    renderHistory();
    if (!next.pagination.hasMore) historyResultCount.focus({ preventScroll: true });
  } catch {
    historyLoadError.textContent = '追加の履歴を読み込めませんでした。もう一度お試しください。';
    historyLoadError.classList.remove('hidden');
  } finally {
    historyLoading = false;
    historyLoadMore.textContent = 'さらに読み込む';
    deliveryHistoryList.setAttribute('aria-busy', 'false');
    setLoading(false);
  }
});

window.addEventListener('beforeunload', () => {
  pageIsUnloading = true;
  disconnectRealtime();
});
window.addEventListener('online', () => {
  offlineQueueNotice = '接続が戻りました。保存した操作を確認しています。';
  renderOfflineQueueStatus();
  flushOfflineQueue();
});
window.addEventListener('offline', () => {
  renderOfflineQueueStatus();
  setRealtimeStatus('fallback');
});

setBottomSheetState(bottomSheetState);
setRankingPeriod(activeRankingPeriod);
refresh();
setInterval(() => {
  if (!state?.offer || isLoading) return;
  renderActionDock();
  if (DeliveryFlowUi.shouldAutoAdvanceOffer(state, Date.now(), {
    online: navigator.onLine,
    loading: isLoading,
    queuedActions: offlineQueue.length,
    advancingOfferId: autoAdvancingOfferId,
  })) void autoAdvanceExpiredOffer();
}, 1000);
setInterval(() => {
  const realtimeConnected = realtimeSocket?.readyState === WebSocket.OPEN;
  const safetyRefreshDue = Date.now() - lastSuccessfulRefreshAt >= 60_000;
  if (!isLoading && (!realtimeConnected || safetyRefreshDue)) refresh({ preserveMessage: true });
}, 10_000);

