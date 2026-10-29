// Early access: the browser pane's one-row address bar.
//
// With "Try new features early" on, a Browser panel draws the address bar
// (history, the address showing only the host at rest, Pick, and a More menu
// holding profiles, Appearance System/Light/Dark, recording, screenshot and
// details), and the details panel gains its own close button. With early
// access off the classic two-part bar renders unchanged.
//
// FLOW (each test seeds its own data dir and launches headlessly):
//   1. Seed a demo workspace (plus early access for the "on" test), launch,
//      select the worktree, add a Browser panel through the `+` menu.
//   2. Navigate it to a page served by an in-test HTTP server.
//   3. On: the bar is the address-bar variant; at rest the field shows the
//      host, focused it shows the full URL. More lists the profile submenu
//      (Task checked, Browser settings) and Appearance; choosing System
//      round-trips through main and comes back checked. Details opens the
//      inspector and its close button closes it.
//   4. Off: the classic bar renders with its own profile chip and no More
//      menu, and the field keeps the full URL at rest.
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { collectLeaves, getLayout } from './panelHarness.mjs';
// Imported directly: the seeders barrel is part of the pinned perf harness.
import { seedEarlyAccess } from './seeders/seedEarlyAccess.mjs';

const WORKTREE_ID = 'demo-main';
const PAGE_PATH = '/settings/profile';

async function pageServer() {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(
      '<!doctype html><title>Settings</title><body style="font-family:sans-serif">Settings</body>',
    );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('The page server has no port.');
  }
  return {
    origin: `http://localhost:${address.port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/**
 * Launch with or without early access, add a Browser panel and load the
 * test page in it. Returns the pane locator and a cleanup function.
 */
async function openBrowserPanel({ earlyAccess, origin }) {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-browser-address-bar-'),
  );
  seedDemoWorkspaces({
    userDataDir,
    apps: ['ts-pnpm-vite'],
    checkRuntimes: false,
  });
  if (earlyAccess) {
    seedEarlyAccess({ userDataDir });
  }
  const { electronApp } = await launchCanopy({ userDataDir });
  const close = () => closeCanopy(electronApp, userDataDir);
  try {
    const page = await electronApp.firstWindow();
    const app = new CanopyAppDriver(page);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    await expect(page.getByTestId('panel-grid-root')).toBeVisible();

    const groupId = collectLeaves((await getLayout(page)).root)[0]?.groupId;
    expect(groupId).toBeTruthy();
    // Early access's `+` opens the add menu itself; otherwise the group has
    // its own add-panel button.
    const addPanel = page.getByTestId(`panel-add-panel-${groupId}`);
    await (
      (await addPanel.isVisible())
        ? addPanel
        : page.getByTestId(`panel-add-tab-${groupId}`)
    ).click();
    await page.getByTestId('panel-add-menu-item-browser').click();

    let browserId;
    await expect
      .poll(
        async () => {
          browserId = collectLeaves((await getLayout(page)).root)
            .flatMap((leaf) => leaf.panels)
            .find((panel) => panel.kind === 'browser')?.instance?.browserId;
          return browserId;
        },
        { message: 'the Browser panel is bound to a session', timeout: 30_000 },
      )
      .toBeTruthy();
    const pane = page.getByTestId(`browser-pane-${browserId}`);
    await expect(pane).toHaveAttribute('data-browser-state', 'live', {
      timeout: 30_000,
    });
    const input = pane.getByTestId('browser-url-input');
    await input.fill(`${origin}${PAGE_PATH}`);
    await input.press('Enter');
    // The outer panel tab takes the loaded page's title.
    await expect(
      page.locator('[role="tab"][data-panel-kind="browser"]', {
        hasText: 'Settings',
      }),
    ).toBeVisible({ timeout: 30_000 });
    return { page, pane, input, close };
  } catch (error) {
    await close();
    throw error;
  }
}

test.describe('browser address bar', () => {
  test('early access on: one-row address bar with the More menu', async () => {
    test.setTimeout(240_000);
    const server = await pageServer();
    const { page, pane, input, close } = await openBrowserPanel({
      earlyAccess: true,
      origin: server.origin,
    });
    try {
      const bar = pane.getByTestId('browser-bar');
      await expect(bar).toHaveAttribute('data-variant', 'address-bar');
      await expect(pane.getByTestId('browser-pick')).toBeVisible();
      // The classic bar's own profile chip does not render.
      await expect(pane.getByTestId('browser-profile-picker')).toHaveCount(0);

      // At rest the field shows only the host; editing shows the full URL.
      await input.blur();
      await expect(input).toHaveValue(new URL(server.origin).host);
      await input.focus();
      await expect(input).toHaveValue(`${server.origin}${PAGE_PATH}`);
      await input.blur();

      // More: the profile submenu lists Task (checked) and Browser settings.
      const more = pane.getByTestId('browser-more');
      await more.click();
      const menu = page.getByTestId('browser-more-menu');
      await expect(menu).toBeVisible();
      await page.getByTestId('browser-more-profile').hover();
      await expect(page.getByTestId('browser-profile-submenu')).toBeVisible();
      await expect(
        page.getByTestId('browser-profile-option-task'),
      ).toHaveAttribute('aria-checked', 'true');
      await expect(page.getByTestId('browser-profile-settings')).toHaveText(
        'Browser settings',
      );

      // Appearance: System round-trips through main and comes back checked.
      await page.getByTestId('browser-more-appearance').hover();
      await expect(
        page.getByTestId('browser-appearance-submenu'),
      ).toBeVisible();
      await page.getByTestId('browser-theme-system').click();
      await expect(menu).toBeHidden();
      await more.click();
      await page.getByTestId('browser-more-appearance').hover();
      await expect(page.getByTestId('browser-theme-system')).toHaveAttribute(
        'aria-checked',
        'true',
      );
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
      await expect(menu).toBeHidden();

      // Details opens the inspector; its close button closes it.
      await more.click();
      await page.getByTestId('browser-more-details').click();
      const closeDetails = pane.getByTestId('browser-inspector-close');
      await expect(closeDetails).toBeVisible();
      await expect(
        pane.getByRole('tablist', { name: 'Browser details' }),
      ).toBeVisible();
      await closeDetails.click();
      await expect(
        pane.getByRole('tablist', { name: 'Browser details' }),
      ).toHaveCount(0);
    } finally {
      await close();
      await server.close();
    }
  });

  test('early access off: the classic bar is unchanged', async () => {
    test.setTimeout(240_000);
    const server = await pageServer();
    const { pane, input, close } = await openBrowserPanel({
      earlyAccess: false,
      origin: server.origin,
    });
    try {
      const bar = pane.getByTestId('browser-bar');
      await expect(bar).toBeVisible();
      await expect(bar).not.toHaveAttribute('data-variant', 'address-bar');
      await expect(pane.getByTestId('browser-profile-picker')).toBeVisible();
      await expect(pane.getByTestId('browser-more')).toHaveCount(0);
      // The classic field keeps the full URL at rest.
      await input.blur();
      await expect(input).toHaveValue(`${server.origin}${PAGE_PATH}`);
      // Details has no close button of its own there.
      await pane.getByRole('button', { name: 'Show browser details' }).click();
      await expect(
        pane.getByRole('tablist', { name: 'Browser details' }),
      ).toBeVisible();
      await expect(pane.getByTestId('browser-inspector-close')).toHaveCount(0);
    } finally {
      await close();
      await server.close();
    }
  });
});
