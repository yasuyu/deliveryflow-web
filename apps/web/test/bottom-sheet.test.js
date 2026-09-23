const assert = require('node:assert/strict');
const test = require('node:test');
const {
  adjacentState,
  calculateSnapHeights,
  nearestState,
} = require('../public/bottom-sheet');

test('ボトムシートの各段階で地図領域を残す', () => {
  const heights = calculateSnapHeights(1000);
  assert.deepEqual(heights, { collapsed: 136, medium: 480, expanded: 778 });
  assert.equal(1000 - heights.expanded, 222);
});

test('スマートフォンでも3段階の高さを保つ', () => {
  const heights = calculateSnapHeights(700, { mobile: true });
  assert.ok(heights.collapsed < heights.medium);
  assert.ok(heights.medium < heights.expanded);
  assert.equal(heights.expanded, 596);
  assert.equal(700 - heights.expanded, 104);
});

test('縮小時も案内と操作フッターの実測高さを確保する', () => {
  for (const mobile of [false, true]) {
    const heights = calculateSnapHeights(700, { mobile, minimumContentHeight: 236 });
    assert.equal(heights.collapsed, 236);
    assert.ok(heights.collapsed < heights.medium);
    assert.ok(heights.medium < heights.expanded);
  }
});

test('小さい画面でもフッターが高い場合の3段階を順番どおりに保つ', () => {
  for (const viewportHeight of [320, 568, 700]) {
    for (const mobile of [false, true]) {
      const heights = calculateSnapHeights(viewportHeight, { mobile, minimumContentHeight: 300 });
      assert.ok(heights.collapsed >= 300);
      assert.ok(heights.collapsed < heights.medium);
      assert.ok(heights.medium < heights.expanded);
    }
  }
});

test('ドラッグ終了位置に最も近い段階を選ぶ', () => {
  const heights = { collapsed: 136, medium: 480, expanded: 630 };
  assert.equal(nearestState(150, heights), 'collapsed');
  assert.equal(nearestState(510, heights), 'medium');
  assert.equal(nearestState(620, heights), 'expanded');
});

test('上下操作は範囲外へ進まない', () => {
  assert.equal(adjacentState('collapsed', -1), 'collapsed');
  assert.equal(adjacentState('collapsed', 1), 'medium');
  assert.equal(adjacentState('medium', 1), 'expanded');
  assert.equal(adjacentState('expanded', 1), 'expanded');
});

