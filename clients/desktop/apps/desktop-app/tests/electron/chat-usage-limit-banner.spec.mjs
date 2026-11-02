import {
  readChatStorageIndexes,
  readChatStorageMessages,
} from './readChatStorage.mjs';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import {
  injectChatEvent,
  seedUsageLimitedChats,
  seedWorktreeChat,
  registerScenario,
  clearScenario,
  getScenarioActivity,
  DEFAULT_MOCK_BASE_URL,
} from './seeders/index.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { withBundledBinaryOverridesScrubbed } from './seeders/bundledBinaryOverrides.mjs';
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

// Holds every AI Credits balance read for a scenario key until released, so
// a spec can observe the banner while its coverage re-read is in flight.
const REVALIDATION_BALANCE_BARRIER = 'can-5160-revalidation-balance';

async function heldBalanceReads(key) {
  const response = await fetch(
    `${DEFAULT_MOCK_BASE_URL}/__mock/barrier?key=${encodeURIComponent(key)}`,
  );
  expect(response.ok).toBe(true);
  const { barriers } = await response.json();
  return (
    barriers.find(({ name }) => name === REVALIDATION_BALANCE_BARRIER)
      ?.waiting ?? 0
  );
}

async function releaseRevalidationBarrier(key) {
  const response = await fetch(`${DEFAULT_MOCK_BASE_URL}/__mock/barrier`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, name: REVALIDATION_BALANCE_BARRIER }),
  });
  expect(response.ok).toBe(true);
}

/**
 * Registers a native Claude login whose subscription reports the same limit
 * the chat shows; pass the key as `CANOPY_MOCK_API_KEY`. The credits card
 * needs the login, and switching back to the subscription asks first.
 */
async function registerLimitedClaudeLogin(usageKey) {
  await registerScenario(DEFAULT_MOCK_BASE_URL, usageKey, {
    authUsage: {
      claude: {
        auth: {
          loggedIn: true,
          email: 'tester@example.com',
          authMethod: 'oauth',
          subscriptionType: 'max',
        },
        usage: {
          five_hour: {
            utilization: 100,
            resets_at: new Date(Date.now() + 2 * 3_600_000).toISOString(),
          },
        },
      },
    },
  });
}

/**
 * Launches a seeded worktree chat, connects the mock cloud account and opens
 * `demo-main`, for the CAN-4757 flows below. Claude usage reads report the
 * same limit the chat shows: a fresh read with allowance would end the
 * session-scoped credits choice (CAN-4272). Call `clearUsage` when done.
 */
async function launchUsageLimitedWorktree({
  userDataDir,
  realProvider = false,
  beforeOpen,
}) {
  const usageKey = `usage-limited-${test.info().workerIndex}-${test.info().testId}`;
  await registerLimitedClaudeLogin(usageKey);
  const clearUsage = () => clearScenario(DEFAULT_MOCK_BASE_URL, usageKey);
  const launch = () =>
    launchCanopy({
      userDataDir,
      env: { CANOPY_MOCK_API_KEY: usageKey },
    });
  // A resend observed at the mock LLM needs the staged provider binaries.
  const { electronApp } = realProvider
    ? await withBundledBinaryOverridesScrubbed(launch)
    : await launch();
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

  await beforeOpen?.(window);
  await app.openMainPage();
  await app.selectWorktree(WORKTREE_BRANCH);
  return { electronApp, window, clearUsage };
}

const interruptedPrompt = (marker) =>
  `[${marker}] [Canopy-Mock-Request:original] Summarize this project.`;

/**
 * A Claude chat whose last prompt a usage limit interrupted before the agent
 * answered (CAN-4756). The prompt carries a mock-LLM marker, so its resend is
 * observable at the provider boundary.
 */
function interruptedChatTab({ id, title, marker, message = {} }) {
  return {
    id,
    title,
    model: 'claude-haiku-4-5-20251001',
    claudeUsageLimitBanner: buildUsageLimitBanner('claude'),
    messages: [
      {
        id: `${id}-user-1`,
        role: 'user',
        blocks: [{ type: 'text', text: interruptedPrompt(marker) }],
        timestamp: Date.parse('2026-04-10T11:59:00.000Z'),
        ...message,
      },
    ],
  };
}

/**
 * Scripts the resent prompt's reply and reads its agent-turn requests. The
 * Claude CLI also sends tool-less and structured-output helper requests that
 * carry the same prompt, so only requests offering the agent's tools count.
 */
async function registerResumeScenario(marker) {
  await registerScenario(DEFAULT_MOCK_BASE_URL, marker, {
    llm: {
      steps: [{ text: 'Unexpected untagged request', stopReason: 'end_turn' }],
      stepsByRequestTag: {
        original: { text: 'Continued on AI Credits.', stopReason: 'end_turn' },
      },
    },
  });
  return {
    requests: async () => {
      const response = await fetch(
        `${DEFAULT_MOCK_BASE_URL}/__mock/requests?key=${encodeURIComponent(marker)}`,
      );
      return (await response.json()).requests.filter(
        (request) =>
          request.tag === 'original' && request.toolNames.includes('Bash'),
      );
    },
    clear: () => clearScenario(DEFAULT_MOCK_BASE_URL, marker),
  };
}

/** Enabled usage-limit resumes scheduled for one worktree. */
async function scheduledResumes(window, workspaceId, worktreeId) {
  const snapshot = await window.evaluate(() => window.api.automations.list());
  return snapshot.activities.filter(
    (activity) =>
      activity.enabled &&
      activity.action.type === 'worktree_session_prompt' &&
      activity.action.purpose === 'usage_limit_resume' &&
      activity.action.workspaceId === workspaceId &&
      activity.action.worktreeId === worktreeId,
  );
}

/** Local receiver standing in for the host browser (see legal-consent-links). */
async function startExternalOpenCapture() {
  const opened = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      try {
        opened.push(JSON.parse(body).url);
      } catch {
        // Ignore malformed payloads; the assertion reports the gap.
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/__capture/external-open`,
    opened,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** One chat's panel. Every open chat tab keeps its panel mounted. */
function chatPanel(window, chatId) {
  return window.locator(`[data-panel-id="panel-chat-${chatId}"]`);
}

/**
 * Clicks "Just this chat" and asserts the usage-limit notice (with its once,
 * always and schedule controls) yields to the credits card. The click also
 * continues the interrupted turn (CAN-4756); callers assert the send.
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

  test('Resume at schedules a capped chat and hides its Home row while retaining the registry (CAN-4970)', async () => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-schedule-then-home-'),
    );
    const workspaceId = 'demo-ts-pnpm-vite';
    const chatId = 'schedule-then-home';
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    seedPreferences(userDataDir);
    seedWorktreeChat({
      userDataDir,
      workspaceId,
      worktreeId: WORKTREE_ID,
      providerType: 'codex',
      tabs: [
        {
          id: chatId,
          title: 'Scheduled capped chat',
          model: 'gpt-6-sol',
          claudeUsageLimitBanner: {
            ...buildUsageLimitBanner('codex'),
            resetsAt: Date.now() + 3_600_000,
          },
        },
      ],
    });
    seedUsageLimitedChats({
      userDataDir,
      entries: [
        {
          projectId: workspaceId,
          worktreeId: WORKTREE_ID,
          chatId,
          provider: 'codex',
          detectedAt: Date.now(),
          workspaceName: 'TypeScript pnpm Vite',
          chatTitle: 'Scheduled capped chat',
          resumeReason: 'usage_limit',
        },
      ],
    });
    // A real usage refresh reads the fixture's future quota window. The
    // existing live-error test separately covers provider failure settlement.
    // Its own bearer keeps the capped window out of concurrent specs.
    const usageKey = `schedule-then-home-${test.info().workerIndex}`;
    await registerScenario(DEFAULT_MOCK_BASE_URL, usageKey, {
      authUsage: {
        codex: {
          account: {
            type: 'chatgpt',
            email: 'schedule@example.test',
            planType: 'plus',
          },
          rateLimits: [
            {
              limitId: 'primary',
              primary: {
                usedPercent: 100,
                windowDurationMins: 300,
                resetsAt: new Date(Date.now() + 3_600_000).toISOString(),
              },
            },
          ],
        },
      },
    });
    const fixture = createFixture('usage-limit-banner');
    const { electronApp } = await launchCanopy({
      userDataDir,
      env: { ...fixture.env, CANOPY_MOCK_API_KEY: usageKey },
    });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      const registry = () =>
        JSON.parse(
          readFileSync(
            path.join(userDataDir, 'usage-limited-chats.json'),
            'utf8',
          ),
        ).entries;
      expect(registry().some((entry) => entry.chatId === chatId)).toBe(true);
      await window.getByTestId('sidebar-create-task').click();
      const home = window.getByTestId('page-home');
      // A single interrupted entry is named by its chat (CAN-4895).
      await expect(
        home.getByTestId('home-interrupted-sessions-details'),
      ).toHaveText(/^Scheduled capped chat waiting for Codex reset/);
      await app.openMainPage();
      await app.selectWorktree(WORKTREE_BRANCH);
      await window
        .getByTestId('chat-input-usage-limit-schedule-resume')
        .click();
      await expect(
        window.getByTestId('chat-input-usage-limit-scheduled'),
      ).toBeVisible();
      const scheduled = await window.evaluate(() =>
        window.api.automations.list(),
      );
      expect(scheduled.activities).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            enabled: true,
            action: expect.objectContaining({
              purpose: 'usage_limit_resume',
              workspaceId,
              worktreeId: WORKTREE_ID,
              chatId,
            }),
          }),
        ]),
      );
      await window.getByTestId('sidebar-create-task').click();
      await expect(home).toBeVisible();
      await expect(
        home.getByTestId('home-interrupted-sessions-banner'),
      ).toBeHidden();
      expect(registry().some((entry) => entry.chatId === chatId)).toBe(true);
    } finally {
      await closeFixture(electronApp, userDataDir, fixture.runtimeDir);
      await clearScenario(DEFAULT_MOCK_BASE_URL, usageKey);
    }
  });

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
        // A model with an AI Credits route, so the limit still offers credits
        // (CAN-4900 gates the offer on routability).
        { id: chatId, title: 'Codex Live Usage Limit', model: 'gpt-6-luna' },
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
        model: 'gpt-6-luna',
        approvalMode: 'full_access',
      });

      const banner = window.getByTestId('chat-input-usage-limit-banner');
      await expect(banner).toBeVisible({ timeout: 45_000 });
      await expect(banner).toContainText('Codex usage limit reached');
      // The reset time comes from Codex's last reached rate-limit update, so
      // the button names a clock time instead of "No, resume at reset". The
      // time format is locale-dependent; match digits and a colon only.
      const scheduleResume = window.getByTestId(
        'chat-input-usage-limit-schedule-resume',
      );
      await expect(scheduleResume).toHaveText(/^No, resume at .*\d{1,2}:\d{2}/);
      await expect(banner).toContainText(
        'Do you want to use AI Credits to keep going?',
      );
      await expect(
        window.getByTestId('chat-input-usage-limit-ai-credits-once'),
      ).toHaveText('Just this chat');
      await expect(
        window.getByTestId('chat-input-usage-limit-ai-credits-always-on-quota'),
      ).toHaveText('Always');

      // Like Claude, the limit adds no transcript row and never shows
      // OpenAI's upsell or purchase links.
      await expect(chatPanel).toContainText('Refactor the session store.');
      await expect(chatPanel).not.toContainText('chatgpt.com');
      await expect(chatPanel).not.toContainText('Upgrade to Pro');
      await expect(chatPanel).not.toContainText('Error:');
      // The failed turn still settles even though the synthetic result adds
      // nothing to the transcript.
      await expect(chatPanel.getByTestId('turn-timer')).toHaveAttribute(
        'data-state',
        'completed',
        {
          timeout: 15_000,
        },
      );
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

  test('asks whether to use credits and answers with the accent action last on its own row', async () => {
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
      // Alternatives first, the per-chat action is the accent, far right
      // (CAN-5159).
      await expect(
        window.getByTestId('chat-input-usage-limit-banner'),
      ).toContainText('Do you want to use AI Credits');
      await expect(actionButtons.nth(0)).toHaveText('No, resume at reset');
      await expect(actionButtons.nth(0)).toHaveAttribute(
        'data-testid',
        'chat-input-usage-limit-schedule-resume',
      );
      await expect(actionButtons.nth(1)).toHaveText('Always');
      await expect(actionButtons.nth(2)).toHaveText('Just this chat');
      // No tooltip repeats the scope on screen.
      for (let index = 1; index < 3; index += 1) {
        await expect(actionButtons.nth(index)).not.toHaveAttribute(
          'title',
          /.+/,
        );
      }

      // Text-only labels, no glyphs competing with the words.
      for (let index = 0; index < 3; index += 1) {
        await expect(actionButtons.nth(index).locator('svg')).toHaveCount(0);
      }
      // The answers sit on their own row under the question.
      await expect(
        window
          .getByTestId('chat-input-usage-limit-banner')
          .locator('[data-notice-actions="below"]'),
      ).toBeVisible();
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
  test('Check again reports each result and Reopen billing reopens the page (CAN-5162)', async () => {
    test.setTimeout(120_000);
    const apiKey = 'csk_chat_usage_limit_check_again_e2e';
    const usageKey = `usage-limited-check-again-${test.info().workerIndex}`;
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-chat-usage-limit-check-again-'),
    );
    const noCredits = {
      cloud: { aiCreditsBalance: { credits: 0, eligible: false } },
    };
    const externalOpen = await startExternalOpenCapture();
    let electronApp;
    try {
      await registerScenario(DEFAULT_MOCK_BASE_URL, apiKey, noCredits);
      await registerLimitedClaudeLogin(usageKey);

      seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
      seedWorktreeChat({
        userDataDir,
        workspaceId: 'demo-ts-pnpm-vite',
        worktreeId: WORKTREE_ID,
        providerType: 'claude',
        tabs: [
          {
            id: 'claude-usage-limit-check-again-tab',
            title: 'Claude Usage Limit Check Again',
            claudeUsageLimitBanner: buildUsageLimitBanner('claude'),
          },
        ],
      });

      ({ electronApp } = await launchCanopy({
        userDataDir,
        env: {
          CANOPY_MOCK_API_KEY: usageKey,
          CANOPY_E2E_EXTERNAL_OPEN_CAPTURE_URL: externalOpen.url,
          // Pinned off so this proves the browser route independently of
          // CAN-5159, which sends the banner to the browser with the flag on
          // too (covered by the routing flow below).
          CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
            'canopy-desktop-hosted-settings': false,
          }),
        },
      }));

      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      const saveResult = await window.evaluate(
        async (key) => window.api.saveCanopyCloudApiKey({ apiKey: key }),
        apiKey,
      );
      expect(saveResult.status.authenticated).toBe(true);
      await window.evaluate((eventName) => {
        window.dispatchEvent(new Event(eventName));
      }, CLOUD_ACCOUNT_CHANGED_EVENT);
      await app.openMainPage();
      await app.selectWorktree(WORKTREE_BRANCH);

      const banner = window.getByTestId('chat-input-usage-limit-banner');
      const getCredits = banner.getByTestId(
        'chat-input-usage-limit-view-plans',
      );
      const checkAgain = banner.getByTestId(
        'chat-input-usage-limit-view-plans-check-again',
      );
      // The checkout step's title and message (CAN-5160).
      const feedback = banner;
      const reopen = banner.getByTestId(
        'chat-input-usage-limit-reopen-billing',
      );
      const waitingCopy =
        'Finish checkout in your browser. Your credits show up here once the payment goes through.';

      // 1. Open billing: the neutral checkout step replaces the limit, and
      // Reopen billing sits beside Check again as a button.
      await expect(getCredits).toBeVisible({ timeout: 30_000 });
      await getCredits.click();
      await expect(checkAgain).toBeVisible({ timeout: 15_000 });
      await expect.poll(() => externalOpen.opened.length).toBe(1);
      await expect(feedback).toContainText(waitingCopy);
      await expect(banner).toHaveAttribute('data-notice-intent', 'neutral');
      await expect(banner).not.toContainText('usage limit reached');
      await expect(reopen).toBeVisible();

      // 2. Still no credits: pending, then the uncovered line with Reopen.
      const restingCheckBounds = await checkAgain.boundingBox();
      expect(restingCheckBounds).not.toBeNull();
      await checkAgain.click();
      await expect(checkAgain).toHaveAttribute('aria-busy', 'true');
      await expect(checkAgain).toBeDisabled();
      expect((await checkAgain.boundingBox())?.width).toBe(
        restingCheckBounds?.width,
      );
      await expect(feedback).toContainText(
        "No credits yet. If you've paid, they can take a minute to arrive.",
      );
      await expect(checkAgain).toHaveAttribute('aria-busy', 'false');
      await expect(reopen).toBeVisible();

      // 3. Reopen billing opens exactly one more page and stays handed off.
      await reopen.click();
      await expect.poll(() => externalOpen.opened.length).toBe(2);
      await expect(feedback).toContainText(waitingCopy);
      await expect(checkAgain).toBeEnabled();

      // 4. A failed balance read is its own message, with no Reopen.
      await registerScenario(DEFAULT_MOCK_BASE_URL, apiKey, {
        cloud: { ...noCredits.cloud, aiCreditsBalanceHttpStatus: 503 },
      });
      await checkAgain.click();
      await expect(feedback).toContainText(
        "Couldn't check your balance. Try again in a moment.",
      );
      await expect(reopen).toHaveCount(0);

      // 5. Credits landed: the chat is routed through them and the credits
      // card replaces the notice and its feedback (CAN-5159).
      await registerScenario(DEFAULT_MOCK_BASE_URL, apiKey, {
        cloud: { aiCreditsBalance: { credits: 1234, eligible: true } },
      });
      await checkAgain.click();
      await expect(
        window.getByTestId('chat-input-ai-credits-active'),
      ).toBeVisible({ timeout: 15_000 });
      await expect(banner).toHaveCount(0);
      // The baseline was read before the first open (CAN-5160).
      await expect(
        window.getByTestId('chat-input-ai-credits-arrival'),
      ).toContainText('1,234 AI Credits added.', { timeout: 15_000 });
      expect(externalOpen.opened).toHaveLength(2);
    } finally {
      try {
        if (electronApp) await closeCanopy(electronApp, userDataDir);
      } finally {
        await externalOpen.close();
        await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey);
        await clearScenario(DEFAULT_MOCK_BASE_URL, usageKey);
      }
    }
  });

  for (const automatic of [false, true]) {
    test(`routes the chat through credits once they are bought from the banner (${automatic ? 'automatic return' : 'Check again'}, CAN-5159)`, async () => {
      test.setTimeout(120_000);
      const apiKey = 'csk_chat_usage_limit_arrival_e2e';
      const usageKey = `usage-limited-arrival-${test.info().workerIndex}-${automatic}`;
      const workspaceId = 'demo-ts-pnpm-vite';
      const chatId = 'claude-usage-limit-arrival-tab';
      const otherChatId = 'claude-usage-limit-arrival-other-tab';
      const userDataDir = mkdtempSync(
        path.join(os.tmpdir(), 'canopy-chat-usage-limit-arrival-'),
      );
      const externalOpen = await startExternalOpenCapture();
      let electronApp;
      try {
        await registerScenario(DEFAULT_MOCK_BASE_URL, apiKey, {
          cloud: { aiCreditsBalance: { credits: 0, eligible: false } },
        });
        await registerLimitedClaudeLogin(usageKey);

        seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
        seedWorktreeChat({
          userDataDir,
          workspaceId,
          worktreeId: WORKTREE_ID,
          providerType: 'claude',
          tabs: [
            {
              id: chatId,
              title: 'Claude Usage Limit Arrival',
              claudeUsageLimitBanner: buildUsageLimitBanner('claude'),
            },
            {
              id: otherChatId,
              title: 'Claude Usage Limit Arrival Other',
              claudeUsageLimitBanner: {
                ...buildUsageLimitBanner('claude'),
                requestId: 'mock-claude-usage-limit-other',
                dismissKey: 'usage-limit:claude:mock-other',
              },
            },
          ],
        });

        ({ electronApp } = await launchCanopy({
          userDataDir,
          env: {
            CANOPY_MOCK_API_KEY: usageKey,
            CANOPY_E2E_EXTERNAL_OPEN_CAPTURE_URL: externalOpen.url,
            // The rollout default, set explicitly: Get AI Credits must still go
            // to the browser so the hand-off survives (CAN-5159).
            CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
              'canopy-desktop-hosted-settings': true,
            }),
          },
        }));

        const window = await electronApp.firstWindow();
        const app = new CanopyAppDriver(window);
        await app.waitForShell({ timeout: 30_000 });
        const saveResult = await window.evaluate(
          async (key) => window.api.saveCanopyCloudApiKey({ apiKey: key }),
          apiKey,
        );
        expect(saveResult.status.authenticated).toBe(true);
        await window.evaluate((eventName) => {
          window.dispatchEvent(new Event(eventName));
        }, CLOUD_ACCOUNT_CHANGED_EVENT);
        await app.openMainPage();
        await app.selectWorktree(WORKTREE_BRANCH);

        const workspaceRoot = path.join(userDataDir, 'workspaces', workspaceId);
        const readPersistedTab = () =>
          readChatStorageIndexes(workspaceRoot, WORKTREE_ID).live.tabs.find(
            (tab) => tab.id === chatId,
          );
        const countUserMessages = () =>
          (
            readChatStorageMessages(workspaceRoot, WORKTREE_ID, chatId) ?? []
          ).filter((message) => message.role === 'user').length;

        const panel = chatPanel(window, chatId);
        await window.getByTestId(`panel-tab-panel-chat-${chatId}`).click();
        await expect(panel).toBeVisible();
        const userMessagesBefore = countUserMessages();
        const banner = panel.getByTestId('chat-input-usage-limit-banner');
        const card = panel.getByTestId('chat-input-ai-credits-active');
        const continueButton = panel.getByTestId(
          'chat-input-ai-credits-continue',
        );
        const switchButton = panel.getByTestId(
          'chat-input-ai-credits-switch-to-subscription',
        );
        const checkAgain = banner.getByTestId(
          'chat-input-usage-limit-view-plans-check-again',
        );

        // 1. At 0 credits, Get AI Credits opens billing once. The click starts
        // the baseline balance read before the coverage read that gates the
        // open, and that read does the same requests and more, so the
        // baseline settles first; otherwise the arrival line falls back.
        await banner
          .getByTestId('chat-input-usage-limit-view-plans')
          .click({ timeout: 30_000 });
        await expect(checkAgain).toBeVisible({ timeout: 15_000 });
        await expect.poll(() => externalOpen.opened.length).toBe(1);
        // The chat waits for the purchase; Settings never opened.
        await expect(window.getByTestId('settings-overlay')).toBeHidden();
        // The captured open is the auth-link consume URL, so read the
        // minted redirect path: the signed-in billing page with the
        // credits top-up intent.
        const { activity } = await getScenarioActivity(
          DEFAULT_MOCK_BASE_URL,
          apiKey,
        );
        const minted = Object.keys(activity)
          .filter((field) => field.startsWith('authLinkMint:'))
          .map(
            (field) =>
              new URL(
                field.slice('authLinkMint:'.length),
                'https://billing.invalid',
              ),
          );
        expect(minted).toHaveLength(1);
        expect(minted[0].pathname).toBe('/account/billing');
        expect(minted[0].searchParams.get('topUp')).toBe('1');
        expect(minted[0].searchParams.get('reason')).toBe('credits');
        expect(minted[0].searchParams.get('source')).toBe('banner');

        // 2. 16 credits land, but the balance read is held: until coverage
        // settles the chat keeps its checkout step and is not routed.
        await registerScenario(DEFAULT_MOCK_BASE_URL, apiKey, {
          cloud: {
            aiCreditsBalance: { credits: 16, eligible: true },
            aiCreditsBalanceWaitFor: REVALIDATION_BALANCE_BARRIER,
          },
        });
        if (automatic) {
          await window.evaluate(() => {
            window.dispatchEvent(new Event('focus'));
            document.dispatchEvent(new Event('visibilitychange'));
          });
        } else {
          await checkAgain.click();
        }
        await expect
          .poll(() => heldBalanceReads(apiKey), { timeout: 15_000 })
          .toBeGreaterThan(0);
        await expect(banner).toHaveAttribute('data-notice-intent', 'neutral');
        await expect(banner).toContainText('Finish checkout in your browser');
        await expect(card).toHaveCount(0);
        await releaseRevalidationBarrier(apiKey);

        // 3. Once settled the chat is routed through credits: the card
        // confirms the purchase and no choice is asked.
        await expect(card).toBeVisible({ timeout: 15_000 });
        await expect(banner).toBeHidden();
        await expect(
          panel.getByTestId('chat-input-ai-credits-arrival'),
        ).toContainText('16 AI Credits added.', { timeout: 15_000 });
        // One line: the purchase is the card's state, so neither the generic
        // title nor the balance repeats it.
        await expect(card).toHaveAttribute('data-notice-intent', 'positive');
        await expect(card).toContainText(
          '16 AI Credits added. Ready to use in this chat.',
        );
        await expect(card).not.toContainText('Using AI Credits');
        await expect(
          panel.getByTestId('chat-input-ai-credits-balance'),
        ).toHaveCount(0);
        // An arrival only routes (CAN-4756): nothing was sent, and the card's
        // single accent action is Continue while the switch waits.
        await expect(continueButton).toHaveClass(/(^|\s)bg-accent(\s|$)/);
        await expect(switchButton).toHaveCount(0);
        expect(countUserMessages()).toBe(userMessagesBefore);
        for (const testId of [
          'chat-input-usage-limit-ai-credits-once',
          'chat-input-usage-limit-schedule-resume',
          'chat-input-usage-limit-ai-credits-always-on-quota',
        ]) {
          await expect(panel.getByTestId(testId)).toHaveCount(0);
        }
        await expect
          .poll(() => readPersistedTab()?.aiCreditsRouting)
          .toMatchObject({ active: true, scope: 'session' });
        // Consent covers this chat only, never the global preference.
        const preferences = await window.evaluate(() =>
          window.api.loadPreferences(),
        );
        expect(preferences.aiCreditsRoutingMode).not.toBe('on-quota');

        // 4. Only in its chat.
        await window.getByTestId(`panel-tab-panel-chat-${otherChatId}`).click();
        const otherPanel = chatPanel(window, otherChatId);
        await expect(
          otherPanel.getByTestId('chat-input-usage-limit-banner'),
        ).toContainText('Claude usage limit reached', { timeout: 15_000 });
        await expect(
          otherPanel.getByTestId('chat-input-ai-credits-active'),
        ).toHaveCount(0);
        await window.getByTestId(`panel-tab-panel-chat-${chatId}`).click();
        await expect(
          panel.getByTestId('chat-input-ai-credits-arrival'),
        ).toContainText('16 AI Credits added.');

        // 5. A later return event makes no second open and no second card.
        await window.evaluate(() => {
          window.dispatchEvent(new Event('focus'));
          document.dispatchEvent(new Event('visibilitychange'));
        });
        expect(externalOpen.opened).toHaveLength(1);
        await expect(card).toHaveCount(1);
        expect(countUserMessages()).toBe(userMessagesBefore);

        // 6. Continue sends the interrupted turn once on credits (CAN-4756).
        // Once answered, Continue goes and switching back returns as a
        // secondary alternative. Restoring the offer after a switch back is
        // covered by chat-ai-credits-routing-banner.spec.mjs.
        await continueButton.click();
        await expect
          .poll(countUserMessages, { timeout: 30_000 })
          .toBe(userMessagesBefore + 1);
        await expect(continueButton).toHaveCount(0, { timeout: 15_000 });
        await expect(switchButton).toBeVisible({ timeout: 15_000 });
        await expect(switchButton).not.toHaveClass(/(^|\s)bg-accent(\s|$)/);
        expect(countUserMessages()).toBe(userMessagesBefore + 1);
        expect(externalOpen.opened).toHaveLength(1);
      } finally {
        try {
          if (electronApp) await closeCanopy(electronApp, userDataDir);
        } finally {
          await externalOpen.close();
          await clearScenario(DEFAULT_MOCK_BASE_URL, apiKey);
          await clearScenario(DEFAULT_MOCK_BASE_URL, usageKey);
        }
      }
    });
  }

  test('Just this chat swaps the limit notice for the credits card and continues the chat (CAN-4757, CAN-4756)', async () => {
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

    const { electronApp, window, clearUsage } =
      await launchUsageLimitedWorktree({ userDataDir });

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

      // The interrupted turn was sent once on credits (CAN-4756), with no
      // typing: the composer stays empty, the transcript gains exactly one
      // user message, and the session-scoped choice is persisted.
      // Slate draws its placeholder only while the editor is empty.
      await expect(
        panel
          .getByRole('textbox')
          .first()
          .locator('[data-slate-placeholder="true"]'),
      ).toHaveCount(1);
      await expect
        .poll(countUserMessages, { timeout: 30_000 })
        .toBe(userMessagesBefore + 1);
      await expect
        .poll(() => readPersistedTab()?.aiCreditsRouting)
        .toMatchObject({ active: true, scope: 'session' });
      // The card offers no Continue once the interruption is answered.
      await expect(
        panel.getByTestId('chat-input-ai-credits-continue'),
      ).toHaveCount(0);

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
      // Visiting the other chat never sent this one again.
      expect(countUserMessages()).toBe(userMessagesBefore + 1);
    } finally {
      try {
        await closeCanopy(electronApp, userDataDir);
      } finally {
        await clearUsage();
      }
    }
  });

  // Every yes to credits sends the interrupted prompt again, observed at the
  // mock LLM (CAN-4756). The scripted provider is Claude; the Jest hook tests
  // cover the provider-agnostic send for Codex.
  for (const answer of ['Always', 'Use AI Credits']) {
    test(`${answer} continues the interrupted turn on credits (CAN-4756)`, async () => {
      test.setTimeout(180_000);
      const always = answer === 'Always';
      const marker = always ? 'Canopy-C4756ALWAYS' : 'Canopy-C4756FALLBACK';
      const scenario = await registerResumeScenario(marker);
      const userDataDir = mkdtempSync(
        path.join(os.tmpdir(), 'canopy-chat-usage-limit-continue-'),
      );
      const workspaceId = 'demo-ts-pnpm-vite';
      const chatId = always
        ? 'claude-always-continue-tab'
        : 'claude-fallback-continue-tab';
      seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
      seedWorktreeChat({
        userDataDir,
        workspaceId,
        worktreeId: WORKTREE_ID,
        providerType: 'claude',
        tabs: [interruptedChatTab({ id: chatId, title: answer, marker })],
      });

      let launched;
      try {
        launched = await launchUsageLimitedWorktree({
          userDataDir,
          realProvider: true,
          // A preference already past off replaces the offer with the
          // fallback Use AI Credits row.
          ...(always
            ? {}
            : {
                beforeOpen: (window) =>
                  window.evaluate(() =>
                    window.api.savePreferences({
                      aiCreditsRoutingMode: 'on-quota',
                    }),
                  ),
              }),
        });
        const { window } = launched;
        const workspaceRoot = path.join(userDataDir, 'workspaces', workspaceId);
        const countUserMessages = () =>
          (
            readChatStorageMessages(workspaceRoot, WORKTREE_ID, chatId) ?? []
          ).filter((message) => message.role === 'user').length;
        const panel = chatPanel(window, chatId);
        await expect(panel).toBeVisible();
        const yes = panel.getByTestId(
          always
            ? 'chat-input-usage-limit-ai-credits-always-on-quota'
            : 'chat-input-usage-limit-use-ai-credits',
        );
        await expect(yes).toBeVisible({ timeout: 30_000 });
        expect(await scenario.requests()).toHaveLength(0);

        await yes.click();

        if (always) {
          await expect
            .poll(
              async () =>
                (await window.evaluate(() => window.api.loadPreferences()))
                  .aiCreditsRoutingMode,
            )
            .toBe('on-quota');
        }
        // One accepted request, answered in the transcript, with no typing.
        await expect
          .poll(async () => (await scenario.requests()).length, {
            timeout: 60_000,
          })
          .toBe(1);
        // The mock LLM answers either lane, so the card is the billing
        // check: Always sets no tab routing, and only main's report that the
        // resend's session spawned on AI Credits shows it.
        await expect(
          panel.getByTestId('chat-input-ai-credits-active'),
        ).toBeVisible({ timeout: 60_000 });
        await expect(panel).toContainText('Continued on AI Credits.', {
          timeout: 60_000,
        });
        await expect.poll(countUserMessages, { timeout: 30_000 }).toBe(2);
        await expect(
          panel.getByTestId('chat-input-usage-limit-banner'),
        ).toBeHidden();
        expect(await scenario.requests()).toHaveLength(1);
      } finally {
        try {
          if (launched) await closeCanopy(launched.electronApp, userDataDir);
        } finally {
          await launched?.clearUsage();
          await scenario.clear();
        }
      }
    });
  }

  test('a failed resend keeps the scheduled resume, and Continue retries it with its attachments (CAN-4756)', async () => {
    test.setTimeout(150_000);
    const marker = 'Canopy-C4756RETRY';
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-chat-usage-limit-continue-retry-'),
    );
    const workspaceId = 'demo-ts-pnpm-vite';
    const chatId = 'claude-continue-retry-tab';
    const attachment = path.join(userDataDir, 'attachments', 'notes.md');
    mkdirSync(path.dirname(attachment), { recursive: true });
    writeFileSync(attachment, '# Notes\n');
    const fileReference = { displayPath: 'notes.md', absolutePath: attachment };
    const resetsAt = Date.now() + 3_600_000;

    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    const tab = interruptedChatTab({
      id: chatId,
      title: 'Continue Retry',
      marker,
      message: {
        blocks: [
          { type: 'text', text: interruptedPrompt(marker) },
          { type: 'file_references', references: [fileReference] },
        ],
        attachmentPaths: [attachment],
      },
    });
    seedWorktreeChat({
      userDataDir,
      workspaceId,
      worktreeId: WORKTREE_ID,
      providerType: 'claude',
      tabs: [
        {
          ...tab,
          claudeUsageLimitBanner: { ...tab.claudeUsageLimitBanner, resetsAt },
        },
      ],
    });
    seedUsageLimitedChats({
      userDataDir,
      entries: [
        {
          projectId: workspaceId,
          worktreeId: WORKTREE_ID,
          chatId,
          provider: 'claude',
          detectedAt: Date.now(),
          workspaceName: 'TypeScript pnpm Vite',
          chatTitle: 'Continue Retry',
          resumeReason: 'usage_limit',
          resetsAt,
        },
      ],
    });

    const { electronApp, window, clearUsage } =
      await launchUsageLimitedWorktree({ userDataDir });
    try {
      // The first resend never reaches main; later sends are accepted.
      await electronApp.evaluate(({ ipcMain }) => {
        globalThis.__can4756Sends = [];
        ipcMain.removeHandler('chat:send-message');
        ipcMain.handle('chat:send-message', async (_event, request) => {
          globalThis.__can4756Sends.push(request);
          if (globalThis.__can4756Sends.length === 1) {
            throw new Error('First resend rejected by test');
          }
          return {};
        });
      });
      const sends = () => electronApp.evaluate(() => globalThis.__can4756Sends);
      const scheduled = () =>
        scheduledResumes(window, workspaceId, WORKTREE_ID);

      const panel = chatPanel(window, chatId);
      const card = panel.getByTestId('chat-input-ai-credits-active');
      const continueButton = panel.getByTestId(
        'chat-input-ai-credits-continue',
      );
      const switchButton = panel.getByTestId(
        'chat-input-ai-credits-switch-to-subscription',
      );
      await expect(panel).toBeVisible();

      // 1. Resume at reset first.
      await panel.getByTestId('chat-input-usage-limit-schedule-resume').click();
      await expect(
        panel.getByTestId('chat-input-usage-limit-scheduled'),
      ).toBeVisible({ timeout: 30_000 });
      await expect.poll(async () => (await scheduled()).length).toBe(1);

      // 2. Just this chat routes and resends; the resend fails, so the card
      // offers Continue as the retry and the schedule stays.
      await panel.getByTestId('chat-input-usage-limit-ai-credits-once').click();
      await expect(card).toBeVisible();
      await expect.poll(async () => (await sends()).length).toBe(1);
      await expect(
        panel.getByTestId('chat-input-ai-credits-continue-error'),
      ).toHaveText('Could not continue this chat. Try again.', {
        timeout: 15_000,
      });
      await expect(continueButton).toBeEnabled();
      await expect(continueButton).toHaveClass(/(^|\s)bg-accent(\s|$)/);
      await expect(switchButton).toHaveCount(0);
      expect(await scheduled()).toHaveLength(1);

      // 3. Continue sends once more, with the original attachments and on
      // the session routing the click applied.
      await continueButton.click();
      await expect.poll(async () => (await sends()).length).toBe(2);
      const [first, retry] = await sends();
      for (const request of [first, retry]) {
        expect(request).toMatchObject({
          chatId,
          text: interruptedPrompt(marker),
          fileReferences: [fileReference],
          attachmentPaths: [attachment],
          aiCreditsRouting: { active: true, scope: 'session' },
        });
      }
      await expect(continueButton).toHaveCount(0, { timeout: 15_000 });
      await expect(switchButton).toBeVisible({ timeout: 15_000 });
      await expect.poll(async () => (await scheduled()).length).toBe(0);
      expect(await sends()).toHaveLength(2);
    } finally {
      try {
        await closeCanopy(electronApp, userDataDir);
      } finally {
        await clearUsage();
      }
    }
  });

  test('Just this chat also hides a live-event-only limit (CAN-4757)', async () => {
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

    const { electronApp, window, clearUsage } =
      await launchUsageLimitedWorktree({ userDataDir });

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
      try {
        await closeCanopy(electronApp, userDataDir);
      } finally {
        await clearUsage();
      }
    }
  });

  test('a model without an AI Credits route offers the credits model instead (CAN-4900)', async () => {
    test.setTimeout(120_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-chat-usage-limit-not-routable-'),
    );
    const workspaceId = 'demo-ts-pnpm-vite';
    const chatId = 'codex-not-routable-usage-limit-tab';
    const scope = { projectId: workspaceId, worktreeId: WORKTREE_ID };

    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    seedPreferences(userDataDir);
    seedWorktreeChat({
      userDataDir,
      workspaceId,
      worktreeId: WORKTREE_ID,
      providerType: 'codex',
      tabs: [{ id: chatId, title: 'Codex Not Routable', model: 'gpt-6-sol' }],
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
      const panel = window.getByTestId('panel-content-chat');
      await expect(panel).toBeVisible();

      await window.evaluate((request) => window.api.chat.sendMessage(request), {
        ...scope,
        chatId,
        userMessageId: 'codex-not-routable-prompt',
        text: 'Refactor the session store.',
        providerType: 'codex',
        model: 'gpt-6-sol',
        approvalMode: 'full_access',
      });

      const banner = window.getByTestId('chat-input-usage-limit-banner');
      const card = window.getByTestId('chat-input-ai-credits-active');
      const switchButton = window.getByTestId(
        'chat-input-usage-limit-continue-on-credits-model',
      );
      await expect(banner).toBeVisible({ timeout: 45_000 });
      await expect(banner).toContainText("GPT 6 Sol can't run on AI Credits");
      await expect(switchButton).toHaveText('Continue on GPT 6 Luna', {
        timeout: 30_000,
      });
      for (const testId of [
        'chat-input-usage-limit-ai-credits-once',
        'chat-input-usage-limit-ai-credits-always-on-quota',
        'chat-input-usage-limit-use-ai-credits',
      ]) {
        await expect(window.getByTestId(testId)).toHaveCount(0);
      }
      // No question to answer, so the resume button is not a "No".
      await expect(
        window.getByTestId('chat-input-usage-limit-schedule-resume'),
      ).toHaveText(/^Resume at /);

      await switchButton.click();

      await expect(card).toBeVisible({ timeout: 30_000 });
      await expect(card).toBeFocused();
      await expect(banner).toBeHidden();

      const readPersistedTab = () =>
        readChatStorageIndexes(
          path.join(userDataDir, 'workspaces', workspaceId),
          WORKTREE_ID,
        ).live.tabs.find((tab) => tab.id === chatId);
      await expect.poll(() => readPersistedTab()?.model).toBe('gpt-6-luna');
      await expect
        .poll(() => readPersistedTab()?.aiCreditsRouting)
        .toMatchObject({ active: true, scope: 'session' });
    } finally {
      await closeFixture(electronApp, userDataDir, fixture.runtimeDir);
    }
  });

  test('clears saved session routing on a model without an AI Credits route (CAN-4900)', async () => {
    test.setTimeout(120_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-chat-usage-limit-stale-routing-'),
    );
    const workspaceId = 'demo-ts-pnpm-vite';
    const chatId = 'codex-stale-routing-tab';

    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    seedWorktreeChat({
      userDataDir,
      workspaceId,
      worktreeId: WORKTREE_ID,
      providerType: 'codex',
      tabs: [
        {
          id: chatId,
          title: 'Codex Stale Routing',
          model: 'gpt-6-sol',
          aiCreditsRouting: {
            active: true,
            scope: 'session',
            activatedAt: Date.now(),
            resetsAt: Date.now() + 2 * 3_600_000,
          },
          claudeUsageLimitBanner: {
            ...buildUsageLimitBanner('codex'),
            resetsAt: Date.now() + 2 * 3_600_000,
          },
        },
      ],
    });

    const { electronApp, window, clearUsage } =
      await launchUsageLimitedWorktree({ userDataDir });

    try {
      const panel = chatPanel(window, chatId);
      await expect(panel).toBeVisible();
      const readPersistedTab = () =>
        readChatStorageIndexes(
          path.join(userDataDir, 'workspaces', workspaceId),
          WORKTREE_ID,
        ).live.tabs.find((tab) => tab.id === chatId);

      await expect
        .poll(() => readPersistedTab()?.aiCreditsRouting?.active ?? false, {
          timeout: 30_000,
        })
        .toBe(false);
      const banner = panel.getByTestId('chat-input-usage-limit-banner');
      await expect(banner).toBeVisible({ timeout: 30_000 });
      await expect(banner).toContainText("GPT 6 Sol can't run on AI Credits");
      await expect(
        panel.getByTestId('chat-input-ai-credits-active'),
      ).toBeHidden();
    } finally {
      try {
        await closeCanopy(electronApp, userDataDir);
      } finally {
        await clearUsage();
      }
    }
  });
});
