const assert = require('node:assert/strict');
const test = require('node:test');
const {
  escapeHtml, getActionView, nextRankingPeriod, offerCountdown, renderActions, updateMarkup,
} = require('../public/delivery-ui');

const now = Date.parse('2026-09-21T09:00:00Z');
const order = {
  store: { name: '駅前ストア' },
  pickupName: '受取カウンター',
  dropoffName: '中央マンション',
};

function offered(expiresAt = '2026-09-21T09:00:30Z') {
  return {
    driver: { status: 'OFFERED' },
    offer: { id: 'offer-1', order, expiresAt, acceptanceSeconds: 30 },
  };
}

test('勤務前と待機中は勤務状態に合った操作を表示する', () => {
  const offline = getActionView({ driver: { status: 'OFFLINE' } }, now);
  assert.equal(offline.primary.action, 'start');
  assert.deepEqual(offline.secondary, []);

  const idle = getActionView({ driver: { status: 'IDLE' }, location: { status: 'MISSING' } }, now);
  assert.equal(idle.primary.action, 'offer');
  assert.deepEqual(idle.secondary.map((item) => item.action), ['end']);
  assert.match(idle.destination, /現在地/);
});

test('有効なオファーには受諾・辞退・退勤と行き先を表示する', () => {
  const view = getActionView(offered(), now);
  assert.equal(view.primary.action, 'accept:offer-1');
  assert.deepEqual(view.secondary.map((item) => item.action), ['reject:offer-1', 'end']);
  assert.equal(view.destination, '駅前ストア → 中央マンション');
  assert.equal(view.expired, false);
  assert.equal(view.deadline, '残り 30秒');
  assert.deepEqual(view.countdown, {
    durationSeconds: 30, remainingSeconds: 30, progressValue: 30, urgent: false, expired: false,
  });
});

test('オファーの残り時間を30秒のバーへ変換する', () => {
  assert.deepEqual(offerCountdown('2026-09-21T09:00:30Z', now + 20_000), {
    durationSeconds: 30, remainingSeconds: 10, progressValue: 10, urgent: true, expired: false,
  });
  assert.deepEqual(offerCountdown('2026-09-21T09:00:30Z', now + 30_000), {
    durationSeconds: 30, remainingSeconds: 0, progressValue: 0, urgent: false, expired: true,
  });
  assert.equal(offerCountdown(null, now), null);
});

test('オファーの期限ちょうどから受諾を最新状況の確認に置き換える', () => {
  const state = offered();
  const deadline = Date.parse(state.offer.expiresAt);
  assert.equal(getActionView(state, deadline - 1).primary.action, 'accept:offer-1');
  for (const time of [deadline, deadline + 1]) {
    const view = getActionView(state, time);
    assert.equal(view.expired, true);
    assert.equal(view.primary.action, 'refresh');
    assert.deepEqual(view.secondary, []);
    const markup = renderActions(view);
    assert.match(markup, /data-action="refresh"/);
    assert.doesNotMatch(markup, /data-action="(?:accept|reject):/);
  }
});

test('期限のないオファーも受諾できる', () => {
  for (const expiry of [null, '']) {
    const view = getActionView(offered(expiry), now);
    assert.equal(view.expired, false);
    assert.equal(view.deadline, '期限なし');
    assert.equal(view.countdown, null);
    assert.equal(view.primary.action, 'accept:offer-1');
  }
  const state = offered();
  delete state.offer.expiresAt;
  assert.equal(getActionView(state, now).primary.action, 'accept:offer-1');
});

test('受取前は店舗への案内と受取操作、受取後は配達先への案内と完了操作を表示する', () => {
  const state = {
    driver: { status: 'ASSIGNED' },
    assignment: { id: 'assignment-1', order, pickedUpAt: null },
  };
  const pickup = getActionView(state, now);
  assert.equal(pickup.guidance, '店舗へ向かってください');
  assert.equal(pickup.destination, '駅前ストア · 受取カウンター');
  assert.equal(pickup.primary.action, 'pickup:assignment-1');
  assert.deepEqual(pickup.secondary, []);

  state.assignment.pickedUpAt = '2026-09-21T08:59:00Z';
  const complete = getActionView(state, now);
  assert.equal(complete.guidance, '配達先へ向かってください');
  assert.equal(complete.destination, '中央マンション');
  assert.equal(complete.primary.action, 'complete:assignment-1');
  assert.deepEqual(complete.secondary, []);
});

test('保存中は主操作と副操作をすべて無効にする', () => {
  const view = getActionView(offered(), now);
  assert.equal((renderActions(view, { loading: true }).match(/ disabled/g) || []).length, 3);
  assert.doesNotMatch(renderActions(view), / disabled/);
});

test('ランキング期間を左右キーと端キーで切り替える', () => {
  assert.equal(nextRankingPeriod('monthly', 'ArrowRight'), 'current');
  assert.equal(nextRankingPeriod('current', 'ArrowRight'), 'lifetime');
  assert.equal(nextRankingPeriod('lifetime', 'ArrowRight'), 'monthly');
  assert.equal(nextRankingPeriod('monthly', 'ArrowLeft'), 'lifetime');
  assert.equal(nextRankingPeriod('current', 'Home'), 'monthly');
  assert.equal(nextRankingPeriod('current', 'End'), 'lifetime');
});

test('表示文字と操作属性に含まれるHTMLをエスケープする', () => {
  const malicious = `"><img src=x onerror='alert(1)'>&`;
  const escaped = '&quot;&gt;&lt;img src=x onerror=&#039;alert(1)&#039;&gt;&amp;';
  assert.equal(escapeHtml(malicious), escaped);
  const markup = renderActions({
    primary: { label: malicious, action: malicious },
    secondary: [{ label: malicious, action: malicious }],
  });
  assert.equal((markup.match(/<button /g) || []).length, 2);
  assert.doesNotMatch(markup, /<img/);
  assert.ok(markup.includes(`data-action="${escaped}"`));
  assert.ok(markup.includes(`>${escaped}</button>`));

  const state = offered();
  state.offer.order = { ...order, store: { name: malicious }, dropoffName: malicious };
  assert.equal(escapeHtml(getActionView(state, now).destination), `${escaped} → ${escaped}`);
});

// Only model the DOM behavior updateMarkup needs: replacing children loses
// their identity and focus, and fresh details elements start closed.
function createContainer() {
  const document = { activeElement: null };
  let markup = '';
  let children = [];
  return {
    dataset: {},
    ownerDocument: document,
    get innerHTML() { return markup; },
    set innerHTML(value) {
      if (children.includes(document.activeElement)) document.activeElement = null;
      markup = value;
      children = [...value.matchAll(/<(details|summary|button)\b([^>]*)>/g)].map((match) => {
        const dataset = {};
        for (const attribute of match[2].matchAll(/data-(action|route-kind)="([^"]*)"/g)) {
          dataset[attribute[1] === 'route-kind' ? 'routeKind' : 'action'] = attribute[2];
        }
        return {
          tagName: match[1].toUpperCase(),
          dataset,
          open: /\bopen\b/.test(match[2]),
          disabled: /\bdisabled\b/.test(match[2]),
          focus() { document.activeElement = this; },
        };
      });
    },
    contains(element) { return children.includes(element); },
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
    querySelectorAll(selector) {
      const tags = selector.split(',').map((tag) => tag.trim().toUpperCase());
      return children.filter((element) => tags.includes(element.tagName));
    },
  };
}

const detailsMarkup = '<details><summary>配達の詳細</summary><button data-route-kind="pickup">店舗への経路</button></details>';

test('同じ注文の内容が変わらなければDOMと操作中のフォーカスを維持する', () => {
  const element = createContainer();
  updateMarkup(element, detailsMarkup, 'order-1');
  const details = element.querySelector('details');
  const button = element.querySelector('button');
  details.open = true;
  button.focus();
  updateMarkup(element, detailsMarkup, 'order-1');
  assert.equal(element.querySelector('details'), details);
  assert.equal(element.querySelector('button'), button);
  assert.equal(details.open, true);
  assert.equal(element.ownerDocument.activeElement, button);
});

test('同じ注文の更新では開いた詳細と経路ボタンのフォーカスを引き継ぐ', () => {
  const element = createContainer();
  updateMarkup(element, detailsMarkup, 'order-1');
  const originalButton = element.querySelector('button');
  element.querySelector('details').open = true;
  originalButton.focus();
  updateMarkup(element, `${detailsMarkup}<p>距離が更新されました</p>`, 'order-1');
  assert.notEqual(element.querySelector('button'), originalButton);
  assert.equal(element.querySelector('details').open, true);
  assert.equal(element.ownerDocument.activeElement, element.querySelector('button'));
});

test('同じ注文の更新では詳細見出しと操作ボタンのフォーカスを引き継ぐ', () => {
  for (const selector of ['summary', 'button']) {
    const element = createContainer();
    const markup = '<details><summary>配達の詳細</summary></details><button data-action="pickup:assignment-1">受け取りました</button>';
    updateMarkup(element, markup, 'order-1');
    element.querySelector(selector).focus();
    updateMarkup(element, `${markup}<p>状態が更新されました</p>`, 'order-1');
    assert.equal(element.ownerDocument.activeElement, element.querySelector(selector));
  }
});

test('別の注文になったら詳細の開閉状態と操作フォーカスをリセットする', () => {
  const element = createContainer();
  updateMarkup(element, detailsMarkup, 'order-1');
  const originalDetails = element.querySelector('details');
  originalDetails.open = true;
  element.querySelector('button').focus();
  updateMarkup(element, detailsMarkup, 'order-2');
  assert.notEqual(element.querySelector('details'), originalDetails);
  assert.equal(element.querySelector('details').open, false);
  assert.equal(element.ownerDocument.activeElement, null);
});

test('更新後に無効になった操作へフォーカスを戻さない', () => {
  const element = createContainer();
  updateMarkup(element, '<button data-action="offer">オファーを確認する</button>', 'order-1');
  element.querySelector('button').focus();
  updateMarkup(element, '<button data-action="offer" disabled>オファーを確認する</button>', 'order-1');
  assert.equal(element.ownerDocument.activeElement, null);
});
