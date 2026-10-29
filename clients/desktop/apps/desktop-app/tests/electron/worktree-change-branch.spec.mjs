import { execFileSync } from 'node:child_process';
import { expect, test } from '@playwright/test';
import { closeCanopy } from './launchCanopy.mjs';
import { launchWorktreeChangeBranch } from './worktree-change-branch-fixture.mjs';

function currentBranch(worktreePath) {
  return execFileSync('git', ['branch', '--show-current'], {
    cwd: worktreePath,
    encoding: 'utf8',
  }).trim();
}

test('the header branch menu changes the worktree branch through the New Task picker', async () => {
  const f = await launchWorktreeChangeBranch();
  try {
    const header = f.window.getByTestId('pr-status-bar');
    const branchTrigger = header.getByTestId(
      'pr-status-bar-branch-menu-trigger',
    );
    await expect(branchTrigger).toHaveText('New branch');
    const editor = f.window
      .locator('[data-testid="panel-content-chat"] [contenteditable="true"]')
      .first();
    await editor.fill('Keep this draft while changing branches');

    async function openChangeBranch() {
      await branchTrigger.click();
      const menu = f.window.getByTestId('pr-status-bar-branch-menu');
      await expect(menu.getByRole('menuitem')).toHaveText([
        'Rename branch',
        'Change branch',
        /Copy branch name/,
        'Branch info',
      ]);
      await menu.getByTestId('branch-menu-change').click();
      const picker = f.window.getByTestId('pr-status-bar-change-branch-menu');
      await expect(picker).toBeVisible();
      await expect(
        picker.getByTestId('home-branch-picker-search'),
      ).toBeFocused();
      await expect(picker.getByRole('tab')).toHaveText([
        'PRs',
        'Branches',
        'Issues',
      ]);
      return picker;
    }

    let picker = await openChangeBranch();
    await expect(
      picker.getByTestId('home-branch-picker-tab-branches'),
    ).toHaveAttribute('aria-selected', 'true');
    await picker.getByTestId('home-branch-picker-search').fill('source');
    await picker.getByTestId('home-branch-picker-branch-source-branch').click();
    await expect(picker).toBeHidden();
    await expect
      .poll(() => currentBranch(f.worktreePath))
      .toBe('source-branch');
    await expect(branchTrigger).toHaveText('source-branch');
    await expect(editor).toContainText(
      'Keep this draft while changing branches',
    );

    picker = await openChangeBranch();
    await picker.getByTestId('home-branch-picker-tab-issues').click();
    await picker.getByTestId('home-branch-picker-search').fill('CAN-123');
    await picker.getByTestId('home-branch-picker-issue-CAN-123').click();
    await expect
      .poll(() => currentBranch(f.worktreePath))
      .toBe('fixture/linear');
    await expect(branchTrigger).toHaveText('fixture/linear');

    picker = await openChangeBranch();
    await picker.getByTestId('home-branch-picker-tab-prs').click();
    await picker.getByTestId('home-branch-picker-pr-42').click();
    await expect.poll(() => currentBranch(f.worktreePath)).toBe('pr-source');
    await expect(branchTrigger).toHaveText('pr-source');
    await expect(editor).toContainText(
      'Keep this draft while changing branches',
    );

    await f.window.reload();
    await f.app.waitForShell();
    await f.app.selectWorktree(f.worktreeId);
    await expect(
      f.window
        .getByTestId('pr-status-bar')
        .getByTestId('pr-status-bar-branch-menu-trigger'),
    ).toHaveText('pr-source');
  } finally {
    await closeCanopy(f.electronApp, f.userDataDir);
  }
});
