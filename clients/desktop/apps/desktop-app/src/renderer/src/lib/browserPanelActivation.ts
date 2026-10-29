// ---------------------------------------------------------------------------
// Browser panel activation bus (renderer)
// ---------------------------------------------------------------------------
//
// A tiny module-level pub/sub used to ask the panel grid to reveal (select or
// add) the Browser panel bound to ONE exact browser session. Decouples
// callers — the dev-server `Open` handler, App Advisor browser actions, and
// `open-requested` push events — from the panel-grid bridge
// (`lib/panels/browser-panel-activation.ts`) without threading refs.
//
// Browser panels are repeatable and each binds exactly one session, so every
// activation request carries the exact `browserId` it targets. There is no
// "reveal whatever browser exists" path anymore.
//
// A window that shows another computer cannot host the in-app browser, so
// every request there is declined before the grid hears of it.

import { isInAppBrowserAvailable } from '@/lib/remote-control/in-app-browser-availability';

export type BrowserPanelPlacement = 'active-group' | 'content-panel';

export interface BrowserPanelActivationTarget {
  projectId: string;
  worktreeId: string;
  /** Exact persisted browser session id the request targets. */
  browserId: string;
  /** Chat panel the request originated from (placement hint). */
  originChatTabId?: string;
  /** False for agent-driven background work that must preserve user focus. */
  focus?: boolean;
  /**
   * How a request without an origin chat places a new panel.
   * `'active-group'` (default) adds it to the active group. `'content-panel'`
   * places it like a pipeline run opened from the Activity list: the most
   * recently used chat group (see `pickContentTargetGroupId`), so the control
   * that was clicked never receives the tab in its own group. The panel,
   * new or existing, is then revealed with `revealPanel`.
   */
  placement?: BrowserPanelPlacement;
  /**
   * False declines instead of queueing when the worktree's layout is not
   * mounted yet, so a focus request can never land later as focus theft.
   */
  queue?: boolean;
  /** Background presentation must not split/collapse groups to place content. */
  preserveSelection?: boolean;
  /** Completes once the exact panel was selected/inserted, or insertion failed. */
  complete: (activated: boolean) => void;
}

type Listener = (target: BrowserPanelActivationTarget) => void;

const listeners = new Set<Listener>();

/**
 * Ask the panel grid to select the Browser panel bound to `browserId` —
 * adding a bound panel first when none exists — and make that browser the
 * worktree's explicitly active browser. Resolves `false` (a declined
 * placement) where the in-app browser is unavailable.
 */
export function requestBrowserPanel(
  projectId: string,
  worktreeId: string,
  browserId: string,
  originChatTabId?: string,
  options?: {
    focus?: boolean;
    placement?: BrowserPanelPlacement;
    queue?: boolean;
    preserveSelection?: boolean;
  },
): Promise<boolean> {
  if (listeners.size === 0 || !isInAppBrowserAvailable()) {
    return Promise.resolve(false);
  }
  return new Promise<boolean>((complete) => {
    // The bridge is installed once in production. Keeping the completion on
    // the request makes queued layout activation observable to transactional
    // callers without coupling them to the layout store.
    listeners.forEach((listener) => {
      listener({
        projectId,
        worktreeId,
        browserId,
        originChatTabId,
        ...(options?.focus === undefined ? {} : { focus: options.focus }),
        ...(options?.placement === undefined
          ? {}
          : { placement: options.placement }),
        ...(options?.queue === undefined ? {} : { queue: options.queue }),
        ...(options?.preserveSelection === undefined
          ? {}
          : { preserveSelection: options.preserveSelection }),
        complete,
      });
    });
  });
}

/** Subscribe to Browser panel activation requests. Returns an unsubscribe fn. */
export function subscribeBrowserPanelActivation(
  listener: Listener,
): () => void {
  listeners.add(listener);
  return (): void => {
    listeners.delete(listener);
  };
}
