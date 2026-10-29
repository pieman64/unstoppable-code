import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver, closePanelTab } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  DEFAULT_GROUP_IDS,
  collectLeaves,
  getLayout,
} from './panelHarness.mjs';
import { seedWorktreeChat } from './seeders/index.mjs';

const WORKTREE_BRANCH = 'demo-main';
const CHAT_TAB_ID = 'sticky-scroll-chat';

function seedScrollableFileTree(worktreePath) {
  const nestedDir = path.join(worktreePath, 'sticky-scroll-e2e');
  mkdirSync(nestedDir, { recursive: true });
  for (let index = 0; index < 80; index += 1) {
    writeFileSync(
      path.join(
        worktreePath,
        `sticky-scroll-e2e-${String(index).padStart(2, '0')}.txt`,
      ),
      `sticky scroll e2e ${index}\n`,
      'utf8',
    );
  }
}

async function getChatGroupFileExplorerPanelId(window) {
  const layout = await getLayout(window);
  const chatLeaf = collectLeaves(layout.root).find(
    (leaf) => leaf.groupId === DEFAULT_GROUP_IDS.chat,
  );
  const panel = chatLeaf?.panels.find(
    (candidate) => candidate.kind === 'file-explorer',
  );
  expect(panel, 'file explorer panel in chat group').toBeTruthy();
  return panel.panelId;
}

test('file explorer sticky headers and scroll restoration work in Electron', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-file-explorer-sticky-scroll-'),
  );
  const demoSeed = seedDemoWorkspaces({
    userDataDir,
    apps: ['ts-pnpm-vite'],
  });
  const worktreePath = demoSeed.workspaces[0]?.worktreePath;
  expect(worktreePath, 'seeded worktree path').toBeTruthy();
  seedScrollableFileTree(worktreePath);
  seedWorktreeChat({
    userDataDir,
    workspaceId: 'demo-ts-pnpm-vite',
    worktreeId: WORKTREE_BRANCH,
    providerType: 'claude',
    tabs: [{ id: CHAT_TAB_ID, title: 'Chat' }],
  });

  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_BRANCH);

    await window.getByTestId('panel-add-panel-group-chat').click();
    await window.getByTestId('panel-add-menu-item-file-explorer').click();
    await expect(
      window.getByTestId('panel-content-file-explorer'),
    ).toBeVisible();

    const scroll = window.getByTestId('files-tree-scroll');
    await expect
      .poll(async () => window.getByTestId('files-tree-row').count(), {
        timeout: 20_000,
        message: 'seeded file rows should render in the file explorer',
      })
      .toBeGreaterThan(40);

    await expect
      .poll(
        async () => {
          await scroll.hover();
          await window.mouse.wheel(0, 360);
          return scroll.evaluate((element) => element.scrollTop);
        },
        {
          timeout: 5_000,
          message: 'real wheel input should scroll the file explorer',
        },
      )
      .toBeGreaterThanOrEqual(300);

    // CDP can apply wheel scrolling on Chromium's compositor without
    // forwarding the paired main-thread events to the Electron renderer.
    // Preserve the real-wheel/layout assertion above, then deliver the
    // omitted events before checking either app-managed sticky state or the
    // persistence boundary.
    await scroll.evaluate((element) => {
      element.dispatchEvent(
        new WheelEvent('wheel', { bubbles: true, deltaY: 0 }),
      );
      element.dispatchEvent(new Event('scroll', { bubbles: true }));
    });

    await expect
      .poll(
        async () =>
          // Folder rows are wrapped: the sticky marker
          // (`data-file-tree-folder`, where `data-stuck` is toggled) lives on
          // the wrapper while the `files-tree-folder` testid stays on the inner
          // row button, so select via the canonical sticky-marker attribute
          // rather than the testid.
          window.locator('[data-file-tree-folder][data-stuck="true"]').count(),
        {
          timeout: 5_000,
          message: 'a sticky folder header should be marked stuck after scroll',
        },
      )
      .toBeGreaterThan(0);

    await expect
      .poll(
        async () =>
          window.evaluate(
            ({ projectId, worktreeId }) =>
              window.__canopyPanelTestApi?.getFileTreeScrollPosition(
                projectId,
                worktreeId,
              ) ?? -1,
            {
              projectId: 'demo-ts-pnpm-vite',
              worktreeId: WORKTREE_BRANCH,
            },
          ),
        {
          timeout: 5_000,
          message:
            'file explorer should durably cache the user scroll position before remount',
        },
      )
      .toBeGreaterThanOrEqual(300);
    const explorerPanelId = await getChatGroupFileExplorerPanelId(window);
    await closePanelTab(window, explorerPanelId);
    await expect(window.getByTestId('panel-content-file-explorer')).toHaveCount(
      0,
    );

    await window.getByTestId('panel-add-panel-group-chat').click();
    await window.getByTestId('panel-add-menu-item-file-explorer').click();
    await expect(
      window.getByTestId('panel-content-file-explorer'),
    ).toBeVisible();

    await expect
      .poll(
        async () =>
          window
            .getByTestId('files-tree-scroll')
            .evaluate((element) => element.scrollTop),
        {
          timeout: 5_000,
          message: 'file explorer should restore the saved scroll position',
        },
      )
      .toBeGreaterThanOrEqual(300);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
