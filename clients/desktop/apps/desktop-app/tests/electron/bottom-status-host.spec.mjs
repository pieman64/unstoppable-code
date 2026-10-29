import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { seedWorktreeChat } from './seeders/index.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const WORKTREE_BRANCH = 'demo-main';
const WORKSPACE_NAME = 'TypeScript pnpm Vite';

/**
 * Drives the renderer's wake-lock subscription from the main process: the
 * indicator listens on the `wake-lock:state-changed` channel through preload,
 * so pushing a state over that channel exercises the real component without
 * needing a live agent turn.
 */
async function broadcastWakeLockState(electronApp, state) {
  await electronApp.evaluate(({ BrowserWindow }, nextState) => {
    for (const browserWindow of BrowserWindow.getAllWindows()) {
      browserWindow.webContents.send('wake-lock:state-changed', nextState);
    }
  }, state);
}

test('keeps the bottom-status host out of the way until its portal has content', async () => {
  const { electronApp, userDataDir } = await launchCanopy();

  try {
    const window = await electronApp.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    await expect(window.getByTestId('app-sidebar')).toBeVisible();

    const host = window.getByTestId('app-bottom-status');
    const portal = host.getByTestId('app-sidebar-bottom-status');

    await expect(portal).toBeAttached();
    await expect(portal).toBeEmpty();
    // An overlay, not a flow row: the empty host must neither reserve space
    // under the panel grid nor intercept clicks meant for the chrome beneath.
    await expect(host).toHaveCSS('position', 'absolute');
    await expect(host).toHaveCSS('pointer-events', 'none');
    const idleBox = await host.boundingBox();
    expect(idleBox?.height ?? 0).toBe(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('renders the wake-lock status as a labeled chip floating in the bottom-right corner of the main shell', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-bottom-status-host-'),
  );

  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    tabs: [{ id: 't1', title: 'Chat' }],
  });

  const { electronApp } = await launchCanopy({
    userDataDir,
    viewportSize: { width: 1400, height: 900 },
  });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);

    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await expect(app.workspaceHeaderLabel(WORKSPACE_NAME)).toBeVisible();
    await app.selectWorktree(WORKTREE_BRANCH);

    const composerRoot = window.locator('[data-chat-composer-root]');
    await expect(composerRoot).toBeVisible();

    const indicator = window.getByTestId('sidebar-wake-lock-indicator');
    await expect(indicator).toHaveCount(0);

    // The pill shows while Settings → Labs → Early access is off (the
    // default). It subscribes once it mounts, so keep re-sending the held
    // state until the subscription receives it.
    const heldLock = { active: true, enabled: true, holderCount: 1 };
    await expect(async () => {
      await broadcastWakeLockState(electronApp, heldLock);
      await expect(indicator).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 15_000 });
    await expect(indicator).toHaveAccessibleName(/Sleep paused/);
    if ((await window.evaluate(() => window.platform)) === 'linux') {
      await expect(indicator).toHaveAccessibleName(
        /Your device can lock and turn off the display/,
      );
    }

    // The written label must paint alongside the glyph: a bare icon under the
    // composer reads as a stray artifact rather than a status.
    const label = indicator.getByText('Sleep paused', { exact: true });
    await expect(label).toBeVisible();
    const labelBox = await label.boundingBox();
    expect(labelBox?.width ?? 0).toBeGreaterThan(0);
    await expect(label).toHaveCSS('opacity', '1');

    // It must read as a pill with its own surface, not a bare glyph.
    const surfaceColor = await indicator.evaluate(
      (element) => getComputedStyle(element).backgroundColor,
    );
    expect(surfaceColor).not.toBe('rgba(0, 0, 0, 0)');

    // The pill is an independent floating chip in the bottom-right corner of
    // the main shell (everything right of the sidebar), floating above the
    // panel content like a quiet persistent toast. It must hug that corner,
    // stay fully inside the shell, and cover no interactive control — in the
    // default layout with a chat selected that means the composer's send and
    // mic buttons when the chat panel is the rightmost panel, and the
    // collapsed terminal strip's right-aligned controls beneath it.
    const CORNER_INSET_MAX_PX = 24;
    const placement = await indicator.evaluate((pill) => {
      const pillRect = pill.getBoundingClientRect();
      const describe = (element) =>
        element.getAttribute('data-testid') ??
        element.getAttribute('aria-label') ??
        element.tagName.toLowerCase();
      const box = (element) => {
        const rect = element.getBoundingClientRect();
        return {
          top: Math.round(rect.top),
          bottom: Math.round(rect.bottom),
          left: Math.round(rect.left),
          right: Math.round(rect.right),
        };
      };
      const shell = document.querySelector('[data-testid="app-main-shell"]');
      const sendButton = document.querySelector('[aria-label="Send message"]');
      const controls = Array.from(
        document.querySelectorAll(
          'button, a, input, [role="button"], [role="tab"], [contenteditable]',
        ),
      ).filter((element) => element !== pill && !pill.contains(element));
      // Hit-test a grid of points across the chip rather than comparing
      // rects: the Activity column is a scroll container, so rows clipped
      // out of view still report boxes that overlap the corner.
      const controlSet = new Set(controls);
      const covered = new Map();
      for (let x = pillRect.left + 1; x < pillRect.right; x += 2) {
        for (let y = pillRect.top + 1; y < pillRect.bottom; y += 2) {
          for (const element of document.elementsFromPoint(x, y)) {
            if (controlSet.has(element) && !covered.has(element)) {
              covered.set(element, {
                control: describe(element),
                ...box(element),
              });
            }
          }
        }
      }
      const coveredControls = Array.from(covered.values());
      // Every control that shares the shell's bottom 64px band, so a
      // failure explains what the chip is competing with.
      const bottomBandControls = controls
        .filter((element) => {
          const rect = element.getBoundingClientRect();
          return (
            rect.width > 0 &&
            shell !== null &&
            rect.bottom > shell.getBoundingClientRect().bottom - 64 &&
            rect.right > shell.getBoundingClientRect().left
          );
        })
        .map((element) => ({ control: describe(element), ...box(element) }));
      // The chip is a toast-style overlay: nothing reserves space for it, so
      // it may sit over content, but it must be the element that receives
      // the pointer at its own centre.
      const centre = document.elementFromPoint(
        (pillRect.left + pillRect.right) / 2,
        (pillRect.top + pillRect.bottom) / 2,
      );
      return {
        pill: box(pill),
        shell: shell ? box(shell) : null,
        sendButton: sendButton ? box(sendButton) : null,
        coveredControls,
        bottomBandControls,
        chipReceivesPointer: centre === pill || pill.contains(centre),
      };
    });
    const placementReport = JSON.stringify(placement, null, 2);
    // Keep the measured boxes with the run so a pass documents the layout
    // the chip was verified against, not only a failure.
    await test.info().attach('bottom-status-chip-placement', {
      body: placementReport,
      contentType: 'application/json',
    });
    expect(placement.shell, placementReport).not.toBeNull();
    // Fully inside the shell...
    expect(placement.pill.left, placementReport).toBeGreaterThanOrEqual(
      placement.shell.left,
    );
    expect(placement.pill.top, placementReport).toBeGreaterThanOrEqual(
      placement.shell.top,
    );
    expect(placement.pill.right, placementReport).toBeLessThanOrEqual(
      placement.shell.right,
    );
    expect(placement.pill.bottom, placementReport).toBeLessThanOrEqual(
      placement.shell.bottom,
    );
    // ...hugging its bottom-right corner...
    expect(
      placement.shell.right - placement.pill.right,
      placementReport,
    ).toBeLessThanOrEqual(CORNER_INSET_MAX_PX);
    expect(
      placement.shell.bottom - placement.pill.bottom,
      placementReport,
    ).toBeLessThanOrEqual(CORNER_INSET_MAX_PX);
    // ...and painted above whatever content shares that corner.
    expect(placement.chipReceivesPointer, placementReport).toBe(true);

    // Releasing the last holder removes the pill again.
    await broadcastWakeLockState(electronApp, {
      active: false,
      enabled: true,
      holderCount: 0,
    });
    await expect(indicator).toHaveCount(0);

    // The indicator leads to the existing Sleep setting on every supported OS.
    await broadcastWakeLockState(electronApp, heldLock);
    await expect(indicator).toBeVisible();
    await indicator.click();
    await expect(
      window.getByTestId('settings-keep-system-awake'),
    ).toBeVisible();
    await app.closeSettings();

    // Early access hides the pill even while a lock is held. The switch
    // reaches the shell through the preferences push, without a reload.
    await broadcastWakeLockState(electronApp, heldLock);
    await expect(indicator).toBeVisible();
    await window.evaluate(() =>
      window.api.experiments.setChoice({
        experimentId: 'early-access',
        enabled: true,
      }),
    );
    await expect(indicator).toHaveCount(0);
    await broadcastWakeLockState(electronApp, heldLock);
    await expect(indicator).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
