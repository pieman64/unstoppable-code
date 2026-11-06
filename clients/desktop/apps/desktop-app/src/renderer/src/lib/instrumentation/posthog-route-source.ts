// ---------------------------------------------------------------------------
// Renderer synthetic screen-route projection (CAN-3117).
//
// Produces, from renderer state alone, a SINGLE stable route string naming the
// screen the user is on, and publishes it through the `PostHogRouteSource`
// seam that the instrumentation client consumes.
//
// Three properties keep this safe to run at the frequency it runs at:
//
//   1. PURE AND NARROW. It reads the navigation page, the Settings fields,
//      the selected worktree / Co-Work entry, and the active panel kind —
//      nothing else. It deliberately does NOT call
//      `lib/current-ui-state/buildCurrentUiStateSnapshot`: that builder walks
//      a dozen stores and allocates a large sanitized object, which is exactly
//      the wrong shape for a derivation that runs on every chat-store update.
//
//   2. ALLOCATION-LIGHT AND SHORT-CIRCUITING. The chat store notifies on every
//      streaming token, so `derive()` reads a handful of fields and returns
//      early. It never builds an intermediate snapshot object.
//
//   3. CLOSED-CATALOG ONLY. Every value it can return comes from
//      `@canopy/desktop-instrumentation/posthog-routes`. This module never
//      concatenates a route string, so no workspace name, branch name, id,
//      path, filename, or website URL can reach the wire.
//
// Change detection is by VALUE, not by subscription filtering. These stores
// use plain zustand `create` (no `subscribeWithSelector` anywhere in the
// repo), so `subscribe(listener)` is the vanilla form that fires on every
// change to that store. Narrowness therefore comes from cheap derivation plus
// a `!==` comparison against the last emitted route.
//
// ---------------------------------------------------------------------------

import {
  POSTHOG_APP_ADVISOR_ROUTE,
  POSTHOG_MAIN_ROUTE,
  POSTHOG_SETTINGS_ROUTE,
  POSTHOG_WORKTREE_CHAT_ROUTE,
  routeForHostedSettingsRoute,
  routeForNavigationPage,
  routeForPanelKind,
  routeForSettingsSection,
  type PostHogRoute,
} from '@canopy/desktop-instrumentation/posthog-routes';
import type { PostHogRouteSource } from '@canopy/desktop-instrumentation/types';
import { PANEL_KINDS, type PanelKind } from '@canopy/protocol/panels';
import { isCoworkChatTarget } from '@/lib/cowork';
import { getActivePanel } from '@/lib/newTabShortcut';
import { useChatStore } from '@/stores/chatStore';
import { useNavigationStore } from '@/stores/navigationStore';
import {
  getPanelLayoutViewModel,
  makeWorktreePanelKey,
  usePanelLayoutStore,
} from '@/stores/panelLayoutStore';
import { useStandaloneChatStore } from '@/stores/standaloneChatStore';

/** Which renderer window a source is projecting for. */
export type PostHogRouteSurface = 'main' | 'app-advisor';

/**
 * Runtime membership set for panel kinds. `getActivePanel` reports `kind` as a
 * plain `string` (layouts can be restored from persisted files written by a
 * newer build), so an unknown kind must fall back to the containing page
 * rather than be forced into the catalog lookup.
 */
const PANEL_KIND_MEMBERS: ReadonlySet<string> = new Set<string>(PANEL_KINDS);

function isPanelKind(kind: string): kind is PanelKind {
  return PANEL_KIND_MEMBERS.has(kind);
}

/**
 * The layout key whose panel grid is on screen for `page`, or `null` when no
 * grid is rendered.
 *
 * Both hosts key their layout the same way — `makeWorktreePanelKey` — but they
 * source the pair differently: the Code page from the chat store's selected
 * worktree, the Co-Work page from the standalone chat store's active
 * workspace + Work Entry.
 */
function activeLayoutKey(page: string): string | null {
  if (page === 'chat') {
    const standalone = useStandaloneChatStore.getState();
    const entryId = standalone.activeWorkEntryId;
    // A null Work Entry means Co-Work renders no panel grid at all.
    if (entryId === null || entryId === '') {
      return null;
    }
    const projectId = standalone.activeChatProjectId;
    return projectId === '' ? null : makeWorktreePanelKey(projectId, entryId);
  }

  if (page === 'main') {
    const selection = useChatStore.getState().selectedWorktree;
    // The Code page's grid belongs to a worktree. A Co-Work (or App Advisor)
    // selection is not one, matching `getVisibleWorktreeKey`'s semantics.
    return selection === null || isCoworkChatTarget(selection.projectId)
      ? null
      : makeWorktreePanelKey(selection.projectId, selection.worktreeId);
  }

  return null;
}

/**
 * Route for the focused panel on `page`, or `null` when the containing page
 * should win.
 *
 * `getActivePanel` already returns `null` for every structural dead end —
 * missing layout, no focused group, no selected panel (which is how a
 * COLLAPSED group reports itself), and a deleted panel id. The one case it
 * does not cover is MAXIMIZE: while a group is maximized only that group is
 * visible, so an active panel in any other group is off screen.
 */
function derivePanelRoute(page: string): PostHogRoute | null {
  if (
    page === 'chat' &&
    useStandaloneChatStore.getState().archiveOverlayChatId !== null
  ) {
    return null;
  }
  const layoutKey = activeLayoutKey(page);
  if (layoutKey === null) {
    return null;
  }

  const panel = getActivePanel(layoutKey);
  if (panel === null) {
    return null;
  }

  const viewModel = getPanelLayoutViewModel(layoutKey);
  if (
    viewModel !== null &&
    viewModel.maximizedGroupId !== null &&
    viewModel.activeGroupId !== viewModel.maximizedGroupId
  ) {
    return null;
  }

  // Unknown kinds and the `chat` kind (catalog value `null`, because a focused
  // chat panel keeps its containing chat route) both fall back to the page.
  return isPanelKind(panel.kind) ? routeForPanelKind(panel.kind) : null;
}

/**
 * Route for the navigation page itself, after the panel override has declined.
 *
 * `main` is the one overloaded page: it is both the worktree page and the
 * catalog's bare fallback. The selected worktree identifies the Code screen
 * immediately, before its chat-panel visibility effect runs. The route names
 * the worktree screen even when its chat panel is hidden.
 */
function derivePageRoute(
  page: ReturnType<typeof useNavigationStore.getState>['activePage'],
): PostHogRoute {
  if (page !== 'main') {
    return routeForNavigationPage(page);
  }

  const selection = useChatStore.getState().selectedWorktree;
  if (selection !== null && !isCoworkChatTarget(selection.projectId)) {
    return POSTHOG_WORKTREE_CHAT_ROUTE;
  }
  return POSTHOG_MAIN_ROUTE;
}

/**
 * The full main-window projection.
 *
 * Precedence, highest first:
 *   1. Settings overrides its underlying page.
 *   2. On `main` or `chat`, a visible focused non-chat panel overrides the
 *      containing page.
 *   3. The fixed page mapping from the catalog.
 *
 * `held` is the route currently reported, used only for the Settings
 * two-view suppression described below.
 */
function deriveMainSurfaceRoute(held: PostHogRoute | null): PostHogRoute {
  const nav = useNavigationStore.getState();

  if (nav.settingsOpen) {
    // A hosted account or organization page reports its scope and page only
    // (`app://settings/<scope>/<page>`), never its ids or query.
    const hosted = nav.settingsHostedLocation;
    if (hosted !== null) {
      const hostedRoute = routeForHostedSettingsRoute(hosted.route);
      if (hostedRoute !== null) return hostedRoute;
    }
    const section = nav.settingsActiveSection;
    if (section === null) {
      // `SettingsOverlay` publishes its displayed section from an effect, one
      // commit after `settingsOpen` flips true. Emitting `app://settings` here
      // would turn one navigation into two page views, so HOLD the previous
      // route until the section arrives. `app://settings` survives only as the
      // terminal fallback for Settings that is already open at the moment this
      // source is first read and never reports a section.
      return held ?? POSTHOG_SETTINGS_ROUTE;
    }
    const settingsRoute = routeForSettingsSection(section);
    // Every section has a route today; a section without one falls through
    // to the page below rather than inventing a settings route.
    if (settingsRoute !== null) {
      return settingsRoute;
    }
  }

  const page = nav.activePage;
  if (page === 'main' || page === 'chat') {
    const panelRoute = derivePanelRoute(page);
    if (panelRoute !== null) {
      return panelRoute;
    }
  }

  return derivePageRoute(page);
}

/**
 * The App Advisor renderer's fixed source.
 *
 * The App Advisor window is a separate renderer process with its own store
 * instances, so this is a constant rather than a projection: it registers
 * nothing, subscribes to nothing, and can never inherit the main window's
 * route. (An App Advisor *conversation* hosted inside the main window is a
 * main-window route — only this renderer reports `app://app-advisor`.)
 */
export function createAppAdvisorPostHogRouteSource(): PostHogRouteSource {
  const unsubscribe = (): void => {};
  return {
    getSnapshot: (): PostHogRoute => POSTHOG_APP_ADVISOR_ROUTE,
    subscribe: (): (() => void) => unsubscribe,
  };
}

/**
 * The main window's live projection over `navigationStore`, the chat store,
 * `standaloneChatStore`, and `panelLayoutStore`.
 *
 * All mutable route state lives in this closure — never at module scope — so
 * HMR disposal and repeated construction cannot leak a stale route between
 * SDK lifetimes.
 */
export function createMainWindowPostHogRouteSource(): PostHogRouteSource {
  const listeners = new Set<(route: PostHogRoute) => void>();
  let storeUnsubscribers: readonly (() => void)[] | null = null;
  let current: PostHogRoute | null = null;
  let flushScheduled = false;

  function flush(): void {
    flushScheduled = false;
    if (listeners.size === 0) {
      return;
    }
    const next = deriveMainSurfaceRoute(current);
    if (next === current) {
      return;
    }
    current = next;
    // Copy so a listener that unsubscribes during delivery cannot perturb the
    // iteration. Only the SDK subscribes, so this set holds at most one entry.
    Array.from(listeners).forEach((listener) => listener(next));
  }

  // Coalesce the several synchronous store writes that one navigation performs
  // (navigate + select worktree + focus panel) into a single comparison. A
  // microtask, not a timer: nothing persistent is installed, and transition
  // timing is not blurred the way a debounce would blur it.
  function scheduleFlush(): void {
    if (flushScheduled) {
      return;
    }
    flushScheduled = true;
    queueMicrotask(flush);
  }

  function attach(): void {
    if (storeUnsubscribers !== null) {
      return;
    }
    // Each listener first compares ONLY the fields the projection reads from
    // that store (zustand's vanilla `subscribe` passes `(state, prevState)`).
    // The chat store notifies on every streaming token, so for it this turns a
    // token into one reference comparison — no microtask, no derivation.
    storeUnsubscribers = [
      useNavigationStore.subscribe((state, prev) => {
        if (
          state.activePage !== prev.activePage ||
          state.settingsOpen !== prev.settingsOpen ||
          state.settingsActiveSection !== prev.settingsActiveSection ||
          state.settingsHostedLocation !== prev.settingsHostedLocation
        ) {
          scheduleFlush();
        }
      }),
      useChatStore.subscribe((state, prev) => {
        if (state.selectedWorktree !== prev.selectedWorktree) {
          scheduleFlush();
        }
      }),
      useStandaloneChatStore.subscribe((state, prev) => {
        if (
          state.activeChatProjectId !== prev.activeChatProjectId ||
          state.activeWorkEntryId !== prev.activeWorkEntryId ||
          state.archiveOverlayChatId !== prev.archiveOverlayChatId
        ) {
          scheduleFlush();
        }
      }),
      // Every tab, focus, collapse, and maximize commit replaces `layouts`;
      // size-only drags bump `layoutSizeRevisions` instead and are skipped.
      usePanelLayoutStore.subscribe((state, prev) => {
        if (state.layouts !== prev.layouts) {
          scheduleFlush();
        }
      }),
    ];
  }

  function detach(): void {
    const unsubscribers = storeUnsubscribers;
    if (unsubscribers === null) {
      return;
    }
    storeUnsubscribers = null;
    for (const unsubscribe of unsubscribers) {
      unsubscribe();
    }
  }

  return {
    getSnapshot(): PostHogRoute {
      // While subscribed, `current` is exactly the value the last notification
      // delivered, which is what the contract promises. Unsubscribed, nothing
      // keeps it fresh, so derive on demand.
      if (storeUnsubscribers === null || current === null) {
        current = deriveMainSurfaceRoute(current);
      }
      return current;
    },
    subscribe(listener): () => void {
      listeners.add(listener);
      attach();
      current ??= deriveMainSurfaceRoute(null);
      let active = true;
      return (): void => {
        if (!active) {
          return;
        }
        active = false;
        listeners.delete(listener);
        if (listeners.size === 0) {
          detach();
        }
      };
    },
  };
}

/**
 * The single entry point `main.tsx` uses. One renderer entry serves both
 * windows, so the surface — already resolved from the `?surface=app-advisor`
 * query parameter — selects between the fixed App Advisor source and the live
 * main-window projection.
 *
 * Construction is synchronous, touches no store, awaits nothing, and performs
 * no disk or IPC read, so it cannot delay first paint or the renderer
 * mount.
 */
export function createPostHogRouteSource(
  surface: PostHogRouteSurface,
): PostHogRouteSource {
  return surface === 'app-advisor'
    ? createAppAdvisorPostHogRouteSource()
    : createMainWindowPostHogRouteSource();
}
