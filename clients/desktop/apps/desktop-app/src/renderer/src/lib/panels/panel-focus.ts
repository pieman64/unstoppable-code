/**
 * DOM focus helpers for the panel grid (Phase 9 focus/a11y polish).
 *
 * The layout store owns the LOGICAL focus (activeGroupId/MRU); these helpers
 * move the DOM focus to match after cross-window transitions — into a pulled
 * out window once its grid renders, and back to the merged-into group after
 * a merge-back. DOM focus works in headless/E2E windows too (an element can
 * be `document.activeElement` without OS focus), so specs can assert it.
 *
 * Target resolution: the group's roving tab (`role="tab"` with
 * `tabindex="0"` — PanelTabBar's roving-tabindex holder) is the natural
 * focus anchor; any focusable fallback inside the group is accepted when a
 * group has no tabs (defensive).
 */

/**
 * Moves DOM focus to `groupId`'s roving tab inside `doc`. Returns whether an
 * element was focused. Never throws (cross-window DOM access can throw on a
 * closing child window).
 */
export function focusPanelGroupElement(
  doc: Document,
  groupId: string,
): boolean {
  try {
    const group = doc.querySelector(`[data-testid="panel-group-${groupId}"]`);
    if (!group) {
      return false;
    }
    const target =
      group.querySelector('[role="tab"][tabindex="0"]') ??
      group.querySelector('button');
    if (target instanceof HTMLElement) {
      target.focus();
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Defers {@link focusPanelGroupElement} by one macrotask so a store commit's
 * React re-render (which may create the roving tab element, e.g. the freshly
 * adopted tab after a merge-back) lands first. A macrotask (not rAF) so the
 * behavior is identical in headless windows, where rAF can be throttled.
 */
export function schedulePanelGroupFocus(doc: Document, groupId: string): void {
  if (typeof setTimeout !== 'function') {
    return;
  }
  setTimeout((): void => {
    focusPanelGroupElement(doc, groupId);
  }, 0);
}
