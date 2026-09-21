(function attachBottomSheetHelpers(globalScope) {
  const states = ['collapsed', 'medium', 'expanded'];

  function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
  }

  function calculateSnapHeights(viewportHeight, { mobile = false } = {}) {
    const height = Math.max(320, Number(viewportHeight) || 0);
    const collapsed = mobile ? 128 : 136;
    const chromeHeight = mobile ? 64 : 150;
    const minimumMapHeight = mobile ? 40 : 72;
    const expanded = Math.max(collapsed + 96, height - chromeHeight - minimumMapHeight);
    const medium = clamp(
      Math.round(height * 0.48),
      collapsed + 48,
      Math.max(collapsed + 48, expanded - 48),
    );
    return { collapsed, medium, expanded };
  }

  function nearestState(height, snapHeights) {
    return states.reduce((nearest, state) => (
      Math.abs(height - snapHeights[state]) < Math.abs(height - snapHeights[nearest])
        ? state
        : nearest
    ), states[0]);
  }

  function adjacentState(state, direction) {
    const currentIndex = Math.max(0, states.indexOf(state));
    return states[clamp(currentIndex + direction, 0, states.length - 1)];
  }

  const api = { states, calculateSnapHeights, nearestState, adjacentState };
  globalScope.DeliveryFlowBottomSheet = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
}(typeof window === 'undefined' ? globalThis : window));

