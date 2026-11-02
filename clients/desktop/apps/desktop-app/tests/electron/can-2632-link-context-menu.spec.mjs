/**
 * CAN-2632: right-clicking an http(s) link offers Copy link, Open in browser
 * (the worktree's Browser panel) and Open in external browser. A right-click
 * never navigates.
 *
 * Two menus carry the items. Chat message rows show the shared CAN-4277 DOM
 * menu with a link section; everything else gets a native main-process menu.
 * As with the CAN-3378 editable menu, the E2E build records each native menu
 * on `globalThis.__CANOPY_E2E_LINK_CONTEXT_MENU__` instead of popping it up
 * (a native menu loop would hang a hidden window), and the spec chooses an
 * item by emitting `e2e:link-context-menu-click` on `ipcMain`. The item still
 * runs the real action. Right-clicks are real Chromium input, so Electron's
 * `context-menu` event decides whether a native menu is presented.
 *
 * The link host is `canopy-e2e.invalid` (never resolvable), so no real
 * network is touched; browser tabs are asserted through their URL input and
 * external opens through the E2E external-open capture endpoint.
 */
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { startExternalOpenCapture } from './fixtures/external-open-capture.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { seedWorktreeChat } from './seeders/index.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const CHAT_ID = 'link-menu-chat';
const LINK_URL = 'http://canopy-e2e.invalid/p?x=1#frag';
const NATIVE_LINK_URL = 'http://canopy-e2e.invalid/native?y=2#bar';
const SEEDED_REPLY = 'Read the guide before you start.';
const LINK_CLICK_CHANNEL = 'e2e:link-context-menu-click';
const GIT_SETTINGS_LINK =
  'https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-the-automatic-deletion-of-branches';
const LINK_ITEMS = ['Copy link', 'Open in browser', 'Open in external browser'];
// Copy selection follows the link section, disabled without a selection
// (CAN-4870).
const COPY_ITEMS = ['Copy selection'];

async function linkMenuRecord(electronApp) {
  return electronApp.evaluate(
    () => globalThis.__CANOPY_E2E_LINK_CONTEXT_MENU__ ?? null,
  );
}

async function linkMenuCount(electronApp) {
  return (await linkMenuRecord(electronApp))?.count ?? 0;
}

async function editableMenuCount(electronApp) {
  return electronApp.evaluate(
    () => globalThis.__CANOPY_E2E_EDITABLE_CONTEXT_MENU__?.count ?? 0,
  );
}

/** Right-clicks `target` and returns the native link menu it presented. */
async function rightClickForLinkMenu(electronApp, target) {
  const before = await linkMenuCount(electronApp);
  await target.click({ button: 'right' });
  await expect.poll(() => linkMenuCount(electronApp)).toBe(before + 1);
  return linkMenuRecord(electronApp);
}

async function chooseLinkMenuItem(electronApp, id) {
  await electronApp.evaluate(
    ({ ipcMain }, { channel, action }) => {
      ipcMain.emit(channel, undefined, action);
    },
    { channel: LINK_CLICK_CHANNEL, action: id },
  );
}

async function readClipboardText(electronApp) {
  return electronApp.evaluate(({ clipboard }) => clipboard.readText());
}

async function clearClipboard(electronApp) {
  await electronApp.evaluate(({ clipboard }) => clipboard.writeText(''));
}

function messageMenuLabels(window) {
  return window
    .getByTestId('chat-message-context-menu')
    .getByRole('menuitem')
    .allTextContents();
}

function browserTabs(window) {
  return window.locator('[data-testid^="panel-tab-panel-browser-"]');
}

async function expectBrowserShowing(window, url) {
  await expect(browserTabs(window).first()).toBeVisible({ timeout: 20_000 });
  const address = window
    .locator('[data-testid="browser-url-input"]:visible')
    .first();
  await address.focus();
  await expect(address).toHaveValue(url, { timeout: 20_000 });
  await address.blur();
}

async function launchLinkChat(slug, capture) {
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
        title: 'Link menu',
        blocks: [
          {
            type: 'text',
            text: `${SEEDED_REPLY} See [the guide](${LINK_URL}).`,
          },
        ],
      },
    ],
  });
  const { electronApp } = await launchCanopy({ userDataDir, env: capture.env });
  const window = await electronApp.firstWindow();
  const app = new CanopyAppDriver(window);
  await app.waitForShell();
  await app.openMainPage();
  await app.selectWorktree(WORKTREE_ID);
  const link = window.locator(`a[href="${LINK_URL}"]:visible`).first();
  await expect(link).toBeVisible();
  return { electronApp, userDataDir, window, app, link };
}

test.describe('link context menu (CAN-2632)', () => {
  test('a chat message link offers the link actions in the message menu', async () => {
    test.setTimeout(180_000);
    const capture = await startExternalOpenCapture();
    const { electronApp, userDataDir, window, link } = await launchLinkChat(
      'can-2632-chat',
      capture,
    );
    try {
      const pageUrl = window.url();
      const nativeBefore = await linkMenuCount(electronApp);

      await link.click({ button: 'right' });
      await expect(
        window.getByTestId('chat-message-context-menu'),
      ).toBeVisible();
      expect(await messageMenuLabels(window)).toEqual([
        ...LINK_ITEMS,
        ...COPY_ITEMS,
      ]);
      // One divider between the link section and Copy selection, which stays
      // disabled while Copy link works without a selection.
      await expect(
        window.getByTestId('chat-message-context-menu').getByRole('separator'),
      ).toHaveCount(1);
      await expect(
        window.getByTestId('chat-message-copy-selection'),
      ).toBeDisabled();
      await clearClipboard(electronApp);
      await window.getByTestId('chat-message-copy-link').click();
      await expect.poll(() => readClipboardText(electronApp)).toBe(LINK_URL);

      await link.click({ button: 'right' });
      await window.getByTestId('chat-message-open-link-external').click();
      await expect.poll(() => capture.opened).toEqual([LINK_URL]);

      await link.click({ button: 'right' });
      await window.getByTestId('chat-message-open-link-in-browser').click();
      await expectBrowserShowing(window, LINK_URL);

      // The shared menu owns chat rows: the native menu never doubled up, and
      // no right-click navigated the app.
      expect(await linkMenuCount(electronApp)).toBe(nativeBefore);
      expect(window.url()).toBe(pageUrl);
      expect(capture.opened).toEqual([LINK_URL]);
    } finally {
      await closeCanopy(electronApp, userDataDir);
      await capture.close();
    }
  });

  test('a link outside chat rows gets the native menu on a worktree page', async () => {
    test.setTimeout(180_000);
    const capture = await startExternalOpenCapture();
    const { electronApp, userDataDir, window } = await launchLinkChat(
      'can-2632-native',
      capture,
    );
    try {
      // The demo fixture has no rendered http(s) link outside chat rows, so
      // add a plain anchor to the main page. The native menu covers every
      // `<a href>` the same way: Electron resolves `linkURL` itself.
      await window.evaluate((url) => {
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.target = '_blank';
        anchor.textContent = 'native link';
        anchor.dataset.testid = 'can-2632-native-link';
        Object.assign(anchor.style, {
          position: 'fixed',
          right: '16px',
          bottom: '16px',
          zIndex: '2147483647',
          background: 'white',
          padding: '4px',
        });
        document.body.append(anchor);
      }, NATIVE_LINK_URL);
      const anchor = window.getByTestId('can-2632-native-link');
      const pageUrl = window.url();
      const mainWindowId = await (
        await electronApp.browserWindow(window)
      ).evaluate((browserWindow) => browserWindow.id);

      const record = await rightClickForLinkMenu(electronApp, anchor);
      expect(record.windowId).toBe(mainWindowId);
      expect(record.url).toBe(NATIVE_LINK_URL);
      expect(record.items.map((item) => item.label)).toEqual(LINK_ITEMS);
      await expect(window.getByTestId('chat-message-context-menu')).toHaveCount(
        0,
      );

      await clearClipboard(electronApp);
      await chooseLinkMenuItem(electronApp, 'copyLink');
      await expect
        .poll(() => readClipboardText(electronApp))
        .toBe(NATIVE_LINK_URL);

      await chooseLinkMenuItem(electronApp, 'openExternal');
      await expect.poll(() => capture.opened).toEqual([NATIVE_LINK_URL]);

      await chooseLinkMenuItem(electronApp, 'openInBrowser');
      await expectBrowserShowing(window, NATIVE_LINK_URL);
      expect(window.url()).toBe(pageUrl);
    } finally {
      await closeCanopy(electronApp, userDataDir);
      await capture.close();
    }
  });

  test('a Settings link omits Open in browser', async () => {
    test.setTimeout(180_000);
    const capture = await startExternalOpenCapture();
    const { electronApp, userDataDir, window, app } = await launchLinkChat(
      'can-2632-settings',
      capture,
    );
    try {
      await app.openSettings();
      await app.openSettingsSection('git');
      const settingsLink = window
        .getByTestId('settings-tab-git')
        .locator(`a[href="${GIT_SETTINGS_LINK}"]`);
      await expect(settingsLink).toBeVisible();

      // Settings covers the worktree, so its Browser panel is no target.
      await expect
        .poll(async () => {
          const record = await rightClickForLinkMenu(electronApp, settingsLink);
          return record.items.map((item) => item.id);
        })
        .toEqual(['copyLink', 'openExternal']);
      await expect(window.getByTestId('settings-overlay')).toBeVisible();

      await chooseLinkMenuItem(electronApp, 'openExternal');
      await expect.poll(() => capture.opened).toEqual([GIT_SETTINGS_LINK]);
    } finally {
      await closeCanopy(electronApp, userDataDir);
      await capture.close();
    }
  });

  test('message text, mailto links and the composer present no link menu', async () => {
    test.setTimeout(180_000);
    const capture = await startExternalOpenCapture();
    const { electronApp, userDataDir, window } = await launchLinkChat(
      'can-2632-negative',
      capture,
    );
    try {
      const pageUrl = window.url();
      const before = await linkMenuCount(electronApp);

      await window.getByText(SEEDED_REPLY).first().click({ button: 'right' });
      await expect(
        window.getByTestId('chat-message-context-menu'),
      ).toBeVisible();
      expect(await messageMenuLabels(window)).toEqual(COPY_ITEMS);
      await window.keyboard.press('Escape');
      await expect(window.getByTestId('chat-message-context-menu')).toHaveCount(
        0,
      );

      await window.evaluate(() => {
        const anchor = document.createElement('a');
        anchor.href = 'mailto:team@canopy-e2e.invalid';
        anchor.textContent = 'mail link';
        anchor.dataset.testid = 'can-2632-mailto-link';
        Object.assign(anchor.style, {
          position: 'fixed',
          right: '16px',
          bottom: '16px',
          zIndex: '2147483647',
          background: 'white',
          padding: '4px',
        });
        document.body.append(anchor);
      });
      await window
        .getByTestId('can-2632-mailto-link')
        .click({ button: 'right' });

      // Positive control: the composer's CAN-3378 menu is presented for a
      // later right-click, so every earlier one has been handled by main.
      const editableBefore = await editableMenuCount(electronApp);
      await window
        .locator('[data-slate-editor="true"]:visible')
        .first()
        .click({ button: 'right' });
      await expect
        .poll(() => editableMenuCount(electronApp))
        .toBe(editableBefore + 1);

      expect(await linkMenuCount(electronApp)).toBe(before);
      expect(window.url()).toBe(pageUrl);
      expect(capture.opened).toEqual([]);
    } finally {
      await closeCanopy(electronApp, userDataDir);
      await capture.close();
    }
  });
});
