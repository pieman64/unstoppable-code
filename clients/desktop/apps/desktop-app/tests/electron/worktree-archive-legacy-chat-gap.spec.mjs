// A worktree whose legacy v1 chat snapshots diverged (tabs at revision 20,
// archives stale at 5, no journal records bridging them) used to fail every
// chat load with "Chat journal revision gap", which also blocked deleting the
// worktree at `chat:flush-scope`. The migration now recovers from the newest
// consistent snapshots, keeps the source files as evidence, and lets the user
// delete the worktree and open its chats.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { chatPanelLocator } from './panelHarness.mjs';
import { seedArchiveActivityFixture } from './seeders/archiveActivityFixture.mjs';

function seedDivergedLegacyChats(workspaceRoot, worktreeId) {
  const chatsPath = path.join(workspaceRoot, 'chats', `${worktreeId}.json`);
  const chats = JSON.parse(readFileSync(chatsPath, 'utf8'));
  writeFileSync(chatsPath, JSON.stringify({ ...chats, revision: 20 }));
  const archivesDir = path.join(workspaceRoot, 'chat-archives');
  mkdirSync(archivesDir, { recursive: true });
  writeFileSync(
    path.join(archivesDir, `${worktreeId}.json`),
    JSON.stringify({
      version: 1,
      revision: 5,
      archived: [
        {
          tab: {
            ...chats.tabs[0],
            id: `${worktreeId}-archived-chat`,
            title: 'Archived before the gap',
          },
          archivedAt: new Date().toISOString(),
          turnCount: 1,
        },
      ],
    }),
  );
  return chats.tabs[0].title;
}

test('worktrees with diverged legacy chat snapshots delete and open', async () => {
  test.setTimeout(180_000);
  const { userDataDir, workspace, workspaceRoot, original, otherId } =
    seedArchiveActivityFixture();
  seedDivergedLegacyChats(workspaceRoot, otherId);
  const liveTitle = seedDivergedLegacyChats(workspaceRoot, original.id);

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    const revisionGap = window.getByText(/revision gap/);

    // Deleting flushes the scope's chats first; this is where the gap blocked.
    const row = window.locator(
      `[data-testid="worktree-row"][data-worktree-id="${otherId}"][data-project-id="${workspace.id}"]`,
    );
    await row.hover();
    await row.getByTestId('worktree-actions-menu-button').click();
    await window.getByTestId('worktree-actions-menu-delete').click();
    const dialog = window.getByRole('dialog', { name: 'Delete worktree?' });
    const confirmationRequired = await dialog
      .waitFor({ state: 'visible', timeout: 5_000 })
      .then(() => true)
      .catch(() => false);
    if (confirmationRequired) {
      await dialog.getByTestId('worktree-removal-preserve-branch').click();
    }
    await expect(row).toHaveCount(0, { timeout: 60_000 });
    await expect(revisionGap).toHaveCount(0);

    await app.selectWorktree(original.id);
    await expect(chatPanelLocator(window)).toBeVisible();
    await expect(window.getByText(liveTitle).first()).toBeVisible({
      timeout: 30_000,
    });
    await expect(revisionGap).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
