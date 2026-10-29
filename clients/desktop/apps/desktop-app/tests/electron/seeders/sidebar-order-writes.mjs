import { expect } from '@playwright/test';
import { CanopyAppDriver, waitForStableLocator } from '../canopyApp.mjs';

export async function createReadyWorktree(window, workspaceId, branchName) {
  const createdId = await window.evaluate(
    async ({ workspaceId, branchName }) => {
      const loaded = await window.api.loadProjects();
      const project = loaded.items.find((item) => item.id === workspaceId);
      if (!project || project.type === 'cowork') {
        throw new Error(`Expected seeded Code workspace ${workspaceId}`);
      }
      const created = await window.api.createWorktree({
        projectId: workspaceId,
        repoPath: project.repoPath,
        existingWorktreeIds: project.worktrees.map((row) => row.id),
        branchName,
      });
      return created.id;
    },
    { workspaceId, branchName },
  );
  await expect
    .poll(
      () =>
        window.evaluate(
          async ({ workspaceId, createdId }) => {
            const loaded = await window.api.loadProjects();
            const row = loaded.items
              .find((item) => item.id === workspaceId)
              ?.worktrees.find((worktree) => worktree.id === createdId);
            return row ? (row.setupPhase ?? 'git-ready') : 'missing';
          },
          { workspaceId, createdId },
        ),
      { timeout: 30_000 },
    )
    .toBe('git-ready');
  return createdId;
}

// Real sidebar drag followed by an unrelated whole-snapshot settings save.
// Kept separate from captures so the durable flow can exercise both sequences.
export async function exerciseSidebarOrderWrite(window, snapshotFirst = false) {
  const workspaceId = 'demo-ts-pnpm-vite';
  const app = new CanopyAppDriver(window);
  await app.waitForShell({ timeout: 30_000 });
  await window.evaluate(async (workspaceId) => {
    const loaded = await window.api.loadProjects();
    const project = loaded.items.find((item) => item.id === workspaceId);
    if (!project || project.type === 'cowork' || !project.worktrees[0]) {
      throw new Error('Expected seeded Code workspace');
    }
    project.collapsed = false;
    project.itemSortMode = 'manual';
    await window.api.saveProjects(loaded.items);
  }, workspaceId);
  await createReadyWorktree(window, workspaceId, 'feature/order-write-second');
  const staleItems = await window.evaluate(
    async () => (await window.api.loadProjects()).items,
  );
  const staleProject = staleItems.find((item) => item.id === workspaceId);
  const originalIds = staleProject.worktrees.map((row) => row.id);
  expect(originalIds).toHaveLength(2);
  staleProject.name = 'Order snapshot saved';
  const saveSnapshot = async () => {
    await window.evaluate(
      async (items) => window.api.saveProjects(items),
      staleItems,
    );
  };
  if (snapshotFirst) await saveSnapshot();
  await window.reload();
  await app.waitForShell({ timeout: 30_000 });
  const workspace = window.locator(
    `[data-sidebar-workspace-id="${workspaceId}"]`,
  );
  const source = workspace.locator(
    `[data-testid="worktree-row"][data-worktree-id="${originalIds[0]}"]`,
  );
  const target = workspace.locator(
    `[data-testid="worktree-row"][data-worktree-id="${originalIds[1]}"]`,
  );
  await expect(source).toBeVisible();
  await expect(target).toBeVisible();
  const label = source.getByTestId('worktree-row-title');
  await waitForStableLocator(window, label);
  const from = await label.boundingBox();
  const to = await target.boundingBox();
  expect(from).not.toBeNull();
  expect(to).not.toBeNull();
  await window.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await window.mouse.down();
  await window.mouse.move(
    from.x + from.width / 2 + 12,
    from.y + from.height / 2,
    { steps: 4 },
  );
  await expect(
    window.getByTestId('sidebar-item-group-drag-overlay'),
  ).toBeVisible();
  await window.mouse.move(to.x + to.width / 2, to.y + to.height * 0.75, {
    steps: 12,
  });
  await window.mouse.up();
  await expect(
    window.getByTestId('sidebar-item-group-drag-overlay'),
  ).toHaveCount(0);
  const readIds = () =>
    window.evaluate(async (workspaceId) => {
      const loaded = await window.api.loadProjects();
      return loaded.items
        .find((item) => item.id === workspaceId)
        ?.worktrees.map((row) => row.id);
    }, workspaceId);
  const reorderedIds = [...originalIds].reverse();
  await expect.poll(readIds).toEqual(reorderedIds);
  if (!snapshotFirst) await saveSnapshot();
  await window.reload();
  await app.waitForShell({ timeout: 30_000 });
  await expect(workspace).toBeVisible();
  return {
    workspaceId,
    originalIds,
    reorderedIds,
    finalIds: await readIds(),
    workspace,
  };
}
