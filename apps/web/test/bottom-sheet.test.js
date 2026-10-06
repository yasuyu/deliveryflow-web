const assert = require('node:assert/strict');
const test = require('node:test');
const {
  adjacentState,
  calculateSnapHeights,
  nearestState,
  visualViewportLayout,
} = require('../public/bottom-sheet');

test('ボトムシートの各段階で地図領域を残す', () => {
  const heights = calculateSnapHeights(1000);
  assert.deepEqual(heights, { minimized: 40, collapsed: 136, medium: 480, expanded: 778 });
  assert.equal(1000 - heights.expanded, 222);
});

test('スマートフォンでも4段階の高さを保つ', () => {
  const heights = calculateSnapHeights(700, { mobile: true });
  assert.ok(heights.minimized < heights.collapsed);
  assert.ok(heights.collapsed < heights.medium);
  assert.ok(heights.medium < heights.expanded);
  assert.equal(heights.expanded, 596);
  assert.equal(700 - heights.expanded, 104);
});

test('縮小時も案内と操作フッターの実測高さを確保する', () => {
  for (const mobile of [false, true]) {
    const heights = calculateSnapHeights(700, {
      mobile,
      minimumContentHeight: 236,
      minimumHandleHeight: 28,
    });
    assert.ok(heights.minimized >= 28);
    assert.equal(heights.collapsed, 236);
    assert.ok(heights.collapsed < heights.medium);
    assert.ok(heights.medium < heights.expanded);
  }
});

test('小さい画面でもフッターが高い場合の4段階を順番どおりに保つ', () => {
  for (const viewportHeight of [320, 568, 700]) {
    for (const mobile of [false, true]) {
      const heights = calculateSnapHeights(viewportHeight, { mobile, minimumContentHeight: 300 });
      assert.ok(heights.minimized < heights.collapsed);
      assert.ok(heights.collapsed >= 300);
      assert.ok(heights.collapsed < heights.medium);
      assert.ok(heights.medium < heights.expanded);
    }
  }
});

test('ドラッグ終了位置に最も近い段階を選ぶ', () => {
  const heights = { minimized: 32, collapsed: 136, medium: 480, expanded: 630 };
  assert.equal(nearestState(40, heights), 'minimized');
  assert.equal(nearestState(150, heights), 'collapsed');
  assert.equal(nearestState(510, heights), 'medium');
  assert.equal(nearestState(620, heights), 'expanded');
});

test('上下操作は範囲外へ進まない', () => {
  assert.equal(adjacentState('minimized', -1), 'minimized');
  assert.equal(adjacentState('collapsed', -1), 'minimized');
  assert.equal(adjacentState('collapsed', 1), 'medium');
  assert.equal(adjacentState('medium', 1), 'expanded');
  assert.equal(adjacentState('expanded', 1), 'expanded');
});

test('拡大されたスマートフォンでも表示領域の中央を返す', () => {
  assert.deepEqual(
    visualViewportLayout({ width: 320, offsetLeft: 24 }, 390),
    { width: 320, centerX: 184, offsetTop: 0 },
  );
  assert.deepEqual(visualViewportLayout(null, 390), { width: 390, centerX: 195, offsetTop: 0 });
});

test('キーボードや拡大で上下にずれた表示領域の上端を返す', () => {
  assert.equal(visualViewportLayout({ width: 320, offsetTop: 160 }, 390).offsetTop, 160);
  for (const offsetTop of [undefined, -20, 'invalid']) {
    assert.equal(visualViewportLayout({ width: 320, offsetTop }, 390).offsetTop, 0);
  }
});

