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

// CAN-5160 — credits bought from the No billing source banner are confirmed.
//
// Pressing Check again after a purchase used to hide the banner at once: the
// "Using AI Credits" card took the slot within about a second and nothing said
// credits arrived or how many. The card now takes its arrival state (CAN-5159)
// and reads "N AI Credits added. Ready to use in this chat." until the next
// send, with no second notice stacked beside it and no switch back to the
// subscription that couldn't pay. Once the first paid answer retires that
// state, a confirmed Claude sign-out still keeps the switch away (CAN-5349).
//
// Deterministic state, as in ecw-9091-credits-only-first-turn.spec.mjs:
//   - Signed-out providers through a per-test `authUsage` scenario under this
//     spec's own `CANOPY_MOCK_API_KEY`.
//   - A `csk_` cloud key whose balance is 0 at the click and 16 once the
//     purchase "lands", so the title names the observed increase.
//   - Hosted settings off, so billing opens in the browser (captured locally)
//     and the hand-off survives until Check again.
//   - A scripted reply for the send that retires the notice.
//
// Run:
//   pnpm run build:e2e
//   pnpm exec playwright test chat-no-billing-source-credits-arrival.spec.mjs --reporter=line

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const WORKTREE_BRANCH = 'demo-main';
const CHAT_ID = 'can-5160-no-billing-source-chat';
const DEFAULT_MODEL = 'opus[1m]';

const CLOUD_API_KEY = 'csk_can_5160_no_billing_source_arrival_e2e';
const CLOUD_ACCOUNT_CHANGED_EVENT = 'canopy:cloud-account-changed';
const CONVERSATION_MARKER = 'Canopy-CAN5160-arrival';
// No trailing punctuation: see ecw-9091-credits-only-first-turn.spec.mjs.
const ASSISTANT_REPLY = 'Bought credits carried this turn';

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

test.describe('CAN-5160 No billing source credits arrival', () => {
  test('confirms bought credits in the Using AI Credits card until the next send', async () => {
    test.setTimeout(180_000);
    const authKey = `can-5160-unauthenticated-${test.info().workerIndex}`;
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-can-5160-no-billing-source-'),
    );
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    seedWorktreeChat({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      providerType: 'claude',
      tabs: [{ id: CHAT_ID, title: 'No billing source', model: DEFAULT_MODEL }],
    });

    const externalOpen = await startExternalOpenCapture();
    let electronApp;
    try {
      await registerScenario(DEFAULT_MOCK_BASE_URL, authKey, {
        authUsage: { scenario: 'unauthenticated' },
      });
      await registerScenario(DEFAULT_MOCK_BASE_URL, CLOUD_API_KEY, {
        cloud: { aiCreditsBalance: { credits: 0, eligible: false } },
      });
      await registerScenario(DEFAULT_MOCK_BASE_URL, CONVERSATION_MARKER, {
        llm: { steps: [{ text: ASSISTANT_REPLY, stopReason: 'end_turn' }] },
      });

      ({ electronApp } = await withBundledBinaryOverridesScrubbed(() =>
        launchCanopy({
          userDataDir,
          env: {
            CANOPY_MOCK_API_KEY: authKey,
            CANOPY_E2E_CLOUD_BASE_URL: DEFAULT_MOCK_BASE_URL,
            CANOPY_E2E_EXTERNAL_OPEN_CAPTURE_URL: externalOpen.url,
            // Billing must open in the browser: with hosted settings on it
            // opens in Settings, which ends the hand-off.
            CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
              'canopy-desktop-hosted-settings': false,
            }),
          },
        }),
      ));

      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      const saveResult = await window.evaluate(
        async (apiKey) => window.api.saveCanopyCloudApiKey({ apiKey }),
        CLOUD_API_KEY,
      );
      expect(saveResult.status.authenticated).toBe(true);
      await window.evaluate((eventName) => {
        window.dispatchEvent(new Event(eventName));
      }, CLOUD_ACCOUNT_CHANGED_EVENT);
      await app.openMainPage();
      await app.selectWorktree(WORKTREE_BRANCH);

      const panel = window.getByTestId('panel-content-chat');
      await expect(panel).toBeVisible();
      const banner = panel.getByTestId('chat-input-no-billing-source-banner');
      const getCredits = banner.getByTestId(
        'chat-input-no-billing-source-get-credits',
      );
      const checkAgain = banner.getByTestId(
        'chat-input-no-billing-source-get-credits-check-again',
      );
      const arrival = panel.getByTestId('chat-input-no-billing-source-arrival');
      const card = panel.getByTestId('chat-input-ai-credits-active');

      // 1. Nothing can pay for the next turn.
      await expect(banner).toBeVisible({ timeout: 30_000 });
      await expect(getCredits).toBeEnabled({ timeout: 15_000 });

      // 2. At 0 credits, Get AI Credits opens billing once. The click reads
      // the baseline balance before the coverage read that gates the open,
      // so the title can name the increase.
      await getCredits.click();
      await expect(checkAgain).toBeVisible({ timeout: 15_000 });
      await expect.poll(() => externalOpen.opened.length).toBe(1);

      // 3. 16 credits land; the user comes back and checks.
      await registerScenario(DEFAULT_MOCK_BASE_URL, CLOUD_API_KEY, {
        cloud: { aiCreditsBalance: { credits: 16, eligible: true } },
      });
      // The standalone notice must never mount, not even for the frame
      // before the card catches up with the purchase.
      await window.evaluate(() => {
        const seen = { count: 0 };
        Object.assign(window, { __can5160StandaloneNotice: seen });
        new MutationObserver(() => {
          if (
            document.querySelector(
              '[data-testid="chat-input-no-billing-source-arrival"]',
            )
          ) {
            seen.count += 1;
          }
        }).observe(document.body, { childList: true, subtree: true });
      });
      await checkAgain.click();

      // 4. One positive confirmation: the card that took the slot, in its
      // arrival state, and no second notice beside it.
      const arrivalTitle = card.getByTestId('chat-input-ai-credits-arrival');
      await expect(arrivalTitle).toHaveText('16 AI Credits added.', {
        timeout: 15_000,
      });
      await expect(card).toContainText('Ready to use in this chat.');
      // No way back to the subscription that couldn't pay.
      await expect(
        card.getByTestId('chat-input-ai-credits-switch-to-subscription'),
      ).toHaveCount(0);
      await expect(card).not.toContainText('Using AI Credits');
      await expect(card).toHaveAttribute('data-notice-intent', 'positive');
      await expect(arrival).toHaveCount(0);
      await expect(banner).toHaveCount(0);

      // 5. It stays: the regression was a disappearance within about a second.
      await window.waitForTimeout(2_000);
      await expect(arrivalTitle).toBeVisible();
      await window.evaluate(() => {
        window.dispatchEvent(new Event('focus'));
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await expect(arrivalTitle).toBeVisible();
      await expect(arrival).toHaveCount(0);
      expect(
        await window.evaluate(() => window.__can5160StandaloneNotice.count),
      ).toBe(0);
      expect(externalOpen.opened.length).toBe(1);

      // 6. The next send retires it, and the turn really runs on credits.
      const userMessage = `[${CONVERSATION_MARKER}] Say hello.`;
      const composer = window.getByRole('textbox').first();
      await composer.click();
      await composer.fill(userMessage);
      await window.getByRole('button', { name: 'Send message' }).click();
      await expect(arrivalTitle).toHaveCount(0, { timeout: 30_000 });
      await expect(card).toContainText('Using AI Credits');
      await expect(panel.getByText(ASSISTANT_REPLY).first()).toBeVisible({
        timeout: 120_000,
      });
      await expect
        .poll(
          async () =>
            (
              await getScenarioActivity(
                DEFAULT_MOCK_BASE_URL,
                CONVERSATION_MARKER,
              )
            ).activity?.['llmProxy:anthropic'] ?? 0,
          { timeout: 30_000 },
        )
        .toBeGreaterThanOrEqual(1);

      // 7. CAN-5349: arrival suppression has cleared and the card is in its
      // ordinary state, but Claude's sign-out is confirmed and credits can
      // pay, so the card still offers no switch to the subscription.
      await expect(card).toContainText('Using AI Credits');
      await expect(
        card.getByTestId('chat-input-ai-credits-switch-to-subscription'),
      ).toHaveCount(0);
    } finally {
      if (electronApp) await closeCanopy(electronApp, userDataDir);
      await clearScenario(DEFAULT_MOCK_BASE_URL, authKey);
      await clearScenario(DEFAULT_MOCK_BASE_URL, CLOUD_API_KEY);
      await clearScenario(DEFAULT_MOCK_BASE_URL, CONVERSATION_MARKER);
      await externalOpen.close();
    }
  });
});
