// Durable UI automation for the sidebar's pending-tool-approval affordance.
//
// A tool-approval prompt used to have NO sidebar signal at all: the row kept
// the ordinary "Working" spinner, so a chat parked on a prompt looked exactly
// like a healthy agent and the user had no reason to go look. The row now
// shows the needs-input orange dot and drops the spinner, and the chat tab
// marks WHICH chat is blocked.
//
// The approval is injected LIVE rather than pre-seeded in the persisted
// `ChatTabsFile`: hydration discards any persisted approval whose `requestId`
// has no matching entry in the main process's pending-approval registry, and
// a fresh Electron process always starts with that registry empty. See
// `tool-approval-interactions.spec.mjs` for the full reasoning.
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { writeJson } from './seeders/fsHelpers.mjs';
import { seedWorktreeChat } from './seeders/seedWorktreeChat.mjs';
import { injectApprovalRequestEvent } from './seeders/injectApprovalRequestEvent.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const CHAT_ID = 'approval-blocked-chat';

test('a pending tool approval replaces the sidebar working spinner with the needs-input dot', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-sidebar-tool-approval-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    activeTabId: CHAT_ID,
    tabs: [{ id: CHAT_ID, title: 'Approval Blocked', status: 'streaming' }],
  });

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();

    const row = window.locator(
      `[data-testid="worktree-row"][data-branch="${WORKTREE_ID}"]`,
    );
    await expect(row).toBeVisible({ timeout: 15_000 });
    // Baseline: nothing is asking for the user yet.
    await expect(row.getByTestId('worktree-row-tool-approval')).toHaveCount(0);

    await injectApprovalRequestEvent(electronApp, {
      requestId: 'sidebar-approval-1',
      projectId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      chatId: CHAT_ID,
      provider: 'claude',
      title: 'Run a command',
      details: { kind: 'command', command: 'npm run build' },
    });

    const dot = row.getByTestId('worktree-row-tool-approval');
    await expect(dot).toBeVisible({ timeout: 15_000 });
    await expect(dot).toHaveAttribute('aria-label', 'Approval needed');
    // The working spinner never co-renders with it: an approval-blocked chat
    // is parked on the user, so the row must not also read as progressing.
    // (The derivation rule itself is pinned in
    // `components/sidebar/__tests__/chatBadgeKeys.test.ts`.)
    await expect(
      row.getByTestId('worktree-row-classic-streaming-spinner'),
    ).toHaveCount(0);
    // Focusing the dot names the chat and the specific thing being asked
    // for, so the user can judge it without opening the worktree. Focus
    // rather than hover: the row's drag overlay sits above the status rail
    // and swallows pointer events, and the dot opens the popover on either.
    // Home's Continue row also names the chat, so read the popover itself.
    await dot.focus();
    const heading = window.getByText('Approval needed');
    await expect(heading).toBeVisible({ timeout: 15_000 });
    const popover = heading.locator('..');
    await expect(popover.getByText('Approval Blocked')).toBeVisible();
    await expect(popover.getByText('npm run build')).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('the blocked chat is marked in the tab bar once the worktree is opened', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-tab-tool-approval-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    activeTabId: 'idle-chat',
    tabs: [
      { id: 'idle-chat', title: 'Unrelated' },
      { id: CHAT_ID, title: 'Approval Blocked', status: 'streaming' },
    ],
  });

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    await expect(
      window.getByTestId('panel-content-chat').first(),
    ).toBeVisible();

    await injectApprovalRequestEvent(electronApp, {
      requestId: 'tab-approval-1',
      projectId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      chatId: CHAT_ID,
      provider: 'claude',
      title: 'Run a command',
      details: { kind: 'command', command: 'npm run build' },
    });

    // Only the blocked chat is marked — the row said the worktree needs
    // input; this says which tab, so arriving here is not a hunt.
    await expect(
      window.getByTestId(`panel-tab-tool-approval-${CHAT_ID}`),
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      window.getByTestId('panel-tab-tool-approval-idle-chat'),
    ).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

// A returning user's worktree carries the badge summary main saved with its
// last chat write, so startup skips hydrating its chats (`needsHydration` is
// false). An approval that then arrives for it must still name the blocked
// chat, not the "New Chat" placeholder.
function seedHydrationFreeBadges(userDataDir) {
  const filePath = path.join(
    userDataDir,
    'workspaces',
    WORKSPACE_ID,
    'worktrees.json',
  );
  const file = JSON.parse(readFileSync(filePath, 'utf8'));
  file.worktrees = file.worktrees.map((worktree) =>
    worktree.id === WORKTREE_ID
      ? {
          ...worktree,
          chatBadges: {
            // Keep this at `CHAT_BADGES_SUMMARY_VERSION` (main
            // `worktree-record-decision-apply.ts`). An older version is rebuilt
            // by the launch backfill. The rebuilt summary still sets
            // `needsHydration: false` for this file, which has no plan
            // exit, question, approval, or scheduled send, so the worktree
            // stays unhydrated either way.
            version: 2,
            unreadChats: [],
            approvalChats: [],
            needsHydration: false,
            updatedAt: '2026-10-01T00:00:00.000Z',
          },
        }
      : worktree,
  );
  writeJson(filePath, file);
}

test('the approval popover names the blocked chat when its worktree has not hydrated', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-sidebar-tool-approval-unhydrated-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    activeTabId: CHAT_ID,
    tabs: [{ id: CHAT_ID, title: 'Approval Blocked', status: 'streaming' }],
  });
  seedHydrationFreeBadges(userDataDir);

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();

    const row = window.locator(
      `[data-testid="worktree-row"][data-branch="${WORKTREE_ID}"]`,
    );
    await expect(row).toBeVisible({ timeout: 15_000 });

    await injectApprovalRequestEvent(electronApp, {
      requestId: 'sidebar-approval-unhydrated-1',
      projectId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      chatId: CHAT_ID,
      provider: 'claude',
      title: 'Run a command',
      details: { kind: 'command', command: 'npm run build' },
    });

    const dot = row.getByTestId('worktree-row-tool-approval');
    await expect(dot).toBeVisible({ timeout: 15_000 });
    await dot.focus();
    const popover = window.getByText('Approval needed').locator('..');
    await expect(popover).toBeVisible({ timeout: 15_000 });
    await expect(popover).toContainText('Approval Blocked', {
      timeout: 15_000,
    });
    await expect(popover).not.toContainText('New Chat');
    await expect(popover).toContainText('npm run build');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
