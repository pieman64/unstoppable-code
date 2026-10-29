import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { seedWorktreeChat } from './seeders/seedWorktreeChat.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const HTML_TAB_ID = 'scroll-html-file';
const TEXT_TAB_ID = 'scroll-text-file';
const HTML_PREVIEW_TEST_ID = 'html-file-preview-frame';
const HTML_FILE = 'SCROLL_PRESERVE.html';
const TEXT_FILE = 'SCROLL_PRESERVE.txt';

// A tall HTML doc with a marker far down the page plus an inline script that
// must remain blocked by the passive HTML-preview sandbox.
const HTML_CONTENT = [
  '<!doctype html>',
  '<html><head><title>original-title</title></head>',
  '<body style="margin:0;padding:0">',
  '<div id="top">TOP_MARKER</div>',
  '<div style="height:4000px;background:#eee"></div>',
  '<div id="bottom">BOTTOM_MARKER</div>',
  "<script>document.body.insertAdjacentHTML('beforeend',",
  '  \'<div id="ran">SCRIPT_RAN</div>\');',
  "document.title = 'HACKED';</script>",
  '</body></html>',
].join('\n');

// Larger than the 5 MB full-read threshold so the file is truncated and opens
// in the read-only RawTextView (the hook-backed `file-viewer-raw-text-scroll`
// container) rather than the Monaco editor. Wide lines give horizontal overflow
// too, so both scroll axes are exercised.
const TEXT_CONTENT = `${'y'.repeat(160)}\n`.repeat(40_000);

test('file viewer preserves HTML iframe + text scroll across tab switches', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-file-viewer-scroll-'),
  );
  const seed = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const worktreePath = seed.workspaces[0]?.worktreePath;
  expect(worktreePath, 'seeded worktree path').toBeTruthy();

  const htmlPath = path.join(worktreePath, HTML_FILE);
  const textPath = path.join(worktreePath, TEXT_FILE);
  writeFileSync(htmlPath, HTML_CONTENT, 'utf8');
  writeFileSync(textPath, TEXT_CONTENT, 'utf8');

  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    activeTabId: HTML_TAB_ID,
    tabs: [
      {
        id: HTML_TAB_ID,
        title: HTML_FILE,
        kind: 'file',
        filePath: htmlPath,
        fileViewMode: 'preview',
        description: htmlPath,
        messages: [],
      },
      {
        id: TEXT_TAB_ID,
        title: TEXT_FILE,
        kind: 'file',
        filePath: textPath,
        fileViewMode: 'raw',
        description: textPath,
        messages: [],
      },
    ],
  });

  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);

    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);

    // File tabs are per-file 'file-diff' panels now; the active (HTML) one
    // is the visible tab of the chat group.
    const htmlPanel = window.locator(
      `[data-testid="panel-content-file-diff"][data-panel-id="panel-file-${HTML_TAB_ID}"]`,
    );
    await expect(htmlPanel).toBeVisible();

    // --- HTML preview permits only the trusted search bridge in its opaque sandbox ---
    const iframe = window.getByTestId(HTML_PREVIEW_TEST_ID);
    await expect(iframe).toBeVisible();
    await expect(iframe).toHaveAttribute('sandbox', 'allow-scripts');

    const frame = window.frameLocator(
      `[data-testid="${HTML_PREVIEW_TEST_ID}"]`,
    );
    await expect(frame.locator('#bottom')).toHaveText('BOTTOM_MARKER');
    await expect(frame.locator('#ran')).toHaveCount(0);

    // --- Scroll the iframe's internal document to the bottom marker ---
    await frame.locator('#bottom').scrollIntoViewIfNeeded();
    const box1 = await frame.locator('#bottom').boundingBox();
    expect(box1, 'bottom marker box after scroll').toBeTruthy();
    const scrolledY = box1.y;

    // --- Switch away to the text tab; the preserved iframe goes hidden ---
    await window.getByTestId(`panel-tab-panel-file-${TEXT_TAB_ID}`).click();
    await expect(iframe).toBeHidden();
    const textPre = window.getByTestId('file-viewer-raw-text-scroll');
    await expect(textPre).toBeVisible();

    // Scroll the text viewer too (separate path: unmounts when inactive, then
    // remounts and restores via the useTabScrollPosition hook).
    await textPre.evaluate((node) => {
      node.scrollTop = 1200;
      node.scrollLeft = 240;
      node.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    const textScroll1 = await textPre.evaluate((node) => ({
      top: node.scrollTop,
      left: node.scrollLeft,
    }));
    expect(textScroll1.top).toBeGreaterThan(0);
    expect(textScroll1.left).toBeGreaterThan(0);

    // --- Switch back to the HTML tab; iframe scroll must be retained ---
    await window.getByTestId(`panel-tab-panel-file-${HTML_TAB_ID}`).click();
    await expect(iframe).toBeVisible();
    await expect(frame.locator('#ran')).toHaveCount(0);
    const box2 = await frame.locator('#bottom').boundingBox();
    expect(box2, 'bottom marker box after return').toBeTruthy();
    // If the iframe had remounted/reloaded it would be at scrollTop 0 and the
    // bottom marker (4000px down) would jump far below where it sat before.
    expect(Math.abs(box2.y - scrolledY)).toBeLessThan(5);

    // --- Return to the text tab; hook-restored scroll must match ---
    await window.getByTestId(`panel-tab-panel-file-${TEXT_TAB_ID}`).click();
    const textPre2 = window.getByTestId('file-viewer-raw-text-scroll');
    await expect(textPre2).toBeVisible();
    await expect
      .poll(async () =>
        textPre2.evaluate((node) => ({
          top: node.scrollTop,
          left: node.scrollLeft,
        })),
      )
      .toEqual(textScroll1);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
