import { clipboard, ipcMain, Menu } from 'electron';
import type {
  BrowserWindow,
  ContextMenuParams,
  MenuItemConstructorOptions,
  WebContents,
} from 'electron';
import { normalizeSafeExternalBrowserUrl } from '../browser/browser-url-policy';
import { isE2eBuild } from './e2e-gate';
import { logMainProcessDebug } from './main-process-logging';
import type { IpcWindowLabel } from './web-contents-send';

/**
 * Right-click menu for http(s) links (CAN-2632): Copy link, Open in browser
 * (the app's Browser panel) and Open in external browser, in every app
 * window. Left-click routing is unchanged and a right-click never navigates.
 *
 * Coexists with the CAN-3378 editable menu on the same `webContents`: editable
 * targets return early here, so at most one of the two presents. Chat message
 * rows cancel the DOM `contextmenu` event and show the shared CAN-4277 menu,
 * which carries the same link items, so this menu never reaches them. In-app
 * browser tabs never fire `browser-window-created` and stay untouched.
 *
 * "Open in browser" is offered only while the main-window renderer reports a
 * selected worktree on the main page (see {@link setLinkBrowserTargetAvailable})
 * and only in the main window and pull-outs.
 *
 * E2E seam: as for the editable menu, an E2E build (`isE2eBuild()`) does not
 * pop the native menu. Each presented menu is recorded on
 * `globalThis.__CANOPY_E2E_LINK_CONTEXT_MENU__` as `{ count, windowId, url,
 * items }`; a right-click that builds no menu records nothing. Specs choose
 * an item by emitting {@link E2E_LINK_CONTEXT_MENU_CLICK_CHANNEL} on
 * `ipcMain` with the item id, which runs it for the last recorded menu.
 */

export type LinkContextMenuAction =
  | 'copyLink'
  | 'openInBrowser'
  | 'openExternal';

export interface LinkContextMenuItem {
  id: LinkContextMenuAction;
  label: string;
}

export interface LinkContextMenu {
  /** The resolved absolute URL, query and hash intact. */
  url: string;
  items: LinkContextMenuItem[];
}

/** Evaluated at right-click (or item click) time. */
export interface LinkContextMenuDeps {
  canOpenInBrowser: () => boolean;
  /** Resolves `true` once the renderer acknowledged the request. */
  openInBrowser: (url: string) => Promise<boolean>;
  openExternal: (url: string) => Promise<void>;
}

interface LinkContextMenuE2eRecord extends LinkContextMenu {
  count: number;
  windowId: number;
}

declare global {
  // Evidence for the Electron UI automation spec; written only in E2E builds.
  var __CANOPY_E2E_LINK_CONTEXT_MENU__: LinkContextMenuE2eRecord | undefined;
}

export const E2E_LINK_CONTEXT_MENU_CLICK_CHANNEL =
  'e2e:link-context-menu-click';

const MENU_ITEMS: ReadonlyArray<LinkContextMenuItem> = [
  { id: 'copyLink', label: 'Copy link' },
  { id: 'openInBrowser', label: 'Open in browser' },
  { id: 'openExternal', label: 'Open in external browser' },
];

/**
 * The menu for a right-click, or `null` outside http(s) links and inside
 * editable fields. Chromium's own link menu shows no shortcuts, so neither
 * does this one.
 */
export function buildLinkContextMenuItems(
  params: Pick<ContextMenuParams, 'linkURL' | 'isEditable'>,
  options: { canOpenInBrowser: boolean },
): LinkContextMenu | null {
  if (params.isEditable || !params.linkURL) return null;
  const url = normalizeSafeExternalBrowserUrl(params.linkURL);
  if (url === null) return null;
  return {
    url,
    items: MENU_ITEMS.filter(
      (item) => item.id !== 'openInBrowser' || options.canOpenInBrowser,
    ),
  };
}

/**
 * Only the main window and its pull-outs offer "Open in browser"; both place
 * the tab through the main renderer, in its selected worktree. The main
 * window is matched by identity because remote-control client windows load
 * the same renderer URL. App Advisor windows and views never offer it.
 */
export function shouldOfferOpenInBrowser(args: {
  label: IpcWindowLabel;
  isMainWindow: boolean;
  available: boolean;
}): boolean {
  return args.available && (args.isMainWindow || args.label === 'aux');
}

let linkBrowserTargetAvailable = false;

export function setLinkBrowserTargetAvailable(available: boolean): void {
  linkBrowserTargetAvailable = available;
}

export function isLinkBrowserTargetAvailable(): boolean {
  return linkBrowserTargetAvailable;
}

export function isLinkContextMenuAction(
  value: unknown,
): value is LinkContextMenuAction {
  return MENU_ITEMS.some((item) => item.id === value);
}

/** Fire-and-forget; the renderer owns failure UX for "Open in browser". */
export function runLinkContextMenuAction(
  id: LinkContextMenuAction,
  url: string,
  deps: Pick<LinkContextMenuDeps, 'openInBrowser' | 'openExternal'>,
): void {
  switch (id) {
    case 'copyLink':
      void clipboard.writeText(url).catch(() => undefined);
      return;
    case 'openInBrowser':
      void deps.openInBrowser(url).then(
        (handled) => {
          if (!handled) {
            logMainProcessDebug('Link menu: renderer did not take the link');
          }
        },
        () => undefined,
      );
      return;
    case 'openExternal':
      void deps.openExternal(url).catch(() => undefined);
      return;
  }
}

let e2eLastMenu: { url: string; deps: LinkContextMenuDeps } | null = null;
let e2eClickListenerRegistered = false;

/** Once per process: a per-window listener would run each click per window. */
function registerE2eClickListener(): void {
  if (e2eClickListenerRegistered) return;
  e2eClickListenerRegistered = true;
  ipcMain.on(
    E2E_LINK_CONTEXT_MENU_CLICK_CHANNEL,
    (_event: unknown, id: unknown): void => {
      if (!isLinkContextMenuAction(id) || e2eLastMenu === null) return;
      runLinkContextMenuAction(id, e2eLastMenu.url, e2eLastMenu.deps);
    },
  );
}

function presentLinkContextMenu(
  window: BrowserWindow,
  menu: LinkContextMenu,
  deps: LinkContextMenuDeps,
): void {
  if (isE2eBuild()) {
    e2eLastMenu = { url: menu.url, deps };
    globalThis.__CANOPY_E2E_LINK_CONTEXT_MENU__ = {
      count: (globalThis.__CANOPY_E2E_LINK_CONTEXT_MENU__?.count ?? 0) + 1,
      windowId: window.id,
      url: menu.url,
      items: menu.items,
    };
    return;
  }
  const template = menu.items.map(
    (item): MenuItemConstructorOptions => ({
      label: item.label,
      click: (): void => {
        runLinkContextMenuAction(item.id, menu.url, deps);
      },
    }),
  );
  // No x/y: the menu opens at the pointer, as the editable menu does.
  Menu.buildFromTemplate(template).popup({ window });
}

/**
 * A window's own page, or a page hosted in a view (App Advisor's page, which
 * moves between windows), with the window holding it when the menu opens.
 */
type LinkContextMenuTarget =
  | BrowserWindow
  | {
      readonly contents: WebContents;
      readonly hostWindow: () => BrowserWindow | null;
    };

export function attachLinkContextMenu(
  target: LinkContextMenuTarget,
  deps: LinkContextMenuDeps,
): void {
  const contents = 'contents' in target ? target.contents : target.webContents;
  const hostWindow =
    'contents' in target ? target.hostWindow : (): BrowserWindow => target;
  if (isE2eBuild()) registerE2eClickListener();
  contents.on('context-menu', (_event, params): void => {
    if (params.isEditable || !params.linkURL) return;
    const menu = buildLinkContextMenuItems(params, {
      canOpenInBrowser: deps.canOpenInBrowser(),
    });
    if (menu === null) return;
    const window = hostWindow();
    if (!window) return;
    presentLinkContextMenu(window, menu, deps);
  });
}

/** {@link attachLinkContextMenu} for a page hosted in a view. */
export function attachLinkContextMenuToContents(
  contents: WebContents,
  hostWindow: () => BrowserWindow | null,
  deps: LinkContextMenuDeps,
): void {
  attachLinkContextMenu({ contents, hostWindow }, deps);
}
