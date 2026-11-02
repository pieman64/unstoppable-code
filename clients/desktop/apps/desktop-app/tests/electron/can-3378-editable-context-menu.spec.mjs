import { connectMockCloudAccount } from './seeders/connectMockCloudAccount.mjs';
/**
 * CAN-3378: right-clicking any text field opens a native menu with Cut, Copy,
 * Paste and Select All.
 *
 * `Menu.popup()` runs a native (modal on macOS) loop that would hang a hidden
 * Playwright window, so the E2E build records each presented menu on
 * `globalThis.__CANOPY_E2E_EDITABLE_CONTEXT_MENU__` instead of showing it, and
 * specs choose an item by emitting `e2e:editable-context-menu-click` on
 * `ipcMain`. The item still runs the real `webContents` edit command, so the
 * renderer sees the same DOM `paste`/`cut` events a user click produces. The
 * menu's native appearance is verified by hand on macOS and Windows.
 *
 * The right-clicks themselves are real Chromium input, so Electron's
 * `context-menu` event (and a renderer `preventDefault`) decide whether a
 * menu is presented, exactly as in production.
 */
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { seedWorktreeChat } from './seeders/index.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { spawnPanelTerminal } from './panelHarness.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const CHAT_ID = 'context-menu-chat';
const SEEDED_REPLY = 'This seeded reply is plain text, not a text field.';
const CLICK_CHANNEL = 'e2e:editable-context-menu-click';
// A person takes far longer than this to choose an item from an open menu.
// Choosing one sooner races slate-react, which copies the DOM selection into
// its model on a 100 ms throttle: a Select All inside that window is undone by
// the next render, and Cut reads the model's selection, not the DOM's.
const MENU_CHOICE_DELAY_MS = 300;
// 1x1 transparent PNG.
const ONE_PIXEL_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

async function readMenuRecord(electronApp) {
  return electronApp.evaluate(
    () => globalThis.__CANOPY_E2E_EDITABLE_CONTEXT_MENU__ ?? null,
  );
}

async function menuCount(electronApp) {
  return (await readMenuRecord(electronApp))?.count ?? 0;
}

function enabledItems(record) {
  return Object.fromEntries(
    record.items.map((item) => [item.id, item.enabled]),
  );
}

/** Right-clicks `target` and returns the menu it presented. */
async function rightClickForMenu(electronApp, target) {
  const before = await menuCount(electronApp);
  await target.click({ button: 'right' });
  await expect.poll(() => menuCount(electronApp)).toBe(before + 1);
  return readMenuRecord(electronApp);
}

async function chooseMenuItem(electronApp, id) {
  await new Promise((resolve) => setTimeout(resolve, MENU_CHOICE_DELAY_MS));
  await electronApp.evaluate(
    ({ ipcMain }, { channel, action }) => {
      ipcMain.emit(channel, undefined, action);
    },
    { channel: CLICK_CHANNEL, action: id },
  );
}

async function writeClipboardText(electronApp, text) {
  await electronApp.evaluate(({ clipboard }, value) => {
    clipboard.writeText(value);
  }, text);
}

async function readClipboardText(electronApp) {
  return electronApp.evaluate(({ clipboard }) => clipboard.readText());
}

async function browserWindowId(electronApp, page) {
  const handle = await electronApp.browserWindow(page);
  return handle.evaluate((browserWindow) => browserWindow.id);
}

async function launchWorktreeChat(slug) {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), `canopy-${slug}-`));
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    tabs: [
      {
        id: CHAT_ID,
        title: 'Context menu',
        blocks: [{ type: 'text', text: SEEDED_REPLY }],
      },
    ],
  });
  const { electronApp } = await launchCanopy({ userDataDir });
  const window = await electronApp.firstWindow();
  const app = new CanopyAppDriver(window);
  await app.waitForShell();
  await app.openMainPage();
  await app.selectWorktree(WORKTREE_ID);
  const composer = window.locator('[data-slate-editor="true"]:visible').first();
  await expect(composer).toBeVisible();
  return { electronApp, userDataDir, window, composer };
}

/**
 * Proves a right-click on `target` presented no menu. A composer right-click
 * with its text selected follows as a positive control: its menu is the only
 * one with Cut enabled, so once it is recorded every earlier right-click in
 * the same document has been handled, and the count must have grown by one.
 */
async function expectNoMenuFrom(electronApp, window, composer, target) {
  const before = await menuCount(electronApp);
  await target.click({ button: 'right' });

  await composer.click();
  await window.keyboard.press('ControlOrMeta+A');
  await expect
    .poll(() => window.evaluate(() => window.getSelection()?.toString() ?? ''))
    .toBe('positive control');
  await composer
    .locator('[data-slate-string="true"]')
    .first()
    .click({ button: 'right' });
  await expect
    .poll(async () => {
      const record = await readMenuRecord(electronApp);
      return record && enabledItems(record).cut;
    })
    .toBe(true);
  expect(await menuCount(electronApp)).toBe(before + 1);
}

test.describe('CAN-3378 editable context menu', () => {
  test('Paste from the menu inserts the clipboard text into the right-clicked composer', async () => {
    const { electronApp, userDataDir, window, composer } =
      await launchWorktreeChat('can-3378-paste');
    try {
      await writeClipboardText(electronApp, 'pasted from menu');
      await window.evaluate(() => {
        if (document.activeElement instanceof HTMLElement) {
          document.activeElement.blur();
        }
      });
      await expect(composer).not.toBeFocused();

      const record = await rightClickForMenu(electronApp, composer);
      expect(record.items.map((item) => item.label)).toEqual([
        'Cut',
        'Copy',
        'Paste',
        'Select All',
      ]);
      expect(enabledItems(record)).toMatchObject({
        cut: false,
        copy: false,
        paste: true,
      });
      expect(record.windowId).toBe(await browserWindowId(electronApp, window));

      await chooseMenuItem(electronApp, 'paste');

      await expect(composer).toHaveText('pasted from menu');
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('Select All then Cut from the menu moves the composer text to the clipboard', async () => {
    const text = 'cut me through the menu';
    const { electronApp, userDataDir, window, composer } =
      await launchWorktreeChat('can-3378-cut');
    try {
      await composer.fill(text);
      await expect(composer).toHaveText(text);

      await rightClickForMenu(electronApp, composer);
      await chooseMenuItem(electronApp, 'selectAll');
      await expect
        .poll(() =>
          window.evaluate(() => window.getSelection()?.toString() ?? ''),
        )
        .toBe(text);

      // Right-click the selected text itself: outside the selection a
      // right-click moves the caret (Windows) or selects a word (macOS).
      const record = await rightClickForMenu(
        electronApp,
        composer.locator('[data-slate-string="true"]').first(),
      );
      expect(enabledItems(record)).toMatchObject({ cut: true, copy: true });

      await chooseMenuItem(electronApp, 'cut');

      await expect(composer).not.toContainText(text);
      await expect.poll(() => readClipboardText(electronApp)).toBe(text);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('an empty clipboard disables Paste', async () => {
    const { electronApp, userDataDir, composer } = await launchWorktreeChat(
      'can-3378-empty-clipboard',
    );
    try {
      await electronApp.evaluate(({ clipboard }) => {
        clipboard.clear();
      });

      const record = await rightClickForMenu(electronApp, composer);

      expect(enabledItems(record).paste).toBe(false);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('pasting an image from the menu stages it as a composer attachment', async () => {
    const { electronApp, userDataDir, window, composer } =
      await launchWorktreeChat('can-3378-image');
    try {
      await connectMockCloudAccount(
        window,
        'csk_can_3378_editable_context_menu_attachments_e2e',
      );
      await electronApp.evaluate(({ clipboard, nativeImage }, dataUrl) => {
        clipboard.writeImage(nativeImage.createFromDataURL(dataUrl));
      }, ONE_PIXEL_PNG);

      const record = await rightClickForMenu(electronApp, composer);
      expect(enabledItems(record).paste).toBe(true);

      await chooseMenuItem(electronApp, 'paste');

      await expect(
        window
          .locator('[data-chat-composer-root]:visible')
          .getByTestId('attachment-pill'),
      ).toHaveCount(1);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('a pulled-out panel window gets the menu and pastes into its own composer', async () => {
    const pasted = 'pasted in the pulled-out panel';
    const { electronApp, userDataDir, window } =
      await launchWorktreeChat('can-3378-pull-out');
    try {
      const auxWindowPromise = electronApp.waitForEvent('window');
      await window
        .getByTestId(`panel-tab-panel-chat-${CHAT_ID}`)
        .click({ button: 'right' });
      await window.getByTestId('panel-tab-context-new-window').click();
      const aux = await auxWindowPromise;
      const auxComposer = aux
        .locator('[data-slate-editor="true"]:visible')
        .first();
      await expect(auxComposer).toBeVisible({ timeout: 20_000 });
      await writeClipboardText(electronApp, pasted);

      const record = await rightClickForMenu(electronApp, auxComposer);
      expect(record.windowId).toBe(await browserWindowId(electronApp, aux));
      expect(record.windowId).not.toBe(
        await browserWindowId(electronApp, window),
      );

      await chooseMenuItem(electronApp, 'paste');

      // Exactly once, in this window's composer. Not `toHaveText`: in a
      // hidden pulled-out window the composer keeps Slate's placeholder
      // beside typed or pasted text, including from Cmd/Ctrl+V, so that
      // rendering is not this menu's concern.
      await expect
        .poll(() =>
          auxComposer.evaluate(
            (element, text) => element.textContent.split(text).length - 1,
            pasted,
          ),
        )
        .toBe(1);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('the integrated terminal and plain text present no menu', async () => {
    const { electronApp, userDataDir, window, composer } =
      await launchWorktreeChat('can-3378-no-menu');
    try {
      await composer.fill('positive control');
      await spawnPanelTerminal(window);

      await expectNoMenuFrom(
        electronApp,
        window,
        composer,
        window.getByTestId('terminal-pane').first(),
      );
      await expectNoMenuFrom(
        electronApp,
        window,
        composer,
        window.getByText(SEEDED_REPLY).first(),
      );
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
});

// CAN-2653: right-clicking inside a popup must not close it.
test('right-clicking a picker search field keeps the picker open', async () => {
  const { electronApp, userDataDir } = await launchCanopy({
    seedDemoWorkspaces: true,
    // Two projects, because the default cowork project is not offered as a
    // picker row (CAN-2363).
    demoWorkspaceApps: ['ts-pnpm-vite', 'ts-npm-next'],
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });

    await window.getByTestId('sidebar-create-task').click();
    const home = window.getByTestId('page-home');
    await expect(home).toBeVisible();
    const workspaceMenu = window.getByTestId('home-workspace-popover');
    await home.getByTestId('home-workspace-select').focus();
    await window.keyboard.press('ArrowDown');
    await expect(workspaceMenu).toBeVisible();
    const search = window.getByTestId('home-workspace-search');
    await expect(search).toBeFocused();

    await rightClickForMenu(electronApp, search);

    await expect(workspaceMenu).toBeVisible();
    await expect(search).toBeFocused();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
