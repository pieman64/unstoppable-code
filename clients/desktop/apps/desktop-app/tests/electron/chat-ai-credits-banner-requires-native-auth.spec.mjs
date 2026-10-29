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
import { closeModelPicker } from './modelPickerBilling.mjs';

// The "You're using AI Credits for this session" banner is gated on the account
// having a native login for the billing provider, not just on the chat billing
// to AI Credits. A brand-new user who signs in to the cloud account and has
// never logged in to Claude or Codex has credits as their only option, so the
// banner announces a fact they cannot act on. The model picker's locked billing
// toggle is where that user learns their billing state.
//
// Deterministic state:
//   - Signed-out providers: a per-spec `authUsage: { scenario: 'unauthenticated' }`
//     registered under this spec's own `CANOPY_MOCK_API_KEY` (the auth probes
//     key off that bearer), so no worker shares the default `mock` key.
//   - Credits eligible: any `csk_`-prefixed key authenticates against the cloud
//     mock, which serves a `Pro` subscription + an eligible balance.
// The chat is seeded with active session-scoped credits routing, so on the
// pre-fix build the banner rendered here. It must not now.
//
// Run:
//   pnpm run build:e2e
//   pnpm run test:electron:built chat-ai-credits-banner-requires-native-auth.spec.mjs --reporter=line

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const WORKTREE_BRANCH = 'demo-main';
const CHAT_ID = 'ai-credits-banner-native-auth-chat';
// Pinned rather than inherited from default-model selection. This spec's settle
// signal asserts `chat-billing-sign-in`, which `ModelPicker` renders only for
// `lockKind: 'no-native-login'`. That lock needs a model that is
// gateway-routable but NOT gateway-only, so `subscriptionAvailable` is false
// for the missing native login rather than for the model. `gpt-5.6-sol` carries
// a `gatewayId` in the package.json codex config and is not gateway-only, so it
// satisfies both. Leaving the model unpinned would let a future default resolve
// to a gateway-only model, flipping the lock to `gateway-only-model` and
// failing this spec for a reason unrelated to the banner.
const DEFAULT_MODEL = 'gpt-5.6-sol';
const TEST_CLOUD_API_KEY = 'csk_ai_credits_banner_native_auth_e2e';
const CLOUD_ACCOUNT_CHANGED_EVENT = 'canopy:cloud-account-changed';

test('the AI Credits session banner stays hidden for an account with no native provider login', async () => {
  const authKey = 'ai-credits-banner-native-auth-unauthenticated';
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
        aiCreditsRouting: {
          active: true,
          scope: 'session',
          activatedAt: Date.parse('2026-04-10T12:00:00.000Z'),
        },
      },
    ],
  });

  await registerScenario(DEFAULT_MOCK_BASE_URL, authKey, {
    authUsage: { scenario: 'unauthenticated' },
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
      TEST_CLOUD_API_KEY,
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

    // Settle signal, and the positive half of the contract. Asserting the
    // banner's absence is vacuous until the provider-availability probe has
    // resolved, so wait on the picker's locked billing toggle instead of a
    // sleep: `chat-billing-locked-reason` only renders once the shared resolver
    // has landed on AI Credits locked with the `no-native-login` lockKind. That
    // is exactly the state the banner used to render in, and it is where a
    // credits-only user is still told about their billing.
    // Click the picker rather than pressing Alt+M. The chord is a one-shot that
    // depends on `resolveComposerShortcutScope()` having a resolved
    // `activeTabId` at that exact instant; a miss goes unclaimed and burns the
    // next assertion's full timeout on an unrelated symptom. The sibling
    // billing specs click the picker for the same reason, and the chord itself
    // is already covered by `shortcut-layout-composer.spec.mjs`.
    await window.getByTestId('chat-model-picker').click();
    await expect(window.getByTestId('chat-model-menu')).toBeVisible({
      timeout: 15_000,
    });
    // Credits-only has resolved once the chat's own row says it bills to AI
    // Credits: its Codex harness is not signed in, and credits pay for it.
    const row = await revealModelRow(window, DEFAULT_MODEL);
    await expect(
      row.locator(`[data-testid="chat-model-row-credits-${DEFAULT_MODEL}"]`),
    ).toBeVisible({ timeout: 15_000 });
    // The Legacy models flyout holds this row, so close it and the picker.
    await closeModelPicker(window);

    // The gate: credits-only, so the banner must not render. This fails on the
    // pre-fix build, where `framework === 'ai-credits'` alone drove it.
    await expect(
      window.getByTestId('chat-input-ai-credits-active'),
    ).toHaveCount(0);
    await expect(
      window.getByTestId('chat-input-usage-limit-banner'),
    ).toBeVisible();
    await expect(
      window.getByTestId('chat-input-usage-limit-banner'),
    ).toContainText('Codex usage limit reached');
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, authKey).catch(() => undefined);
  }
});
