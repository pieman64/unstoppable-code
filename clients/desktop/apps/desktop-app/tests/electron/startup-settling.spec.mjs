import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver, expandDefaultActivityRail } from './canopyApp.mjs';
import {
  cleanupDemoWorkspaces,
  seedDemoWorkspaces,
} from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { seedWorktreeChat, writeJson } from './seeders/index.mjs';

// Startup-settling behavior guard for performance work.
//
// This spec deliberately protects user-visible behavior rather than asserting
// timings. It is run against the unchanged implementation before an
// optimization, then against the candidate using the same fixture and
// assertions. Relative responsiveness is measured separately by
// tests/performance/startup-settle.

const WORKTREE_ID = 'demo-main';
const CREATED_AT = '2026-07-20T12:00:00.000Z';
const DRAFT_PREFIX = 'Startup input remains responsive while summaries load.';
const DRAFT_SUFFIX = ' No keystrokes were lost.';

const WORKSPACES = [
  {
    appId: 'ts-npm-next',
    id: 'demo-ts-npm-next',
    chatId: 'startup-next-chat',
    chatTitle: 'Next startup fallback title',
    summaryTitle: 'Next persisted startup summary',
    needsHydration: false,
  },
  {
    appId: 'ts-pnpm-vite',
    id: 'demo-ts-pnpm-vite',
    chatId: 'startup-vite-chat',
    chatTitle: 'Vite startup fallback title',
    summaryTitle: 'Vite persisted startup summary',
    needsHydration: true,
  },
  {
    appId: 'python-fastapi-uv',
    id: 'demo-python-fastapi-uv',
    chatId: 'startup-python-chat',
    chatTitle: 'Python startup fallback title',
    summaryTitle: null,
    needsHydration: false,
  },
];

function completedMessages(label) {
  const startedAt = Date.parse(CREATED_AT);
  return [
    {
      id: `${label}-user`,
      role: 'user',
      blocks: [{ type: 'text', text: `Investigate ${label} startup.` }],
      timestamp: startedAt,
    },
    {
      id: `${label}-assistant`,
      role: 'assistant',
      blocks: [{ type: 'text', text: `${label} startup is ready to inspect.` }],
      timestamp: startedAt + 10_000,
    },
    {
      id: `${label}-timer`,
      role: 'system',
      blocks: [
        {
          type: 'turn_timer',
          startedAt,
          completedAt: startedAt + 20_000,
        },
      ],
      timestamp: startedAt + 20_000,
    },
  ];
}

function seedSummary(userDataDir, workspace) {
  if (!workspace.summaryTitle) {
    return;
  }
  const summary = {
    title: workspace.summaryTitle,
    description: `Persisted summary for ${workspace.id}.`,
    highlights: [`Hydrated only for ${workspace.id}`],
    generatedAt: CREATED_AT,
    turnCountAtGeneration: 1,
    lastFullRefreshAt: CREATED_AT,
    lastFullRefreshTurnCount: 1,
  };
  writeJson(
    path.join(
      userDataDir,
      'workspaces',
      workspace.id,
      'summaries',
      `${WORKTREE_ID}.json`,
    ),
    {
      version: 2,
      summary,
      history: [
        {
          snapshotId: `startup-${workspace.appId}`,
          summary,
        },
      ],
    },
  );
}

function seedBadgeState(userDataDir, workspace) {
  const filePath = path.join(
    userDataDir,
    'workspaces',
    workspace.id,
    'worktrees.json',
  );
  const file = JSON.parse(readFileSync(filePath, 'utf8'));
  file.worktrees = file.worktrees.map((worktree) =>
    worktree.id === WORKTREE_ID
      ? {
          ...worktree,
          chatBadges: {
            version: 1,
            unreadChats: [],
            approvalChats: [],
            needsHydration: workspace.needsHydration,
            updatedAt: CREATED_AT,
          },
        }
      : worktree,
  );
  writeJson(filePath, file);
}

function seedStartupSettlingFixture() {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-startup-settling-'),
  );
  const seed = seedDemoWorkspaces({
    userDataDir,
    apps: WORKSPACES.map((workspace) => workspace.appId),
  });

  for (const workspace of WORKSPACES) {
    seedWorktreeChat({
      userDataDir,
      workspaceId: workspace.id,
      worktreeId: WORKTREE_ID,
      activeTabId: workspace.chatId,
      tabs: [
        {
          id: workspace.chatId,
          title: workspace.chatTitle,
          providerType: 'claude',
          messages: completedMessages(workspace.appId),
        },
      ],
    });
    seedSummary(userDataDir, workspace);
    seedBadgeState(userDataDir, workspace);
  }

  return { userDataDir, seed };
}

function worktreeRow(window, workspaceId) {
  return window.locator(
    `[data-testid="worktree-row"][data-project-id="${workspaceId}"][data-worktree-id="${WORKTREE_ID}"]`,
  );
}

async function selectWorkspaceWorktree(window, workspace) {
  const row = worktreeRow(window, workspace.id);
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.click();
  const chatPanel = window
    .locator('[data-testid="panel-content-chat"]:visible')
    .last();
  await expect(chatPanel).toHaveAttribute(
    'data-panel-id',
    `panel-chat-${workspace.chatId}`,
    { timeout: 30_000 },
  );
  await expect(chatPanel).toContainText(
    `${workspace.appId} startup is ready to inspect.`,
  );
}

async function expandSummarySection(window) {
  await expandDefaultActivityRail(window);
  const section = window.getByTestId('activity-summary-section');
  await expect(section).toBeVisible({ timeout: 30_000 });
  const expandButton = section.locator('[aria-label="Expand section"]');
  if (await expandButton.count()) {
    await expandButton.first().click();
  }
  return section;
}

test('startup settling preserves Home input and keyed lazy/eager summaries', async () => {
  test.setTimeout(180_000);
  const { userDataDir, seed } = seedStartupSettlingFixture();
  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });

    // Startup must remain on Home and accept a paced draft while eager/lazy
    // chat state and staggered summaries hydrate in the background.
    const home = window.getByTestId('page-home');
    await expect(home).toBeVisible();
    const editor = home.getByTestId('home-composer-editor');
    await editor.click();
    await editor.pressSequentially(DRAFT_PREFIX, { delay: 20 });
    await expect(editor).toContainText(DRAFT_PREFIX);

    const first = WORKSPACES[0];
    const eager = WORKSPACES[1];
    const missing = WORKSPACES[2];

    await app.openMainPage();
    await selectWorkspaceWorktree(window, first);
    let summarySection = await expandSummarySection(window);
    await expect(summarySection).toContainText(first.summaryTitle);
    await expect(summarySection).not.toContainText(eager.summaryTitle);

    // The eager-hydration worktree remains independently selectable and shows
    // only its keyed summary.
    await selectWorkspaceWorktree(window, eager);
    summarySection = await expandSummarySection(window);
    await expect(summarySection).toContainText(eager.summaryTitle);
    await expect(summarySection).not.toContainText(first.summaryTitle);

    // Switching back proves the previous store entry was retained rather than
    // overwritten by the later response.
    await selectWorkspaceWorktree(window, first);
    summarySection = await expandSummarySection(window);
    await expect(summarySection).toContainText(first.summaryTitle);
    await expect(summarySection).not.toContainText(eager.summaryTitle);

    // A missing summary must not inherit either previous worktree's value.
    await selectWorkspaceWorktree(window, missing);
    summarySection = await expandSummarySection(window);
    await expect(summarySection).toContainText('Generate summary');
    await expect(summarySection).not.toContainText(first.summaryTitle);
    await expect(summarySection).not.toContainText(eager.summaryTitle);

    // The current navigation contract clears a Home draft when the user
    // intentionally enters a worktree. That behavior is outside summary
    // hydration; returning Home must still produce an editable composer that
    // accepts every paced keystroke.
    await window.getByTestId('sidebar-create-task').click();
    await expect(home).toBeVisible();
    await editor.click();
    await editor.pressSequentially(DRAFT_SUFFIX, { delay: 20 });
    await expect(editor).toContainText(DRAFT_SUFFIX);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    cleanupDemoWorkspaces(seed);
  }
});
