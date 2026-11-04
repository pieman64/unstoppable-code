import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { chatPanelLocator } from './panelHarness.mjs';
import { configureArchiveFixture } from './seeders/largeArchiveFixture.mjs';
import { seedWorktreeChat } from './seeders/index.mjs';

async function confirmWorktreeArchive(window, row) {
  await row.hover();
  await row.getByTestId('worktree-actions-menu-button').click();
  await window.getByTestId('worktree-actions-menu-archive').click();
  const dialog = window.getByRole('dialog', { name: /^Archive worktree/ });
  await expect(dialog).toBeVisible();
  await dialog.getByTestId('worktree-removal-preserve-branch').click();
}

// Cassowary: the archive worker stopped acknowledging the managed-payload copy
// after chat storage copied. The original checkout stayed intact. This spec
// reproduces the admission timeout through the real sidebar archive action,
// holds the worker's exit, then retries after the interruption is reported.
test('waits for archive worker exit after admission timeout and keeps the worktree and chat when the retry is refused', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-archive-admission-'),
  );
  let electronApp;
  try {
    const {
      workspaces: [workspace],
    } = seedDemoWorkspaces({
      userDataDir,
      apps: ['ts-pnpm-vite'],
    });
    writeFileSync(
      path.join(userDataDir, 'preferences.json'),
      JSON.stringify({
        version: 1,
        preferences: { onboardingCompleted: ['v1'] },
      }),
    );
    configureArchiveFixture(userDataDir, workspace.id);
    const worktreeId = 'demo-main';
    const retainedText =
      'Cassowary chat survives an archive worker interruption.';
    seedWorktreeChat({
      userDataDir,
      workspaceId: workspace.id,
      worktreeId,
      activeTabId: 'admission-chat',
      tabs: [
        {
          id: 'admission-chat',
          title: 'Admission retry chat',
          providerType: 'claude',
          messages: [
            {
              id: 'admission-chat-message',
              role: 'user',
              timestamp: Date.now(),
              blocks: [{ type: 'text', text: retainedText }],
            },
          ],
        },
      ],
    });

    ({ electronApp } = await launchCanopy({ userDataDir }));
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    const row = window.locator(
      '[data-testid="worktree-row"][data-branch="demo-main"]',
    );
    await row.click();
    await expect(
      chatPanelLocator(window).getByText(retainedText),
    ).toBeVisible();

    // Intercept only this fresh archive worker. The managed-payload request
    // never reaches it, so the runner's real 10-second admission timer fires.
    // Holding kill exposes an early rejection before the child actually exits.
    await electronApp.evaluate(({ utilityProcess }) => {
      const originalFork = utilityProcess.fork;
      let releaseKill;
      const killGate = new Promise((resolve) => {
        releaseKill = resolve;
      });
      const fault = {
        archiveForks: 0,
        swallowed: false,
        killRequested: false,
        releaseKill: () => releaseKill(),
        restore: () => {
          utilityProcess.fork = originalFork;
        },
      };
      utilityProcess.fork = function (...args) {
        const child = originalFork.apply(this, args);
        if (args[2]?.serviceName !== 'archive-io') return child;
        fault.archiveForks += 1;
        const originalPost = child.postMessage.bind(child);
        child.postMessage = (message, ...rest) => {
          if (
            !fault.swallowed &&
            message?.type === 'copy-payload' &&
            message.operationId?.endsWith(':copy-managed-payload')
          ) {
            fault.swallowed = true;
            return;
          }
          return originalPost(message, ...rest);
        };
        const originalKill = child.kill.bind(child);
        child.kill = (...args) => {
          fault.killRequested = true;
          void killGate.then(() => originalKill(...args));
          return true;
        };
        return child;
      };
      globalThis.__cassowaryArchiveFault = fault;
    });

    await confirmWorktreeArchive(window, row);
    await expect
      .poll(
        () =>
          electronApp.evaluate(() => ({
            archiveForks: globalThis.__cassowaryArchiveFault.archiveForks,
            swallowed: globalThis.__cassowaryArchiveFault.swallowed,
            killRequested: globalThis.__cassowaryArchiveFault.killRequested,
          })),
        { timeout: 25_000 },
      )
      .toEqual({
        archiveForks: 1,
        swallowed: true,
        killRequested: true,
      });
    await window.waitForTimeout(1_000);
    expect(
      await window
        .getByTestId('toast-card')
        .filter({ hasText: 'Archive work was interrupted' })
        .count(),
    ).toBe(0);
    const workspaceMetaDir = path.join(userDataDir, 'workspaces', workspace.id);
    const archiveDir = path.join(
      workspaceMetaDir,
      'archived-containers',
      worktreeId,
    );
    expect(existsSync(workspace.worktreePath)).toBe(true);
    expect(existsSync(path.join(archiveDir, 'container.json'))).toBe(false);
    expect(existsSync(path.join(archiveDir, 'git-state.staged.json'))).toBe(
      false,
    );

    await electronApp.evaluate(() => {
      const fault = globalThis.__cassowaryArchiveFault;
      fault.restore();
      fault.releaseKill();
    });
    await expect(
      window.getByTestId('toast-card').filter({
        hasText: 'Archive work was interrupted',
      }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(row).toBeVisible();
    expect(
      JSON.parse(
        readFileSync(path.join(workspaceMetaDir, 'worktrees.json'), 'utf8'),
      ).worktrees.some((worktree) => worktree.id === worktreeId),
    ).toBe(true);

    // The interrupted archive's journal ends recovery-required, so the retry
    // is refused and offers the discard instead. Cancel keeps the worktree.
    await confirmWorktreeArchive(window, row);
    const discard = window.getByTestId('worktree-discard-dialog');
    await expect(discard).toBeVisible({ timeout: 30_000 });
    await expect(
      window.getByTestId('worktree-discard-dialog-targets'),
    ).toContainText(workspace.worktreePath);
    await window.getByTestId('worktree-discard-dialog-cancel').click();
    await expect(discard).toHaveCount(0);
    await expect(row).toBeVisible();
    expect(existsSync(workspace.worktreePath)).toBe(true);
    expect(existsSync(path.join(archiveDir, 'container.json'))).toBe(false);
    expect(
      JSON.parse(
        readFileSync(path.join(workspaceMetaDir, 'worktrees.json'), 'utf8'),
      ).worktrees.some((worktree) => worktree.id === worktreeId),
    ).toBe(true);
    await row.click();
    await expect(
      chatPanelLocator(window).getByText(retainedText),
    ).toBeVisible();
  } finally {
    if (electronApp) {
      await electronApp
        .evaluate(() => {
          const fault = globalThis.__cassowaryArchiveFault;
          if (fault) {
            fault.restore();
            fault.releaseKill();
          }
        })
        .catch(() => undefined);
      await closeCanopy(electronApp, userDataDir);
    } else {
      rmSync(userDataDir, { recursive: true, force: true });
    }
  }
});
