/**
 * Per-layout tab selection seam for the panel command layer (CAN-4616).
 *
 * A tab click does more than `selectTab`: the mounted `PanelGridSurface`
 * also makes a selected Browser panel the worktree's active browser and
 * passes the selection to the host's `onSelectPanel` (desktop terminal focus
 * and spawn). Commands that select a tab without a click, such as next and
 * previous tab, route through the handler the surface registers here, so they
 * behave like the click. Without a mounted surface they fall back to the bare
 * store selection.
 */

/** Selects `panelId` in `groupId` the way a tab click on the strip does. */
export type PanelTabSelectionHandler = (
  groupId: string,
  panelId: string,
) => void;

const handlers = new Map<string, PanelTabSelectionHandler>();

/**
 * Registers the click-equivalent tab selection for one layout key. The most
 * recent registration wins; the returned function removes only its own
 * registration, so a surface unmounting after a newer one mounted for the
 * same key leaves the newer handler in place.
 */
export function registerPanelTabSelectionHandler(
  worktreeKey: string,
  handler: PanelTabSelectionHandler,
): () => void {
  handlers.set(worktreeKey, handler);
  return (): void => {
    if (handlers.get(worktreeKey) === handler) {
      handlers.delete(worktreeKey);
    }
  };
}

/** The registered click-equivalent tab selection for a layout, if mounted. */
export function getPanelTabSelectionHandler(
  worktreeKey: string,
): PanelTabSelectionHandler | undefined {
  return handlers.get(worktreeKey);
}
