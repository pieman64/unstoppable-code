// Chat auto-archive lifecycle regressions.
//
// Both the agent Set Auto Archive tool and a hook chat action with
// `autoArchive: true` leave the same durable marker on the chat tab. These
// tests drive each producer through the canonical provider-event ingress and
// assert that a completed turn moves the chat out of the live strip and into
// the archived-chat UI.
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import {
  closeFixture,
  createFixture,
  conversationRequests,
  seedPreferences,
} from './codexPipelineRuntime.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { seedWorktreeChat } from './seeders/index.mjs';
import { withBundledBinaryOverridesScrubbed } from './seeders/bundledBinaryOverrides.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

import {
  openAutoArchiveSurface,
  sendAutoArchiveRequest,
  readAutoArchiveState,
} from './chatAutoArchiveSurfaces.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';

async function sendMessage(window, chatId, text) {
  const panel = window.locator(
    `[data-testid="panel-content-chat"][data-panel-id="panel-chat-${chatId}"]`,
  );
  const composer = panel.getByRole('textbox').first();
  await composer.click();
  await composer.fill(text);
  await panel.getByRole('button', { name: 'Send message' }).click();
}

// The archived row is located by its stable `data-archived-chat-id` hook
// rather than by the seeded `title`: these specs send a live message, so the
// generated summary lands on `description` and the row (correctly) leads with
// it. Generated-title precedence itself is covered by
// `archive-worktree-chat.spec.mjs`.
async function expectArchived(window, chatId, { expectedUnread } = {}) {
  await expect
    .poll(
      async () => {
        const snapshot = await window.evaluate(
          async ({ projectId, worktreeId }) =>
            window.api.chat.getState({ projectId, worktreeId }),
          { projectId: WORKSPACE_ID, worktreeId: WORKTREE_ID },
        );
        const liveTab = snapshot.tabsFile.tabs.find((tab) => tab.id === chatId);
        return {
          liveTab: liveTab
            ? {
                autoArchive: liveTab.autoArchive ?? null,
                status: snapshot.runtimeByChatId[chatId]?.status ?? null,
                unread: liveTab.unread ?? false,
              }
            : null,
          archived: snapshot.archives.some(
            (archive) => archive.chatId === chatId,
          ),
        };
      },
      { timeout: 15_000 },
    )
    .toEqual({ liveTab: null, archived: true });
  await expect(
    window.getByTestId(`panel-tab-panel-chat-${chatId}`),
  ).toHaveCount(0, { timeout: 15_000 });
  const archiveButton = window.getByTestId('chat-tab-archive');
  await expect(archiveButton).toBeVisible({ timeout: 15_000 });
  if (expectedUnread !== undefined) {
    await expect(archiveButton).toHaveAttribute(
      'data-unread',
      String(expectedUnread),
    );
  }
  await archiveButton.click();
  const modal = window.getByTestId('archived-chats-modal');
  await expect(modal).toBeVisible();
  await expect(
    modal.locator(
      `[data-testid="archived-chats-modal-row"][data-archived-chat-id="${chatId}"]`,
    ),
  ).toBeVisible();
  await modal.getByRole('button', { name: 'Close' }).click();
}

test('snapshot recovery archives an agent-marked chat completed during reload', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-agent-auto-archive-'),
  );
  const fixture = createFixture(
    'auto-archive-tool',
    'Auto archive enabled and turn completed',
  );
  seedPreferences(userDataDir);
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    activeTabId: 'agent-auto-archive',
    tabs: [
      {
        id: 'agent-auto-archive',
        title: 'Agent auto archive',
        providerType: 'codex',
        model: 'gpt-6-sol',
      },
      {
        id: 'keeper',
        title: 'Keeper chat',
        providerType: 'codex',
        model: 'gpt-6-sol',
      },
    ],
  });

  const launched = await launchCanopy({ userDataDir, env: fixture.env });
  try {
    const window = await launched.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);

    const chatId = 'agent-auto-archive';
    await sendMessage(window, chatId, 'Enable auto archive and finish.');
    await expect
      .poll(async () => {
        const snapshot = await window.evaluate(
          async ({ projectId, worktreeId, targetChatId }) => {
            const state = await window.api.chat.getState({
              projectId,
              worktreeId,
            });
            return {
              autoArchive:
                state.tabsFile.tabs.find((tab) => tab.id === targetChatId)
                  ?.autoArchive ?? false,
              status: state.runtimeByChatId[targetChatId]?.status ?? null,
            };
          },
          {
            projectId: WORKSPACE_ID,
            worktreeId: WORKTREE_ID,
            targetChatId: chatId,
          },
        );
        return snapshot;
      })
      .toEqual({ autoArchive: true, status: 'streaming' });

    // Keep the old renderer inside unload until the delayed provider result is
    // committed by main. The replacement renderer must recover exclusively
    // from the completed canonical snapshot, with no live delta to rescue it.
    await window.evaluate(() => {
      window.addEventListener(
        'beforeunload',
        () => {
          const releaseAt = Date.now() + 5_000;
          while (Date.now() < releaseAt) {
            // Deliberately hold only this disposable E2E renderer.
          }
        },
        { once: true },
      );
    });
    await window.reload();
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);

    await expectArchived(window, chatId);
  } finally {
    await closeFixture(launched.electronApp, userDataDir, fixture.runtimeDir);
  }
});

test('a completed background auto-archive chat remains unread in the archive', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-background-auto-archive-'),
  );
  const fixture = createFixture(
    'auto-archive-tool',
    'Background auto archive enabled and turn completed',
  );
  seedPreferences(userDataDir);
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    activeTabId: 'agent-auto-archive',
    tabs: [
      {
        id: 'agent-auto-archive',
        title: 'Background agent auto archive',
        providerType: 'codex',
        model: 'gpt-6-sol',
      },
      {
        id: 'keeper',
        title: 'Keeper chat',
        providerType: 'codex',
        model: 'gpt-6-sol',
      },
    ],
  });

  const launched = await launchCanopy({ userDataDir, env: fixture.env });
  try {
    const window = await launched.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);

    await sendMessage(
      window,
      'agent-auto-archive',
      'Enable auto archive while I switch chats.',
    );
    await expect
      .poll(async () =>
        window.evaluate(
          async ({ projectId, worktreeId, chatId }) => {
            const state = await window.api.chat.getState({
              projectId,
              worktreeId,
            });
            return (
              state.tabsFile.tabs.find((tab) => tab.id === chatId)
                ?.autoArchive ?? false
            );
          },
          {
            projectId: WORKSPACE_ID,
            worktreeId: WORKTREE_ID,
            chatId: 'agent-auto-archive',
          },
        ),
      )
      .toBe(true);
    await window.getByTestId('panel-tab-panel-chat-keeper').click();

    await expectArchived(window, 'agent-auto-archive', {
      expectedUnread: true,
    });
  } finally {
    await closeFixture(launched.electronApp, userDataDir, fixture.runtimeDir);
  }
});

test('dismissing the last async question resumes auto-archive', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-question-auto-archive-'),
  );
  const fixture = createFixture(
    'auto-archive-async-question',
    'Question emitted and turn completed',
  );
  seedPreferences(userDataDir);
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    activeTabId: 'question-auto-archive',
    tabs: [
      {
        id: 'question-auto-archive',
        title: 'Question auto archive',
        providerType: 'codex',
        model: 'gpt-6-sol',
      },
      {
        id: 'keeper',
        title: 'Keeper chat',
        providerType: 'codex',
        model: 'gpt-6-sol',
      },
    ],
  });

  const launched = await launchCanopy({ userDataDir, env: fixture.env });
  try {
    const window = await launched.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);

    const chatId = 'question-auto-archive';
    await sendMessage(window, chatId, 'Ask before auto archive.');
    await expect(window.getByTestId('chat-question-prompt')).toBeVisible({
      timeout: 15_000,
    });
    await expect
      .poll(async () =>
        window.evaluate(
          async ({ projectId, worktreeId, targetChatId }) => {
            const state = await window.api.chat.getState({
              projectId,
              worktreeId,
            });
            return {
              live: state.tabsFile.tabs.some((tab) => tab.id === targetChatId),
              archived: state.archives.some(
                (archive) => archive.chatId === targetChatId,
              ),
              status: state.runtimeByChatId[targetChatId]?.status ?? null,
              unanswered: (state.tabsFile.pendingQuestions ?? []).some(
                (question) =>
                  question.chatId === targetChatId &&
                  question.delivery === 'async' &&
                  question.answeredAt === undefined,
              ),
            };
          },
          {
            projectId: WORKSPACE_ID,
            worktreeId: WORKTREE_ID,
            targetChatId: chatId,
          },
        ),
      )
      .toEqual({
        live: true,
        archived: false,
        status: 'completed',
        unanswered: true,
      });

    await window.getByTestId('chat-question-skip').click();
    await expectArchived(window, chatId);
  } finally {
    await closeFixture(launched.electronApp, userDataDir, fixture.runtimeDir);
  }
});

test('waits for async answer delivery before auto-archiving', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-question-answer-auto-archive-'),
  );
  const fixture = createFixture(
    'auto-archive-async-question',
    'Question emitted and turn completed',
  );
  seedPreferences(userDataDir);
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    activeTabId: 'question-answer-auto-archive',
    tabs: [
      {
        id: 'question-answer-auto-archive',
        title: 'Question answer auto archive',
        providerType: 'codex',
        model: 'gpt-6-sol',
      },
      {
        id: 'keeper',
        title: 'Keeper chat',
        providerType: 'codex',
        model: 'gpt-6-sol',
      },
    ],
  });

  const launched = await launchCanopy({ userDataDir, env: fixture.env });
  try {
    const window = await launched.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);

    const chatId = 'question-answer-auto-archive';
    await sendMessage(window, chatId, 'Ask before auto archive.');
    const card = window.getByTestId('chat-question-prompt');
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect
      .poll(async () => {
        const state = await window.evaluate(
          ({ projectId, worktreeId }) =>
            window.api.chat.getState({ projectId, worktreeId }),
          { projectId: WORKSPACE_ID, worktreeId: WORKTREE_ID },
        );
        return state.runtimeByChatId[chatId]?.status ?? null;
      })
      .toBe('completed');

    await card.getByRole('button', { name: 'Full', exact: true }).click();
    await expect
      .poll(() =>
        conversationRequests(fixture.logPath).some(
          (request) =>
            request.method === 'turn/start' &&
            JSON.stringify(request.params.input).includes('Q: Which scope?'),
        ),
      )
      .toBe(true);
    await expect
      .poll(async () => {
        const state = await window.evaluate(
          ({ projectId, worktreeId }) =>
            window.api.chat.getState({ projectId, worktreeId }),
          { projectId: WORKSPACE_ID, worktreeId: WORKTREE_ID },
        );
        return {
          live: state.tabsFile.tabs.some((tab) => tab.id === chatId),
          archived: state.archives.some((archive) => archive.chatId === chatId),
        };
      })
      .toEqual({
        live: true,
        archived: false,
      });

    writeFileSync(fixture.releasePath, 'release');
    await expectArchived(window, chatId);
  } finally {
    await closeFixture(launched.electronApp, userDataDir, fixture.runtimeDir);
  }
});

test('a hook-configured auto-archive chat moves to archives after its first completed turn', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-hook-auto-archive-'),
  );
  const fixture = createFixture(
    'normal',
    'Hook-configured turn completed normally',
  );
  seedPreferences(userDataDir);
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    activeTabId: 'hook-auto-archive',
    tabs: [
      {
        id: 'hook-auto-archive',
        title: 'Hook auto archive',
        autoArchive: true,
        providerType: 'codex',
        model: 'gpt-6-sol',
      },
      {
        id: 'keeper',
        title: 'Keeper chat',
        providerType: 'codex',
        model: 'gpt-6-sol',
      },
    ],
  });

  const launched = await launchCanopy({ userDataDir, env: fixture.env });
  try {
    const window = await launched.electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);

    await sendMessage(
      window,
      'hook-auto-archive',
      'Complete this hook-configured chat.',
    );

    await expectArchived(window, 'hook-auto-archive');
  } finally {
    await closeFixture(launched.electronApp, userDataDir, fixture.runtimeDir);
  }
});

const CLAUDE_AUTO_ARCHIVE_FIXTURE = fileURLToPath(
  new URL('./fixtures/fake-claude-auto-archive-cli.mjs', import.meta.url),
);
// Matches the fixture's provider session id.
const CLAUDE_AUTO_ARCHIVE_SESSION_ID = '6f1c2a3e-1b2c-4d5e-8f90-0a1b2c3d4e5f';

function readClaudeAutoArchiveLog(logPath) {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function launchClaudeAutoArchive(chatId) {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-claude-auto-archive-'),
  );
  const fakeCliPath = path.join(userDataDir, 'fake-claude-auto-archive.mjs');
  const logPath = path.join(userDataDir, 'fake-claude-auto-archive.log');
  copyFileSync(CLAUDE_AUTO_ARCHIVE_FIXTURE, fakeCliPath);
  chmodSync(fakeCliPath, 0o755);
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    activeTabId: chatId,
    tabs: [
      {
        id: chatId,
        title: 'Claude auto archive',
        autoArchive: true,
        providerType: 'claude',
      },
      { id: 'keeper', title: 'Keeper chat', providerType: 'claude' },
    ],
  });
  const { electronApp } = await withBundledBinaryOverridesScrubbed(() =>
    launchCanopy({
      userDataDir,
      env: {
        CLAUDE_CODE_EXECUTABLE: fakeCliPath,
        CANOPY_CLAUDE_AUTO_ARCHIVE_LOG: logPath,
      },
    }),
  );
  return { electronApp, userDataDir, logPath };
}

async function openClaudeAutoArchiveWorktree(electronApp) {
  const window = await electronApp.firstWindow();
  const app = new CanopyAppDriver(window);
  await app.waitForShell({ timeout: 30_000 });
  await app.openMainPage();
  await app.selectWorktree(WORKTREE_ID);
  return window;
}

function claudeChatStarts(logPath) {
  return readClaudeAutoArchiveLog(logPath).filter(
    (entry) => entry.type === 'chat_start',
  );
}

async function readArchivedClaudeChat(window, chatId) {
  const { tab } = await window.evaluate(
    (request) => window.api.chat.readArchive(request),
    {
      projectId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      chatId,
      fullTranscript: true,
    },
  );
  return tab;
}

async function expectStillArchived(window, chatId) {
  const state = await window.evaluate(
    ({ projectId, worktreeId }) =>
      window.api.chat.getState({ projectId, worktreeId }),
    { projectId: WORKSPACE_ID, worktreeId: WORKTREE_ID },
  );
  expect(state.archives.some((archive) => archive.chatId === chatId)).toBe(
    true,
  );
  expect(state.tabsFile.tabs.some((tab) => tab.id === chatId)).toBe(false);
}

test('an auto-archived Claude chat releases its CLI and resumes the same session on restore', async () => {
  test.setTimeout(150_000);
  const chatId = 'claude-auto-archive';
  const { electronApp, userDataDir, logPath } =
    await launchClaudeAutoArchive(chatId);
  try {
    const window = await openClaudeAutoArchiveWorktree(electronApp);

    await sendMessage(window, chatId, 'Finish and auto archive.');
    await expectArchived(window, chatId);

    const [firstStart] = claudeChatStarts(logPath);
    const firstPid = firstStart?.pid;
    expect(firstPid).toEqual(expect.any(Number));
    expect(firstStart.resume).toBeNull();
    // The leaked process is the one whose MCP route names the chat.
    expect(firstStart.mcpConfigNamesChat).toBe(true);
    const archivedBefore = await readArchivedClaudeChat(window, chatId);
    expect(archivedBefore.sdkSessionId).toBe(CLAUDE_AUTO_ARCHIVE_SESSION_ID);

    // Released after its settle period, with nothing written to the chat.
    await expect
      .poll(() => processIsAlive(firstPid), { timeout: 45_000 })
      .toBe(false);
    await expectStillArchived(window, chatId);
    const archivedAfter = await readArchivedClaudeChat(window, chatId);
    expect(archivedAfter.messages).toEqual(archivedBefore.messages);
    expect(archivedAfter.sdkSessionId).toBe(CLAUDE_AUTO_ARCHIVE_SESSION_ID);

    await window.getByTestId('chat-tab-archive').click();
    const modal = window.getByTestId('archived-chats-modal');
    await expect(modal).toBeVisible();
    await modal
      .locator(
        `[data-testid="archived-chats-modal-row"][data-archived-chat-id="${chatId}"]`,
      )
      .getByTestId('archived-chat-restore')
      .click();
    await expect(
      window.getByTestId(`panel-tab-panel-chat-${chatId}`),
    ).toBeVisible({ timeout: 15_000 });

    await sendMessage(window, chatId, 'Continue with the earlier context.');
    await expect
      .poll(
        () =>
          claudeChatStarts(logPath)
            .filter((entry) => entry.pid !== firstPid)
            .map((entry) => entry.resume),
        { timeout: 45_000 },
      )
      .toEqual([CLAUDE_AUTO_ARCHIVE_SESSION_ID]);
    const panel = window.locator(
      `[data-testid="panel-content-chat"][data-panel-id="panel-chat-${chatId}"]`,
    );
    await expect(
      panel.getByText(`Resumed ${CLAUDE_AUTO_ARCHIVE_SESSION_ID} turn 1`),
    ).toBeVisible({ timeout: 15_000 });
    // A user restore ends auto-archiving, so the chat stays open.
    await expect(
      window.getByTestId(`panel-tab-panel-chat-${chatId}`),
    ).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('an auto-archived Claude chat keeps its CLI while a background Bash task runs', async () => {
  test.setTimeout(150_000);
  const chatId = 'claude-auto-archive';
  const { electronApp, userDataDir, logPath } =
    await launchClaudeAutoArchive(chatId);
  try {
    const window = await openClaudeAutoArchiveWorktree(electronApp);

    await sendMessage(window, chatId, 'Start the dev server [background-task]');
    await expectArchived(window, chatId);
    const [start] = claudeChatStarts(logPath);
    expect(start?.pid).toEqual(expect.any(Number));
    expect(
      readClaudeAutoArchiveLog(logPath).some(
        (entry) => entry.type === 'task_started',
      ),
    ).toBe(true);

    // Longer than the idle settle period: the live task holds the CLI.
    await new Promise((resolve) => setTimeout(resolve, 8_000));
    expect(processIsAlive(start.pid)).toBe(true);
    await expectStillArchived(window, chatId);

    writeFileSync(`${logPath}.finish-task`, '');
    await expect
      .poll(
        () =>
          readClaudeAutoArchiveLog(logPath).some(
            (entry) => entry.type === 'task_finished',
          ),
        { timeout: 10_000 },
      )
      .toBe(true);
    // Released once the task ends and its continuation window passes.
    await expect
      .poll(() => processIsAlive(start.pid), { timeout: 60_000 })
      .toBe(false);
    await expectStillArchived(window, chatId);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

for (const surface of ['cowork', 'advisor']) {
  for (const action of ['disable', 're-enable', 'tool-disable']) {
    test(`${surface} auto-archive supports ${action} and keeps sibling chats`, async () => {
      const context = await openAutoArchiveSurface(surface);
      try {
        await sendAutoArchiveRequest(
          context,
          action === 'tool-disable' ? 'Disable using tool.' : undefined,
        );
        const toggle = context.panel.getByTestId('auto-archive-toggle');
        await expect(toggle).toBeVisible();
        await expect(toggle).toHaveAttribute(
          'aria-pressed',
          action === 'tool-disable' ? 'false' : 'true',
        );
        if (action !== 'tool-disable') {
          await toggle.click();
          await expect(toggle).toHaveAttribute('aria-pressed', 'false');
          if (action === 're-enable') {
            await toggle.click();
            await expect(toggle).toHaveAttribute('aria-pressed', 'true');
          }
        }
        await expect
          .poll(async () => {
            const state = await readAutoArchiveState(context);
            return (
              state.tabsFile.tabs.find((tab) => tab.id === context.chatId)
                ?.autoArchive === true
            );
          })
          .toBe(action === 're-enable');
        writeFileSync(context.fixture.releasePath, 'release');
        await expect
          .poll(async () => {
            const state = await readAutoArchiveState(context);
            return {
              archived: state.archives.some(
                (row) => row.chatId === context.chatId,
              ),
              live: state.tabsFile.tabs.some(
                (tab) => tab.id === context.chatId,
              ),
              keeper: state.tabsFile.tabs.some(
                (tab) => tab.id === 'archive-keeper',
              ),
              completed:
                action === 're-enable' ||
                state.runtimeByChatId[context.chatId]?.status === 'completed',
            };
          })
          .toEqual({
            archived: action === 're-enable',
            live: action !== 're-enable',
            keeper: true,
            completed: true,
          });
        if (action === 're-enable') {
          await expect(
            context.window.getByTestId(
              `panel-tab-panel-chat-${context.chatId}`,
            ),
          ).toHaveCount(0);
          await context.window.getByTestId('chat-tab-archive').click();
          await expect(
            context.window.locator(
              `[data-testid="archived-chats-modal-row"][data-archived-chat-id="${context.chatId}"]`,
            ),
          ).toBeVisible();
        } else {
          await expect(
            context.panel.getByText('Auto archive surface finished.', {
              exact: true,
            }),
          ).toBeVisible();
          await expect(toggle).toHaveCount(0);
        }
      } finally {
        await closeFixture(
          context.electronApp,
          context.userDataDir,
          context.fixture.runtimeDir,
        );
      }
    });
  }
}
