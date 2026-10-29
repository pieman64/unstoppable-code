import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { launchCanopy, closeCanopy } from './launchCanopy.mjs';
import { CanopyAppDriver } from './canopyApp.mjs';
import { startAccountMcpCloud } from './fixtures/accountMcpCloud.mjs';
import {
  DEFAULT_MOCK_BASE_URL,
  registerScenario,
  clearScenario,
} from './seeders/index.mjs';

const KEY = 'can4451-authorize';
const NAME = 'Authorization Fixture';
// The tile's copy for each provider answer, from the shared connect errors.
const PROVIDER_ANSWERS = {
  deny: {
    error: 'access_denied',
    message: 'Access wasn’t approved. Sign in again to approve it.',
  },
  'provider-error': {
    error: 'server_error',
    message: 'The sign-in page reported a problem. Sign in again.',
  },
};
const records = (window) =>
  window.evaluate(() =>
    Object.entries(localStorage)
      .filter(([key]) => key.startsWith('canopy:try-it-continuation:'))
      .map(([, raw]) => JSON.parse(raw)),
  );

for (const route of ['embedded', 'external']) {
  for (const outcome of [
    'success',
    'cancel',
    'failure',
    'deny',
    'provider-error',
  ]) {
    test(`CAN-4451 ${route} ${outcome} keeps the prompt and accepts it once`, async () => {
      test.setTimeout(180_000);
      const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'can4451-'));
      const cloud = await startAccountMcpCloud({
        includeConnection: false,
        signInPage: true,
        curatedServers: [
          {
            key: KEY,
            name: NAME,
            shortDescription: 'Seeded authorization fixture',
            url: 'https://mcp.example.test',
            transport: 'http',
            oauthHints: { usePkce: true },
            categories: ['development'],
            popular: true,
            sortOrder: 0,
            updatedAt: '2026-10-18T00:00:00Z',
          },
        ],
      });
      let electronApp;
      let releaseDisconnect;
      try {
        ({ electronApp } = await launchCanopy({
          userDataDir,
          env: {
            CANOPY_E2E_CLOUD_BASE_URL: cloud.baseUrl,
            CANOPY_E2E_EXTERNAL_OPEN_CAPTURE_URL: cloud.externalOpenUrl,
            CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
              'canopy-guest-mode-enabled': false,
              'canopy-cloud-sign-in-required': false,
              'canopy-shared-mcp-account-connections': true,
            }),
          },
        }));
        await registerScenario(DEFAULT_MOCK_BASE_URL, NAME, {
          llm: {
            steps: [{ text: 'The example settled.', stopReason: 'end_turn' }],
          },
        });
        const window = await electronApp.firstWindow();
        const app = new CanopyAppDriver(window);
        await app.waitForShell();
        expect(
          (await window.evaluate(() => window.api.loadCanopyCloudAccount()))
            .hasApiKey,
        ).toBe(false);
        await app.openPluginsPage();
        await window.getByTestId('plugins-search').fill(NAME);
        await window.getByTestId(`plugins-entry-mcp-catalog:${KEY}`).click();
        await window.getByTestId('detail-primary-cta').click();
        const messages = window
          .getByTestId('page-chat')
          .getByTestId('user-message-content');
        await expect(messages).toHaveCount(1, { timeout: 60_000 });
        const notice = window.getByTestId('try-it-sign-in-notice');
        await expect(notice).toHaveAttribute('data-state', 'sign-in');
        const [original] = await records(window);
        await notice.getByTestId('try-it-sign-in-notice-sign-in').click();
        await expect(window.getByTestId('cloud-sync-modal')).toBeVisible();
        await window.evaluate(async () => {
          await window.api.saveCanopyCloudApiKey({
            apiKey: 'csk_can4451_fixture',
          });
          window.dispatchEvent(new Event('canopy:cloud-account-changed'));
        });
        await expect(window.getByTestId('cloud-sync-modal')).not.toBeVisible();
        const account = await window.evaluate(() =>
          window.api.loadCanopyCloudAccount(),
        );
        expect(account.account?.id).toBeTruthy();
        await expect(notice).toHaveAttribute('data-state', 'setup-required');
        const start = async () => {
          await notice
            .getByTestId(
              route === 'embedded'
                ? 'try-it-sign-in-notice-authorize'
                : 'try-it-sign-in-notice-authorize-external',
            )
            .click();
          await expect(notice).toHaveAttribute('data-state', 'authorizing');
          await expect(window.getByTestId('try-it-setup-pane')).toHaveCount(
            route === 'embedded' ? 1 : 0,
          );
        };
        const answer = PROVIDER_ANSWERS[outcome];
        // The provider answers the callback with `error` (CAN-4451): in the
        // pane the sign-in page redirects there itself; the default browser
        // is played by following the page the app opened.
        if (answer) cloud.answerSignIn(KEY, answer.error);
        await start();
        if (route === 'embedded' && outcome === 'success') {
          // CAN-4404: in a narrow window the pane covers the chat column
          // instead of squeezing it to a sliver beside the pane.
          const viewport = await window.evaluate(() => ({
            width: innerWidth,
            height: innerHeight,
          }));
          await window.setViewportSize({ width: 760, height: viewport.height });
          const pane = window.getByTestId('try-it-setup-pane');
          await expect
            .poll(async () => {
              const paneBox = await pane.boundingBox();
              const noticeBox = await notice.boundingBox();
              if (!paneBox || !noticeBox) return false;
              return (
                noticeBox.width >= 320 ||
                (paneBox.x <= noticeBox.x &&
                  paneBox.x + paneBox.width >= noticeBox.x + noticeBox.width)
              );
            })
            .toBe(true);
          await window.setViewportSize(viewport);
        }
        if (answer) {
          if (route === 'external') {
            await expect.poll(() => cloud.externalOpens.length).toBe(1);
            await fetch(cloud.externalOpens[0]);
          }
          await expect(notice).toHaveAttribute('data-state', 'retry', {
            timeout: 15_000,
          });
          await expect(notice).toContainText(answer.message);
          await expect(window.getByTestId('try-it-setup-pane')).toHaveCount(0);
          await expect(messages).toHaveCount(1);
          cloud.answerSignIn(KEY, null);
        } else if (outcome === 'cancel') {
          releaseDisconnect = cloud.holdDisconnect();
          await notice.getByTestId('try-it-sign-in-notice-cancel').click();
          await expect(notice).toHaveAttribute('data-state', 'retry');
          cloud.fail(KEY); // Polling settles while the DELETE is still held.
          await expect(messages).toHaveCount(1);
        } else if (outcome === 'failure') {
          cloud.fail(KEY);
          await expect(notice).toHaveAttribute('data-state', 'retry', {
            timeout: 30_000,
          });
          await expect(messages).toHaveCount(1);
        }
        if (outcome !== 'success') {
          // Wait for the cancelled/failed backend await to settle before retry.
          await expect
            .poll(
              () =>
                cloud.calls.filter((call) => call.method === 'DELETE').length,
            )
            .toBeGreaterThanOrEqual(outcome === 'cancel' ? 1 : 0);
          await notice
            .getByTestId(
              route === 'embedded'
                ? 'try-it-sign-in-notice-retry'
                : 'try-it-sign-in-notice-authorize-external',
            )
            .click();
          await expect(notice).toHaveAttribute('data-state', 'authorizing');
        }
        if (outcome === 'cancel') {
          // Retry must remain blocked for a full polling interval while the
          // old disconnect is held, even though polling has already settled.
          await expect(
            expect
              .poll(
                () =>
                  cloud.calls.filter((call) => call.method === 'POST').length,
                { timeout: 2500 },
              )
              .toBe(2),
          ).rejects.toThrow();
          releaseDisconnect();
        }
        // Retry shows authorizing before its start request reaches the cloud;
        // completing earlier would be overwritten by that request.
        await expect
          .poll(
            () => cloud.calls.filter((call) => call.method === 'POST').length,
          )
          .toBe(outcome === 'success' ? 1 : 2);
        cloud.complete(KEY);
        cloud.complete(KEY);
        await expect
          .poll(async () => (await records(window))[0]?.status)
          .toBe('completed');
        await expect(messages).toHaveCount(2);
        await expect(window.getByTestId('try-it-setup-pane')).toHaveCount(0);
        expect((await records(window))[0]).toMatchObject({
          requestId: original.requestId,
          prompt: original.prompt,
          receipt: {
            requestId: original.requestId,
            chatId: original.sourceChatId,
            accountKey: `account:${account.account.id}`,
          },
        });
        if (answer)
          expect(
            cloud.calls.filter((call) => call.method === 'DELETE'),
          ).toHaveLength(0);
        expect(cloud.externalOpens).toHaveLength(
          route === 'embedded' ? 0 : outcome === 'success' ? 1 : 2,
        );
        await window.reload();
        await app.waitForShell();
        await window
          .getByTestId('sidebar-section-chats-content')
          .locator(`[data-standalone-chat-id="${original.host.worktreeId}"]`)
          .click();
        await expect(messages).toHaveCount(2);
        expect((await records(window))[0]).toMatchObject({
          requestId: original.requestId,
          status: 'completed',
        });
      } finally {
        releaseDisconnect?.();
        if (electronApp) await closeCanopy(electronApp, userDataDir);
        await clearScenario(DEFAULT_MOCK_BASE_URL, NAME);
        await cloud.close();
      }
    });
  }
}
