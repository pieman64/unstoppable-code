/** Agent group operations through authenticated MCP, with real persisted owners. */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { seedBrowserProfileEntryOwners } from './seeders/browser-profile-state.mjs';
import { expandCoworkWorkspace } from './coworkWorkEntryDoneFixture.mjs';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

async function callTool(route, name, args) {
  const response = await fetch(route.url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${route.authToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: `${name}-${Date.now()}`,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
    signal: AbortSignal.timeout(60_000),
  });
  expect(response.status).toBe(200);
  const envelope = await response.json();
  expect(envelope.error).toBeUndefined();
  const text = envelope.result.content.find(
    (block) => block.type === 'text',
  )?.text;
  return {
    isError: envelope.result.isError === true,
    result: text?.startsWith('{') ? JSON.parse(text) : text,
  };
}

for (const owner of ['worktree', 'cowork']) {
  test(`${owner} agents manage their current group and Advisor targets the same project`, async () => {
    test.setTimeout(120_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'sidebar-agent-tools-'),
    );
    seedDemoWorkspaces({
      userDataDir,
      apps: ['ts-pnpm-vite'],
      checkRuntimes: false,
    });
    await seedBrowserProfileEntryOwners(userDataDir);
    const projectId =
      owner === 'cowork' ? 'profile-data-cowork' : 'demo-ts-pnpm-vite';
    const itemId = owner === 'cowork' ? 'profile-cowork-entry' : 'demo-main';
    if (owner === 'cowork') {
      const chats = path.join(userDataDir, 'workspaces', projectId, 'chats');
      mkdirSync(chats, { recursive: true });
      writeFileSync(
        path.join(chats, `${itemId}.json`),
        JSON.stringify({
          version: 1,
          activeTabId: 'seed-chat',
          tabs: [
            {
              id: 'seed-chat',
              title: 'Research task',
              createdAt: '2026-10-05T00:00:00Z',
              kind: 'chat',
              messages: [],
            },
          ],
        }),
      );
    }
    const { electronApp } = await launchCanopy({ userDataDir });
    const routes = [];
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();
      if (owner === 'cowork') await expandCoworkWorkspace(window, projectId);
      else {
        await app.openMainPage();
        await app.selectWorktree(itemId);
      }
      const scoped = await electronApp.evaluate(
        (_electron, owner) =>
          globalThis.__CANOPY_E2E_BROWSER_MCP_ROUTE__({
            kind: 'create',
            owner,
          }),
        owner,
      );
      routes.push(scoped);
      const advisor = await electronApp.evaluate(() =>
        globalThis.__CANOPY_E2E_BROWSER_MCP_ROUTE__({
          kind: 'create',
          owner: 'advisor',
          mode: 'app-advisor',
        }),
      );
      routes.push(advisor);
      const discovered = await callTool(scoped, 'SearchActions', {
        category: 'sidebar',
      });
      expect(discovered.result.actions.map((action) => action.type)).toEqual(
        expect.arrayContaining([
          'sidebar.item_groups.list',
          'sidebar.item_groups.set_item',
          'sidebar.item_groups.update',
          'sidebar.item_groups.list_items',
        ]),
      );
      const created = await callTool(scoped, 'DispatchAction', {
        action: {
          type: 'sidebar.item_groups.set_item',
          newGroup: { name: 'Agent work', color: 'categorical-2' },
        },
      });
      expect(created.result.ok).toBe(true);
      const groupId = created.result.result.groupId;
      await expect(
        window.locator(`[data-sidebar-item-group-id="${groupId}"]`).first(),
      ).toContainText('Agent work');
      const listed = await callTool(scoped, 'DispatchAction', {
        action: { type: 'sidebar.item_groups.list' },
      });
      expect(listed.result.result.groups).toEqual([
        expect.objectContaining({
          id: groupId,
          name: 'Agent work',
          color: 'categorical-2',
          order: 0,
        }),
      ]);
      const scope = { workspaceLocalId: projectId };
      const updated = await callTool(advisor, 'DispatchAction', {
        action: {
          type: 'sidebar.item_groups.update',
          scope,
          groupId,
          name: 'Updated work',
          color: 'categorical-4',
        },
      });
      expect(updated.result.ok).toBe(true);
      await expect(
        window.locator(`[data-sidebar-item-group-id="${groupId}"]`).first(),
      ).toContainText('Updated work');
      const members = await callTool(scoped, 'DispatchAction', {
        action: { type: 'sidebar.item_groups.list_items', groupId },
      });
      expect(members.result.result.items).toEqual([
        expect.objectContaining({ id: itemId, groupId }),
      ]);
      const advisorMembers = await callTool(advisor, 'DispatchAction', {
        action: { type: 'sidebar.item_groups.list_items', scope, groupId },
      });
      expect(advisorMembers.result.result.items).toEqual([
        expect.objectContaining({ id: itemId, groupId }),
      ]);
      const items = await callTool(advisor, 'DispatchAction', {
        action:
          owner === 'cowork'
            ? { type: 'standalone-chat.list_chats', projectId }
            : { type: 'workspace.list_worktrees', workspaceId: projectId },
      });
      expect(items.result.ok).toBe(true);
      const itemRows =
        owner === 'cowork'
          ? items.result.result.chats
          : items.result.result.worktrees;
      expect(itemRows).toEqual(
        expect.arrayContaining([
          expect.objectContaining(
            owner === 'cowork'
              ? { workEntryId: itemId, groupId }
              : { id: itemId, groupId },
          ),
        ]),
      );
      const foreign = await callTool(scoped, 'DispatchAction', {
        action: {
          type: 'sidebar.item_groups.set_item',
          scope: { workspaceLocalId: 'other-project' },
          itemId: 'other-item',
          groupId: null,
        },
      });
      expect(foreign.isError).toBe(true);
      const removed = await callTool(scoped, 'DispatchAction', {
        action: { type: 'sidebar.item_groups.set_item', groupId: null },
      });
      expect(removed.result).toMatchObject({
        ok: true,
        result: { itemId, groupId: null, groups: [] },
      });
      await expect(
        window.locator(`[data-sidebar-item-group-id="${groupId}"]`),
      ).toHaveCount(0);
      const recreated = await callTool(advisor, 'DispatchAction', {
        action: {
          type: 'sidebar.item_groups.set_item',
          scope,
          itemId,
          newGroup: { name: 'Advisor work' },
        },
      });
      expect(recreated.result.ok).toBe(true);
      await window.reload();
      await app.waitForShell();
      const persisted = await window.evaluate(
        (scope) => window.api.sidebarItemGroups.list(scope),
        scope,
      );
      expect(persisted).toEqual([
        expect.objectContaining({ name: 'Advisor work', memberIds: [itemId] }),
      ]);
    } finally {
      for (const route of routes)
        await electronApp.evaluate(
          (_electron, sessionKey) =>
            globalThis.__CANOPY_E2E_BROWSER_MCP_ROUTE__({
              kind: 'delete',
              sessionKey,
            }),
          route.sessionKey,
        );
      await closeCanopy(electronApp, userDataDir);
    }
  });
}
