// CAN-4207: "Open in external browser" on a local file page.
//
// A Browser panel showing a `file:` page enables both external-open controls
// (the classic bar's toolbar button and the early-access More-menu item) and
// hands the page to the default web browser through the session-bound main
// path. E2E builds never launch a process: the opener POSTs the URL to the
// external-open capture server instead, so `opened` is the full record.
//
// FLOW (each test seeds its own data dir and launches headlessly):
//   1. Seed a demo workspace (plus early access for the "on" test), write
//      `site/index.html` into its worktree, launch with the capture env,
//      select the worktree, and add a Browser panel through the `+` menu.
//   2. The blank panel keeps the control disabled.
//   3. Navigate to the file URL: the control is enabled, and clicking it
//      captures that file URL and nothing else.
//   4. Classic bar only: an http page still opens externally (regression).
import http from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { startExternalOpenCapture } from './fixtures/external-open-capture.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { collectLeaves, getLayout } from './panelHarness.mjs';
// Imported directly: the seeders barrel is part of the pinned perf harness.
import { seedEarlyAccess } from './seeders/seedEarlyAccess.mjs';

const WORKTREE_ID = 'demo-main';
const FILE_PAGE_TITLE = 'Local site';
const HTTP_PAGE_TITLE = 'Served page';
const LOCAL_FILE_URL = /^file:\/\/.*\/site\/index\.html$/;

async function pageServer() {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(
      `<!doctype html><title>${HTTP_PAGE_TITLE}</title><body>Served</body>`,
    );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('The page server has no port.');
  }
  return {
    url: `http://localhost:${address.port}/`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/**
 * Launch with or without early access, write the local page into the seeded
 * worktree and add a blank Browser panel. Returns the pane, the file URL and
 * a cleanup function.
 */
async function openBlankBrowserPanel({ earlyAccess, captureEnv }) {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-browser-open-external-file-'),
  );
  const seed = seedDemoWorkspaces({
    userDataDir,
    apps: ['ts-pnpm-vite'],
    checkRuntimes: false,
  });
  const worktreePath = seed.workspaces[0]?.worktreePath;
  expect(worktreePath, 'seeded worktree path').toBeTruthy();
  const siteDir = path.join(worktreePath, 'site');
  mkdirSync(siteDir, { recursive: true });
  const indexPath = path.join(siteDir, 'index.html');
  writeFileSync(
    indexPath,
    `<!doctype html><title>${FILE_PAGE_TITLE}</title><body>Local site</body>`,
  );
  if (earlyAccess) {
    seedEarlyAccess({ userDataDir });
  }
  const { electronApp } = await launchCanopy({ userDataDir, env: captureEnv });
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
    return {
      page,
      pane,
      fileUrl: pathToFileURL(indexPath).href,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

async function navigate(page, pane, url, title) {
  const input = pane.getByTestId('browser-url-input');
  // Focus expands the display address to its full URL before replacing it.
  await input.click();
  await input.fill(url);
  await input.press('Enter');
  // The outer panel tab takes the loaded page's title.
  await expect(
    page.locator('[role="tab"][data-panel-kind="browser"]', {
      hasText: title,
    }),
  ).toBeVisible({ timeout: 30_000 });
}

test.describe('open a local file page in the external browser', () => {
  test('without early access: More-menu item opens file and http pages', async () => {
    test.setTimeout(240_000);
    const capture = await startExternalOpenCapture();
    const server = await pageServer();
    let session;
    try {
      session = await openBlankBrowserPanel({
        earlyAccess: false,
        captureEnv: capture.env,
      });
      const { page, pane, fileUrl } = session;
      await expect(pane.getByTestId('browser-bar')).toHaveAttribute(
        'data-variant',
        'address-bar',
      );
      const more = pane.getByTestId('browser-more');
      const external = page.getByTestId('browser-more-open-external');

      // A blank tab has nothing to open.
      await more.click();
      await expect(external).toBeDisabled();
      await page.keyboard.press('Escape');

      await navigate(page, pane, fileUrl, FILE_PAGE_TITLE);
      await more.click();
      await expect(external).toBeEnabled();
      await external.click();
      await expect.poll(() => capture.opened.length).toBe(1);
      expect(capture.opened[0]).toMatch(LOCAL_FILE_URL);

      // http pages keep opening externally.
      await navigate(page, pane, server.url, HTTP_PAGE_TITLE);
      await more.click();
      await expect(external).toBeEnabled();
      await external.click();
      await expect.poll(() => capture.opened.length).toBe(2);
      expect(capture.opened[1]).toBe(server.url);
    } finally {
      await session?.close();
      await server.close();
      await capture.close();
    }
  });

  test('early access on: More-menu item opens the file page', async () => {
    test.setTimeout(240_000);
    const capture = await startExternalOpenCapture();
    let session;
    try {
      session = await openBlankBrowserPanel({
        earlyAccess: true,
        captureEnv: capture.env,
      });
      const { page, pane, fileUrl } = session;
      await expect(pane.getByTestId('browser-bar')).toHaveAttribute(
        'data-variant',
        'address-bar',
      );
      const more = pane.getByTestId('browser-more');
      const item = page.getByTestId('browser-more-open-external');

      // A blank tab has nothing to open.
      await more.click();
      await expect(item).toBeDisabled();
      await page.keyboard.press('Escape');
      await expect(item).toHaveCount(0);

      await navigate(page, pane, fileUrl, FILE_PAGE_TITLE);
      await more.click();
      await expect(item).toBeEnabled();
      await item.click();
      await expect.poll(() => capture.opened.length).toBe(1);
      expect(capture.opened[0]).toMatch(LOCAL_FILE_URL);
    } finally {
      await session?.close();
      await capture.close();
    }
  });
});
