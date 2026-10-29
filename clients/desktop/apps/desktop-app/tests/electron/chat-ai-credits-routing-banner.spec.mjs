import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  injectChatEvent,
  seedWorktreeChat,
  writeJson,
} from './seeders/index.mjs';

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
        aiCreditsRouting: {
          active: true,
          scope: 'session',
          activatedAt: Date.parse('2026-04-10T12:00:00.000Z'),
        },
      },
    ],
  });

  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);

    await app.waitForShell({ timeout: 30_000 });

    // The status banner now tracks the chat's *effective* billing framework via
    // the shared resolver (chatBillingFramework.ts), not just the stored per-tab
    // routing bit: it is only visible when the chat can actually bill to AI
    // Credits. Connect the mock cloud account so the resolver sees a
    // credits-eligible account (otherwise there is no AI Credits framework to
    // route to and the banner correctly stays hidden).
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
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
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
 * account connected, and hand the window to `run`.
 */
async function withRoutedChat({ aiCreditsRouting, preferences }, run) {
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
    await run(window);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
}

test('Switch to subscription on the routing card returns the chat to its subscription', async () => {
  await withRoutedChat(
    {
      aiCreditsRouting: {
        active: true,
        scope: 'session',
        activatedAt: Date.now(),
      },
    },
    async (window) => {
      const routingBanner = window.getByTestId('chat-input-ai-credits-active');
      await expect(routingBanner).toBeVisible({ timeout: 30_000 });
      const switchButton = window.getByTestId(
        'chat-input-ai-credits-switch-to-subscription',
      );
      await expect(switchButton).toHaveText('Switch to subscription');

      await switchButton.click();

      await expect(routingBanner).toBeHidden({ timeout: 10_000 });
      // Exactly the picker's subscription choice: routing cleared and the
      // subscription override persisted.
      await expect
        .poll(async () => {
          const tab = await persistedTab(window);
          return {
            routing: tab?.aiCreditsRouting ?? null,
            override: tab?.subscriptionBillingOverride ?? false,
          };
        })
        .toEqual({ routing: null, override: true });
      await expectNoRejectedCommand(window);
    },
  );
});

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
