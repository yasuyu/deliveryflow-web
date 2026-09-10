const statusText = {
  OFFLINE: 'OFFLINE（退勤中）',
  IDLE: 'IDLE（待機中）',
  OFFERED: 'OFFERED（オファー確認中）',
  BUSY: 'BUSY（配達中）',
};

const message = document.querySelector('#message');
const actions = document.querySelector('#actions');
const detail = document.querySelector('#deliveryDetail');
const card = document.querySelector('#deliveryCard');
const registrationCard = document.querySelector('#registrationCard');
const registrationForm = document.querySelector('#registrationForm');
const workflow = document.querySelector('#workflow');
let driverToken = localStorage.getItem('deliveryFlowDriverId');
let state;

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
      const data = await response.json();
      if (!response.ok) throw new Error(`${data.code}: ${data.message}`);
      return data;
    } catch (error) {
      if (attempt === 1 || !(error instanceof TypeError)) throw error;
    }
  }
}

function button(label, action) {
  return `<button data-action="${action}">${label}</button>`;
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

function render() {
  document.querySelector('#driverStatus').textContent = statusText[state.driver.status];
  document.querySelector('#driverName').textContent = state.driver.name;
  document.querySelector('#shiftStartedAt').textContent = state.driver.shiftStartedAt
    ? `稼働開始: ${formatJapanTime(state.driver.shiftStartedAt)}`
    : '現在は退勤中です';

  actions.innerHTML = '';
  card.classList.add('hidden');

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
}

async function refresh() {
  if (!driverToken) {
    registrationCard.classList.remove('hidden');
    workflow.classList.add('hidden');
    return;
  }
  const response = await fetch('/api/dashboard', {
    headers: { Authorization: `Bearer ${driverToken}` },
  });
  if (response.status === 401) {
    localStorage.removeItem('deliveryFlowDriverId');
    driverToken = null;
    return refresh();
  }
  state = await response.json();
  registrationCard.classList.add('hidden');
  workflow.classList.remove('hidden');
  render();
  message.textContent = '資料に定義された順序で操作してください。';
}

registrationForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const { name } = Object.fromEntries(new FormData(registrationForm));
  const response = await fetch('/api/drivers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  const driver = await response.json();
  if (!response.ok) {
    alert(driver.message);
    return;
  }
  driverToken = String(driver.id);
  localStorage.setItem('deliveryFlowDriverId', driverToken);
  await refresh();
});

actions.addEventListener('click', async (event) => {
  const action = event.target.dataset.action;
  if (!action) return;
  try {
    if (action === 'start') await request('/api/shifts/start');
    if (action === 'end') await request('/api/shifts/end');
    if (action === 'offer') await request('/api/offers/current');
    if (action.startsWith('accept:')) await request(`/api/offers/${action.split(':')[1]}/accept`);
    if (action.startsWith('reject:')) await request(`/api/offers/${action.split(':')[1]}/reject`);
    if (action.startsWith('pickup:')) await request(`/api/assignments/${action.split(':')[1]}/pickup`);
    if (action.startsWith('complete:')) await request(`/api/assignments/${action.split(':')[1]}/complete`);
    await refresh();
  } catch (error) {
    message.textContent = error.message;
  }
});

refresh();
setInterval(refresh, 10_000);
