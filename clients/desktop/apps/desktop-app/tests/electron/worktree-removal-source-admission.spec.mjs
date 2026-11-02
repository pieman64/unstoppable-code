import {
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

// ---------------------------------------------------------------------------
// CAN-5333 (CAN-4995 leg B): the desktop renderer runs main's read-only source
// admission before any of its own removal effects. A worktree whose source
// repository Git can't open is refused before the pending "Archived and
// deleted" entry, deselection, setup cancellation, script and hook stops,
// teardown or optimistic removal; nothing needs restoring. Once the source is
// back, the same action archives normally, so the check reserved nothing.
//
// Drives the real sidebar row, preload and IPC. Main's removal-effect
// channels are wrapped to count calls; the configured teardown writes a
// marker file, so a teardown that ran leaves it behind.
// ---------------------------------------------------------------------------

const WORKTREE_BRANCH = 'demo-main';
const SOURCE_UNAVAILABLE =
  "Couldn't verify the worktree's source repositories. Check repository access and retry.";
const EFFECT_CHANNELS = [
  'script:cancel-worktree-setup',
  'script:stop',
  'hook:stop',
  'script:run',
  'worktree:archive',
];

function seed(userDataDir) {
  const { workspaces } = seedDemoWorkspaces({
    userDataDir,
    apps: ['ts-pnpm-vite'],
  });
  const workspace = workspaces[0];
  const workspaceDir = path.join(userDataDir, 'workspaces', workspace.id);
  const configPath = path.join(workspaceDir, 'workspace.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const marker = path.join(userDataDir, 'teardown-ran');
  config.scripts = { ...config.scripts, teardown: `echo ran > '${marker}'` };
  writeFileSync(configPath, JSON.stringify(config));
  return {
    workspace,
    marker,
    worktreesPath: path.join(workspaceDir, 'worktrees.json'),
  };
}

/** Removal state, without chat badges that launch backfill updates on its own. */
function readRemovalState(worktreesPath) {
  const file = JSON.parse(readFileSync(worktreesPath, 'utf8'));
  for (const row of file.worktrees) delete row.chatBadges;
  return file;
}

/** The worktree row's activity watermark in epoch milliseconds, or NaN. */
function readLastTouchedAt(worktreesPath) {
  const { worktrees } = JSON.parse(readFileSync(worktreesPath, 'utf8'));
  const row = worktrees.find(
    (worktree) => worktree.branchName === WORKTREE_BRANCH,
  );
  return Date.parse(row?.lastTouchedAt ?? '');
}

async function countEffectCalls(electronApp) {
  await electronApp.evaluate(({ ipcMain }, channels) => {
    const calls = {};
    globalThis.__removalEffectCalls = calls;
    for (const channel of channels) {
      const handler = ipcMain._invokeHandlers.get(channel);
      if (!handler) throw new Error(`Missing handler ${channel}`);
      calls[channel] = 0;
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, (...args) => {
        calls[channel] += 1;
        return handler(...args);
      });
    }
  }, EFFECT_CHANNELS);
}

const readEffectCalls = (electronApp) =>
  electronApp.evaluate(() => ({ ...globalThis.__removalEffectCalls }));

for (const removal of [
  { mode: 'archive', missingCheckout: false },
  { mode: 'delete', missingCheckout: true },
]) {
  test(`CAN-5333: a refused ${removal.mode} (missing checkout: ${removal.missingCheckout}) has no renderer effects`, async () => {
    test.setTimeout(150_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), `canopy-can5333-${removal.mode}-`),
    );
    const { workspace, marker, worktreesPath } = seed(userDataDir);
    const hiddenSource = `${workspace.repoPath}-unavailable`;
    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();
      const row = window.locator(
        `[data-testid="worktree-row"][data-branch="${WORKTREE_BRANCH}"]`,
      );
      await expect(row).toBeVisible();
      await row.click();
      // Loading a worktree without chats commits its starter chat, whose
      // observer writes the seeded row's first activity watermark; later
      // touches coalesce for a minute. Snapshot after that write.
      await expect
        .poll(() => readLastTouchedAt(worktreesPath), { timeout: 30_000 })
        .not.toBeNaN();

      if (removal.missingCheckout)
        rmSync(workspace.worktreePath, { recursive: true, force: true });
      const before = readRemovalState(worktreesPath);
      renameSync(workspace.repoPath, hiddenSource);
      await countEffectCalls(electronApp);

      // CAN-5336: a gone source offers the discard instead of the toast.
      const discard = window.getByTestId('worktree-discard-dialog');
      const remove = async () => {
        await row.hover();
        if (removal.mode === 'archive') {
          await row.getByTestId('worktree-archive-button').click();
        } else {
          await row.getByTestId('worktree-actions-menu-button').click();
          await window.getByTestId('worktree-actions-menu-delete').click();
        }
        // A confirm appears unless the removal takes its safe bypass.
        const dialog = window.getByRole('dialog', {
          name: /^(Archive|Delete) worktree/,
        });
        await expect
          .poll(
            async () =>
              (await dialog.isVisible()) ||
              (await discard.isVisible()) ||
              (await window.getByText(SOURCE_UNAVAILABLE).count()) > 0 ||
              (await row.count()) === 0,
          )
          .toBe(true);
        // Its one action commits the removal; the branch choice is irrelevant.
        if (await dialog.isVisible()) {
          await window
            .locator(
              '[data-testid="worktree-removal-preserve-branch"], [data-testid="worktree-removal-delete-branch"]',
            )
            .first()
            .click();
        }
      };

      await remove();
      await expect(discard).toBeVisible({ timeout: 30_000 });
      await expect(window.getByText(SOURCE_UNAVAILABLE)).toHaveCount(0);
      await window.getByTestId('worktree-discard-dialog-cancel').click();
      await expect(discard).toHaveCount(0);
      // Refused before every renderer effect: the row stayed, nothing was
      // announced as pending, and no setup, script, hook or teardown call or
      // archive request reached main.
      await expect(row).toBeVisible();
      expect(
        await window.evaluate(
          (workspaceId) =>
            window.__canopyArchivedContainersTestApi.getPendingContainerCount(
              workspaceId,
            ),
          workspace.id,
        ),
      ).toBe(0);
      expect(await readEffectCalls(electronApp)).toEqual(
        Object.fromEntries(EFFECT_CHANNELS.map((channel) => [channel, 0])),
      );
      expect(existsSync(marker)).toBe(false);
      expect(readRemovalState(worktreesPath)).toEqual(before);
      expect(existsSync(workspace.worktreePath)).toBe(!removal.missingCheckout);

      // The check is not a reservation: with the source back, the same
      // action runs its teardown and removes the worktree.
      renameSync(hiddenSource, workspace.repoPath);
      await window.evaluate(() => window.__canopyToastTestApi.clear());
      await expect(window.getByText(SOURCE_UNAVAILABLE)).toHaveCount(0);
      await remove();
      await expect(row).toHaveCount(0, { timeout: 30_000 });
      await expect
        .poll(
          () =>
            JSON.parse(readFileSync(worktreesPath, 'utf8')).worktrees.length,
          { timeout: 30_000 },
        )
        .toBe(0);
      expect((await readEffectCalls(electronApp))['worktree:archive']).toBe(1);
      if (!removal.missingCheckout) expect(existsSync(marker)).toBe(true);
    } finally {
      if (existsSync(hiddenSource))
        renameSync(hiddenSource, workspace.repoPath);
      await closeCanopy(electronApp, userDataDir);
    }
  });
}
