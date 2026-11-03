import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { seedPluginsCache } from './seeders/seedPluginsCache.mjs';
import {
  clearScenario,
  DEFAULT_MOCK_BASE_URL,
  getScenarioActivity,
  registerScenario,
  seedWorktreeChat,
} from './seeders/index.mjs';
import { withBundledBinaryOverridesScrubbed } from './seeders/bundledBinaryOverrides.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

// CAN-5348 — a prompt sent into an empty wallet comes back to the composer.
//
// Send stays enabled under the No billing source banner. A send commits the
// user message, then the pre-flight backstop refuses the turn before any
// provider request. The composer used to stay empty, so the prompt and its
// attachment were lost. Now the refused submission returns to the composer
// once, survives the purchase or eligibility refresh, and one normal Send
// delivers it. No new control is added for that.
//
// Deterministic state, as in chat-no-billing-source-credits-arrival.spec.mjs:
//   - Signed-out providers through a per-test `authUsage` scenario.
//   - A `csk_` cloud key with 0 ineligible credits, made eligible later.
//   - Hosted settings off, so billing opens in the (captured) browser.
//
// Run:
//   pnpm run build:e2e
//   pnpm run test:electron:built can-5348-no-billing-abort-restores-composer.spec.mjs --reporter=line

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const WORKTREE_BRANCH = 'demo-main';
const CHAT_ID = 'can-5348-no-billing-abort-chat';
const DEFAULT_MODEL = 'opus[1m]';
const CLOUD_ACCOUNT_CHANGED_EVENT = 'canopy:cloud-account-changed';
// No trailing punctuation: see ecw-9091-credits-only-first-turn.spec.mjs.
const ASSISTANT_REPLY = 'Restored prompt carried this turn';
const ONE_PIXEL_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

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

/** Paste a one-pixel PNG into the composer, as a user would. */
async function pasteImage(editor, name) {
  await editor.evaluate(
    (node, { base64, fileName }) => {
      const bytes = Uint8Array.from(atob(base64), (character) =>
        character.charCodeAt(0),
      );
      const transfer = new DataTransfer();
      transfer.items.add(new File([bytes], fileName, { type: 'image/png' }));
      node.dispatchEvent(
        new ClipboardEvent('paste', {
          clipboardData: transfer,
          bubbles: true,
          cancelable: true,
        }),
      );
    },
    { base64: ONE_PIXEL_PNG, fileName: name },
  );
}

for (const route of [
  'purchase',
  'eligibility-refresh',
  'hosted-pre-work',
  'hosted-mid-turn',
  'hosted-edit-cleared',
  'preparation-input-cleared',
  'preparation-untouched',
]) {
  test(`no-billing composer recovery: ${route}`, async () => {
    test.setTimeout(240_000);
    const hosted = route.startsWith('hosted-');
    const midTurn = route === 'hosted-mid-turn';
    const editCleared = route === 'hosted-edit-cleared';
    const preparationInputCleared = route === 'preparation-input-cleared';
    const preparation = route.startsWith('preparation-');
    const worker = test.info().workerIndex;
    const authKey = `can-5348-unauthenticated-${route}-${worker}`;
    const slug = route.replaceAll('-', '');
    const cloudApiKey = `csk_can_5348_${slug}_${worker}`;
    const marker = `Canopy-CAN5348-${slug}${worker}`;
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-can-5348-no-billing-abort-'),
    );
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    if (preparation) seedPluginsCache({ userDataDir });
    seedWorktreeChat({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      providerType: 'claude',
      tabs: [{ id: CHAT_ID, title: 'Refused prompt', model: DEFAULT_MODEL }],
    });

    const externalOpen = await startExternalOpenCapture();
    let electronApp;
    try {
      await registerScenario(DEFAULT_MOCK_BASE_URL, authKey, {
        authUsage: { scenario: 'unauthenticated' },
      });
      await registerScenario(DEFAULT_MOCK_BASE_URL, cloudApiKey, {
        cloud: {
          aiCreditsBalance: { credits: hosted ? 16 : 0, eligible: hosted },
        },
      });
      // The resend carries the refused copy in its history, which can move
      // the mock's step cursor past a single step; every step is the reply.
      const reply = { text: ASSISTANT_REPLY, stopReason: 'end_turn' };
      await registerScenario(DEFAULT_MOCK_BASE_URL, marker, {
        llm: {
          steps: hosted
            ? [
                ...(midTurn
                  ? [
                      {
                        toolCalls: [
                          {
                            name: 'Read',
                            input: { file_path: 'package.json' },
                          },
                        ],
                        stopReason: 'tool_use',
                      },
                    ]
                  : []),
                {
                  error: 'no_billing_source',
                  ...(editCleared ? { delayMs: 5_000 } : {}),
                },
                {
                  error: 'no_billing_source',
                  ...(editCleared ? { delayMs: 5_000 } : {}),
                },
              ]
            : [reply, reply, reply],
        },
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
        cloudApiKey,
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
      if (!hosted) await expect(banner).toBeVisible({ timeout: 30_000 });
      const composerRoot = window
        .locator('[data-chat-composer-root]:visible')
        .first();
      const editor = composerRoot.getByRole('textbox').first();
      const composerPills = composerRoot.getByTestId('attachment-pill');
      const send = panel.getByRole('button', { name: 'Send message' });

      // 1. Send a marker prompt with an attachment while nothing can pay.
      const userMessage = `[${marker}] Summarize the attached image.`;
      await editor.click();
      await pasteImage(editor, 'can-5348.png');
      await expect(composerPills).toHaveCount(1);
      await editor.fill(userMessage);
      if (preparation) {
        // Hold the real plugin update so input edits happen after reservation
        // but before the complete outbound recovery snapshot is recorded.
        await electronApp.evaluate(({ ipcMain }) => {
          const original = ipcMain._invokeHandlers.get('chat:update-plugins');
          ipcMain.removeHandler('chat:update-plugins');
          ipcMain.handle('chat:update-plugins', async (event, request) => {
            const result = await original(event, request);
            globalThis.__can5348PluginsHeld = true;
            await new Promise((resolve) => {
              globalThis.__can5348ReleasePlugins = resolve;
            });
            return result;
          });
        });
        await window.evaluate(() =>
          document.dispatchEvent(
            new CustomEvent('canopy:insert-file-reference', {
              detail: {
                displayPath: 'delta-tool',
                absolutePath: 'plugin://demo%2Fmarket/delta-tool',
                kind: 'plugin',
              },
            }),
          ),
        );
      }
      await send.click();
      if (preparation) {
        await expect
          .poll(() =>
            electronApp.evaluate(() => globalThis.__can5348PluginsHeld),
          )
          .toBe(true);
        await expect(composerPills).toHaveCount(0);
        if (preparationInputCleared) {
          await pasteImage(editor, 'new-input.png');
          await expect(composerPills).toHaveCount(1);
          await composerPills.getByRole('button').click();
          await expect(composerPills).toHaveCount(0);
        }
        await electronApp.evaluate(() => globalThis.__can5348ReleasePlugins());
      }
      if (editCleared) {
        await expect(editor).not.toContainText(userMessage);
        await editor.fill('My next draft');
        await editor.fill('');
      }

      // 2. One committed user message, the existing error row, an idle turn,
      // and no provider request.
      if (hosted) {
        await expect(
          panel.getByTestId('chat-ai-credits-stop-line').first(),
        ).toBeVisible({ timeout: 90_000 });
      } else {
        await expect(
          panel.getByText(
            /^Error: You're not signed in to Claude and have no .+ AI Credits available\./,
          ),
        ).toBeVisible({ timeout: 60_000 });
      }
      await expect(
        panel.getByRole('button', { name: 'Stop generation', exact: true }),
      ).toHaveCount(0);
      await expect(panel).not.toContainText('Working…');
      const providerRequests =
        (await getScenarioActivity(DEFAULT_MOCK_BASE_URL, marker)).activity
          ?.llmRequests ?? 0;
      if (hosted)
        expect(providerRequests).toBeGreaterThanOrEqual(midTurn ? 2 : 1);
      else expect(providerRequests).toBe(0);

      // A real tool request followed by a hosted refusal must leave the
      // composer cleared; replaying that submission would repeat agent work.
      if (midTurn || editCleared || preparationInputCleared) {
        // Observe through the accepted-send cleanup and delayed restore effect.
        await window.waitForTimeout(1_000);
        await expect(editor).not.toContainText(userMessage);
        await expect(composerPills).toHaveCount(0);
        return;
      }

      if (preparation) {
        await expect(editor).toContainText(userMessage, { timeout: 30_000 });
        await expect(composerPills).toHaveCount(1);
        return;
      }

      // 3. The prompt and attachment return, once.
      await expect(editor).toHaveText(userMessage, { timeout: 30_000 });
      await expect(composerPills).toHaveCount(1);
      await window.waitForTimeout(1_000);
      await expect(composerPills).toHaveCount(1);
      await expect(editor).toHaveText(userMessage);
      // Transcript copies only: the restored composer holds the same text.
      const transcriptCopies = () =>
        panel
          .getByText(userMessage, { exact: true })
          .evaluateAll(
            (nodes) =>
              nodes.filter((node) => !node.closest('[data-chat-composer-root]'))
                .length,
          );
      await expect.poll(transcriptCopies).toBe(1);
      if (hosted) return;

      // 4. Recover billing without touching the composer.
      if (route === 'purchase') {
        const getCredits = banner.getByTestId(
          'chat-input-no-billing-source-get-credits',
        );
        await expect(getCredits).toBeEnabled({ timeout: 15_000 });
        await getCredits.click();
        const checkAgain = banner.getByTestId(
          'chat-input-no-billing-source-get-credits-check-again',
        );
        await expect(checkAgain).toBeVisible({ timeout: 15_000 });
        await registerScenario(DEFAULT_MOCK_BASE_URL, cloudApiKey, {
          cloud: { aiCreditsBalance: { credits: 16, eligible: true } },
        });
        await checkAgain.click();
      } else {
        // Free daily credits or any other eligibility change reach the
        // renderer as an account refresh; no purchase UI is opened.
        await registerScenario(DEFAULT_MOCK_BASE_URL, cloudApiKey, {
          cloud: { aiCreditsBalance: { credits: 5, eligible: true } },
        });
        await window.evaluate((eventName) => {
          window.dispatchEvent(new Event(eventName));
          window.dispatchEvent(new Event('focus'));
        }, CLOUD_ACCOUNT_CHANGED_EVENT);
      }
      await expect(banner).toHaveCount(0, { timeout: 30_000 });

      // 5. The draft survived recovery; one normal Send delivers it.
      await expect(editor).toHaveText(userMessage);
      await expect(composerPills).toHaveCount(1);
      await send.click();
      await expect(panel.getByText(ASSISTANT_REPLY).first()).toBeVisible({
        timeout: 120_000,
      });
      await expect
        .poll(
          async () =>
            (await getScenarioActivity(DEFAULT_MOCK_BASE_URL, marker))
              .activity?.['llmProxy:anthropic'] ?? 0,
          { timeout: 30_000 },
        )
        .toBeGreaterThanOrEqual(1);

      // 6. Two transcript copies now; the composer is empty after acceptance.
      await expect.poll(transcriptCopies).toBe(2);
      await expect(editor).not.toContainText(userMessage);
      await expect(composerPills).toHaveCount(0);
    } finally {
      if (electronApp) await closeCanopy(electronApp, userDataDir);
      await clearScenario(DEFAULT_MOCK_BASE_URL, authKey);
      await clearScenario(DEFAULT_MOCK_BASE_URL, cloudApiKey);
      await clearScenario(DEFAULT_MOCK_BASE_URL, marker);
      await externalOpen.close();
    }
  });
}
