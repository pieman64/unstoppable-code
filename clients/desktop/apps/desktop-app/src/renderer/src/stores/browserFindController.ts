/**
 * Browser-mode controller for the floating find bar (CAN-3048). Drives the
 * page's native find (`webContents.findInPage`) and turns the asynchronous
 * `find-result` browser events into the bar's counts.
 */
import type {
  BrowserEvent,
  BrowserFindInPageRequest,
  BrowserStopFindInPageRequest,
} from '@canopy/desktop-shared/types';
import {
  EMPTY_FIND_CONTROLLER_STATE,
  useSurfaceFindStore,
  type FindController,
  type FindControllerState,
} from '@/stores/surfaceFindStore';

export const BROWSER_FIND_DEBOUNCE_MS = 150;
const BROWSER_FIND_MIN_LENGTH = 2;
export const BROWSER_FIND_ERROR = "Couldn't search this page.";

type BrowserFindResultEvent = Extract<BrowserEvent, { type: 'find-result' }>;

export interface BrowserFindApi {
  findInPage: (request: BrowserFindInPageRequest) => Promise<number>;
  stopFindInPage: (request: BrowserStopFindInPageRequest) => Promise<void>;
}

export interface BrowserFindControllerHandle {
  controller: FindController;
  handleFindResult: (event: BrowserFindResultEvent) => void;
  /** Re-runs the current query after a page load finished. */
  handlePageLoad: () => void;
  dispose: () => void;
}

const handles = new Map<string, BrowserFindControllerHandle>();

/** Routes a native find result to the controller of its browser tab. */
export function routeBrowserFindResult(event: BrowserFindResultEvent): void {
  handles.get(event.browserId)?.handleFindResult(event);
}

export function getBrowserFindController(
  browserId: string,
): BrowserFindControllerHandle | null {
  return handles.get(browserId) ?? null;
}

function defaultApi(): BrowserFindApi {
  return window.api.browser;
}

export function createBrowserFindController({
  browserId,
  anchor,
  title = browserId,
  api = defaultApi,
}: {
  browserId: string;
  anchor: HTMLElement;
  /** Scope-menu label; the surface keeps it current via the store. */
  title?: string;
  api?: () => BrowserFindApi;
}): BrowserFindControllerHandle {
  let text = '';
  let timer: ReturnType<typeof setTimeout> | null = null;
  let latestRequestId: number | null = null;
  let bufferedResult: BrowserFindResultEvent | null = null;
  let disposed = false;

  const report = (state: FindControllerState): void => {
    if (disposed) return;
    useSurfaceFindStore
      .getState()
      .updateControllerState('browser', browserId, state);
  };

  const applyResult = (event: BrowserFindResultEvent): void => {
    if (!event.finalUpdate && event.activeMatchOrdinal < 1) return;
    report(
      event.matches === 0
        ? EMPTY_FIND_CONTROLLER_STATE
        : {
            currentIndex: Math.max(0, event.activeMatchOrdinal - 1),
            totalCount: event.matches,
            error: null,
          },
    );
  };

  const clearTimer = (): void => {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
  };

  const stopFind = (): void => {
    latestRequestId = null;
    bufferedResult = null;
    void api()
      .stopFindInPage({ browserId, action: 'clearSelection' })
      .catch(() => undefined);
  };

  const find = (findNext: boolean, forward: boolean): void => {
    const issued = text;
    void api()
      .findInPage({ browserId, text: issued, findNext, forward })
      .then((requestId) => {
        if (disposed || issued !== text) return;
        if (latestRequestId !== null && requestId < latestRequestId) return;
        latestRequestId = requestId;
        const buffered = bufferedResult;
        bufferedResult = null;
        if (buffered?.requestId === requestId) applyResult(buffered);
      })
      .catch(() => {
        if (disposed || issued !== text) return;
        report({ currentIndex: 0, totalCount: 0, error: BROWSER_FIND_ERROR });
      });
  };

  const startSearch = (): void => {
    clearTimer();
    if (text.length === 0) return;
    // A new search makes every earlier request stale, even before its own
    // request id is known.
    latestRequestId = null;
    bufferedResult = null;
    find(false, true);
  };

  const step = (forward: boolean): void => {
    if (timer !== null) {
      startSearch();
      return;
    }
    if (text.length === 0) return;
    find(true, forward);
  };

  const controller: FindController = {
    mode: 'browser',
    scopeKey: browserId,
    title,
    anchor,
    setQuery: (query) => {
      // Like the chat and file searches (and the bar's counter), one
      // character is not a search yet.
      const trimmed =
        query.trim().length >= BROWSER_FIND_MIN_LENGTH ? query.trim() : '';
      // Padding-only edits keep the active match instead of restarting.
      if (trimmed.length > 0 && trimmed === text) return;
      clearTimer();
      const wasSearching = text.length > 0 || latestRequestId !== null;
      text = trimmed;
      if (text.length === 0) {
        if (wasSearching) stopFind();
        report(EMPTY_FIND_CONTROLLER_STATE);
        return;
      }
      timer = setTimeout(startSearch, BROWSER_FIND_DEBOUNCE_MS);
    },
    next: () => step(true),
    previous: () => step(false),
    close: () => {
      clearTimer();
      const wasSearching = text.length > 0 || latestRequestId !== null;
      text = '';
      if (wasSearching) stopFind();
      report(EMPTY_FIND_CONTROLLER_STATE);
    },
    retry: () => {
      report(EMPTY_FIND_CONTROLLER_STATE);
      startSearch();
    },
  };

  const handle: BrowserFindControllerHandle = {
    controller,
    handleFindResult: (event) => {
      if (disposed || text.length === 0) return;
      if (latestRequestId === null || event.requestId > latestRequestId) {
        // The result can arrive before `findInPage` resolves with its id.
        bufferedResult = event;
        return;
      }
      if (event.requestId < latestRequestId) return;
      applyResult(event);
    },
    handlePageLoad: () => {
      if (disposed || text.length === 0) return;
      latestRequestId = null;
      bufferedResult = null;
      report(EMPTY_FIND_CONTROLLER_STATE);
      startSearch();
    },
    dispose: () => {
      if (disposed) return;
      clearTimer();
      if (text.length > 0 || latestRequestId !== null) stopFind();
      disposed = true;
      if (handles.get(browserId) === handle) handles.delete(browserId);
    },
  };
  handles.set(browserId, handle);
  return handle;
}
