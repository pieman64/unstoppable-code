/**
 * Pure Browser-panel identity helpers.
 *
 * Keep these separate from migration and activation orchestration so callers
 * that only need a deterministic panel id do not pull the full panel registry
 * and persistence graph into their bundle or tests.
 */

/** Reserved, never-persisted browser id used by the hydration recovery UI. */
export const RECOVERY_BROWSER_ID = 'browser-hydration-recovery';

export function isRecoveryBrowserId(browserId: string): boolean {
  return browserId === RECOVERY_BROWSER_ID;
}

/** Deterministic bound-panel id for a browser session. */
export function browserPanelIdFor(browserId: string): string {
  return `panel-browser-${browserId}`;
}
