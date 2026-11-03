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
  registerScenario,
  seedWorktreeChat,
} from './seeders/index.mjs';
import { withBundledBinaryOverridesScrubbed } from './seeders/bundledBinaryOverrides.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

// CAN-5534 — switching chats during checkout kept the purchase.
//
// After Get AI Credits opened browser checkout, switching to another chat and
// back reset the No billing source banner: Check again and Reopen billing
// disappeared, a fresh Get AI Credits came back, and the arrival handle was
// cancelled, so the CAN-5160 "N AI Credits added." confirmation could be lost.
// The hand-off now lives for the purchase scope (project, worktree and
// navigation context), so every chat in it shows the return controls and the
// arrival still belongs to the chat the purchase started in.
//
// The report was in Cowork; two tabs in one worktree exercise the same
// `ChatInput` scope transition. Fixture as in
// chat-no-billing-source-credits-arrival.spec.mjs: signed-out providers, a
// `csk_` cloud key at 0 credits then 16, hosted settings off so billing opens
// in the (captured) browser.
//
// Run:
//   pnpm run build:e2e
//   pnpm run test:electron:built chat-no-billing-source-handoff-chat-switch.spec.mjs --reporter=line

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const WORKTREE_BRANCH = 'demo-main';
const FIRST_CHAT_ID = 'can-5534-origin-chat';
const SECOND_CHAT_ID = 'can-5534-sibling-chat';
const DEFAULT_MODEL = 'opus[1m]';

const CLOUD_API_KEY = 'csk_can_5534_no_billing_source_chat_switch_e2e';
const CLOUD_ACCOUNT_CHANGED_EVENT = 'canopy:cloud-account-changed';
const WAITING_TITLE = 'Finish checkout in your browser';
const DRAFT = 'Draft kept across the chat switch';

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

test.describe('CAN-5534 No billing source hand-off across a chat switch', () => {
  for (const automatic of [false, true]) {
    test(`keeps waiting across chats, then confirms in the origin (${automatic ? 'automatic return' : 'Check again'})`, async () => {
      test.setTimeout(180_000);
      const authKey = `can-5534-unauthenticated-${test.info().workerIndex}`;
      const userDataDir = mkdtempSync(
        path.join(os.tmpdir(), 'canopy-can-5534-chat-switch-'),
      );
      seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
      seedWorktreeChat({
        userDataDir,
        workspaceId: WORKSPACE_ID,
        worktreeId: WORKTREE_ID,
        providerType: 'claude',
        tabs: [
          { id: FIRST_CHAT_ID, title: 'Origin chat', model: DEFAULT_MODEL },
          { id: SECOND_CHAT_ID, title: 'Sibling chat', model: DEFAULT_MODEL },
        ],
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

        ({ electronApp } = await withBundledBinaryOverridesScrubbed(() =>
          launchCanopy({
            userDataDir,
            env: {
              CANOPY_MOCK_API_KEY: authKey,
              CANOPY_E2E_CLOUD_BASE_URL: DEFAULT_MOCK_BASE_URL,
              CANOPY_E2E_EXTERNAL_OPEN_CAPTURE_URL: externalOpen.url,
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

        const firstTab = window.getByTestId(
          `panel-tab-panel-chat-${FIRST_CHAT_ID}`,
        );
        const secondTab = window.getByTestId(
          `panel-tab-panel-chat-${SECOND_CHAT_ID}`,
        );
        const panel = window.locator(
          '[data-testid="panel-content-chat"]:visible',
        );
        const banner = panel.getByTestId('chat-input-no-billing-source-banner');
        const getCredits = banner.getByTestId(
          'chat-input-no-billing-source-get-credits',
        );
        const checkAgain = banner.getByTestId(
          'chat-input-no-billing-source-get-credits-check-again',
        );
        const reopenBilling = banner.getByTestId(
          'chat-input-no-billing-source-reopen-billing',
        );
        const composer = panel.getByRole('textbox').first();

        await firstTab.click();
        await expect(banner).toBeVisible({ timeout: 30_000 });
        await expect(getCredits).toBeEnabled({ timeout: 15_000 });
        await composer.click();
        await composer.fill(DRAFT);

        // 1. Get AI Credits opens billing once and the chat waits.
        await getCredits.click();
        await expect(checkAgain).toBeVisible({ timeout: 15_000 });
        await expect.poll(() => externalOpen.opened.length).toBe(1);

        // 2. The sibling chat shares the purchase: return controls, no second
        // purchase action.
        await secondTab.click();
        await expect(banner).toBeVisible({ timeout: 15_000 });
        await expect(checkAgain).toBeVisible({ timeout: 15_000 });
        await expect(reopenBilling).toBeEnabled({ timeout: 15_000 });
        await expect(getCredits).toHaveCount(0);

        // Credits can arrive while away. Navigation alone must discover them,
        // without a Check again click or a synthetic account-change event.
        if (automatic) {
          await registerScenario(DEFAULT_MOCK_BASE_URL, CLOUD_API_KEY, {
            cloud: { aiCreditsBalance: { credits: 16, eligible: true } },
          });
          await firstTab.click();
          await expect(
            panel.getByTestId('chat-input-ai-credits-arrival'),
          ).toHaveText('16 AI Credits added.', { timeout: 15_000 });
          await expect(composer).toHaveText(DRAFT);
          expect(externalOpen.opened).toHaveLength(1);
          return;
        }

        // 3. Back in the origin chat the waiting state is intact.
        await firstTab.click();
        await expect(banner).toContainText(WAITING_TITLE, { timeout: 15_000 });
        await expect(banner).toHaveAttribute('data-notice-intent', 'neutral');
        await expect(checkAgain).toBeVisible();
        await expect(reopenBilling).toBeEnabled({ timeout: 15_000 });
        await expect(getCredits).toHaveCount(0);
        await expect(composer).toHaveText(DRAFT);

        // 4. Credits land; Check again confirms them in the origin chat.
        await registerScenario(DEFAULT_MOCK_BASE_URL, CLOUD_API_KEY, {
          cloud: { aiCreditsBalance: { credits: 16, eligible: true } },
        });
        await checkAgain.click();
        const card = panel.getByTestId('chat-input-ai-credits-active');
        await expect(
          card.getByTestId('chat-input-ai-credits-arrival'),
        ).toHaveText('16 AI Credits added.', { timeout: 15_000 });

        // 5. Navigation and checking never opened a second checkout.
        expect(externalOpen.opened.length).toBe(1);
      } finally {
        if (electronApp) await closeCanopy(electronApp, userDataDir);
        await clearScenario(DEFAULT_MOCK_BASE_URL, authKey);
        await clearScenario(DEFAULT_MOCK_BASE_URL, CLOUD_API_KEY);
        await externalOpen.close();
      }
    });
  }
});
