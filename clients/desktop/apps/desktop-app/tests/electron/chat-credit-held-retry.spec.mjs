// CAN-4450: observe the original queued prompt at the native provider boundary.
// A queue removal or working-state transition cannot satisfy this regression.
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  clearScenario,
  connectMockCloudAccount,
  DEFAULT_MOCK_BASE_URL,
  registerScenario,
  seedWorktreeChat,
} from './seeders/index.mjs';
import { withBundledBinaryOverridesScrubbed } from './seeders/bundledBinaryOverrides.mjs';

const target = {
  projectId: 'demo-ts-pnpm-vite',
  worktreeId: 'demo-main',
  chatId: 'credit-held-retry',
};
const account = (credits) => ({
  cloud: {
    dailyCreditDrip: {
      enabled: false,
      decidedAt: '2026-01-01T00:00:00.000Z',
      capCredits: 25,
    },
    aiCreditsSubscription: { active: false, source: 'canopy' },
    aiCreditsBalance: {
      credits,
      eligible: credits > 0,
      dailyDripEnabled: false,
      dailyDripCapCredits: 25,
      orgPool: null,
      source: 'canopy',
    },
  },
});

for (const funding of ['daily credits', 'settled top-up', 'clear']) {
  test(
    funding === 'clear'
      ? 'CAN-4450 Clear removes a credit-held original without dispatch'
      : `CAN-4450 ${funding} preserves the original through explicit Retry`,
    async () => {
      test.setTimeout(180_000);
      const marker = `Canopy-C4450${funding.replaceAll(' ', '').toUpperCase()}`;
      const wallet = `csk_${marker}_wallet`;
      const auth = `${marker}_auth`;
      const original = `[${marker}] [Canopy-Mock-Request:original] Summarize this project.`;
      const requests = async () => {
        const response = await fetch(
          `${DEFAULT_MOCK_BASE_URL}/__mock/requests?key=${marker}`,
        );
        return (await response.json()).requests.filter(
          (request) => request.stepId === 'original',
        );
      };
      const release = (name) =>
        fetch(`${DEFAULT_MOCK_BASE_URL}/__mock/barrier`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ key: marker, name }),
        });
      await registerScenario(DEFAULT_MOCK_BASE_URL, auth, {
        authUsage: { scenario: 'unauthenticated' },
      });
      await registerScenario(DEFAULT_MOCK_BASE_URL, wallet, account(25));
      await registerScenario(DEFAULT_MOCK_BASE_URL, marker, {
        llm: {
          steps: [
            {
              stepId: 'starter',
              waitFor: 'starter-complete',
              barrierTimeoutMs: 60_000,
              text: 'Ready',
              stopReason: 'end_turn',
            },
            {
              stepId: 'original',
              attempts: [
                {
                  waitFor: 'refuse-original',
                  barrierTimeoutMs: 60_000,
                  error: {
                    status: 402,
                    message: 'AI Credits are unavailable for this request.',
                  },
                },
                {
                  text: 'The original queued prompt completed.',
                  stopReason: 'end_turn',
                },
              ],
            },
          ],
        },
      });
      const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'credit-retry-'));
      seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
      seedWorktreeChat({
        userDataDir,
        workspaceId: target.projectId,
        worktreeId: target.worktreeId,
        providerType: 'claude',
        tabs: [
          {
            id: target.chatId,
            title: 'Credit recovery',
            model: 'sonnet',
            aiCreditsRouting: {
              active: true,
              scope: 'persistent',
              activatedAt: Date.now(),
            },
          },
        ],
      });
      const launchHost = () =>
        withBundledBinaryOverridesScrubbed(() =>
          launchCanopy({
            userDataDir,
            env: {
              HOME: userDataDir,
              CANOPY_MOCK_API_KEY: auth,
              CANOPY_E2E_CLOUD_BASE_URL: DEFAULT_MOCK_BASE_URL,
              CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
                'canopy-desktop-hosted-settings': false,
              }),
            },
          }),
        );
      let { electronApp } = await launchHost();
      try {
        let window = await electronApp.firstWindow();
        let app = new CanopyAppDriver(window);
        await app.waitForShell();
        await connectMockCloudAccount(window, wallet);
        await app.openMainPage();
        await app.selectWorktree(target.worktreeId);
        await window.getByTestId('chat-model-picker').click();
        await window.getByTestId('chat-model-harness-tab-claude').click();
        await window
          .locator('[data-testid="chat-model-option-sonnet"]:visible')
          .click();
        const composer = window.getByRole('textbox').first();
        await composer.fill(
          `[${marker}] [Canopy-Mock-Request:starter] Prepare to summarize.`,
        );
        await window
          .getByRole('button', { name: 'Send message', exact: true })
          .click();
        await expect
          .poll(
            async () => {
              const response = await fetch(
                `${DEFAULT_MOCK_BASE_URL}/__mock/barrier?key=${marker}`,
              );
              return (await response.json()).barriers.some(
                (barrier) =>
                  barrier.name === 'starter-complete' && barrier.waiting > 0,
              );
            },
            { timeout: 45_000 },
          )
          .toBe(true);
        await composer.fill(original);
        await composer.press('Enter');
        await expect(window.getByTestId('queued-message-bubble')).toContainText(
          original,
        );
        await release('starter-complete');
        await expect
          .poll(async () => (await requests()).length, { timeout: 45_000 })
          .toBe(1);
        await registerScenario(DEFAULT_MOCK_BASE_URL, wallet, account(0));
        await release('refuse-original');
        // Nothing can pay for it: the transcript records the stop and the
        // composer banner owns the payment choice (CAN-5160).
        await expect(
          window.getByTestId('chat-ai-credits-stop-line'),
        ).toBeVisible({ timeout: 60_000 });
        // In the composer's work drawer the held row's Retry, Edit and Delete
        // live in its More actions menu.
        const openActions = async () => {
          await window.getByTestId('queued-message-more').click();
          await expect(
            window.getByTestId('queued-message-more-menu'),
          ).toBeVisible();
        };
        const closeActions = async () => {
          await window.keyboard.press('Escape');
          await expect(
            window.getByTestId('queued-message-more-menu'),
          ).toHaveCount(0);
        };
        const expectRetryHeld = async () => {
          await openActions();
          await expect(retry).toBeDisabled();
          await expect(retry).toHaveAttribute(
            'aria-description',
            /Retry sends it once your account has AI credits/,
          );
          await closeActions();
        };
        let retry = window.getByTestId('queued-message-retry');
        await expectRetryHeld();
        await expect(
          window.getByTestId('queued-message-interrupt'),
        ).toHaveCount(0);
        const held = await window.evaluate(
          (scope) => window.api.chat.getChatQueueSnapshot(scope),
          target,
        );
        if (funding === 'clear') {
          await openActions();
          await window.getByTestId('queued-message-cancel').click();
          await expect(window.getByTestId('queued-message-bubble')).toHaveCount(
            0,
          );
          expect(await requests()).toHaveLength(1);
          const cleared = await window.evaluate(
            (scope) => window.api.chat.getChatQueueSnapshot(scope),
            target,
          );
          expect(cleared.flatMap((snapshot) => snapshot.queue)).toEqual([]);
          return;
        }
        if (funding === 'settled top-up') {
          await closeCanopy(electronApp, userDataDir, { keepUserData: true });
          ({ electronApp } = await launchHost());
          window = await electronApp.firstWindow();
          app = new CanopyAppDriver(window);
          await app.waitForShell();
          await connectMockCloudAccount(window, wallet);
          await app.openMainPage();
          await app.selectWorktree(target.worktreeId);
          retry = window.getByTestId('queued-message-retry');
          await expectRetryHeld();
          expect(await requests()).toHaveLength(1);
        } else {
          await openActions();
          await window.getByTestId('queued-message-edit').click();
          const editor = window.getByTestId('queued-message-editor');
          await expect(editor).toContainText(original);
          await editor.getByTestId('queued-message-edit-cancel').click();
          await expectRetryHeld();
          expect(await requests()).toHaveLength(1);
        }
        if (funding === 'daily credits') {
          await app.openSettings();
          await app.openSettingsSection('account');
          await window.getByTestId('settings-daily-credit-drip-toggle').click();
          await app.closeSettings();
        } else {
          // Settlement is an external account change; exercise the existing refresh.
          await registerScenario(DEFAULT_MOCK_BASE_URL, wallet, account(25));
          await window.evaluate(() =>
            window.dispatchEvent(new Event('canopy:cloud-account-changed')),
          );
        }
        await expect(async () => {
          if (!(await retry.isVisible())) await openActions();
          await expect(retry).toBeEnabled({ timeout: 1_000 });
        }).toPass({ timeout: 30_000 });
        expect(await requests()).toHaveLength(1);
        const funded = await window.evaluate(
          (scope) => window.api.chat.getChatQueueSnapshot(scope),
          target,
        );
        expect(
          funded
            .flatMap((snapshot) => snapshot.queue)
            .map((entry) => ({
              id: entry.id,
              text: entry.text,
              supersedesUserMessageId: entry.supersedesUserMessageId,
            })),
        ).toEqual(
          held
            .flatMap((snapshot) => snapshot.queue)
            .map((entry) => ({
              id: entry.id,
              text: entry.text,
              supersedesUserMessageId: entry.supersedesUserMessageId,
            })),
        );
        if (funding === 'daily credits') await retry.click();
        else
          await retry.evaluate((button) => {
            button.click();
            button.click();
          });
        await expect
          .poll(async () => (await requests()).length, { timeout: 30_000 })
          .toBe(2);
        await expect(window.getByTestId('panel-content-chat')).toContainText(
          'The original queued prompt completed.',
          { timeout: 30_000 },
        );
        await expect(retry).toHaveCount(0);
        await expect(
          window.getByTestId('chat-ai-credits-stop-line'),
        ).toHaveCount(0);
        // Starter and retried answer retain timing; the credit-only attempt
        // must not leave a third, metadata-only footer.
        await expect(window.getByTestId('turn-timer')).toHaveCount(2);
        await expect(
          window
            .getByTestId('panel-content-chat')
            .getByText(original, { exact: true }),
        ).toHaveCount(1);
        expect(
          (await requests()).map(({ tag, attempt }) => ({ tag, attempt })),
        ).toEqual([
          { tag: 'original', attempt: 1 },
          { tag: 'original', attempt: 2 },
        ]);
      } finally {
        await closeCanopy(electronApp, userDataDir);
        for (const key of [marker, wallet, auth])
          await clearScenario(DEFAULT_MOCK_BASE_URL, key);
      }
    },
  );
}
