import { LoadingSpinner } from '@/components/shared/loading';
import {
  hasBrowserNativeViewOverlay,
  subscribeBrowserOverlayTopology,
} from '@/lib/browserNativeOverlay';
import { browserLoadingLabel } from '@/lib/browserUrl';
import { BROWSER_VIEW_BOUNDS_INVALIDATED_EVENT } from '@/lib/browserViewBounds';
import {
  selectUnreadConsoleErrorCount,
  selectUnreadDiagnosticCount,
  selectUnreadFailedRequestCount,
  useBrowserStore,
} from '@/stores/browserStore';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import type { BrowserCornerRadii } from '@canopy/desktop-shared/types';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type JSX,
  type RefObject,
} from 'react';
import { BrowserAddressBar } from './BrowserAddressBar';
import { BrowserDownloadNotices } from './BrowserDownloadNotices';
import { BrowserFileChooserNotice } from './BrowserFileChooserNotice';
import { BrowserPrintRequestNotice } from './BrowserPrintRequestNotice';
import { BrowserAuthRequestNotice } from './BrowserAuthRequestNotice';
import { BrowserSignInDialog } from './BrowserSignInDialog';
import { BrowserInspector } from './BrowserInspector';
import { BrowserJavaScriptDialogModal } from './BrowserJavaScriptDialogModal';
import { RefreshIcon } from './icons';

interface BrowserPaneProps {
  projectId: string;
  worktreeId: string;
  /** Exact browser session this pane renders and controls. */
  browserId: string;
  /**
   * Whether the hosting panel is visible (active tab of a shown, expanded
   * group). Drives the embedded `WebContentsView` visibility so it never
   * covers other app chrome, and gates LAZY live-view creation: a hidden
   * restored pane stays inert until it becomes visible or an explicit action
   * targets it.
   */
  visible: boolean;
}

const FREEZE_FRAME_CAPTURE_FALLBACK_MS = 250;

function roundRect(rect: DOMRect): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  return {
    x: Math.round(rect.left),
    y: Math.round(rect.top),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
}

/**
 * Whether a blocking app-level overlay currently intersects THIS pane's
 * rectangle. Overlay topology changes come from the shared ref-counted body
 * `MutationObserver` (`subscribeBrowserOverlayTopology`); each mounted pane
 * independently re-tests intersection against its own rect, so one overlay
 * can block one of two side-by-side panes while the other stays live.
 */
function useBrowserNativeViewBlocked(
  targetRef: RefObject<HTMLElement | null>,
): boolean {
  const [blocked, setBlocked] = useState(false);

  useEffect(() => {
    let frameId: number | null = null;

    const update = (): void => {
      frameId = null;
      setBlocked(
        hasBrowserNativeViewOverlay(
          document,
          targetRef.current?.getBoundingClientRect() ?? null,
        ),
      );
    };

    const scheduleUpdate = (): void => {
      if (frameId !== null) {
        return;
      }
      frameId = requestAnimationFrame(update);
    };

    update();

    const unsubscribeTopology = subscribeBrowserOverlayTopology(scheduleUpdate);

    window.addEventListener('resize', scheduleUpdate);
    window.addEventListener('scroll', scheduleUpdate, true);
    const resizeObserver =
      typeof ResizeObserver !== 'undefined' && targetRef.current
        ? new ResizeObserver(scheduleUpdate)
        : null;
    if (targetRef.current) {
      resizeObserver?.observe(targetRef.current);
    }

    return (): void => {
      unsubscribeTopology();
      resizeObserver?.disconnect();
      window.removeEventListener('resize', scheduleUpdate);
      window.removeEventListener('scroll', scheduleUpdate, true);
      if (frameId !== null) {
        cancelAnimationFrame(frameId);
      }
    };
  }, [targetRef]);

  return blocked;
}

interface BrowserFreezeFrame {
  browserId: string;
  runtimeGeneration?: number;
  sequence: number;
  dataUrl: string;
}

/**
 * One browser session's pane: the {@link BrowserAddressBar} (always the first
 * content element), the native-view placeholder rect, and the optional
 * inspector column. Exact-ID throughout: bounds, visibility, overlay freeze
 * frames, diagnostics, and interaction-driven activation all address only
 * `browserId`.
 */
/** An element's corner radii, in CSS px. */
function readCornerRadii(element: HTMLElement): BrowserCornerRadii {
  const style = getComputedStyle(element);
  const radius = (value: string): number => Number.parseFloat(value) || 0;
  return {
    topLeft: radius(style.borderTopLeftRadius),
    topRight: radius(style.borderTopRightRadius),
    bottomRight: radius(style.borderBottomRightRadius),
    bottomLeft: radius(style.borderBottomLeftRadius),
  };
}

export function BrowserPane({
  projectId,
  worktreeId,
  browserId,
  visible,
}: BrowserPaneProps): JSX.Element {
  const snapshot = useBrowserStore((s) => {
    const bucket = s.worktrees[`${projectId}/${worktreeId}`];
    return bucket?.browsers[browserId];
  });
  const live = useBrowserStore((s) => {
    const bucket = s.worktrees[`${projectId}/${worktreeId}`];
    return bucket?.live.has(browserId) ?? false;
  });
  // The backend session is still being created (a just-opened tab, or a
  // restored one being rematerialized).
  const opening = useBrowserStore(
    (s) => s.openingBrowserIds[browserId] === true,
  );
  const inspectorOpen = useBrowserStore(
    (s) => s.inspectorOpen[browserId] ?? false,
  );
  const dialog = useBrowserStore((s) => s.dialogs[browserId]);
  const authRequest = useBrowserStore((s) => s.authRequests[browserId]);
  // The sign-in whose credentials dialog is open; closing keeps it pending.
  const [signingIn, setSigningIn] = useState<string | null>(null);
  const errorCount = useBrowserStore((s) =>
    selectUnreadDiagnosticCount(s, browserId),
  );
  const unreadConsoleErrorCount = useBrowserStore((s) =>
    selectUnreadConsoleErrorCount(s, browserId),
  );
  const unreadFailedRequestCount = useBrowserStore((s) =>
    selectUnreadFailedRequestCount(s, browserId),
  );
  const applySnapshot = useBrowserStore((s) => s.applySnapshot);
  const setActiveBrowser = useBrowserStore((s) => s.setActiveBrowser);
  const setInspectorTab = useBrowserStore((s) => s.setInspectorTab);
  const toggleInspector = useBrowserStore((s) => s.toggleInspector);

  const contentRef = useRef<HTMLDivElement | null>(null);
  const lastVisibleNavigationRef = useRef<string | null>(null);
  const nativeViewBlocked = useBrowserNativeViewBlocked(contentRef);
  const captureSequenceRef = useRef(0);
  const [freezeFrame, setFreezeFrame] = useState<BrowserFreezeFrame | null>(
    null,
  );
  const [freezeCaptureFailed, setFreezeCaptureFailed] = useState(false);
  // Tracks whether this live view has ever committed a page, so a navigation
  // only shows the centered loading placeholder when the pane is truly blank
  // (nothing painted yet) rather than over previously-loaded content.
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false);

  // Whether this session was ever live while mounted here. A hidden restored
  // pane stays inert: it must not receive `setVisible(false)` IPC (there is
  // no native view to hide) and must not create one until visible. Tracked
  // per bound id synchronously during render so rebinding resets it without
  // an effect-ordering race.
  const liveSeenRef = useRef<{ browserId: string; wasLive: boolean }>({
    browserId,
    wasLive: false,
  });
  if (liveSeenRef.current.browserId !== browserId) {
    liveSeenRef.current = { browserId, wasLive: false };
  }
  if (live) {
    liveSeenRef.current.wasLive = true;
  }

  const hasUrl =
    snapshot?.url !== undefined &&
    snapshot.url.length > 0 &&
    snapshot.url !== 'about:blank';
  const failed = snapshot?.status === 'failed';
  const isNavigating = snapshot?.loading === true;
  // Opening the session for a URL, or a first-ever load with nothing painted
  // yet: show one centered spinner in the DOM and keep the (blank) native view
  // hidden until the page commits. A blank tab that is still opening shows
  // its normal empty state; it only turns into a loading state if a URL is
  // submitted before the session is ready.
  const showInitialLoading =
    hasUrl && (opening || (isNavigating && !failed && !hasLoadedOnce));
  // The backend session could not be created (no live view to load into).
  const openFailed = failed && !live && !opening;
  const nativeViewAvailable = visible && live && hasUrl && !failed;
  const activeFreezeFrame =
    freezeFrame !== null &&
    freezeFrame.browserId === browserId &&
    freezeFrame.runtimeGeneration === snapshot?.profile?.runtimeGeneration &&
    freezeFrame.sequence === captureSequenceRef.current
      ? freezeFrame
      : null;
  const nativeViewSuppressed =
    nativeViewBlocked && (activeFreezeFrame !== null || freezeCaptureFailed);
  // The native view is shown only when the pane is visible, a live view
  // exists, and a real URL has been committed (a blank browser shows its
  // hint). It is hidden while app-level overlays intersect this pane because
  // Electron child views are stacked outside the renderer DOM and otherwise
  // cover modals, dropdowns, and portaled popovers regardless of CSS z-index.
  const viewVisible =
    nativeViewAvailable && !nativeViewSuppressed && !showInitialLoading;

  // Lazy live-view creation: only when the pane is VISIBLE. A hidden restored
  // pane stays inert until shown or explicitly targeted elsewhere.
  useEffect(() => {
    if (!visible) {
      return;
    }
    void useBrowserStore
      .getState()
      .ensureLiveView(projectId, worktreeId, browserId);
  }, [projectId, worktreeId, browserId, visible]);

  // Reconcile on mount/materialization as a backstop for a dialog event that
  // arrived before this pane or the renderer subscription was ready.
  useEffect(() => {
    if (!live) {
      useBrowserStore.getState().clearDialog(browserId);
      return;
    }
    let cancelled = false;
    void window.api.browser
      .getDialog({ browserId })
      .then((pending) => {
        if (cancelled) {
          return;
        }
        if (pending) {
          useBrowserStore.getState().setDialog(browserId, pending);
        } else {
          useBrowserStore.getState().clearDialog(browserId);
        }
      })
      .catch(() => undefined);
    return (): void => {
      cancelled = true;
    };
  }, [browserId, live, snapshot?.profile?.runtimeGeneration]);

  useEffect(() => {
    captureSequenceRef.current += 1;
    setFreezeFrame(null);
    setFreezeCaptureFailed(false);
  }, [browserId, snapshot?.url, snapshot?.profile?.runtimeGeneration]);

  // A fresh pane id starts blank; once any page commits, subsequent
  // navigations show the old content (not the blank-state spinner).
  useEffect(() => {
    setHasLoadedOnce(false);
  }, [browserId, snapshot?.profile?.runtimeGeneration]);

  useEffect(() => {
    if (snapshot?.status === 'ready') {
      setHasLoadedOnce(true);
    }
  }, [snapshot?.status, snapshot?.profile?.runtimeGeneration]);

  // Freeze-frame capture on visible → blocked transitions. The capture is
  // scoped to {browserId, sequence}: late results from an earlier browser,
  // overlay episode, or mount can never render over the current content.
  useEffect(() => {
    if (!nativeViewBlocked || !nativeViewAvailable) {
      captureSequenceRef.current += 1;
      setFreezeCaptureFailed(false);
      if (freezeFrame !== null) {
        const frameId = requestAnimationFrame(() => {
          setFreezeFrame(null);
        });
        return (): void => {
          cancelAnimationFrame(frameId);
        };
      }
      return undefined;
    }

    if (freezeFrame !== null || freezeCaptureFailed) {
      return undefined;
    }

    const sequence = ++captureSequenceRef.current;
    const capturedBrowserId = browserId;
    // Wait no more than the fallback window for the capture before hiding
    // the native view without an image. The capture itself stays wanted: a
    // frame that lands late still replaces the blank pane for as long as this
    // same overlay episode lasts. The sequence, not this effect's lifetime,
    // scopes the result — flipping `freezeCaptureFailed` re-runs the effect.
    const timeoutId = window.setTimeout(() => {
      if (captureSequenceRef.current === sequence) {
        setFreezeCaptureFailed(true);
      }
    }, FREEZE_FRAME_CAPTURE_FALLBACK_MS);

    void window.api.browser
      .screenshot({
        browserId: capturedBrowserId,
        purpose: 'freeze-frame',
        ...(snapshot?.profile?.runtimeGeneration !== undefined
          ? { expectedRuntimeGeneration: snapshot.profile.runtimeGeneration }
          : {}),
      })
      .then((result) => {
        window.clearTimeout(timeoutId);
        if (captureSequenceRef.current !== sequence) {
          return;
        }
        if (!result.dataUrl) {
          setFreezeCaptureFailed(true);
          return;
        }
        setFreezeFrame({
          browserId: capturedBrowserId,
          runtimeGeneration: snapshot?.profile?.runtimeGeneration,
          sequence,
          dataUrl: result.dataUrl,
        });
      })
      .catch(() => {
        window.clearTimeout(timeoutId);
        if (captureSequenceRef.current === sequence) {
          setFreezeCaptureFailed(true);
        }
      });

    return (): void => {
      window.clearTimeout(timeoutId);
    };
  }, [
    browserId,
    snapshot?.profile?.runtimeGeneration,
    freezeCaptureFailed,
    freezeFrame,
    nativeViewAvailable,
    nativeViewBlocked,
  ]);

  const sendBounds = useCallback((): void => {
    const target = {
      browserId,
      ...(snapshot?.profile?.runtimeGeneration !== undefined
        ? { expectedRuntimeGeneration: snapshot.profile.runtimeGeneration }
        : {}),
    };
    const el = contentRef.current;
    if (!el || !viewVisible) {
      // Hidden/blocked/inactive: hide the native view — but only when one
      // exists. A hidden restored pane is inert and gets no IPC at all.
      if (liveSeenRef.current.wasLive) {
        void window.api.browser
          .setVisible({ ...target, visible: false })
          .catch(() => undefined);
      }
      return;
    }
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      // A zero-sized rectangle also means an ancestor hid the still-mounted
      // page (for example app navigation's `display: none`). Never leave the
      // last native frame visible while waiting for the next real layout.
      if (liveSeenRef.current.wasLive) {
        void window.api.browser
          .setVisible({ ...target, visible: false })
          .catch(() => undefined);
      }
      return;
    }
    void window.api.browser
      .setBounds({
        ...target,
        visible: true,
        bounds: roundRect(rect),
        // The page area's rounding (its card's bottom corners), which the
        // native view copies.
        cornerRadii: readCornerRadii(el),
      })
      .catch(() => undefined);
  }, [browserId, viewVisible, snapshot?.profile?.runtimeGeneration]);

  const handleRetry = useCallback((): void => {
    if (openFailed) {
      // Recreate the session; `create` loads its URL itself.
      void useBrowserStore
        .getState()
        .ensureLiveView(projectId, worktreeId, browserId);
      return;
    }
    if (!snapshot?.url || snapshot.url === 'about:blank') {
      return;
    }
    // Explicit action targeting the view: materialize it even when hidden.
    void useBrowserStore
      .getState()
      .ensureLiveView(projectId, worktreeId, browserId)
      .then(() => window.api.browser.navigate({ browserId, url: snapshot.url }))
      .then((next) => applySnapshot(next))
      .catch(() => undefined);
  }, [
    applySnapshot,
    browserId,
    openFailed,
    projectId,
    snapshot?.url,
    worktreeId,
  ]);

  // Pane interaction participates in EXPLICIT activation: pointer/keyboard
  // interaction within the pane makes this browser the worktree's active
  // browser. (Bounds updates never do — activation is interaction-only.)
  const handleActivate = useCallback((): void => {
    void setActiveBrowser(projectId, worktreeId, browserId);
  }, [browserId, projectId, setActiveBrowser, worktreeId]);

  // Drive bounds/visibility on every layout transition: resize observer,
  // window resize, tab/inspector visibility changes, and grid relayouts.
  useEffect(() => {
    sendBounds();
    if (!viewVisible) {
      return undefined;
    }
    const el = contentRef.current;
    const observer = new ResizeObserver(() => sendBounds());
    if (el) {
      observer.observe(el);
    }
    const handleWindowResize = (): void => sendBounds();
    window.addEventListener('resize', handleWindowResize);
    return (): void => {
      observer.disconnect();
      window.removeEventListener('resize', handleWindowResize);
    };
  }, [sendBounds, viewVisible, inspectorOpen]);

  const snapshotStatus = snapshot?.status;
  const snapshotUrl = snapshot?.url;

  useEffect(() => {
    // Backstop for a live view that exists but has never begun loading
    // (status 'idle' — e.g. a session materialized without a URL). Gate on
    // `nativeViewAvailable` rather than `viewVisible` so a pane showing the
    // initial-loading spinner (native view hidden) still drives navigation.
    //
    // Only act on 'idle': a 'loading'/'ready' view already has an
    // authoritative navigation in flight, and re-navigating it would abort
    // that load and can race the snapshot back to 'loading'.
    if (!nativeViewAvailable || !snapshotUrl || !hasUrl || failed) {
      return;
    }
    if (snapshotStatus !== 'idle') {
      if (snapshotStatus === 'ready') {
        lastVisibleNavigationRef.current = `${browserId}\0${snapshotUrl}`;
      }
      return;
    }
    const key = `${browserId}\0${snapshotUrl}`;
    if (lastVisibleNavigationRef.current === key) {
      return;
    }
    lastVisibleNavigationRef.current = key;
    void window.api.browser
      .navigate({ browserId, url: snapshotUrl })
      .then((next) => applySnapshot(next))
      .catch(async () => {
        try {
          const next = await window.api.browser.create({
            projectId,
            worktreeId,
            browserId,
            url: snapshotUrl,
            ...(snapshot?.themeMode ? { themeMode: snapshot.themeMode } : {}),
          });
          applySnapshot(next);
          return;
        } catch {
          // Allow a future visibility/status change to retry.
        }
        lastVisibleNavigationRef.current = null;
      });
  }, [
    applySnapshot,
    browserId,
    failed,
    hasUrl,
    nativeViewAvailable,
    projectId,
    snapshot?.themeMode,
    snapshotStatus,
    snapshotUrl,
    worktreeId,
  ]);

  // Native view bounds use window coordinates. Grid relayouts and composer
  // height changes can MOVE the pane without resizing it, so listen for
  // explicit layout invalidations and recompute bounds.
  useEffect(() => {
    let frameId: number | null = null;
    const handleInvalidated = (): void => {
      if (frameId !== null) {
        cancelAnimationFrame(frameId);
      }
      frameId = requestAnimationFrame(() => {
        frameId = null;
        sendBounds();
      });
    };
    window.addEventListener(
      BROWSER_VIEW_BOUNDS_INVALIDATED_EVENT,
      handleInvalidated,
    );
    return (): void => {
      window.removeEventListener(
        BROWSER_VIEW_BOUNDS_INVALIDATED_EVENT,
        handleInvalidated,
      );
      if (frameId !== null) {
        cancelAnimationFrame(frameId);
      }
    };
  }, [sendBounds]);

  // On unmount (panel removed/temporarily unmounted, worktree changed) hide
  // the view so it never lingers over unrelated UI. Unmount is presentation
  // teardown only — permanent destruction is the lifecycle coordinator's
  // decision, made from committed panel-layout changes.
  useEffect(() => {
    return (): void => {
      if (liveSeenRef.current.wasLive) {
        void window.api.browser
          .setVisible({ browserId, visible: false })
          .catch(() => undefined);
      }
    };
  }, [browserId]);

  if (!snapshot) {
    return <div className="min-h-0 flex-1" />;
  }

  // The one-row address bar uses the same
  // actions.
  const Bar = BrowserAddressBar;

  // Session replay records the browser bar (URL and page title). The page
  // area (freeze frame, loading, and error content) and the devtools panel
  // carry their own blocks; both mount with their content.
  return (
    <div
      className="relative flex min-h-0 min-w-0 flex-1 flex-col"
      data-testid={`browser-pane-${browserId}`}
      // Session lifecycle for automation: a blank tab looks the same while
      // opening and once ready.
      data-browser-state={opening ? 'opening' : live ? 'live' : 'inert'}
      onMouseDownCapture={handleActivate}
      onFocusCapture={handleActivate}
    >
      <Bar
        browserId={browserId}
        snapshot={snapshot}
        inspectorOpen={inspectorOpen}
        errorCount={errorCount}
        onToggleInspector={(): void => {
          if (!inspectorOpen) {
            if (unreadConsoleErrorCount > 0) {
              setInspectorTab(browserId, 'console');
            } else if (unreadFailedRequestCount > 0) {
              setInspectorTab(browserId, 'network');
            }
          }
          toggleInspector(browserId);
        }}
      />
      <BrowserFileChooserNotice browserId={browserId} />
      <BrowserPrintRequestNotice browserId={browserId} />
      <BrowserAuthRequestNotice
        browserId={browserId}
        onSignIn={(): void => setSigningIn(authRequest?.id ?? null)}
      />
      <BrowserDownloadNotices browserId={browserId} />
      <div className="flex min-h-0 flex-1">
        <div
          ref={contentRef}
          data-testid="browser-page-area"
          // Where a live native view can show. The notification corner lifts
          // its toasts into an overlay layer above this area instead of
          // freezing the page. Freeze state must not feed this, or a frozen
          // page would never unfreeze.
          data-browser-native-view-available={
            nativeViewAvailable ? 'true' : 'false'
          }
          className={`${POSTHOG_REPLAY_BLOCK_CLASS} relative min-h-0 min-w-0 flex-1 bg-base`}
        >
          {showInitialLoading ? (
            <div
              data-testid="browser-pane-loading"
              role="status"
              className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-s fg-secondary"
            >
              <LoadingSpinner decorative />
              <span className="max-w-full truncate">
                {browserLoadingLabel(snapshot.url)}
              </span>
            </div>
          ) : failed && (hasUrl || openFailed) ? (
            <div
              data-testid="browser-pane-failed"
              className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-s fg-secondary"
            >
              <div className="font-medium fg-primary">
                {openFailed ? "Couldn't open Browser" : 'Unable to load page'}
              </div>
              <div className="max-w-full break-words font-mono text-xs">
                {snapshot.lastError ?? snapshot.url}
              </div>
              <button
                type="button"
                onClick={handleRetry}
                className="mt-1 flex items-center gap-1 rounded border bg-base/50 px-2 py-1 text-xs fg-primary hover:bg-base"
              >
                <RefreshIcon />
                Retry
              </button>
            </div>
          ) : !hasUrl ? (
            <div
              data-testid="browser-pane-empty"
              className="flex h-full items-center justify-center text-s fg-secondary"
            >
              Enter a URL to start.
            </div>
          ) : null}
          {nativeViewSuppressed && activeFreezeFrame && (
            <img
              src={activeFreezeFrame.dataUrl}
              alt=""
              aria-hidden="true"
              data-testid="browser-pane-freeze-frame"
              className="pointer-events-none absolute inset-0 h-full w-full object-fill"
              draggable={false}
            />
          )}
        </div>
        {inspectorOpen && (
          <div
            className={`${POSTHOG_REPLAY_BLOCK_CLASS} flex min-h-0 shrink-0 flex-col`}
            style={{ width: 320, minWidth: 280, maxWidth: '45%' }}
          >
            <BrowserInspector browserId={browserId} />
          </div>
        )}
      </div>
      {dialog && (
        <BrowserJavaScriptDialogModal browserId={browserId} dialog={dialog} />
      )}
      {authRequest && signingIn === authRequest.id && (
        <BrowserSignInDialog
          browserId={browserId}
          request={authRequest}
          onClose={(): void => setSigningIn(null)}
        />
      )}
    </div>
  );
}
