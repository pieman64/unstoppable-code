export const MESSAGE_BUBBLE_STATES_PAGE_STORAGE_KEY =
  'canopy.dev.messageBubbleStatesPage';

/**
 * Gate for the Message Bubble States gallery entry in the sidebar More menu.
 *
 * E2E builds always show it (the specs drive the page). Dev builds require a
 * per-machine localStorage opt-in so the page stays personal to whoever
 * enabled it rather than appearing for every developer:
 *
 *   localStorage.setItem('canopy.dev.messageBubbleStatesPage', '1')
 *
 * Packaged builds never show it. Mirrors `worktree-states-page-flag.ts`.
 */
export function isMessageBubbleStatesPageEnabled(): boolean {
  if (__CANOPY_E2E__) return true;
  if (window.devInfo?.isDev !== true) return false;
  try {
    return (
      window.localStorage.getItem(MESSAGE_BUBBLE_STATES_PAGE_STORAGE_KEY) ===
      '1'
    );
  } catch {
    return false;
  }
}
