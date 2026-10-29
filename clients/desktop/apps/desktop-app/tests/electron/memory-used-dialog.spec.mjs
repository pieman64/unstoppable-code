import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  connectMockCloudAccount,
  DEFAULT_MOCK_BASE_URL,
  getScenarioActivity,
  injectChatEvent,
  seedWorktreeChat,
} from './seeders/index.mjs';
import {
  MEMORY_CLOUD_API_KEY,
  MEMORY_ORGANIZATION_ID,
  MEMORY_ORGANIZATION_NAME,
  MEMORY_OWNER_CLOUD_API_KEY,
  markWorkspaceOwnedByMemoryOrganization,
  startOrgMemoryDisclosureChat,
} from './orgMemoryDisclosureFixture.mjs';

async function readMemorySearchActivity(apiKey) {
  const { activity } = await getScenarioActivity(DEFAULT_MOCK_BASE_URL, apiKey);
  return activity ?? {};
}

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const MESSAGE_ID = 'memory-user-message';
const CHAT_ID = 'memory-chat';

// Server fact ids are lowercase UUIDs. The IPC boundary runs the id through
// `validateId()` (`/^[a-z0-9][a-z0-9-]*$/`), so the seeded id must be shaped
// like a real one or the feedback submission would be rejected in main.
const FACT_ID = '11111111-1111-4111-8111-111111111111';
const SEARCH_ID = '22222222-2222-4222-8222-222222222222';
const MEMORY_FEEDBACK_CLOUD_API_KEY = MEMORY_CLOUD_API_KEY;

// Mirrors `MEMORY_FEEDBACK_COMMENT_MAX_CHARS` in
// `packages/protocol/src/memory/index.ts`. This spec is plain ESM and cannot
// import the TypeScript protocol module, so the literal here is the automation
// guard that the renderer textarea keeps using the shared protocol limit rather
// than drifting from the server.
const COMMENT_MAX_CHARS = 2000;

test('a real retrieved memory remains visible after its provider turn and relaunch', async () => {
  test.setTimeout(180_000);
  const first = await startOrgMemoryDisclosureChat();
  const { userDataDir, window } = first;
  try {
    await expect(window.getByTestId('memory-used-button')).toBeVisible();
    await window.getByTestId('memory-used-button').click();
    const dialog = window.getByTestId('memory-used-dialog');
    await expect(dialog).toContainText('Releases use a weekly release train.');
    // CAN-3457: the dialog names the org that owns the project, the only org
    // searched for this turn.
    await expect(
      dialog.getByTestId('memory-used-organization-name'),
    ).toHaveText(MEMORY_ORGANIZATION_NAME);
    const activity = await readMemorySearchActivity(MEMORY_CLOUD_API_KEY);
    expect(activity[`memorySearch:${MEMORY_ORGANIZATION_ID}`]).toBeGreaterThan(
      0,
    );
    expect(activity['memorySearch:missing']).toBeUndefined();
  } finally {
    await closeCanopy(first.electronApp, userDataDir, { keepUserData: true });
  }
  const second = await launchCanopy({ userDataDir });
  try {
    const window = await second.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    await expect(window.getByTestId('memory-used-button')).toBeVisible();
  } finally {
    await closeCanopy(second.electronApp, userDataDir);
  }
});

// CAN-3457: org memory follows the owner of the work. A Personal project turn
// sends nothing to any org's search log, even for an account whose only
// memory-eligible org would otherwise have been searched.
test('a Personal project turn never searches organization memory', async () => {
  test.setTimeout(180_000);
  const before = await readMemorySearchActivity(MEMORY_OWNER_CLOUD_API_KEY);
  const running = await startOrgMemoryDisclosureChat({
    owned: false,
    apiKey: MEMORY_OWNER_CLOUD_API_KEY,
  });
  try {
    const after = await readMemorySearchActivity(MEMORY_OWNER_CLOUD_API_KEY);
    expect(after.memorySearch ?? 0).toBe(before.memorySearch ?? 0);
    await expect(running.window.getByTestId('memory-used-button')).toHaveCount(
      0,
    );
  } finally {
    await closeCanopy(running.electronApp, running.userDataDir);
  }
});

// CAN-3477: a Cowork workspace follows its saved owner. An org-owned one (an
// org's default Chats workspace, for example) searches that org's memory, and
// the dialog names it.
test('an org-owned Cowork chat searches its owning organization memory', async () => {
  test.setTimeout(180_000);
  const running = await startOrgMemoryDisclosureChat({ surface: 'cowork' });
  try {
    const { window } = running;
    await expect(window.getByTestId('memory-used-button')).toBeVisible();
    await window.getByTestId('memory-used-button').click();
    const dialog = window.getByTestId('memory-used-dialog');
    await expect(dialog).toContainText('Releases use a weekly release train.');
    await expect(
      dialog.getByTestId('memory-used-organization-name'),
    ).toHaveText(MEMORY_ORGANIZATION_NAME);
    const activity = await readMemorySearchActivity(MEMORY_CLOUD_API_KEY);
    expect(activity[`memorySearch:${MEMORY_ORGANIZATION_ID}`]).toBeGreaterThan(
      0,
    );
    expect(activity['memorySearch:missing']).toBeUndefined();
  } finally {
    await closeCanopy(running.electronApp, running.userDataDir);
  }
});

// CAN-3477: a Personal Cowork workspace searches nothing. It shares the
// Personal project test's key; every test on that key expects zero searches.
test('a Personal Cowork chat never searches organization memory', async () => {
  test.setTimeout(180_000);
  const before = await readMemorySearchActivity(MEMORY_OWNER_CLOUD_API_KEY);
  const running = await startOrgMemoryDisclosureChat({
    owned: false,
    apiKey: MEMORY_OWNER_CLOUD_API_KEY,
    surface: 'cowork',
  });
  try {
    const after = await readMemorySearchActivity(MEMORY_OWNER_CLOUD_API_KEY);
    expect(after.memorySearch ?? 0).toBe(before.memorySearch ?? 0);
    await expect(running.window.getByTestId('memory-used-button')).toHaveCount(
      0,
    );
  } finally {
    await closeCanopy(running.electronApp, running.userDataDir);
  }
});

function seedMemoryChat(userDataDir) {
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  markWorkspaceOwnedByMemoryOrganization(userDataDir, WORKSPACE_ID);
  return seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    tabs: [
      {
        id: CHAT_ID,
        title: 'Memory used',
        messages: [
          {
            id: MESSAGE_ID,
            role: 'user',
            blocks: [{ type: 'text', text: 'How do releases work?' }],
            timestamp: Date.parse('2026-07-23T10:00:00.000Z'),
          },
          {
            id: 'memory-assistant-message',
            role: 'assistant',
            blocks: [{ type: 'text', text: 'Use the release train.' }],
            timestamp: Date.parse('2026-07-23T10:00:01.000Z'),
          },
          {
            id: 'memory-turn-timer',
            role: 'system',
            blocks: [
              {
                type: 'turn_timer',
                startedAt: Date.parse('2026-07-23T10:00:00.000Z'),
                completedAt: Date.parse('2026-07-23T10:00:02.000Z'),
              },
            ],
            timestamp: Date.parse('2026-07-23T10:00:02.000Z'),
          },
        ],
      },
    ],
  });
}

async function readCanonicalMemory(window) {
  return window.evaluate(
    async ({ projectId, worktreeId, chatId, messageId }) => {
      const snapshot = await window.api.chat.getState({
        projectId,
        worktreeId,
      });
      return snapshot.tabsFile.tabs.find((tab) => tab.id === chatId)
        ?.memoryByMessageId?.[messageId];
    },
    {
      projectId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      chatId: CHAT_ID,
      messageId: MESSAGE_ID,
    },
  );
}

test('opens the read-only memory-used dialog and preserves it across relaunch', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-memory-used-dialog-'),
  );
  seedMemoryChat(userDataDir);

  const first = await launchCanopy({ userDataDir });
  try {
    const window = await first.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();

    await injectChatEvent(first.electronApp, {
      projectId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      chatId: CHAT_ID,
      data: {
        type: 'org_memory_used',
        localChatId: CHAT_ID,
        localMessageId: MESSAGE_ID,
        facts: [
          {
            factText: 'Releases use a weekly release train.',
            validAt: '2026-07-22',
            sourceTurnIds: ['source-turn-1'],
          },
        ],
      },
    });
    await app.selectWorktree(WORKTREE_ID);
    await expect(window.getByTestId('panel-content-chat')).toBeVisible();
    await expect(window.getByText('How do releases work?')).toBeVisible();
    await expect
      .poll(
        async () => (await readCanonicalMemory(window))?.facts?.[0]?.factText,
      )
      .toBe('Releases use a weekly release train.');

    await window
      .getByRole('button', {
        name: 'Show organization memories used for this message',
      })
      .click();
    const dialog = window.getByTestId('memory-used-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Releases use a weekly release train.');
    await expect(dialog).toContainText('As of 2026-07-22');
    await expect(dialog.getByRole('button', { name: 'Helpful' })).toHaveCount(
      0,
    );
    await expect(dialog.locator('textarea')).toHaveCount(0);
  } finally {
    await closeCanopy(first.electronApp, userDataDir, { keepUserData: true });
  }

  const second = await launchCanopy({ userDataDir });
  try {
    const window = await second.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);

    await expect(
      window.getByRole('button', {
        name: 'Show organization memories used for this message',
      }),
    ).toBeVisible();
  } finally {
    await closeCanopy(second.electronApp, userDataDir);
  }
});

// Interactive path: a turn carrying both `searchId` and `factId` exposes the
// one-time feedback controls. The dedicated mock account advertises memory
// search and returns an eligible occurrence from the feedback GET route. Its
// POST deliberately declines the write so this spec covers the recoverable
// error state; renderer tests cover successful confirmation and retrieval.
test('drives one-time feedback controls for an injected occurrence', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-memory-feedback-'),
  );
  seedMemoryChat(userDataDir);

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();

    await connectMockCloudAccount(window, MEMORY_FEEDBACK_CLOUD_API_KEY, {
      expectedStatus: {
        capabilities: expect.arrayContaining(['memorySearch']),
      },
    });

    await injectChatEvent(electronApp, {
      projectId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      chatId: CHAT_ID,
      data: {
        type: 'org_memory_used',
        localChatId: CHAT_ID,
        localMessageId: MESSAGE_ID,
        organizationExternalId: MEMORY_ORGANIZATION_ID,
        searchId: SEARCH_ID,
        facts: [
          {
            factId: FACT_ID,
            factText: 'The database proxy uses port 4031.',
            validAt: '2026-07-22',
            sourceTurnIds: ['source-turn-1'],
          },
        ],
      },
    });
    await app.selectWorktree(WORKTREE_ID);
    await expect(window.getByTestId('panel-content-chat')).toBeVisible();
    await expect(window.getByText('How do releases work?')).toBeVisible();
    await expect
      .poll(() => readCanonicalMemory(window))
      .toMatchObject({
        organizationExternalId: MEMORY_ORGANIZATION_ID,
        searchId: SEARCH_ID,
        facts: [{ factId: FACT_ID }],
      });

    await window
      .getByRole('button', {
        name: 'Show organization memories used for this message',
      })
      .click();
    const dialog = window.getByTestId('memory-used-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('The database proxy uses port 4031.');
    await expect(
      dialog.getByTestId('memory-used-organization-name'),
    ).toHaveText(MEMORY_ORGANIZATION_NAME);

    const like = dialog.getByTestId('memory-feedback-like');
    await expect(like).toBeVisible();
    await expect(dialog.getByTestId('memory-feedback-dislike')).toBeVisible();
    await expect(like).toHaveAttribute('aria-pressed', 'false');

    await dialog.getByTestId('memory-feedback-comment-toggle').click();
    const commentInput = dialog.getByTestId('memory-feedback-comment-input');
    await expect(commentInput).toBeVisible();
    await expect(commentInput).toHaveAttribute(
      'maxlength',
      String(COMMENT_MAX_CHARS),
    );

    await commentInput.fill('The proxy moved to port 4032 last week.');
    await dialog.getByTestId('memory-feedback-comment-send').click();
    await expect(dialog).toContainText('Couldn’t submit. Try again.');
    await expect(commentInput).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
