// "Save layout as default" — the worktree top bar's LayoutDashboard control
// captures the current panel layout (including collapsed state) as a global
// default that seeds newly created worktrees, without touching existing ones.
//
//   1. SAVE: add portable activity-card tabs, collapse the activity group,
//      open the dropdown, click
//      "Save layout as default" → `{dataDir}/default-panel-layout.json` is
//      written with the activity/terminal groups collapsed, activity-card
//      bindings preserved, one portable terminal placeholder, and no chat or
//      terminal session binding.
//   2. APPLY: a worktree with no `panel-layout.json` but a saved default on
//      disk adopts that default (including dedicated activity-card panels and
//      the collapsed terminal placeholder) on first open.

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  collectLeaves,
  DEFAULT_GROUP_IDS,
  expandDefaultActivityRail,
  getLayout,
  SEEDED_CHAT_TAB_ID,
  seedPanelWorktree,
  spawnPanelTerminal,
} from './panelHarness.mjs';
import { seedWorktreeChat } from './seeders/index.mjs';

function activityLeaf(layout) {
  return collectLeaves(layout.root).find(
    (leaf) => leaf.groupId === DEFAULT_GROUP_IDS.activity,
  );
}

test('save layout as default persists a templatized default file', async () => {
  const { electronApp, userDataDir, window } = await seedPanelWorktree();
  try {
    // Reproduce the post-unnesting shape: starting the default terminal binds
    // its panel to one concrete terminal session. A saved default must retain
    // that tab's slot as a portable placeholder, not leave an empty drawer.
    await spawnPanelTerminal(window);
    await window.evaluate(
      ([groupId]) => window.__canopyPanelTestApi.collapseGroup(groupId, true),
      [DEFAULT_GROUP_IDS.terminal],
    );
    const boundTerminal = collectLeaves((await getLayout(window))?.root)
      .find((leaf) => leaf.groupId === DEFAULT_GROUP_IDS.terminal)
      ?.panels.find((panel) => panel.kind === 'terminal');
    expect(boundTerminal?.instance?.terminalId).toBeTruthy();

    // Activity cards bind stable section ids, so they are portable across code
    // worktrees and must survive the default-layout transform.
    // The graduated tab-strip + opens the shared panel catalog.
    for (const sectionId of ['pull-request', 'pipeline-runs']) {
      await window
        .getByTestId(`panel-add-tab-${DEFAULT_GROUP_IDS.activity}`)
        .click();
      await expect(window.getByTestId('panel-add-menu')).toBeVisible();
      await window
        .getByTestId(`panel-add-menu-item-activity-card-${sectionId}`)
        .click();
    }

    // CAN-2836 seeds a fresh worktree with the activity rail ALREADY collapsed
    // (carrying `auto: true`), and `collapseGroup` returns false immediately
    // when `group.collapsed !== undefined`. Without expanding first, the
    // collapse below is a silent no-op and the poll passes on Canopy's seeded
    // collapse — so this spec would assert on the wrong collapse entirely and
    // stop covering "a user-performed collapse is captured in the saved
    // default". Expand first so the collapse is genuinely the user's.
    await expandDefaultActivityRail(window);

    // Collapse the activity group via the panel test API (same store path the
    // real collapse affordance uses).
    await window.evaluate(
      ([groupId]) => window.__canopyPanelTestApi.collapseGroup(groupId, true),
      [DEFAULT_GROUP_IDS.activity],
    );
    await expect
      .poll(async () => {
        const layout = await getLayout(window);
        return activityLeaf(layout)?.collapsed ?? null;
      })
      .not.toBeNull();

    // Open the dropdown and save.
    await window.getByTestId('worktree-top-save-layout-default').click();
    await window.getByTestId('save-layout-default-item').click();

    // The default file is written (synchronous main-process write).
    const defaultPath = path.join(userDataDir, 'default-panel-layout.json');
    await expect
      .poll(() => {
        try {
          return JSON.parse(readFileSync(defaultPath, 'utf8')) !== null;
        } catch {
          return false;
        }
      })
      .toBe(true);

    const saved = JSON.parse(readFileSync(defaultPath, 'utf8'));
    expect(saved.version).toBe(1);
    // Chat instance stripped; activity cards and collapse preserved.
    expect(JSON.stringify(saved.layout)).not.toContain('chatTabId');
    expect(JSON.stringify(saved.layout)).toContain(
      '"sectionId":"pull-request"',
    );
    expect(JSON.stringify(saved.layout)).toContain(
      '"sectionId":"pipeline-runs"',
    );
    const savedActivity = collectLeaves(saved.layout.grid.root).find(
      (leaf) => leaf.groupId === DEFAULT_GROUP_IDS.activity,
    );
    expect(savedActivity.collapsed).toBeDefined();
    const savedTerminal = collectLeaves(saved.layout.grid.root).find(
      (leaf) => leaf.groupId === DEFAULT_GROUP_IDS.terminal,
    );
    expect(savedTerminal.collapsed?.edge).toBe('bottom');
    expect(savedTerminal.panels).toHaveLength(1);
    expect(savedTerminal.panels[0].kind).toBe('terminal');
    expect(savedTerminal.panels[0].title?.trim()).toBeTruthy();
    expect(savedTerminal.panels[0].instance).toBeUndefined();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('saving remaps an active chat group emptied by terminal deduplication', async () => {
  const apps = ['ts-pnpm-vite'];
  const branch = 'demo-main';
  const workspaceId = `demo-${apps[0]}`;
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-savedef-'));
  seedDemoWorkspaces({ userDataDir, apps });
  seedWorktreeChat({
    userDataDir,
    workspaceId,
    worktreeId: branch,
    providerType: 'claude',
    tabs: [{ id: SEEDED_CHAT_TAB_ID, title: 'Chat' }],
  });

  const worktreeDataDir = path.join(
    userDataDir,
    'workspaces',
    workspaceId,
    'worktree-data',
    branch,
  );
  mkdirSync(worktreeDataDir, { recursive: true });
  writeFileSync(
    path.join(worktreeDataDir, 'panel-layout.json'),
    JSON.stringify({
      version: 1,
      grid: {
        root: {
          type: 'branch',
          size: 1200,
          children: [
            {
              type: 'leaf',
              groupId: DEFAULT_GROUP_IDS.chat,
              size: 400,
              panels: [
                {
                  panelId: 'panel-terminal-placeholder',
                  kind: 'terminal',
                },
              ],
              activePanelId: 'panel-terminal-placeholder',
            },
            {
              type: 'leaf',
              groupId: 'group-chat-source',
              size: 400,
              panels: [
                {
                  panelId: `panel-chat-${SEEDED_CHAT_TAB_ID}`,
                  kind: 'chat',
                  title: 'Chat',
                  instance: { chatTabId: SEEDED_CHAT_TAB_ID },
                },
                {
                  panelId: 'panel-terminal-bound',
                  kind: 'terminal',
                  instance: { terminalId: 'terminal-session-1' },
                },
              ],
              activePanelId: `panel-chat-${SEEDED_CHAT_TAB_ID}`,
            },
            {
              type: 'leaf',
              groupId: DEFAULT_GROUP_IDS.activity,
              size: 400,
              panels: [{ panelId: 'panel-activity', kind: 'activity-section' }],
              activePanelId: 'panel-activity',
            },
          ],
        },
        orientation: 1,
        width: 1200,
        height: 800,
      },
      activeGroupId: 'group-chat-source',
      mostRecentActiveGroupIds: [
        'group-chat-source',
        DEFAULT_GROUP_IDS.activity,
      ],
    }),
    'utf8',
  );

  const { electronApp } = await launchCanopy({ userDataDir });
  const window = await electronApp.firstWindow();
  try {
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(branch);
    await expect(window.getByTestId('panel-grid-root')).toBeVisible();

    await window.getByTestId('worktree-top-save-layout-default').click();
    await window.getByTestId('save-layout-default-item').click();

    const defaultPath = path.join(userDataDir, 'default-panel-layout.json');
    await expect
      .poll(() => {
        try {
          return readFileSync(defaultPath, 'utf8');
        } catch {
          return '';
        }
      })
      .toContain('layout');
    const saved = JSON.parse(readFileSync(defaultPath, 'utf8'));
    const leaves = collectLeaves(saved.layout.grid.root);
    expect(
      leaves.find((leaf) => leaf.groupId === 'group-chat-source')?.panels,
    ).toEqual([]);
    expect(saved.layout.activeGroupId).toBe(DEFAULT_GROUP_IDS.chat);
    expect(saved.layout.mostRecentActiveGroupIds.slice(0, 2)).toEqual([
      DEFAULT_GROUP_IDS.chat,
      DEFAULT_GROUP_IDS.activity,
    ]);
    expect(saved.layout.mostRecentActiveGroupIds).not.toContain(
      'group-chat-source',
    );
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('a worktree with no layout adopts the saved default', async () => {
  // Two-phase seed: demo workspace + one fixed-id chat tab, plus a saved
  // default file whose activity group is collapsed. The worktree itself has NO
  // panel-layout.json, so first open must apply the saved default.
  const apps = ['ts-pnpm-vite'];
  const branch = 'demo-main';
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-savedef-'));
  seedDemoWorkspaces({ userDataDir, apps });
  seedWorktreeChat({
    userDataDir,
    workspaceId: `demo-${apps[0]}`,
    worktreeId: branch,
    providerType: 'claude',
    tabs: [{ id: SEEDED_CHAT_TAB_ID, title: 'Chat' }],
  });

  const defaultTemplate = {
    version: 1,
    layout: {
      version: 1,
      grid: {
        root: {
          type: 'branch',
          size: 1200,
          children: [
            {
              type: 'branch',
              size: 860,
              children: [
                {
                  type: 'leaf',
                  groupId: DEFAULT_GROUP_IDS.chat,
                  size: 700,
                  panels: [],
                  activePanelId: null,
                },
                {
                  type: 'leaf',
                  groupId: DEFAULT_GROUP_IDS.terminal,
                  size: 48,
                  panels: [
                    {
                      panelId: 'panel-terminal-template',
                      kind: 'terminal',
                      title: 'zsh',
                    },
                  ],
                  activePanelId: 'panel-terminal-template',
                  collapsed: { edge: 'bottom', expandedSize: 240 },
                },
              ],
            },
            {
              type: 'leaf',
              groupId: 'group-pull-request',
              size: 260,
              panels: [
                {
                  panelId: 'panel-pull-request',
                  kind: 'activity-card',
                  title: 'Pull requests',
                  instance: { sectionId: 'pull-request' },
                },
              ],
              activePanelId: 'panel-pull-request',
            },
            {
              type: 'leaf',
              groupId: 'group-pipeline-runs',
              size: 260,
              panels: [
                {
                  panelId: 'panel-pipeline-runs',
                  kind: 'activity-card',
                  title: 'Pipeline runs',
                  instance: { sectionId: 'pipeline-runs' },
                },
              ],
              activePanelId: 'panel-pipeline-runs',
            },
            {
              type: 'leaf',
              groupId: DEFAULT_GROUP_IDS.activity,
              size: 340,
              panels: [{ panelId: 'panel-activity', kind: 'activity-section' }],
              activePanelId: 'panel-activity',
              collapsed: { edge: 'right', expandedSize: 340 },
            },
          ],
        },
        orientation: 1,
        width: 1200,
        height: 800,
      },
      activeGroupId: DEFAULT_GROUP_IDS.chat,
      mostRecentActiveGroupIds: [DEFAULT_GROUP_IDS.chat],
    },
  };
  writeFileSync(
    path.join(userDataDir, 'default-panel-layout.json'),
    JSON.stringify(defaultTemplate, null, 2),
    'utf8',
  );

  const { electronApp } = await launchCanopy({ userDataDir });
  const window = await electronApp.firstWindow();
  try {
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(branch, {
      expandDefaultActivityRail: false,
    });
    await expect(window.getByTestId('panel-grid-root')).toBeVisible();

    // Adopted default: activity group and terminal drawer are collapsed, and
    // dedicated activity-card groups are preserved. The terminal placeholder
    // keeps its saved slot/title without reusing a source worktree session id.
    await expect
      .poll(async () => {
        const layout = await getLayout(window);
        if (!layout) return null;
        const leaves = collectLeaves(layout.root);
        const terminal = leaves.find(
          (leaf) => leaf.groupId === DEFAULT_GROUP_IDS.terminal,
        );
        const activity = leaves.find(
          (leaf) => leaf.groupId === DEFAULT_GROUP_IDS.activity,
        );
        if (!terminal || !activity) return 'not-applied';
        return {
          activity: activity.collapsed,
          terminal: terminal.collapsed,
          terminalKinds: terminal.panels.map((panel) => panel.kind),
          terminalIds: terminal.panels.map(
            (panel) => panel.instance?.terminalId ?? null,
          ),
        };
      })
      .toEqual({
        activity: 'right',
        terminal: 'bottom',
        terminalKinds: ['terminal'],
        terminalIds: [null],
      });

    await expect(
      window.getByTestId('panel-collapsed-tab-panel-terminal-template'),
    ).toHaveAttribute('aria-label', 'zsh');

    const applied = await getLayout(window);
    const activityCards = collectLeaves(applied.root)
      .flatMap((leaf) => leaf.panels)
      .filter((panel) => panel.kind === 'activity-card')
      .map((panel) => panel.instance?.sectionId)
      .sort();
    expect(activityCards).toEqual(['pipeline-runs', 'pull-request']);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
