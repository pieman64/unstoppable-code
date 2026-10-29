'use client';

import { create } from 'zustand';
import type { FindSurfaceMode } from '@canopy/ui-shared/components/FindInSurfaceBar';

export type { FindSurfaceMode };

/** Selector for the floating find bar's root (CAN-3048). */
export const SURFACE_FIND_BAR_SELECTOR = '[data-testid="surface-find-bar"]';

/** Live counts a controller reports for its current query. */
export interface FindControllerState {
  currentIndex: number;
  totalCount: number;
  error: string | null;
}

/**
 * One searchable surface (a chat transcript, a browser tab, or a previewed
 * file). Surfaces register while they can take Cmd/Ctrl+F and are on screen
 * (hosts keep hidden tabs and a hidden main page mounted, so a surface
 * unregisters rather than staying listed), and delegate the bar's actions to
 * their own search engine.
 */
export interface FindController {
  mode: FindSurfaceMode;
  /** Chat: transcript id. File: file tab id. Browser: browser id. */
  scopeKey: string;
  /**
   * Shown in the bar's scope menu when several surfaces of one mode are
   * registered (two browser panels). Update it with `setControllerTitle`.
   */
  title: string;
  /** Surface root; its document hosts the bar and takes focus on close. */
  anchor: HTMLElement;
  setQuery: (query: string) => void;
  next: () => void;
  previous: () => void;
  /** Clears highlights and selection. */
  close: () => void;
  retry?: () => void;
}

interface RegisteredController {
  controller: FindController;
  order: number;
  title: string;
}

/** One entry of the bar's scope menu for a mode. */
export interface FindScopeOption {
  key: string;
  title: string;
}

export const EMPTY_FIND_CONTROLLER_STATE: FindControllerState = {
  currentIndex: 0,
  totalCount: 0,
  error: null,
};

export interface SurfaceFindState {
  open: boolean;
  mode: FindSurfaceMode | null;
  /** Owned here so it survives mode switches; `close()` clears it. */
  query: string;
  /** Bumped on every open so a repeated shortcut refocuses the input. */
  focusNonce: number;
  /** Last-used scope per mode. */
  activeScope: Partial<Record<FindSurfaceMode, string>>;
  /**
   * Last non-empty query per controller key. Closing the bar, or losing the
   * searched surface (a worktree switch), keeps it so the next Cmd/Ctrl+F on
   * that surface starts from the same query, pre-filled and selected.
   */
  rememberedQueries: Record<string, string>;
  controllers: Record<string, RegisteredController>;
  controllerStates: Record<string, FindControllerState>;
  returnFocus: HTMLElement | null;
  registerController: (controller: FindController) => void;
  /** Removes `controller` if it is still the registered one for its key. */
  unregisterController: (controller: FindController) => void;
  updateControllerState: (
    mode: FindSurfaceMode,
    scopeKey: string,
    state: FindControllerState,
  ) => void;
  /** Renames a registered surface in place; no-op when unregistered. */
  setControllerTitle: (
    mode: FindSurfaceMode,
    scopeKey: string,
    title: string,
  ) => void;
  hasController: (mode: FindSurfaceMode, scopeKey: string) => boolean;
  openFor: (
    mode: FindSurfaceMode,
    scopeKey: string,
    returnFocus?: Element | null,
  ) => void;
  /**
   * Opens `mode` on `scopeKey`, else on the mode's last-used shown scope,
   * else on its newest shown scope, within the bar's own window.
   */
  switchMode: (mode: FindSurfaceMode, scopeKey?: string) => void;
  setQuery: (query: string) => void;
  next: () => void;
  previous: () => void;
  close: () => void;
}

export function findControllerKey(
  mode: FindSurfaceMode,
  scopeKey: string,
): string {
  return `${mode}:${scopeKey}`;
}

/** The controller the open bar is searching, or null while closed. */
export function getActiveFindController(
  state: Pick<
    SurfaceFindState,
    'open' | 'mode' | 'activeScope' | 'controllers'
  >,
): FindController | null {
  if (!state.open || state.mode === null) return null;
  const scopeKey = state.activeScope[state.mode];
  if (scopeKey === undefined) return null;
  return (
    state.controllers[findControllerKey(state.mode, scopeKey)]?.controller ??
    null
  );
}

/**
 * Modes with at least one controller, in registration order. With `doc`,
 * only controllers anchored in that document count: a bar open in one window
 * never offers the surfaces of a popped-out panel window.
 */
export function getAvailableFindModes(
  controllers: Record<string, RegisteredController>,
  doc?: Document,
): FindSurfaceMode[] {
  const modes = new Set<FindSurfaceMode>();
  for (const entry of Object.values(controllers)) {
    if (isFindControllerShown(entry.controller, doc)) {
      modes.add(entry.controller.mode);
    }
  }
  return Array.from(modes);
}

/**
 * The surfaces of `mode` for the bar's numbered toggles, in on-screen reading
 * order: panels side by side (overlapping vertically) left to right, otherwise
 * top to bottom. Registration order only breaks ties, since a panel that is
 * hidden or remounted registers again. With `doc`, only surfaces anchored in
 * that document.
 */
export function getFindScopes(
  controllers: Record<string, RegisteredController>,
  mode: FindSurfaceMode,
  doc?: Document,
): FindScopeOption[] {
  const entries = Object.values(controllers).filter(
    (entry) =>
      entry.controller.mode === mode &&
      isFindControllerShown(entry.controller, doc),
  );
  // One layout read per surface, and none for a lone surface (no toggles).
  const rects = new Map(
    entries.length > 1
      ? entries.map((entry) => [
          entry,
          entry.controller.anchor.getBoundingClientRect(),
        ])
      : [],
  );
  return entries
    .sort((a, b) => {
      const ra = rects.get(a);
      const rb = rects.get(b);
      return (ra && rb ? compareReadingOrder(ra, rb) : 0) || a.order - b.order;
    })
    .map((entry) => ({ key: entry.controller.scopeKey, title: entry.title }));
}

/** Rects that share rows sort by left edge; otherwise the higher one first. */
function compareReadingOrder(a: DOMRect, b: DOMRect): number {
  const sharedRows = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  return sharedRows > 0 ? a.left - b.left : a.top - b.top;
}

/** False for a surface in another window when `doc` is given. */
function isFindControllerShown(
  controller: FindController,
  doc?: Document,
): boolean {
  return doc === undefined || controller.anchor.ownerDocument === doc;
}

/** Whether `element` sits inside the open find bar. */
export function isInsideSurfaceFindBar(element: Element | null): boolean {
  return element?.closest(SURFACE_FIND_BAR_SELECTOR) != null;
}

/**
 * `instanceof HTMLElement` that also holds for nodes of a popped-out panel
 * window, whose elements belong to that window's realm.
 */
export function isHtmlElementInAnyRealm(
  element: Element | null | undefined,
): element is HTMLElement {
  if (!element) return false;
  const realm = element.ownerDocument.defaultView;
  return (
    element instanceof HTMLElement ||
    (realm !== null && element instanceof realm.HTMLElement)
  );
}

function newestScopeFor(
  controllers: Record<string, RegisteredController>,
  mode: FindSurfaceMode,
  doc?: Document,
): string | null {
  let newest: RegisteredController | null = null;
  for (const entry of Object.values(controllers)) {
    if (entry.controller.mode !== mode) continue;
    if (!isFindControllerShown(entry.controller, doc)) continue;
    if (newest === null || entry.order > newest.order) newest = entry;
  }
  return newest?.controller.scopeKey ?? null;
}

function sameControllerState(
  a: FindControllerState | undefined,
  b: FindControllerState,
): boolean {
  return (
    a !== undefined &&
    a.currentIndex === b.currentIndex &&
    a.totalCount === b.totalCount &&
    a.error === b.error
  );
}

let registrationOrder = 0;

export const useSurfaceFindStore = create<SurfaceFindState>()((set, get) => {
  const closeBar = (restoreFocus: boolean): void => {
    const state = get();
    if (!state.open) return;
    const active = getActiveFindController(state);
    active?.close();
    const { returnFocus } = state;
    const rememberedQueries =
      active && state.query.length > 0
        ? {
            ...state.rememberedQueries,
            [findControllerKey(active.mode, active.scopeKey)]: state.query,
          }
        : state.rememberedQueries;
    set({
      open: false,
      mode: null,
      query: '',
      returnFocus: null,
      rememberedQueries,
    });
    if (!restoreFocus) return;
    if (returnFocus?.isConnected) {
      returnFocus.focus();
    } else if (active?.anchor.isConnected) {
      active.anchor.focus();
    }
  };

  return {
    open: false,
    mode: null,
    query: '',
    focusNonce: 0,
    activeScope: {},
    rememberedQueries: {},
    controllers: {},
    controllerStates: {},
    returnFocus: null,

    registerController: (controller): void => {
      const key = findControllerKey(controller.mode, controller.scopeKey);
      const existing = get().controllers[key];
      registrationOrder += 1;
      set((state) => ({
        controllers: {
          ...state.controllers,
          [key]: {
            controller,
            order: existing?.order ?? registrationOrder,
            title: controller.title,
          },
        },
      }));
    },

    unregisterController: (controller): void => {
      const key = findControllerKey(controller.mode, controller.scopeKey);
      const state = get();
      if (state.controllers[key]?.controller !== controller) return;
      if (getActiveFindController(state) === controller) {
        // The surface went away (tab switch, panel hidden). Only pull focus
        // back when the bar held it; otherwise the user already moved on.
        closeBar(
          isInsideSurfaceFindBar(controller.anchor.ownerDocument.activeElement),
        );
      }
      set((current) => {
        const controllers = { ...current.controllers };
        delete controllers[key];
        const controllerStates = { ...current.controllerStates };
        delete controllerStates[key];
        const activeScope = { ...current.activeScope };
        if (activeScope[controller.mode] === controller.scopeKey) {
          delete activeScope[controller.mode];
        }
        return { controllers, controllerStates, activeScope };
      });
    },

    updateControllerState: (mode, scopeKey, next): void => {
      const key = findControllerKey(mode, scopeKey);
      if (sameControllerState(get().controllerStates[key], next)) return;
      set((state) => ({
        controllerStates: { ...state.controllerStates, [key]: next },
      }));
    },

    setControllerTitle: (mode, scopeKey, title): void => {
      const key = findControllerKey(mode, scopeKey);
      const entry = get().controllers[key];
      if (!entry || entry.title === title) return;
      set((state) => ({
        controllers: { ...state.controllers, [key]: { ...entry, title } },
      }));
    },

    hasController: (mode, scopeKey): boolean =>
      findControllerKey(mode, scopeKey) in get().controllers,

    openFor: (mode, scopeKey, returnFocus): void => {
      const state = get();
      const entry = state.controllers[findControllerKey(mode, scopeKey)];
      if (!entry) return;
      if (
        state.open &&
        state.mode === mode &&
        state.activeScope[mode] === scopeKey
      ) {
        set({ focusNonce: state.focusNonce + 1 });
        return;
      }
      const previous = getActiveFindController(state);
      previous?.close();
      // A switch within the bar's window keeps the original opener; a retarget
      // into another window (Cmd/Ctrl+F in a popped-out panel) takes that
      // window's opener, so closing never focuses the window the user left.
      const sameWindow =
        previous?.anchor.ownerDocument ===
        entry.controller.anchor.ownerDocument;
      const nextReturnFocus =
        state.open && sameWindow
          ? state.returnFocus
          : isHtmlElementInAnyRealm(returnFocus) &&
              !isInsideSurfaceFindBar(returnFocus)
            ? returnFocus
            : null;
      // An open bar keeps its live query across a switch, and the scope being
      // left remembers it too; a fresh open starts from the scope's own
      // remembered query.
      const query = state.open
        ? state.query
        : (state.rememberedQueries[findControllerKey(mode, scopeKey)] ?? '');
      const rememberedQueries =
        previous && state.query.length > 0
          ? {
              ...state.rememberedQueries,
              [findControllerKey(previous.mode, previous.scopeKey)]:
                state.query,
            }
          : state.rememberedQueries;
      set({
        open: true,
        mode,
        query,
        rememberedQueries,
        activeScope: { ...state.activeScope, [mode]: scopeKey },
        focusNonce: state.focusNonce + 1,
        returnFocus: nextReturnFocus,
      });
      entry.controller.setQuery(query);
    },

    switchMode: (mode, chosen): void => {
      const state = get();
      // Stay in the window the bar is open in (popped-out panel windows
      // register their own surfaces).
      const doc = getActiveFindController(state)?.anchor.ownerDocument;
      const chosenEntry =
        chosen === undefined
          ? undefined
          : state.controllers[findControllerKey(mode, chosen)];
      if (
        chosen !== undefined &&
        chosenEntry !== undefined &&
        isFindControllerShown(chosenEntry.controller, doc)
      ) {
        state.openFor(mode, chosen);
        return;
      }
      const remembered = state.activeScope[mode];
      const rememberedEntry =
        remembered === undefined
          ? undefined
          : state.controllers[findControllerKey(mode, remembered)];
      const scopeKey =
        remembered !== undefined &&
        rememberedEntry !== undefined &&
        isFindControllerShown(rememberedEntry.controller, doc)
          ? remembered
          : newestScopeFor(state.controllers, mode, doc);
      if (scopeKey === null) return;
      state.openFor(mode, scopeKey);
    },

    setQuery: (query): void => {
      set({ query });
      getActiveFindController(get())?.setQuery(query);
    },

    next: (): void => {
      const state = get();
      if (state.query.length === 0) return;
      getActiveFindController(state)?.next();
    },

    previous: (): void => {
      const state = get();
      if (state.query.length === 0) return;
      getActiveFindController(state)?.previous();
    },

    close: (): void => closeBar(true),
  };
});
