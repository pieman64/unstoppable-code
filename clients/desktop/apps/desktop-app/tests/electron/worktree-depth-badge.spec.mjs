import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { writeJson } from './seeders/fsHelpers.mjs';

function git(cwd, args) {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

test.describe('worktree grouping controls', () => {
  async function verifyGroupingFlow(sharedRail) {
    test.setTimeout(180_000);

    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-depth-badge-'),
    );
    const fixtureDir = mkdtempSync(path.join(os.tmpdir(), 'depth-fixture-'));
    const sourceRepoPath = path.join(fixtureDir, 'source');
    const workspaceId = 'depth-test';

    // Build a source repo with a base-branch chain wt-base -> wt-child ->
    // wt-grandchild, plus wt-sibling also based on wt-base. Each is a real
    // git worktree.
    mkdirSync(sourceRepoPath, { recursive: true });
    git(sourceRepoPath, ['init']);
    git(sourceRepoPath, ['config', 'user.email', 'test@example.com']);
    git(sourceRepoPath, ['config', 'user.name', 'Canopy Test']);
    writeJson(path.join(sourceRepoPath, 'canopy.json'), {
      version: 1,
      scripts: {},
      repos: [],
    });
    git(sourceRepoPath, ['add', 'canopy.json']);
    git(sourceRepoPath, ['commit', '-m', 'initial']);

    const workspaceDir = path.join(userDataDir, 'workspaces', workspaceId);
    let parentRef = 'HEAD';
    for (const id of ['wt-base', 'wt-child', 'wt-grandchild']) {
      const worktreePath = path.join(workspaceDir, 'worktrees', id);
      mkdirSync(path.dirname(worktreePath), { recursive: true });
      git(sourceRepoPath, [
        'worktree',
        'add',
        '-b',
        id,
        worktreePath,
        parentRef,
      ]);
      writeFileSync(
        path.join(worktreePath, `${id}.txt`),
        `${id} ancestry marker\n`,
        'utf8',
      );
      git(worktreePath, ['add', `${id}.txt`]);
      git(worktreePath, ['commit', '-m', `add ${id} marker`]);
      parentRef = id;
    }
    const siblingPath = path.join(workspaceDir, 'worktrees', 'wt-sibling');
    git(sourceRepoPath, [
      'worktree',
      'add',
      '-b',
      'wt-sibling',
      siblingPath,
      'wt-base',
    ]);
    writeFileSync(
      path.join(siblingPath, 'wt-sibling.txt'),
      'wt-sibling ancestry marker\n',
      'utf8',
    );
    git(siblingPath, ['add', 'wt-sibling.txt']);
    git(siblingPath, ['commit', '-m', 'add wt-sibling marker']);

    writeJson(path.join(userDataDir, 'workspaces', 'index.json'), {
      version: 1,
      workspaces: [
        {
          id: workspaceId,
          name: 'Depth Test',
          type: 'multi-repo',
          color: '#38bdf8',
          collapsed: false,
          order: 0,
        },
      ],
    });

    writeJson(path.join(workspaceDir, 'workspace.json'), {
      version: 1,
      type: 'multi-repo',
      repos: [],
      sourceRepoPath,
      alwaysShow: true,
    });

    // Multi-repo Git refresh resolves the root through its per-repository map.
    // Seed the same ancestry there as in the initial sidebar projection.
    writeJson(path.join(workspaceDir, 'worktrees.json'), {
      version: 1,
      worktrees: [
        {
          id: 'wt-base',
          branchName: 'wt-base',
          createdAt: '2026-05-14T00:00:00.000Z',
        },
        {
          id: 'wt-child',
          branchName: 'wt-child',
          createdAt: '2026-05-14T00:00:01.000Z',
          trackedBaseBranch: 'wt-base',
          trackedRepoBaseBranches: { __workspace_root__: 'wt-base' },
          branchGroupingParentWorktreeId: 'wt-base',
        },
        {
          id: 'wt-sibling',
          branchName: 'wt-sibling',
          createdAt: '2026-05-14T00:00:01.500Z',
          trackedBaseBranch: 'wt-base',
          trackedRepoBaseBranches: { __workspace_root__: 'wt-base' },
          branchGroupingParentWorktreeId: 'wt-base',
        },
        {
          id: 'wt-grandchild',
          branchName: 'wt-grandchild',
          createdAt: '2026-05-14T00:00:02.000Z',
          trackedBaseBranch: 'wt-child',
          trackedRepoBaseBranches: { __workspace_root__: 'wt-child' },
          branchGroupingParentWorktreeId: 'wt-child',
        },
      ],
    });

    const { electronApp } = await launchCanopy({ userDataDir });

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);

      await app.waitForShell({ timeout: 30_000 });
      await window.evaluate((enabled) => {
        localStorage.setItem(
          'canopy.desktop.sharedSidebar',
          enabled ? '1' : '0',
        );
      }, sharedRail);
      await window.reload();
      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();

      const openWorktreeActions = async (row) => {
        await row.getByTestId('worktree-actions-menu-button').click();
        await expect(window.getByRole('menu').first()).toBeVisible();
        const more = window.getByTestId('worktree-actions-menu-more');
        // The rails can expose either the compact or the flat action menu.
        if (await more.isVisible()) await more.click();
      };

      const childRow = window.locator(
        '[data-testid="worktree-row"][data-branch="wt-child"]',
      );
      await expect(childRow).toBeVisible();
      await expect(
        childRow.getByTestId('worktree-row-depth-badge'),
      ).toHaveCount(0);

      const grandchildRow = window.locator(
        '[data-testid="worktree-row"][data-branch="wt-grandchild"]',
      );
      await expect(grandchildRow).toBeVisible();
      await expect(
        grandchildRow.getByTestId('worktree-row-depth-badge'),
      ).toHaveCount(0);
      const siblingRow = window.locator(
        '[data-testid="worktree-row"][data-branch="wt-sibling"]',
      );
      await expect(siblingRow).toBeVisible();
      await expect(
        siblingRow.getByTestId('worktree-row-depth-badge'),
      ).toHaveCount(0);

      const baseRow = window.locator(
        '[data-testid="worktree-row"][data-branch="wt-base"]',
      );
      await expect(baseRow).toBeVisible();
      await expect(baseRow.getByTestId('worktree-row-depth-badge')).toHaveCount(
        0,
      );
      const groupedChildren = window.getByTestId(
        'worktree-branch-group-children',
      );
      await expect(groupedChildren).toHaveAttribute(
        'data-parent-worktree-id',
        'wt-base',
      );
      await expect(
        groupedChildren.getByTestId('worktree-nesting-rail'),
      ).toHaveCount(3);
      const groupedDepthTrigger = childRow.getByTestId(
        'worktree-row-nested-child-depth',
      );
      await expect(groupedDepthTrigger).toHaveText('1');
      await expect(groupedDepthTrigger).toHaveAttribute('data-depth', '1');
      const siblingDepthTrigger = siblingRow.getByTestId(
        'worktree-row-nested-child-depth',
      );
      await expect(siblingDepthTrigger).toHaveText('1');
      await expect(siblingDepthTrigger).toHaveAttribute('data-depth', '1');
      const grandchildDepthTrigger = grandchildRow.getByTestId(
        'worktree-row-nested-child-depth',
      );
      await expect(grandchildDepthTrigger).toHaveText('2');
      await expect(grandchildDepthTrigger).toHaveAttribute('data-depth', '2');
      const groupedDepthTriggerBox = await groupedDepthTrigger.boundingBox();
      expect(groupedDepthTriggerBox).not.toBeNull();
      expect(groupedDepthTriggerBox.width).toBeGreaterThanOrEqual(24);
      expect(groupedDepthTriggerBox.height).toBe(16);
      await groupedDepthTrigger.hover({
        position: {
          x: groupedDepthTriggerBox.width - 1,
          y: groupedDepthTriggerBox.height / 2,
        },
      });
      const groupedDepthTooltip = window.getByRole('tooltip');
      await expect(groupedDepthTooltip).toContainText(
        'Depth 1 under the top-most parent',
      );
      await expect(groupedDepthTooltip).toContainText(
        'Top-most parent: wt-base (wt-base)',
      );
      await childRow.hover();
      await expect(
        childRow.getByTestId('worktree-actions-menu-button'),
      ).toBeVisible();

      const worktreeRows = window.locator('[data-testid="worktree-row"]');
      const rowBranches = async () =>
        worktreeRows.evaluateAll((rows) =>
          rows.map((row) => row.getAttribute('data-branch')),
        );
      await expect
        .poll(rowBranches)
        .toEqual(['wt-base', 'wt-child', 'wt-sibling', 'wt-grandchild']);

      await openWorktreeActions(childRow);
      const childGrouping = window.getByTestId(
        'worktree-actions-menu-toggle-grouping',
      );
      await expect(childGrouping).toHaveText('Unstack from base');
      const unstackBaseGlyph = await childGrouping.locator('svg').innerHTML();
      await window.keyboard.press('Escape');
      await window.keyboard.press('Escape');
      await baseRow.hover();
      await openWorktreeActions(baseRow);
      const toggleGrouping = window.getByTestId(
        'worktree-actions-menu-toggle-grouping',
      );
      await expect(toggleGrouping).toHaveText('Unstack children');
      expect(await toggleGrouping.locator('svg').innerHTML()).not.toBe(
        unstackBaseGlyph,
      );
      await toggleGrouping.click();

      await expect(groupedChildren).toHaveCount(0);
      await expect
        .poll(rowBranches)
        .toEqual(['wt-base', 'wt-child', 'wt-sibling', 'wt-grandchild']);

      const worktreesFilePath = path.join(workspaceDir, 'worktrees.json');
      await expect
        .poll(() => {
          const persisted = JSON.parse(readFileSync(worktreesFilePath, 'utf8'));
          return persisted.worktrees.map((worktree) => ({
            id: worktree.id,
            override: worktree.branchGroupingOverride,
          }));
        })
        .toEqual([
          { id: 'wt-base', override: undefined },
          { id: 'wt-child', override: 'ungroup' },
          { id: 'wt-sibling', override: 'ungroup' },
          { id: 'wt-grandchild', override: 'ungroup' },
        ]);

      const childDepthBadge = childRow.getByTestId('worktree-row-depth-badge');
      await expect(childDepthBadge).toHaveAttribute('data-depth', '1');
      const depthTriggerBox = await childDepthBadge.boundingBox();
      expect(depthTriggerBox).not.toBeNull();
      expect(depthTriggerBox.width).toBeGreaterThanOrEqual(24);
      expect(depthTriggerBox.height).toBe(16);
      const identityBox = await childRow
        .getByTestId('worktree-row-subtitle')
        .evaluate((subtitle) => {
          const walker = document.createTreeWalker(
            subtitle,
            NodeFilter.SHOW_TEXT,
          );
          let textNode = walker.nextNode();
          while (textNode) {
            if (textNode.textContent?.trim() === 'wt-child') {
              const range = document.createRange();
              range.selectNodeContents(textNode);
              const rect = range.getBoundingClientRect();
              return {
                x: rect.x,
                y: rect.y,
                width: rect.width,
                height: rect.height,
              };
            }
            textNode = walker.nextNode();
          }
          return null;
        });
      expect(identityBox).not.toBeNull();
      expect(depthTriggerBox.x + depthTriggerBox.width).toBeLessThanOrEqual(
        identityBox.x,
      );
      await childDepthBadge.hover({
        position: {
          x: depthTriggerBox.width - 1,
          y: depthTriggerBox.height / 2,
        },
      });
      const depthTooltip = window.getByRole('tooltip');
      await expect(depthTooltip).toContainText(
        'Depth 1 under the top-most parent',
      );
      await expect(depthTooltip).toContainText(
        'Top-most parent: wt-base (wt-base)',
      );
      await childRow.hover();
      await expect(
        childRow.getByTestId('worktree-actions-menu-button'),
      ).toBeVisible();
      await openWorktreeActions(childRow);
      await expect(
        window.getByTestId('worktree-actions-menu-toggle-grouping').last(),
      ).toBeVisible();
      await window.keyboard.press('Escape');
      await window.keyboard.press('Escape');

      await baseRow.hover();
      await openWorktreeActions(baseRow);
      const regroupAction = window
        .getByTestId('worktree-actions-menu-toggle-grouping')
        .last();
      await expect(regroupAction).toHaveText('Stack children');
      await regroupAction.click();

      await expect(groupedChildren).toHaveAttribute(
        'data-parent-worktree-id',
        'wt-base',
      );
      await expect
        .poll(rowBranches)
        .toEqual(['wt-base', 'wt-child', 'wt-sibling', 'wt-grandchild']);

      await baseRow.hover();
      await openWorktreeActions(baseRow);
      await window.getByTestId('worktree-actions-menu-toggle-hidden').click();

      await expect
        .poll(rowBranches)
        .toEqual(['wt-child', 'wt-grandchild', 'wt-sibling']);
      await expect(grandchildDepthTrigger).toHaveText('2');
      await expect(grandchildDepthTrigger).toHaveAttribute('data-depth', '2');
    } finally {
      await closeCanopy(electronApp, userDataDir);
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  }

  for (const sharedRail of [false, true]) {
    test(`groups and ungroups descendants without changing their order (${sharedRail ? 'shared' : 'fallback'} rail)`, async () => {
      await verifyGroupingFlow(sharedRail);
    });
  }
});
