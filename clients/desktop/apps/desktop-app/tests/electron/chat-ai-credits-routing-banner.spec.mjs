import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { createServer, request } from 'node:http';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  DEFAULT_MOCK_BASE_URL,
  injectChatEvent,
  seedWorktreeChat,
  writeJson,
} from './seeders/index.mjs';
import {
  clearScenario,
  getScenarioActivity,
  registerScenario,
} from './seeders/registerScenario.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const WORKTREE_BRANCH = 'demo-main';
const CHAT_ID = 'ai-credits-routing-banner-chat';
// Any `csk_`-prefixed key authenticates against the shared cloud mock at
// 127.0.0.1:4011, which serves a `Pro` subscription + an eligible balance (see
// mock-server/routes/cloud.mjs).
const TEST_CLOUD_API_KEY = 'csk_ai_credits_routing_banner_e2e';
const CLOUD_ACCOUNT_CHANGED_EVENT = 'canopy:cloud-account-changed';

test('session-scoped AI Credits routing keeps the status banner visible after an inactive routing event', async () => {
  // The status banner tracks the chat's *effective* billing framework via the
  // shared resolver (chatBillingFramework.ts), so `withRoutedChat` connects the
  // mock cloud account first. Usage reads stay limited: a fresh read showing
  // allowance would end session routing (CAN-4272).
  await withRoutedChat(
    {
      aiCreditsRouting: {
        active: true,
        scope: 'session',
        activatedAt: Date.parse('2026-04-10T12:00:00.000Z'),
      },
      authUsageScenario: limitedUsage(),
    },
    async (window, electronApp) => {
      const routingBanner = window.getByTestId('chat-input-ai-credits-active');
      await expect(routingBanner).toBeVisible({ timeout: 30_000 });
      await expect(routingBanner).toContainText('Using AI Credits');

      await injectChatEvent(electronApp, {
        projectId: WORKSPACE_ID,
        worktreeId: WORKTREE_ID,
        chatId: CHAT_ID,
        data: {
          type: 'canopy_ai_credits_routing',
          active: false,
          provider: 'codex',
        },
      });

      await expect(routingBanner).toBeVisible({ timeout: 10_000 });
    },
  );
});

/** The chat tab as main persists it, so assertions see the canonical state. */
async function persistedTab(window) {
  const file = await window.evaluate(
    (request) => window.api.chat.loadTabs(request),
    { projectId: WORKSPACE_ID, worktreeId: WORKTREE_ID },
  );
  return file.tabs.find((tab) => tab.id === CHAT_ID);
}

/** The clear and the switch are accepted by main, not shown as unsaved. */
async function expectNoRejectedCommand(window) {
  await expect(window.getByTestId('chat-state-recovery-banner')).toHaveCount(0);
}

/**
 * Seed a Codex chat with the given routing, open it with the mock cloud
 * account connected, and hand the window to `run`. `authUsageScenario` names a
 * provider-usage scenario from the mock library, registered under a key unique
 * to this test so parallel workers never share it.
 */
async function withRoutedChat(
  {
    aiCreditsRouting,
    preferences,
    authUsageScenario,
    mockKey: requestedMockKey,
    env,
  },
  run,
) {
  const mockKey =
    requestedMockKey ??
    (authUsageScenario
      ? `routing-banner-${test.info().workerIndex}-${test.info().testId}-${randomUUID()}`
      : null);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-ai-credits-routing-banner-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'codex',
    tabs: [
      {
        id: CHAT_ID,
        title: 'AI Credits Routing Banner',
        aiCreditsRouting,
      },
    ],
  });
  if (preferences) {
    const filePath = path.join(userDataDir, 'preferences.json');
    const existing = existsSync(filePath)
      ? JSON.parse(readFileSync(filePath, 'utf8'))
      : { version: 1, preferences: {} };
    writeJson(filePath, {
      ...existing,
      version: existing.version ?? 1,
      preferences: { ...existing.preferences, ...preferences },
    });
  }

  let electronApp;
  try {
    if (mockKey) {
      await registerScenario(DEFAULT_MOCK_BASE_URL, mockKey, {
        authUsage:
          typeof authUsageScenario === 'string'
            ? { scenario: authUsageScenario }
            : authUsageScenario,
      });
    }
    ({ electronApp } = await launchCanopy({
      userDataDir,
      env: { ...env, ...(mockKey ? { CANOPY_MOCK_API_KEY: mockKey } : {}) },
    }));
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
    await run(window, electronApp, { mockKey });
  } finally {
    try {
      if (electronApp) await closeCanopy(electronApp, userDataDir);
    } finally {
      if (mockKey) await clearScenario(DEFAULT_MOCK_BASE_URL, mockKey);
    }
  }
}

test('session routing past its reset time shows no routing card', async () => {
  await withRoutedChat(
    {
      aiCreditsRouting: {
        active: true,
        scope: 'session',
        activatedAt: Date.now() - 2 * 60 * 60 * 1000,
        resetsAt: Date.now() - 60 * 60 * 1000,
      },
    },
    async (window) => {
      // The composer clears the stale routing from the stored chat, with no
      // subscription override.
      await expect
        .poll(
          async () => {
            const tab = await persistedTab(window);
            return {
              routing: tab?.aiCreditsRouting ?? null,
              override: tab?.subscriptionBillingOverride ?? false,
            };
          },
          { timeout: 30_000 },
        )
        .toEqual({ routing: null, override: false });
      await expect(
        window.getByTestId('chat-input-ai-credits-active'),
      ).toBeHidden();
      await expectNoRejectedCommand(window);
    },
  );
});

test('session routing ends after the native account changes', async () => {
  await withRoutedChat(
    {
      // No `activatedAt`: chats stuck before account tracking shipped count
      // as older than any recorded account change.
      aiCreditsRouting: { active: true, scope: 'session' },
      // The composer bills this chat's model to Claude, and the mock Claude
      // account is tester@example.com, so startup records a switch from this
      // account.
      preferences: {
        nativeProviderAccounts: {
          claude: { accountKey: 'someone-else@example.com' },
        },
      },
    },
    async (window) => {
      await expect
        .poll(
          async () => {
            const preferences = await window.evaluate(() =>
              window.api.loadPreferences(),
            );
            const claude = preferences.nativeProviderAccounts?.claude;
            return {
              accountKey: claude?.accountKey ?? null,
              changed: typeof claude?.changedAt === 'number',
            };
          },
          { timeout: 30_000 },
        )
        .toEqual({ accountKey: 'tester@example.com', changed: true });
      await expect
        .poll(
          async () => (await persistedTab(window))?.aiCreditsRouting ?? null,
          {
            timeout: 30_000,
          },
        )
        .toBeNull();
      await expect(
        window.getByTestId('chat-input-ai-credits-active'),
      ).toBeHidden();
      // No rejected-command check here: a stored routing with no
      // `activatedAt` already raises an unrelated "Change not saved" notice on
      // load, account change or not.
    },
  );
});

/** The active chat's composer, not the first editor anywhere in the window. */
function composer(window) {
  return window
    .getByTestId('panel-content-chat')
    .locator('[data-chat-textarea][contenteditable="true"]');
}

async function persistedBilling(window) {
  const tab = await persistedTab(window);
  return {
    routing: tab?.aiCreditsRouting ?? null,
    override: tab?.subscriptionBillingOverride ?? false,
  };
}

/**
 * Wait for the card's usage read to report the limit, mark the finished
 * credits turn's live routing bit as still on, and return the shown reset.
 */
async function openLimitedCard(window, electronApp) {
  const routingBanner = window.getByTestId('chat-input-ai-credits-active');
  await expect(routingBanner).toBeVisible({ timeout: 30_000 });
  const resetLine = window.getByTestId('chat-input-ai-credits-limit-resets');
  await expect(resetLine).toBeVisible({ timeout: 30_000 });
  const match = /^(Claude|Codex) resets (.+)$/.exec(
    (await resetLine.textContent()) ?? '',
  );
  expect(match).not.toBeNull();
  const resetLabel = match[2];
  await injectChatEvent(electronApp, {
    projectId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    chatId: CHAT_ID,
    data: {
      type: 'canopy_ai_credits_routing',
      active: true,
      provider: match[1].toLowerCase(),
    },
  });
  await injectChatEvent(electronApp, {
    projectId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    chatId: CHAT_ID,
    data: { type: 'result', is_error: false, result: '' },
  });
  await expect(window.getByTestId('chat-stop-generation')).toHaveCount(0);
  await expect(routingBanner).toBeVisible();
  return resetLabel;
}

function sessionRouting() {
  return { active: true, scope: 'session', activatedAt: Date.now() };
}

test('switching to a limited subscription confirms, then restores the usage-limit warning (CAN-4759)', async () => {
  await withRoutedChat(
    {
      aiCreditsRouting: sessionRouting(),
      authUsageScenario: limitedUsage(),
    },
    async (window, electronApp) => {
      const resetLabel = await openLimitedCard(window, electronApp);

      await window
        .getByTestId('chat-input-ai-credits-switch-to-subscription')
        .click();
      const confirm = window.getByTestId(
        'chat-input-ai-credits-switch-confirm',
      );
      await expect(confirm).toBeVisible();
      await expect(confirm).toContainText(`is limited until ${resetLabel}`);
      await expect(confirm).toContainText('Switch anyway?');
      const accept = window.getByTestId('chat-input-ai-credits-switch-accept');
      await expect(accept).toBeFocused();
      // Asking changes nothing yet.
      expect((await persistedBilling(window)).override).toBe(false);
      expect((await persistedBilling(window)).routing).not.toBeNull();

      await accept.click();

      await expect(
        window.getByTestId('chat-input-ai-credits-active'),
      ).toHaveCount(0);
      // The warning is back before anything else is sent, with the same reset
      // and its recovery actions, despite the stale live routing bit.
      const warning = window.getByTestId('chat-input-usage-limit-banner');
      await expect(warning).toBeVisible();
      await expect(warning).toContainText('usage limit reached');
      await expect(warning).toContainText(resetLabel);
      await expect(
        window.getByTestId('chat-input-usage-limit-ai-credits-once'),
      ).toBeVisible();
      await expect
        .poll(() => persistedBilling(window))
        .toEqual({ routing: null, override: true });
      await expectNoRejectedCommand(window);
      await expect(composer(window)).toBeFocused();

      // Recovery: choosing credits again routes this chat through credits and
      // retires the warning for the routing card.
      await window
        .getByTestId('chat-input-usage-limit-ai-credits-once')
        .click();
      await expect(warning).toHaveCount(0);
      await expect(
        window.getByTestId('chat-input-ai-credits-active'),
      ).toBeVisible();
      await expect
        .poll(async () => (await persistedBilling(window)).routing?.active)
        .toBe(true);
      await expectNoRejectedCommand(window);
    },
  );
});

test('keeping credits at the limited-subscription prompt changes nothing (CAN-4759)', async () => {
  await withRoutedChat(
    {
      aiCreditsRouting: sessionRouting(),
      authUsageScenario: limitedUsage(),
    },
    async (window, electronApp) => {
      await openLimitedCard(window, electronApp);
      const before = await persistedBilling(window);
      const switchButton = window.getByTestId(
        'chat-input-ai-credits-switch-to-subscription',
      );
      await switchButton.click();
      await window.getByTestId('chat-input-ai-credits-switch-cancel').click();

      await expect(
        window.getByTestId('chat-input-ai-credits-switch-confirm'),
      ).toHaveCount(0);
      await expect(
        window.getByTestId('chat-input-ai-credits-active'),
      ).toBeVisible();
      await expect(switchButton).toBeFocused();
      await expect(
        window.getByTestId('chat-input-usage-limit-banner'),
      ).toHaveCount(0);
      expect(await persistedBilling(window)).toEqual(before);
    },
  );
});

test('failed usage snapshots require an explicit switch anyway (CAN-4759)', async () => {
  await withRoutedChat(
    {
      aiCreditsRouting: sessionRouting(),
      authUsageScenario: {
        claude: {
          auth: {
            loggedIn: true,
            email: 'tester@example.com',
            authMethod: 'oauth',
            subscriptionType: 'max',
          },
          usageHttpStatus: 503,
        },
        codex: {
          account: {
            type: 'chatgpt',
            email: 'tester@example.com',
            planType: 'plus',
          },
          ratelimitsHttpStatus: 503,
        },
      },
    },
    async (window) => {
      const button = window.getByTestId(
        'chat-input-ai-credits-switch-to-subscription',
      );
      await expect(button).toBeEnabled();
      await button.click();
      const confirmation = window.getByTestId(
        'chat-input-ai-credits-switch-confirm',
      );
      await expect(confirmation).toBeVisible();
      await expect(confirmation).toContainText("Couldn't confirm");
      expect((await persistedBilling(window)).override).toBe(false);
      await window.getByTestId('chat-input-ai-credits-switch-accept').click();
      await expect(
        window.getByTestId('chat-input-subscription-availability-notice'),
      ).toBeVisible();
      await expect(
        window.getByTestId('chat-input-usage-limit-banner'),
      ).toHaveCount(0);
      await expect
        .poll(() => persistedBilling(window))
        .toEqual({ routing: null, override: true });
      await expect(composer(window)).toBeFocused();
    },
  );
});

/** Fixed per invocation: refreshes cannot move the confirmed/scheduled reset. */
function limitedUsage() {
  const resetAt = new Date(Date.now() + 2 * 3_600_000).toISOString();
  return {
    claude: {
      auth: {
        loggedIn: true,
        email: 'tester@example.com',
        authMethod: 'oauth',
        subscriptionType: 'max',
      },
      usage: { five_hour: { utilization: 100, resets_at: resetAt } },
    },
    codex: {
      account: {
        type: 'chatgpt',
        email: 'tester@example.com',
        planType: 'plus',
      },
      rateLimits: [
        {
          limitId: 'primary',
          primary: {
            usedPercent: 100,
            windowDurationMins: 300,
            resetsAt: resetAt,
          },
        },
      ],
    },
  };
}

test('a restored warning can schedule resume without sending a turn (CAN-4759)', async () => {
  await withRoutedChat(
    { aiCreditsRouting: sessionRouting(), authUsageScenario: limitedUsage() },
    async (window, electronApp, { mockKey }) => {
      const resetLabel = await openLimitedCard(window, electronApp);
      await window
        .getByTestId('chat-input-ai-credits-switch-to-subscription')
        .click();
      await window.getByTestId('chat-input-ai-credits-switch-accept').click();
      const activityBefore = await getScenarioActivity(
        DEFAULT_MOCK_BASE_URL,
        mockKey,
      );
      await window
        .getByTestId('chat-input-usage-limit-schedule-resume')
        .click();
      const scheduled = window.getByTestId('chat-input-usage-limit-scheduled');
      await expect(scheduled).toBeVisible();
      await expect(scheduled).toContainText(resetLabel);
      await expect(
        window.getByTestId('chat-input-usage-limit-schedule-resume'),
      ).toHaveCount(0);
      expect(await getScenarioActivity(DEFAULT_MOCK_BASE_URL, mockKey)).toEqual(
        activityBefore,
      );
      await expectNoRejectedCommand(window);
      expect(await persistedBilling(window)).toEqual({
        routing: null,
        override: true,
      });
    },
  );
});

test('an early click cannot bypass the pending usage check (CAN-4759)', async () => {
  let release;
  const usageReady = new Promise((resolve) => {
    release = resolve;
  });
  // Hold only provider usage responses; auth and cloud setup remain usable.
  // This proxy is scoped to this foreground test and closed in finally.
  const server = createServer(async (incoming, outgoing) => {
    if (['/api/oauth/usage', '/__mock/codex/ratelimits'].includes(incoming.url))
      await usageReady;
    if (outgoing.destroyed) return;
    const destination = new URL(incoming.url, DEFAULT_MOCK_BASE_URL);
    const upstream = request(
      destination,
      {
        method: incoming.method,
        headers: { ...incoming.headers, host: destination.host },
      },
      (response) => {
        outgoing.writeHead(response.statusCode, response.headers);
        response.pipe(outgoing);
      },
    );
    upstream.on('error', () => {
      outgoing.writeHead(502);
      outgoing.end();
    });
    incoming.pipe(upstream);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('No proxy port');
    await withRoutedChat(
      {
        aiCreditsRouting: sessionRouting(),
        authUsageScenario: limitedUsage(),
        env: { CANOPY_MOCK_LLM_BASE_URL: `http://127.0.0.1:${address.port}` },
      },
      async (window) => {
        const button = window.getByTestId(
          'chat-input-ai-credits-switch-to-subscription',
        );
        await expect(button).toBeVisible();
        await expect(button).toBeDisabled();
        await expect(button).toHaveAttribute('aria-busy', 'true');
        await expect(
          button.getByTestId('chat-input-ai-credits-switch-checking'),
        ).toBeVisible();
        await expect(
          window.getByTestId('chat-input-ai-credits-active'),
        ).not.toContainText('Checking');
        // A DOM click reproduces an early activation without Playwright waiting
        // for the disabled button to become enabled first.
        await button.evaluate((element) => element.click());
        expect((await persistedBilling(window)).override).toBe(false);
        await expect(
          window.getByTestId('chat-input-ai-credits-switch-confirm'),
        ).toHaveCount(0);
        release();
        await expect(button).toBeEnabled();
        await button.click();
        await expect(
          window.getByTestId('chat-input-ai-credits-switch-confirm'),
        ).toBeVisible();
        expect((await persistedBilling(window)).override).toBe(false);
      },
    );
  } finally {
    release();
    server.closeAllConnections();
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test('a rejected subscription command leaves usable credits routing (CAN-4759)', async () => {
  await withRoutedChat(
    { aiCreditsRouting: sessionRouting(), authUsageScenario: limitedUsage() },
    async (window, electronApp) => {
      await openLimitedCard(window, electronApp);
      const before = await persistedBilling(window);
      // Fail one existing command at the main IPC seam, preserving every other
      // handler and restoring the real handler before returning the rejection.
      await electronApp.evaluate(({ ipcMain }) => {
        const channel = 'chat:command';
        const original = ipcMain._invokeHandlers.get(channel);
        if (!original) throw new Error('Chat command handler is unavailable');
        ipcMain.removeHandler(channel);
        ipcMain.handle(channel, (event, envelope) => {
          if (
            envelope.command.type === 'chat.patch_tab_settings' &&
            envelope.command.patch.subscriptionBillingOverride === true
          ) {
            ipcMain.removeHandler(channel);
            ipcMain.handle(channel, original);
            return {
              commandId: envelope.commandId,
              revision: 1,
              outcome: 'rejected',
            };
          }
          return original(event, envelope);
        });
      });
      await window
        .getByTestId('chat-input-ai-credits-switch-to-subscription')
        .click();
      await window.getByTestId('chat-input-ai-credits-switch-accept').click();
      await expect(
        window.getByTestId('chat-state-recovery-banner'),
      ).toBeVisible();
      await expect(
        window.getByTestId('chat-input-ai-credits-active'),
      ).toBeVisible();
      await expect(
        window.getByTestId('chat-input-usage-limit-banner'),
      ).toHaveCount(0);
      expect(await persistedBilling(window)).toEqual(before);
      await expect(
        window.getByTestId('chat-input-ai-credits-switch-to-subscription'),
      ).toBeEnabled();
    },
  );
});

test('fresh Claude subscription allowance clears only legacy session fallback across scoped formats despite exhausted Extra usage', async () => {
  test.setTimeout(120_000);
  const key = 'can-4272-restored-allowance';
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-restored-claude-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    tabs: [
      {
        id: CHAT_ID,
        title: 'Recovered subscription',
        model: 'sonnet',
        aiCreditsRouting: {
          active: true,
          scope: 'session',
          activatedAt: Date.now() - 86400000,
        },
      },
      {
        id: 'persistent-credits',
        title: 'Explicit credits',
        model: 'sonnet',
        aiCreditsRouting: {
          active: true,
          scope: 'persistent',
          activatedAt: Date.now() - 86400000,
        },
      },
    ],
  });
  await registerScenario(DEFAULT_MOCK_BASE_URL, key, {
    authUsage: {
      claude: {
        auth: {
          loggedIn: true,
          email: 'tester@example.com',
          authMethod: 'oauth',
          subscriptionType: 'max',
        },
        usage: {
          five_hour: { utilization: 0, resets_at: '+2h' },
          seven_day: { utilization: 0, resets_at: '+5d' },
          seven_day_sonnet: { utilization: 100, resets_at: null },
          extra_usage: {
            is_enabled: true,
            monthly_limit: 5000,
            used_credits: 6100,
            utilization: 122,
            currency: 'USD',
            decimal_places: 2,
          },
        },
      },
    },
  });
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: {
      CANOPY_MOCK_API_KEY: key,
      CANOPY_E2E_CLAUDE_USAGE_FRESHNESS_MS: '0',
    },
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await window.evaluate(async (apiKey) => {
      await window.api.saveCanopyCloudApiKey({ apiKey });
      window.dispatchEvent(new Event('canopy:cloud-account-changed'));
    }, TEST_CLOUD_API_KEY);
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_BRANCH);
    await expect
      .poll(async () => {
        const snapshot = await window.evaluate(() =>
          window.api.observability.loadSnapshot(),
        );
        return snapshot.usage.providers
          .find((provider) => provider.provider === 'claude')
          ?.rateLimits?.find((limit) => limit.limitId === 'seven_day_sonnet')
          ?.primary?.usedPercent;
      })
      .toBe(100);
    await registerScenario(DEFAULT_MOCK_BASE_URL, key, {
      authUsage: {
        claude: {
          auth: {
            loggedIn: true,
            email: 'tester@example.com',
            authMethod: 'oauth',
            subscriptionType: 'max',
          },
          usage: {
            limits: [
              { kind: 'session', percent: 10 },
              { kind: 'weekly_all', percent: 20 },
              {
                kind: 'weekly_scoped',
                percent: 10,
                scope: {
                  model: { id: 'claude-sonnet-4-6', display_name: 'Sonnet' },
                },
              },
            ],
            extra_usage: {
              is_enabled: true,
              monthly_limit: 5000,
              used_credits: 6100,
              utilization: 122,
              currency: 'USD',
              decimal_places: 2,
            },
          },
        },
      },
    });
    await window.evaluate(() =>
      window.api.observability.refreshUsage('claude'),
    );
    await expect
      .poll(async () => {
        const refreshed = await window.evaluate(() =>
          window.api.observability.loadSnapshot(),
        );
        return refreshed.usage.providers
          .find((provider) => provider.provider === 'claude')
          ?.rateLimits?.map((limit) => limit.limitId);
      })
      .toEqual([
        'session',
        'weekly_all',
        'weekly_scoped:Sonnet',
        'extra_usage',
      ]);
    await expect
      .poll(async () => {
        const tabs = await window.evaluate(
          (target) => window.api.chat.loadTabs(target),
          { projectId: WORKSPACE_ID, worktreeId: WORKTREE_ID },
        );
        return (
          tabs.tabs.find((tab) => tab.id === CHAT_ID)?.aiCreditsRouting
            ?.active ?? false
        );
      })
      .toBe(false);
    const tabs = await window.evaluate(
      (target) => window.api.chat.loadTabs(target),
      { projectId: WORKSPACE_ID, worktreeId: WORKTREE_ID },
    );
    expect(
      tabs.tabs.find((tab) => tab.id === 'persistent-credits')?.aiCreditsRouting
        ?.scope,
    ).toBe('persistent');
    await expect(
      window.getByTestId('chat-input-ai-credits-active'),
    ).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, key);
  }
});
