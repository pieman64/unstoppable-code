import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import {
  clearScenario,
  DEFAULT_MOCK_BASE_URL,
  registerScenario,
  seedUsageLimitedChats,
  seedWorktreeChat,
} from './seeders/index.mjs';
import {
  WAITING_RESET,
  WAITING_WORKSPACE,
  WAITING_WORKTREE,
  waitingUsageScenario,
} from './fixtures/usage-waiting-sessions.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

// Usage card and Home agree on waiting chats (CAN-5014). A chat with a
// pending usage-limit resume automation will resume on its own, so Home
// (CAN-4970) and the Usage provider card both leave it out: the card's count,
// its single-chat Open action, and its chooser come from the same filtered
// list. Only the Home dialog keeps a chat scheduled during its current
// opening, for Undo (CAN-5015). Scheduling never removes a registry entry.
// Codex's weekly window is at 100% through the build-gated auth/usage mock,
// keyed by each test's own bearer so it never leaks into concurrent specs.

let usageKey = '';
const PROVIDER = 'codex';

function seed(chatIds) {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-usage-card-scheduled-resume-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WAITING_WORKSPACE,
    worktreeId: WAITING_WORKTREE,
    providerType: PROVIDER,
    tabs: chatIds.map((id) => ({ id, title: id })),
  });
  seedUsageLimitedChats({
    userDataDir,
    entries: chatIds.map((chatId) => ({
      projectId: WAITING_WORKSPACE,
      worktreeId: WAITING_WORKTREE,
      chatId,
      provider: PROVIDER,
      detectedAt: Date.parse('2026-10-20T12:00:00.000Z'),
      workspaceName: 'TypeScript pnpm Vite',
      chatTitle: chatId,
      resumeReason: 'usage_limit',
      resetsAt: Date.parse(WAITING_RESET),
    })),
  });
  return userDataDir;
}

function registryChatIds(userDataDir) {
  return JSON.parse(
    readFileSync(path.join(userDataDir, 'usage-limited-chats.json'), 'utf8'),
  )
    .entries.map((entry) => entry.chatId)
    .sort();
}

async function scheduledResumes(window) {
  const snapshot = await window.evaluate(() => window.api.automations.list());
  return snapshot.activities.filter(
    (activity) =>
      activity.enabled &&
      activity.action.type === 'worktree_session_prompt' &&
      activity.action.purpose === 'usage_limit_resume' &&
      activity.action.workspaceId === WAITING_WORKSPACE &&
      activity.action.worktreeId === WAITING_WORKTREE,
  );
}

async function scheduledChatIds(window) {
  return (await scheduledResumes(window))
    .map((activity) => activity.action.chatId)
    .sort();
}

async function openHome(window) {
  await window.getByTestId('sidebar-create-task').click();
  const home = window.getByTestId('page-home');
  await expect(home).toBeVisible();
  return home;
}

async function openResumeDialog(window, home) {
  await home.getByTestId('home-interrupted-sessions-resume').click();
  const modal = window.getByTestId('usage-limit-resume-modal');
  await expect(modal).toBeVisible({ timeout: 30_000 });
  return modal;
}

function dialogChatIds(modal) {
  return modal
    .locator('input[type="checkbox"][data-testid^="usage-limit-resume-chat-"]')
    .evaluateAll((inputs) =>
      inputs
        .map((input) =>
          input.dataset.testid.replace('usage-limit-resume-chat-', ''),
        )
        .sort(),
    );
}

/** Schedules each chat from the open Home dialog and waits for persistence. */
async function scheduleFromDialog(window, modal, chatIds) {
  for (const chatId of chatIds) {
    await modal
      .getByTestId(`usage-limit-resume-schedule-chat-${chatId}`)
      .click();
    await expect(
      modal.getByTestId(`usage-limit-resume-scheduled-chat-${chatId}`),
    ).toHaveText(/^Scheduled for .+/, { timeout: 30_000 });
    await expect
      .poll(async () => (await scheduledChatIds(window)).includes(chatId))
      .toBe(true);
    // The current opening keeps the row and its Undo (CAN-5015).
    await expect(
      modal.getByTestId(`usage-limit-resume-undo-schedule-chat-${chatId}`),
    ).toHaveText('Undo');
  }
}

function usageCard(window) {
  return window
    .getByTestId(`usage-provider-card-${PROVIDER}`)
    .filter({ visible: true });
}

function chooserChatIds(window) {
  const prefix = `usage-provider-${PROVIDER}-waiting-session-chat-${WAITING_WORKSPACE}-${WAITING_WORKTREE}-`;
  return window
    .getByTestId(`usage-provider-${PROVIDER}-waiting-chooser`)
    .locator(`[data-testid^="${prefix}"]`)
    .evaluateAll(
      (rows, rowPrefix) =>
        rows.map((row) => row.dataset.testid.replace(rowPrefix, '')).sort(),
      prefix,
    );
}

test.describe('usage card scheduled resumes', () => {
  test.beforeEach(async ({}, testInfo) => {
    usageKey = `usage-card-scheduled-resume-${testInfo.workerIndex}-${testInfo.testId}`;
    await registerScenario(
      DEFAULT_MOCK_BASE_URL,
      usageKey,
      waitingUsageScenario(),
    );
  });
  test.afterEach(async () => {
    await clearScenario(DEFAULT_MOCK_BASE_URL, usageKey);
  });

  test('counts, opens and hides waiting chats the same way as Home', async () => {
    test.setTimeout(180_000);
    const chats = ['waiting-chat-one', 'waiting-chat-two'];
    const [scheduledChat, remainingChat] = chats;
    const userDataDir = seed(chats);
    const { electronApp } = await launchCanopy({
      userDataDir,
      env: { CANOPY_MOCK_API_KEY: usageKey },
    });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });

      // Home offers both chats until one is scheduled.
      let home = await openHome(window);
      const banner = home.getByTestId('home-interrupted-sessions-details');
      await expect(banner).toContainText('2', { timeout: 30_000 });
      const modal = await openResumeDialog(window, home);
      await expect.poll(() => dialogChatIds(modal)).toEqual(chats);
      await scheduleFromDialog(window, modal, [scheduledChat]);
      await expect.poll(() => dialogChatIds(modal)).toEqual(chats);
      await modal.getByTestId('usage-limit-resume-cancel').click();
      await expect(modal).toBeHidden();

      // Home now names only the remaining chat; reopening excludes the other.
      await expect(banner).toContainText(remainingChat, { timeout: 30_000 });
      await expect(banner).not.toContainText(scheduledChat);
      const reopened = await openResumeDialog(window, home);
      await expect.poll(() => dialogChatIds(reopened)).toEqual([remainingChat]);
      await reopened.getByTestId('usage-limit-resume-cancel').click();
      await expect(reopened).toBeHidden();

      // The Usage card agrees and opens the remaining chat.
      await app.openUsagePage();
      const card = usageCard(window);
      const waiting = card.getByTestId(`usage-provider-${PROVIDER}-waiting`);
      await expect(waiting).toContainText('1 interrupted session', {
        timeout: 30_000,
      });
      await expect(waiting).not.toContainText('1 interrupted sessions');
      await expect(card).toContainText('Limit reached');
      await expect(
        waiting.getByTestId(`usage-provider-${PROVIDER}-waiting-view`),
      ).toHaveCount(0);
      await expect(
        card.getByTestId(`usage-provider-${PROVIDER}-resume`),
      ).toHaveCount(0);
      expect(registryChatIds(userDataDir)).toEqual(chats);

      // Removing the schedule restores the chat without leaving Usage.
      const [activity] = await scheduledResumes(window);
      await window.evaluate(
        (id) => window.api.automations.delete({ id }),
        activity.id,
      );
      await expect(waiting).toContainText('2 interrupted sessions', {
        timeout: 30_000,
      });
      await waiting
        .getByTestId(`usage-provider-${PROVIDER}-waiting-view`)
        .click();
      await expect.poll(() => chooserChatIds(window)).toEqual(chats);
      await window.keyboard.press('Escape');
      await expect(
        window.getByTestId(`usage-provider-${PROVIDER}-waiting-chooser`),
      ).toBeHidden();

      // With every chat scheduled, neither surface advertises waiting work.
      home = await openHome(window);
      const allModal = await openResumeDialog(window, home);
      await scheduleFromDialog(window, allModal, chats);
      await allModal.getByTestId('usage-limit-resume-cancel').click();
      await expect(allModal).toBeHidden();
      await expect(
        home.getByTestId('home-interrupted-sessions-resume'),
      ).toBeHidden({
        timeout: 30_000,
      });
      await app.openUsagePage();
      await expect(card).toContainText('Limit reached', { timeout: 30_000 });
      await expect(
        card.getByTestId(`usage-provider-${PROVIDER}-waiting`),
      ).toHaveCount(0);
      expect(registryChatIds(userDataDir)).toEqual(chats);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('opens the one unscheduled chat from the Usage card', async () => {
    test.setTimeout(180_000);
    const chats = ['waiting-chat-one', 'waiting-chat-two'];
    const [scheduledChat, remainingChat] = chats;
    const userDataDir = seed(chats);
    const { electronApp } = await launchCanopy({
      userDataDir,
      env: { CANOPY_MOCK_API_KEY: usageKey },
    });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      const home = await openHome(window);
      const modal = await openResumeDialog(window, home);
      await scheduleFromDialog(window, modal, [scheduledChat]);
      await modal.getByTestId('usage-limit-resume-cancel').click();
      await expect(modal).toBeHidden();

      await app.openUsagePage();
      const waiting = usageCard(window).getByTestId(
        `usage-provider-${PROVIDER}-waiting`,
      );
      await expect(waiting).toContainText('1 interrupted session', {
        timeout: 30_000,
      });
      await waiting
        .getByTestId(`usage-provider-${PROVIDER}-waiting-open`)
        .click();
      await expect(
        window.locator(`[data-panel-id="panel-chat-${remainingChat}"]`),
      ).toBeVisible({ timeout: 15_000 });
      await expect(window.getByTestId('usage-limit-resume-modal')).toHaveCount(
        0,
      );
      expect(registryChatIds(userDataDir)).toEqual(chats);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('keeps scheduled chats out of the chooser, including while it is open', async () => {
    test.setTimeout(180_000);
    const chats = [
      'waiting-chat-one',
      'waiting-chat-three',
      'waiting-chat-two',
    ];
    const [scheduledChat] = chats;
    const unscheduled = chats.filter((chatId) => chatId !== scheduledChat);
    const userDataDir = seed(chats);
    const { electronApp } = await launchCanopy({
      userDataDir,
      env: {
        CANOPY_MOCK_API_KEY: usageKey,
        // Exercise broadcasts that reload the current context's automations.
        CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
          'canopy-shared-org-projects-enabled': true,
        }),
      },
    });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      const home = await openHome(window);
      const modal = await openResumeDialog(window, home);
      await scheduleFromDialog(window, modal, [scheduledChat]);
      await modal.getByTestId('usage-limit-resume-cancel').click();
      await expect(modal).toBeHidden();

      await app.openUsagePage();
      const waiting = usageCard(window).getByTestId(
        `usage-provider-${PROVIDER}-waiting`,
      );
      await expect(waiting).toContainText('2 interrupted sessions', {
        timeout: 30_000,
      });
      await waiting
        .getByTestId(`usage-provider-${PROVIDER}-waiting-view`)
        .click();
      const chooser = window.getByTestId(
        `usage-provider-${PROVIDER}-waiting-chooser`,
      );
      await expect(chooser).toBeVisible();
      await expect.poll(() => chooserChatIds(window)).toEqual(unscheduled);

      // Disabling the schedule while the chooser is open restores its row.
      const [activity] = await scheduledResumes(window);
      await window.evaluate(
        (id) => window.api.automations.update({ id, enabled: false }),
        activity.id,
      );
      await expect.poll(() => chooserChatIds(window)).toEqual(chats);
      await expect(chooser).toBeVisible();
      await expect(waiting).toContainText('3 interrupted sessions');
      expect(registryChatIds(userDataDir)).toEqual(chats);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
});
