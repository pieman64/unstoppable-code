import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver, waitForStableLocator } from './canopyApp.mjs';
import { launchCanopyWithLabsPagesOffered } from './helpers/labsPages.mjs';
import { closeCanopy } from './launchCanopy.mjs';
import { writeJson } from './seeders/index.mjs';

function seedPinnedEmptyWorkEntry(userDataDir) {
  const workspaceId = 'pinned-empty-cowork';
  const workspaceDir = path.join(userDataDir, 'workspaces', workspaceId);
  const createdAt = '2026-09-01T12:00:00.000Z';

  writeJson(path.join(userDataDir, 'workspaces', 'index.json'), {
    version: 1,
    workspaces: [
      {
        id: workspaceId,
        name: 'Pinned Empty Workspace',
        type: 'cowork',
        color: '#7C9B6D',
        collapsed: false,
        order: 0,
        cowork: { createdAt, archiveRetentionDays: null },
      },
    ],
  });
  writeJson(path.join(workspaceDir, 'workspace.json'), {
    version: 1,
    type: 'cowork',
    repos: [],
    cowork: {
      createdAt,
      defaultModel: 'gpt-6-luna',
      searchIndexingEnabled: true,
      archiveRetentionDays: null,
    },
  });
  writeJson(path.join(workspaceDir, 'work-entries.json'), {
    version: 1,
    entries: [
      {
        id: 'empty-pinned',
        pinned: true,
        title: 'Pinned empty entry',
        createdAt,
      },
    ],
  });

  return { workspaceId };
}

// A sidebar row's hover actions are revealed by `group-hover` AND
// `group-focus-within`. Opening the row's ••• menu moves focus INTO the
// trigger, so the whole cluster stayed lit for as long as the menu was up —
// duplicated affordances beside a menu that already identifies its row.
// Opening the menu now hides the actions; the trigger stays mounted as the
// menu's anchor.
test('a row hides its hover actions while its menu is open', async () => {
  const { electronApp, userDataDir } = await launchCanopyWithLabsPagesOffered({
    seedDemoWorkspaces: true,
    demoWorkspaceApps: ['ts-yarn-cli'],
  });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();

    // This fixture seeds one project so the locator cannot retarget while the
    // larger first-wave project list finishes sorting during startup.
    const row = window.locator(
      '[data-testid="worktree-row"][data-worktree-id="demo-main"]',
    );
    await expect(row).toBeVisible();
    // Initial project/git hydration can replace the in-flow row after the
    // shell becomes interactive. Start the menu flow only on the settled row
    // so that a startup remount cannot close the menu between assertions.
    await waitForStableLocator(window, row);
    await row.hover();

    const chip = row.getByTestId('worktree-row-action-chip');
    const chipOpacity = async () =>
      chip.evaluate((node) => getComputedStyle(node).opacity);

    // Hovered with no menu: the actions are revealed.
    await expect.poll(chipOpacity).toBe('1');

    // Opened with the keyboard on purpose. Mouse activation of this menu is
    // unreliable in the harness on develop — a plain click leaves
    // `aria-expanded` false 3 runs out of 3 with no changes applied at all —
    // so clicking here would test the fixture's flakiness, not this behaviour.
    const menuButton = row.getByTestId('worktree-actions-menu-button').first();
    await menuButton.focus();
    await window.keyboard.press('Enter');
    await expect(menuButton).toHaveAttribute('aria-expanded', 'true');
    await expect(window.getByTestId('worktree-actions-menu')).toBeVisible();

    // Menu open: hidden, even though the trigger holds focus and the pointer
    // may still be over the row.
    await expect.poll(chipOpacity).toBe('0');
    // ...and still mounted, so the portalled menu keeps its anchor.
    await expect(menuButton).toHaveCount(1);

    await window.keyboard.press('Escape');
    await expect(menuButton).toHaveAttribute('aria-expanded', 'false');

    // Dismissed: revealable again while hovered.
    await row.hover();
    await expect.poll(chipOpacity).toBe('1');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

// CAN-1074: pin/unpin lives in the row's ••• menu and persists, so the label
// flips on reopen rather than resetting to the unpinned wording.
test('a worktree row can be pinned and unpinned from its menu', async () => {
  const { electronApp, userDataDir } = await launchCanopyWithLabsPagesOffered({
    seedDemoWorkspaces: true,
    demoWorkspaceApps: ['ts-yarn-cli'],
  });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();

    const row = window.locator(
      '[data-testid="worktree-row"][data-worktree-id="demo-main"]',
    );
    await expect(row).toBeVisible();
    await waitForStableLocator(window, row);
    await row.hover();

    const menuButton = row.getByTestId('worktree-actions-menu-button').first();
    const pinItem = window.getByTestId('worktree-actions-menu-toggle-pin');

    // Keyboard activation for the same reason the test above uses it: mouse
    // activation of this trigger is unreliable in the harness.
    const openMenu = async () => {
      await menuButton.focus();
      await window.keyboard.press('Enter');
      await expect(menuButton).toHaveAttribute('aria-expanded', 'true');
      await expect(pinItem).toBeVisible();
    };

    await openMenu();
    await expect(pinItem).toHaveText('Pin to top');
    await pinItem.click();
    await expect(pinItem).toBeHidden();

    // Reopened: the pin round-tripped through main, so the action inverts.
    await row.hover();
    await openMenu();
    await expect(pinItem).toHaveText('Unpin');

    await pinItem.click();
    await expect(pinItem).toBeHidden();

    await row.hover();
    await openMenu();
    await expect(pinItem).toHaveText('Pin to top');

    await window.keyboard.press('Escape');
    await expect(menuButton).toHaveAttribute('aria-expanded', 'false');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

// CAN-1074: a failed optimistic pin must roll back even when another project
// update replaces the project array while the write is in flight.
test('a rejected worktree pin rolls back across a concurrent project update', async () => {
  const { electronApp, userDataDir, demoSeed } =
    await launchCanopyWithLabsPagesOffered({
      seedDemoWorkspaces: true,
      demoWorkspaceApps: ['ts-yarn-cli'],
    });

  try {
    const workspace = demoSeed.workspaces[0];
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();

    const row = window.locator(
      '[data-testid="worktree-row"][data-worktree-id="demo-main"]',
    );
    await expect(row).toBeVisible();
    await waitForStableLocator(window, row);

    await electronApp.evaluate(({ ipcMain }) => {
      const pinChannel = 'worktree:set-pinned';
      if (typeof ipcMain._invokeHandlers.get(pinChannel) !== 'function') {
        throw new Error('Expected worktree pin handler to be registered');
      }
      ipcMain.removeHandler(pinChannel);
      ipcMain.handle(
        pinChannel,
        () =>
          new Promise((_resolve, reject) => {
            globalThis.__rejectPendingWorktreePin = () => {
              reject(new Error('Injected pin persistence failure'));
              delete globalThis.__rejectPendingWorktreePin;
            };
          }),
      );
    });

    const menuButton = row.getByTestId('worktree-actions-menu-button').first();
    const pinItem = window.getByTestId('worktree-actions-menu-toggle-pin');
    await row.hover();
    await menuButton.focus();
    await window.keyboard.press('Enter');
    await expect(pinItem).toHaveText('Pin to top');
    await pinItem.click();
    await expect(pinItem).toBeHidden();

    await expect
      .poll(() =>
        electronApp.evaluate(
          () => typeof globalThis.__rejectPendingWorktreePin,
        ),
      )
      .toBe('function');
    const header = window.getByTestId(`sidebar-project-header-${workspace.id}`);
    await header.getByRole('button', { name: /Collapse/ }).click();
    await expect(row).toBeHidden();
    await electronApp.evaluate(() => {
      globalThis.__rejectPendingWorktreePin?.();
    });
    await expect(window.getByText('Failed to pin')).toBeVisible();
    await header.getByRole('button', { name: /Expand/ }).click();
    await expect(row).toBeVisible();

    await row.hover();
    await menuButton.focus();
    await window.keyboard.press('Enter');
    await expect(pinItem).toHaveText('Pin to top');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

// CAN-1074: branch grouping must not reattach a pinned child beneath its
// unpinned base. The real create flow supplies the retained parent metadata
// that exposed this interaction in review.
test('a pinned grouped child leads its workspace section', async () => {
  const { electronApp, userDataDir, demoSeed } =
    await launchCanopyWithLabsPagesOffered({
      seedDemoWorkspaces: true,
      demoWorkspaceApps: ['ts-yarn-cli'],
    });

  try {
    const workspace = demoSeed.workspaces[0];
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();

    const child = await window.evaluate(
      (request) => window.api.createWorktree(request),
      {
        projectId: workspace.id,
        repoPath: workspace.repoPath,
        existingWorktreeIds: ['demo-main'],
        baseWorktreeId: 'demo-main',
        branchName: 'feature/pinned-child',
      },
    );
    const childRow = window.locator(
      `[data-testid="worktree-row"][data-worktree-id="${child.id}"]`,
    );
    await expect(childRow).toBeVisible({ timeout: 30_000 });
    await expect(
      window.locator(
        `[data-testid="worktree-branch-group-child"][data-child-worktree-id="${child.id}"]`,
      ),
    ).toHaveCount(1);

    await childRow.hover();
    const menuButton = childRow
      .getByTestId('worktree-actions-menu-button')
      .first();
    await menuButton.focus();
    await window.keyboard.press('Enter');
    const pinItem = window.getByTestId('worktree-actions-menu-toggle-pin');
    await expect(pinItem).toHaveText('Pin to top');
    await pinItem.click();

    const rows = window.locator('[data-testid="worktree-row"]');
    await expect(rows.first()).toHaveAttribute('data-worktree-id', child.id);
    await expect(
      window.locator(
        `[data-testid="worktree-branch-group-child"][data-child-worktree-id="${child.id}"]`,
      ),
    ).toHaveCount(0);

    await childRow.hover();
    await menuButton.focus();
    await window.keyboard.press('Enter');
    await expect(
      window.getByTestId('worktree-actions-menu-toggle-grouping'),
    ).toHaveText('Unstack from base');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

// CAN-1074: branch grouping cannot interleave an unpinned child into the
// leading pinned group when its base and another top-level peer are pinned.
test('all pinned worktrees lead an unpinned grouped child', async () => {
  const { electronApp, userDataDir, demoSeed } =
    await launchCanopyWithLabsPagesOffered({
      seedDemoWorkspaces: true,
      demoWorkspaceApps: ['ts-yarn-cli'],
    });

  try {
    const workspace = demoSeed.workspaces[0];
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();

    const child = await window.evaluate(
      (request) => window.api.createWorktree(request),
      {
        projectId: workspace.id,
        repoPath: workspace.repoPath,
        existingWorktreeIds: ['demo-main'],
        baseWorktreeId: 'demo-main',
        branchName: 'feature/unpinned-child',
      },
    );
    const peer = await window.evaluate(
      (request) => window.api.createWorktree(request),
      {
        projectId: workspace.id,
        repoPath: workspace.repoPath,
        existingWorktreeIds: ['demo-main', child.id],
        branchName: 'feature/pinned-peer',
      },
    );
    const childGroup = window.locator(
      `[data-testid="worktree-branch-group-child"][data-child-worktree-id="${child.id}"]`,
    );
    await expect(childGroup).toHaveCount(1, { timeout: 30_000 });

    for (const worktreeId of ['demo-main', peer.id]) {
      const row = window.locator(
        `[data-testid="worktree-row"][data-worktree-id="${worktreeId}"]`,
      );
      await expect(row).toBeVisible({ timeout: 30_000 });
      await row.hover();
      const menuButton = row
        .getByTestId('worktree-actions-menu-button')
        .first();
      await menuButton.focus();
      await window.keyboard.press('Enter');
      const pinItem = window.getByTestId('worktree-actions-menu-toggle-pin');
      await expect(pinItem).toHaveText('Pin to top');
      await pinItem.click();
    }

    // The pinned group keeps manual order, where new worktrees lead: the
    // later-created peer sits above demo-main, and both precede the child.
    const rows = window.locator('[data-testid="worktree-row"]');
    await expect
      .poll(() =>
        rows.evaluateAll((elements) =>
          elements.map((element) => element.dataset.worktreeId),
        ),
      )
      .toEqual([peer.id, 'demo-main', child.id]);
    await expect(childGroup).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

// CAN-1074: an empty pinned Work Entry is still a durable sidebar favorite.
// Seed it before launch to cover the restart path where it is not the active
// entry and therefore cannot rely on the transient open-empty exception.
test('a pinned empty work entry remains visible after restart', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-pinned-empty-entry-'),
  );
  seedPinnedEmptyWorkEntry(userDataDir);
  const { electronApp } = await launchCanopyWithLabsPagesOffered({
    userDataDir,
  });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();

    await expect(
      window.getByTestId('sidebar-work-entry-empty-pinned'),
    ).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

// CAN-3053: right-click on a worktree row opens the same ⋯ actions menu the
// hover trigger opens, anchored at the pointer — matching the legacy desktop
// rail. The shared rail's `WorktreeRow` already accepted an `onContextMenu`
// prop; the regression was that the shared rail never wired one up.
test('right-click opens the row actions menu anchored at the pointer, clamped on screen', async () => {
  const { electronApp, userDataDir } = await launchCanopyWithLabsPagesOffered({
    seedDemoWorkspaces: true,
    demoWorkspaceApps: ['ts-yarn-cli'],
  });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();

    const row = window.locator(
      '[data-testid="worktree-row"][data-worktree-id="demo-main"]',
    );
    await expect(row).toBeVisible();
    await waitForStableLocator(window, row);

    const menu = window.getByTestId('worktree-actions-menu');

    // First, the trigger-anchored position (hover reveals the ••• button;
    // opened with the keyboard for the same reliability reason the other
    // tests in this file use it).
    await row.hover();
    const menuButton = row.getByTestId('worktree-actions-menu-button').first();
    await menuButton.focus();
    await window.keyboard.press('Enter');
    await expect(menu).toBeVisible();
    const triggerAnchoredBox = await menu.boundingBox();
    expect(triggerAnchoredBox).not.toBeNull();
    await window.keyboard.press('Escape');
    await expect(menu).toBeHidden();

    // Then, right-click near the row's LEFT edge — the regression this
    // covers only reproduces there: anchoring the menu's right edge at the
    // pointer pushes its left edge off-screen for a click this close to a
    // left-docked rail's own left edge.
    const box = await row.boundingBox();
    expect(box).not.toBeNull();
    const point = { x: box.x + 8, y: box.y + box.height / 2 };

    await expect(menu).toBeHidden();
    await window.mouse.move(point.x, point.y);
    await window.mouse.click(point.x, point.y, { button: 'right' });

    await expect(menu).toBeVisible();
    // Same items the hover trigger's menu carries.
    await expect(
      window.getByTestId('worktree-actions-menu-toggle-pin'),
    ).toBeVisible();

    const pointerAnchoredBox = await menu.boundingBox();
    expect(pointerAnchoredBox).not.toBeNull();
    // Follows the pointer vertically...
    expect(Math.abs(pointerAnchoredBox.y - point.y)).toBeLessThan(60);
    // ...and differs from the trigger-anchored position — it is not
    // silently falling back to anchoring on the (hidden, un-hovered) •••
    // button instead of the click point.
    expect(
      Math.abs(pointerAnchoredBox.x - triggerAnchoredBox.x) > 4 ||
        Math.abs(pointerAnchoredBox.y - triggerAnchoredBox.y) > 4,
    ).toBe(true);
    // Fully on screen: clamped inside the viewport rather than extending
    // past the left edge, which a right-edge-at-the-pointer anchor would do
    // for a click this close to the rail's own left edge.
    const viewport = window.viewportSize();
    expect(viewport).not.toBeNull();
    expect(pointerAnchoredBox.x).toBeGreaterThanOrEqual(0);
    expect(pointerAnchoredBox.x + pointerAnchoredBox.width).toBeLessThanOrEqual(
      viewport.width,
    );

    await window.keyboard.press('Escape');
    await expect(menu).toBeHidden();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

// A Menu (ContextMenu) key press on a focused row makes Chromium fire the
// same `contextmenu` DOM event a right-click does, so the row's handler opens
// the same menu. Mac keyboards have no Menu key; there the keyboard path to
// these actions is the row's ⋯ button, covered by the tests above.
test('the ContextMenu key opens the row actions menu on a focused row', async () => {
  const { electronApp, userDataDir } = await launchCanopyWithLabsPagesOffered({
    seedDemoWorkspaces: true,
    demoWorkspaceApps: ['ts-yarn-cli'],
  });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();

    const row = window.locator(
      '[data-testid="worktree-row"][data-worktree-id="demo-main"]',
    );
    await expect(row).toBeVisible();
    await waitForStableLocator(window, row);

    const menu = window.getByTestId('worktree-actions-menu');
    await expect(menu).toBeHidden();

    // `worktree-row` is `WorktreeRow`'s own root; the focusable element that
    // carries the context-menu handler is its nearest `tabindex="0"`
    // ancestor (`SidebarRowFrame`). Focus it the way tabbing to the row would.
    const rowFrame = row.locator('xpath=ancestor::*[@tabindex="0"][1]');
    await rowFrame.focus();
    await window.keyboard.press('ContextMenu');

    await expect(menu).toBeVisible();
    await expect(
      window.getByTestId('worktree-actions-menu-toggle-pin'),
    ).toBeVisible();

    await window.keyboard.press('Escape');
    await expect(menu).toBeHidden();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

// CAN-1074 requires whole-project pinning to be discoverable from an options
// dropdown, not only from the row's right-click shortcut.
test('a project can be pinned from its visible options menu', async () => {
  const { electronApp, userDataDir } = await launchCanopyWithLabsPagesOffered({
    seedDemoWorkspaces: true,
    demoWorkspaceApps: ['ts-yarn-cli'],
  });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();

    const header = window.getByTestId(
      'sidebar-project-header-demo-ts-yarn-cli',
    );
    await expect(header).toBeVisible();
    await waitForStableLocator(window, header);
    await header.hover();

    const optionsButton = header.getByTestId(
      'workspace-project-options-button',
    );
    await expect(optionsButton).toBeVisible();
    await optionsButton.focus();
    await window.keyboard.press('Enter');

    const pinItem = window.getByTestId('workspace-toggle-pin-menu-item');
    await expect(pinItem).toBeVisible();
    // One wording everywhere: a project row says what a worktree row says.
    await expect(pinItem).toContainText('Pin to top');
    await pinItem.click();
    await expect(pinItem).toBeHidden();

    await header.hover();
    await optionsButton.focus();
    await window.keyboard.press('Enter');
    await expect(pinItem).toContainText('Unpin');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
