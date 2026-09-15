const statusText = {
  OFFLINE: 'OFFLINE（退勤中）',
  IDLE: 'IDLE（待機中）',
  OFFERED: 'OFFERED（オファー確認中）',
  BUSY: 'BUSY（配達中）',
};

const message = document.querySelector('#message');
const registrationMessage = document.querySelector('#registrationMessage');
const actions = document.querySelector('#actions');
const detail = document.querySelector('#deliveryDetail');
const card = document.querySelector('#deliveryCard');
const registrationCard = document.querySelector('#registrationCard');
const registrationForm = document.querySelector('#registrationForm');
const loginForm = document.querySelector('#loginForm');
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
let driverToken = localStorage.getItem('deliveryFlowAccessToken');
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

function setMessage(text, kind = 'info') {
  message.textContent = text;
  message.className = `message message--${kind}`;
}

function setRegistrationMessage(text = '') {
  registrationMessage.textContent = text;
  registrationMessage.classList.toggle('hidden', !text);
}

function setLoading(loading) {
  isLoading = loading;
  document.querySelectorAll('button').forEach((element) => {
    element.disabled = loading || element.dataset.alwaysDisabled === 'true';
  });
  actions.setAttribute('aria-busy', String(loading));
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

function button(label, action, alwaysDisabled = false) {
  const disabled = isLoading || alwaysDisabled;
  return `<button data-action="${action}" data-always-disabled="${alwaysDisabled}"${disabled ? ' disabled' : ''}>${label}</button>`;
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

function scoreBreakdownMarkup(estimatedPoints, scoreBreakdown = []) {
  if (estimatedPoints === null) return '';
  const rows = scoreBreakdown
    .map((item) => `<li><span>${item.label}</span><strong>+${item.points} pt</strong></li>`)
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
  detail.innerHTML = `${DeliveryFlowRoutePreview.renderRoutePreview(order, routeDistance, {
    canOpenCurrentRoute: Boolean(currentBrowserLocation),
  })}<dl>
    <dt>店舗</dt><dd>${order.store.name}</dd>
    <dt>受取先</dt><dd>${order.pickupName}</dd>
    <dt>届け先</dt><dd>${order.dropoffName}</dd>
    <dt>注文の状態</dt><dd>${order.status}</dd>
    <dt>現在地 → 店舗</dt><dd>${formatDistance(routeDistance.toPickupMeters)}</dd>
    ${matchedDistanceToPickupMeters === null ? '' : `<dt>候補選定時の距離</dt><dd>${formatDistance(matchedDistanceToPickupMeters)}（直線）</dd>`}
    <dt>店舗 → 届け先</dt><dd>${formatDistance(routeDistance.pickupToDropoffMeters)}（直線）</dd>
    <dt>${extraLabel}</dt><dd>${extraValue}</dd>
    ${scoreBreakdownMarkup(estimatedPoints, scoreBreakdown)}
  </dl>`;
}

function renderScore() {
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
  meElement.textContent = period.me
    ? `あなたは ${period.me.rank}位 · ${period.me.score}ポイント${period.me.monthlyTitle ? ` · ${period.me.monthlyTitle}` : ''}`
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
  workflow.classList.toggle('workflow--active-delivery', Boolean(state.assignment || state.offer));
  if (state.driver.status === 'OFFLINE') currentBrowserLocation = null;
  document.querySelector('#driverStatus').textContent = statusText[state.driver.status];
  document.querySelector('#driverName').textContent = state.driver.name;
  document.querySelector('#driverId').textContent = `配達員ID: ${state.driver.id}`;
  document.querySelector('#shiftStartedAt').textContent = state.driver.shiftStartedAt
    ? `稼働開始: ${formatJapanTime(state.driver.shiftStartedAt)}`
    : '現在は退勤中です';

  actions.innerHTML = '';
  card.classList.add('hidden');
  renderScore();
  renderRanking();
  renderHistory();
  const currentWeather = state.simulator?.weatherCondition || 'CLEAR';
  weatherCondition.value = currentWeather;
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

  if (state.driver.status === 'OFFLINE') {
    actions.innerHTML = button('稼働を開始する', 'start');
  }
  if (state.driver.status === 'IDLE') {
    actions.innerHTML = button('オファーを確認する', 'offer') + button('退勤する', 'end');
  }
  if (state.driver.status === 'OFFERED' && state.offer) {
    actions.innerHTML =
      button('この配達を受諾する', `accept:${state.offer.id}`) +
      button('このオファーを辞退する', `reject:${state.offer.id}`) +
      button('オファーを辞退して退勤する', 'end');
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
    if (!state.assignment.pickedUpAt) {
      actions.innerHTML = button('荷物を受け取った', `pickup:${state.assignment.id}`);
    } else if (!state.assignment.deliveredAt) {
      actions.innerHTML = button('配達を完了する', `complete:${state.assignment.id}`);
    }
  }

  actions.innerHTML += button(
    state.driver.status === 'OFFLINE' ? 'この端末からログアウトする' : 'ログアウトするには先に退勤してください',
    'logout',
    state.driver.status !== 'OFFLINE',
  );

  if (!isLoading) {
    const guidance = {
      OFFLINE: '稼働を開始すると、新しいオファーを確認できます。',
      IDLE: state.location.status === 'MISSING'
        ? '現在地を更新すると、店舗に近い配達員からオファー候補になります。'
        : '近い配達員へ送られたオファーを確認するか、退勤を選んでください。',
      OFFERED: '内容と期限を確認して、受諾または辞退を選んでください。',
      BUSY: state.assignment?.pickedUpAt
        ? '配達先に到着したら、配達完了を記録してください。'
        : '店舗で荷物を受け取ったら、受取を記録してください。',
    };
    setMessage(guidance[state.driver.status]);
  }
}

async function refresh({ preserveMessage = false } = {}) {
  if (!driverToken) {
    loginForm.elements.driverId.value = localStorage.getItem('deliveryFlowDriverId') || '';
    registrationCard.classList.remove('hidden');
    workflow.classList.add('hidden');
    return;
  }
  try {
    const response = await fetch('/api/dashboard', {
      headers: { Authorization: `Bearer ${driverToken}` },
    });
    if (response.status === 401) {
      localStorage.removeItem('deliveryFlowAccessToken');
      driverToken = null;
      return refresh();
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`${data.code}: ${data.message}`);
    state = data;
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
    registrationCard.classList.add('hidden');
    workflow.classList.remove('hidden');
    render();
    if (!preserveMessage) setMessage('最新の配達状況を表示しています。', 'success');
  } catch (error) {
    setMessage(`読み込みに失敗しました。${error.message}`, 'error');
  }
}

registrationForm.addEventListener('submit', async (event) => {
  event.preventDefault();
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
    setRegistrationMessage();
    await refresh({ preserveMessage: true });
    setMessage('ログインしました。', 'success');
  } catch (error) {
    setRegistrationMessage(`ログインに失敗しました。${error.message}`);
  } finally {
    setLoading(false);
  }
});

actions.addEventListener('click', async (event) => {
  const action = event.target.dataset.action;
  if (!action || isLoading) return;
  const actionLabels = {
    start: '稼働を開始', end: '退勤', offer: 'オファーの確認',
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
      localStorage.removeItem('deliveryFlowAccessToken');
      driverToken = null;
      await refresh();
      return;
    }
    if (action.startsWith('accept:')) await request(`/api/offers/${action.split(':')[1]}/accept`);
    if (action.startsWith('reject:')) await request(`/api/offers/${action.split(':')[1]}/reject`);
    if (action.startsWith('pickup:')) await request(`/api/assignments/${action.split(':')[1]}/pickup`);
    if (action.startsWith('complete:')) actionResult = await request(`/api/assignments/${action.split(':')[1]}/complete`);
    await refresh({ preserveMessage: true });
    const awardDetails = actionResult?.scoreAward?.breakdown
      ?.map((item) => `${item.label} +${item.points}`).join(' / ');
    setMessage(actionResult?.scoreAward
      ? `${actionName}が完了しました。${awardDetails}、合計 +${actionResult.scoreAward.points}ポイント獲得しました。`
      : `${actionName}が完了しました。`, 'success');
  } catch (error) {
    setMessage(`${actionName}に失敗しました。${error.message}`, 'error');
  } finally {
    setLoading(false);
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

refresh();
setInterval(() => {
  if (!isLoading) refresh();
}, 10_000);
