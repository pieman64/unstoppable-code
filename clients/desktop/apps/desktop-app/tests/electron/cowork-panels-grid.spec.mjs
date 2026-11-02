// Cowork panel-grid cutover — the Cowork page renders the same VS Code-style
// panel grid as Code worktrees, keyed `(coworkWorkspaceId, 'home')`:
//
//   1. Dismissing the cold-start CTA mounts the grid with the shared default
//      arrangement (group-chat / group-terminal / group-activity) under the
//      git-free Cowork top bar; the E2E panel test API addresses the cowork
//      layout (LIFO install — the cowork page's install sits above the
//      always-mounted WorktreePart's).
//   2. The add-panel menu is surface-filtered: cowork offers the shared
//      workspace-item cards (notes/prompts/attachments) but never the
//      git-bound sections (changed-files / pull-request / scripts / hooks /
//      plans).
//   3. The top bar's New Chat routes through startNewChat(), which REUSES the
//      auto-provisioned empty chat instead of stacking blank tabs — the chat
//      group keeps exactly one bound chat panel.
//   4. Returning to Cowork from a code workspace opens the Work Entry that was
//      actually clicked: the page remount must not re-assert the retained
//      entry over the in-flight sidebar destination (REG-2842).

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import {
  backFromWorkflowEdit,
  CanopyAppDriver,
  discardWorkflowEditIfOpen,
} from './canopyApp.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { injectChatEvent } from './seeders/index.mjs';
import { openWorkEntryMenu } from './coworkWorkEntryDoneFixture.mjs';

function collectLeaves(node) {
  if (node.type === 'leaf') {
    return [node];
  }
  return node.children.flatMap((child) => collectLeaves(child));
}

function writeJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

test('New chat preserves empty entries customized in the sidebar or layout', async () => {
  test.setTimeout(120_000);
  const { electronApp, userDataDir } = await launchCanopy();
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openChatPage();
    await window.getByTestId('empty-new-chat').click();
    await expect(window.getByTestId('cowork-top-bar')).toBeVisible();
    const selected = window.locator(
      '[data-testid^="sidebar-work-entry-"][data-sidebar-selected-item]',
    );
    const firstTestId = await selected.getAttribute('data-testid');
    const firstId = firstTestId.replace('sidebar-work-entry-', '');
    const newChat = window.getByTestId('sidebar-section-chats-new-chat');
    // Opening and laying out the default grid does not customize the entry.
    await window.getByTestId('sidebar-section-chats').hover();
    await newChat.click();
    await expect(selected).toHaveAttribute('data-testid', firstTestId);

    await openWorkEntryMenu(window, firstId);
    await window.getByTestId(`${firstTestId}-rename`).click();
    const dialog = window.getByTestId(`${firstTestId}-rename-dialog`);
    await dialog.getByRole('textbox').fill('Research desk');
    await dialog.getByRole('button', { name: 'Rename', exact: true }).click();
    await expect(window.getByTestId(firstTestId)).toContainText(
      'Research desk',
    );
    await window.getByTestId('sidebar-section-chats').hover();
    await newChat.click();
    await expect(selected).not.toHaveAttribute('data-testid', firstTestId);
    await expect(window.getByTestId(firstTestId)).toContainText(
      'Research desk',
    );

    const secondTestId = await selected.getAttribute('data-testid');
    await window.getByTestId('panel-group-expand-group-activity').click();
    await expect(
      window.getByTestId('panel-content-activity-section'),
    ).toBeVisible();
    // The saved customization keeps this empty entry in the sidebar even
    // when navigation leaves it without using New chat.
    await window.waitForTimeout(700);
    await window.getByTestId(firstTestId).click();
    await expect(window.getByTestId(secondTestId)).toBeVisible();
    await window.getByTestId(secondTestId).click();
    // Click immediately: a layout edit inside the save debounce must count.
    await window.getByTestId('sidebar-section-chats').hover();
    await newChat.click();
    await expect(selected).not.toHaveAttribute('data-testid', secondTestId);
    await window.getByTestId(secondTestId).click();
    await expect(
      window.getByTestId('panel-content-activity-section'),
    ).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

/**
 * Ensures a cowork workspace row's work-entry list is expanded. Expansion is
 * the persisted `collapsed` flag (the fixture seeds `collapsed: false`, so
 * rows usually mount expanded) — only click the toggle when it reports
 * collapsed, since a blind click would collapse an expanded row.
 */
async function ensureWorkspaceRowExpanded(window, workspaceId) {
  const toggle = window.getByTestId(
    `sidebar-cowork-project-${workspaceId}-toggle`,
  );
  const expectedContent = window.getByTestId('sidebar-work-entry-entry-alpha');
  await expect(toggle.or(expectedContent).first()).toBeVisible();
  if ((await toggle.count()) > 0) {
    await expect(toggle).toBeVisible();
    if ((await toggle.getAttribute('aria-expanded')) !== 'true') {
      await toggle.click();
    }
  } else {
    // CAN-2672: a sole Cowork workspace has no toggle and is force-expanded.
    await expect(expectedContent).toBeVisible();
  }
}

const COWORK_WORKSPACE_INDEX_ENTRY = {
  id: 'cowork-default',
  name: 'Personal',
  type: 'cowork',
  color: '#7C9B6D',
  collapsed: false,
  order: 0,
  cowork: {
    createdAt: '2026-07-01T10:00:00.000Z',
    archiveRetentionDays: null,
  },
};

/**
 * Seeds a post-migration cowork workspace with two Work Entries, each holding
 * one chat with content (so neither is reusable-as-empty). Beta has the more
 * recent activity, so it sorts first and is auto-selected on activation.
 */
function seedWorkEntryFixture(userDataDir) {
  const wsDir = path.join(userDataDir, 'workspaces', 'cowork-default');

  writeJson(path.join(userDataDir, 'workspaces', 'index.json'), {
    version: 1,
    workspaces: [COWORK_WORKSPACE_INDEX_ENTRY],
  });

  writeJson(path.join(wsDir, 'work-entries.json'), {
    version: 1,
    entries: [
      { id: 'entry-alpha', createdAt: '2026-07-01T10:00:00.000Z' },
      { id: 'entry-beta', createdAt: '2026-07-02T10:00:00.000Z' },
    ],
  });

  const seedTab = (id, description, text, timestampIso) => ({
    id,
    title: 'New Chat',
    description,
    createdAt: timestampIso,
    kind: 'chat',
    messages: [
      {
        id: `${id}-m1`,
        role: 'user',
        blocks: [{ type: 'text', text }],
        timestamp: Date.parse(timestampIso),
      },
    ],
  });
  // Alpha's chat is flagged unread with an agent reply so the (unselected,
  // unhydrated) entry row shows the amber unread badge + hover preview
  // derived from the work-entries list meta.
  const alphaTab = seedTab(
    'chat-alpha',
    'Alpha planning session',
    'Draft the alpha plan.',
    '2026-07-01T10:05:00.000Z',
  );
  alphaTab.unread = true;
  alphaTab.messages.push({
    id: 'chat-alpha-m2',
    role: 'assistant',
    blocks: [{ type: 'text', text: 'Alpha plan drafted and ready.' }],
    timestamp: Date.parse('2026-07-01T10:06:00.000Z'),
  });
  writeJson(path.join(wsDir, 'chats', 'entry-alpha.json'), {
    version: 1,
    activeTabId: 'chat-alpha',
    tabs: [alphaTab],
  });
  writeJson(path.join(wsDir, 'chats', 'entry-beta.json'), {
    version: 1,
    activeTabId: 'chat-beta',
    tabs: [
      seedTab(
        'chat-beta',
        'Beta research session',
        'Collect the beta findings.',
        '2026-07-02T10:05:00.000Z',
      ),
    ],
  });
}

test('work entries list flat in the sidebar and isolate their chat sets', async ({}, testInfo) => {
  test.setTimeout(120_000);

  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-work-entries-'),
  );
  seedWorkEntryFixture(userDataDir);

  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });

    // Expand the workspace row: two flat entry rows, most recent first, and
    // NO date group headers (the old day-grouped chat list is gone).
    const workspaceRow = window.getByTestId(
      'sidebar-cowork-project-cowork-default',
    );
    await expect(workspaceRow).toBeVisible();
    await ensureWorkspaceRowExpanded(window, 'cowork-default');
    const betaRow = window.getByTestId('sidebar-work-entry-entry-beta');
    const alphaRow = window.getByTestId('sidebar-work-entry-entry-alpha');
    await expect(betaRow).toBeVisible({ timeout: 15_000 });
    await expect(alphaRow).toBeVisible();
    await expect(betaRow).toContainText('Beta research session');
    await expect(alphaRow).toContainText('Alpha planning session');
    for (const header of ['Today', 'Yesterday']) {
      await expect(workspaceRow.getByText(header, { exact: true })).toHaveCount(
        0,
      );
    }

    // Alpha's seeded chat is unread and the entry is not selected, so its
    // row swaps the chat icon for the amber unread badge (driven purely by
    // list-derived meta — no hydration). Hovering surfaces the preview
    // popover with the last agent response. Beta has no unread chats.
    const alphaUnread = window.getByTestId(
      'sidebar-work-entry-entry-alpha-unread',
    );
    await expect(alphaUnread).toBeVisible({ timeout: 15_000 });
    await expect(
      window.getByTestId('sidebar-work-entry-entry-beta-unread'),
    ).toHaveCount(0);
    await alphaUnread.hover();
    await expect(
      window.getByText('Alpha plan drafted and ready.'),
    ).toBeVisible();
    const railClearance = await alphaRow.evaluate((row) => {
      const title = row.querySelector('p');
      const actionRail = row
        .querySelector(
          '[data-testid="sidebar-work-entry-entry-alpha-delete-button"]',
        )
        ?.closest('.absolute');
      if (!title || !actionRail) {
        throw new Error('Expected cowork title and action rail');
      }
      return {
        reserved: Number.parseFloat(getComputedStyle(title).paddingRight),
        required:
          title.getBoundingClientRect().right -
          actionRail.getBoundingClientRect().left,
      };
    });
    expect(railClearance.reserved).toBeGreaterThanOrEqual(
      railClearance.required,
    );
    await workspaceRow.hover(); // move off the badge to dismiss the popover

    // Selecting the beta entry reveals ITS isolated grid: only beta's chat
    // tab and transcript are present.
    await betaRow.click();
    await expect(window.getByTestId('cowork-top-bar')).toBeVisible({
      timeout: 15_000,
    });
    const panelTabs = window.locator('[data-testid^="panel-tab-panel-chat-"]');
    await expect(
      panelTabs.filter({ hasText: 'Beta research session' }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      panelTabs.filter({ hasText: 'Alpha planning session' }),
    ).toHaveCount(0);
    await expect(
      window.getByText('Collect the beta findings.').first(),
    ).toBeVisible();

    // Switching to alpha swaps in the other entry's isolated chat set.
    await alphaRow.click();
    await expect(
      panelTabs.filter({ hasText: 'Alpha planning session' }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      panelTabs.filter({ hasText: 'Beta research session' }),
    ).toHaveCount(0);
    await expect(
      window.getByText('Draft the alpha plan.').first(),
    ).toBeVisible();

    // Opening alpha hydrates its chats and marks them read, clearing the
    // amber badge live.
    await expect(alphaUnread).toHaveCount(0);

    // The header "+" works like a code project's: it creates a new task and
    // opens its grid right away, so the first action can be a pipeline run
    // instead of a chat message. The new, still-empty task shows as the
    // selected sidebar row.
    // CAN-2363: the default cowork workspace has no row header of its own, so
    // its "+" is the Chats section header's.
    await window.getByTestId('sidebar-section-chats').hover();
    await window.getByTestId('sidebar-section-chats-new-chat').click();
    await expect(window.getByTestId('page-home')).toBeHidden();
    await expect(window.getByTestId('cowork-top-bar')).toBeVisible({
      timeout: 15_000,
    });
    const newTaskRow = window.locator(
      '[data-testid^="sidebar-work-entry-"][data-sidebar-selected-item]',
    );
    await expect(newTaskRow).toHaveCount(1, { timeout: 15_000 });
    // Neither seeded entry may be the selected row: the selection must be the
    // task the "+" just created.
    await expect(
      window.locator(
        '[data-testid="sidebar-work-entry-entry-alpha"][data-sidebar-selected-item], [data-testid="sidebar-work-entry-entry-beta"][data-sidebar-selected-item]',
      ),
    ).toHaveCount(0);
    await expect(
      panelTabs.filter({ hasText: 'Alpha planning session' }),
    ).toHaveCount(0);

    await window.screenshot({
      path: testInfo.outputPath('cowork-work-entries.png'),
    });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

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

test('cowork chat completion in a background work entry toasts, badges, and navigates', async () => {
  test.setTimeout(120_000);

  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-cowork-unread-toast-'),
  );
  seedWorkEntryFixture(userDataDir);

  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });

    await ensureWorkspaceRowExpanded(window, 'cowork-default');
    const alphaRow = window.getByTestId('sidebar-work-entry-entry-alpha');
    const alphaTitle = alphaRow.locator('p');
    const alphaUnread = window.getByTestId(
      'sidebar-work-entry-entry-alpha-unread',
    );
    const panelTabs = window.locator('[data-testid^="panel-tab-panel-chat-"]');

    // Cold-click alpha directly: page init used to auto-select the most
    // recent entry (beta) and clobber this click — the single-flight
    // preferred-entry initialize must land on alpha. Visiting alpha
    // hydrates its chats and clears the seeded unread; then switch to
    // beta — the user's scenario: watching another entry while alpha's
    // chat finishes in the background.
    await alphaRow.click();
    await expect(
      panelTabs.filter({ hasText: 'Alpha planning session' }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(alphaUnread).toHaveCount(0);
    await window.getByTestId('sidebar-work-entry-entry-beta').click();
    await expect(
      panelTabs.filter({ hasText: 'Beta research session' }),
    ).toBeVisible({ timeout: 15_000 });
    // Unselected + read: the alpha title is not bolded (selection also
    // bolds, so this is only checkable while beta is selected).
    await expect(alphaTitle).not.toHaveClass(/font-semibold/);

    // A completed turn in the (hydrated, non-visible) alpha entry: in-app
    // toast plus amber badge and bolded row title.
    await injectChatEvent(electronApp, {
      projectId: 'cowork-default',
      worktreeId: 'entry-alpha',
      chatId: 'chat-alpha',
      data: { type: 'result', is_error: false, result: 'Done' },
    });

    const toast = window
      .locator('div.pointer-events-auto', {
        hasText: 'Alpha planning session: Alpha plan drafted and ready.',
      })
      .filter({ has: window.locator('button[aria-label="Expand"]') });
    await expect(toast).toBeVisible({ timeout: 15_000 });
    await expect(alphaUnread).toBeVisible();
    // Unread state is carried by the blue indicator without changing the
    // canonical idle sidebar label typography inherited from the row: the text
    // color lives on the ROW container (unselected rows are fg-secondary) while
    // the title <p> itself carries no fg-* class.
    await expect(alphaTitle).toHaveClass(/font-normal/);
    await expect(alphaRow).toHaveClass(/fg-secondary/);
    await expect(alphaTitle).not.toHaveClass(/fg-(?:primary|secondary)/);

    // Clicking the toast routes to the cowork surface: alpha's chat set
    // becomes visible and viewing it clears the unread badge (the title
    // inherits the selected row foreground).
    await toast.click();
    await expect(
      panelTabs.filter({ hasText: 'Alpha planning session' }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(alphaUnread).toHaveCount(0);
    // Selected row styling: bg-muted + fg-primary on the row, not the title.
    await expect(alphaRow).toHaveClass(/fg-primary/);
    await expect(alphaTitle).not.toHaveClass(/fg-(?:primary|secondary)/);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('cowork chat output file mentions are clickable and Cmd+P searches project files', async ({}, testInfo) => {
  test.setTimeout(120_000);

  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-cowork-file-mention-'),
  );
  seedWorkEntryFixture(userDataDir);

  // A real file in the managed cowork home (the agent cwd), plus an
  // assistant message that references it by cwd-relative path — the same
  // shape worktree chats make clickable.
  const homeDir = path.join(
    userDataDir,
    'workspaces',
    'cowork-default',
    'home',
  );
  mkdirSync(path.join(homeDir, 'plans'), { recursive: true });
  writeFileSync(
    path.join(homeDir, 'plans', 'roadmap.md'),
    '# Roadmap\n\n- ship it\n',
    'utf8',
  );
  // A managed note, which is inside the workspace folder
  // (`home/.canopy/notes/...`) but surfaced by its own more specific file
  // root — it must appear exactly once in the Cmd+P list.
  mkdirSync(path.join(homeDir, '.canopy', 'notes'), { recursive: true });
  writeFileSync(
    path.join(homeDir, '.canopy', 'notes', 'release-notes.md'),
    '# Release notes\n',
    'utf8',
  );
  writeJson(
    path.join(
      userDataDir,
      'workspaces',
      'cowork-default',
      'chats',
      'entry-beta.json',
    ),
    {
      version: 1,
      activeTabId: 'chat-beta',
      tabs: [
        {
          id: 'chat-beta',
          title: 'New Chat',
          description: 'Beta research session',
          createdAt: '2026-07-02T10:05:00.000Z',
          kind: 'chat',
          messages: [
            {
              id: 'chat-beta-m1',
              role: 'user',
              blocks: [{ type: 'text', text: 'Where is the roadmap?' }],
              timestamp: Date.parse('2026-07-02T10:05:00.000Z'),
            },
            {
              id: 'chat-beta-m2',
              role: 'assistant',
              blocks: [
                {
                  type: 'text',
                  text: 'Open plans/roadmap.md to review the outline.',
                },
              ],
              timestamp: Date.parse('2026-07-02T10:06:00.000Z'),
            },
          ],
        },
      ],
    },
  );

  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });

    await ensureWorkspaceRowExpanded(window, 'cowork-default');
    await window.getByTestId('sidebar-work-entry-entry-beta').click();
    await expect(window.getByTestId('cowork-top-bar')).toBeVisible({
      timeout: 15_000,
    });

    // Cmd+P opens the file search palette ON the cowork page and finds the
    // indexed workspace file (this also proves the file index loads).
    await window.keyboard.press(
      process.platform === 'darwin' ? 'Meta+P' : 'Control+P',
    );
    const palette = window.getByTestId('file-search-palette');
    await expect(palette).toBeVisible();
    await expect(window.getByTestId('cowork-top-bar')).toBeVisible();
    await window.getByTestId('file-search-palette-input').fill('roadmap');
    const paletteResult = window
      .getByTestId('file-search-palette-result')
      .filter({ hasText: 'plans/roadmap.md' })
      .first();
    await expect(paletteResult).toBeVisible({ timeout: 30_000 });

    // Managed notes/prompts/attachments live inside the workspace folder but
    // are indexed by their own more specific roots — the workspace root's
    // scan excludes them, so the note appears exactly ONCE.
    await window
      .getByTestId('file-search-palette-input')
      .fill('release-notes.md');
    const noteResults = window
      .getByTestId('file-search-palette-result')
      .filter({ hasText: 'release-notes.md' });
    await expect(noteResults.first()).toBeVisible({ timeout: 15_000 });
    await expect(noteResults).toHaveCount(1);

    await window.keyboard.press('Escape');
    await expect(palette).toBeHidden();

    // The assistant message's cwd-relative path renders as a clickable file
    // mention; clicking opens the file panel BESIDE the chat group (same
    // placement contract as worktree chats).
    const targetPath = path.join(homeDir, 'plans', 'roadmap.md');
    const mention = window.getByRole('button', {
      name: 'Open plans/roadmap.md',
    });
    await expect(mention.first()).toBeVisible({ timeout: 15_000 });
    await mention.first().click();

    await expect
      .poll(
        async () => {
          const layout = await window.evaluate(() =>
            window.__canopyPanelTestApi
              ? window.__canopyPanelTestApi.getSerializedLayout()
              : null,
          );
          if (!layout) return null;
          const leaves = collectLeaves(layout.root);
          const fileLeaf = leaves.find((leaf) =>
            leaf.panels.some(
              (panel) =>
                panel.kind === 'file-diff' &&
                panel.instance?.filePath === targetPath,
            ),
          );
          if (!fileLeaf) return null;
          return {
            groupId: fileLeaf.groupId,
            besideChat: groupsShareImmediateBranch(
              layout.root,
              'group-chat',
              fileLeaf.groupId,
            ),
          };
        },
        { timeout: 15_000 },
      )
      .toMatchObject({ besideChat: true });

    await window.screenshot({
      path: testInfo.outputPath('cowork-file-mention.png'),
    });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('cowork page mounts the panel grid with surface-filtered panels', async ({}, testInfo) => {
  test.setTimeout(120_000);

  const { electronApp, userDataDir } = await launchCanopy();

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openChatPage();

    // Cold start → CTA → grid.
    const cta = window.getByTestId('empty-new-chat');
    await expect(cta).toBeVisible({ timeout: 15_000 });
    await cta.click();
    await expect(window.getByTestId('cowork-top-bar')).toBeVisible({
      timeout: 15_000,
    });

    // The default layout mounts with the stable shared group ids and one
    // instance-bound chat panel. The new Work Entry installs the test API
    // before it ensures its layout, so that gap reads as "not yet".
    await expect
      .poll(async () =>
        window.evaluate(() => {
          const api = window.__canopyPanelTestApi;
          if (!api) return null;
          try {
            return api.getSerializedLayout().root.type;
          } catch (error) {
            if (
              error instanceof Error &&
              error.message.includes('No panel layout for worktree')
            ) {
              return null;
            }
            throw error;
          }
        }),
      )
      .not.toBeNull();
    const layout = await window.evaluate(() =>
      window.__canopyPanelTestApi.getSerializedLayout(),
    );
    const leaves = collectLeaves(layout.root);
    const groupIds = leaves.map((leaf) => leaf.groupId).sort();
    expect(groupIds).toEqual([
      'group-activity',
      'group-chat',
      'group-terminal',
    ]);
    const chatLeaf = leaves.find((leaf) => leaf.groupId === 'group-chat');
    expect(chatLeaf.panels).toHaveLength(1);
    expect(chatLeaf.panels[0].kind).toBe('chat');

    // CAN-2836: Cowork reaches the same fallback seeder as Code through the
    // real StandaloneChatPage -> PanelGridSurface path. Its activity rail is
    // therefore hidden by default, but remains in the tree and reopens from
    // the right-edge collapsed bar.
    const activityLeaf = leaves.find(
      (leaf) => leaf.groupId === 'group-activity',
    );
    expect(activityLeaf.panels).toEqual([
      expect.objectContaining({ kind: 'activity-section' }),
    ]);
    expect(activityLeaf.collapsed).toBe('right');
    const activityGroup = window.getByTestId('panel-group-group-activity');
    const activityCollapsedBar = activityGroup.getByTestId(
      'panel-collapsed-bar-group-activity',
    );
    await expect(activityCollapsedBar).toBeVisible();
    await expect(activityCollapsedBar).toHaveAttribute('data-edge', 'right');
    await activityGroup
      .getByTestId('panel-group-expand-group-activity')
      .click();
    await expect(
      activityGroup.getByTestId('panel-content-activity-section'),
    ).toBeVisible();

    // New Chat reuses the existing empty chat: still exactly one chat panel.
    // (The affordance moved from the top bar to the tab strip's `+`.)
    await window.getByTestId('panel-add-tab-group-chat').click();
    await window.getByTestId('panel-add-menu-item-new-chat').click();
    await window.waitForTimeout(500);
    const layoutAfterNewChat = await window.evaluate(() =>
      window.__canopyPanelTestApi.getSerializedLayout(),
    );
    const chatLeafAfter = collectLeaves(layoutAfterNewChat.root).find(
      (leaf) => leaf.groupId === 'group-chat',
    );
    expect(chatLeafAfter.panels).toHaveLength(1);

    // Surface-filtered add-panel menu: workspace-item cards present,
    // git-bound sections absent.
    await window.getByTestId('panel-add-tab-group-chat').click();
    const addMenu = window.getByTestId('panel-add-menu');
    await expect(addMenu).toBeVisible();
    for (const present of [
      'panel-add-menu-item-activity-card-memory',
      'panel-add-menu-item-activity-card-notes',
      'panel-add-menu-item-activity-card-prompts',
      'panel-add-menu-item-activity-card-attachments',
      'panel-add-menu-item-activity-card-pipeline-runs',
      'panel-add-menu-item-activity-card-summary',
      'panel-add-menu-item-browser',
      'panel-add-menu-item-file-explorer',
      // Workspace-scoped panel groups are offered on Cowork too (their
      // variants live behind nested submenu rows, same UX as Usage).
      'panel-add-menu-usage-submenu',
      'panel-add-menu-automations-submenu',
    ]) {
      await expect(addMenu.getByTestId(present)).toBeVisible();
    }
    for (const absent of [
      'panel-add-menu-item-activity-card-changed-files',
      'panel-add-menu-item-activity-card-pull-request',
      'panel-add-menu-item-activity-card-scripts',
      'panel-add-menu-item-activity-card-hooks',
      'panel-add-menu-item-activity-card-plans',
    ]) {
      await expect(addMenu.getByTestId(absent)).toHaveCount(0);
    }

    // Cowork can add the full Automations panel. Its shared toolbar omits the
    // code-only worktree toggle but keeps Add, which opens creation already
    // targeted to the current cowork workspace.
    await addMenu.getByTestId('panel-add-menu-automations-submenu').click();
    const automationsGroup = window.getByTestId(
      'panel-add-menu-automations-group',
    );
    await expect(automationsGroup).toBeVisible();
    await automationsGroup
      .getByTestId('panel-add-menu-item-automations-full')
      .click();
    const automationsPanel = window.locator(
      '[data-testid="automations-panel"][data-variant="full"]',
    );
    await expect(automationsPanel).toBeVisible();
    await expect(
      automationsPanel.getByTestId('automations-panel-worktree-toggle'),
    ).toHaveCount(0);
    // Add opens a seeded draft in the Workflows edit shell (CAN-4072).
    await automationsPanel.getByTestId('automations-panel-add').click();
    const automationShell = window.getByTestId('workflow-edit-shell');
    await expect(automationShell).toBeVisible();
    await expect(automationShell).toHaveAttribute(
      'aria-label',
      'New automation',
    );
    const automationForm = automationShell.getByTestId(
      'workflow-edit-section-definition',
    );
    await expect(
      automationForm.getByTestId('automations-form-workspace'),
    ).toContainText('Chats');
    await expect(
      automationForm.getByTestId('automations-form-run-in-new_chat'),
    ).toHaveAttribute('aria-checked', 'true');
    // The untouched seeded draft is clean, so Back leaves without asking;
    // then return to the cowork chat.
    await backFromWorkflowEdit(window);
    await app.openChatPage();
    await expect(window.getByTestId('cowork-top-bar')).toBeVisible({
      timeout: 15_000,
    });

    // Opening the file explorer shows the cowork folder as the primary root,
    // named for the project and expanded on first open (formerly mislabeled
    // "artifacts", then "Workspace"). The notes/prompts roots sit under the
    // collapsed brand group. Assert by root identity, not by a fixed label.
    await window.getByTestId('panel-add-tab-group-chat').click();
    await expect(addMenu).toBeVisible();
    await addMenu.getByTestId('panel-add-menu-item-file-explorer').click();
    await expect(addMenu).toBeHidden();
    const filesTree = window.getByTestId('files-tree-tab');
    await expect(filesTree).toBeVisible({ timeout: 15_000 });
    const coworkRoot = filesTree.locator(
      '[data-testid="files-tree-folder"][data-path=""][data-file-tree-id="workspace:"]',
    );
    await expect(coworkRoot).toBeVisible({ timeout: 15_000 });
    await expect(coworkRoot).toHaveAttribute('aria-expanded', 'true');
    await expect(coworkRoot).not.toHaveText(/^\W*Workspace$/);
    await expect(
      filesTree.getByTestId('files-tree-root-group'),
    ).toHaveAttribute('aria-expanded', 'false');
    await expect(filesTree.getByText('artifacts', { exact: true })).toHaveCount(
      0,
    );

    // Git-free top bar: no PR status bar, and the layout dropdown saves the
    // Cowork-surface default.
    await expect(window.getByTestId('pr-status-bar')).toHaveCount(0);
    await expect(
      window.getByTestId('worktree-top-save-layout-default'),
    ).toBeVisible();

    await window.screenshot({
      path: testInfo.outputPath('cowork-panels-grid.png'),
    });
  } finally {
    await discardWorkflowEditIfOpen(electronApp);
    await closeCanopy(electronApp, userDataDir);
  }
});

const CODE_WORKSPACE_ID = 'code-workspace';
const CODE_WORKSPACE_NAME = 'Code Project';
const CODE_WORKTREE_ID = 'code-feature';

function git(cwd, args) {
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * Adds one real single-repo code workspace (git repo plus a single worktree)
 * beside the cowork fixture, so a test can leave the Cowork page for the Code
 * surface and come back. Preserve the cowork entry when adding the code
 * workspace so the final index remains authoritative for both projects.
 */
function seedCodeWorkspaceFixture(userDataDir) {
  const repoPath = path.join(userDataDir, 'code-repo');
  mkdirSync(repoPath, { recursive: true });
  git(repoPath, ['init', '--initial-branch=main']);
  git(repoPath, ['config', 'user.email', 'test@example.com']);
  git(repoPath, ['config', 'user.name', 'Canopy Test']);
  writeFileSync(path.join(repoPath, 'README.md'), 'code project\n', 'utf8');
  git(repoPath, ['add', 'README.md']);
  git(repoPath, ['commit', '-m', 'initial']);

  const workspaceDir = path.join(userDataDir, 'workspaces', CODE_WORKSPACE_ID);
  git(repoPath, [
    'worktree',
    'add',
    '-b',
    CODE_WORKTREE_ID,
    path.join(workspaceDir, 'worktrees', CODE_WORKTREE_ID),
  ]);

  writeJson(path.join(userDataDir, 'workspaces', 'index.json'), {
    version: 1,
    workspaces: [
      COWORK_WORKSPACE_INDEX_ENTRY,
      {
        id: CODE_WORKSPACE_ID,
        name: CODE_WORKSPACE_NAME,
        type: 'single-repo',
        color: '#38BDF8',
        collapsed: false,
        order: 1,
      },
    ],
  });
  writeJson(path.join(workspaceDir, 'workspace.json'), {
    version: 1,
    type: 'single-repo',
    repoPath,
    repos: [],
    alwaysShow: true,
  });
  writeJson(path.join(workspaceDir, 'worktrees.json'), {
    version: 1,
    worktrees: [
      {
        id: CODE_WORKTREE_ID,
        branchName: CODE_WORKTREE_ID,
        createdAt: '2026-07-01T09:00:00.000Z',
      },
    ],
  });
}

test('opening a cowork work entry after a code project detour selects the clicked entry', async ({}, testInfo) => {
  test.setTimeout(120_000);

  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-cowork-entry-race-'),
  );
  seedWorkEntryFixture(userDataDir);
  seedCodeWorkspaceFixture(userDataDir);

  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });

    await ensureWorkspaceRowExpanded(window, 'cowork-default');
    const alphaRow = window.getByTestId('sidebar-work-entry-entry-alpha');
    const betaRow = window.getByTestId('sidebar-work-entry-entry-beta');
    await expect(alphaRow).toBeVisible({ timeout: 15_000 });
    await expect(betaRow).toBeVisible();
    const panelTabs = window.locator('[data-testid^="panel-tab-panel-chat-"]');

    // 1. Open cowork Work Entry alpha.
    await alphaRow.click();
    await expect(
      panelTabs.filter({ hasText: 'Alpha planning session' }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(alphaRow).toHaveAttribute('data-sidebar-selected-item', '');

    // 2. Detour through the Code surface. This unmounts the Cowork page and
    //    leaves chatStore selecting the code worktree while the cowork store
    //    still retains alpha as its active entry.
    await app.selectWorktree(CODE_WORKTREE_ID);
    await app.expectMainPage();
    await expect(window.getByTestId('page-chat')).toHaveCount(0);

    // 3. Open the OTHER cowork Work Entry. The Cowork page remounts while
    //    beta's selection is still awaiting tab hydration, so an unconditional
    //    re-assert of the retained entry would reopen alpha (REG-2842).
    await betaRow.click();
    await app.expectChatPage();
    await expect(
      panelTabs.filter({ hasText: 'Beta research session' }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      panelTabs.filter({ hasText: 'Alpha planning session' }),
    ).toHaveCount(0);
    await expect(
      window.getByText('Collect the beta findings.').first(),
    ).toBeVisible();
    await expect(betaRow).toHaveAttribute('data-sidebar-selected-item', '');
    await expect(alphaRow).not.toHaveAttribute(
      'data-sidebar-selected-item',
      '',
    );

    await window.screenshot({
      path: testInfo.outputPath('cowork-entry-after-code-detour.png'),
    });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

/**
 * Seeds two Cowork projects: "Personal" with one past task, and an empty
 * "Analysis pipeline". Mirrors the fixture that first caught the cold-start
 * regression: the "+" on the inactive project was a no-op because the store's
 * lazy initialize superseded the create's own destination generation.
 */
function seedTwoCoworkProjects(userDataDir) {
  const workspacesDir = path.join(userDataDir, 'workspaces');
  writeJson(path.join(workspacesDir, 'index.json'), {
    version: 1,
    workspaces: [
      {
        id: 'cowork-default',
        name: 'Personal',
        type: 'cowork',
        color: '#7C9B6D',
        collapsed: false,
        order: 0,
        cowork: {
          createdAt: '2026-07-01T10:00:00.000Z',
          archiveRetentionDays: null,
        },
      },
      {
        id: 'cowork-analysis',
        name: 'Analysis pipeline',
        type: 'cowork',
        color: '#B0476B',
        collapsed: false,
        order: 1,
        cowork: {
          createdAt: '2026-07-02T10:00:00.000Z',
          archiveRetentionDays: null,
        },
      },
    ],
  });
  for (const [workspaceId, createdAt] of [
    ['cowork-default', '2026-07-01T10:00:00.000Z'],
    ['cowork-analysis', '2026-07-02T10:00:00.000Z'],
  ]) {
    // A Cowork workspace.json carries no `repos` (docs/cowork-workspaces.md):
    // seed the shape the product actually writes.
    writeJson(path.join(workspacesDir, workspaceId, 'workspace.json'), {
      version: 1,
      type: 'cowork',
      cowork: { createdAt, archiveRetentionDays: null },
    });
  }
  const personalDir = path.join(workspacesDir, 'cowork-default');
  writeJson(path.join(personalDir, 'work-entries.json'), {
    version: 1,
    entries: [{ id: 'entry-alpha', createdAt: '2026-07-01T10:00:00.000Z' }],
  });
  writeJson(path.join(personalDir, 'chats', 'entry-alpha.json'), {
    version: 1,
    activeTabId: 'chat-alpha',
    tabs: [
      {
        id: 'chat-alpha',
        title: 'New Chat',
        description: 'Weekly metrics summary',
        createdAt: '2026-07-01T10:05:00.000Z',
        kind: 'chat',
        messages: [
          {
            id: 'chat-alpha-m1',
            role: 'user',
            blocks: [{ type: 'text', text: 'Summarize the weekly metrics.' }],
            timestamp: Date.parse('2026-07-01T10:05:00.000Z'),
          },
        ],
      },
    ],
  });
  writeJson(path.join(workspacesDir, 'cowork-analysis', 'work-entries.json'), {
    version: 1,
    entries: [],
  });
}

test('the "+" on an inactive Cowork project opens a new task there, from a cold start', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-cowork-plus-inactive-'),
  );
  seedTwoCoworkProjects(userDataDir);
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });

    // Straight from the New task page, before any Cowork page has mounted,
    // so the store has not initialized yet.
    await expect(window.getByTestId('page-home')).toBeVisible();
    const header = window.getByTestId(
      'sidebar-cowork-project-cowork-analysis-header',
    );
    await expect(header).toBeVisible({ timeout: 15_000 });
    await header.hover();
    await window
      .getByTestId('sidebar-cowork-project-cowork-analysis-new-chat')
      .click();

    // Lands in the new task's grid under the project that was clicked, with
    // that task as the selected row — never Personal's task.
    await expect(window.getByTestId('cowork-top-bar')).toBeVisible({
      timeout: 15_000,
    });
    await expect(window.getByTestId('page-home')).toBeHidden();
    const selectedRow = window.locator(
      '[data-testid^="sidebar-work-entry-"][data-sidebar-selected-item]',
    );
    await expect(selectedRow).toHaveCount(1, { timeout: 15_000 });
    await expect(
      window.locator(
        '[data-testid="sidebar-work-entry-entry-alpha"][data-sidebar-selected-item]',
      ),
    ).toHaveCount(0);
    // Exactly one in-flow entry row under the clicked project: the new task.
    // (Row parts share the testid prefix; only rows carry the chat-id mark.)
    await expect(
      window
        .getByTestId('sidebar-cowork-project-cowork-analysis')
        .locator('[data-standalone-chat-id]'),
    ).toHaveCount(1);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

/**
 * One Cowork project and no messages anywhere: the first-time, pipeline-first
 * user. StandaloneChatPage shows its cold-start CTA while
 * `chatProjectCount <= 1 && !hasChatActivity`, and a freshly created task has
 * no `lastMessageAt`, so the "+" must dismiss that CTA itself.
 */
function seedSingleEmptyCoworkProject(userDataDir) {
  const workspacesDir = path.join(userDataDir, 'workspaces');
  writeJson(path.join(workspacesDir, 'index.json'), {
    version: 1,
    workspaces: [
      {
        id: 'cowork-default',
        name: 'Personal',
        type: 'cowork',
        color: '#7C9B6D',
        collapsed: false,
        order: 0,
        cowork: {
          createdAt: '2026-07-01T10:00:00.000Z',
          archiveRetentionDays: null,
        },
      },
    ],
  });
  writeJson(path.join(workspacesDir, 'cowork-default', 'workspace.json'), {
    version: 1,
    type: 'cowork',
    cowork: {
      createdAt: '2026-07-01T10:00:00.000Z',
      archiveRetentionDays: null,
    },
  });
  writeJson(path.join(workspacesDir, 'cowork-default', 'work-entries.json'), {
    version: 1,
    entries: [],
  });
}

test('the "+" on a sole Cowork project with no messages opens the task, not the cold-start screen', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-cowork-plus-first-run-'),
  );
  seedSingleEmptyCoworkProject(userDataDir);
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });

    await expect(window.getByTestId('page-home')).toBeVisible();
    // CAN-2363: the default cowork workspace is not a row in the Projects
    // list, so its "+" is the Chats section header's.
    await window.getByTestId('sidebar-section-chats').hover();
    await window.getByTestId('sidebar-section-chats-new-chat').click();

    // The new task's grid, ready for a pipeline run before any message —
    // never the first-run "New chat" screen.
    await expect(window.getByTestId('cowork-top-bar')).toBeVisible({
      timeout: 15_000,
    });
    await expect(window.getByTestId('cowork-empty-state')).toHaveCount(0);
    await expect(window.getByTestId('page-home')).toBeHidden();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('the Cowork "+" opens a new task after the user has left the chat page', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-cowork-plus-return-'),
  );
  seedWorkEntryFixture(userDataDir);
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });

    // Open an existing task first, so the Cowork store is initialized and this
    // project is the active one.
    await ensureWorkspaceRowExpanded(window, 'cowork-default');
    await window.getByTestId('sidebar-work-entry-entry-beta').click();
    await expect(window.getByTestId('cowork-top-bar')).toBeVisible({
      timeout: 15_000,
    });

    // Leave the chat page, the way most users reach the "+": leaving clears
    // the chat selection, and returning remounts the page, which puts the
    // retained entry back.
    await window.getByTestId('sidebar-create-task').click();
    await expect(window.getByTestId('page-home')).toBeVisible();
    // CAN-2363: the default cowork workspace is not a row in the Projects
    // list, so its "+" is the Chats section header's.
    await window.getByTestId('sidebar-section-chats').hover();
    await window.getByTestId('sidebar-section-chats-new-chat').click();

    // A new task is open and selected — never the task that was open before.
    await expect(window.getByTestId('cowork-top-bar')).toBeVisible({
      timeout: 15_000,
    });
    await expect(
      window.locator(
        '[data-testid^="sidebar-work-entry-"][data-sidebar-selected-item]',
      ),
    ).toHaveCount(1, { timeout: 15_000 });
    await expect(
      window.locator(
        '[data-testid="sidebar-work-entry-entry-alpha"][data-sidebar-selected-item], [data-testid="sidebar-work-entry-entry-beta"][data-sidebar-selected-item]',
      ),
    ).toHaveCount(0, { timeout: 15_000 });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
