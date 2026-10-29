import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  collectLeaves,
  DEFAULT_GROUP_IDS,
  getLayout,
  waitForPanelLayout,
} from './panelHarness.mjs';
import { seedWorktreeChat } from './seeders/seedWorktreeChat.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const CHAT_TAB_ID = 'file-mention-origin-chat';
const TARGET_RELATIVE_PATH = 'src/status.ts';
const ASSISTANT_RELATIVE_PATH = 'README.md';

function containsGroup(node, groupId) {
  if (!node) {
    return false;
  }
  if (node.type === 'leaf') {
    return node.groupId === groupId;
  }
  return node.children.some((child) => containsGroup(child, groupId));
}

function groupsShareImmediateBranch(node, leftGroupId, rightGroupId) {
  if (!node || node.type === 'leaf') {
    return false;
  }
  const hasLeft = node.children.some((child) =>
    containsGroup(child, leftGroupId),
  );
  const hasRight = node.children.some((child) =>
    containsGroup(child, rightGroupId),
  );
  if (hasLeft && hasRight) {
    return true;
  }
  return node.children.some((child) =>
    groupsShareImmediateBranch(child, leftGroupId, rightGroupId),
  );
}

test('chat history makes user and assistant file mentions clickable without opening file search', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-file-mention-panel-'),
  );
  const demoSeed = seedDemoWorkspaces({
    userDataDir,
    apps: ['ts-pnpm-vite'],
  });
  const worktreePath = demoSeed.workspaces[0]?.worktreePath;
  expect(worktreePath, 'seeded worktree path').toBeTruthy();

  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    activeTabId: CHAT_TAB_ID,
    tabs: [
      {
        id: CHAT_TAB_ID,
        title: 'File Mention Origin',
        messages: [
          {
            id: 'file-mention-user',
            role: 'user',
            blocks: [
              {
                type: 'text',
                text: `Please compare ${TARGET_RELATIVE_PATH}.`,
              },
            ],
            timestamp: Date.parse('2026-04-10T11:59:00.000Z'),
          },
          {
            id: 'file-mention-assistant',
            role: 'assistant',
            blocks: [
              {
                type: 'text',
                text: `**Open ${ASSISTANT_RELATIVE_PATH}** to inspect the placement.`,
              },
            ],
            timestamp: Date.parse('2026-04-10T12:00:00.000Z'),
          },
        ],
      },
    ],
  });

  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);

    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID, {
      expandDefaultActivityRail: false,
    });

    const chatPanel = window.locator(
      `[data-testid="panel-content-chat"][data-panel-id="panel-chat-${CHAT_TAB_ID}"]`,
    );
    await expect(chatPanel).toBeVisible();

    // This is the regression boundary: the transcript must load the file
    // index itself. Opening Cmd+P or an `@` menu here would mask a missing
    // transcript-owned load by warming the same shared index.
    const userMention = chatPanel
      .locator('[data-role="user"]')
      .getByRole('button', {
        name: `Open ${TARGET_RELATIVE_PATH}`,
      });
    await expect(userMention).toBeVisible({ timeout: 30_000 });
    await userMention.click();

    const userTargetPath = path.join(worktreePath, TARGET_RELATIVE_PATH);
    await expect
      .poll(
        async () => {
          const layout = await getLayout(window);
          return collectLeaves(layout?.root).some((leaf) =>
            leaf.panels.some(
              (panel) =>
                panel.kind === 'file-diff' &&
                panel.instance?.filePath === userTargetPath,
            ),
          );
        },
        { timeout: 15_000 },
      )
      .toBe(true);

    const collapsedLayout = await getLayout(window);
    const collapsedActivity = collectLeaves(collapsedLayout.root).find(
      (leaf) => leaf.groupId === DEFAULT_GROUP_IDS.activity,
    );
    expect(collapsedActivity?.collapsed).toBe('right');

    const mention = chatPanel.getByRole('button', {
      name: `Open ${ASSISTANT_RELATIVE_PATH}`,
    });
    await expect(mention).toBeVisible();
    await expect(mention.locator('xpath=ancestor::strong')).toHaveCount(1);
    await mention.click();

    const targetPath = path.join(worktreePath, ASSISTANT_RELATIVE_PATH);
    await expect
      .poll(
        async () => {
          const layout = await getLayout(window);
          const leaves = collectLeaves(layout?.root);
          return leaves
            .flatMap((leaf) =>
              leaf.panels.map((panel) => ({
                groupId: leaf.groupId,
                kind: panel.kind,
                filePath: panel.instance?.filePath ?? null,
              })),
            )
            .find(
              (panel) =>
                panel.kind === 'file-diff' && panel.filePath === targetPath,
            );
        },
        { timeout: 15_000 },
      )
      .toBeTruthy();

    const layout = await getLayout(window);
    const leaves = collectLeaves(layout.root);
    const fileLeaf = leaves.find((leaf) =>
      leaf.panels.some(
        (panel) =>
          panel.kind === 'file-diff' && panel.instance?.filePath === targetPath,
      ),
    );
    expect(fileLeaf, 'file mention opened a file-diff panel').toBeTruthy();
    expect(fileLeaf.groupId).not.toBe(DEFAULT_GROUP_IDS.chat);
    expect(
      groupsShareImmediateBranch(
        layout.root,
        DEFAULT_GROUP_IDS.chat,
        fileLeaf.groupId,
      ),
    ).toBe(true);

    await expect(
      window.locator(
        `[data-testid="panel-content-file-diff"][data-panel-id="${fileLeaf.activePanelId}"]`,
      ),
    ).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('failed browser sibling insertion restores the full-height right rail', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-browser-panel-rollback-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    activeTabId: CHAT_TAB_ID,
    tabs: [{ id: CHAT_TAB_ID, title: 'Browser Origin' }],
  });

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);

    const before = await waitForPanelLayout(window, {
      requiredGroupIds: [
        DEFAULT_GROUP_IDS.chat,
        DEFAULT_GROUP_IDS.terminal,
        DEFAULT_GROUP_IDS.activity,
      ],
    });
    const beforeLeaves = collectLeaves(before.root);
    expect(
      beforeLeaves.find((leaf) => leaf.groupId === DEFAULT_GROUP_IDS.activity)
        ?.collapsed,
    ).toBe(null);

    const activated = await window.evaluate(
      async ({ browserId, chatTabId }) =>
        window.__canopyPanelTestApi.requestBrowserPanel(
          browserId,
          chatTabId,
          true,
        ),
      { browserId: 'rollback-browser', chatTabId: CHAT_TAB_ID },
    );
    expect(activated).toBe(false);

    const after = await waitForPanelLayout(window, {
      requiredGroupIds: beforeLeaves.map((leaf) => leaf.groupId),
    });
    const afterLeaves = collectLeaves(after.root);
    expect(afterLeaves).toHaveLength(beforeLeaves.length);
    expect(
      afterLeaves.find((leaf) => leaf.groupId === DEFAULT_GROUP_IDS.activity)
        ?.collapsed,
    ).toBe(null);
    await expect(
      window.getByTestId(`panel-group-${DEFAULT_GROUP_IDS.activity}`),
    ).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
