import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver, closePanelTab } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { seedWorktreeChat } from './seeders/index.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { collectLeaves, getLayout } from './panelHarness.mjs';
import { seedAdvancedDefaultPanelLayout } from './seeders/seedAdvancedDefaultPanelLayout.mjs';

const GROUPS = {
  chat: 'group-chat',
  side: 'group-extras',
  bottom: 'group-terminal',
  advancedActivity: 'group-activity',
};

function seedWorkspace(
  mode = 'minimal',
  {
    advancedDefault = false,
    workspaceDefaultMode = 'minimal',
    extraChat = false,
  } = {},
) {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-layout-mode-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: 'demo-ts-pnpm-vite',
    worktreeId: 'demo-main',
    providerType: 'claude',
    tabs: [
      { id: 'seed-chat', title: 'Chat' },
      ...(extraChat ? [{ id: 'second-chat', title: 'Second chat' }] : []),
    ],
  });
  const dataDir = path.join(
    userDataDir,
    'workspaces',
    'demo-ts-pnpm-vite',
    'worktree-data',
    'demo-main',
  );
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(
    path.join(dataDir, 'panel-layout-mode.json'),
    JSON.stringify({ version: 1, mode }),
  );
  writeFileSync(
    path.join(userDataDir, 'preferences.json'),
    JSON.stringify({
      version: 1,
      preferences: { workspaceDefaultLayoutMode: workspaceDefaultMode },
    }),
  );
  if (advancedDefault) seedAdvancedDefaultPanelLayout({ userDataDir });
  return userDataDir;
}

async function openWorkspace(mode = 'minimal', options) {
  const userDataDir = seedWorkspace(mode, options);
  const launched = await launchCanopy({ userDataDir });
  const window = await launched.electronApp.firstWindow();
  const app = new CanopyAppDriver(window);
  await app.waitForShell({ timeout: 30_000 });
  await app.openMainPage();
  await app.selectWorktree('demo-main');
  await expect(window.getByTestId('panel-grid-root')).toBeVisible();
  // The seeded chat tab's bound panel materializes asynchronously: the
  // ensure-layout pass can run before chat hydration seeds it, and the sync
  // bridge then adds it on a later sweep. Specs here snapshot the layout and
  // compare it after a mutation, so returning before that settles makes the
  // `before` snapshot miss the chat panel. Mirrors the same wait in
  // `panelHarness.seedPanelWorktree`.
  await expect
    .poll(
      async () => {
        const layout = await getLayout(window).catch(() => null);
        if (!layout) return false;
        return collectLeaves(layout.root).some((leaf) =>
          leaf.panels.some(
            (panel) => panel.instance?.chatTabId === 'seed-chat',
          ),
        );
      },
      { timeout: 20_000 },
    )
    .toBe(true);
  return { ...launched, app, window, userDataDir };
}

async function leafByGroup(window, groupId) {
  const layout = await getLayout(window).catch((error) => {
    if (
      error instanceof Error &&
      error.message.includes('No panel layout for worktree')
    ) {
      return null;
    }
    throw error;
  });
  return collectLeaves(layout?.root).find((leaf) => leaf.groupId === groupId);
}

/**
 * The first collapse state `groupId` had since the visible surface installed
 * its test API, or `null` before the layout exists. For a newly created entry
 * the surface installs the API before it ensures the layout, so this is the
 * layout's starting state. Unlike the live leaf, it is not raced by a later
 * reopen (CAN-2836) once the new entry's chat starts running.
 */
async function initialCollapse(window, groupId) {
  const history = await window.evaluate(
    (id) => window.__canopyPanelTestApi?.getGroupCollapseHistory(id) ?? [],
    groupId,
  );
  return history[0] ?? null;
}

async function addPanel(window, groupId, kind) {
  await window.getByTestId(`panel-add-panel-${groupId}`).click();
  if (kind === 'terminal') {
    const submenu = window.getByTestId('panel-add-menu-terminal-submenu');
    await expect(submenu).toBeVisible();
    await submenu.click();
  }
  const item = window.getByTestId(`panel-add-menu-item-${kind}`);
  await expect(item).toBeVisible();
  await item.click();
  await expect(window.getByTestId('panel-add-menu')).toBeHidden({
    timeout: 20_000,
  });
}

async function ensureBottomDrawerVisible(window) {
  const toggle = window.getByTestId('workspace-layout-terminal-toggle');
  if ((await toggle.getAttribute('aria-label')) !== 'Collapse bottom drawer') {
    await toggle.click();
  }
  await expect(
    window.getByTestId(`panel-group-${GROUPS.bottom}`),
  ).toBeVisible();
}

async function ensureSidePanelVisible(window) {
  const toggle = window.getByTestId('workspace-layout-side-panel-toggle');
  if ((await toggle.getAttribute('aria-label')) !== 'Collapse side panel') {
    await toggle.click();
  }
  await expect(window.getByTestId(`panel-group-${GROUPS.side}`)).toBeVisible();
}

async function switchMode(window, mode) {
  if (!(await window.getByTestId('save-layout-default-menu').isVisible())) {
    await window.getByTestId('worktree-top-save-layout-default').click();
  }
  await window.getByRole('menuitemradio', { name: mode }).click();
}

async function setDefaultLayoutMode(app, window, userDataDir, mode) {
  await app.openSettings();
  await app.openSettingsSection('display');
  await window.getByTestId(`workspace-layout-default-${mode}`).click();
  await expect
    .poll(async () => {
      const preferences = JSON.parse(
        await readFile(path.join(userDataDir, 'preferences.json'), 'utf8'),
      );
      return preferences.preferences?.workspaceDefaultLayoutMode;
    })
    .toBe(mode);
  await app.closeSettings();
  await app.openMainPage();
}

test('repeated layout mode switches preserve Side Panel width and Bottom Drawer height', async () => {
  const { electronApp, window, userDataDir } = await openWorkspace();
  try {
    await window.setViewportSize({ width: 1600, height: 1000 });
    await ensureSidePanelVisible(window);
    await ensureBottomDrawerVisible(window);
    await window.getByTestId('panel-group-group-extras').click();
    const side = window.getByTestId('panel-group-group-extras');
    const bottom = window.getByTestId('panel-group-group-terminal');
    const initialSide = (await side.boundingBox()).width;
    const initialBottom = (await bottom.boundingBox()).height;
    const toggleReveal = window.getByTestId('workspace-layout-toggle-reveal');
    await expect(toggleReveal).toHaveCSS('width', '64px');
    for (let cycle = 0; cycle < 4; cycle++) {
      await switchMode(window, 'advanced');
      await expect(toggleReveal).toHaveCSS('width', '0px');
      await expect(toggleReveal).toHaveAttribute('inert', '');
      await expect(
        window.getByTestId('workspace-layout-side-panel-toggle'),
      ).toBeHidden();
      await window.keyboard.press('Escape');
      await switchMode(window, 'minimal');
      await expect(toggleReveal).toHaveCSS('width', '64px');
      await expect(
        window.getByTestId('workspace-layout-side-panel-toggle'),
      ).toBeVisible();
      await window.keyboard.press('Escape');
      await expect
        .poll(async () =>
          Math.abs((await side.boundingBox()).width - initialSide),
        )
        .toBeLessThanOrEqual(2);
      await expect
        .poll(async () =>
          Math.abs((await bottom.boundingBox()).height - initialBottom),
        )
        .toBeLessThanOrEqual(2);
    }
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('Advanced only shows New Chat on bars that already contain a Chat tab', async () => {
  test.setTimeout(120_000);
  const { electronApp, userDataDir, window } = await openWorkspace('advanced', {
    advancedDefault: true,
  });
  try {
    await expect(
      window.getByTestId(`panel-add-tab-${GROUPS.chat}`),
    ).toBeVisible();
    await expect(
      window.getByTestId(`panel-add-tab-${GROUPS.chat}`),
    ).not.toHaveAttribute('aria-haspopup');
    await expect(
      window.getByTestId(`panel-add-tab-${GROUPS.chat}`),
    ).not.toHaveAttribute('aria-expanded');
    await expect(
      window.getByTestId(`panel-add-tab-${GROUPS.advancedActivity}`),
    ).toHaveCount(0);
    await expect(
      window.getByTestId(`panel-add-tab-${GROUPS.bottom}`),
    ).toHaveCount(0);
    await expect(
      window.getByTestId(`panel-add-panel-${GROUPS.advancedActivity}`),
    ).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('Minimal renders Chat, Side Panel, and a full-width Bottom Drawer with local controls', async () => {
  test.setTimeout(120_000);
  const { electronApp, userDataDir, window } = await openWorkspace();
  try {
    await expect(window.getByTestId('workspace-layout-add-panel')).toHaveCount(
      0,
    );
    await expect(
      window.getByTestId(`panel-group-${GROUPS.advancedActivity}`),
    ).toHaveCount(0);
    await expect(
      window.getByTestId(`panel-add-panel-${GROUPS.chat}`),
    ).toHaveCount(0);
    await expect(
      window.getByTestId(`panel-add-tab-${GROUPS.chat}`),
    ).toBeVisible();
    await expect
      .poll(async () => (await leafByGroup(window, GROUPS.side))?.collapsed)
      .toBe('right');
    await expect
      .poll(async () => (await leafByGroup(window, GROUPS.bottom))?.collapsed)
      .toBe('bottom');
    await expect(window.getByTestId(`panel-group-${GROUPS.side}`)).toBeHidden();
    await expect(
      window.getByTestId(`panel-group-${GROUPS.bottom}`),
    ).toBeHidden();

    await window.getByTestId('workspace-layout-side-panel-toggle').click();
    await expect
      .poll(async () => (await leafByGroup(window, GROUPS.side))?.collapsed)
      .toBeNull();
    await expect(
      window.getByTestId(`panel-add-panel-${GROUPS.side}`),
    ).toBeVisible();

    const [initialChat, initialSide] = await Promise.all([
      window.getByTestId(`panel-group-${GROUPS.chat}`).boundingBox(),
      window.getByTestId(`panel-group-${GROUPS.side}`).boundingBox(),
    ]);
    expect(initialChat).not.toBeNull();
    expect(initialSide).not.toBeNull();
    expect(
      Math.abs(
        initialSide.width / (initialChat.width + initialSide.width) - 0.5,
      ),
    ).toBeLessThanOrEqual(0.015);

    await window.getByTestId('workspace-layout-side-panel-toggle').click();
    await expect
      .poll(async () => (await leafByGroup(window, GROUPS.side))?.collapsed)
      .toBe('right');
    const initialGrid = await window
      .getByTestId('panel-grid-root')
      .boundingBox();
    if (!initialGrid) throw new Error('Expected panel grid bounds');
    const appSidebarToggle = window.getByTestId('sidebar-toggle');
    await expect(appSidebarToggle).toHaveAttribute(
      'aria-label',
      'Hide sidebar',
    );
    await appSidebarToggle.click();
    await expect(appSidebarToggle).toHaveAttribute(
      'aria-label',
      'Show sidebar',
    );
    await expect
      .poll(
        async () =>
          (await window.getByTestId('panel-grid-root').boundingBox())?.width,
      )
      .toBeGreaterThan(initialGrid.width + 200);

    await window.getByTestId('workspace-layout-side-panel-toggle').click();
    await expect
      .poll(async () => (await leafByGroup(window, GROUPS.side))?.collapsed)
      .toBeNull();
    const [resizedChat, resizedSide] = await Promise.all([
      window.getByTestId(`panel-group-${GROUPS.chat}`).boundingBox(),
      window.getByTestId(`panel-group-${GROUPS.side}`).boundingBox(),
    ]);
    expect(resizedChat).not.toBeNull();
    expect(resizedSide).not.toBeNull();
    expect(
      Math.abs(
        resizedSide.width / (resizedChat.width + resizedSide.width) - 0.5,
      ),
    ).toBeLessThanOrEqual(0.015);
    await appSidebarToggle.click();
    await expect(appSidebarToggle).toHaveAttribute(
      'aria-label',
      'Hide sidebar',
    );

    const sideLeaf = await leafByGroup(window, GROUPS.side);
    expect(sideLeaf.panels.slice(0, 2).map((panel) => panel.kind)).toEqual([
      'activity-section',
      'file-explorer',
    ]);
    for (const panel of sideLeaf.panels.slice(0, 2)) {
      await expect(
        window.getByTestId(`panel-tab-close-${panel.panelId}`),
      ).toHaveCount(0);
    }

    const terminalToggle = window.getByTestId(
      'workspace-layout-terminal-toggle',
    );
    await expect(terminalToggle).toBeEnabled();
    if (
      (await terminalToggle.getAttribute('aria-label')) ===
      'Collapse bottom drawer'
    ) {
      await terminalToggle.click();
      await expect
        .poll(async () => (await leafByGroup(window, GROUPS.bottom))?.collapsed)
        .toBe('bottom');
    }
    await expect(terminalToggle).toHaveAttribute(
      'aria-label',
      'Expand Bottom Drawer',
    );
    await terminalToggle.click();
    await expect
      .poll(async () => (await leafByGroup(window, GROUPS.bottom))?.collapsed)
      .toBeNull();
    await expect(
      window.getByTestId(`panel-add-panel-${GROUPS.bottom}`),
    ).toBeVisible();

    const [chat, side, bottom] = await Promise.all([
      window.getByTestId(`panel-group-${GROUPS.chat}`).boundingBox(),
      window.getByTestId(`panel-group-${GROUPS.side}`).boundingBox(),
      window.getByTestId(`panel-group-${GROUPS.bottom}`).boundingBox(),
    ]);
    expect(chat).not.toBeNull();
    expect(side).not.toBeNull();
    expect(bottom).not.toBeNull();
    expect(Math.abs(bottom.x - chat.x)).toBeLessThanOrEqual(1);
    expect(
      Math.abs(bottom.width - (chat.width + side.width)),
    ).toBeLessThanOrEqual(2);
    expect(bottom.y).toBeGreaterThanOrEqual(chat.y + chat.height - 1);
    expect(bottom.y).toBeGreaterThanOrEqual(side.y + side.height - 1);
    expect((await leafByGroup(window, GROUPS.bottom)).panels[0]).toEqual(
      expect.objectContaining({ kind: 'terminal' }),
    );

    for (const groupId of [GROUPS.side, GROUPS.bottom]) {
      await window.getByTestId(`panel-add-panel-${groupId}`).click();
      const menu = window.getByTestId('panel-add-menu');
      await expect(menu).toBeVisible();
      await expect(
        menu.getByTestId('panel-add-menu-item-new-chat'),
      ).toBeVisible();
      await expect(
        menu.getByTestId('panel-add-menu-item-browser'),
      ).toBeVisible();
      await expect(
        menu.getByTestId('panel-add-menu-terminal-submenu'),
      ).toBeVisible();
      await expect(
        menu.getByTestId('panel-add-menu-usage-submenu'),
      ).toBeVisible();
      await expect(
        menu.getByTestId('panel-add-menu-activity-group'),
      ).toBeVisible();
      await window.keyboard.press('Escape');
    }

    await expect(
      window.getByTestId(`panel-group-hide-${GROUPS.bottom}`),
    ).toHaveAttribute('aria-label', 'Collapse bottom drawer');

    await terminalToggle.click();
    await expect
      .poll(async () => (await leafByGroup(window, GROUPS.bottom))?.collapsed)
      .toBe('bottom');
    await expect(
      window.getByTestId(`panel-group-${GROUPS.bottom}`),
    ).toBeHidden();

    const sideMaximize = window.getByTestId(
      `panel-group-maximize-${GROUPS.side}`,
    );
    const sideHide = window.getByTestId(`panel-group-hide-${GROUPS.side}`);
    await expect(sideMaximize).toBeVisible();
    await expect(sideHide).toHaveAttribute('aria-label', 'Collapse side panel');
    await sideMaximize.click();
    await expect(
      window.getByTestId(`panel-group-restore-${GROUPS.side}`),
    ).toBeVisible();
    await window.getByTestId(`panel-group-restore-${GROUPS.side}`).click();
    await expect(
      window.getByTestId(`panel-group-${GROUPS.bottom}`),
    ).toBeHidden();
    await expect
      .poll(async () => (await leafByGroup(window, GROUPS.bottom))?.collapsed)
      .toBe('bottom');

    // A top-bar toggle first exits another group's full-screen presentation.
    await sideMaximize.click();
    await terminalToggle.click();
    await expect(
      window.getByTestId(`panel-group-restore-${GROUPS.side}`),
    ).toHaveCount(0);
    await expect(
      window.getByTestId(`panel-group-${GROUPS.bottom}`),
    ).toBeVisible();

    await sideHide.click();
    await expect(window.getByTestId(`panel-group-${GROUPS.side}`)).toBeHidden();
    await window.getByTestId('workspace-layout-side-panel-toggle').click();
    await expect(
      window.getByTestId(`panel-group-${GROUPS.side}`),
    ).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('Minimal restore preserves custom bottom-row pop-out placement', async () => {
  test.setTimeout(120_000);
  const userDataDir = seedWorkspace('minimal');
  const dataDir = path.join(
    userDataDir,
    'workspaces',
    'demo-ts-pnpm-vite',
    'worktree-data',
    'demo-main',
  );
  writeFileSync(
    path.join(dataDir, 'panel-layout.json'),
    JSON.stringify({
      version: 1,
      grid: {
        orientation: 1,
        width: 1200,
        height: 800,
        root: {
          type: 'leaf',
          groupId: GROUPS.chat,
          size: 1200,
          panels: [
            {
              panelId: 'panel-chat-seed-chat',
              kind: 'chat',
              instance: { chatTabId: 'seed-chat' },
            },
          ],
          activePanelId: 'panel-chat-seed-chat',
        },
      },
      activeGroupId: GROUPS.chat,
      mostRecentActiveGroupIds: [GROUPS.chat],
      poppedOut: [
        {
          windowId: 'aux-window-usage',
          grid: {
            orientation: 1,
            width: 640,
            height: 480,
            root: {
              type: 'leaf',
              groupId: 'group-aux-usage',
              size: 640,
              panels: [
                {
                  panelId: 'panel-usage-popped',
                  kind: 'usage',
                  instance: { variant: 'all' },
                },
              ],
              activePanelId: 'panel-usage-popped',
            },
          },
          bounds: { x: 10, y: 20, width: 640, height: 480 },
          sourceGroupId: 'group-custom-bottom',
          returnTarget: {
            anchorGroupId: GROUPS.chat,
            direction: 'down',
            size: 240,
          },
        },
      ],
    }),
  );
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree('demo-main');
    await expect(window.getByTestId('panel-grid-root')).toBeVisible();
    await expect
      .poll(async () =>
        (await leafByGroup(window, GROUPS.bottom))?.panels.some(
          (panel) => panel.panelId === 'panel-usage-popped',
        ),
      )
      .toBe(true);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('a sidebar-created worktree inherits Minimal and starts with optional regions hidden', async () => {
  test.setTimeout(120_000);
  const userDataDir = seedWorkspace('advanced', {
    workspaceDefaultMode: 'advanced',
  });
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await setDefaultLayoutMode(app, window, userDataDir, 'minimal');

    const header = window.getByTestId(
      'sidebar-project-header-demo-ts-pnpm-vite',
    );
    await header.hover();
    await header.locator('button[aria-label^="Create worktree for"]').click();

    await expect(window.getByTestId('worktree-row')).toHaveCount(2, {
      timeout: 30_000,
    });
    await expect(
      window.getByTestId('workspace-layout-side-panel-toggle'),
    ).toBeVisible();
    await expect
      .poll(async () => (await leafByGroup(window, GROUPS.side))?.collapsed)
      .toBe('right');
    await expect
      .poll(async () => (await leafByGroup(window, GROUPS.bottom))?.collapsed)
      .toBe('bottom');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('a Home-composer-created worktree inherits Minimal and starts with optional regions hidden', async () => {
  test.setTimeout(120_000);
  const userDataDir = seedWorkspace('advanced', {
    workspaceDefaultMode: 'advanced',
  });
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await setDefaultLayoutMode(app, window, userDataDir, 'minimal');

    await window.getByTestId('sidebar-create-task').click();
    const home = window.getByTestId('page-home');
    await expect(home).toBeVisible();
    await expect(home.getByTestId('home-branch-picker')).toContainText(
      'New worktree',
    );
    await home
      .getByTestId('home-composer-editor')
      .fill('Verify the Minimal project default.');
    await home.getByTestId('home-send-button').click();

    await expect(home).toHaveCount(0, { timeout: 30_000 });
    await expect(
      window.getByTestId('workspace-layout-side-panel-toggle'),
    ).toBeVisible();
    // See the cowork Work Entry test below: assert the starting state rather
    // than racing a CAN-2836 reopen once the chat starts running.
    await expect
      .poll(async () => initialCollapse(window, GROUPS.side))
      .toEqual({ collapsed: 'right', auto: true });
    await expect
      .poll(async () => (await leafByGroup(window, GROUPS.bottom))?.collapsed)
      .toBe('bottom');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('a Home-composer-created cowork Work Entry inherits Minimal and starts with optional regions hidden', async () => {
  test.setTimeout(120_000);
  const userDataDir = seedWorkspace('advanced', {
    workspaceDefaultMode: 'advanced',
  });
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await setDefaultLayoutMode(app, window, userDataDir, 'minimal');

    const home = await app.openHomeForProject('cowork-default');
    // The catch-all is selected but deliberately unnamed on the trigger
    // (CAN-2363), so the draft reads as having no project chosen.
    await expect(home.getByTestId('home-workspace-select')).toContainText(
      'Choose project',
    );
    await home
      .getByTestId('home-composer-editor')
      .fill('Verify the Minimal Work Entry default.');
    await home.getByTestId('home-send-button').click();

    await expect(home).toHaveCount(0, { timeout: 30_000 });
    await expect(window.getByTestId('cowork-top-bar')).toBeVisible();
    await expect(
      window.getByTestId('workspace-layout-side-panel-toggle'),
    ).toBeVisible();
    // The Side Panel starts as Canopy's own collapse. Whether the entry's
    // running chat then reopens it is a separate CAN-2836 rule, so assert
    // the starting state rather than racing that reopen. Add a final-state
    // assertion once that rule is settled for Home-composer sends.
    await expect
      .poll(async () => initialCollapse(window, GROUPS.side))
      .toEqual({ collapsed: 'right', auto: true });
    await expect
      .poll(async () => (await leafByGroup(window, GROUPS.bottom))?.collapsed)
      .toBe('bottom');
    await expect(
      window.getByTestId(`panel-group-${GROUPS.bottom}`),
    ).toBeHidden();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('Minimal local Add panel keeps user-selected tabs in Side Panel or Bottom Drawer', async () => {
  test.setTimeout(120_000);
  const { electronApp, userDataDir, window } = await openWorkspace();
  try {
    await ensureSidePanelVisible(window);
    await addPanel(window, GROUPS.side, 'browser');
    await expect
      .poll(
        async () =>
          (await leafByGroup(window, GROUPS.side)).panels.filter(
            (panel) => panel.kind === 'browser',
          ).length,
        { timeout: 20_000 },
      )
      .toBe(1);

    await ensureBottomDrawerVisible(window);
    await addPanel(window, GROUPS.bottom, 'browser');
    await expect
      .poll(
        async () =>
          (await leafByGroup(window, GROUPS.bottom)).panels.filter(
            (panel) => panel.kind === 'browser',
          ).length,
        { timeout: 20_000 },
      )
      .toBe(1);

    const [chat, side, bottom] = await Promise.all([
      window.getByTestId(`panel-group-${GROUPS.chat}`).boundingBox(),
      window.getByTestId(`panel-group-${GROUPS.side}`).boundingBox(),
      window.getByTestId(`panel-group-${GROUPS.bottom}`).boundingBox(),
    ]);
    expect(Math.abs(bottom.x - chat.x)).toBeLessThanOrEqual(1);
    expect(
      Math.abs(bottom.width - (chat.width + side.width)),
    ).toBeLessThanOrEqual(2);

    const bottomBeforeToggle = await leafByGroup(window, GROUPS.bottom);
    const initialTerminal = bottomBeforeToggle.panels.find(
      (panel) => panel.kind === 'terminal',
    );
    await closePanelTab(window, initialTerminal.panelId);
    await expect
      .poll(
        async () =>
          (await leafByGroup(window, GROUPS.bottom)).panels.filter(
            (panel) => panel.kind === 'terminal',
          ).length,
      )
      .toBe(0);

    // Even when the Bottom Drawer still exists for another tab, its top-bar
    // toggle must exit full screen and reassert a terminal instead of merely
    // hiding the group.
    await window.getByTestId(`panel-group-maximize-${GROUPS.side}`).click();
    await expect(
      window.getByTestId(`panel-group-restore-${GROUPS.side}`),
    ).toBeVisible();
    await window.getByTestId('workspace-layout-terminal-toggle').click();
    await expect(
      window.getByTestId(`panel-group-restore-${GROUPS.side}`),
    ).toHaveCount(0);
    await expect
      .poll(
        async () =>
          (await leafByGroup(window, GROUPS.bottom)).panels.find(
            (panel) => panel.kind === 'terminal',
          )?.instance?.terminalId,
        { timeout: 20_000 },
      )
      .toEqual(expect.any(String));

    const bottomBrowser = bottomBeforeToggle.panels.find(
      (panel) => panel.kind === 'browser',
    );
    await window.getByTestId(`panel-tab-${bottomBrowser.panelId}`).click();
    const quickAdd = window.getByTestId(`panel-quick-add-${GROUPS.bottom}`);
    await expect(quickAdd).toHaveAttribute('aria-label', 'Add another browser');
    await quickAdd.click();
    await expect
      .poll(
        async () =>
          (await leafByGroup(window, GROUPS.bottom)).panels.filter(
            (panel) => panel.kind === 'browser',
          ).length,
      )
      .toBe(2);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('Minimal external file and terminal flows default to Side Panel and Bottom Drawer', async () => {
  test.setTimeout(120_000);
  const { electronApp, userDataDir, window } = await openWorkspace();
  try {
    await ensureSidePanelVisible(window);
    const sideLeaf = await leafByGroup(window, GROUPS.side);
    const explorer = sideLeaf.panels.find(
      (panel) => panel.kind === 'file-explorer',
    );
    await window.getByTestId(`panel-tab-${explorer.panelId}`).click();
    const packageRow = window.locator(
      '[data-testid="files-tree-row"][data-path="package.json"]',
    );
    await expect(packageRow).toBeVisible({ timeout: 20_000 });
    await packageRow.click();
    const filePanel = (await leafByGroup(window, GROUPS.side)).panels.find(
      (panel) => panel.kind === 'file-diff',
    );
    expect(filePanel?.instance?.filePath).toContain('package.json');
    await closePanelTab(window, filePanel.panelId);
    await expect(
      window.getByTestId(`panel-group-${GROUPS.side}`),
    ).toBeVisible();

    // A terminal explicitly added from Side Panel stays there, but it must
    // not capture later terminal-mode/script-created sessions.
    await addPanel(window, GROUPS.side, 'terminal');
    await expect
      .poll(
        async () =>
          (await leafByGroup(window, GROUPS.side)).panels.filter(
            (panel) => panel.kind === 'terminal',
          ).length,
        { timeout: 20_000 },
      )
      .toBe(1);

    const chatPanel = window.locator(
      '[data-testid="panel-content-chat"]:visible',
    );
    await chatPanel
      .locator('[data-chat-textarea][contenteditable="true"]')
      .fill('!echo minimal-bottom-drawer');
    await chatPanel
      .getByRole('button', { name: 'Run terminal command', exact: true })
      .click();
    await expect(
      window
        .getByTestId(`panel-group-body-${GROUPS.bottom}`)
        .getByTestId('terminal-pane'),
    ).toBeVisible({ timeout: 20_000 });
    const terminalLeaf = await leafByGroup(window, GROUPS.bottom);
    expect(terminalLeaf.panels).toEqual([
      expect.objectContaining({
        kind: 'terminal',
        instance: expect.objectContaining({ terminalId: expect.any(String) }),
      }),
    ]);
    await closePanelTab(window, terminalLeaf.panels[0].panelId);
    await expect(
      window.getByTestId(`panel-group-${GROUPS.bottom}`),
    ).toHaveCount(0);

    // The Bottom Drawer toggle reasserts its canonical group and a fresh
    // terminal; the terminal already open in Side Panel is not reused.
    await window.getByTestId('workspace-layout-terminal-toggle').click();
    await expect(
      window.getByTestId(`panel-group-${GROUPS.bottom}`),
    ).toBeVisible({ timeout: 20_000 });
    await expect
      .poll(
        async () =>
          (await leafByGroup(window, GROUPS.bottom)).panels.find(
            (panel) => panel.kind === 'terminal',
          )?.instance?.terminalId,
        { timeout: 20_000 },
      )
      .toEqual(expect.any(String));
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('Minimal preserves a Side Panel terminal placement across relaunch', async () => {
  test.setTimeout(180_000);
  const first = await openWorkspace();
  const { userDataDir } = first;
  let sideTerminalId;
  try {
    await ensureSidePanelVisible(first.window);
    await addPanel(first.window, GROUPS.side, 'terminal');
    await expect
      .poll(
        async () =>
          (await leafByGroup(first.window, GROUPS.side)).panels.find(
            (panel) => panel.kind === 'terminal',
          )?.instance?.terminalId,
        { timeout: 20_000 },
      )
      .toEqual(expect.any(String));
    sideTerminalId = (await leafByGroup(first.window, GROUPS.side)).panels.find(
      (panel) => panel.kind === 'terminal',
    ).instance.terminalId;
    // Allow the renderer's panel-layout debounce to reach main before quit;
    // main flushes its own disk debounce during app teardown.
    await first.window.waitForTimeout(1500);
  } finally {
    await closeCanopy(first.electronApp, userDataDir, { keepUserData: true });
  }

  const persistedLayout = JSON.parse(
    await readFile(
      path.join(
        userDataDir,
        'workspaces',
        'demo-ts-pnpm-vite',
        'worktree-data',
        'demo-main',
        'panel-layout.json',
      ),
      'utf8',
    ),
  );
  expect(
    collectLeaves(persistedLayout.grid.root)
      .find((leaf) => leaf.groupId === GROUPS.side)
      ?.panels.some((panel) => panel.instance?.terminalId === sideTerminalId),
  ).toBe(true);

  const second = await launchCanopy({ userDataDir });
  try {
    const window = await second.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree('demo-main');
    await expect(window.getByTestId('panel-grid-root')).toBeVisible();

    await expect
      .poll(
        async () =>
          (await leafByGroup(window, GROUPS.side)).panels.some(
            (panel) => panel.instance?.terminalId === sideTerminalId,
          ),
        { timeout: 20_000 },
      )
      .toBe(true);
    expect(
      (await leafByGroup(window, GROUPS.bottom)).panels.some(
        (panel) => panel.instance?.terminalId === sideTerminalId,
      ),
    ).toBe(false);
  } finally {
    await closeCanopy(second.electronApp, userDataDir);
  }
});

test('Minimal preserves a Bottom Drawer file whose path was assigned after creation', async () => {
  test.setTimeout(180_000);
  const first = await openWorkspace();
  const { userDataDir } = first;
  let fileTabId;
  try {
    await ensureBottomDrawerVisible(first.window);
    await addPanel(first.window, GROUPS.bottom, 'new-file');
    const bottomBody = first.window.getByTestId(
      `panel-group-body-${GROUPS.bottom}`,
    );
    const fileTree = bottomBody.getByTestId('file-tab-tree');
    await expect(fileTree).toBeVisible();
    await fileTree
      .locator('[data-testid="files-tree-row"][data-path="package.json"]')
      .click();
    await expect(
      bottomBody.getByTestId('file-breadcrumb-segment-file'),
    ).toHaveText('package.json');
    const filePanel = (
      await leafByGroup(first.window, GROUPS.bottom)
    ).panels.find((panel) => panel.kind === 'file-diff');
    fileTabId = filePanel?.instance?.fileTabId;
    expect(fileTabId).toEqual(expect.any(String));
    expect(filePanel?.instance?.filePath ?? '').toBe('');
    await first.window.waitForTimeout(1500);
  } finally {
    await closeCanopy(first.electronApp, userDataDir, { keepUserData: true });
  }

  const second = await launchCanopy({ userDataDir });
  try {
    const window = await second.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree('demo-main');
    await expect(window.getByTestId('panel-grid-root')).toBeVisible();

    await expect
      .poll(
        async () =>
          (await leafByGroup(window, GROUPS.bottom)).panels.some(
            (panel) => panel.instance?.fileTabId === fileTabId,
          ),
        { timeout: 20_000 },
      )
      .toBe(true);
    expect(
      (await leafByGroup(window, GROUPS.side)).panels.some(
        (panel) => panel.instance?.fileTabId === fileTabId,
      ),
    ).toBe(false);
  } finally {
    await closeCanopy(second.electronApp, userDataDir);
  }
});

test('Advanced to Minimal preserves every tab and sends the Advanced lower row to Bottom Drawer', async () => {
  test.setTimeout(120_000);
  const { electronApp, userDataDir, window } = await openWorkspace('advanced', {
    advancedDefault: true,
  });
  try {
    await window.getByTestId(`panel-add-panel-${GROUPS.bottom}`).click();
    await window.getByTestId('panel-add-menu-item-browser').click();
    await expect(window.getByTestId('panel-add-menu')).toBeHidden({
      timeout: 20_000,
    });
    const advancedBottomBrowser = (
      await leafByGroup(window, GROUPS.bottom)
    ).panels.find((panel) => panel.kind === 'browser');
    expect(advancedBottomBrowser?.panelId).toBeTruthy();

    await addPanel(window, GROUPS.advancedActivity, 'browser');
    const advancedSideBrowser = (
      await leafByGroup(window, GROUPS.advancedActivity)
    ).panels.find((panel) => panel.kind === 'browser');
    expect(advancedSideBrowser?.panelId).toBeTruthy();

    const focusedSideGroup = await window.evaluate(
      (groupId) => window.__canopyPanelTestApi.splitPanel(groupId, 'right'),
      GROUPS.advancedActivity,
    );
    await addPanel(window, focusedSideGroup, 'browser');
    const focusedSideBrowser = (
      await leafByGroup(window, focusedSideGroup)
    ).panels.find((panel) => panel.kind === 'browser');
    expect(focusedSideBrowser?.panelId).toBeTruthy();
    await window.evaluate(
      ({ groupId, panelId }) =>
        window.__canopyPanelTestApi.focusPanel(groupId, panelId),
      { groupId: focusedSideGroup, panelId: focusedSideBrowser.panelId },
    );

    const beforePanelIds = collectLeaves((await getLayout(window)).root)
      .flatMap((leaf) => leaf.panels)
      .map((panel) => panel.panelId)
      .sort();
    await switchMode(window, 'minimal');
    await expect(
      window.getByRole('dialog', { name: 'Switch to Minimal layout?' }),
    ).toHaveCount(0);

    await expect
      .poll(async () => collectLeaves((await getLayout(window)).root).length)
      .toBe(3);
    const minimal = await getLayout(window);
    const leaves = collectLeaves(minimal.root);
    const afterPanelIds = leaves
      .flatMap((leaf) => leaf.panels)
      .map((panel) => panel.panelId)
      .sort();
    expect(afterPanelIds).toEqual(beforePanelIds);
    expect(leaves.map((leaf) => leaf.groupId).sort()).toEqual(
      [GROUPS.chat, GROUPS.side, GROUPS.bottom].sort(),
    );
    expect(
      leaves
        .find((leaf) => leaf.groupId === GROUPS.bottom)
        .panels.map((panel) => panel.panelId),
    ).toContain(advancedBottomBrowser.panelId);
    const minimalSide = leaves.find((leaf) => leaf.groupId === GROUPS.side);
    expect(minimalSide.panels.map((panel) => panel.panelId)).toEqual(
      expect.arrayContaining([
        advancedSideBrowser.panelId,
        focusedSideBrowser.panelId,
      ]),
    );
    expect(minimalSide.activePanelId).toBe(focusedSideBrowser.panelId);

    const minimalRoot = await getLayout(window);
    await switchMode(window, 'advanced');
    await expect.poll(() => getLayout(window)).toEqual(minimalRoot);
    await expect(
      window.getByTestId(`panel-add-panel-${GROUPS.chat}`),
    ).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('Advanced to Minimal adopts auxiliary tabs without confirmation', async () => {
  test.setTimeout(120_000);
  const { electronApp, userDataDir, window } = await openWorkspace('advanced', {
    advancedDefault: true,
  });
  try {
    await window.getByTestId(`panel-add-panel-${GROUPS.bottom}`).click();
    await window.getByTestId('panel-add-menu-usage-submenu').click();
    await window.getByTestId('panel-add-menu-item-usage-all').click();
    await expect
      .poll(async () =>
        (await leafByGroup(window, GROUPS.bottom)).panels.some(
          (panel) => panel.kind === 'usage',
        ),
      )
      .toBe(true);

    const auxWindowPromise = electronApp.waitForEvent('window');
    const auxWindowId = await window.evaluate(
      (groupId) => window.__canopyPanelTestApi.popOutPanel(groupId),
      GROUPS.bottom,
    );
    expect(auxWindowId).toBeTruthy();
    const aux = await auxWindowPromise;
    await expect(aux.getByTestId('panel-aux-window-root')).toBeVisible();
    const auxiliaryLayout = await window.evaluate(
      (windowId) =>
        window.__canopyPanelTestApi.getAuxSerializedLayout(windowId),
      auxWindowId,
    );
    const auxiliaryPanelIds = collectLeaves(auxiliaryLayout.root)
      .flatMap((leaf) => leaf.panels)
      .map((panel) => panel.panelId);

    await switchMode(window, 'minimal');
    await expect(
      window.getByRole('dialog', { name: 'Switch to Minimal layout?' }),
    ).toHaveCount(0);
    await expect.poll(() => aux.isClosed()).toBe(true);
    const bottomPanelIds = (
      await leafByGroup(window, GROUPS.bottom)
    ).panels.map((panel) => panel.panelId);
    expect(bottomPanelIds).toEqual(expect.arrayContaining(auxiliaryPanelIds));
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('failed Advanced conversion restores the layout and retains Advanced mode', async () => {
  test.setTimeout(120_000);
  const { electronApp, userDataDir, window } = await openWorkspace('advanced', {
    advancedDefault: true,
  });
  try {
    await expect
      .poll(async () =>
        (await leafByGroup(window, GROUPS.chat))?.panels.some(
          (panel) => panel.kind === 'chat',
        ),
      )
      .toBe(true);
    const before = await getLayout(window);
    await window.evaluate(() =>
      window.__canopyPanelTestApi.failNextWorkspaceLayoutModeSave(),
    );
    await switchMode(window, 'minimal');

    await expect(
      window.getByText("Couldn't switch layout mode", { exact: true }),
    ).toBeVisible();
    await expect.poll(() => getLayout(window)).toEqual(before);
    await expect(
      window.getByTestId(`panel-add-panel-${GROUPS.chat}`),
    ).toBeVisible();

    const persistedMode = JSON.parse(
      await readFile(
        path.join(
          userDataDir,
          'workspaces',
          'demo-ts-pnpm-vite',
          'worktree-data',
          'demo-main',
          'panel-layout-mode.json',
        ),
        'utf8',
      ),
    );
    expect(persistedMode).toEqual({ version: 1, mode: 'advanced' });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('layout picker switches and persists chat width without changing layout mode', async () => {
  const { electronApp, userDataDir, window } = await openWorkspace('advanced', {
    advancedDefault: true,
  });
  try {
    await window.setViewportSize({ width: 2000, height: 1000 });
    await window.emulateMedia({ reducedMotion: 'no-preference' });
    const composer = window.locator('[data-chat-composer-root]').first();
    await expect(composer).toBeVisible();
    await composer.evaluate((element) => {
      element.dataset.widthTransitions = '0';
      element.addEventListener('transitionrun', (event) => {
        if (event.target === element && event.propertyName === 'max-width') {
          element.dataset.widthTransitions = String(
            Number(element.dataset.widthTransitions) + 1,
          );
        }
      });
    });
    await window.getByTestId('worktree-top-save-layout-default').click();
    await expect(
      window.getByTestId('workspace-chat-width-default'),
    ).toHaveAttribute('aria-checked', 'true');
    await window.getByTestId('workspace-chat-width-full').click();
    await expect
      .poll(() =>
        window.evaluate(() =>
          getComputedStyle(document.documentElement)
            .getPropertyValue('--chat-reading-width')
            .trim(),
        ),
      )
      .toBe('100%');
    await expect(composer).toHaveAttribute('data-width-transitions', '1');
    await expect
      .poll(() =>
        composer.evaluate((element) => element.getAnimations().length),
      )
      .toBe(0);
    await expect
      .poll(
        async () =>
          JSON.parse(
            await readFile(path.join(userDataDir, 'preferences.json'), 'utf8'),
          ).preferences.chatWidth,
      )
      .toBe('full');
    await expect(window.getByTestId('save-layout-default-menu')).toBeVisible();
    await expect(
      window.getByTestId('workspace-chat-width-full'),
    ).toHaveAttribute('aria-checked', 'true');
    await expect(
      window.getByTestId('workspace-layout-mode-advanced'),
    ).toHaveAttribute('aria-checked', 'true');
    await expect(window.getByTestId('save-layout-default-item')).toHaveClass(
      /canopy-dropdown-menu-item/,
    );
    await window.getByTestId('workspace-chat-width-default').click();
    await expect
      .poll(() =>
        window.evaluate(() =>
          getComputedStyle(document.documentElement)
            .getPropertyValue('--chat-reading-width')
            .trim(),
        ),
      )
      .toBe('736px');
    await expect(composer).toHaveAttribute('data-width-transitions', '2');
    await expect
      .poll(() =>
        composer.evaluate((element) => element.getAnimations().length),
      )
      .toBe(0);
    await window.emulateMedia({ reducedMotion: 'reduce' });
    // The shared reduced-motion reset uses 0.01ms rather than literal zero.
    await expect
      .poll(() =>
        composer.evaluate((element) =>
          Number.parseFloat(getComputedStyle(element).transitionDuration),
        ),
      )
      .toBeLessThanOrEqual(0.00001);
    await expect
      .poll(() =>
        window.evaluate(() =>
          document.documentElement.style.getPropertyValue(
            '--chat-composer-shell-width',
          ),
        ),
      )
      .toBe('');
    await expect(window.getByTestId('save-layout-default-menu')).toBeVisible();
    await window.getByTestId('workspace-layout-mode-minimal').click();
    await expect(
      window.getByTestId('workspace-layout-mode-minimal'),
    ).toHaveAttribute('aria-checked', 'true');
    await expect(window.getByTestId('save-layout-default-menu')).toBeVisible();
    await window.getByTestId('workspace-layout-mode-advanced').click();
    await expect(
      window.getByTestId('workspace-layout-mode-advanced'),
    ).toHaveAttribute('aria-checked', 'true');
    await expect(window.getByTestId('save-layout-default-menu')).toBeVisible();
    await window.keyboard.press('Escape');
    await expect(window.getByTestId('save-layout-default-menu')).toBeHidden();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('recovery notice follows chat width and keeps one gap above the composer', async () => {
  const { electronApp, userDataDir, window } = await openWorkspace('advanced', {
    advancedDefault: true,
    extraChat: true,
  });
  try {
    await window.setViewportSize({ width: 2200, height: 1000 });
    const panel = window.locator('[data-testid="panel-content-chat"]:visible');
    await electronApp.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('chat:command');
      ipcMain.handle('chat:command', (_event, envelope) => ({
        commandId: envelope.commandId,
        revision: 9,
        outcome: 'not_found',
      }));
    });
    await window.getByTestId('panel-tab-panel-chat-second-chat').click();
    const notice = panel.getByTestId('chat-state-conflict-notice');
    await expect(notice).toBeVisible();
    const composer = panel.locator('[data-chat-composer-root]');
    const assertAlignment = async () => {
      const noticeBox = await notice.boundingBox();
      const composerBox = await composer.boundingBox();
      expect(Math.abs(noticeBox.x - composerBox.x - 16)).toBeLessThanOrEqual(1);
      expect(
        Math.abs(noticeBox.width - composerBox.width + 32),
      ).toBeLessThanOrEqual(1);
      // The composer owns the top gap; the banner must not add another one.
      expect(
        Math.abs(composerBox.y - noticeBox.y - noticeBox.height),
      ).toBeLessThanOrEqual(1);
    };
    await expect(assertAlignment).toPass({ timeout: 5_000 });
    await window.getByTestId('worktree-top-save-layout-default').click();
    await window.getByTestId('workspace-chat-width-full').click();
    await window.keyboard.press('Escape');
    await expect(assertAlignment).toPass({ timeout: 5_000 });
    await window.setViewportSize({ width: 1200, height: 900 });
    await expect(assertAlignment).toPass({ timeout: 5_000 });
    await panel.getByTestId('chat-state-notice-dismiss').click();
    await expect(notice).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
