import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from 'react';
import {
  SHARED_CONTAINER_VIEWER_PROJECT_ID,
  type BrowserSessionSnapshot,
  type BrowserThemeMode,
} from '@canopy/desktop-shared/types';
import {
  pendingBrowserNavigationUrl,
  selectActiveSearchEngine,
  useBrowserStore,
} from '@/stores/browserStore';
import {
  browserBarPlaceholder,
  classifyBrowserBarInput,
  inAppBrowserInputMessage,
  isFileBrowserUrl,
} from '@/lib/browserUrl';
import {
  consumePendingBrowserUrlFocus,
  subscribeBrowserUrlFocus,
} from '@/lib/browserUrlFocus';

export interface BrowserBarActions {
  readonly urlDraft: string;
  readonly setUrlDraft: (value: string) => void;
  readonly urlError: string | null;
  /** Names the search engine that typed keywords go to. */
  readonly urlPlaceholder: string;
  readonly urlInputRef: RefObject<HTMLInputElement | null>;
  readonly handleKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
  readonly back: () => void;
  readonly forward: () => void;
  readonly refresh: () => void;
  readonly stop: () => void;
  readonly setTheme: (themeMode: BrowserThemeMode) => void;
  readonly toggleRecording: () => void;
  readonly togglePick: () => void;
  readonly screenshot: () => void;
  readonly openExternally: () => void;
  /**
   * `file:` pages open in the default web browser through the session-bound
   * main path; blank tabs and the shared-container viewer scope stay disabled.
   */
  readonly canOpenExternally: boolean;
  readonly isLoading: boolean;
}

/**
 * Everything a browser bar does, independent of how it is drawn: the address
 * draft and its validation, navigation, and the page tools. Both the classic
 * bar and the early-access address bar render from this.
 */
export function useBrowserBarActions(
  browserId: string,
  snapshot: BrowserSessionSnapshot,
): BrowserBarActions {
  const applySnapshot = useBrowserStore((s) => s.applySnapshot);
  const setRecordingResult = useBrowserStore((s) => s.setRecordingResult);
  const addScreenshot = useBrowserStore((s) => s.addScreenshot);
  const setInspectorOpen = useBrowserStore((s) => s.setInspectorOpen);
  const setInspectorTab = useBrowserStore((s) => s.setInspectorTab);
  const localServersOnly = useBrowserStore((s) => s.localServersOnly);
  const searchEngine = useBrowserStore(selectActiveSearchEngine);

  const { projectId, worktreeId } = snapshot;
  const [urlDraft, setUrlDraft] = useState(snapshot.url);
  const [urlError, setUrlError] = useState<string | null>(null);
  const urlInputRef = useRef<HTMLInputElement | null>(null);

  // Keep the input in sync with committed navigation (back/forward/redirects).
  useEffect(() => {
    setUrlDraft(snapshot.url);
    setUrlError(null);
  }, [snapshot.url]);

  // Address-bar focus requests (ECW-7984): ⌘/Ctrl+T creates a browser tab
  // whose bar should come up focused, and ⌘/Ctrl+L focuses the active tab's
  // bar — from both the renderer chord path and the main-process native-page
  // path. The pending request survives until this bar mounts (a brand-new
  // tab's bar renders one commit later).
  useEffect(() => {
    const focusUrlInput = (): void => {
      const input = urlInputRef.current;
      if (!input) {
        return;
      }
      input.focus();
      input.select();
    };
    if (consumePendingBrowserUrlFocus(browserId)) {
      focusUrlInput();
    }
    return subscribeBrowserUrlFocus((target) => {
      if (target === browserId && consumePendingBrowserUrlFocus(browserId)) {
        focusUrlInput();
      }
    });
  }, [browserId]);

  const run = useCallback(
    async (fn: () => Promise<BrowserSessionSnapshot>): Promise<void> => {
      try {
        const next = await fn();
        applySnapshot(next);
      } catch (cause) {
        setUrlError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [applySnapshot],
  );

  const handleNavigate = useCallback((): void => {
    // One classifier, shared with main, picks both the verdict and the copy —
    // the bar no longer re-parses the scheme to guess which message to show.
    // Keywords search with the engine chosen in Settings → Browser.
    const verdict = classifyBrowserBarInput(
      urlDraft,
      localServersOnly,
      searchEngine.urlTemplate,
    );
    if (verdict.kind !== 'ok') {
      setUrlError(inAppBrowserInputMessage(verdict));
      return;
    }
    setUrlError(null);
    const url = verdict.url;
    void (async (): Promise<void> => {
      const store = useBrowserStore.getState();
      // A tab can be typed into while it is still opening (or before a
      // restored tab rematerializes): show the URL loading now, and navigate
      // once its session exists. A tab that could not be opened shows that
      // failure with Retry instead.
      const pending = store.startPendingNavigation(browserId, url);
      await store.ensureLiveView(projectId, worktreeId, browserId);
      if (
        !useBrowserStore
          .getState()
          .worktrees[`${projectId}/${worktreeId}`]?.live.has(browserId)
      ) {
        return;
      }
      // Recreating an inert tab loads the submitted URL in its create; only
      // a session that came up blank (or was already live) still needs it.
      // When several URLs were submitted while opening, only the latest one
      // navigates.
      if (pending && pendingBrowserNavigationUrl(browserId) !== url) {
        return;
      }
      useBrowserStore.getState().clearPendingNavigation(browserId);
      await run(() => window.api.browser.navigate({ browserId, url }));
    })();
  }, [
    browserId,
    localServersOnly,
    projectId,
    run,
    searchEngine.urlTemplate,
    urlDraft,
    worktreeId,
  ]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>): void => {
      if (event.key === 'Enter') {
        event.preventDefault();
        handleNavigate();
      }
    },
    [handleNavigate],
  );

  const back = useCallback((): void => {
    void run(() => window.api.browser.back({ browserId }));
  }, [browserId, run]);

  const forward = useCallback((): void => {
    void run(() => window.api.browser.forward({ browserId }));
  }, [browserId, run]);

  const refresh = useCallback((): void => {
    setUrlError(null);
    void (async (): Promise<void> => {
      await useBrowserStore
        .getState()
        .ensureLiveView(projectId, worktreeId, browserId);
      const worktree =
        useBrowserStore.getState().worktrees[`${projectId}/${worktreeId}`];
      if (!worktree?.live.has(browserId)) {
        setUrlError(worktree?.browsers[browserId]?.lastError ?? null);
        return;
      }
      await run(() => window.api.browser.reload({ browserId }));
    })().catch((cause) => {
      setUrlError(cause instanceof Error ? cause.message : String(cause));
    });
  }, [browserId, projectId, run, worktreeId]);

  const setTheme = useCallback(
    (themeMode: BrowserThemeMode): void => {
      void run(() => window.api.browser.setTheme({ browserId, themeMode }));
    },
    [browserId, run],
  );

  const toggleRecording = useCallback((): void => {
    if (snapshot.recording) {
      void window.api.browser
        .stopRecording({ browserId })
        .then((result) => {
          setRecordingResult(browserId, result);
          if (result.steps.length > 0) {
            setInspectorTab(browserId, 'recording');
            setInspectorOpen(browserId, true);
          }
        })
        .catch(() => undefined);
    } else {
      void run(() => window.api.browser.startRecording({ browserId }));
    }
  }, [
    browserId,
    run,
    setInspectorOpen,
    setInspectorTab,
    setRecordingResult,
    snapshot.recording,
  ]);

  const togglePick = useCallback((): void => {
    void run(() =>
      window.api.browser.setPickMode({
        browserId,
        enabled: !snapshot.pickMode,
      }),
    );
  }, [browserId, run, snapshot.pickMode]);

  const stop = useCallback((): void => {
    void run(() => window.api.browser.stop({ browserId }));
  }, [browserId, run]);

  const screenshot = useCallback((): void => {
    void window.api.browser
      .screenshot({ browserId, saveToAttachments: true })
      .then((result) => {
        const filename =
          result.attachmentPath?.split(/[\\/]/).pop() ?? 'screenshot.png';
        addScreenshot(browserId, {
          id: crypto.randomUUID(),
          filename,
          attachmentPath: result.attachmentPath,
          dataUrl: result.dataUrl,
          capturedAt: Date.now(),
          attached: false,
        });
        setInspectorTab(browserId, 'snapshots');
        setInspectorOpen(browserId, true);
      })
      .catch(() => undefined);
  }, [addScreenshot, browserId, setInspectorOpen, setInspectorTab]);

  const hasUrl = snapshot.url.length > 0;
  // `file:` pages open in the default web browser: main checks that the URL is
  // this tab's current page and never hands it to the file type's handler.
  // The shared-container viewer scope is read-only and stays in the app.
  const canOpenExternally =
    hasUrl &&
    !(
      isFileBrowserUrl(snapshot.url) &&
      projectId === SHARED_CONTAINER_VIEWER_PROJECT_ID
    );

  const openExternally = useCallback((): void => {
    if (canOpenExternally) {
      void window.api.browser
        .openExternal({ url: snapshot.url, browserId })
        .catch(() => undefined);
    }
  }, [browserId, canOpenExternally, snapshot.url]);

  return {
    urlDraft,
    setUrlDraft,
    urlError,
    urlPlaceholder: browserBarPlaceholder(searchEngine.name),
    urlInputRef,
    handleKeyDown,
    back,
    forward,
    refresh,
    stop,
    setTheme,
    toggleRecording,
    togglePick,
    screenshot,
    openExternally,
    canOpenExternally,
    isLoading: snapshot.loading === true,
  };
}
