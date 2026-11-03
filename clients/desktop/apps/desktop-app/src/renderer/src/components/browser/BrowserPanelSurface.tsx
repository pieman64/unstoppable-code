import { LoadingSpinner } from '@/components/shared/loading';
import {
  forgetWarmBrowserWorktree,
  keepBrowserWorktreeViewsWarm,
} from '@/lib/browserWarmWorktrees';
import { ensureBrowserEventSubscription } from '@/stores/browserEventSubscription';
import {
  createBrowserFindController,
  getBrowserFindController,
} from '@/stores/browserFindController';
import {
  ensureBrowserWorktreeHydrated,
  selectBrowserBucket,
  useBrowserStore,
} from '@/stores/browserStore';
import { ensureLabsExperimentsSubscription } from '@/stores/labsExperimentsStore';
import { useSurfaceFindStore } from '@/stores/surfaceFindStore';
import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import { BrowserPane } from './BrowserPane';
import { ErrorState } from '@canopy/ui-shared/components';

export interface BrowserPanelSurfaceProps {
  projectId: string;
  worktreeId: string;
  /** Exact persisted browser session this panel is bound to. */
  browserId: string;
  /**
   * Whether the hosting panel is visible. Gates the native browser view's
   * visibility (the `WebContentsView` panes are composited over the renderer,
   * so hiding the DOM alone is not enough) and lazy live-view creation.
   * Defaults to true.
   */
  visible?: boolean;
}

const mountedSurfacesByWorktree = new Map<string, number>();

/**
 * The browser surface hosted by ONE 'browser' panel: exactly one
 * {@link BrowserPane} bound to `browserId`, with the BrowserBar as the FIRST
 * content element beneath the outer panel chrome. There is no inner browser
 * group/tab/add/split chrome — repeatability lives at the outer panel layer.
 *
 * States:
 * - a tracked session (including one still being opened, which is tracked
 *   before hydration finishes) → the bound pane, which shows its own
 *   opening spinner until the backend session exists;
 * - initial hydration → accessible loading copy `Opening Browser…`;
 * - recoverable hydration failure (corrupt/future browser state, including
 *   migration recovery placeholders) → heading `Unable to open Browser`,
 *   body `Browser state could not be restored.`, and a `Retry` button that
 *   re-runs hydration (success also completes any pending migration
 *   recovery);
 * - hydrated without the bound id → conclusively stale; the lifecycle/
 *   migration reconciliation removes the panel, so this surface only renders
 *   a neutral placeholder for the intervening frame(s).
 *
 * Browser-view bounds contract for hosts: the native `WebContentsView`
 * behind the pane is positioned in window coordinates. `BrowserPane`
 * observes its own element with a `ResizeObserver` (plus window `resize`),
 * so layout changes that RESIZE the pane re-push bounds automatically.
 * Layout changes that MOVE this surface without resizing the pane are
 * invisible to that observer — hosts must call
 * `dispatchBrowserViewBoundsInvalidated()` from `@/lib/browserViewBounds`
 * after such relayouts, exactly as `PanelGridSurface` does on grid-topology
 * changes and `ChatInput` does when the composer height changes.
 */
export function BrowserPanelSurface({
  projectId,
  worktreeId,
  browserId,
  visible,
}: BrowserPanelSurfaceProps): JSX.Element {
  const bucket = useBrowserStore((s) =>
    selectBrowserBucket(s, projectId, worktreeId),
  );
  const retryHydration = useBrowserStore((s) => s.retryHydration);
  const [retrying, setRetrying] = useState(false);
  const releaseWorktreeViews = useBrowserStore((s) => s.releaseWorktreeViews);

  useEffect(() => {
    const key = `${projectId}/${worktreeId}`;
    mountedSurfacesByWorktree.set(
      key,
      (mountedSurfacesByWorktree.get(key) ?? 0) + 1,
    );
    forgetWarmBrowserWorktree(key);
    ensureLabsExperimentsSubscription();
    void ensureBrowserWorktreeHydrated(projectId, worktreeId).catch(
      // Failures are recorded on the bucket (`hydrationError`) and surfaced
      // through the retry state below.
      () => undefined,
    );
    ensureBrowserEventSubscription();
    return (): void => {
      const remaining = (mountedSurfacesByWorktree.get(key) ?? 1) - 1;
      if (remaining > 0) {
        mountedSurfacesByWorktree.set(key, remaining);
      } else {
        mountedSurfacesByWorktree.delete(key);
        {
          keepBrowserWorktreeViewsWarm(key, projectId, worktreeId);
        }
      }
    };
  }, [projectId, releaseWorktreeViews, worktreeId]);

  const handleRetry = useCallback((): void => {
    setRetrying(true);
    void retryHydration(projectId, worktreeId).finally(() => {
      setRetrying(false);
    });
  }, [projectId, retryHydration, worktreeId]);

  const hydrated = bucket?.hydrated === true;
  const hydrationError = bucket?.hydrationError;
  // A session opened in this renderer is tracked before hydration finishes,
  // so its pane (address bar prefilled) renders without waiting on it.
  const snapshot = bucket?.browsers[browserId];
  const rootRef = useRef<HTMLDivElement>(null);

  // Cmd/Ctrl+F browser mode (CAN-3048): a visible tab with a live session can
  // be searched with the page's native find.
  const findSearchable = (visible ?? true) && snapshot !== undefined;
  // Names this tab in the bar's scope menu beside other browser panels; an
  // untitled page shows its URL.
  const findTitle = snapshot?.title.trim() || snapshot?.url || '';
  const findTitleRef = useRef(findTitle);
  findTitleRef.current = findTitle;
  useEffect(() => {
    const anchor = rootRef.current;
    if (!findSearchable || !anchor) return undefined;
    const handle = createBrowserFindController({
      browserId,
      anchor,
      title: findTitleRef.current,
    });
    useSurfaceFindStore.getState().registerController(handle.controller);
    return (): void => {
      useSurfaceFindStore.getState().unregisterController(handle.controller);
      handle.dispose();
    };
  }, [browserId, findSearchable]);
  useEffect(() => {
    if (!findSearchable) return;
    useSurfaceFindStore
      .getState()
      .setControllerTitle('browser', browserId, findTitle);
  }, [browserId, findSearchable, findTitle]);

  // Search again once a navigation finishes loading, so counts reflect the
  // loaded page. Same-document URL changes (pushState, hash) never load and
  // keep the active match.
  const loading = snapshot?.loading === true;
  const wasLoadingRef = useRef(loading);
  useEffect(() => {
    const finishedLoading = wasLoadingRef.current && !loading;
    wasLoadingRef.current = loading;
    if (finishedLoading) {
      getBrowserFindController(browserId)?.handlePageLoad();
    }
  }, [browserId, loading]);

  let content: JSX.Element;
  if (!hydrated && hydrationError !== undefined) {
    // Recoverable hydration failure — also the surface a migration recovery
    // placeholder renders; a successful Retry completes the pending
    // migration and resumes layout persistence.
    content = (
      <div className="flex h-full flex-col justify-center">
        <ErrorState
          space="panel"
          testId="browser-panel-hydration-error"
          message="Couldn't restore Browser."
          onRetry={handleRetry}
          retrying={retrying}
        />
      </div>
    );
  } else if (snapshot !== undefined) {
    content = (
      <BrowserPane
        projectId={projectId}
        worktreeId={worktreeId}
        browserId={browserId}
        visible={visible ?? true}
      />
    );
  } else if (!hydrated) {
    content = (
      <div
        data-testid="browser-panel-loading"
        role="status"
        aria-label="Opening Browser…"
        className="flex h-full flex-col items-center justify-center gap-2 text-sm fg-secondary"
      >
        <LoadingSpinner />
        <span>Opening Browser…</span>
      </div>
    );
  } else {
    // Conclusively stale binding (session gone after successful hydration).
    // Reconciliation closes this panel on its next pass; render a neutral
    // placeholder for the intervening frame(s).
    content = (
      <div
        data-testid="browser-panel-stale"
        className="flex h-full items-center justify-center text-sm fg-secondary"
      >
        Browser session is no longer available.
      </div>
    );
  }

  return (
    <div
      ref={rootRef}
      data-testid="browser-panel-surface"
      // Marks the browser surface's React chrome for focus-based shortcut
      // routing (`isBrowserSurfaceTarget`, ECW-7984).
      data-browser-surface=""
      data-browser-id={browserId}
      // Focus target when the find bar closes after a native-page Cmd+F.
      tabIndex={-1}
      className="flex h-full min-h-0 flex-col outline-none"
    >
      {content}
    </div>
  );
}
