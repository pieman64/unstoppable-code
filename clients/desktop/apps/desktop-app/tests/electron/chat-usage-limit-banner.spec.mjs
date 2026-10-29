import {
  readChatStorageIndexes,
  readChatStorageMessages,
} from './readChatStorage.mjs';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { injectChatEvent, seedWorktreeChat } from './seeders/index.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  closeFixture,
  createFixture,
  seedPreferences,
} from './codexPipelineRuntime.mjs';

const WORKTREE_ID = 'demo-main';
const WORKTREE_BRANCH = 'demo-main';
const TEST_CLOUD_API_KEY = 'csk_chat_usage_limit_combined_actions_e2e';
const CLOUD_ACCOUNT_CHANGED_EVENT = 'canopy:cloud-account-changed';

const CASES = [
  {
    providerType: 'claude',
    workspaceId: 'demo-ts-pnpm-vite',
    workspaceName: 'TypeScript pnpm Vite',
    app: 'ts-pnpm-vite',
    userDataPrefix: 'canopy-chat-usage-limit-claude-',
    expectedText: 'Claude usage limit reached',
  },
  {
    providerType: 'codex',
    workspaceId: 'demo-ts-npm-next',
    workspaceName: 'TypeScript npm Next',
    app: 'ts-npm-next',
    userDataPrefix: 'canopy-chat-usage-limit-codex-',
    expectedText: 'Codex usage limit reached',
  },
];

function buildUsageLimitBanner(providerType) {
  return {
    provider: providerType,
    message: `${providerType} usage limit reached in mock chat.`,
    detectedAt: Date.parse('2026-04-10T12:00:00.000Z'),
    requestId: `mock-${providerType}-usage-limit`,
    dismissKey: `usage-limit:${providerType}:mock`,
  };
}

/**
 * Launches a seeded worktree chat, connects the mock cloud account and opens
 * `demo-main`, for the CAN-4757 flows below.
 */
async function launchUsageLimitedWorktree({ userDataDir }) {
  const { electronApp } = await launchCanopy({ userDataDir });
  const window = await electronApp.firstWindow();
  const app = new CanopyAppDriver(window);

  await app.waitForShell({ timeout: 30_000 });
  const saveResult = await window.evaluate(
    async (apiKey) => window.api.saveCanopyCloudApiKey({ apiKey }),
    TEST_CLOUD_API_KEY,
  );
  expect(saveResult.status.authenticated).toBe(true);
  await window.evaluate((eventName) => {
    window.dispatchEvent(new Event(eventName));
  }, CLOUD_ACCOUNT_CHANGED_EVENT);

  await app.openMainPage();
  await app.selectWorktree(WORKTREE_BRANCH);
  return { electronApp, window };
}

/** One chat's panel. Every open chat tab keeps its panel mounted. */
function chatPanel(window, chatId) {
  return window.locator(`[data-panel-id="panel-chat-${chatId}"]`);
}

/**
 * Clicks "Use credits now" without sending and asserts the usage-limit notice
 * (with its once, always and schedule controls) yields to the credits card.
 */
async function useCreditsNowAndExpectOnlyTheCard(panel) {
  const banner = panel.getByTestId('chat-input-usage-limit-banner');
  const card = panel.getByTestId('chat-input-ai-credits-active');
  await expect(
    panel.getByTestId('chat-input-usage-limit-ai-credits-offer'),
  ).toBeVisible({ timeout: 30_000 });
  await expect(card).toBeHidden();

  await panel.getByTestId('chat-input-usage-limit-ai-credits-once').click();

  await expect(card).toContainText('Using AI Credits');
  await expect(banner).toBeHidden();
  for (const testId of [
    'chat-input-usage-limit-ai-credits-once',
    'chat-input-usage-limit-ai-credits-always-on-quota',
    'chat-input-usage-limit-schedule-resume',
  ]) {
    await expect(panel.getByTestId(testId)).toHaveCount(0);
  }
}

test.describe('chat usage-limit banner', () => {
  for (const testCase of CASES) {
    test(`${testCase.providerType} chat shows the usage-limit banner and Resume at reset CTA`, async () => {
      const userDataDir = mkdtempSync(
        path.join(os.tmpdir(), testCase.userDataPrefix),
      );

      seedDemoWorkspaces({ userDataDir, apps: [testCase.app] });
      seedWorktreeChat({
        userDataDir,
        workspaceId: testCase.workspaceId,
        worktreeId: WORKTREE_ID,
        providerType: testCase.providerType,
        tabs: [
          {
            id: `${testCase.providerType}-usage-limit-tab`,
            title: `${testCase.providerType} Usage Limit`,
            claudeUsageLimitBanner: buildUsageLimitBanner(
              testCase.providerType,
            ),
          },
        ],
      });

      const { electronApp } = await launchCanopy({ userDataDir });

      try {
        const window = await electronApp.firstWindow();
        const app = new CanopyAppDriver(window);

        await app.waitForShell({ timeout: 30_000 });
        await app.openMainPage();

        await app.selectWorktree(WORKTREE_BRANCH);
        await expect(window.getByTestId('panel-content-chat')).toBeVisible();

        const banner = window.getByTestId('chat-input-usage-limit-banner');
        await expect(banner).toBeVisible({ timeout: 30_000 });
        // The notice column is the stack's only spacing owner.
        const notices = window.getByTestId('chat-input-notices');
        await expect(notices).toBeVisible();
        // CAN-4396: the shared composer notice stack keeps the notices on
        // the composer box's edges, 8px above it.
        const noticesBox = await notices.boundingBox();
        const composerBox = await window
          .locator('[data-composer-layout]')
          .filter({ visible: true })
          .first()
          .boundingBox();
        expect(Math.abs(noticesBox.x - composerBox.x)).toBeLessThanOrEqual(1);
        expect(
          Math.abs(
            noticesBox.x +
              noticesBox.width -
              (composerBox.x + composerBox.width),
          ),
        ).toBeLessThanOrEqual(1);
        expect(
          Math.abs(composerBox.y - (noticesBox.y + noticesBox.height) - 8),
        ).toBeLessThanOrEqual(1);
        await expect(banner).toContainText(testCase.expectedText);
        await expect(banner).toContainText(
          'to keep working when you hit your provider limits',
        );

        const scheduleResume = window.getByTestId(
          'chat-input-usage-limit-schedule-resume',
        );
        await expect(scheduleResume).toBeVisible();
        await expect(scheduleResume).toBeEnabled();

        await expect(
          window.getByTestId('chat-input-usage-limit-dismiss'),
        ).toBeVisible();

        const retryMessage = `Retry after ${testCase.providerType} limit.`;
        const composer = window.getByRole('textbox').first();
        await expect(composer).toBeVisible();
        await composer.click();
        await composer.fill(retryMessage);

        await window.getByRole('button', { name: 'Send message' }).click();
        await expect(banner).toBeHidden({ timeout: 10_000 });
        // With nothing left in it the column collapses (`empty:hidden`) so
        // no dead space stays above the composer.
        await expect(notices).toBeHidden();
      } finally {
        await closeCanopy(electronApp, userDataDir);
      }
    });
  }

  test('external prompts preserve the banner until provider dispatch is accepted', async () => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-chat-usage-limit-external-dispatch-'),
    );
    const workspaceId = 'demo-ts-pnpm-vite';
    const chatId = 'external-usage-limit-tab';

    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    seedWorktreeChat({
      userDataDir,
      workspaceId,
      worktreeId: WORKTREE_ID,
      providerType: 'claude',
      tabs: [
        {
          id: chatId,
          title: 'External Dispatch Usage Limit',
          claudeUsageLimitBanner: buildUsageLimitBanner('claude'),
        },
      ],
    });

    const { electronApp } = await launchCanopy({ userDataDir });

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);

      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();
      await app.selectWorktree(WORKTREE_BRANCH);

      const banner = window.getByTestId('chat-input-usage-limit-banner');
      await expect(banner).toBeVisible({ timeout: 30_000 });

      await injectChatEvent(electronApp, {
        projectId: workspaceId,
        worktreeId: WORKTREE_ID,
        chatId,
        data: {
          type: 'canopy_user_prompt',
          original_text: 'Continue after reset',
          canopy_turn_user_message_id: 'external-user-message',
          provider: 'claude',
        },
      });

      // A rejected external dispatch emits no acceptance event. The renderer
      // must keep both the visible banner and its durable tab-state copy.
      await expect(banner).toBeVisible();
      await expect
        .poll(() => {
          const { live: persisted } = readChatStorageIndexes(
            path.join(userDataDir, 'workspaces', workspaceId),
            WORKTREE_ID,
          );
          return persisted.tabs.find((tab) => tab.id === chatId)
            ?.llmProviderUsageLimitBanner?.provider;
        })
        .toBe('claude');

      await injectChatEvent(electronApp, {
        projectId: workspaceId,
        worktreeId: WORKTREE_ID,
        chatId,
        data: {
          type: 'canopy_user_prompt_accepted',
          canopy_turn_user_message_id: 'external-user-message',
        },
      });

      await expect(banner).toBeHidden({ timeout: 10_000 });
      await expect
        .poll(() => {
          const { live: persisted } = readChatStorageIndexes(
            path.join(userDataDir, 'workspaces', workspaceId),
            WORKTREE_ID,
          );
          return persisted.tabs.find((tab) => tab.id === chatId)
            ?.llmProviderUsageLimitBanner;
        })
        .toBeUndefined();
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('a live Codex usage limit shows only the banner, with the reset time (CAN-4564)', async () => {
    test.setTimeout(120_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-chat-usage-limit-codex-live-'),
    );
    const workspaceId = 'demo-ts-pnpm-vite';
    const chatId = 'codex-live-usage-limit-tab';
    const scope = { projectId: workspaceId, worktreeId: WORKTREE_ID };

    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    seedPreferences(userDataDir);
    seedWorktreeChat({
      userDataDir,
      workspaceId,
      worktreeId: WORKTREE_ID,
      providerType: 'codex',
      tabs: [
        { id: chatId, title: 'Codex Live Usage Limit', model: 'gpt-6-sol' },
      ],
    });
    const fixture = createFixture('usage-limit-banner');
    const { electronApp } = await launchCanopy({
      userDataDir,
      env: fixture.env,
    });

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);

      await app.waitForShell({ timeout: 30_000 });
      const saveResult = await window.evaluate(
        async (apiKey) => window.api.saveCanopyCloudApiKey({ apiKey }),
        TEST_CLOUD_API_KEY,
      );
      expect(saveResult.status.authenticated).toBe(true);
      await window.evaluate((eventName) => {
        window.dispatchEvent(new Event(eventName));
      }, CLOUD_ACCOUNT_CHANGED_EVENT);

      await app.openMainPage();
      await app.selectWorktree(WORKTREE_BRANCH);
      const chatPanel = window.getByTestId('panel-content-chat');
      await expect(chatPanel).toBeVisible();

      await window.evaluate((request) => window.api.chat.sendMessage(request), {
        ...scope,
        chatId,
        userMessageId: 'codex-usage-limit-prompt',
        text: 'Refactor the session store.',
        providerType: 'codex',
        model: 'gpt-6-sol',
        approvalMode: 'full_access',
      });

      const banner = window.getByTestId('chat-input-usage-limit-banner');
      await expect(banner).toBeVisible({ timeout: 45_000 });
      await expect(banner).toContainText('Codex usage limit reached');
      // The reset time comes from Codex's last reached rate-limit update, so
      // the button names a clock time instead of "Resume at reset". The time
      // format is locale-dependent; match digits and a colon only.
      const scheduleResume = window.getByTestId(
        'chat-input-usage-limit-schedule-resume',
      );
      await expect(scheduleResume).toHaveText(/^Resume at .*\d{1,2}:\d{2}/);
      await expect(
        window.getByTestId('chat-input-usage-limit-ai-credits-once'),
      ).toHaveText('Use credits now');
      await expect(
        window.getByTestId('chat-input-usage-limit-ai-credits-always-on-quota'),
      ).toHaveText('Always use credits');

      // Like Claude, the limit adds no transcript row and never shows
      // OpenAI's upsell or purchase links.
      await expect(chatPanel).toContainText('Refactor the session store.');
      await expect(chatPanel).not.toContainText('chatgpt.com');
      await expect(chatPanel).not.toContainText('Upgrade to Pro');
      await expect(chatPanel).not.toContainText('Error:');
      // The failed turn still settles even though the synthetic result adds
      // nothing to the transcript.
      await expect(chatPanel).toContainText('Completed in', {
        timeout: 15_000,
      });
      await expect(chatPanel).not.toContainText('Working');

      const readPersistedTab = () =>
        readChatStorageIndexes(
          path.join(userDataDir, 'workspaces', workspaceId),
          WORKTREE_ID,
        ).live.tabs.find((tab) => tab.id === chatId);
      await expect
        .poll(() => readPersistedTab()?.llmProviderUsageLimitBanner?.provider)
        .toBe('codex');
      // Codex reports the window in epoch seconds; the persisted banner keeps
      // milliseconds so the renderer never draws a 1970 time.
      expect(
        readPersistedTab()?.llmProviderUsageLimitBanner?.resetsAt,
      ).toBeGreaterThan(1e12);
      const tabs = await window.evaluate(
        (request) => window.api.chat.loadTabs(request),
        scope,
      );
      expect(JSON.stringify(tabs)).not.toContain('chatgpt.com');
    } finally {
      await closeFixture(electronApp, userDataDir, fixture.runtimeDir);
    }
  });

  test('shows the accent action last with three actions on their own row', async () => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-chat-usage-limit-combined-actions-'),
    );

    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    seedWorktreeChat({
      userDataDir,
      workspaceId: 'demo-ts-pnpm-vite',
      worktreeId: WORKTREE_ID,
      providerType: 'claude',
      tabs: [
        {
          id: 'claude-usage-limit-combined-actions-tab',
          title: 'Claude Usage Limit Combined Actions',
          claudeUsageLimitBanner: buildUsageLimitBanner('claude'),
        },
      ],
    });

    const { electronApp } = await launchCanopy({ userDataDir });

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);

      await app.waitForShell({ timeout: 30_000 });

      const saveResult = await window.evaluate(
        async (apiKey) => window.api.saveCanopyCloudApiKey({ apiKey }),
        TEST_CLOUD_API_KEY,
      );
      expect(saveResult.status.authenticated).toBe(true);
      await window.evaluate((eventName) => {
        window.dispatchEvent(new Event(eventName));
      }, CLOUD_ACCOUNT_CHANGED_EVENT);

      await app.openMainPage();
      await app.selectWorktree(WORKTREE_BRANCH);
      await expect(window.getByTestId('panel-content-chat')).toBeVisible();

      const actionRow = window.getByTestId(
        'chat-input-usage-limit-ai-credits-offer',
      );
      await expect(actionRow).toBeVisible({ timeout: 30_000 });

      const actionButtons = actionRow.getByRole('button');
      await expect(actionButtons).toHaveCount(3);
      await expect(actionButtons.nth(0)).toHaveText('Use credits now');
      await expect(actionButtons.nth(1)).toHaveText('Resume at reset');
      await expect(actionButtons.nth(1)).toHaveAttribute(
        'data-testid',
        'chat-input-usage-limit-schedule-resume',
      );
      await expect(actionButtons.nth(2)).toHaveText('Always use credits');

      // Text-only labels, no glyphs competing with the words.
      for (let index = 0; index < 3; index += 1) {
        await expect(actionButtons.nth(index).locator('svg')).toHaveCount(0);
      }
      // Three actions sit on their own row under the message.
      await expect(
        window
          .getByTestId('chat-input-usage-limit-banner')
          .locator('[data-notice-actions="below"]'),
      ).toBeVisible();
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
  test('Use credits now swaps the limit notice for the credits card before any send (CAN-4757)', async () => {
    test.setTimeout(120_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-chat-usage-limit-use-credits-now-'),
    );
    const workspaceId = 'demo-ts-pnpm-vite';
    const chatId = 'claude-use-credits-now-tab';
    const otherChatId = 'claude-other-usage-limit-tab';

    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    seedWorktreeChat({
      userDataDir,
      workspaceId,
      worktreeId: WORKTREE_ID,
      providerType: 'claude',
      tabs: [
        {
          id: chatId,
          title: 'Use Credits Now',
          claudeUsageLimitBanner: buildUsageLimitBanner('claude'),
        },
        {
          id: otherChatId,
          title: 'Other Usage Limit',
          claudeUsageLimitBanner: {
            ...buildUsageLimitBanner('claude'),
            requestId: 'mock-claude-usage-limit-other',
            dismissKey: 'usage-limit:claude:mock-other',
          },
        },
      ],
    });

    const { electronApp, window } = await launchUsageLimitedWorktree({
      userDataDir,
    });

    try {
      const workspaceRoot = path.join(userDataDir, 'workspaces', workspaceId);
      const countUserMessages = () =>
        (
          readChatStorageMessages(workspaceRoot, WORKTREE_ID, chatId) ?? []
        ).filter((message) => message.role === 'user').length;
      const readPersistedTab = () =>
        readChatStorageIndexes(workspaceRoot, WORKTREE_ID).live.tabs.find(
          (tab) => tab.id === chatId,
        );

      const panel = chatPanel(window, chatId);
      const otherPanel = chatPanel(window, otherChatId);
      await window.getByTestId(`panel-tab-panel-chat-${chatId}`).click();
      await expect(panel).toBeVisible();
      const userMessagesBefore = countUserMessages();

      await useCreditsNowAndExpectOnlyTheCard(panel);

      // Nothing was sent: the composer is empty and the transcript unchanged,
      // while the session-scoped choice is persisted for this chat.
      // Slate draws its placeholder only while the editor is empty.
      await expect(
        panel
          .getByRole('textbox')
          .first()
          .locator('[data-slate-placeholder="true"]'),
      ).toHaveCount(1);
      expect(countUserMessages()).toBe(userMessagesBefore);
      await expect
        .poll(() => readPersistedTab()?.aiCreditsRouting)
        .toMatchObject({ active: true, scope: 'session' });

      // The other chat keeps its own limit offer; the decision follows the
      // selected chat.
      await window.getByTestId(`panel-tab-panel-chat-${otherChatId}`).click();
      await expect(otherPanel).toBeVisible();
      await expect(
        otherPanel.getByTestId('chat-input-usage-limit-ai-credits-once'),
      ).toBeVisible({ timeout: 30_000 });
      await expect(
        otherPanel.getByTestId('chat-input-ai-credits-active'),
      ).toBeHidden();

      await window.getByTestId(`panel-tab-panel-chat-${chatId}`).click();
      await expect(
        panel.getByTestId('chat-input-ai-credits-active'),
      ).toBeVisible();
      await expect(
        panel.getByTestId('chat-input-usage-limit-banner'),
      ).toBeHidden();

      // Switching back before any routing event restores the retained offer.
      await panel
        .getByTestId('chat-input-ai-credits-switch-to-subscription')
        .click();
      await expect(
        panel.getByTestId('chat-input-ai-credits-active'),
      ).toBeHidden();
      await expect(
        panel.getByTestId('chat-input-usage-limit-ai-credits-once'),
      ).toBeVisible({ timeout: 30_000 });
      expect(countUserMessages()).toBe(userMessagesBefore);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });

  test('Use credits now also hides a live-event-only limit (CAN-4757)', async () => {
    test.setTimeout(120_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-chat-usage-limit-live-use-credits-'),
    );
    const workspaceId = 'demo-ts-pnpm-vite';
    const chatId = 'claude-live-use-credits-now-tab';

    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    // No persisted tab banner: the limit arrives only as a live event.
    seedWorktreeChat({
      userDataDir,
      workspaceId,
      worktreeId: WORKTREE_ID,
      providerType: 'claude',
      tabs: [{ id: chatId, title: 'Live Use Credits Now' }],
    });

    const { electronApp, window } = await launchUsageLimitedWorktree({
      userDataDir,
    });

    try {
      const panel = chatPanel(window, chatId);
      await expect(panel).toBeVisible();
      await expect(
        panel.getByTestId('chat-input-usage-limit-banner'),
      ).toBeHidden();
      await injectChatEvent(electronApp, {
        projectId: workspaceId,
        worktreeId: WORKTREE_ID,
        chatId,
        data: { type: 'canopy_usage_limit_reached', provider: 'claude' },
      });

      await useCreditsNowAndExpectOnlyTheCard(panel);
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
});
