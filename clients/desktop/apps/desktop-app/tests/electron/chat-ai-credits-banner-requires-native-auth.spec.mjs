import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  clearScenario,
  DEFAULT_MOCK_BASE_URL,
  registerScenario,
  seedWorktreeChat,
} from './seeders/index.mjs';
import { revealModelRow } from './model-selection-fixture.mjs';
import { mergeSeedPreferences } from './seeders/mergePreferences.mjs';
import {
  closeModelPicker,
  offeredBillingMenus,
  openModelBillingMenu,
} from './modelPickerBilling.mjs';

// CAN-4272: an inconclusive auth probe cannot prevent an explicit native
// subscription attempt, and neither can a sign-out when no credits can pay.
// CAN-5349 narrows that: a confirmed sign-out with usable credits locks the
// chat to AI Credits, so neither the card nor the picker offers subscription.
const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const WORKTREE_BRANCH = 'demo-main';
const CHAT_ID = 'ai-credits-banner-native-auth-chat';
// Pin a native-capable model that can also route through AI Credits.
const DEFAULT_MODEL = 'gpt-5.6-sol';
const TEST_CLOUD_API_KEY = 'csk_ai_credits_banner_native_auth_e2e';
const CLOUD_ACCOUNT_CHANGED_EVENT = 'canopy:cloud-account-changed';

async function modelRequests(key) {
  const response = await fetch(
    `${DEFAULT_MOCK_BASE_URL}/__mock/requests?key=${encodeURIComponent(key)}`,
  );
  expect(response.ok).toBe(true);
  const { requests } = await response.json();
  expect(Array.isArray(requests)).toBe(true);
  return requests;
}

for (const explicitSubscription of [false, true]) {
  test(`Home ${explicitSubscription ? 'preserves an explicit subscription choice' : 'locks a confirmed signed-out account with credits to AI Credits'} (CAN-5349)`, async () => {
    const authKey = `can-5349-home-billing-${explicitSubscription}`;
    const cloudKey = `${TEST_CLOUD_API_KEY}_home`;
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-home-billing-'),
    );
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    mergeSeedPreferences(userDataDir, {
      defaultChatProvider: 'codex',
      defaultChatModelByProvider: { codex: { model: DEFAULT_MODEL } },
    });
    await registerScenario(DEFAULT_MOCK_BASE_URL, authKey, {
      authUsage: { scenario: 'unauthenticated' },
    });
    await registerScenario(DEFAULT_MOCK_BASE_URL, cloudKey, {
      cloud: {
        aiCreditsBalance: {
          credits: explicitSubscription ? 0 : 1234,
          eligible: !explicitSubscription,
        },
      },
    });
    const { electronApp } = await launchCanopy({
      userDataDir,
      env: { CANOPY_MOCK_API_KEY: authKey },
    });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();
      await window.evaluate(async (apiKey) => {
        await window.api.saveCanopyCloudApiKey({ apiKey });
        window.dispatchEvent(new Event('canopy:cloud-account-changed'));
      }, cloudKey);
      const home = await app.openHomeForProject(WORKSPACE_ID);
      if (explicitSubscription) {
        // Establish the existing choice through the unchanged no-credits
        // attempt path, then let credits arrive while auth remains signed out.
        const choices = await openModelBillingMenu(window, DEFAULT_MODEL);
        await choices.subscription.click();
        await closeModelPicker(window);
        await registerScenario(DEFAULT_MOCK_BASE_URL, cloudKey, {
          cloud: { aiCreditsBalance: { credits: 1234, eligible: true } },
        });
        await window.evaluate(() => {
          window.dispatchEvent(new Event('canopy:cloud-account-changed'));
        });
      }
      await home.getByTestId('chat-model-picker').click();
      const row = await revealModelRow(window, DEFAULT_MODEL);
      const creditsLabel = row.getByTestId(
        `chat-model-row-credits-${DEFAULT_MODEL}`,
      );
      if (explicitSubscription) {
        await expect(creditsLabel).toHaveCount(0);
        await closeModelPicker(window);
        const choices = await openModelBillingMenu(window, DEFAULT_MODEL);
        await expect(choices.subscription).toBeEnabled();
        await choices.credits.click();
        await closeModelPicker(window);
        // Choosing credits ends the preserved subscription override; the next
        // resolution must apply the confirmed-sign-out lock on Home as in chat.
        await home.getByTestId('chat-model-picker').click();
      } else {
        await expect(creditsLabel).toBeVisible();
      }
      await expect(offeredBillingMenus(window)).toHaveCount(0);
      const signIn = window.getByTestId('chat-billing-sign-in');
      await expect(signIn).toHaveText('Sign in to Codex');
      await signIn.click();
      await expect(
        window.getByRole('dialog', { name: 'Sign in to Codex' }),
      ).toBeVisible();
      expect(await Promise.all([authKey, cloudKey].map(modelRequests))).toEqual(
        [[], []],
      );
    } finally {
      await closeCanopy(electronApp, userDataDir);
      await clearScenario(DEFAULT_MOCK_BASE_URL, authKey).catch(
        () => undefined,
      );
      await clearScenario(DEFAULT_MOCK_BASE_URL, cloudKey).catch(
        () => undefined,
      );
    }
  });
}

for (const hasCredits of [true, false]) {
  const title = hasCredits
    ? 'a confirmed signed-out account with credits stays on AI Credits without a switch (CAN-5349)'
    : 'a confirmed signed-out account without credits can explicitly select subscription';
  test(title, async () => {
    const authKey = `ai-credits-banner-native-auth-${hasCredits}`;
    const cloudKey = `${TEST_CLOUD_API_KEY}_${hasCredits}`;
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-ai-credits-banner-native-auth-'),
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
          title: 'Credits only',
          model: DEFAULT_MODEL,
          // A historical limit does not imply that native auth is still
          // available. Keep the limit notice when the credits card cannot show
          // (CAN-4757), even though the chat bills to credits.
          claudeUsageLimitBanner: {
            provider: 'codex',
            message: 'codex usage limit reached in mock chat.',
            detectedAt: Date.parse('2026-04-10T12:00:00.000Z'),
            requestId: 'mock-codex-native-auth-usage-limit',
            dismissKey: 'usage-limit:codex:native-auth',
          },
          aiCreditsRouting: hasCredits
            ? {
                active: true,
                scope: 'session',
                activatedAt: Date.parse('2026-04-10T12:00:00.000Z'),
              }
            : undefined,
        },
      ],
    });

    await registerScenario(DEFAULT_MOCK_BASE_URL, authKey, {
      authUsage: { scenario: 'unauthenticated' },
    });
    await registerScenario(DEFAULT_MOCK_BASE_URL, cloudKey, {
      cloud: {
        aiCreditsBalance: {
          credits: hasCredits ? 1234 : 0,
          eligible: hasCredits,
        },
      },
    });

    const { electronApp } = await launchCanopy({
      userDataDir,
      env: {
        HOME: userDataDir,
        CANOPY_MOCK_API_KEY: authKey,
        CANOPY_E2E_CLOUD_BASE_URL: DEFAULT_MOCK_BASE_URL,
      },
    });

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);

      await app.waitForShell({ timeout: 30_000 });

      // Make AI Credits genuinely eligible, so the chat really does bill to
      // credits. Without this the banner would be hidden for the uninteresting
      // reason that there is no credits framework at all.
      const saveResult = await window.evaluate(
        async (apiKey) => window.api.saveCanopyCloudApiKey({ apiKey }),
        cloudKey,
      );
      expect(saveResult.status.authenticated).toBe(true);
      await window.evaluate((eventName) => {
        window.dispatchEvent(new Event(eventName));
      }, CLOUD_ACCOUNT_CHANGED_EVENT);

      await app.openMainPage();
      await app.selectWorktree(WORKTREE_BRANCH);
      await expect(window.getByTestId('panel-content-chat')).toBeVisible();

      // The composer is live — this is a real, usable chat, not a blocked shell.
      await expect(window.getByTestId('chat-model-picker')).toBeVisible({
        timeout: 30_000,
      });

      const requestsBefore = await Promise.all(
        [authKey, cloudKey].map(modelRequests),
      );
      if (hasCredits) {
        await window.getByTestId('chat-model-picker').click();
        await expect(window.getByTestId('chat-model-menu')).toBeVisible({
          timeout: 15_000,
        });
        // Credits-only has resolved once the chat's own row says it bills to AI
        // Credits: its Codex harness is not signed in, and credits pay for it.
        const row = await revealModelRow(window, DEFAULT_MODEL);
        await expect(
          row.locator(
            `[data-testid="chat-model-row-credits-${DEFAULT_MODEL}"]`,
          ),
        ).toBeVisible({ timeout: 15_000 });
        // Locked billing offers no row billing menu, and the actual harness
        // layout exposes the existing provider sign-in remedy.
        await expect(offeredBillingMenus(window)).toHaveCount(0);
        await window.getByTestId('chat-billing-sign-in').click();
        await expect(
          window.getByRole('dialog', { name: 'Sign in to Codex' }),
        ).toBeVisible();
        await window.getByTestId('auth-login-cancel').click();

        const banner = window.getByTestId('chat-input-ai-credits-active');
        await expect(banner).toBeVisible();
        await expect(
          banner.getByTestId('chat-input-ai-credits-switch-to-subscription'),
        ).toHaveCount(0);
      } else {
        // A same-value menu selection must explicitly persist the native attempt.
        const choices = await openModelBillingMenu(window, DEFAULT_MODEL);
        await expect(choices.subscription).toBeEnabled();
        await choices.subscription.click();
        await closeModelPicker(window);
      }
      const subscriptionOverride = async () => {
        const tabs = await window.evaluate(
          (target) => window.api.chat.loadTabs(target),
          {
            projectId: WORKSPACE_ID,
            worktreeId: WORKTREE_ID,
          },
        );
        return (
          tabs.tabs.find((tab) => tab.id === CHAT_ID)
            ?.subscriptionBillingOverride === true
        );
      };
      if (hasCredits) {
        expect(await subscriptionOverride()).toBe(false);
        await expect(
          window.getByTestId('chat-input-ai-credits-active'),
        ).toBeVisible();
      } else {
        await expect.poll(subscriptionOverride).toBe(true);
        await expect(
          window.getByTestId('chat-input-ai-credits-active'),
        ).toHaveCount(0);
      }
      expect(await Promise.all([authKey, cloudKey].map(modelRequests))).toEqual(
        requestsBefore,
      );
    } finally {
      await closeCanopy(electronApp, userDataDir);
      await clearScenario(DEFAULT_MOCK_BASE_URL, authKey).catch(
        () => undefined,
      );
      await clearScenario(DEFAULT_MOCK_BASE_URL, cloudKey).catch(
        () => undefined,
      );
    }
  });
}
