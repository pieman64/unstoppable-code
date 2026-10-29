import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

// dzzzgnr/header-chat-opened — workspace header (chat opened) redesign.
//
// The worktree header became a clickable breadcrumb (`[project icon] ›
// branch › base branch`): the project button opens project settings, the
// branch pill opens an actions menu (Rename / Copy / Branch info) and
// double-click flips the pill into an inline rename input, and the whole bar
// moved to the 46px `bg-secondary` chrome row shared with the panel tab
// strip below it. The tab strip's controls (add tab, add panel, group menu)
// all ride the shared 28px TitlebarIconButton frame.
//
// This spec seeds one demo worktree (no live agents, no network — all state
// comes from `seedDemoWorkspaces`), walks the realistic flow (open worktree →
// click breadcrumb → open branch menu → enter/leave inline rename), asserts
// the durable geometry contracts. The one-shot capture wrapper and delivered
// feature artifacts were removed after their review handoff.

const WORKTREE_BRANCH = 'demo-main';

export async function runHeaderChatOpenedRedesignScenario() {
  test.setTimeout(240_000);

  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-electron-header-redesign-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);

    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_BRANCH);
    await expect(window.getByTestId('panel-content-chat')).toBeVisible();

    const statusBar = window.getByTestId('pr-status-bar');
    await expect(statusBar).toBeVisible({ timeout: 15_000 });

    const groupTitle = window
      .locator('[data-testid^="panel-group-title-"]')
      .first();
    await expect(groupTitle).toBeVisible();

    // --- Header geometry: the 46px chrome row shared with the tab strip.
    const statusBarBox = await statusBar.boundingBox();
    expect(statusBarBox?.height ?? 0).toBeGreaterThanOrEqual(46);
    const groupTitleBox = await groupTitle.boundingBox();
    expect(groupTitleBox?.height ?? 0).toBeGreaterThanOrEqual(46);

    // --- Breadcrumb: project button + branch pill are discrete controls.
    await expect(
      window.getByTestId('pr-status-bar-project-button'),
    ).toBeVisible();
    const branchTrigger = window.getByTestId(
      'pr-status-bar-branch-menu-trigger',
    );
    await expect(branchTrigger).toBeVisible();
    // The pill renders the resolved display label (worktree title fallback
    // for un-renamed demo worktrees), so assert presence rather than a
    // hard-coded branch string.
    await expect(branchTrigger).not.toHaveText('');

    // --- Hovering the pill reveals the quick copy INSIDE the pill (the
    //     wrapper is the pill face), inset an equal 2px from its top,
    //     bottom, and right edge, with the nested 6px radius (8px pill −
    //     2px inset).
    const pillRestBox = await branchTrigger.locator('xpath=..').boundingBox();
    await branchTrigger.hover();
    const copyButton = window.getByTestId('pr-status-bar-branch-copy');
    await expect(copyButton).toBeVisible();
    const pillBox = await branchTrigger.locator('xpath=..').boundingBox();
    // The wrapper locks its rest width for the hover: the label yields the
    // button's space (real ellipsis), the pill never grows.
    expect(Math.abs(pillBox.width - pillRestBox.width)).toBeLessThan(1);
    const copyBox = await copyButton.boundingBox();
    expect(copyBox.y - pillBox.y).toBeCloseTo(2, 0);
    expect(
      pillBox.y + pillBox.height - (copyBox.y + copyBox.height),
    ).toBeCloseTo(2, 0);
    expect(pillBox.x + pillBox.width - (copyBox.x + copyBox.width)).toBeCloseTo(
      2,
      0,
    );
    await expect(copyButton).toHaveCSS('border-radius', '6px');
    // Text-to-copy gap: the trigger's hover pr is exactly 4px, and the
    // truncated label's box runs to the trigger's padding edge.
    const labelBox = await branchTrigger.locator('span[title]').boundingBox();
    expect(copyBox.x - (labelBox.x + labelBox.width)).toBeCloseTo(4, 0);
    await window.mouse.move(4, 4);
    await expect(copyButton).toBeHidden();
    await window.waitForTimeout(200);

    // --- Click opens the branch actions menu.
    await window.waitForTimeout(300);
    await branchTrigger.click();
    const branchMenu = window.locator('.canopy-floating-menu');
    await expect(branchMenu).toBeVisible();
    await expect(branchMenu).toContainText('Rename branch');
    await expect(branchMenu).toContainText('Copy branch name');
    await expect(branchMenu).toContainText('Branch info');

    // --- Copying swaps the item label to "Copied" (the menu stays open for
    //     the confirmation) WITHOUT the menu changing width: an invisible
    //     copy of the longer label reserves the cell.
    // The floating menu animates open (scale), so poll until its box is
    // stable before taking the reference width — a mid-animation read
    // undershoots by a few px and would blame the label swap for it.
    let menuRestWidth = 0;
    await expect
      .poll(async () => {
        const next = (await branchMenu.boundingBox()).width;
        const stable = Math.abs(next - menuRestWidth) < 0.5;
        menuRestWidth = next;
        return stable;
      })
      .toBe(true);
    await window.getByTestId('branch-menu-copy').click();
    await expect(branchMenu).toContainText('Copied');
    await window.waitForTimeout(250);
    const menuCopiedBox = await branchMenu.boundingBox();
    expect(Math.abs(menuCopiedBox.width - menuRestWidth)).toBeLessThan(1);
    await window.waitForTimeout(300);
    await window.keyboard.press('Escape');
    await expect(branchMenu).toBeHidden();

    // --- The menu's "Rename branch" flips the pill into the inline rename
    //     input; Escape restores the pill without renaming. (The former
    //     double-click shortcut was cut on review: renaming a branch must
    //     go through a deliberate, labelled action.)
    await window.waitForTimeout(300);
    await branchTrigger.click();
    await expect(branchMenu).toBeVisible();
    await window.getByTestId('branch-menu-rename').click();
    const renameInput = window.getByTestId('pr-status-bar-branch-rename-input');
    await expect(renameInput).toBeVisible();
    // Seeded with the RAW branch label (not the display title) — a
    // non-empty value proves the menu flow armed the input.
    await expect(renameInput).not.toHaveValue('');
    await window.keyboard.press('Escape');
    await expect(renameInput).toBeHidden();
    await expect(branchTrigger).toBeVisible();

    // --- Tab strip: every trailing control on the shared 28px frame.
    for (const prefix of [
      'panel-add-tab-',
      'panel-add-panel-',
      'panel-group-menu-',
    ]) {
      const control = groupTitle.locator(`[data-testid^="${prefix}"]`).first();
      await expect(control).toBeVisible();
      const box = await control.boundingBox();
      expect(box?.width, `${prefix} width`).toBe(28);
      expect(box?.height, `${prefix} height`).toBe(28);
    }

    // --- Layout ••• menu: "Reset layout" was removed on review (too
    //     destructive to sit one mis-click from "Save layout as default"),
    //     so the menu must expose ONLY the save item.
    await window.getByTestId('worktree-top-save-layout-default').click();
    const layoutMenu = window.getByTestId('save-layout-default-menu');
    await expect(layoutMenu).toBeVisible();
    await expect(
      layoutMenu.getByTestId('save-layout-default-item'),
    ).toBeVisible();
    await expect(layoutMenu.getByTestId('reset-layout-item')).toHaveCount(0);
    await window.keyboard.press('Escape');
    await expect(layoutMenu).toBeHidden();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
}
