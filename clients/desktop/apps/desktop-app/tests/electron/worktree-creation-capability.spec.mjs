// REG-3022 / B#4923: the actual desktop shared-sidebar host reports
// worktreeCreation for local projects. Both header and group creation must
// continue through the real IPC/store and persist after reload. Desktop has
// no disabled per-project client; the web mixed-client spec proves that gate.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  seedChatsSectionFixture,
  CHATS_SECTION_CODE_WORKSPACE_ID,
} from './seeders/seedChatsSectionFixture.mjs';

for (const entryPoint of ['project header', 'group header', 'group menu']) {
  test(`supported local project creates through its ${entryPoint} and retains the settled, user-ready row after active-worktree reload`, async () => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'creation-gate-desktop-'),
    );
    const { worktreeIds } = seedChatsSectionFixture(userDataDir, {
      worktreeCount: 1,
      chatEntryCount: 1,
    });
    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await window.evaluate(() =>
        localStorage.setItem('canopy.desktop.sharedSidebar', '1'),
      );
      await window.reload();
      await app.waitForShell({ timeout: 30_000 });
      const scope = { workspaceLocalId: CHATS_SECTION_CODE_WORKSPACE_ID };
      const group = await window.evaluate(
        ({ scope, itemId }) =>
          window.api.sidebarItemGroups.create({
            scope,
            itemId,
            name: 'Release group',
          }),
        { scope, itemId: worktreeIds[0] },
      );
      await window.reload();
      await app.waitForShell({ timeout: 30_000 });
      // Observe the real IPC handler; no synthetic completed row or capability.
      await electronApp.evaluate(({ ipcMain }) => {
        const create = ipcMain._invokeHandlers.get('worktree:create');
        if (!create) throw new Error('worktree:create handler missing');
        globalThis.__CREATION_GATE_CALLS__ = [];
        ipcMain.removeHandler('worktree:create');
        ipcMain.handle('worktree:create', async (event, request) => {
          globalThis.__CREATION_GATE_CALLS__.push(request);
          return create(event, request);
        });
      });
      const project = window
        .getByTestId('sidebar-shared-rail')
        .locator(`[data-workspace-id="${CHATS_SECTION_CODE_WORKSPACE_ID}"]`);
      await expect(project).toBeVisible();
      if (entryPoint === 'project header') {
        await project.hover();
        await app.workspaceHeaderLabel('Chats Section Code').hover();
        const create = window.getByRole('button', {
          name: /^Create (task|worktree) for Chats Section Code$/,
        });
        await create.focus();
        await create.press('Enter');
      } else if (entryPoint === 'group header') {
        await project.getByTestId('sidebar-item-group-header').hover();
        await project.getByTestId('sidebar-item-group-create').click();
      } else {
        const menuTrigger = project.getByTestId(
          'sidebar-item-group-menu-trigger',
        );
        await menuTrigger.focus();
        await menuTrigger.press('Enter');
        await window
          .getByTestId('sidebar-item-group-menu')
          .getByRole('menuitem', { name: /^New (task|worktree) in group$/ })
          .click();
      }
      const registry = path.join(
        userDataDir,
        'workspaces',
        CHATS_SECTION_CODE_WORKSPACE_ID,
        'worktrees.json',
      );
      const ids = () =>
        JSON.parse(readFileSync(registry, 'utf8')).worktrees.map(
          (row) => row.id,
        );
      await expect.poll(ids).toHaveLength(2);
      const createdId = ids().find((id) => !worktreeIds.includes(id));
      const calls = await electronApp.evaluate(
        () => globalThis.__CREATION_GATE_CALLS__,
      );
      expect(calls).toHaveLength(1);
      expect(calls[0].projectId).toBe(CHATS_SECTION_CODE_WORKSPACE_ID);
      if (entryPoint !== 'project header')
        expect(calls[0].sidebarItemGroupId).toBe(group.id);
      const row = project.locator(`[data-worktree-id="${createdId}"]`);
      await expect(row).toBeVisible();
      // Desktop registration precedes background Git setup. The settled scenario waits
      // for Git setup and the actual chat editor/model controls before reload.
      await expect
        .poll(
          () =>
            JSON.parse(readFileSync(registry, 'utf8')).worktrees.find(
              (worktree) => worktree.id === createdId,
            )?.setupPhase,
        )
        .not.toBe('git-pending');
      await expect(window.getByTestId('page-main')).toBeVisible();
      const chatPanel = window.getByTestId('panel-content-chat');
      await expect(
        chatPanel.locator('[data-slate-editor="true"]'),
      ).toBeVisible();
      await expect(chatPanel.getByTestId('chat-model-picker')).toBeVisible();
      await window.reload();
      await app.waitForShell({ timeout: 30_000 });
      await expect(row).toBeVisible();
      if (entryPoint !== 'project header') {
        const saved = await window.evaluate(
          (scope) => window.api.sidebarItemGroups.list(scope),
          scope,
        );
        expect(saved[0].memberIds).toEqual([worktreeIds[0], createdId]);
        await expect(
          project
            .locator(`[data-sidebar-item-group-id="${group.id}"]`)
            .locator(`[data-worktree-id="${createdId}"]`),
        ).toBeVisible();
      }
    } finally {
      await closeCanopy(electronApp, userDataDir);
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });
}
