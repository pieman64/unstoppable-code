import {
  Menu,
  type BrowserWindow,
  type Input,
  type MenuItemConstructorOptions,
  type WebContents,
} from 'electron';
import { is } from '@electron-toolkit/utils';
import type { UiScaleAdjustment } from '@canopy/desktop-shared/lib/ui-scale';
import { applyUiScaleCommand } from './lib/ui-scale-commands';

/**
 * Application menu + window input-guard policy (CAN-338).
 *
 * Two main-process layers previously stole `Ctrl+R` before it could reach the
 * renderer (and therefore the integrated terminal's xterm instance, which
 * needs `\x12` for shell reverse-i-search):
 *
 * 1. Electron's default application menu binds Reload to `CmdOrCtrl+R`, which
 *    is `Ctrl+R` on Windows/Linux. The custom menu built here keeps the
 *    standard roles but never binds a plain `CmdOrCtrl+R` accelerator —
 *    Reload (dev-only) lives on `CmdOrCtrl+Shift+R`.
 * 2. `optimizer.watchWindowShortcuts` from `@electron-toolkit/utils` attached
 *    a `before-input-event` handler that `preventDefault()`ed every
 *    `Ctrl/Cmd+R` keydown in packaged builds — on every platform, including
 *    macOS. `attachWindowInputGuards` replaces it, preserving its devtools
 *    suppression but deliberately letting `Ctrl/Cmd+R` through to the
 *    renderer. Its zoom-key suppression is gone too: the View menu always
 *    owns those chords and steps the interface scale.
 *
 * `CmdOrCtrl+W` follows the same ownership rule: the default `fileMenu` role
 * (macOS) and `windowMenu` role (Windows/Linux) both contain a `close` role
 * whose default accelerator is `CmdOrCtrl+W`, and menu accelerators fire
 * before the renderer ever sees the keydown — so ⌘W closed the entire window
 * even though the renderer binds it to "close chat tab". The menus below keep
 * a clickable "Close Window" item but bind NO accelerator to it, letting
 * `CmdOrCtrl+W` reach the renderer, which owns it unconditionally
 * (`useGlobalShortcuts` / `AppAdvisorWindowApp`).
 */

export interface ApplicationMenuTemplateOptions {
  isMac: boolean;
  isDev: boolean;
}

/**
 * The View-menu zoom items, which step `PreferencesData.uiScale`. Always
 * present, including in the menu installed before preferences are read.
 *
 * Deliberately NOT the `zoomIn`/`zoomOut`/`resetZoom` roles — see
 * `lib/ui-scale-commands.ts` for why those would drift from the preference.
 */
function uiScaleMenuItems(): MenuItemConstructorOptions[] {
  const step = (adjustment: UiScaleAdjustment): (() => void) => {
    return (): void => {
      void applyUiScaleCommand(adjustment).catch((error: unknown) => {
        // eslint-disable-next-line no-console
        console.error('Failed to change the interface scale:', error);
      });
    };
  };
  return [
    { type: 'separator' },
    {
      label: 'Zoom In',
      accelerator: 'CommandOrControl+Plus',
      click: step('in'),
    },
    {
      // Electron binds one accelerator per item, and `+` needs Shift on most
      // layouts, so the conventional second spelling rides a hidden twin.
      // `acceleratorWorksWhenHidden` is what keeps macOS registering it.
      label: 'Zoom In',
      accelerator: 'CommandOrControl+=',
      visible: false,
      acceleratorWorksWhenHidden: true,
      click: step('in'),
    },
    {
      label: 'Zoom Out',
      accelerator: 'CommandOrControl+-',
      click: step('out'),
    },
    {
      label: 'Actual Size',
      accelerator: 'CommandOrControl+0',
      click: step('actual-size'),
    },
  ];
}

/**
 * Click handler behind the accelerator-free "Close Window" menu item,
 * exported for unit tests.
 */
export function handleCloseWindowClick(
  focusedWindow: { close: () => void } | undefined,
): void {
  focusedWindow?.close();
}

export function buildApplicationMenuTemplate(
  options: ApplicationMenuTemplateOptions,
): MenuItemConstructorOptions[] {
  const { isMac, isDev } = options;

  const viewSubmenu: MenuItemConstructorOptions[] = [];
  if (isDev) {
    // Deliberately NOT plain `CmdOrCtrl+R`: the integrated terminal needs
    // Ctrl+R (readline reverse-i-search) to reach the shell on Windows/Linux.
    viewSubmenu.push(
      { role: 'reload', accelerator: 'CmdOrCtrl+Shift+R' },
      { type: 'separator' },
    );
  }
  viewSubmenu.push(
    { role: 'toggleDevTools' },
    { type: 'separator' },
    {
      role: 'togglefullscreen',
    },
    ...uiScaleMenuItems(),
  );

  // Not `role: 'close'`: that role registers the default `CmdOrCtrl+W`
  // accelerator, which must stay free for the renderer's close-tab shortcut
  // (see file header). A plain click item keeps the menu entry without
  // stealing the chord.
  const closeWindowItem: MenuItemConstructorOptions = {
    label: 'Close Window',
    click: (_item, focusedWindow): void => {
      handleCloseWindowClick(focusedWindow);
    },
  };

  const template: MenuItemConstructorOptions[] = [];
  if (isMac) {
    template.push({ role: 'appMenu' });
  }
  template.push(
    // The default `fileMenu` role is just `close` (⌘W) on macOS; on other
    // platforms it is `quit`, which is safe to keep as-is.
    isMac
      ? { label: 'File', submenu: [closeWindowItem] }
      : { role: 'fileMenu' },
    { role: 'editMenu' },
    { label: 'View', submenu: viewSubmenu },
    // The default `windowMenu` role contains `close` (Ctrl+W) on
    // Windows/Linux; on macOS it is minimize/zoom/front and safe to keep.
    isMac
      ? { role: 'windowMenu' }
      : {
          label: 'Window',
          submenu: [{ role: 'minimize' }, closeWindowItem],
        },
  );
  if (isMac) {
    template.push({ role: 'help' });
  }
  return template;
}

export function installApplicationMenu(): void {
  const template = buildApplicationMenuTemplate({
    isMac: process.platform === 'darwin',
    isDev: is.dev,
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

export type BeforeInputGuardInput = Pick<
  Input,
  'type' | 'code' | 'alt' | 'control' | 'meta' | 'shift'
>;

/**
 * Pure predicate behind `attachWindowInputGuards`, exported for unit tests.
 *
 * Mirrors `optimizer.watchWindowShortcuts`'s devtools-combo suppression in
 * packaged builds, minus its `Ctrl/Cmd+R` blocking, which broke terminal
 * reverse-i-search, and its zoom-accelerator suppression: the View menu owns
 * those chords, and swallowing them here would break it on the platforms
 * where `before-input-event` runs ahead of the menu.
 */
export function shouldBlockBeforeInput(
  input: BeforeInputGuardInput,
  options: { isDev: boolean },
): boolean {
  if (input.type !== 'keyDown') {
    return false;
  }
  if (
    !options.isDev &&
    input.code === 'KeyI' &&
    ((input.alt && input.meta) || (input.control && input.shift))
  ) {
    // Block accidental devtools shortcuts in packaged builds (the menu item
    // remains available under View).
    return true;
  }
  return false;
}

/**
 * Replacement for `optimizer.watchWindowShortcuts(window)`. Keeps the dev
 * F12 devtools toggle and the suppression rules in `shouldBlockBeforeInput`,
 * but lets `Ctrl/Cmd+R` reach the renderer in packaged builds so the
 * integrated terminal receives readline control sequences.
 */
export function attachWindowInputGuards(window: BrowserWindow): void {
  attachInputGuardsToContents(window.webContents);
}

/**
 * The same guards for a page hosted in a view rather than a window's own
 * contents (early access: App Advisor's page).
 */
export function attachInputGuardsToContents(webContents: WebContents): void {
  webContents.on('before-input-event', (event, input): void => {
    if (shouldBlockBeforeInput(input, { isDev: is.dev })) {
      event.preventDefault();
      return;
    }
    if (is.dev && input.type === 'keyDown' && input.code === 'F12') {
      if (webContents.isDevToolsOpened()) {
        webContents.closeDevTools();
      } else {
        webContents.openDevTools({ mode: 'undocked' });
      }
    }
  });
}
