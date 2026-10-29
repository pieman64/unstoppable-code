/**
 * The most tabs one panel group (one tab row) holds while its tabs use the
 * `fill` style, counting every panel kind. Those rows never scroll; past this
 * many tabs they could no longer be told apart, so opening another tab into a
 * full row is refused. Classic rows scroll and have no limit.
 */
export const MAX_TABS_PER_GROUP = 20;

/** Shown when a tab cannot open because its row is full. */
export const PANEL_TAB_ROW_FULL_NOTE = `Tab limit reached (${MAX_TABS_PER_GROUP})`;

/**
 * Whether a group with these tabs can take one more under `limit` (the most
 * tabs a row holds; `null` for no limit).
 */
export function hasRoomForTab(
  group: { readonly tabs: readonly unknown[] },
  limit: number | null,
): boolean {
  return limit === null || group.tabs.length < limit;
}
