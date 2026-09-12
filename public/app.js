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
const completedDeliveryCount = document.querySelector('#completedDeliveryCount');
const lastDeliveredAt = document.querySelector('#lastDeliveredAt');
const deliveryHistoryList = document.querySelector('#deliveryHistory');
const historyFilterForm = document.querySelector('#historyFilterForm');
const historyFilterReset = document.querySelector('#historyFilterReset');
const historyResultCount = document.querySelector('#historyResultCount');
let driverToken = localStorage.getItem('deliveryFlowAccessToken');
let state;
let historyState = { summary: { completedDeliveries: 0, lastDeliveredAt: null }, deliveries: [] };
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

async function request(url) {
  const idempotencyKey = crypto.randomUUID();
  const options = {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${driverToken}`,
      'Idempotency-Key': idempotencyKey,
    },
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

function showOrder(order, extraLabel, extraValue) {
  card.classList.remove('hidden');
  detail.innerHTML = `<dl>
    <dt>店舗</dt><dd>${order.store.name}</dd>
    <dt>受取先</dt><dd>${order.pickupName}</dd>
    <dt>届け先</dt><dd>${order.dropoffName}</dd>
    <dt>注文の状態</dt><dd>${order.status}</dd>
    <dt>${extraLabel}</dt><dd>${extraValue}</dd>
  </dl>`;
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
  document.querySelector('#driverStatus').textContent = statusText[state.driver.status];
  document.querySelector('#driverName').textContent = state.driver.name;
  document.querySelector('#driverId').textContent = `配達員ID: ${state.driver.id}`;
  document.querySelector('#shiftStartedAt').textContent = state.driver.shiftStartedAt
    ? `稼働開始: ${formatJapanTime(state.driver.shiftStartedAt)}`
    : '現在は退勤中です';

  actions.innerHTML = '';
  card.classList.add('hidden');
  renderHistory();

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
    );
  }
  if (state.assignment) {
    const order = state.assignment.order;
    showOrder(order, '受諾時刻', formatJapanTime(state.assignment.acceptedAt));
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
      IDLE: 'オファーを確認するか、退勤を選んでください。',
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
    const historyResponse = await fetch(`/api/deliveries/history?${historyParameters}`, {
      headers: { Authorization: `Bearer ${driverToken}` },
    });
    const history = await historyResponse.json().catch(() => ({}));
    if (!historyResponse.ok) throw new Error(`${history.code}: ${history.message}`);
    historyState = history;
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
    if (action.startsWith('complete:')) await request(`/api/assignments/${action.split(':')[1]}/complete`);
    await refresh({ preserveMessage: true });
    setMessage(`${actionName}が完了しました。`, 'success');
  } catch (error) {
    setMessage(`${actionName}に失敗しました。${error.message}`, 'error');
  } finally {
    setLoading(false);
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
