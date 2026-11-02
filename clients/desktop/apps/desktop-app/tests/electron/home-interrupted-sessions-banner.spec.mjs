import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import {
  seedAutomations,
  seedUsageLimitedChats,
  seedWorktreeChat,
} from './seeders/index.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { seedInterruptedSessionScopes } from './interrupted-sessions-scope-fixture.mjs';
import { seedTranscriptRecovery } from './transcript-storage-fixture.mjs';
import { withResumeQueue } from './resume-queue.scenario.mjs';
import { collectLeaves, getLayout } from './panelHarness.mjs';
import { readChatStorageMessages } from './readChatStorage.mjs';

// Home interrupted sessions Continue row (2026-09-08, relocated 2026-09-16).
// When the usage-limited registry holds any idle session — usage limit,
// authentication failure, or application stop, for any provider — the Home
// Continue list offers a dismissible row with one Resume CTA that opens the
// shared `UsageLimitResumeModal` for every interrupted session at once.
// Dismissal is session-only and keyed to the interrupted set, so a new
// interruption brings the row back. The registry is seeded JSON; no live
// agents or network.

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKSPACE_NAME = 'TypeScript pnpm Vite';
const WORKTREE_ID = 'demo-main';
const CHATS = [
  { id: 'usage-limit-chat', title: 'Usage limit chat', provider: 'claude' },
  { id: 'shutdown-chat', title: 'Shutdown chat', provider: 'claude' },
  {
    id: 'codex-shutdown-chat',
    title: 'Codex shutdown chat',
    provider: 'codex',
  },
];

function registryEntry(chat, resumeReason) {
  return {
    projectId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    chatId: chat.id,
    provider: chat.provider,
    detectedAt: Date.parse('2026-09-08T12:00:00.000Z'),
    workspaceName: WORKSPACE_NAME,
    chatTitle: chat.title,
    resumeReason,
  };
}

function seed(entries) {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-home-interrupted-banner-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    tabs: CHATS.map((chat) => ({ id: chat.id, title: chat.title })),
  });
  seedUsageLimitedChats({ userDataDir, entries });
  return userDataDir;
}

function readRegistry(userDataDir) {
  return JSON.parse(
    readFileSync(path.join(userDataDir, 'usage-limited-chats.json'), 'utf8'),
  );
}

async function openHome(window, app) {
  await app.waitForShell({ timeout: 30_000 });
  await window.getByTestId('sidebar-create-task').click();
  await expect(window.getByTestId('page-home')).toBeVisible();
  return window.getByTestId('page-home');
}

test.describe('home interrupted sessions banner', () => {
  test('CAN-4895 merges the named chat, isolates keyboard Open and Dismiss, and names Last viewed after resume and relaunch', async () => {
    test.setTimeout(120_000);
    const interruptedTitle = 'Review retry backoff';
    await withResumeQueue(
      async ({ window, chatIds, starts, restart, userDataDir }) => {
        await window.getByTestId('usage-limit-resume-confirm').click();
        await expect(
          window.getByTestId('usage-limit-resume-modal'),
        ).toBeHidden();
        await expect(
          window.locator(`[data-panel-id="panel-chat-${chatIds[0]}"]`),
        ).toBeVisible();
        await expect.poll(() => readRegistry(userDataDir).entries).toEqual([]);
        await expect.poll(() => starts().length).toBe(1);
        // Acknowledge the completed queue by closing its dialog so the next
        // launch tests Last viewed, without restoring a queue chip.
        await window.getByTestId('resume-queue-sidebar-open-queue').click();
        const queue = window.getByTestId('resume-queue-modal');
        await expect(queue.getByTestId('resume-queue-done')).toBeVisible();
        await window.keyboard.press('Escape');
        await expect(queue).toBeHidden();
        await expect(window.getByTestId('resume-queue-sidebar')).toBeHidden();
        const relaunched = await restart();
        const home = relaunched.window.getByTestId('page-home');
        await expect(home).toBeVisible();
        await expect(
          home.getByTestId('home-interrupted-sessions-banner'),
        ).toHaveCount(0);
        // The worktree keeps its default branch, so Last viewed names it by
        // the chat title and does not repeat the title below (CAN-5008).
        await expect(home.getByTestId('home-resume-destination')).toHaveText(
          interruptedTitle,
        );
        await expect(home.getByTestId('home-resume-chat-title')).toHaveCount(0);
      },
      1,
      'complete',
      {
        startupOffer: true,
        welcomeChecklist: true,
        chatTitle: interruptedTitle,
        otherActiveChat: true,
        beforeResume: async ({ window, userDataDir, chatIds }) => {
          const home = window.getByTestId('page-home');
          const row = home.getByTestId('home-interrupted-sessions-resume');
          await expect(row).toContainText(`Resume ${interruptedTitle}`);
          await expect(row).toHaveAccessibleName(
            /Resume Review retry backoff Interrupted/,
          );
          await expect(
            home.getByTestId('home-interrupted-sessions-context'),
          ).toContainText('New Task');
          await expect(home.getByTestId('home-resume-details')).toHaveCount(0);
          const suggestions = home
            .getByTestId('suggested-prompt-chips')
            .getByTestId('suggested-prompt-chip');
          await expect(suggestions.first()).toBeVisible();
          const promptCount = await suggestions.count();
          const before = readRegistry(userDataDir).entries;
          await home.getByTestId('home-interrupted-sessions-dismiss').focus();
          await window.keyboard.press('Space');
          await expect(row).toHaveCount(0);
          await expect(home.getByTestId('home-resume-destination')).toHaveText(
            interruptedTitle,
          );
          await expect(home.getByTestId('home-resume-chat-title')).toHaveCount(
            0,
          );
          await expect(suggestions.first()).toBeVisible();
          await expect(suggestions).toHaveCount(promptCount);
          await expect(
            window.getByTestId('usage-limit-resume-modal'),
          ).toHaveCount(0);
          expect(readRegistry(userDataDir).entries).toEqual(before);
          // Dismissal is session-only. Reloading restores the named offer.
          await window.reload();
          await new CanopyAppDriver(window).waitForShell({ timeout: 30_000 });
          await expect(row).toBeVisible();
          await home.getByTestId('home-interrupted-sessions-open').focus();
          await window.keyboard.press('Enter');
          await expect(
            window.locator(`[data-panel-id="panel-chat-${chatIds[0]}"]`),
          ).toBeVisible();
          await expect(
            window.getByTestId('usage-limit-resume-modal'),
          ).toHaveCount(0);
          expect(readRegistry(userDataDir).entries).toEqual(before);
          // Open must also reveal a chat that is already active: switching
          // to the same tab alone does not expand its collapsed panel group.
          const groups = collectLeaves((await getLayout(window)).root);
          const chatGroup = groups.find((leaf) =>
            leaf.panels.some(
              (panel) => panel.panelId === `panel-chat-${chatIds[0]}`,
            ),
          );
          expect(chatGroup).toBeDefined();
          const otherGroup = groups.find(
            (leaf) => leaf.groupId !== chatGroup.groupId,
          );
          expect(otherGroup).toBeDefined();
          await window.evaluate(
            (groupId) =>
              window.__canopyPanelTestApi.collapseGroup(groupId, false),
            otherGroup.groupId,
          );
          await window.evaluate(
            (groupId) =>
              window.__canopyPanelTestApi.collapseGroup(groupId, true),
            chatGroup.groupId,
          );
          await expect(
            window.getByTestId(`panel-collapsed-bar-${chatGroup.groupId}`),
          ).toBeVisible();
          await window.getByTestId('sidebar-create-task').click();
          await home.getByTestId('home-interrupted-sessions-open').click();
          await expect(
            window.locator(`[data-panel-id="panel-chat-${chatIds[0]}"]`),
          ).toBeVisible();
          await expect(
            window.getByTestId('usage-limit-resume-modal'),
          ).toHaveCount(0);
          expect(readRegistry(userDataDir).entries).toEqual(before);
          await window.getByTestId('sidebar-create-task').click();
          await expect(row).toContainText(`Resume ${interruptedTitle}`);
          await expect(home.getByTestId('home-resume-details')).toHaveCount(0);
          // The consumed startup offer no longer trims Getting started.
          await expect(suggestions).toHaveCount(promptCount);
        },
      },
    );
  });

  test('wraps a long last-step path within the resume row (CAN-4896)', async () => {
    const chat = CHATS[1];
    const detail =
      'src/features/editor/workspace/configuration/formatting/preferences/settings.json';
    const userDataDir = seed([registryEntry(chat, 'app_shutdown')]);
    seedWorktreeChat({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      providerType: 'claude',
      tabs: [
        {
          id: chat.id,
          title: chat.title,
          messages: [
            {
              id: 'prompt',
              role: 'user',
              timestamp: 1,
              blocks: [{ type: 'text', text: 'Update editor settings' }],
            },
            {
              id: 'edit',
              role: 'assistant',
              timestamp: 2,
              blocks: [
                {
                  type: 'tool_use',
                  toolUseId: 'edit',
                  toolName: 'Edit',
                  input: JSON.stringify({ file_path: detail }),
                },
              ],
            },
          ],
        },
      ],
    });
    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      await window.setViewportSize({ width: 1280, height: 800 });
      const home = await openHome(window, new CanopyAppDriver(window));
      await home.getByTestId('home-interrupted-sessions-resume').click();
      const modal = window.getByTestId('usage-limit-resume-modal');
      const secondary = modal
        .getByTestId(`usage-limit-resume-chat-${chat.id}-metadata`)
        .locator('xpath=following-sibling::p[1]');
      await expect(secondary).toContainText(`Last step: Edit ${detail}`);
      for (const width of [1280, 480]) {
        await window.setViewportSize({ width, height: 800 });
        await expect
          .poll(() =>
            secondary.evaluate(
              (element) => element.scrollWidth <= element.clientWidth,
            ),
          )
          .toBe(true);
        await expect(
          modal.getByTestId('usage-limit-resume-confirm'),
        ).toBeInViewport();
      }
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('explains what Resume sends, where, and the last persisted step (CAN-4896)', async () => {
    test.setTimeout(120_000);
    const chats = CHATS.slice(0, 2);
    const userDataDir = seed(
      chats.map((chat) => registryEntry(chat, 'app_shutdown')),
    );
    const worktreeRoot = path.join(
      userDataDir,
      'workspaces',
      WORKSPACE_ID,
      'worktrees',
      WORKTREE_ID,
    );
    const prompt = (text) => ({
      id: `prompt-${text.length}`,
      role: 'user',
      timestamp: 1,
      blocks: [{ type: 'text', text }],
    });
    const privateRequest = 'Private request shown nowhere in the dialog';
    seedWorktreeChat({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      providerType: 'claude',
      tabs: [
        {
          id: chats[0].id,
          title: chats[0].title,
          messages: [
            prompt('Update the API client'),
            {
              id: 'edit',
              role: 'assistant',
              timestamp: 2,
              blocks: [
                {
                  type: 'tool_use',
                  toolUseId: 'edit',
                  toolName: 'Edit',
                  input: JSON.stringify({
                    file_path: path.join(worktreeRoot, 'src/api/client.ts'),
                  }),
                },
              ],
            },
          ],
        },
        {
          id: chats[1].id,
          title: chats[1].title,
          messages: [prompt(privateRequest)],
        },
      ],
    });
    // A deterministic uncommitted change in the seeded git worktree.
    writeFileSync(path.join(worktreeRoot, 'can-4896-dirty.txt'), 'dirty\n');
    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      const home = await openHome(window, new CanopyAppDriver(window));
      await expect(
        home.getByTestId('home-interrupted-sessions-details'),
      ).toHaveText('Resume 2 interrupted chats', { timeout: 15_000 });
      await home.getByTestId('home-interrupted-sessions-resume').click();
      const modal = window.getByTestId('usage-limit-resume-modal');
      await expect(modal).toBeVisible({ timeout: 15_000 });
      await expect(
        window.getByRole('heading', { name: 'Resume interrupted chats' }),
      ).toBeVisible();
      await expect(
        window.getByText(/closed before these chats finished\./),
      ).toBeVisible();
      await expect(modal).not.toContainText('usage limit stopped');
      const effect = modal.getByTestId('usage-limit-resume-effect');
      await expect(effect).toHaveText(
        'Resuming sends "Continue" or re-sends your last message, as shown for each selected chat. Each agent continues in its chat\'s worktree.',
        { timeout: 15_000 },
      );
      const secondary = (chat) =>
        modal
          .getByTestId(`usage-limit-resume-chat-${chat.id}-metadata`)
          .locator('xpath=following-sibling::p[1]');
      // No persisted result: the step stays neutral, never `Stopped during`.
      await expect(secondary(chats[0])).toContainText(
        'Last step: Edit src/api/client.ts · Stopped ',
      );
      await expect(secondary(chats[0])).not.toContainText('finished');
      await expect(secondary(chats[0])).toContainText('Sends "Continue"');
      await expect(secondary(chats[0])).toHaveClass(/ph-mask/);
      // Diff stats arrive through the existing worktree poll.
      await expect(secondary(chats[0])).toContainText('Uncommitted changes', {
        timeout: 45_000,
      });
      await expect(secondary(chats[1])).toContainText(
        'Re-sends your last message',
      );
      await expect(modal).not.toContainText(privateRequest);
      const confirm = modal.getByTestId('usage-limit-resume-confirm');
      await expect(confirm).toHaveText('Resume 2 chats');

      await modal
        .getByTestId(`usage-limit-resume-chat-${chats[1].id}`)
        .uncheck();
      await expect(effect).toHaveText(
        'Resuming sends "Continue" in this chat, so the agent picks up where it stopped without sending your original request again. The agent continues in the same worktree.',
      );
      await expect(confirm).toHaveText('Resume chat');
      await modal
        .getByTestId(`usage-limit-resume-chat-${chats[0].id}`)
        .uncheck();
      await expect(effect).toHaveCount(0);
      await expect(confirm).toHaveText('Resume');
      await expect(confirm).toBeDisabled();

      await modal.getByTestId(`usage-limit-resume-chat-${chats[0].id}`).check();
      await confirm.click();
      await expect(modal).toBeHidden({ timeout: 20_000 });
      await expect
        .poll(
          () => readRegistry(userDataDir).entries.map((entry) => entry.chatId),
          { timeout: 30_000 },
        )
        .toEqual([chats[1].id]);
      const sentTexts = (chat) =>
        readChatStorageMessages(
          path.join(userDataDir, 'workspaces', WORKSPACE_ID),
          WORKTREE_ID,
          chat.id,
        )
          .filter((message) => message.role === 'user')
          .map((message) =>
            message.blocks
              .filter((block) => block.type === 'text')
              .map((block) => block.text)
              .join('\n'),
          );
      expect(sentTexts(chats[0])).toEqual([
        'Update the API client',
        'Continue',
      ]);
      expect(sentTexts(chats[1])).toEqual([privateRequest]);

      // The remaining interruption re-sends the original message once.
      const remainingHome = await openHome(window, new CanopyAppDriver(window));
      await expect(
        remainingHome.getByTestId('home-interrupted-sessions-resume'),
      ).toBeVisible();
      await remainingHome
        .getByTestId('home-interrupted-sessions-resume')
        .click();
      await expect(effect).toContainText(
        'Resuming re-sends your last message in this chat.',
      );
      await expect(modal).not.toContainText(privateRequest);
      await confirm.click();
      await expect(modal).toBeHidden();
      await expect.poll(() => readRegistry(userDataDir).entries).toEqual([]);
      expect(sentTexts(chats[1])).toEqual([privateRequest, privateRequest]);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('keeps unavailable worktree metadata and unknown reasons neutral (CAN-4896)', async () => {
    const userDataDir = seed([registryEntry(CHATS[0], 'app_shutdown')]);
    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      const home = await openHome(window, new CanopyAppDriver(window));
      await electronApp.evaluate(({ ipcMain }) => {
        const channel = 'usage-limited-sessions:list';
        const original = ipcMain._invokeHandlers.get(channel);
        if (!original) throw new Error('Missing interrupted listing handler');
        ipcMain.removeHandler(channel);
        ipcMain.handle(channel, async (event, request) =>
          (await original(event, request)).map((group) => ({
            ...group,
            sessions: [
              ...group.sessions.map((session) => ({
                ...session,
                worktreeName: '',
                resumeReason: 'future_reason',
                resumePromptKind: 'continue',
              })),
              {
                kind: 'pipeline',
                executionId: 'missing-reason',
                statusReasonIds: [],
                pipelineName: 'Older pipeline',
                detectedAt: 1,
                pausedStepCount: 1,
                modelLabels: [],
                otherBlockingReasonCount: 0,
                projectId: group.workspaceId,
                worktreeId: group.sessions[0].worktreeId,
                worktreeName: '',
              },
            ],
          })),
        );
      });
      await home.getByTestId('home-interrupted-sessions-resume').click();
      const modal = window.getByTestId('usage-limit-resume-modal');
      await expect(modal).toBeVisible();
      await expect(modal.getByTestId('usage-limit-resume-effect')).toHaveText(
        'Resuming sends "Continue" in this chat, so the agent picks up where it stopped without sending your original request again. Resuming continues the selected workflow.',
      );
      await expect(
        modal.getByTestId(`usage-limit-resume-chat-${CHATS[0].id}-metadata`),
      ).toHaveText('Claude · Interruption reason unavailable · Ready now');
      await expect(
        modal.getByTestId(
          'usage-limit-resume-pipeline-missing-reason-metadata',
        ),
      ).toHaveText(
        'Provider unavailable · Interruption reason unavailable · Ready now',
      );
      await modal.getByRole('button', { name: 'Cancel', exact: true }).click();
      expect(readRegistry(userDataDir).entries).toHaveLength(1);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('lists safe resume previews from full persisted turns (CAN-4896)', async () => {
    const chats = CHATS.slice(0, 2);
    const userDataDir = seed(
      chats.map((chat) => registryEntry(chat, 'app_shutdown')),
    );
    const worktreeRoot = path.join(
      userDataDir,
      'workspaces',
      WORKSPACE_ID,
      'worktrees',
      WORKTREE_ID,
    );
    const prompt = {
      id: 'prompt',
      role: 'user',
      timestamp: 1,
      blocks: [
        {
          type: 'text',
          text: 'Private request that must not enter the listing',
        },
      ],
    };
    seedWorktreeChat({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      providerType: 'claude',
      tabs: [
        {
          id: chats[0].id,
          title: chats[0].title,
          messages: [
            prompt,
            {
              id: 'edit',
              role: 'assistant',
              timestamp: 2,
              blocks: [
                {
                  type: 'tool_use',
                  toolUseId: 'edit',
                  toolName: 'Edit',
                  input: JSON.stringify({
                    file_path: path.join(worktreeRoot, 'src/api/client.ts'),
                  }),
                },
              ],
            },
            {
              id: 'result',
              role: 'system',
              timestamp: 3,
              blocks: [
                {
                  type: 'tool_result',
                  toolUseId: 'edit',
                  toolName: 'Edit',
                  output: 'done',
                  isError: false,
                },
              ],
            },
            ...Array.from({ length: 600 }, (_, index) => ({
              id: `timer-${index}`,
              role: 'system',
              timestamp: index + 4,
              blocks: [{ type: 'turn_timer', completedAt: index + 4 }],
            })),
          ],
        },
        { id: chats[1].id, title: chats[1].title, messages: [prompt] },
      ],
    });
    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      await new CanopyAppDriver(window).waitForShell({ timeout: 30_000 });
      const result = await window.evaluate(() =>
        window.api.listUsageLimitedIdleChats({
          provider: 'claude',
          includeResumePreview: true,
        }),
      );
      const listed = result.find(
        (group) => group.workspaceId === WORKSPACE_ID,
      )?.chats;
      expect(listed).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            chatId: chats[0].id,
            resumePromptKind: 'continue',
            lastStep: {
              toolName: 'Edit',
              detail: 'src/api/client.ts',
              finished: true,
            },
          }),
          expect.objectContaining({
            chatId: chats[1].id,
            resumePromptKind: 'resend_user_message',
          }),
        ]),
      );
      expect(JSON.stringify(result)).not.toContain(prompt.blocks[0].text);
      expect(JSON.stringify(result)).not.toContain(worktreeRoot);
      // Home's count poll does not ask for previews, so it skips full reads.
      const counted = await window.evaluate(() =>
        window.api.listUsageLimitedIdleSessions({}),
      );
      const countedChats = counted
        .find((group) => group.workspaceId === WORKSPACE_ID)
        ?.sessions.filter((session) => session.kind === 'chat');
      expect(countedChats?.map((chat) => chat.chatId).sort()).toEqual(
        [chats[0].id, chats[1].id].sort(),
      );
      for (const chat of countedChats ?? []) {
        expect(chat).not.toHaveProperty('resumePromptKind');
        expect(chat).not.toHaveProperty('lastStep');
      }

      // The recorded success beyond the truncation window reaches the row.
      const home = await openHome(window, new CanopyAppDriver(window));
      await home.getByTestId('home-interrupted-sessions-resume').click();
      const modal = window.getByTestId('usage-limit-resume-modal');
      await expect(modal).toBeVisible({ timeout: 15_000 });
      await expect(
        modal
          .getByTestId(`usage-limit-resume-chat-${chats[0].id}-metadata`)
          .locator('xpath=following-sibling::p[1]'),
      ).toContainText(
        'Last step: Edit src/api/client.ts (finished) · Stopped ',
        {
          timeout: 15_000,
        },
      );
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('withholds Home resume choices after an automation refresh fails and recovers on focus (CAN-4970)', async () => {
    const userDataDir = seed(
      CHATS.slice(0, 2).map((chat) => registryEntry(chat, 'usage_limit')),
    );
    const { electronApp } = await launchCanopy({
      userDataDir,
      env: {
        CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
          'canopy-shared-org-projects-enabled': true,
        }),
      },
    });
    try {
      const window = await electronApp.firstWindow();
      const home = await openHome(window, new CanopyAppDriver(window));
      const details = home.getByTestId('home-interrupted-sessions-details');
      await expect(details).toHaveText('Resume 2 interrupted chats');
      await home.getByTestId('home-interrupted-sessions-resume').click();
      await expect(
        window.getByTestId('usage-limit-resume-modal'),
      ).toBeVisible();

      await electronApp.evaluate(({ ipcMain }) => {
        const list = ipcMain._invokeHandlers.get('automations:list');
        if (!list) throw new Error('Missing automations listing handler');
        globalThis.__can4970FailAutomationsList = true;
        ipcMain.removeHandler('automations:list');
        ipcMain.handle('automations:list', (event, request) => {
          if (globalThis.__can4970FailAutomationsList)
            throw new Error('Injected automation refresh failure');
          return list(event, request);
        });
      });
      // Creating a real schedule broadcasts an update. In organization mode
      // consumers reload the context snapshot instead of using the broadcast.
      // The schedule comes from outside the dialog, so the open dialog drops
      // the chat at once; only the dialog's own schedules stay (CAN-5015).
      const scheduled = await window.evaluate(
        ({ workspaceId, worktreeId, chatId }) =>
          window.api.automations.create({
            name: 'Resume capped chat',
            enabled: true,
            schedule: {
              kind: 'one_time',
              runAt: new Date(Date.now() + 3_600_000).toISOString(),
              timezone: 'local',
            },
            action: {
              type: 'worktree_session_prompt',
              workspaceId,
              worktreeId,
              chatId,
              prompt: 'Continue',
              purpose: 'usage_limit_resume',
            },
          }),
        {
          workspaceId: WORKSPACE_ID,
          worktreeId: WORKTREE_ID,
          chatId: CHATS[0].id,
        },
      );
      expect(scheduled.ok).toBe(true);
      await expect(
        window.getByText('Couldn’t load interrupted work.', {
          exact: true,
        }),
      ).toBeVisible();
      await expect(
        window.getByTestId('usage-limit-resume-confirm'),
      ).toHaveCount(0);
      await window.getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(
        home.getByTestId('home-interrupted-sessions-resume'),
      ).toBeHidden();

      await electronApp.evaluate(() => {
        globalThis.__can4970FailAutomationsList = false;
      });
      await window.evaluate(() => window.dispatchEvent(new Event('focus')));
      await expect(details).toContainText(`Resume ${CHATS[1].title}`);
      await home.getByTestId('home-interrupted-sessions-resume').click();
      const modal = window.getByTestId('usage-limit-resume-modal');
      await expect(
        modal.getByTestId(`usage-limit-resume-chat-${CHATS[0].id}`),
      ).toHaveCount(0);
      await expect(
        modal.getByTestId(`usage-limit-resume-chat-${CHATS[1].id}`),
      ).toBeChecked();
      expect(readRegistry(userDataDir).entries).toHaveLength(2);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('cold Home excludes scheduled resumes and restores them after real API deletion (CAN-4970)', async () => {
    const entries = CHATS.slice(0, 2).map((chat) =>
      registryEntry(chat, 'usage_limit'),
    );
    const userDataDir = seed(entries);
    const runAt = new Date(Date.now() + 3_600_000).toISOString();
    seedAutomations({
      userDataDir,
      activities: [
        {
          version: 1,
          id: 'can-4970-resume',
          name: 'Resume capped chat',
          enabled: true,
          schedule: { kind: 'one_time', runAt, timezone: 'local' },
          action: {
            type: 'worktree_session_prompt',
            workspaceId: WORKSPACE_ID,
            worktreeId: WORKTREE_ID,
            chatId: CHATS[0].id,
            prompt: 'Continue',
            purpose: 'usage_limit_resume',
          },
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          nextRunAt: runAt,
          failureCount: 0,
        },
      ],
    });
    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      // No worktree is opened before the Home row and dialog read automations.
      const home = await openHome(window, new CanopyAppDriver(window));
      const details = home.getByTestId('home-interrupted-sessions-details');
      await expect(details).toContainText(`Resume ${CHATS[1].title}`);
      await home.getByTestId('home-interrupted-sessions-resume').click();
      const modal = window.getByTestId('usage-limit-resume-modal');
      await expect(modal).toBeVisible();
      await expect(
        modal.getByTestId(`usage-limit-resume-chat-${CHATS[0].id}`),
      ).toHaveCount(0);
      await expect(
        modal.getByTestId(`usage-limit-resume-chat-${CHATS[1].id}`),
      ).toBeChecked();
      await expect(modal.getByTestId('usage-limit-resume-confirm')).toHaveText(
        'Resume chat',
      );
      expect(readRegistry(userDataDir).entries).toHaveLength(2);
      // A schedule made outside the dialog never offers the dialog's Undo.
      await expect(
        modal.getByTestId(
          `usage-limit-resume-undo-schedule-chat-${CHATS[0].id}`,
        ),
      ).toHaveCount(0);
      const removed = await window.evaluate(() =>
        window.api.automations.delete({ id: 'can-4970-resume' }),
      );
      expect(removed.ok).toBe(true);
      await expect(
        modal.getByTestId(`usage-limit-resume-chat-${CHATS[0].id}`),
      ).toBeVisible();
      await expect(
        modal.getByTestId(`usage-limit-resume-chat-${CHATS[0].id}`),
      ).not.toBeChecked();
      await modal.getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(details).toHaveText('Resume 2 interrupted chats');
      await home.getByTestId('home-interrupted-sessions-resume').click();
      for (const chat of CHATS.slice(0, 2))
        await expect(
          modal.getByTestId(`usage-limit-resume-chat-${chat.id}`),
        ).toBeChecked();
      expect(readRegistry(userDataDir).entries).toHaveLength(2);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('excludes retained sessions for archived or deleted work and workspaces', async () => {
    const { userDataDir, scopes } = seedInterruptedSessionScopes();
    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      const home = await openHome(window, new CanopyAppDriver(window));
      await home.getByTestId('home-interrupted-sessions-resume').click();
      const modal = window.getByTestId('usage-limit-resume-modal');
      await expect(modal).toBeVisible();
      for (const scope of scopes) {
        const row = modal.getByTestId(
          `usage-limit-resume-chat-${scope.chatId}`,
        );
        if (scope.live) await expect(row).toBeChecked();
        else await expect(row).toHaveCount(0);
      }
      await expect(modal).toContainText('live-pipeline');
      await expect(modal).toContainText('local-pipeline');
      await expect(modal).toContainText('legacy-standalone-pipeline');
      await expect(modal).not.toContainText('archived-pipeline');
      await expect(modal).not.toContainText('deleted-entry-pipeline');
      await expect(modal).not.toContainText('deleted-workspace-pipeline');
      await expect(modal.getByTestId('usage-limit-resume-confirm')).toHaveText(
        'Resume 3 chats and 3 workflows',
      );
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('resumes a migrated standalone chat from its owning Work Entry', async () => {
    const { userDataDir } = seedInterruptedSessionScopes();
    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      const home = await openHome(window, new CanopyAppDriver(window));
      await home.getByTestId('home-interrupted-sessions-resume').click();
      const modal = window.getByTestId('usage-limit-resume-modal');
      await expect(modal).toBeVisible();
      const chat = modal.getByTestId(
        'usage-limit-resume-chat-migrated-legacy-chat',
      );
      await expect(chat).toBeChecked();
      for (const checkbox of await modal
        .locator('input[type="checkbox"]')
        .all()) {
        await checkbox.uncheck();
      }
      await chat.check();
      await expect(modal.getByTestId('usage-limit-resume-confirm')).toHaveText(
        'Resume chat',
      );
      await modal.getByTestId('usage-limit-resume-confirm').click();
      await expect(modal).toBeHidden();
      await expect
        .poll(() =>
          readRegistry(userDataDir).entries.map((entry) => entry.chatId),
        )
        .not.toContain('migrated-legacy-chat');
      // One confirmed chat opens directly; the chip reopens its queue.
      await expect(window.getByTestId('resume-queue-modal')).toBeHidden();
      await expect(
        window.locator('[data-panel-id="panel-chat-migrated-legacy-chat"]'),
      ).toBeVisible();
      await expect(window.getByTestId('resume-queue-sidebar')).toContainText(
        'Resumed',
      );
      await window.getByTestId('resume-queue-sidebar-open-queue').click();
      await expect(window.getByTestId('resume-queue-modal')).toContainText(
        'Resumed',
      );
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('discovers an interrupted JSONL chat on Home before opening its worktree', async () => {
    const { userDataDir } = await seedTranscriptRecovery({
      interrupted: true,
      interruptedScopeId: WORKTREE_ID,
    });
    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      const home = await openHome(window, new CanopyAppDriver(window));
      const banner = home.getByTestId('home-interrupted-sessions-banner');
      await expect(banner).toBeVisible();
      await banner.getByTestId('home-interrupted-sessions-resume').click();
      await expect(
        window.getByTestId('usage-limit-resume-modal'),
      ).toContainText('Application stopped');
      expect(readRegistry(userDataDir).entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            chatId: 'long',
            resumeReason: 'app_shutdown',
          }),
        ]),
      );
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
  test('recovers a retained JSONL scope without offering its removed worktree', async () => {
    const { userDataDir } = await seedTranscriptRecovery({ interrupted: true });
    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      const home = await openHome(window, new CanopyAppDriver(window));
      await expect
        .poll(() => readRegistry(userDataDir).entries)
        .toContainEqual(
          expect.objectContaining({
            chatId: 'long',
            worktreeId: 'startup-recovery',
            resumeReason: 'app_shutdown',
          }),
        );
      expect(
        await window.evaluate(() =>
          window.api.listUsageLimitedIdleSessions({}),
        ),
      ).toEqual([]);
      await expect(
        home.getByTestId('home-interrupted-sessions-banner'),
      ).toBeHidden();
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('covers usage-limit and application-stop interrupts and opens the shared resume modal', async () => {
    // Two queued resumes, paced 10 seconds apart, after launch.
    test.setTimeout(120_000);
    const userDataDir = seed([
      registryEntry(CHATS[0], 'usage_limit'),
      registryEntry(CHATS[1], 'app_shutdown'),
    ]);
    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      const homePage = await openHome(window, app);

      const banner = homePage.getByTestId('home-interrupted-sessions-banner');
      await expect(banner).toBeVisible({ timeout: 15_000 });
      await expect(banner).toContainText('Resume 2 interrupted chats');

      await banner.getByTestId('home-interrupted-sessions-resume').click();
      const modal = window.getByTestId('usage-limit-resume-modal');
      await expect(modal).toBeVisible({ timeout: 15_000 });
      await expect(
        window.getByText('Review why this work stopped below.'),
      ).toBeVisible();
      await expect(modal).toContainText(CHATS[0].title);
      await expect(modal).toContainText(CHATS[1].title);
      await expect(modal).toContainText('Application stopped');
      await expect(
        window.getByTestId(`usage-limit-resume-chat-${CHATS[0].id}`),
      ).toBeChecked();
      await expect(
        window.getByTestId(`usage-limit-resume-chat-${CHATS[1].id}`),
      ).toBeChecked();

      await window.getByTestId('usage-limit-resume-confirm').click();
      await expect(modal).toBeHidden({ timeout: 20_000 });

      // The resume queue starts sessions 10 seconds apart, so the second one
      // leaves the registry well after the dialog closes. Wait for the queue
      // to drain; its last settled resume refetches the banner away.
      await expect
        .poll(() => readRegistry(userDataDir).entries, { timeout: 60_000 })
        .toEqual([]);
      await expect(banner).toBeHidden({ timeout: 15_000 });
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('preserves pending choices and mounted rows through background workspace refreshes', async () => {
    const userDataDir = seed([
      registryEntry(CHATS[0], 'usage_limit'),
      registryEntry(CHATS[1], 'app_shutdown'),
    ]);
    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      const home = await openHome(window, new CanopyAppDriver(window));
      await home.getByTestId('home-interrupted-sessions-resume').click();
      const modal = window.getByTestId('usage-limit-resume-modal');
      await expect(modal).toBeVisible();
      const checkbox = modal.getByTestId(
        `usage-limit-resume-chat-${CHATS[0].id}`,
      );
      await checkbox.uncheck();
      await checkbox.focus();
      const originalRow = await checkbox.elementHandle();
      for (let refresh = 0; refresh < 3; refresh++) {
        await window.evaluate(() => {
          window.__canopyProjectsTestApi.holdNextLoadAfterRead();
          window.__canopyProjectsTestApi.loadProjects();
        });
        await window.evaluate(() =>
          window.__canopyProjectsTestApi.waitForHeldLoad(),
        );
        await window.evaluate(() =>
          window.__canopyProjectsTestApi.releaseHeldLoad(),
        );
        await expect(checkbox).not.toBeChecked();
        await expect(checkbox).toBeFocused();
        expect(await originalRow.evaluate((row) => row.isConnected)).toBe(true);
        await expect(
          modal.getByTestId('usage-limit-resume-confirm'),
        ).toHaveText('Resume chat');
      }
      await modal.getByTestId('usage-limit-resume-confirm').click();
      await expect(modal).toBeHidden();
      // One confirmed chat opens directly; the chip reopens its queue.
      await expect(window.getByTestId('resume-queue-sidebar')).toContainText(
        CHATS[1].title,
      );
      await window.getByTestId('resume-queue-sidebar-open-queue').click();
      const queue = window.getByTestId('resume-queue-modal');
      await expect(queue.locator('li')).toHaveCount(1);
      await expect(queue).toContainText(CHATS[1].title);
      // Closing the selection dialog acknowledges enqueueing; dispatch and
      // registry cleanup complete asynchronously in the resume queue.
      await expect
        .poll(() =>
          readRegistry(userDataDir).entries.map((entry) => entry.chatId),
        )
        .toEqual([CHATS[0].id]);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('keeps the loaded list and choices when a background refresh fails', async () => {
    const userDataDir = seed([
      registryEntry(CHATS[0], 'usage_limit'),
      registryEntry(CHATS[1], 'app_shutdown'),
    ]);
    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      const home = await openHome(window, new CanopyAppDriver(window));
      await home.getByTestId('home-interrupted-sessions-resume').click();
      const modal = window.getByTestId('usage-limit-resume-modal');
      const checkbox = modal.getByTestId(
        `usage-limit-resume-chat-${CHATS[0].id}`,
      );
      await checkbox.uncheck();

      await electronApp.evaluate(({ ipcMain }) => {
        globalThis.__failedResumeRefreshes = 0;
        ipcMain.removeHandler('usage-limited-sessions:list');
        ipcMain.handle('usage-limited-sessions:list', () => {
          globalThis.__failedResumeRefreshes += 1;
          throw new Error('Injected background refresh failure');
        });
      });
      await window.evaluate(() => window.dispatchEvent(new Event('focus')));
      await expect
        .poll(() =>
          electronApp.evaluate(() => globalThis.__failedResumeRefreshes),
        )
        .toBe(1);
      await window.evaluate(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          ),
      );

      await expect(modal).not.toContainText('Couldn’t load interrupted work.');
      await expect(checkbox).not.toBeChecked();
      await expect(modal.getByTestId('usage-limit-resume-confirm')).toHaveText(
        'Resume chat',
      );
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('refreshes session additions and removals without clearing valid choices', async () => {
    const initial = [
      registryEntry(CHATS[0], 'usage_limit'),
      registryEntry(CHATS[1], 'app_shutdown'),
    ];
    const userDataDir = seed(initial);
    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      const home = await openHome(window, new CanopyAppDriver(window));
      await home.getByTestId('home-interrupted-sessions-resume').click();
      const modal = window.getByTestId('usage-limit-resume-modal');
      const checkbox = modal.getByTestId(
        `usage-limit-resume-chat-${CHATS[0].id}`,
      );
      await checkbox.uncheck();
      await checkbox.focus();
      const originalRow = await checkbox.elementHandle();
      const newEntry = registryEntry(CHATS[2], 'app_shutdown');
      seedUsageLimitedChats({ userDataDir, entries: [...initial, newEntry] });
      await window.evaluate(() => window.dispatchEvent(new Event('focus')));
      const newCheckbox = modal.getByTestId(
        `usage-limit-resume-chat-${CHATS[2].id}`,
      );
      await expect(newCheckbox).toBeVisible();
      await expect(newCheckbox).not.toBeChecked();
      await expect(checkbox).not.toBeChecked();
      await expect(checkbox).toBeFocused();
      expect(await originalRow.evaluate((row) => row.isConnected)).toBe(true);
      await expect(modal.getByTestId('usage-limit-resume-confirm')).toHaveText(
        'Resume chat',
      );
      seedUsageLimitedChats({ userDataDir, entries: [initial[0], newEntry] });
      await window.evaluate(() => window.dispatchEvent(new Event('focus')));
      await expect(
        modal.getByTestId(`usage-limit-resume-chat-${CHATS[1].id}`),
      ).toHaveCount(0);
      await expect(
        modal.getByTestId('usage-limit-resume-confirm'),
      ).toBeDisabled();
      await expect(checkbox).not.toBeChecked();
      await modal.getByTestId('usage-limit-resume-cancel').click();
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('dismisses until the interrupted set changes, across providers', async () => {
    const userDataDir = seed([
      registryEntry(CHATS[0], 'usage_limit'),
      registryEntry(CHATS[2], 'app_shutdown'),
    ]);
    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      const homePage = await openHome(window, app);

      const banner = homePage.getByTestId('home-interrupted-sessions-banner');
      await expect(banner).toBeVisible({ timeout: 15_000 });
      await expect(banner).toContainText('Resume 2 interrupted chats');

      await banner.getByTestId('home-interrupted-sessions-dismiss').click();
      await expect(banner).toBeHidden();

      // Leaving and returning to Home does not resurrect a dismissed banner
      // for the same interrupted set.
      await app.openMainPage();
      await window.getByTestId('sidebar-create-task').click();
      await expect(window.getByTestId('page-home')).toBeVisible();
      await window.waitForTimeout(1_000);
      await expect(banner).toBeHidden();

      // A new interruption changes the set: the banner returns on the next
      // refresh (window focus is one of the refresh triggers).
      seedUsageLimitedChats({
        userDataDir,
        entries: [
          registryEntry(CHATS[0], 'usage_limit'),
          registryEntry(CHATS[2], 'app_shutdown'),
          registryEntry(CHATS[1], 'authentication'),
        ],
      });
      await window.evaluate(() => window.dispatchEvent(new Event('focus')));
      await expect(banner).toBeVisible({ timeout: 15_000 });
      await expect(banner).toContainText('Resume 3 interrupted chats');
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('does not render when nothing is interrupted', async () => {
    const userDataDir = seed([]);
    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      const homePage = await openHome(window, app);
      await expect(homePage.getByTestId('home-composer')).toBeVisible();
      await window.waitForTimeout(1_500);
      await expect(
        homePage.getByTestId('home-interrupted-sessions-banner'),
      ).toBeHidden();
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
});
