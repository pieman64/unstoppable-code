import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  rmSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  seedChatsSectionFixture,
  CHATS_SECTION_CODE_WORKSPACE_ID,
  CHATS_SECTION_NAMED_COWORK_ID,
  CHATS_SECTION_NAMED_COWORK_ENTRY_ID,
} from './seeders/seedChatsSectionFixture.mjs';

const json = (file) => JSON.parse(readFileSync(file, 'utf8'));

test('typed host groups persist, carry complete order, reconcile lifecycle and survive reload', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'sidebar-groups-host-'),
  );
  const { worktreeIds } = seedChatsSectionFixture(userDataDir, {
    worktreeCount: 3,
    chatEntryCount: 1,
  });
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    await new CanopyAppDriver(window).waitForShell({ timeout: 30_000 });
    const scope = { workspaceLocalId: CHATS_SECTION_CODE_WORKSPACE_ID };
    const group = await window.evaluate(
      ({ scope, itemId }) =>
        window.api.sidebarItemGroups.create({
          scope,
          itemId,
          name: 'Host group',
        }),
      { scope, itemId: worktreeIds[0] },
    );
    await window.evaluate(
      ({ scope, itemId, groupId }) =>
        window.api.sidebarItemGroups.moveItem({ scope, itemId, groupId }),
      { scope, itemId: worktreeIds[2], groupId: group.id },
    );
    const registry = path.join(
      userDataDir,
      'workspaces',
      CHATS_SECTION_CODE_WORKSPACE_ID,
      'worktrees.json',
    );
    expect(json(registry).worktrees.map((row) => row.id)).toEqual([
      worktreeIds[0],
      worktreeIds[2],
      worktreeIds[1],
    ]);
    await window.reload();
    await new CanopyAppDriver(window).waitForShell({ timeout: 30_000 });
    expect(
      await window.evaluate(
        (scope) => window.api.sidebarItemGroups.list(scope),
        scope,
      ),
    ).toEqual([{ ...group, memberIds: [worktreeIds[0], worktreeIds[2]] }]);
    await window.evaluate(
      ({ projectId, worktreeId }) =>
        window.api.setWorktreePinned({ projectId, worktreeId, pinned: true }),
      {
        projectId: CHATS_SECTION_CODE_WORKSPACE_ID,
        worktreeId: worktreeIds[0],
      },
    );
    expect(
      (
        await window.evaluate(
          (scope) => window.api.sidebarItemGroups.list(scope),
          scope,
        )
      )[0].memberIds,
    ).toEqual([worktreeIds[2]]);
    await expect(window.getByTestId('sidebar-shared-rail')).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('a held grouped creation cannot expose an ungrouped row before its membership commits', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'sidebar-group-creation-'),
  );
  seedChatsSectionFixture(userDataDir, { worktreeCount: 1, chatEntryCount: 1 });
  const { electronApp } = await launchCanopy({ userDataDir });
  const workspaceDir = path.join(
    userDataDir,
    'workspaces',
    CHATS_SECTION_NAMED_COWORK_ID,
  );
  const sidecar = path.join(workspaceDir, 'sidebar-item-groups.json');
  try {
    const window = await electronApp.firstWindow();
    await new CanopyAppDriver(window).waitForShell({ timeout: 30_000 });
    const scope = { workspaceLocalId: CHATS_SECTION_NAMED_COWORK_ID };
    const group = await window.evaluate(
      ({ scope, itemId }) =>
        window.api.sidebarItemGroups.create({
          scope,
          itemId,
          name: 'Creation group',
        }),
      { scope, itemId: CHATS_SECTION_NAMED_COWORK_ENTRY_ID },
    );
    writeFileSync(`${sidecar}.e2e-hold`, 'hold');
    await electronApp.evaluate(() => {
      process.env.CANOPY_E2E_SIDEBAR_ITEM_GROUP_HOLD_WRITES = '1';
    });
    const prior = json(
      path.join(workspaceDir, 'work-entries.json'),
    ).entries.map((row) => row.id);
    const creation = window.evaluate(
      ({ projectId, groupId }) =>
        window.api.workEntries.create({
          projectId,
          title: 'Held creation',
          sidebarItemGroupId: groupId,
        }),
      { projectId: CHATS_SECTION_NAMED_COWORK_ID, groupId: group.id },
    );
    await expect.poll(() => existsSync(`${sidecar}.e2e-entered`)).toBe(true);
    expect(
      json(path.join(workspaceDir, 'work-entries.json')).entries.map(
        (row) => row.id,
      ),
    ).toEqual(prior);
    expect(json(sidecar).groups[0].memberIds).toEqual([
      CHATS_SECTION_NAMED_COWORK_ENTRY_ID,
    ]);
    rmSync(`${sidecar}.e2e-hold`);
    const result = await creation;
    expect(result.reusedExistingEmpty).toBe(false);
    const members = json(sidecar).groups[0].memberIds;
    expect(members).toEqual([
      CHATS_SECTION_NAMED_COWORK_ENTRY_ID,
      result.entry.id,
    ]);
    expect(
      json(path.join(workspaceDir, 'work-entries.json')).entries.map(
        (row) => row.id,
      ),
    ).toEqual([result.entry.id, CHATS_SECTION_NAMED_COWORK_ENTRY_ID]);
    expect(
      (
        await window.evaluate(
          (scope) => window.api.sidebarItemGroups.list(scope),
          scope,
        )
      )[0].memberIds,
    ).toEqual(members);
  } finally {
    rmSync(`${sidecar}.e2e-hold`, { force: true });
    await closeCanopy(electronApp, userDataDir);
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('git-pending worktree creation commits group membership before its reservation is visible', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'sidebar-group-worktree-'),
  );
  const { worktreeIds } = seedChatsSectionFixture(userDataDir, {
    worktreeCount: 1,
    chatEntryCount: 1,
  });
  const { electronApp } = await launchCanopy({ userDataDir });
  const workspaceDir = path.join(
    userDataDir,
    'workspaces',
    CHATS_SECTION_CODE_WORKSPACE_ID,
  );
  const sidecar = path.join(workspaceDir, 'sidebar-item-groups.json');
  try {
    const window = await electronApp.firstWindow();
    await new CanopyAppDriver(window).waitForShell({ timeout: 30_000 });
    const scope = { workspaceLocalId: CHATS_SECTION_CODE_WORKSPACE_ID };
    const group = await window.evaluate(
      ({ scope, itemId }) =>
        window.api.sidebarItemGroups.create({
          scope,
          itemId,
          name: 'Reservation group',
        }),
      { scope, itemId: worktreeIds[0] },
    );
    writeFileSync(`${sidecar}.e2e-hold`, 'hold');
    await electronApp.evaluate(() => {
      process.env.CANOPY_E2E_SIDEBAR_ITEM_GROUP_HOLD_WRITES = '1';
    });
    const creation = window.evaluate(
      (request) => window.api.createWorktree(request),
      {
        projectId: CHATS_SECTION_CODE_WORKSPACE_ID,
        repoPath: path.join(userDataDir, 'chats-section-repo'),
        existingWorktreeIds: worktreeIds,
        sidebarItemGroupId: group.id,
        baseBranch: 'main',
        branchName: 'feature/group-created',
      },
    );
    await expect.poll(() => existsSync(`${sidecar}.e2e-entered`)).toBe(true);
    expect(
      json(path.join(workspaceDir, 'worktrees.json')).worktrees.map(
        (row) => row.id,
      ),
    ).toEqual(worktreeIds);
    expect(json(sidecar).groups[0].memberIds).toEqual(worktreeIds);
    rmSync(`${sidecar}.e2e-hold`);
    const result = await creation;
    expect(result.setupPhase).toBe('git-pending');
    expect(json(sidecar).groups[0].memberIds).toEqual([
      ...worktreeIds,
      result.id,
    ]);
    expect(
      json(path.join(workspaceDir, 'worktrees.json')).worktrees.map(
        (row) => row.id,
      ),
    ).toEqual([result.id, ...worktreeIds]);
    expect(
      (
        await window.evaluate(
          (scope) => window.api.sidebarItemGroups.list(scope),
          scope,
        )
      )[0].memberIds,
    ).toEqual([...worktreeIds, result.id]);
  } finally {
    rmSync(`${sidecar}.e2e-hold`, { force: true });
    await closeCanopy(electronApp, userDataDir);
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('an unreadable project registry is preserved while a healthy sidebar project saves and reloads', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'sidebar-registry-preserve-'),
  );
  seedChatsSectionFixture(userDataDir, { worktreeCount: 1, chatEntryCount: 1 });
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    const header = window.getByTestId(
      `sidebar-cowork-project-${CHATS_SECTION_NAMED_COWORK_ID}-toggle`,
    );
    await expect(header).toBeVisible();
    const items = await window.evaluate(
      async () => (await window.api.loadProjects()).items,
    );
    const healthy = items.find(
      (item) => item.id === CHATS_SECTION_NAMED_COWORK_ID,
    );
    expect(healthy).toBeDefined();
    healthy.name = 'Saved healthy project';
    const registry = path.join(
      userDataDir,
      'workspaces',
      CHATS_SECTION_CODE_WORKSPACE_ID,
      'worktrees.json',
    );
    const config = path.join(path.dirname(registry), 'workspace.json');
    const configBefore = readFileSync(config, 'utf8');
    const index = path.join(userDataDir, 'workspaces', 'index.json');
    const indexEntry = json(index).workspaces.find(
      (item) => item.id === CHATS_SECTION_CODE_WORKSPACE_ID,
    );
    const stale = items.find(
      (item) => item.id === CHATS_SECTION_CODE_WORKSPACE_ID,
    );
    expect(stale).toBeDefined();
    stale.name = 'Stale replacement';
    stale.collapsed = true;
    const unreadable = '{"version":1,"worktrees":[';
    writeFileSync(registry, unreadable);
    const saved = await window.evaluate(
      (items) => window.api.saveProjects(items),
      items,
    );
    expect(saved.preservedWorkspaceIds).toContain(
      CHATS_SECTION_CODE_WORKSPACE_ID,
    );
    expect(
      saved.items.find((item) => item.id === CHATS_SECTION_NAMED_COWORK_ID)
        ?.name,
    ).toBe('Saved healthy project');
    expect(readFileSync(registry, 'utf8')).toBe(unreadable);
    expect(
      json(index).workspaces.find(
        (item) => item.id === CHATS_SECTION_CODE_WORKSPACE_ID,
      ),
    ).toEqual(indexEntry);
    expect(readFileSync(config, 'utf8')).toBe(configBefore);
    await window.reload();
    await app.waitForShell({ timeout: 30_000 });
    await expect(header).toContainText('Saved healthy project');
    expect(readFileSync(registry, 'utf8')).toBe(unreadable);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('failed post-commit group reconciliation retains the registered worktree metadata', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'sidebar-reservation-retain-'),
  );
  const { worktreeIds } = seedChatsSectionFixture(userDataDir, {
    worktreeCount: 1,
    chatEntryCount: 1,
  });
  const { electronApp } = await launchCanopy({ userDataDir });
  const workspaceDir = path.join(
    userDataDir,
    'workspaces',
    CHATS_SECTION_CODE_WORKSPACE_ID,
  );
  const sidecar = path.join(workspaceDir, 'sidebar-item-groups.json');
  try {
    const window = await electronApp.firstWindow();
    await new CanopyAppDriver(window).waitForShell({ timeout: 30_000 });
    // Wait for initial Code projection and drain its owner read before installing
    // the post-commit fence. Shell chrome can be ready before snapshot hydration.
    await expect(window.getByTestId('worktree-row')).toHaveCount(
      worktreeIds.length,
    );
    await window.evaluate((scope) => window.api.sidebarItemGroups.list(scope), {
      workspaceLocalId: CHATS_SECTION_CODE_WORKSPACE_ID,
    });
    // Stale membership needs lifecycle repair after the new registry row lands.
    writeFileSync(
      sidecar,
      JSON.stringify({
        version: 1,
        groups: [
          {
            id: 'grp-stale',
            name: 'Stale',
            color: 'blue',
            memberIds: ['removed-row'],
            collapsed: false,
          },
        ],
      }),
    );
    writeFileSync(`${sidecar}.e2e-hold`, 'hold');
    await electronApp.evaluate(() => {
      process.env.CANOPY_E2E_SIDEBAR_ITEM_GROUP_HOLD_WRITES = '1';
    });
    const creation = window
      .evaluate((request) => window.api.createWorktree(request), {
        projectId: CHATS_SECTION_CODE_WORKSPACE_ID,
        repoPath: path.join(userDataDir, 'chats-section-repo'),
        existingWorktreeIds: worktreeIds,
        baseBranch: 'main',
        branchName: 'feature/reconciliation-failure',
      })
      .then(
        (value) => ({ value }),
        (error) => ({ error: String(error) }),
      );
    await expect.poll(() => existsSync(`${sidecar}.e2e-entered`)).toBe(true);
    const rows = json(path.join(workspaceDir, 'worktrees.json')).worktrees;
    const created = rows.find((row) => !worktreeIds.includes(row.id));
    expect(created).toBeDefined();
    const metadata = path.join(workspaceDir, 'worktree-data', created.id);
    expect(existsSync(metadata)).toBe(true);
    // Make the real sidecar's atomic replacement fail after the registry commit.
    rmSync(sidecar);
    mkdirSync(sidecar);
    rmSync(`${sidecar}.e2e-hold`);
    const outcome = await creation;
    expect(outcome.error).toBeDefined();
    expect(
      json(path.join(workspaceDir, 'worktrees.json')).worktrees.some(
        (row) => row.id === created.id,
      ),
    ).toBe(true);
    expect(existsSync(metadata)).toBe(true);
  } finally {
    rmSync(`${sidecar}.e2e-hold`, { force: true });
    await closeCanopy(electronApp, userDataDir);
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
