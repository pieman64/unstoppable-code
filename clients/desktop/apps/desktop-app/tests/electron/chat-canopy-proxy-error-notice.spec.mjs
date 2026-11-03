import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { readChatStorageTabs } from './readChatStorage.mjs';
import { withBundledBinaryOverridesScrubbed } from './seeders/bundledBinaryOverrides.mjs';
import {
  clearScenario,
  DEFAULT_MOCK_BASE_URL,
  getScenarioActivity,
  injectChatEvent,
  registerScenario,
  seedWorktreeChat,
} from './seeders/index.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const CHAT_ID = 'canopy-proxy-error-chat';
const CORRELATION_ID = 'a1b2c3d4-0000-4000-8000-abcdefabcdef';
const ORIGINAL_PROMPT = 'Finish the original proxy retry request';
const GATEWAY_ONLY_MODEL = 'deepseek-v4-pro';

async function injectGatewayOnlyModelRegistry(electronApp) {
  await electronApp.evaluate(
    ({ BrowserWindow }, { model }) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (!window) throw new Error('No BrowserWindow available');
      window.webContents.send('model-registry:updated', {
        claude: [],
        codex: [],
        ollama: [],
        agents: [],
        aliases: {},
        // Gateway-only entries live in the dedicated catalog and route fields
        // carried by the model-registry snapshot. Keep this fixture aligned
        // with that transport contract so the renderer's billing resolver can
        // recognize the seeded model as AI Credits-only after hydration.
        aiGatewayModels: [
          {
            id: model,
            label: 'DeepSeek V4 Pro',
            recommendedHarness: 'codex',
            contextWindow: 1_000_000,
            supportsPromptCaching: false,
            supportedThinkingLevels: ['low', 'medium', 'high'],
            toolSchemaProfile: 'standard',
          },
        ],
        gatewayRoutes: [
          {
            modelId: model,
            gatewayId: 'deepseek/deepseek-v4-pro',
            family: 'deepseek',
            recommendedHarness: 'codex',
            gatewayOnly: true,
            contextWindow: 1_000_000,
            supportsPromptCaching: false,
            supportedThinkingLevels: ['low', 'medium', 'high'],
            toolSchemaProfile: 'standard',
          },
        ],
      });
    },
    { model: GATEWAY_ONLY_MODEL },
  );
}

/**
 * CAN-2413: a structured AI Credits proxy failure must render as the clean
 * `CanopyProxyErrorNotice` rather than the raw JSON body Codex embeds into
 * `unexpected status <code>: <body>`.
 *
 * The Codex `turn.failed` event is injected directly on the `chat:event` IPC
 * channel in its live wire shape (`{ type: 'codex', event: {...} }`, unwrapped
 * by `event-transforms.ts`), so no fake app-server or live gateway is needed
 * and the failure body is exactly the one `codex-gateway-proxy-service.ts`
 * synthesizes.
 */
function proxyErrorMessage(code, status = '502 Bad Gateway') {
  // Field order mirrors `writeProxyError` exactly — marker, `code`,
  // `correlation_id` first — because that ordering is the truncation contract:
  // Codex may cut this body short inside `unexpected status <code>: <body>`,
  // and the actionable fields have to survive. A fixture in a different order
  // would leave that guarantee exercised only by unit tests.
  const body = JSON.stringify({
    error: {
      canopy_proxy: 'CANOPY_AI_CREDITS_PROXY',
      code,
      correlation_id: CORRELATION_ID,
      message: 'AI Credits proxy could not reach the gateway.',
      attempts: 4,
      elapsed_ms: 3120,
    },
  });
  return `unexpected status ${status}: ${body}`;
}

test('renders the AI Credits proxy failure as a clean notice with its error id', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-proxy-error-notice-'),
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
        title: 'Proxy Error Notice',
        messages: [
          {
            id: 'proxy-retry-user-1',
            role: 'user',
            blocks: [{ type: 'text', text: ORIGINAL_PROMPT }],
            timestamp: Date.parse('2026-08-20T00:00:00.000Z'),
          },
          {
            id: 'proxy-retry-assistant-1',
            role: 'assistant',
            blocks: [
              { type: 'text', text: 'Partial work before the proxy failure' },
            ],
            timestamp: Date.parse('2026-08-20T00:00:01.000Z'),
          },
        ],
      },
    ],
  });

  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);

    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    await expect(window.getByTestId('panel-content-chat')).toBeVisible();

    await injectChatEvent(electronApp, {
      projectId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      chatId: CHAT_ID,
      data: {
        type: 'codex',
        event: {
          type: 'turn.failed',
          error: { message: proxyErrorMessage('upstream_unavailable') },
        },
      },
    });

    const notices = window.getByTestId('chat-canopy-proxy-error');
    await expect(notices).toHaveCount(1);
    const notice = notices.first();
    await expect(
      window.getByTestId('chat-canopy-proxy-error-title'),
    ).toContainText("The AI provider didn't respond");

    // The correlation id is the only diagnostic detail that reaches the user.
    await expect(
      window.getByTestId('chat-canopy-proxy-error-correlation-id'),
    ).toHaveText(CORRELATION_ID);

    // None of the internal vocabulary leaks into the notice itself.
    await expect(notice).not.toContainText('502');
    await expect(notice).not.toContainText('gateway');
    await expect(notice).not.toContainText('proxy');

    // The raw structured body must not survive anywhere in the chat surface,
    // not merely inside the notice we replaced it with.
    const panel = window.getByTestId('panel-content-chat');
    await expect(panel).not.toContainText('CANOPY_AI_CREDITS_PROXY');
    await expect(panel).not.toContainText('elapsed_ms');

    // Retry must not replay the original prompt when the agent already did
    // work in this turn: the seeded transcript has assistant output after the
    // user message, so the shared resume helper resolves to `Continue` rather
    // than re-sending — otherwise a retry would repeat completed tool work.
    const retry = window.getByTestId('chat-canopy-proxy-error-retry');
    await expect(retry).toBeVisible();
    await retry.click();
    await expect(
      panel.getByText('Continue', { exact: true }).first(),
    ).toBeVisible();
    await expect(panel.getByText(ORIGINAL_PROMPT, { exact: true })).toHaveCount(
      1,
    );

    // Retry dispatches a BILLED, non-idempotent turn. Once that turn is in
    // flight the button must gate itself on the tab no longer being idle —
    // `sendMessage` has no streaming guard of its own, and this notice stays in
    // the transcript with a live button, so without the gate a second click
    // (or a click landing while the auto-retry service is mid-turn) sends
    // twice and bills twice.
    await expect(retry).toBeDisabled();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('renders a session spending ceiling notice without retry or billing actions', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-proxy-error-session-budget-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'codex',
    tabs: [{ id: CHAT_ID, title: 'Session Budget Exhausted' }],
  });

  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);

    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    await expect(window.getByTestId('panel-content-chat')).toBeVisible();

    await injectChatEvent(electronApp, {
      projectId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      chatId: CHAT_ID,
      data: {
        type: 'codex',
        event: {
          type: 'turn.failed',
          error: {
            message: proxyErrorMessage(
              'session_budget_exhausted',
              '402 Payment Required',
            ),
          },
        },
      },
    });

    const notice = window.getByTestId('chat-canopy-proxy-error');
    await expect(notice).toBeVisible();
    await expect(
      window.getByTestId('chat-canopy-proxy-error-title'),
    ).toHaveText('This session hit its AI Credits spending ceiling');
    await expect(window.getByTestId('chat-canopy-proxy-error-body')).toHaveText(
      'This Canopy session has used its AI Credits spending limit. Start a new session to continue.',
    );
    await expect(
      window.getByTestId('chat-canopy-proxy-error-correlation-id'),
    ).toHaveText(CORRELATION_ID);

    const copyId = window.getByTestId('chat-canopy-proxy-error-copy-id');
    await expect(copyId).toHaveText('Copy id');
    await copyId.click();
    await expect(copyId).toHaveText('Copied');
    await expect(async () => {
      const copiedId = await electronApp.evaluate(({ clipboard }) =>
        clipboard.readText(),
      );
      expect(copiedId).toBe(CORRELATION_ID);
    }).toPass();

    await expect(
      window.getByTestId('chat-canopy-proxy-error-retry'),
    ).toHaveCount(0);
    await expect(
      window.getByTestId('chat-canopy-proxy-error-get-credits'),
    ).toHaveCount(0);
    await expect(
      window.getByTestId('chat-canopy-proxy-error-contact-admin'),
    ).toHaveCount(0);
    await expect(
      window.getByTestId('chat-canopy-proxy-error-recheck-credits'),
    ).toHaveCount(0);
    await expect(
      window.getByTestId('chat-canopy-proxy-error-credits-recovered'),
    ).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

/**
 * CAN-3462: the hosted proxy refuses work claimed by an organization the user
 * has left. Codex surfaces the marked 403 as `turn.failed`; the notice names
 * the lost membership and offers only the error id, because retrying hits the
 * same refusal and neither Settings nor billing can restore a membership.
 */
test('renders an organization owner refusal with only the copy-id action', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-proxy-error-work-owner-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'codex',
    tabs: [{ id: CHAT_ID, title: 'Work Owner Refused' }],
  });

  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);

    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    await expect(window.getByTestId('panel-content-chat')).toBeVisible();

    await injectChatEvent(electronApp, {
      projectId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      chatId: CHAT_ID,
      data: {
        type: 'codex',
        event: {
          type: 'turn.failed',
          error: {
            message: proxyErrorMessage(
              'work_owner_not_member',
              '403 Forbidden',
            ),
          },
        },
      },
    });

    const notice = window.getByTestId('chat-canopy-proxy-error');
    await expect(notice).toBeVisible();
    await expect(
      window.getByTestId('chat-canopy-proxy-error-title'),
    ).toHaveText("You're no longer in this organization");
    await expect(
      window.getByTestId('chat-canopy-proxy-error-body'),
    ).toContainText("an organization you've left");
    await expect(
      window.getByTestId('chat-canopy-proxy-error-correlation-id'),
    ).toHaveText(CORRELATION_ID);
    await expect(notice).not.toContainText('CANOPY_AI_CREDITS_PROXY');
    await expect(notice).not.toContainText('work_owner_not_member');
    await expect(notice).not.toContainText('403');

    const copyId = window.getByTestId('chat-canopy-proxy-error-copy-id');
    await expect(copyId).toHaveText('Copy id');
    await copyId.click();
    await expect(copyId).toHaveText('Copied');

    for (const testId of [
      'chat-canopy-proxy-error-retry',
      'chat-canopy-proxy-error-open-settings',
      'chat-canopy-proxy-error-get-credits',
      'chat-canopy-proxy-error-recheck-credits',
    ]) {
      await expect(window.getByTestId(testId)).toHaveCount(0);
    }
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

/**
 * CAN-3026 review: the guest model allowlist's 403 must render as a notice with
 * a sign-in route, not as a raw provider error.
 *
 * This is the failure a guest ALREADY pinned to a disallowed credit-routed
 * model hits on every turn. There is no desktop pre-turn gate for the allowlist
 * (the picker row gate deliberately skips the current model, and nothing
 * repairs a persisted selection), so this response is the user's first and only
 * signal. Before the fix the body was unmarked, `parseCanopyProxyError`
 * returned null, and the transcript showed the raw upstream 403 with no way
 * back to the sign-in gate the same ticket built — a gate that was a dead end.
 */
test('renders the guest model refusal as a notice with a sign-in route', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-proxy-error-guest-model-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'codex',
    tabs: [{ id: CHAT_ID, title: 'Guest Model Not Allowed' }],
  });

  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);

    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    await expect(window.getByTestId('panel-content-chat')).toBeVisible();

    await injectChatEvent(electronApp, {
      projectId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      chatId: CHAT_ID,
      data: {
        type: 'codex',
        event: {
          type: 'turn.failed',
          error: {
            message: proxyErrorMessage(
              'guest_model_not_allowed',
              '403 Forbidden',
            ),
          },
        },
      },
    });

    const notice = window.getByTestId('chat-canopy-proxy-error');
    await expect(notice).toBeVisible();
    await expect(
      window.getByTestId('chat-canopy-proxy-error-title'),
    ).toHaveText('Sign in to Canopy Cloud');
    await expect(window.getByTestId('chat-canopy-proxy-error-body')).toHaveText(
      'This chat is set to a model that needs an account. Your guest work comes with you, nothing is lost.',
    );
    await expect(
      window.getByTestId('chat-canopy-proxy-error-correlation-id'),
    ).toHaveText(CORRELATION_ID);

    // The recovery route: Open Settings lands on the cloud account section,
    // which is where a guest actually signs in.
    const openSettings = window.getByTestId(
      'chat-canopy-proxy-error-open-settings',
    );
    await expect(openSettings).toBeVisible();

    // Retry is wrong here and must not be offered: the same model would be
    // sent and hit the same wall.
    await expect(
      window.getByTestId('chat-canopy-proxy-error-retry'),
    ).toHaveCount(0);
    // Nor is this a balance problem — the guest's credits are irrelevant.
    await expect(
      window.getByTestId('chat-canopy-proxy-error-get-credits'),
    ).toHaveCount(0);

    // The raw structured body must not survive anywhere in the chat surface.
    const panel = window.getByTestId('panel-content-chat');
    await expect(panel).not.toContainText('CANOPY_AI_CREDITS_PROXY');
    await expect(panel).not.toContainText('guest_model_not_allowed');
    await expect(notice).not.toContainText('403');

    await openSettings.click();
    await expect(window.getByTestId('settings-overlay')).toBeVisible();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

/**
 * CAN-2413: the reported bug. A mid-turn `402 no_billing_source` used to carry
 * neither the marker nor a classifier-recognized status, so the transcript
 * showed `{"error":"no_billing_source"}` plus a 127.0.0.1 gateway URL and
 * offered the user nothing to click. This is the whole point of the fix, so it
 * gets the walk-the-real-flow coverage rather than only a unit assertion.
 */
test('reloads a spent gateway-only credit balance as a stop line plus the composer banner', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-proxy-error-no-billing-'),
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
        title: 'No Billing Source',
        model: GATEWAY_ONLY_MODEL,
        // The persisted transcript is the reload path this regression must
        // cover. The companion metadata is what the transcript reducer writes
        // during the live turn; ChatInput replays it into the target-keyed
        // banner store after hydration.
        aiCreditsNoBillingSource: {
          provider: 'codex',
          detectedAt: Date.parse('2026-08-20T00:00:02.000Z'),
        },
        messages: [
          {
            id: 'no-billing-user-1',
            role: 'user',
            blocks: [{ type: 'text', text: 'Use the gateway-only model.' }],
            timestamp: Date.parse('2026-08-20T00:00:00.000Z'),
          },
          {
            id: 'no-billing-system-1',
            role: 'system',
            blocks: [
              {
                type: 'text',
                text: proxyErrorMessage(
                  'no_billing_source',
                  '402 Payment Required',
                ),
              },
            ],
            timestamp: Date.parse('2026-08-20T00:00:02.000Z'),
          },
        ],
      },
    ],
  });

  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);

    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    await expect(window.getByTestId('panel-content-chat')).toBeVisible();
    // The main process re-broadcasts its own `model-registry:updated`
    // snapshots asynchronously after startup (AI gateway catalog hydration,
    // feature-flag snapshot refreshes — see `main/index.ts`), and each one
    // replaces the renderer's registry wholesale. Under CI load a late
    // broadcast lands AFTER a one-shot injection, the seeded gateway-only
    // model stops resolving, and the composer banner below never mounts
    // (hard 3/3 failure in Internal Release run 32453800995). Re-inject
    // until the banner that depends on the injected route is actually up.
    const banner = window.getByTestId('chat-input-no-billing-source-banner');
    await expect(async () => {
      await injectGatewayOnlyModelRegistry(electronApp);
      await expect(banner).toBeVisible({ timeout: 3_000 });
    }).toPass({ timeout: 30_000 });

    // CAN-5160: the transcript only says why the chat stopped. The banner is
    // the one place to choose how to pay, so no panel, CTA, or Retry here.
    await expect(window.getByTestId('chat-ai-credits-stop-line')).toHaveText(
      'Chat stopped. Choose how to pay for this message to keep going.',
    );
    await expect(window.getByTestId('chat-canopy-proxy-error')).toHaveCount(0);

    // The persisted per-tab signal must also rehydrate the composer recovery
    // banner. DeepSeek V4 Pro is gateway-only, so a native Codex sign-in is not
    // a remedy and must not be offered; adding credits is the only useful CTA.
    await expect(banner).toBeVisible();
    // This fresh secure data dir seeds no model policy, so the banner must not
    // invent an organization (CAN-2436): a no-policy dispatch dead end keeps
    // the ECW-9091 sentence, and the CTAs below name the remedy.
    await expect(banner).toContainText(
      'No available model can be paid for right now.',
    );
    await expect(
      window.getByTestId('chat-input-no-billing-source-get-credits'),
    ).toBeVisible();
    await expect(
      window.getByTestId('chat-input-no-billing-source-sign-in'),
    ).toHaveCount(0);

    // The raw body the user actually reported seeing must be gone entirely.
    const panel = window.getByTestId('panel-content-chat');
    await expect(panel).not.toContainText('unexpected status 402');
    await expect(panel).not.toContainText('no_billing_source');
    await expect(panel).not.toContainText('CANOPY_AI_CREDITS_PROXY');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

/**
 * CAN-3732: a Claude chat routed through AI Credits hit the hosted
 * `no_billing_source` 402, but the Claude harness kept only
 * `API Error: 402 AI Credits are unavailable for this request.` Main now
 * restores the marked body (without a correlation id, since none survived) and
 * stamps its verdict before publishing. These events are injected in that
 * already-normalized shape through the canonical chat-event ingress: the
 * routing gate and restoration are covered by `claude-session.test.ts`, and
 * this flow covers how the renderer presents the result.
 */
const CLAUDE_CHAT_ID = 'claude-no-billing-source-chat';
const CLAUDE_TURN_USER_MESSAGE_ID = 'claude-no-billing-user-1';
const CLAUDE_RAW_402 =
  'API Error: 402 AI Credits are unavailable for this request.';
const RESTORED_CLAUDE_NO_BILLING_BODY = JSON.stringify({
  error: {
    canopy_proxy: 'CANOPY_AI_CREDITS_PROXY',
    code: 'no_billing_source',
    message: 'AI Credits are unavailable for this request.',
  },
});

function seedClaudeNoBillingChat(userDataDir, { persistedFailure }) {
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    tabs: [
      {
        id: CLAUDE_CHAT_ID,
        title: 'Claude No Billing Source',
        // The reported chat was routed through AI Credits; the composer banner
        // is scoped to chats still on that route.
        aiCreditsRouting: {
          active: true,
          scope: 'persistent',
          activatedAt: Date.parse('2026-10-06T11:49:00.000Z'),
        },
        ...(persistedFailure
          ? {
              aiCreditsNoBillingSource: {
                provider: 'claude',
                detectedAt: Date.parse('2026-10-06T11:50:03.000Z'),
              },
            }
          : {}),
        messages: [
          {
            id: CLAUDE_TURN_USER_MESSAGE_ID,
            role: 'user',
            blocks: [
              { type: 'text', text: 'Summarize the open pull requests.' },
            ],
            timestamp: Date.parse('2026-10-06T11:50:00.000Z'),
          },
          ...(persistedFailure
            ? [
                {
                  id: 'claude-no-billing-system-1',
                  role: 'system',
                  blocks: [
                    { type: 'text', text: RESTORED_CLAUDE_NO_BILLING_BODY },
                  ],
                  timestamp: Date.parse('2026-10-06T11:50:03.000Z'),
                },
              ]
            : []),
        ],
      },
    ],
  });
}

/**
 * A developer's real Claude login (keychain-backed, so HOME isolation is not
 * enough) would lock this chat to subscription billing, which correctly
 * suppresses the runtime banner. Pin provider auth to the mock control plane's
 * unauthenticated scenario so the result does not depend on the host.
 */
async function launchUnauthenticatedClaude(userDataDir) {
  const authKey = `claude-no-billing-${path.basename(userDataDir)}`;
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
  return { electronApp, authKey };
}

/**
 * Make AI Credits eligible, so the composer's pre-flight "nothing can pay"
 * condition is false and the only billing state left is the refusal's runtime
 * signal rather than the unauthenticated provider alone.
 */
async function makeAiCreditsEligible(window) {
  const saveResult = await window.evaluate(
    async (apiKey) => window.api.saveCanopyCloudApiKey({ apiKey }),
    'csk_claude_no_billing_source_e2e',
  );
  expect(saveResult.status.authenticated).toBe(true);
  await window.evaluate(() => {
    window.dispatchEvent(new Event('canopy:cloud-account-changed'));
  });
}

async function expectClaudeNoBillingRecovery(window) {
  // CAN-5160: one plain stop line in the transcript, and no second panel
  // offering the purchase the composer banner already offers.
  await expect(window.getByTestId('chat-ai-credits-stop-line')).toHaveCount(1);
  await expect(window.getByTestId('chat-canopy-proxy-error')).toHaveCount(0);

  // The refusal's runtime signal raises the composer banner, but its coverage
  // read, which the mock reports as covered, stands it down (CAN-5348): AI
  // Credits are eligible, so the AI Credits card reports the balance and the
  // stop line above is the whole recovery. Check again after the read has had
  // time to settle, so a banner that stays up cannot pass on an early frame.
  const banner = window.getByTestId('chat-input-no-billing-source-banner');
  await expect(banner).toHaveCount(0);
  await window.waitForTimeout(2_000);
  await expect(banner).toHaveCount(0);

  const panel = window.getByTestId('panel-content-chat');
  await expect(panel).not.toContainText('API Error: 402');
  await expect(panel).not.toContainText('CANOPY_AI_CREDITS_PROXY');
  await expect(panel).not.toContainText('no_billing_source');
}

test('shows the AI Credits recovery for a normalized Claude 402 refusal', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-proxy-error-claude-live-'),
  );
  seedClaudeNoBillingChat(userDataDir, { persistedFailure: false });

  const { electronApp, authKey } =
    await launchUnauthenticatedClaude(userDataDir);

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);

    await app.waitForShell({ timeout: 30_000 });
    await makeAiCreditsEligible(window);
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    await expect(window.getByTestId('panel-content-chat')).toBeVisible();

    // Before the refusal nothing is wrong with billing, so the composer
    // banner must be absent. Give the availability probe time to settle, so
    // this absence is not just an unresolved first render.
    await expect(window.getByTestId('chat-model-picker')).toBeVisible({
      timeout: 30_000,
    });
    await window.waitForTimeout(2_000);
    await expect(
      window.getByTestId('chat-input-no-billing-source-banner'),
    ).toHaveCount(0);

    const target = {
      projectId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      chatId: CLAUDE_CHAT_ID,
    };
    // The harness's synthetic assistant error frame, then the terminal
    // result: both carry the restored body and main's stamp, and together they
    // must produce one stop line.
    await injectChatEvent(electronApp, {
      ...target,
      data: {
        type: 'assistant',
        error: 'unknown',
        canopy_turn_user_message_id: CLAUDE_TURN_USER_MESSAGE_ID,
        canopy_ai_credits_no_billing_source: true,
        message: {
          id: 'claude-no-billing-error-frame',
          role: 'assistant',
          model: '<synthetic>',
          content: [{ type: 'text', text: RESTORED_CLAUDE_NO_BILLING_BODY }],
        },
      },
    });
    await injectChatEvent(electronApp, {
      ...target,
      data: {
        type: 'result',
        subtype: 'success',
        is_error: true,
        api_error_status: 402,
        canopy_turn_user_message_id: CLAUDE_TURN_USER_MESSAGE_ID,
        canopy_ai_credits_no_billing_source: true,
        result: RESTORED_CLAUDE_NO_BILLING_BODY,
      },
    });

    await expectClaudeNoBillingRecovery(window);
    // A next prompt can be queued before the harness repeats the old result.
    // Turn metadata must prevent a second stop line or stale recovery state.
    await injectChatEvent(electronApp, {
      ...target,
      data: {
        type: 'canopy_user_prompt',
        provider: 'claude',
        user_message_id: 'claude-next-turn',
        original_text: 'Try the next turn.',
      },
    });
    await expect(window.getByTestId('panel-content-chat')).toContainText(
      'Try the next turn.',
    );
    await injectChatEvent(electronApp, {
      ...target,
      data: {
        type: 'result',
        subtype: 'success',
        is_error: true,
        canopy_turn_user_message_id: CLAUDE_TURN_USER_MESSAGE_ID,
        canopy_ai_credits_no_billing_source: true,
        result: RESTORED_CLAUDE_NO_BILLING_BODY,
      },
    });
    await expect(window.getByTestId('chat-ai-credits-stop-line')).toHaveCount(
      1,
    );
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, authKey).catch(() => undefined);
  }
});

test('reloads a persisted Claude AI Credits refusal as a stop line once credits cover the chat', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-proxy-error-claude-reload-'),
  );
  seedClaudeNoBillingChat(userDataDir, { persistedFailure: true });

  const { electronApp, authKey } =
    await launchUnauthenticatedClaude(userDataDir);

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);

    await app.waitForShell({ timeout: 30_000 });
    await makeAiCreditsEligible(window);
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    await expect(window.getByTestId('panel-content-chat')).toBeVisible();

    await expectClaudeNoBillingRecovery(window);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, authKey).catch(() => undefined);
  }
});

test('normalizes a Claude harness 402 from the mock provider and persists recovery', async () => {
  test.setTimeout(180_000);
  const marker = 'Canopy-CCLAUDE-CREDITS-402';
  await registerScenario(DEFAULT_MOCK_BASE_URL, marker, {
    llm: {
      steps: [
        {
          error: {
            status: 402,
            message: 'AI Credits are unavailable for this request.',
          },
        },
      ],
    },
  });
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-proxy-error-claude-harness-'),
  );
  seedClaudeNoBillingChat(userDataDir, { persistedFailure: false });
  const { electronApp, authKey } = await withBundledBinaryOverridesScrubbed(
    () => launchUnauthenticatedClaude(userDataDir),
  );
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await makeAiCreditsEligible(window);
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    await expect(window.getByTestId('chat-model-picker')).toBeVisible();
    // A persisted provider alone does not pin the model resolved by the
    // composer. Select Claude explicitly so this exercises its real harness.
    await window.getByTestId('chat-model-picker').click();
    await window.getByTestId('chat-model-harness-tab-claude').click();
    await window
      .locator('[data-testid="chat-model-option-sonnet"]:visible')
      .click();
    await window.waitForTimeout(2_000);
    await expect(
      window.getByTestId('chat-input-no-billing-source-banner'),
    ).toHaveCount(0);
    await window.getByRole('textbox').first().fill(`[${marker}] Say hello.`);
    await window.getByRole('button', { name: 'Send message' }).click();
    await expect
      .poll(
        async () =>
          (await getScenarioActivity(DEFAULT_MOCK_BASE_URL, marker)).activity[
            'llmProxy:anthropic'
          ] ?? 0,
        { timeout: 90_000 },
      )
      .toBeGreaterThan(0);
    await expect(window.getByTestId('chat-ai-credits-stop-line')).toBeVisible({
      timeout: 90_000,
    });
    await expectClaudeNoBillingRecovery(window);
    const readTab = () =>
      readChatStorageTabs(
        path.join(userDataDir, 'workspaces', WORKSPACE_ID),
        WORKTREE_ID,
      ).tabs.find((tab) => tab.id === CLAUDE_CHAT_ID);
    await expect
      .poll(() => readTab()?.aiCreditsNoBillingSource)
      .toMatchObject({
        provider: 'claude',
      });
    const persistedMessages = JSON.stringify(readTab()?.messages);
    expect(persistedMessages).toContain('CANOPY_AI_CREDITS_PROXY');
    expect(persistedMessages).not.toContain('API Error: 402');
    await window.reload();
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    await expect(window.getByTestId('panel-content-chat')).toBeVisible();
    await expectClaudeNoBillingRecovery(window);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await clearScenario(DEFAULT_MOCK_BASE_URL, authKey).catch(() => undefined);
    await clearScenario(DEFAULT_MOCK_BASE_URL, marker).catch(() => undefined);
  }
});

test('leaves a raw Claude 402 without main normalization as plain text', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-proxy-error-claude-raw-'),
  );
  seedClaudeNoBillingChat(userDataDir, { persistedFailure: false });

  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);

    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    await expect(window.getByTestId('panel-content-chat')).toBeVisible();

    // Bare 402 wording is not proxy evidence at the shared boundary; only
    // main's routing-gated normalization may turn it into the notice.
    await injectChatEvent(electronApp, {
      projectId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      chatId: CLAUDE_CHAT_ID,
      data: {
        type: 'assistant',
        error: 'unknown',
        canopy_turn_user_message_id: CLAUDE_TURN_USER_MESSAGE_ID,
        message: {
          id: 'claude-raw-402-frame',
          role: 'assistant',
          model: '<synthetic>',
          content: [{ type: 'text', text: CLAUDE_RAW_402 }],
        },
      },
    });

    await expect(window.getByTestId('panel-content-chat')).toContainText(
      CLAUDE_RAW_402,
    );
    await expect(window.getByTestId('chat-canopy-proxy-error')).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('an upstream failure without the proxy marker keeps the plain error text', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-proxy-error-passthrough-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'codex',
    tabs: [{ id: CHAT_ID, title: 'Proxy Error Passthrough' }],
  });

  const { electronApp } = await launchCanopy({ userDataDir });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);

    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    await expect(window.getByTestId('panel-content-chat')).toBeVisible();

    await injectChatEvent(electronApp, {
      projectId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      chatId: CHAT_ID,
      data: {
        type: 'codex',
        event: {
          type: 'turn.failed',
          error: {
            message: 'unexpected status 503: upstream temporarily unavailable',
          },
        },
      },
    });

    await expect(window.getByTestId('panel-content-chat')).toContainText(
      'upstream temporarily unavailable',
    );
    await expect(window.getByTestId('chat-canopy-proxy-error')).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
