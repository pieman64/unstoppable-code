import type { DevServerHit } from '@/lib/scriptDevServerDetection';
import { isAllowedInAppBrowserUrl } from '@/lib/browserUrl';
import { requestBrowserPanel } from '@/lib/browserPanelActivation';
import { initBrowserPanelActivation } from '@/lib/panels/browser-panel-activation';
import { ensureWorktreePanelLayout } from '@/lib/panels/persistence-bridge';
import { makeWorktreePanelKey } from '@/stores/panelLayoutStore';
import { useBrowserStore } from '@/stores/browserStore';
import { isBrowserOpenTargetAvailable } from '@/lib/remote-control/in-app-browser-availability';

/**
 * Worktree context needed to route a dev-server `Open` into the in-app browser.
 * Threaded from the activity surfaces down to each open affordance.
 */
export interface DevServerOpenContext {
  projectId: string;
  worktreeId: string;
}

/**
 * Defensive http(s) re-check at click time. The detection layer already
 * filters non-http(s) candidates, but this guard protects against future
 * shape drift in `DevServerHit`.
 */
export function isClickableHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Route a clicked dev-server hit per its `openTarget`:
 *
 * - `'external'` always opens the system browser.
 * - `'in-app'` (default) opens allowed URLs in the in-app Browser and falls
 *   back to the system browser when the current Browser policy blocks one.
 *
 * Nothing opens where the target is unavailable: a window that shows another
 * computer has neither its in-app nor its system browser, and the URL names
 * that computer's local server, so there is no fallback either.
 */
export function openDevServerHit(
  hit: DevServerHit,
  context: DevServerOpenContext,
): void {
  if (
    !isClickableHttpUrl(hit.url) ||
    !isBrowserOpenTargetAvailable(hit.openTarget)
  ) {
    return;
  }
  if (hit.openTarget === 'external') {
    void window.api.browser.openExternal({ url: hit.url });
    return;
  }
  const localServersOnly = useBrowserStore.getState().localServersOnly;
  if (isAllowedInAppBrowserUrl(hit.url, localServersOnly)) {
    // The tab (URL prefilled) is placed on this click; its session is
    // created in the background and the pane shows the loading state.
    const opened = useBrowserStore
      .getState()
      .openUrlFromDevServer(context.projectId, context.worktreeId, hit);
    if (opened === null) {
      return;
    }
    const { browserId } = opened;
    // Placed like a pipeline run opened from the Activity list, so the tab
    // never joins the group of the Scripts panel or top bar control that was
    // clicked. A rejected placement is a declined one: discard the opened
    // session.
    void requestBrowserPanel(
      context.projectId,
      context.worktreeId,
      browserId,
      undefined,
      { placement: 'content-panel' },
    )
      .catch(() => false)
      .then(async (activated) => {
        if (activated) return;
        const { discardOpenedBrowser } =
          await import('@/lib/panels/browser-panel-sync');
        await discardOpenedBrowser(
          context.projectId,
          context.worktreeId,
          browserId,
        );
      })
      .catch(() => undefined);
    return;
  }
  void window.api.browser.openExternal({ url: hit.url });
}

/** Prepare the target's panel layout even when another worktree is selected. */
export async function autoOpenDevServerHit(
  hit: DevServerHit,
  context: DevServerOpenContext,
): Promise<void> {
  if (!isBrowserOpenTargetAvailable(hit.openTarget)) {
    return;
  }
  if (hit.openTarget !== 'external' && isClickableHttpUrl(hit.url)) {
    initBrowserPanelActivation();
    await ensureWorktreePanelLayout(
      makeWorktreePanelKey(context.projectId, context.worktreeId),
    );
  }
  openDevServerHit(hit, context);
}

export function getDevServerOpenButtonText(hit: DevServerHit): string {
  return hit.label ? `Open ${hit.label}` : 'Open';
}

export function getDevServerOpenAriaLabel(hit: DevServerHit): string {
  return hit.label
    ? `Open dev server ${hit.label} ${hit.url}`
    : `Open dev server ${hit.url}`;
}

export function getDevServerMenuItemText(hit: DevServerHit): string {
  return hit.label ? `${hit.label}: ${hit.displayUrl}` : hit.displayUrl;
}
