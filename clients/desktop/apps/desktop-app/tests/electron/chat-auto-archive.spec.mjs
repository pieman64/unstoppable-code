// Chat auto-archive lifecycle regressions.
//
// Both the agent Set Auto Archive tool and a hook chat action with
// `autoArchive: true` leave the same durable marker on the chat tab. These
// tests drive each producer through the canonical provider-event ingress and
// assert that a completed turn moves the chat out of the live strip and into
// the archived-chat UI.
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
import { launchCanopy } from './launchCanopy.mjs';

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
