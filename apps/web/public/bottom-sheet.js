(function attachBottomSheetHelpers(globalScope) {
  const states = ['minimized', 'collapsed', 'medium', 'expanded'];

  function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
  }

  function calculateSnapHeights(viewportHeight, {
    mobile = false,
    minimumContentHeight = 0,
    minimumHandleHeight = 0,
  } = {}) {
    const height = Math.max(320, Number(viewportHeight) || 0);
    const minimized = Math.max(mobile ? 32 : 40, minimumHandleHeight);
    const collapsed = Math.max(mobile ? 128 : 136, minimumContentHeight, minimized + 48);
    const chromeHeight = mobile ? 64 : 150;
    const minimumMapHeight = mobile ? 40 : 72;
    const expanded = Math.max(collapsed + 96, height - chromeHeight - minimumMapHeight);
    const medium = clamp(
      Math.round(height * 0.48),
      collapsed + 48,
      Math.max(collapsed + 48, expanded - 48),
    );
    return { minimized, collapsed, medium, expanded };
  }

  function visualViewportLayout(viewport, fallbackWidth = 0) {
    const fallback = Math.max(0, Number(fallbackWidth) || 0);
    const width = Math.max(0, Number(viewport?.width) || fallback);
    const offsetLeft = Number.isFinite(Number(viewport?.offsetLeft))
      ? Number(viewport.offsetLeft) : 0;
    return { width, centerX: offsetLeft + (width / 2) };
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

  const api = {
    states,
    calculateSnapHeights,
    visualViewportLayout,
    nearestState,
    adjacentState,
  };
  globalScope.DeliveryFlowBottomSheet = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
}(typeof window === 'undefined' ? globalThis : window));

