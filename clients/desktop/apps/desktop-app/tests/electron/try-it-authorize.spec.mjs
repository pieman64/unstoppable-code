import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { launchCanopy, closeCanopy } from './launchCanopy.mjs';
import { CanopyAppDriver } from './canopyApp.mjs';
import { startAccountMcpCloud } from './fixtures/accountMcpCloud.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { seedWorktreeChat } from './seeders/seedWorktreeChat.mjs';
import {
  DEFAULT_MOCK_BASE_URL,
  registerScenario,
  clearScenario,
  seedPluginsCache,
} from './seeders/index.mjs';

const KEY = 'can4451-authorize';
const NAME = 'Authorization Fixture';
const NEXT_KEY = 'can5218-next-authorization';
const NEXT_NAME = 'Next Authorization Fixture';
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
  for (const selectedOutcome of [
    'success',
    ...(route === 'embedded'
      ? [
          'success-queued',
          'success-quick',
          'success-activity',
          'success-stage-before',
          'success-stage-after',
        ]
      : []),
    'cancel',
    'failure',
    'deny',
    'provider-error',
  ]) {
    const queuedPicker = selectedOutcome === 'success-queued';
    const quickPicker = selectedOutcome === 'success-quick';
    const activityRemoval = selectedOutcome === 'success-activity';
    const stagePicker = selectedOutcome.startsWith('success-stage-');
    const worktreePicker =
      queuedPicker || quickPicker || activityRemoval || stagePicker;
    const outcome = worktreePicker ? 'success' : selectedOutcome;
    test(`CAN-4451 ${route} ${outcome}${queuedPicker ? ' with queued picker' : quickPicker ? ' with quick picker' : activityRemoval ? ' with Activity removal' : stagePicker ? ` with next Try it ${selectedOutcome.endsWith('before') ? 'before' : 'after'} persistence` : ''} preserves the unsent edited prompt through authorization`, async () => {
      test.setTimeout(180_000);
      const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'can4451-'));
      const sequential =
        route === 'embedded' &&
        outcome === 'success' &&
        !queuedPicker &&
        !quickPicker &&
        !activityRemoval &&
        !stagePicker;
      if (sequential || worktreePicker) {
        seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
        seedPluginsCache({ userDataDir });
        seedWorktreeChat({
          userDataDir,
          workspaceId: 'demo-ts-pnpm-vite',
          worktreeId: 'demo-main',
          activeTabId: 'authorization-chat',
          tabs: [
            {
              id: 'authorization-chat',
              title: 'Incident authorization',
              ...(activityRemoval
                ? {
                    pluginSelections: {
                      collectionIds: [],
                      skillRefs: [],
                      mcpServerRefs: [],
                      pluginRefs: [
                        {
                          marketplaceId: 'demo/market',
                          pluginName: 'delta-tool',
                        },
                      ],
                    },
                  }
                : {}),
            },
          ],
        });
      }
      const cloud = await startAccountMcpCloud({
        includeConnection: false,
        ...(stagePicker
          ? {
              connections: [
                {
                  id: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff',
                  serverKey: NEXT_KEY,
                  configId: 'default',
                  displayName: NEXT_NAME,
                  kind: 'CURATED',
                  status: 'CONNECTED',
                  routeId: 'fixture-next-route',
                  enabledTools: null,
                  lastError: null,
                },
              ],
            }
          : {}),
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
          {
            key: NEXT_KEY,
            name: NEXT_NAME,
            shortDescription: 'Second authorization fixture',
            url: 'https://next-mcp.example.test',
            transport: 'http',
            oauthHints: { usePkce: true },
            categories: ['development'],
            popular: true,
            sortOrder: 1,
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
        if (sequential || worktreePicker) {
          await app.openMainPage();
          await app.selectWorktree('demo-main');
        }
        await app.openPluginsPage();
        await window.getByTestId('plugins-search').fill(NAME);
        await window.getByTestId(`plugins-entry-mcp-catalog:${KEY}`).click();
        if (sequential) {
          // Keep the mounted composer in staging while its account and
          // selections settle. Completion must update its notice directly.
          await window.evaluate(() => {
            globalThis.__tryItFocusAttempts = 0;
            const hold = (event) => {
              globalThis.__tryItFocusAttempts += 1;
              event.stopImmediatePropagation();
            };
            document.addEventListener('canopy:focus-chat-input', hold, true);
            globalThis.__releaseTryItFocus = () =>
              document.removeEventListener(
                'canopy:focus-chat-input',
                hold,
                true,
              );
          });
        }
        await window.getByTestId('detail-primary-cta').click();
        const messages = window.getByTestId('user-message-content');
        await expect(messages).toHaveCount(0);
        const editor = window
          .locator('[data-slate-editor="true"]:visible')
          .first();
        await expect(editor).toContainText(NAME);
        const notice = window.getByTestId('try-it-sign-in-notice');
        if (sequential) {
          await expect
            .poll(() => window.evaluate(() => globalThis.__tryItFocusAttempts))
            .toBeGreaterThanOrEqual(10);
          await expect(notice).toHaveCount(0);
          await window.evaluate(() => globalThis.__releaseTryItFocus());
        }
        await expect
          .poll(() =>
            window.evaluate(
              (catalogId) =>
                Object.entries(localStorage)
                  .filter(([key]) => key.startsWith('canopy:try-it-launch:'))
                  .map(([, raw]) => JSON.parse(raw))
                  .find((launch) => launch.capability.catalogId === catalogId)
                  ?.status,
              KEY,
            ),
          )
          .toBe('staged');
        await expect(notice).toHaveAttribute('data-state', 'sign-in');
        await editor.fill('My edited Authorization Fixture incident');
        const [original] = await records(window);
        let acceptedDraft = 'My edited Authorization Fixture incident';
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
          await expect(messages).toHaveCount(0);
          cloud.answerSignIn(KEY, null);
        } else if (outcome === 'cancel') {
          releaseDisconnect = cloud.holdDisconnect();
          await notice.getByTestId('try-it-sign-in-notice-cancel').click();
          await expect(notice).toHaveAttribute('data-state', 'retry');
          cloud.fail(KEY); // Polling settles while the DELETE is still held.
          await expect(messages).toHaveCount(0);
        } else if (outcome === 'failure') {
          cloud.fail(KEY);
          await expect(notice).toHaveAttribute('data-state', 'retry', {
            timeout: 30_000,
          });
          await expect(messages).toHaveCount(0);
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
        if (sequential || worktreePicker) {
          await electronApp.evaluate(
            (
              { ipcMain },
              { serverId, nextServerId, queued, quick, activity, stage },
            ) => {
              const original = ipcMain._invokeHandlers.get(
                'chat:update-plugins',
              );
              ipcMain.removeHandler('chat:update-plugins');
              let held = false;
              let pendingQuickWrite;
              let releasePicker;
              const pickerGate = new Promise((resolve) => {
                releasePicker = resolve;
              });
              globalThis.__releaseQueuedTryItPicker = releasePicker;
              const hold = async () => {
                globalThis.__tryItSelectionHeld = true;
                await new Promise((resolve) => {
                  globalThis.__releaseTryItSelection = async () => {
                    if (quick) await pendingQuickWrite;
                    resolve();
                  };
                });
              };
              ipcMain.handle('chat:update-plugins', async (event, request) => {
                const resolved = request.pluginSelections.mcpServerRefs?.some(
                  (ref) => ref.serverId === serverId,
                );
                if (resolved && !held) {
                  held = true;
                  if (queued) await hold();
                  const result = await original(event, request);
                  if (!queued) await hold();
                  return result;
                }
                if (
                  (queued || stage) &&
                  !quick &&
                  held &&
                  !resolved &&
                  (activity ||
                    (stage &&
                      request.pluginSelections.mcpServerRefs?.some(
                        (ref) => ref.serverId === nextServerId,
                      )) ||
                    request.pluginSelections.pluginRefs.some(
                      (ref) => ref.pluginName === 'delta-tool',
                    ))
                ) {
                  // A stale picker write can remain queued behind authorization
                  // and return only after its acknowledgement.
                  await pickerGate;
                }
                if (
                  quick &&
                  held &&
                  request.pluginSelections.pluginRefs.some(
                    (ref) => ref.pluginName === 'delta-tool',
                  )
                ) {
                  pendingQuickWrite = original(event, request);
                  return pendingQuickWrite;
                }
                return original(event, request);
              });
            },
            {
              serverId: KEY,
              queued:
                worktreePicker && selectedOutcome !== 'success-stage-after',
              stage: stagePicker,
              nextServerId: NEXT_KEY,
              activity: activityRemoval,
              quick: quickPicker,
            },
          );
        }
        cloud.complete(KEY);
        cloud.complete(KEY);
        const editUnrelatedPlugin = async () => {
          await window.getByTestId('chat-input-plus-button').click();
          await window.getByTestId('chat-plugins-button').click();
          const dialog = window
            .getByRole('dialog')
            .filter({ hasText: 'Plugins' });
          await expect(dialog).toBeVisible();
          await dialog.getByPlaceholder('Search by name…').fill('delta-tool');
          return dialog;
        };
        const unrelatedPlugin = {
          marketplaceId: 'demo/market',
          pluginName: 'delta-tool',
        };
        const readUnrelatedSelection = () =>
          window.evaluate(
            async ({ projectId, worktreeId, chatId }) => {
              const state = await window.api.chat.getState({
                projectId,
                worktreeId,
              });
              return (
                state.tabsFile.tabs.find((tab) => tab.id === chatId)
                  ?.pluginSelections?.pluginRefs ?? []
              );
            },
            {
              projectId: 'demo-ts-pnpm-vite',
              worktreeId: 'demo-main',
              chatId: original.sourceChatId,
            },
          );
        if (sequential || worktreePicker) {
          await expect
            .poll(() =>
              electronApp.evaluate(() => globalThis.__tryItSelectionHeld),
            )
            .toBe(true);
          if (stagePicker) {
            await window.getByTestId('sidebar-nav-plugins').click();
            const primary = window.getByTestId('detail-primary-cta');
            await expect(
              primary.or(
                window.getByRole('heading', { name: 'Customize', exact: true }),
              ),
            ).toBeVisible();
            if (await primary.isVisible())
              await window
                .getByTestId('plugins-entry-detail-breadcrumb-root')
                .click();
            await window.getByTestId('plugins-search').fill(NEXT_NAME);
            await window
              .getByTestId(`plugins-entry-mcp-catalog:${NEXT_KEY}`)
              .or(
                window
                  .getByTestId('customize-section-installed')
                  .getByText(NEXT_NAME, { exact: true }),
              )
              .click();
            await expect(primary).toHaveText('Try it');
            await primary.click();
            await window.evaluate(() =>
              window.api.chat.getState({
                projectId: 'demo-ts-pnpm-vite',
                worktreeId: 'demo-main',
              }),
            );
          } else if (activityRemoval) {
            await window
              .getByTestId('chat-plugins-activity')
              .getByRole('button', { name: 'Remove delta-tool from this chat' })
              .click();
            await readUnrelatedSelection();
          } else if (quickPicker) {
            await window.getByTestId('chat-input-plus-button').click();
            await window
              .getByTestId('chat-input-plugin-demo/market-delta-tool')
              .click();
            await expect(
              window.getByTestId('chat-input-plus-menu'),
            ).toHaveCount(0);
            // Flush the renderer's earlier IPC before releasing authorization;
            // already-received quick writes finish before its held mutation.
            await readUnrelatedSelection();
            acceptedDraft = await editor.innerText();
          } else {
            const dialog = await editUnrelatedPlugin();
            await dialog
              .getByRole('checkbox', { name: 'Select delta-tool', exact: true })
              .check();
            await dialog
              .getByRole('button', { name: 'Save', exact: true })
              .click();
          }
          await electronApp.evaluate(() =>
            globalThis.__releaseTryItSelection(),
          );
        }
        if (stagePicker) {
          await expect
            .poll(async () => (await records(window))[0]?.status)
            .toBe('completed');
          await electronApp.evaluate(() =>
            globalThis.__releaseQueuedTryItPicker(),
          );
          await expect(editor).toContainText(
            'My edited Authorization Fixture incident',
          );
          await expect(editor).toContainText(NEXT_NAME);
          const stagedDraft = await editor.innerText();
          const readSelections = () =>
            window.evaluate(async (chatId) => {
              const state = await window.api.chat.getState({
                projectId: 'demo-ts-pnpm-vite',
                worktreeId: 'demo-main',
              });
              return state.tabsFile.tabs.find((tab) => tab.id === chatId)
                ?.pluginSelections;
            }, original.sourceChatId);
          const expectBoth = async () => {
            await expect
              .poll(async () => (await readSelections())?.mcpServerRefs ?? [])
              .toContainEqual({ serverId: KEY, configId: 'default' });
            await expect
              .poll(async () => (await readSelections())?.mcpServerRefs ?? [])
              .toContainEqual({ serverId: NEXT_KEY, configId: 'default' });
          };
          await expectBoth();
          await expect
            .poll(async () => (await records(window))[0]?.status)
            .toBe('completed');
          await expect(messages).toHaveCount(0);
          await window.reload();
          await app.waitForShell();
          await app.openMainPage();
          await app.selectWorktree('demo-main');
          await expect(editor).toHaveText(stagedDraft);
          await expectBoth();
          await expect(messages).toHaveCount(0);
          return;
        }
        await expect
          .poll(async () => (await records(window))[0]?.status)
          .toBe('completed');
        if (queuedPicker || activityRemoval) {
          await electronApp.evaluate(() =>
            globalThis.__releaseQueuedTryItPicker(),
          );
        }
        if (sequential || worktreePicker) {
          await expect(
            window.getByRole('dialog').filter({ hasText: 'Plugins' }),
          ).toHaveCount(0);
          if (activityRemoval)
            await expect.poll(readUnrelatedSelection).toEqual([]);
          else
            await expect
              .poll(readUnrelatedSelection)
              .toContainEqual(unrelatedPlugin);
          const refs = await window.evaluate(async (chatId) => {
            const state = await window.api.chat.getState({
              projectId: 'demo-ts-pnpm-vite',
              worktreeId: 'demo-main',
            });
            return (
              state.tabsFile.tabs.find((tab) => tab.id === chatId)
                ?.pluginSelections?.mcpServerRefs ?? []
            );
          }, original.sourceChatId);
          expect(refs).toContainEqual({ serverId: KEY, configId: 'default' });
        }
        await expect(messages).toHaveCount(0);
        await expect(editor).toHaveText(acceptedDraft);
        await expect(window.getByTestId('try-it-setup-pane')).toHaveCount(0);
        expect((await records(window))[0]).toMatchObject({
          requestId: original.requestId,
          prompt: original.prompt,
          selectionResolution: {
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
        if (sequential || worktreePicker) {
          const dialog = await editUnrelatedPlugin();
          await expect(
            dialog.getByRole('checkbox', {
              name: 'Select delta-tool',
              exact: true,
            }),
          ).toBeChecked({ checked: !activityRemoval });
          await dialog
            .getByRole('button', { name: 'Save', exact: true })
            .click();
          await expect(dialog).toHaveCount(0);
        }
        await window.reload();
        await app.waitForShell();
        if (sequential || worktreePicker) {
          await app.openMainPage();
          await app.selectWorktree('demo-main');
        } else {
          await window
            .locator('[data-testid="home-resume-button"]:visible')
            .click();
        }
        await expect(messages).toHaveCount(0);
        await expect(editor).toHaveText(acceptedDraft);
        expect((await records(window))[0]).toMatchObject({
          requestId: original.requestId,
          status: 'completed',
        });
        if (sequential || quickPicker) {
          if (!queuedPicker)
            await expect
              .poll(readUnrelatedSelection)
              .toContainEqual(unrelatedPlugin);
          const dialog = await editUnrelatedPlugin();
          const selected = dialog.getByRole('checkbox', {
            name: 'Select delta-tool',
            exact: true,
          });
          await expect(selected).toBeChecked();
          await selected.uncheck();
          await dialog
            .getByRole('button', { name: 'Save', exact: true })
            .click();
          await expect(dialog).toHaveCount(0);
          await expect.poll(readUnrelatedSelection).toEqual([]);
          await editor.press('Enter');
          await expect(messages).toHaveCount(1, { timeout: 60_000 });
          // Sent-message pills show their label without the editor's @ marker.
          await expect(messages).toHaveText(
            quickPicker
              ? 'My edited Authorization Fixture incident delta-tool'
              : acceptedDraft,
          );
          if (quickPicker) {
            await expect
              .poll(readUnrelatedSelection)
              .toContainEqual(unrelatedPlugin);
            return;
          }
          await editor.fill('Second incident');
          const tryCapability = async (key, name) => {
            await window.getByTestId('sidebar-nav-plugins').click();
            const primary = window.getByTestId('detail-primary-cta');
            await expect(
              primary.or(
                window.getByRole('heading', { name: 'Customize', exact: true }),
              ),
            ).toBeVisible();
            if (await primary.isVisible())
              await window
                .getByTestId('plugins-entry-detail-breadcrumb-root')
                .click();
            await window.getByTestId('plugins-search').fill(name);
            await window
              .getByTestId(`plugins-entry-mcp-catalog:${key}`)
              .or(
                window
                  .getByTestId('customize-section-installed')
                  .getByText(name, { exact: true }),
              )
              .click();
            await expect(primary).toHaveText('Try it');
            await primary.click();
          };
          await tryCapability(KEY, NAME);
          await expect(editor).toContainText('Second incident');
          await expect(editor).toContainText(original.prompt);
          await expect(messages).toHaveCount(1);
          const repeatedDraft = await editor.innerText();
          await window.evaluate(async () => {
            await window.api.clearCanopyCloudApiKey();
            window.dispatchEvent(new Event('canopy:cloud-account-changed'));
          });
          await tryCapability(NEXT_KEY, NEXT_NAME);
          await expect(notice).toHaveAttribute('data-state', 'sign-in');
          const [next] = await records(window);
          expect(next.sourceChatId).toBe(original.sourceChatId);
          expect(next.capability.catalogId).toBe(NEXT_KEY);
          await expect(editor).toContainText(repeatedDraft);
          const nextDraft = await editor.innerText();
          await notice.getByTestId('try-it-sign-in-notice-sign-in').click();
          await expect(window.getByTestId('cloud-sync-modal')).toBeVisible();
          await window.evaluate(async () => {
            await window.api.saveCanopyCloudApiKey({
              apiKey: 'csk_can4451_fixture',
            });
            window.dispatchEvent(new Event('canopy:cloud-account-changed'));
          });
          await expect(
            window.getByTestId('cloud-sync-modal'),
          ).not.toBeVisible();
          await expect(notice).toHaveAttribute('data-state', 'setup-required');
          await notice.getByTestId('try-it-sign-in-notice-authorize').click();
          await expect
            .poll(
              () => cloud.calls.filter((call) => call.method === 'POST').length,
            )
            .toBe(2);
          cloud.complete(NEXT_KEY);
          await expect
            .poll(async () => (await records(window))[0]?.status)
            .toBe('completed');
          await expect(editor).toHaveText(nextDraft);
          await expect(messages).toHaveCount(1);
        }
      } finally {
        releaseDisconnect?.();
        if (electronApp) await closeCanopy(electronApp, userDataDir);
        await clearScenario(DEFAULT_MOCK_BASE_URL, NAME);
        await cloud.close();
      }
    });
  }
}

test('CAN-5218 retry finalizes an accepted draft and exposes sign-in after a completion write failure', async () => {
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'can5218-recovery-'));
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: 'demo-ts-pnpm-vite',
    worktreeId: 'demo-main',
    activeTabId: 'authorization-chat',
    tabs: [{ id: 'authorization-chat', title: 'Incident authorization' }],
  });
  const cloud = await startAccountMcpCloud({
    includeConnection: false,
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
  try {
    ({ electronApp } = await launchCanopy({
      userDataDir,
      env: {
        CANOPY_E2E_CLOUD_BASE_URL: cloud.baseUrl,
        CANOPY_E2E_CLIENT_FEATURE_FLAGS: JSON.stringify({
          'canopy-guest-mode-enabled': false,
          'canopy-cloud-sign-in-required': false,
          'canopy-shared-mcp-account-connections': true,
        }),
      },
    }));
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openMainPage();
    await app.selectWorktree('demo-main');
    const before = await window.evaluate(() =>
      window.api.chat.getState({
        projectId: 'demo-ts-pnpm-vite',
        worktreeId: 'demo-main',
      }),
    );
    const openDetail = async () => {
      await window.getByTestId('sidebar-nav-plugins').click();
      const primary = window.getByTestId('detail-primary-cta');
      await expect(
        primary.or(
          window.getByRole('heading', { name: 'Customize', exact: true }),
        ),
      ).toBeVisible();
      if (await primary.isVisible()) return;
      await window.getByTestId('plugins-search').fill(NAME);
      await window.getByTestId(`plugins-entry-mcp-catalog:${KEY}`).click();
    };
    await openDetail();
    await window.evaluate(() => {
      const save = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (
          key.startsWith('canopy:try-it-launch:') &&
          JSON.parse(value).status === 'staged'
        ) {
          Storage.prototype.setItem = save;
          globalThis.__tryItCompletionFailed = true;
          throw new Error('completion write unavailable');
        }
        return save.call(this, key, value);
      };
    });
    await window.getByTestId('detail-primary-cta').click();
    const editor = window.locator('[data-slate-editor="true"]:visible').first();
    await expect(editor).toContainText(NAME);
    await expect
      .poll(() => window.evaluate(() => globalThis.__tryItCompletionFailed))
      .toBe(true);
    const notice = window.getByTestId('try-it-sign-in-notice');
    await expect(notice).toHaveCount(0);
    await editor.fill('My edited recovery incident');
    await openDetail();
    await window.getByTestId('detail-primary-cta').click();
    await expect(notice).toHaveAttribute('data-state', 'sign-in');
    await expect(editor).toHaveText('My edited recovery incident');
    await expect(window.getByTestId('user-message-content')).toHaveCount(0);
    const after = await window.evaluate(() =>
      window.api.chat.getState({
        projectId: 'demo-ts-pnpm-vite',
        worktreeId: 'demo-main',
      }),
    );
    expect(after.tabsFile.tabs.map((tab) => tab.id)).toEqual(
      before.tabsFile.tabs.map((tab) => tab.id),
    );
    expect(after.queue).toEqual(before.queue);
    await window.reload();
    await app.waitForShell();
    await app.openMainPage();
    await app.selectWorktree('demo-main');
    await expect(editor).toHaveText('My edited recovery incident');
    await expect(notice).toHaveAttribute('data-state', 'sign-in');
    await expect(window.getByTestId('user-message-content')).toHaveCount(0);
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
    await cloud.close();
  }
});
