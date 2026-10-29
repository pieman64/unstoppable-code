// CAN-2659 — semantic stacking tiers and the CAN-2708 stacking regression.
//
// The first test is the durable seeded New Task user flow. The unified
// composer menu must remain inside the work surface instead of crossing the
// sidebar at narrow widths. The remaining checks exercise a real dropdown
// portaled over the Workflows edit shell and its unsaved-changes dialog
// (CAN-4072) plus two isolated global-tier relationships in the real renderer
// CSS. No live agents or network are used.

import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver, discardWorkflowEditIfOpen } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { seedWorktreeChat } from './seeders/index.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const NARROW_VIEWPORT_WIDTHS = [900, 850, 800, 750, 700, 650, 600];
const NARROW_VIEWPORT_HEIGHT = 650;

async function launchSeededWorktree() {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-can2659-'));
  seedDemoWorkspaces({
    userDataDir,
    apps: ['ts-pnpm-vite'],
    checkRuntimes: false,
  });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    tabs: [{ id: 't1', title: 'Chat' }],
  });
  const launched = await launchCanopy({
    userDataDir,
    viewportSize: { width: 1000, height: 700 },
  });
  const window = await launched.electronApp.firstWindow();
  const app = new CanopyAppDriver(window);
  await app.waitForShell({ timeout: 30_000 });
  await app.openMainPage();
  await app.selectWorktree(WORKTREE_ID);
  return { ...launched, window };
}

test('New Task composer menu stays clear of the sidebar at narrow widths', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-can2659-home-'),
  );
  seedDemoWorkspaces({
    userDataDir,
    apps: ['ts-pnpm-vite'],
    checkRuntimes: false,
  });
  const { electronApp } = await launchCanopy({
    userDataDir,
    viewportSize: {
      width: NARROW_VIEWPORT_WIDTHS[0],
      height: NARROW_VIEWPORT_HEIGHT,
    },
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await window.getByTestId('sidebar-create-task').click();

    const homePage = window.getByTestId('page-home');
    await expect(homePage).toBeVisible();
    await homePage.getByTestId('home-composer-plus-button').click();
    const plusMenu = window.getByTestId('home-composer-plus-menu');
    await expect(plusMenu).toBeVisible();

    const sidebar = window.getByTestId('app-sidebar');

    let geometry;
    for (const width of NARROW_VIEWPORT_WIDTHS) {
      await window.setViewportSize({ width, height: NARROW_VIEWPORT_HEIGHT });
      await window.evaluate(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          ),
      );
      geometry = await plusMenu.evaluate(
        (selector, { sidebarElement, viewportWidth }) => {
          const selectorRect = selector.getBoundingClientRect();
          const sidebarRect = sidebarElement.getBoundingClientRect();
          const left = Math.max(selectorRect.left, sidebarRect.left);
          const right = Math.min(selectorRect.right, sidebarRect.right);
          const top = Math.max(selectorRect.top, sidebarRect.top);
          const bottom = Math.min(selectorRect.bottom, sidebarRect.bottom);
          const overlaps = right > left && bottom > top;
          const point = overlaps
            ? { x: (left + right) / 2, y: (top + bottom) / 2 }
            : null;
          const painted = point
            ? document.elementFromPoint(point.x, point.y)
            : null;
          return {
            viewport: { width: viewportWidth, height: window.innerHeight },
            selectorRect: selectorRect.toJSON(),
            sidebarRect: sidebarRect.toJSON(),
            overlaps,
            point,
            wins: painted !== null && selector.contains(painted),
          };
        },
        {
          sidebarElement: await sidebar.elementHandle(),
          viewportWidth: width,
        },
      );
      expect(
        geometry.overlaps,
        `Composer menu overlapped the sidebar: ${JSON.stringify(geometry)}`,
      ).toBe(false);
      expect(geometry.selectorRect.left).toBeGreaterThanOrEqual(0);
      expect(geometry.selectorRect.top).toBeGreaterThanOrEqual(0);
      expect(geometry.selectorRect.right).toBeLessThanOrEqual(
        geometry.viewport.width,
      );
      expect(geometry.selectorRect.bottom).toBeLessThanOrEqual(
        geometry.viewport.height,
      );
    }

    // PR #3459 replaced the overlapping nested CommandsPopup with the unified
    // composer menu. Keep the narrow-width user flow pinned to that stronger
    // invariant; the nested-overlay tests below still own z-tier coverage.
    expect(geometry).toBeDefined();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('the prompt Add menu paints over the edit shell and yields to the unsaved-changes dialog', async () => {
  const { electronApp, userDataDir, window } = await launchSeededWorktree();
  try {
    const app = new CanopyAppDriver(window);
    await app.openAutomationsPage();
    await app.startNewWorkflow('schedule');

    // CAN-4072: the automation form is a section of the full-page Workflows
    // edit shell, not a modal. PR #3899 folded variable insertion into the
    // prompt composer's Add menu, which is the dropdown portaled over it.
    const shell = window.getByTestId('workflow-edit-shell');
    await expect(shell).toBeVisible();
    const definition = shell.getByTestId('workflow-edit-section-definition');
    await definition
      .getByTestId('automations-form-name')
      .fill('Stacking tiers check');
    // A draft's save state stays "new"; the edited name is what Back asks
    // about.
    await expect(shell).toHaveAttribute('aria-label', 'Stacking tiers check');
    await definition.getByTestId('automations-form-prompt-plus-button').click();

    const menu = window.getByTestId('automations-form-prompt-plus-menu');
    await expect(menu).toBeVisible();
    await expect(menu).toHaveClass(/\bcanopy-floating-menu\b/);

    const overShell = await menu.evaluate(
      (menuElement, shellElement) => {
        const menuRect = menuElement.getBoundingClientRect();
        const shellRect = shellElement.getBoundingClientRect();
        const point = {
          x: menuRect.left + menuRect.width / 2,
          y: menuRect.top + menuRect.height / 2,
        };
        const hit = document.elementFromPoint(point.x, point.y);
        return {
          overlapsShell:
            point.x >= shellRect.left &&
            point.x <= shellRect.right &&
            point.y >= shellRect.top &&
            point.y <= shellRect.bottom,
          portaled: !shellElement.contains(menuElement),
          wins: hit !== null && menuElement.contains(hit),
        };
      },
      await shell.elementHandle(),
    );
    expect(overShell.overlapsShell).toBe(true);
    expect(overShell.portaled).toBe(true);
    expect(overShell.wins).toBe(true);

    // Leaving with the edit asks. The dialog takes the modal tier: the menu
    // is gone and the dialog paints over the shell.
    await window.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await shell.getByTestId('workflow-edit-back').click();
    const dialog = window.getByTestId('workflows-unsaved-dialog');
    await expect(dialog).toBeVisible();
    await expect(menu).toBeHidden();
    const overDialog = await dialog.evaluate((dialogElement) => {
      const rect = dialogElement.getBoundingClientRect();
      const hit = document.elementFromPoint(
        rect.left + rect.width / 2,
        rect.top + rect.height / 2,
      );
      let tier = dialogElement;
      while (tier && getComputedStyle(tier).position !== 'fixed') {
        tier = tier.parentElement;
      }
      return {
        wins: hit !== null && dialogElement.contains(hit),
        dialogZ: tier ? Number(getComputedStyle(tier).zIndex) : null,
      };
    });
    expect(overDialog.wins).toBe(true);
    expect(overDialog.dialogZ).toBeGreaterThan(0);

    await window.getByTestId('workflows-unsaved-discard').click();
    await expect(dialog).toBeHidden();
    await expect(shell).toBeHidden();
  } finally {
    await discardWorkflowEditIfOpen(electronApp);
    await closeCanopy(electronApp, userDataDir);
  }
});

for (const relationship of [
  { name: 'tooltip over drawer', lower: 'z-drawer', upper: 'z-tooltip' },
  { name: 'toast over modal', lower: 'z-modal', upper: 'z-toast' },
]) {
  test(`${relationship.name} preserves its paint order`, async () => {
    const { electronApp, userDataDir, window } = await launchSeededWorktree();
    try {
      const result = await window.evaluate(({ lower, upper }) => {
        const lowerNode = document.createElement('div');
        lowerNode.className = `fixed ${lower}`;
        Object.assign(lowerNode.style, {
          left: '80px',
          top: '80px',
          width: '96px',
          height: '96px',
        });
        lowerNode.dataset.testid = 'stacking-lower';
        const upperNode = document.createElement('div');
        upperNode.className = `fixed ${upper}`;
        Object.assign(upperNode.style, {
          left: '96px',
          top: '96px',
          width: '64px',
          height: '64px',
        });
        upperNode.dataset.testid = 'stacking-upper';
        document.body.appendChild(lowerNode);
        document.body.appendChild(upperNode);
        const lowerZ = Number(getComputedStyle(lowerNode).zIndex);
        const upperZ = Number(getComputedStyle(upperNode).zIndex);
        const hit = document.elementFromPoint(112, 112);
        const wins = hit === upperNode || upperNode.contains(hit);
        lowerNode.remove();
        upperNode.remove();
        return { lowerZ, upperZ, wins };
      }, relationship);
      expect(result.lowerZ).toBeGreaterThan(0);
      expect(result.upperZ).toBeGreaterThan(0);
      expect(result.wins).toBe(true);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
}
