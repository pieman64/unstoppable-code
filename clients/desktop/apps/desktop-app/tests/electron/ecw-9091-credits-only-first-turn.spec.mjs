import { selectModelOption } from './model-selection-fixture.mjs';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import {
  clearScenario,
  DEFAULT_MOCK_BASE_URL,
  getScenarioActivity,
  registerScenario,
  seedWorktreeChat,
} from './seeders/index.mjs';
import { withBundledBinaryOverridesScrubbed } from './seeders/bundledBinaryOverrides.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  closeModelPicker,
  offeredBillingMenus,
  openModelPicker,
} from './modelPickerBilling.mjs';

// ECW-9091 — credits-only users hit "Not logged in · Please run /login".
//
// ── Why this spec has to drive a real turn ──────────────────────────────────
// A UI-only spec CANNOT detect this bug. On the broken build the model picker
// already locks the billing toggle ON and the "You're not signed in to Claude,
// so this chat bills to your AI Credits" copy is already rendered — the display
// resolver and the spawn path simply disagreed. The only observable that
// separates fixed from broken is what the spawn actually does, so case 1
// completes a real routed turn and asserts the mock served it on the AI Credits
// gateway path rather than the native provider path.
//
// ── How the routed turn reaches the mock ────────────────────────────────────
//   - Each routed-turn launch points the build-gated
//     `CANOPY_E2E_CLOUD_BASE_URL` override at `DEFAULT_MOCK_BASE_URL`, so custom
//     mock-server ports exercise the same gateway route as the default port.
//   - With credits routing active, `claude-session.ts` sets
//     `ANTHROPIC_BASE_URL=<cloudBaseUrl>/api/v1/llm-proxy/anthropic`, and that
//     env deliberately WINS over the E2E native-redirect `envOverride`. So a
//     routed turn arrives on `/api/v1/llm-proxy/anthropic/v1/messages` while a
//     native turn arrives on `/v1/messages` — the two are distinguishable.
//   - The guest case takes the Codex leg of the same mechanism (CAN-3026 bars
//     a guest from Claude): `OPENAI_BASE_URL` points at
//     `<cloudBaseUrl>/api/v1/llm-proxy/openai/responses`, the app-server
//     appends its own `/responses`, and the turn is tagged `llmProxy:openai`.
//   - `mock-server/routes/llm.mjs` normalizes that prefix (ECW-9091) and records
//     an `llmProxy:anthropic` scenario-activity counter, which is the assertion
//     that proves the gateway carried the turn.
//
// ── Deterministic provider/account state ────────────────────────────────────
//   - Signed-out providers: a per-test `authUsage: { scenario: 'unauthenticated' }`
//     scenario registered under this spec's own `CANOPY_MOCK_API_KEY` (the auth
//     probes key off that bearer), so no worker shares the default `mock` key.
//   - Credits: `saveCanopyCloudApiKey` with any `csk_`-prefixed key authenticates
//     against the cloud mock, which serves an eligible AI Credits balance.
//   Case 2 simply omits the cloud sign-in, which is the "nothing can pay for
//   this turn" state.
//
// Run:
//   pnpm run build:e2e
//   pnpm exec playwright test ecw-9091-credits-only-first-turn.spec.mjs --reporter=line

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const WORKTREE_BRANCH = 'demo-main';
const CHAT_ID = 'ecw-9091-chat';
// The shipped default model, and the one the bug reporter was on. It is
// gateway-routable, so the credits path can actually cover it.
const DEFAULT_MODEL = 'opus[1m]';

const CONVERSATION_MARKER = 'Canopy-CECW9091';
// No trailing punctuation: assistant text streams into a markdown <span> and a
// trailing '.' is not reliably part of the same matched text node.
const ASSISTANT_REPLY = 'Routed through the AI Credits gateway';

const CLOUD_API_KEY = 'csk_ecw_9091_e2e';
const CLOUD_ACCOUNT_CHANGED_EVENT = 'canopy:cloud-account-changed';

// The raw provider error this ticket exists to eliminate.
const RAW_LOGIN_ERROR = 'Please run /login';

function seedTree(userDataDir) {
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    tabs: [{ id: CHAT_ID, title: 'Credits only', model: DEFAULT_MODEL }],
  });
}

test.describe('ECW-9091 credits-only first turn', () => {
  // CAN-3026 later closed the guest allowlist to two cheap models, so the
  // guest half of ECW-9091 can no longer be a *Claude* turn: a guest may not
  // run Sonnet anywhere Canopy pays. The regression this case exists to catch
  // — the display resolver and the spawn path disagreeing about who is paying
  // — is lane-agnostic, so it now runs on the allowlisted Codex model and
  // asserts the OpenAI gateway leg instead. The Claude leg stays covered by
  // the signed-in credits-only case below.
  test('a brand-new guest routes its first turn through the free AI Credits gateway', async ({}, testInfo) => {
    test.setTimeout(180_000);
    const authKey = 'ecw-9091-brand-new-guest-unauthenticated';
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-ecw-9091-guest-cowork-routed-'),
    );

    await registerScenario(DEFAULT_MOCK_BASE_URL, authKey, {
      authUsage: { scenario: 'unauthenticated' },
    });
    await registerScenario(DEFAULT_MOCK_BASE_URL, CONVERSATION_MARKER, {
      llm: { steps: [{ text: ASSISTANT_REPLY, stopReason: 'end_turn' }] },
    });

    const { electronApp } = await withBundledBinaryOverridesScrubbed(() =>
      launchCanopy({
        userDataDir,
        env: {
          HOME: userDataDir,
          CANOPY_MOCK_API_KEY: authKey,
          CANOPY_E2E_CLOUD_BASE_URL: DEFAULT_MOCK_BASE_URL,
          CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
            'canopy-guest-mode-enabled': true,
          }),
        },
      }),
    );

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });

      const guestAccount = await window.evaluate(() =>
        window.api.loadCanopyCloudAccount(),
      );
      expect(guestAccount.credentialSource).toBe('guest');
      expect(guestAccount.capabilities).toContain('llm-proxy-v1');

      // Match the reported first-run flow exactly: open the auto-provisioned
      // Default Cowork workspace, dismiss its cold-start state, and send from
      // the new standalone chat without connecting a repository.
      await app.openChatPage();
      const emptyNewChat = window.getByTestId('empty-new-chat');
      await expect(emptyNewChat).toBeVisible({ timeout: 15_000 });
      await emptyNewChat.click();

      const panel = window.getByTestId('panel-content-chat');
      await expect(panel).toBeVisible({ timeout: 15_000 });
      await expect(
        window.getByTestId('chat-input-no-billing-source-banner'),
      ).toHaveCount(0);

      // Make the first-turn path deterministic. Guest defaults are lane-aware
      // and may prefer either provider, so pin the model rather than trusting
      // whatever the lane resolved to.
      //
      // The pin must be a model CAN-3026's guest allowlist admits. This used
      // to pin `gpt-5.6-sol`, which that gate deliberately refuses to a guest:
      // the row resolves to `needs-account`, so the click opens the sign-in
      // recovery modal instead of committing and the picker keeps its previous
      // model. That is what made this spec red — not any routing change. The
      // refusal UX itself is covered by `can-3026-guest-model-gate.spec.mjs`.
      const modelPicker = panel.getByTestId('chat-model-picker');
      await modelPicker.click();
      await selectModelOption(window, 'gpt-6-luna');
      await expect(modelPicker).toContainText('GPT 6 Luna');

      const composer = window.getByRole('textbox').first();
      // CAN-4921: real no-project guest turns with controlled wallet reads.
      // The mock provider completes the turn; changing the mock cloud balance
      // alone never sends an invalidation, so the host must refresh it.
      for (const [turn, credits] of [
        [1, 9.25],
        [2, 0],
      ]) {
        await registerScenario(DEFAULT_MOCK_BASE_URL, 'csk_guest_e2e', {
          cloud: { aiCreditsBalance: { credits, eligible: true } },
        });
        await composer.fill(
          `[${CONVERSATION_MARKER}] Say hello as a guest, turn ${turn}.`,
        );
        await window.getByRole('button', { name: 'Send message' }).click();
        await expect(panel.getByText(ASSISTANT_REPLY).first()).toBeVisible({
          timeout: 120_000,
        });
        const meter = panel
          .getByTestId('usage-indicator')
          .filter({ visible: true });
        await expect(meter).toHaveAccessibleName(
          `Usage indicator, ${credits} AI Credits`,
          { timeout: 30_000 },
        );
        await expect(
          meter.getByTestId('usage-indicator-credit-balance'),
        ).toHaveText(`${credits} AI Credits`);
        await meter.press('Enter');
        const account = window.getByTestId('usage-indicator-account');
        await expect(account).toContainText('AI Credits');
        await expect(
          account.getByTestId('usage-indicator-account-credit-balance'),
        ).toHaveText(String(credits));
        await expect(account).not.toContainText('left');
        await window.keyboard.press('Escape');
      }
      expect(await panel.innerText()).not.toContain(RAW_LOGIN_ERROR);
      await expect
        .poll(
          async () =>
            (
              await getScenarioActivity(
                DEFAULT_MOCK_BASE_URL,
                CONVERSATION_MARKER,
              )
            ).activity?.['llmProxy:openai'] ?? 0,
          { timeout: 30_000 },
        )
        .toBeGreaterThanOrEqual(1);

      await window.screenshot({
        path: testInfo.outputPath('ecw-9091-guest-credits-routed-turn.png'),
      });
    } finally {
      await closeCanopy(electronApp, userDataDir);
      await clearScenario(DEFAULT_MOCK_BASE_URL, 'csk_guest_e2e').catch(
        () => undefined,
      );
      await clearScenario(DEFAULT_MOCK_BASE_URL, authKey).catch(
        () => undefined,
      );
      await clearScenario(DEFAULT_MOCK_BASE_URL, CONVERSATION_MARKER).catch(
        () => undefined,
      );
    }
  });

  for (const autoChat of [false, true]) {
    test(`a credits-only account routes ${autoChat ? 'an AUTO chat without DeepSeek' : 'the Claude default'} through the AI Credits gateway`, async ({}, testInfo) => {
      test.setTimeout(180_000);
      const conversationMarker = `${CONVERSATION_MARKER}-${autoChat ? 'auto' : 'claude'}`;
      const authKey = 'ecw-9091-credits-only-unauthenticated';
      const userDataDir = mkdtempSync(
        path.join(os.tmpdir(), 'canopy-ecw-9091-routed-'),
      );
      if (autoChat) {
        seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
      } else {
        seedTree(userDataDir);
      }

      // Both providers signed out, registered BEFORE launch so the startup auth
      // probes resolve the seeded scenario.
      await registerScenario(DEFAULT_MOCK_BASE_URL, authKey, {
        authUsage: { scenario: 'unauthenticated' },
      });
      // The scripted reply for the marker embedded in the user message.
      await registerScenario(DEFAULT_MOCK_BASE_URL, conversationMarker, {
        llm: { steps: [{ text: ASSISTANT_REPLY, stopReason: 'end_turn' }] },
      });

      const { electronApp } = await withBundledBinaryOverridesScrubbed(() =>
        launchCanopy({
          userDataDir,
          env: {
            CANOPY_MOCK_API_KEY: authKey,
            CANOPY_E2E_CLOUD_BASE_URL: DEFAULT_MOCK_BASE_URL,
          },
        }),
      );

      try {
        const window = await electronApp.firstWindow();
        const app = new CanopyAppDriver(window);
        await app.waitForShell({ timeout: 30_000 });

        // Connect a credits-eligible cloud account: this is the "has credits, has
        // no Claude login" state the ticket is about.
        const saveResult = await window.evaluate(
          async (apiKey) => window.api.saveCanopyCloudApiKey({ apiKey }),
          CLOUD_API_KEY,
        );
        expect(saveResult.status.authenticated).toBe(true);
        await window.evaluate((eventName) => {
          window.dispatchEvent(new Event(eventName));
        }, CLOUD_ACCOUNT_CHANGED_EVENT);

        if (autoChat) {
          await app.openChatPage();
          const emptyNewChat = window.getByTestId('empty-new-chat');
          await expect(emptyNewChat).toBeVisible({ timeout: 15_000 });
          await emptyNewChat.click();
        } else {
          await app.openMainPage();
          await app.selectWorktree(WORKTREE_BRANCH);
        }

        const panel = window.getByTestId('panel-content-chat');
        await expect(panel).toBeVisible();
        if (autoChat) {
          await expect(panel.getByTestId('chat-model-picker')).toContainText(
            'GPT 6 Luna',
          );
        }

        // The no-billing-source banner must NOT appear: credits can pay.
        await expect(
          window.getByTestId('chat-input-no-billing-source-banner'),
        ).toHaveCount(0);

        // CAN-5349: Claude's probe confirms sign-out and credits can pay, so
        // the card has no subscription switch and the picker offers none.
        const expectLockedToCredits = async () => {
          const card = window.getByTestId('chat-input-ai-credits-active');
          await expect(card).toBeVisible({ timeout: 15_000 });
          await expect(
            card.getByTestId('chat-input-ai-credits-switch-to-subscription'),
          ).toHaveCount(0);
          await openModelPicker(window);
          await expect(offeredBillingMenus(window)).toHaveCount(0);
          await closeModelPicker(window);
        };
        if (!autoChat) await expectLockedToCredits();

        const userMessage = `[${conversationMarker}] Say hello.`;
        const composer = window.getByRole('textbox').first();
        await expect(composer).toBeVisible();
        await composer.click();
        await composer.fill(userMessage);
        await window.getByRole('button', { name: 'Send message' }).click();

        await expect(panel.getByText(userMessage).first()).toBeVisible({
          timeout: 30_000,
        });

        // The scripted reply can only come from the mock answering a live turn.
        await expect(panel.getByText(ASSISTANT_REPLY).first()).toBeVisible({
          timeout: 120_000,
        });

        // The regression itself: no raw provider login error anywhere in the chat.
        expect(await panel.innerText()).not.toContain(RAW_LOGIN_ERROR);

        // ...and the turn was carried by the gateway, not the native path. This is
        // the assertion a UI-only spec cannot make.
        await expect
          .poll(
            async () =>
              (
                await getScenarioActivity(
                  DEFAULT_MOCK_BASE_URL,
                  conversationMarker,
                )
              ).activity?.[
                autoChat ? 'llmProxy:openai' : 'llmProxy:anthropic'
              ] ?? 0,
            { timeout: 30_000 },
          )
          .toBeGreaterThanOrEqual(1);

        // The ordinary active card after the first paid answer still has no
        // switch: settling the turn must not unlock a confirmed sign-out.
        if (!autoChat) await expectLockedToCredits();

        await window.screenshot({
          path: testInfo.outputPath('ecw-9091-credits-routed-turn.png'),
        });
      } finally {
        await closeCanopy(electronApp, userDataDir);
        await clearScenario(DEFAULT_MOCK_BASE_URL, authKey).catch(
          () => undefined,
        );
        await clearScenario(DEFAULT_MOCK_BASE_URL, conversationMarker).catch(
          () => undefined,
        );
      }
    });
  }

  test('the model-picker provider login modal stays mounted across auth refreshes', async ({}, testInfo) => {
    test.setTimeout(120_000);
    const authKey = 'ecw-9091-billing-login-modal-unauthenticated';
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-ecw-9091-login-modal-'),
    );
    seedTree(userDataDir);

    await registerScenario(DEFAULT_MOCK_BASE_URL, authKey, {
      authUsage: { scenario: 'unauthenticated' },
    });

    const { electronApp } = await withBundledBinaryOverridesScrubbed(() =>
      launchCanopy({
        userDataDir,
        env: {
          CANOPY_MOCK_API_KEY: authKey,
          CANOPY_E2E_CLOUD_BASE_URL: DEFAULT_MOCK_BASE_URL,
        },
      }),
    );

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });

      // No cloud account, so no AI Credits: Claude can only run once it is
      // signed in, and the picker's Claude tab offers that sign-in. It opens
      // the same provider login modal the auth refresh loop used to remount.
      await app.openMainPage();
      await app.selectWorktree(WORKTREE_BRANCH);

      await window.getByTestId('chat-model-picker').click();
      await window.getByTestId('chat-model-harness-tab-claude').click();
      const signIn = window.getByTestId('chat-model-connect-harness');
      await expect(signIn).toBeVisible({ timeout: 20_000 });
      await expect(signIn).toHaveText('Sign in');

      // Count DOM mount/unmount cycles rather than sampling visibility at one
      // instant. The broken flow repeatedly removes and re-adds the modal as
      // each two-second auth poll invalidates and then repopulates availability.
      await window.evaluate(() => {
        const selector = '[data-testid="auth-login-modal"]';
        const containsModal = (node) =>
          node instanceof Element &&
          (node.matches(selector) || node.querySelector(selector) !== null);
        const state = { mounts: 0, unmounts: 0 };
        const observer = new MutationObserver((records) => {
          for (const record of records) {
            for (const node of record.addedNodes) {
              if (containsModal(node)) state.mounts += 1;
            }
            for (const node of record.removedNodes) {
              if (containsModal(node)) state.unmounts += 1;
            }
          }
        });
        observer.observe(document.body, { childList: true, subtree: true });
        window.__ecw9091LoginModalObserver = { observer, state };
      });

      await signIn.click();
      const loginModal = window.getByTestId('auth-login-modal');
      await expect(loginModal).toBeVisible();
      await window.waitForTimeout(5_000);

      const cycles = await window.evaluate(() => {
        const tracked = window.__ecw9091LoginModalObserver;
        tracked?.observer.disconnect();
        return tracked?.state ?? { mounts: 0, unmounts: 0 };
      });
      expect(cycles.mounts).toBe(1);
      expect(cycles.unmounts).toBe(0);
      await expect(loginModal).toBeVisible();

      await window.screenshot({
        path: testInfo.outputPath(
          'ecw-9091-provider-login-modal-after-auth-refresh.png',
        ),
      });

      await window
        .getByRole('dialog', { name: 'Sign in to Claude' })
        .getByRole('button', { name: 'Close' })
        .click();
      await expect(loginModal).toBeHidden();
    } finally {
      await closeCanopy(electronApp, userDataDir);
      await clearScenario(DEFAULT_MOCK_BASE_URL, authKey).catch(
        () => undefined,
      );
    }
  });

  test('with neither a native login nor credits the composer offers a Get AI Credits CTA and sending aborts instead of falling through to a native spawn', async ({}, testInfo) => {
    test.setTimeout(180_000);
    const authKey = 'ecw-9091-no-billing-source-unauthenticated';
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-ecw-9091-no-billing-'),
    );
    seedTree(userDataDir);

    await registerScenario(DEFAULT_MOCK_BASE_URL, authKey, {
      authUsage: { scenario: 'unauthenticated' },
    });
    // Registered but deliberately unused: if the app ever DID reach a provider
    // for this turn, the scripted reply would show up and fail the assertions
    // below, which is exactly the fall-through this case is bounding.
    await registerScenario(DEFAULT_MOCK_BASE_URL, CONVERSATION_MARKER, {
      llm: { steps: [{ text: ASSISTANT_REPLY, stopReason: 'end_turn' }] },
    });

    // No `saveCanopyCloudApiKey` here — no cloud account means no credits.
    const { electronApp } = await withBundledBinaryOverridesScrubbed(() =>
      launchCanopy({
        userDataDir,
        env: {
          CANOPY_MOCK_API_KEY: authKey,
          CANOPY_E2E_CLOUD_BASE_URL: DEFAULT_MOCK_BASE_URL,
        },
      }),
    );

    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });

      await app.openMainPage();
      await app.selectWorktree(WORKTREE_BRANCH);

      const panel = window.getByTestId('panel-content-chat');
      await expect(panel).toBeVisible();

      // Proactive dead-end signal, before the user spends a turn finding out.
      const banner = window.getByTestId('chat-input-no-billing-source-banner');
      await expect(banner).toBeVisible({ timeout: 30_000 });
      await expect(banner).toContainText(
        'No available model can be paid for right now.',
      );
      await expect(
        window.getByTestId('chat-input-no-billing-source-get-credits'),
      ).toBeVisible();
      await expect(
        window.getByTestId('chat-input-no-billing-source-sign-in'),
      ).toBeVisible();

      await window.screenshot({
        path: testInfo.outputPath('ecw-9091-no-billing-source-banner.png'),
      });

      // Send anyway. The main-process backstop must ABORT the turn rather than
      // fall through to a native spawn (which is what produced the raw
      // `Please run /login`).
      //
      // The backstop emits
      // `{ type: 'error', error_code: 'no_billing_source', error: <copy> }`.
      // The desktop transcript renders that copy as an `Error: …` row beneath
      // the user's message, which names both remedies, and the persistent
      // `NoBillingSourceBanner` asserted above stays on screen after the send.
      //
      // No provider turn ran, so there is nothing to time: the turn ends with
      // the error row and no "Completed in" footer. What actually bounds the
      // bug is that no provider request happens at all: no scripted reply
      // renders and the mock records zero LLM requests for this marker.
      const userMessage = `[${CONVERSATION_MARKER}] Say hello.`;
      const composer = window.getByRole('textbox').first();
      await expect(composer).toBeVisible();
      await composer.click();
      await composer.fill(userMessage);
      await window.getByRole('button', { name: 'Send message' }).click();

      // The sent message lands, the abort renders its error row, and the turn
      // settles: the composer is idle again and no live turn remains.
      await expect(panel.getByText(userMessage).first()).toBeVisible({
        timeout: 30_000,
      });
      await expect(
        panel.getByText(
          /^Error: You're not signed in to Claude and have no .+ AI Credits available\./,
        ),
      ).toBeVisible({ timeout: 60_000 });
      await expect(
        panel.getByRole('button', { name: 'Stop generation', exact: true }),
      ).toHaveCount(0);
      await expect(composer).toBeEditable();
      await expect(panel).not.toContainText('Working…');
      // Aborted before any provider turn started, so no turn timer is written.
      await expect(panel).not.toContainText('Completed in');

      const panelText = await panel.innerText();
      expect(panelText).not.toContain(RAW_LOGIN_ERROR);
      // Aborted before any provider request, so the scripted reply that a
      // native fall-through would have produced must never render.
      expect(panelText).not.toContain(ASSISTANT_REPLY);
      // ...and the mock saw no request for this conversation at all.
      const activity = (
        await getScenarioActivity(DEFAULT_MOCK_BASE_URL, CONVERSATION_MARKER)
      ).activity;
      expect(activity?.llmRequests ?? 0).toBe(0);

      // The proactive banner is still the user's way out after the failed send.
      await expect(banner).toBeVisible();
    } finally {
      await closeCanopy(electronApp, userDataDir);
      await clearScenario(DEFAULT_MOCK_BASE_URL, authKey).catch(
        () => undefined,
      );
      await clearScenario(DEFAULT_MOCK_BASE_URL, CONVERSATION_MARKER).catch(
        () => undefined,
      );
    }
  });
});

// A real Claude SDK request, not an injected error: plaintext is intentional.
// The generic mock's JSON error envelope does not reproduce this exact SDK text.
test('signed-out Claude fallback 400 explains the connection and preserves raw audit', async () => {
  test.setTimeout(180_000);
  const raw = 'API Error: 400 messages.4.content: Invalid input';
  const authKey = 'claude-fallback-400-signed-out';
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'claude-fallback-400-'),
  );
  seedTree(userDataDir);
  await registerScenario(DEFAULT_MOCK_BASE_URL, authKey, {
    authUsage: { scenario: 'unauthenticated' },
  });
  let gatewayRequests = 0;
  const loopback = createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      if (request.url.startsWith('/api/v1/llm-proxy/anthropic')) {
        gatewayRequests += 1;
        response.writeHead(400, { 'Content-Type': 'text/plain' });
        response.end('messages.4.content: Invalid input');
        return;
      }
      const upstream = await fetch(`${DEFAULT_MOCK_BASE_URL}${request.url}`, {
        method: request.method,
        headers: {
          ...request.headers,
          host: new URL(DEFAULT_MOCK_BASE_URL).host,
        },
        ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
      });
      response.writeHead(upstream.status, Object.fromEntries(upstream.headers));
      response.end(Buffer.from(await upstream.arrayBuffer()));
    } catch {
      response.writeHead(502);
      response.end('Local fixture forwarding failed');
    }
  });
  await new Promise((resolve) => loopback.listen(0, '127.0.0.1', resolve));
  let electronApp;
  try {
    ({ electronApp } = await withBundledBinaryOverridesScrubbed(() =>
      launchCanopy({
        userDataDir,
        env: {
          CANOPY_MOCK_API_KEY: authKey,
          CANOPY_E2E_CLOUD_BASE_URL: `http://127.0.0.1:${loopback.address().port}`,
        },
      }),
    ));
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    const saved = await window.evaluate(
      (apiKey) => window.api.saveCanopyCloudApiKey({ apiKey }),
      'csk_claude_fallback_400_e2e',
    );
    expect(saved.status.authenticated).toBe(true);
    await window.evaluate(() =>
      window.dispatchEvent(new Event('canopy:cloud-account-changed')),
    );
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_BRANCH);
    const panel = window.getByTestId('panel-content-chat');
    await panel.getByRole('textbox').first().fill('Explain this conversation');
    await panel.getByRole('button', { name: 'Send message' }).click();
    await expect
      .poll(() => gatewayRequests, { timeout: 60_000 })
      .toBeGreaterThan(0);
    // Check the original terminal before UI assertions, so a wrong fixture
    // cannot masquerade as the expected pre-fix failure.
    await expect
      .poll(
        async () =>
          window.evaluate(
            async ({ chatId, expected }) => {
              const snapshot = await window.api.observability.loadSnapshot();
              const entry = snapshot.recentEntries.find(
                (item) => item.chatId === chatId && item.status === 'failure',
              );
              if (!entry) return null;
              const transcript =
                await window.api.observability.loadTranscript(entry);
              if (transcript.type !== 'success') return null;
              const events = transcript.lines.map((line) => JSON.parse(line));
              return {
                error: entry.error,
                rawResult: events.some(
                  (event) =>
                    event.type === 'result' &&
                    (event.result === expected ||
                      event.errors?.includes(expected)),
                ),
              };
            },
            { chatId: CHAT_ID, expected: raw },
          ),
        { timeout: 45_000 },
      )
      .toEqual({ error: raw, rawResult: true });
    const notice = panel.getByTestId('claude-ai-credits-fallback-error');
    await expect(notice).toHaveCount(1);
    await expect(notice).toContainText('Claude is signed out.');
    await expect(notice).toContainText('could not read the conversation');
    await expect(panel).not.toContainText(raw);
    await notice.getByTestId('claude-fallback-sign-in').click();
    await expect(window.getByTestId('auth-login-modal')).toBeVisible();
    await window.reload();
    await app.waitForShell();
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_BRANCH);
    await expect(
      panel.getByTestId('claude-ai-credits-fallback-error'),
    ).toHaveCount(1);
    await expect(panel).not.toContainText(raw);
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
    await new Promise((resolve) => loopback.close(resolve));
    await clearScenario(DEFAULT_MOCK_BASE_URL, authKey);
  }
});
