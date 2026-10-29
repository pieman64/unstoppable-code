// Watcher delivery retry regression.
//
// The main process intentionally reuses a delivery id when retrying a watcher
// command. Deliver the same command twice through the real Electron IPC path,
// wait for the normal mocked provider turn, reload, deliver it again from the
// fresh renderer, and assert durable chat history still contains exactly one
// watcher-generated user message and one provider reply.

import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import {
  cleanupDemoWorkspaces,
  seedDemoWorkspaces,
} from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { withBundledBinaryOverridesScrubbed } from './seeders/bundledBinaryOverrides.mjs';
import {
  DEFAULT_MOCK_BASE_URL,
  registerScenario,
  seedWorktreeChat,
  seedWatchers,
  seedPipelineExecution,
} from './seeders/index.mjs';
import { composerIdleAction } from './composerIdleAction.mjs';
import { seedUncertainWatcherDeliveries } from './seeders/uncertainWatcherDelivery.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const CHAT_ID = 'watcher-delivery-dedup';
const WATCHER_TEXT =
  '[Canopy-CWATCHERDELIVERYDEDUP] Inspect the completed run.';
const WATCHER_REPLY = 'Canopy-CWATCHERDELIVERYDEDUP-REPLY complete.';

test('a retried watcher delivery is persisted exactly once', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-watcher-delivery-dedup-'),
  );
  const demo = seedDemoWorkspaces({
    userDataDir,
    apps: ['ts-pnpm-vite'],
  });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    activeTabId: CHAT_ID,
    tabs: [{ id: CHAT_ID, title: 'Watcher delivery dedup' }],
  });
  await registerScenario(
    DEFAULT_MOCK_BASE_URL,
    'Canopy-CWATCHERDELIVERYDEDUP',
    {
      llm: { steps: [{ text: WATCHER_REPLY, stopReason: 'end_turn' }] },
    },
  );

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    let window = await electronApp.firstWindow();
    let app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);

    const command = {
      type: 'send_watcher_message',
      projectId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      chatId: CHAT_ID,
      watcherId: 'watcher-dedup',
      deliveryId: 'delivery-dedup',
      text: WATCHER_TEXT,
      watcherFired: { kind: 'Pipeline completion (Deploy)' },
    };
    await electronApp.evaluate(({ BrowserWindow }, command) => {
      const mainWindow = BrowserWindow.getAllWindows()[0];
      if (!mainWindow) throw new Error('Expected the main BrowserWindow');
      mainWindow.webContents.send('chat:window-command', command);
      mainWindow.webContents.send('chat:window-command', command);
    }, command);

    await expect(window.getByText(WATCHER_REPLY).first()).toBeVisible({
      timeout: 90_000,
    });
    await window.reload();
    window = await electronApp.firstWindow();
    app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);

    const firstReloadWatcherMessages = window
      .getByTestId('panel-content-chat')
      .locator('[data-role="user"]')
      .filter({ hasText: WATCHER_TEXT });
    await expect(firstReloadWatcherMessages).toHaveCount(1, {
      timeout: 30_000,
    });
    await expect(
      firstReloadWatcherMessages.getByTestId('watcher-fired-title'),
    ).toHaveText('Pipeline completion (Deploy) watcher has fired');

    await electronApp.evaluate(({ BrowserWindow }, retriedCommand) => {
      const mainWindow = BrowserWindow.getAllWindows()[0];
      if (!mainWindow) throw new Error('Expected the main BrowserWindow');
      mainWindow.webContents.send('chat:window-command', retriedCommand);
    }, command);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    await window.reload();
    window = await electronApp.firstWindow();
    app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);

    const watcherMessages = window
      .getByTestId('panel-content-chat')
      .locator('[data-role="user"]')
      .filter({ hasText: WATCHER_TEXT });
    await expect(watcherMessages).toHaveCount(1, { timeout: 30_000 });
    await expect(
      window
        .getByTestId('panel-content-chat')
        .locator('[data-role="assistant"]')
        .filter({ hasText: WATCHER_REPLY }),
    ).toHaveCount(1, { timeout: 30_000 });
  } finally {
    await closeCanopy(electronApp, userDataDir);
    cleanupDemoWorkspaces(demo);
  }
});

test('a hung watcher delivery to one chat does not block another chat', async () => {
  test.setTimeout(180_000);
  const hungChatId = 'watcher-delivery-hung';
  const marker = 'Canopy-CWATCHERHEADOFLINE';
  const reply = `${marker}-REPLY complete.`;
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-watcher-head-of-line-'),
  );
  const demo = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    activeTabId: CHAT_ID,
    tabs: [
      { id: hungChatId, title: 'Hung watcher destination' },
      { id: CHAT_ID, title: 'Healthy watcher destination' },
    ],
  });
  await registerScenario(DEFAULT_MOCK_BASE_URL, marker, {
    llm: { steps: [{ text: reply, stopReason: 'end_turn' }] },
  });

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);

    // Main never answers a send to the hung chat, like a busy session whose
    // event drain never settles. Every other chat keeps the real handler.
    await electronApp.evaluate(({ ipcMain }, chatId) => {
      const channel = 'chat:send-message';
      const original = ipcMain._invokeHandlers?.get(channel);
      if (typeof original !== 'function') {
        throw new Error(`Expected a registered ${channel} handler`);
      }
      globalThis.__hungWatcherSends = 0;
      globalThis.__watcherAcks = [];
      const ackChannel = 'app-advisor:watcher-message-delivery';
      const originalAck = ipcMain._invokeHandlers?.get(ackChannel);
      ipcMain.removeHandler(ackChannel);
      ipcMain.handle(ackChannel, (event, request, ...rest) => {
        globalThis.__watcherAcks.push(request);
        return originalAck(event, request, ...rest);
      });
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, (event, request, ...rest) => {
        if (request?.chatId !== chatId)
          return original(event, request, ...rest);
        globalThis.__hungWatcherSends += 1;
        // Retain the pending reply: Electron rejects an invoke whose
        // unreachable promise is garbage collected.
        const hung = new Promise((resolve) => {
          globalThis.__releaseHungWatcherSend = resolve;
        });
        globalThis.__hungWatcherReply = hung;
        return hung;
      });
    }, hungChatId);

    const command = (chatId, deliveryId, text) => ({
      type: 'send_watcher_message',
      projectId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      chatId,
      watcherId: `watcher-${deliveryId}`,
      deliveryId,
      text,
      watcherFired: { kind: 'Pipeline completion (Deploy)' },
    });
    await electronApp.evaluate(
      ({ BrowserWindow }, commands) => {
        const mainWindow = BrowserWindow.getAllWindows()[0];
        if (!mainWindow) throw new Error('Expected the main BrowserWindow');
        for (const next of commands) {
          mainWindow.webContents.send('chat:window-command', next);
        }
      },
      [
        command(hungChatId, 'delivery-hung', `[${marker}] Hung destination.`),
        command(CHAT_ID, 'delivery-healthy', `[${marker}] Healthy one.`),
      ],
    );

    await expect
      .poll(() => electronApp.evaluate(() => globalThis.__hungWatcherSends), {
        timeout: 30_000,
      })
      .toBe(1);
    await expect(
      window
        .getByTestId('panel-content-chat')
        .locator('[data-role="assistant"]')
        .filter({ hasText: reply }),
    ).toHaveCount(1, { timeout: 90_000 });
    // The hung delivery holds only its own chat's lane.
    expect(
      await electronApp.evaluate(() =>
        globalThis.__watcherAcks.map(
          ({ deliveryId, stage, ok }) => `${deliveryId}:${stage}:${ok}`,
        ),
      ),
    ).toEqual([
      'delivery-hung:received:true',
      'delivery-healthy:received:true',
      'delivery-healthy:completed:true',
    ]);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    cleanupDemoWorkspaces(demo);
  }
});

test('startup recovers a missed pipeline watcher notification exactly once', async ({}, testInfo) => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-watcher-recovery-'),
  );
  const demo = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'claude',
    activeTabId: CHAT_ID,
    tabs: [{ id: CHAT_ID, title: 'Recovered watcher' }],
  });
  seedPipelineExecution({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    execution: {
      id: 'missed-run',
      status: 'success',
      completedAt: '2026-09-01T12:00:00.000Z',
    },
  });
  seedWatchers({
    userDataDir,
    watchers: [
      {
        id: 'missed-watcher',
        createdAt: '2026-09-01T11:00:00.000Z',
        label: 'Recovered pipeline',
        trigger: 'worktree_pipeline_completion',
        target: {
          kind: 'worktree_pipeline',
          projectId: WORKSPACE_ID,
          worktreeId: WORKTREE_ID,
          executionId: 'missed-run',
        },
        destination: {
          projectId: WORKSPACE_ID,
          worktreeId: WORKTREE_ID,
          chatId: CHAT_ID,
        },
        followUpInstruction:
          '[Canopy-CWATCHERRECOVERY] Summarize the recovered result.',
      },
    ],
  });
  await registerScenario(DEFAULT_MOCK_BASE_URL, 'Canopy-CWATCHERRECOVERY', {
    llm: {
      steps: [
        {
          text: 'Canopy-CWATCHERRECOVERY-REPLY complete.',
          stopReason: 'end_turn',
        },
      ],
    },
  });
  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({ userDataDir }));
    let window = await electronApp.firstWindow();
    let app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    await expect(window.getByTestId('watcher-fired-title')).toHaveCount(1, {
      timeout: 30_000,
    });
    await expect(
      window.getByText('Canopy-CWATCHERRECOVERY-REPLY complete.').first(),
    ).toBeVisible({ timeout: 90_000 });
    await closeCanopy(electronApp, userDataDir, { keepUserData: true });
    ({ electronApp } = await launchCanopy({ userDataDir }));
    window = await electronApp.firstWindow();
    app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    await expect(window.getByTestId('watcher-fired-title')).toHaveCount(1, {
      timeout: 30_000,
    });
  } catch (error) {
    for (const relative of [
      'app-advisor-watchers.json',
      'pipeline-executions/missed-run.json',
      'logs/main.log',
    ]) {
      try {
        await testInfo.attach(relative.replaceAll('/', '-'), {
          body: readFileSync(path.join(userDataDir, relative)),
          contentType: 'text/plain',
        });
      } catch {
        /* Missing diagnostics do not replace the assertion. */
      }
    }
    throw error;
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
    cleanupDemoWorkspaces(demo);
  }
});

for (const providerType of ['claude', 'codex']) {
  test(`mid-turn ${providerType} watcher steers once and idle watcher starts a full turn`, async () => {
    test.setTimeout(150_000);
    const marker = `Canopy-CWATCHERSTEER${providerType.toUpperCase()}`;
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-watcher-steer-'),
    );
    const demo = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    seedWorktreeChat({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      providerType,
      activeTabId: CHAT_ID,
      tabs: [
        {
          id: CHAT_ID,
          title: 'Watcher steering',
          interfaceMode: 'canopy',
          model: providerType === 'claude' ? 'claude-sonnet-4-6' : 'gpt-5.5',
        },
      ],
    });
    await registerScenario(DEFAULT_MOCK_BASE_URL, marker, {
      llm: {
        steps: [
          {
            text: 'Unexpected untagged watcher request',
            stopReason: 'end_turn',
          },
        ],
        stepsByRequestTag: {
          root: {
            text: 'Watcher root still active. '.repeat(30),
            streamMs: providerType === 'codex' ? 12_000 : 60_000,
            chunkChars: 8,
            stopReason: 'end_turn',
          },
          watcher: {
            text: 'Steered watcher reply. '.repeat(20),
            streamMs: 60_000,
            chunkChars: 8,
            stopReason: 'end_turn',
          },
          idle: { text: 'Idle watcher full reply', stopReason: 'end_turn' },
        },
      },
    });
    const { electronApp } = await withBundledBinaryOverridesScrubbed(() =>
      launchCanopy({ userDataDir }),
    );
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();
      await app.selectWorktree(WORKTREE_ID);
      const panel = window.getByTestId('panel-content-chat');
      await panel
        .getByRole('textbox')
        .last()
        .fill(`[${marker}] [Canopy-Mock-Request:root] Work on the root task`);
      await panel.getByRole('textbox').last().press('Enter');
      const state = () =>
        window.evaluate(
          async ({ projectId, worktreeId, chatId }) => {
            const state = await window.api.chat.getState({
              projectId,
              worktreeId,
            });
            return {
              tab: state.tabsFile.tabs.find((tab) => tab.id === chatId),
              runtime: state.runtimeByChatId[chatId],
            };
          },
          { projectId: WORKSPACE_ID, worktreeId: WORKTREE_ID, chatId: CHAT_ID },
        );
      await expect
        .poll(async () => (await state()).runtime?.steeringCapabilities?.steer)
        .toBe(true);
      const root = (await state()).runtime.activeTurn.userMessageId;
      await electronApp.evaluate(({ ipcMain }) => {
        const channel = 'app-advisor:watcher-message-delivery';
        const original = ipcMain._invokeHandlers.get(channel);
        if (!original)
          throw new Error('Missing watcher acknowledgement handler');
        globalThis.__watcherAcks = [];
        ipcMain.removeHandler(channel);
        ipcMain.handle(channel, (event, request) => {
          globalThis.__watcherAcks.push(request);
          return original(event, request);
        });
      });
      const command = {
        type: 'send_watcher_message',
        projectId: WORKSPACE_ID,
        worktreeId: WORKTREE_ID,
        chatId: CHAT_ID,
        watcherId: 'watcher-mid-turn',
        deliveryId: 'watcher-mid-turn',
        text: `[${marker}] [Canopy-Mock-Request:watcher] Watcher completed while working`,
        hiddenContextText:
          '<system_instruction>Use the event as context. Keep working.</system_instruction>',
        watcherFired: { kind: 'Pipeline completion (Deploy)' },
      };
      const deliver = (payload) =>
        electronApp.evaluate(({ BrowserWindow }, payload) => {
          const main = BrowserWindow.getAllWindows().find(
            (window) => !window.isDestroyed(),
          );
          if (!main) throw new Error('Missing watcher destination');
          main.webContents.send('chat:window-command', payload);
        }, payload);
      await deliver(command);
      await expect
        .poll(async () => (await state()).tab?.inputDelivery?.rows[0]?.state)
        .toBe('pending');
      const pendingBubble = panel.getByTestId('input-delivery-bubble');
      await expect(pendingBubble.getByRole('status')).toHaveText('Pending');
      await expect(pendingBubble.getByTestId('watcher-fired-title')).toHaveText(
        'Pipeline completion (Deploy) watcher has fired',
      );
      await expect(pendingBubble).toHaveClass(/(^|\s)bg-info-subtle(\s|$)/);
      await deliver(command);
      await expect(panel.getByTestId('queued-message-bubble')).toHaveCount(0);
      const admitted = await state();
      expect(admitted.tab.inputDelivery.rows).toHaveLength(1);
      expect(admitted.tab.inputDelivery.rows[0].attempts).toHaveLength(1);
      expect(admitted.tab.inputDelivery.rows[0].payload.watcherFired).toEqual(
        command.watcherFired,
      );
      expect(admitted.tab.inputDelivery.rows[0].payload.hiddenContext).toEqual({
        kind: 'canopy-watcher-event',
        text: command.hiddenContextText,
      });
      expect(admitted.runtime.activeTurn.userMessageId).toBe(root);
      if (providerType === 'codex') {
        // turn/steer's response proves admission; pickup follows at the next
        // provider input boundary, after the current model response settles.
        await expect
          .poll(
            async () => (await state()).tab?.inputDelivery?.rows[0]?.state,
            { timeout: 30_000 },
          )
          .toBe('picked-up');
        expect((await state()).runtime.activeTurn.userMessageId).toBe(root);
      }
      await panel.getByTestId('chat-stop-generation').click();
      await expect(composerIdleAction(panel)).toBeVisible();
      if (providerType === 'claude') {
        await expect(panel.getByTestId('input-delivery-row')).toContainText(
          'Cancelled',
        );
      } else {
        const picked = (await state()).tab.messages.find(
          (message) => message.id === 'watcher-watcher-mid-turn',
        );
        expect(picked.watcherFired).toEqual(command.watcherFired);
        expect(
          picked.blocks.some(
            (block) => block.type === 'text' && block.steering,
          ),
        ).toBe(true);
      }
      await deliver({
        ...command,
        watcherId: 'watcher-idle',
        deliveryId: 'watcher-idle',
        text: `[${marker}] [Canopy-Mock-Request:idle] Watcher completed after the turn`,
      });
      await expect(
        panel.getByText('Idle watcher full reply', { exact: true }),
      ).toBeVisible({ timeout: 45_000 });
      await window.reload();
      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();
      await app.selectWorktree(WORKTREE_ID);
      const completedAcks = () =>
        electronApp.evaluate(
          () =>
            globalThis.__watcherAcks.filter(
              (ack) =>
                ack.deliveryId === 'watcher-mid-turn' &&
                ack.stage === 'completed' &&
                ack.ok,
            ).length,
        );
      const priorAcks = await completedAcks();
      await deliver(command);
      await expect.poll(completedAcks).toBe(priorAcks + 1);
      await expect(composerIdleAction(panel)).toBeVisible();
      await expect
        .poll(async () => (await state()).tab?.inputDelivery?.rows.length)
        .toBe(1);
      await expect(panel.getByTestId('queued-message-bubble')).toHaveCount(0);
      const final = await state();
      const idle = final.tab.messages.filter(
        (message) => message.id === 'watcher-watcher-idle',
      );
      expect(idle).toHaveLength(1);
      expect(
        idle[0].blocks.some((block) => block.type === 'text' && block.steering),
      ).toBe(false);
      expect(final.tab.inputDelivery.rows[0].attempts).toHaveLength(1);
    } finally {
      await closeCanopy(electronApp, userDataDir);
      cleanupDemoWorkspaces(demo);
    }
  });
}

test('refused codex watcher steer is queued and sent once as a full turn', async () => {
  test.setTimeout(180_000);
  const marker = 'Canopy-CWATCHERREFUSEDSTEER';
  const deliveryId = 'watcher-refused-steer';
  const watcherMessageId = `watcher-${deliveryId}`;
  const watcherReply = 'Refused watcher full reply';
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-watcher-refused-steer-'),
  );
  const demo = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId: WORKSPACE_ID,
    worktreeId: WORKTREE_ID,
    providerType: 'codex',
    activeTabId: CHAT_ID,
    tabs: [
      {
        id: CHAT_ID,
        title: 'Refused watcher steering',
        interfaceMode: 'canopy',
        model: 'gpt-5.5',
      },
    ],
  });
  await registerScenario(DEFAULT_MOCK_BASE_URL, marker, {
    llm: {
      steps: [
        {
          text: 'Unexpected untagged watcher request',
          stopReason: 'end_turn',
        },
      ],
      stepsByRequestTag: {
        root: {
          text: 'Watcher root still active. '.repeat(30),
          streamMs: 12_000,
          chunkChars: 8,
          stopReason: 'end_turn',
        },
        watcher: { text: watcherReply, stopReason: 'end_turn' },
      },
    },
  });

  let electronApp;
  try {
    ({ electronApp } = await withBundledBinaryOverridesScrubbed(() =>
      launchCanopy({
        userDataDir,
        env: {
          CANOPY_E2E_CODEX_STALE_STEER_TURN_ID:
            '01a00000-0000-7000-8000-000000000000',
        },
      }),
    ));
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_ID);
    const panel = window.getByTestId('panel-content-chat');
    const state = () =>
      window.evaluate(
        async ({ projectId, worktreeId, chatId }) => {
          const state = await window.api.chat.getState({
            projectId,
            worktreeId,
          });
          return {
            tab: state.tabsFile.tabs.find((tab) => tab.id === chatId),
            runtime: state.runtimeByChatId[chatId],
          };
        },
        { projectId: WORKSPACE_ID, worktreeId: WORKTREE_ID, chatId: CHAT_ID },
      );

    await panel
      .getByRole('textbox')
      .last()
      .fill(`[${marker}] [Canopy-Mock-Request:root] Work on the root task`);
    await panel.getByRole('textbox').last().press('Enter');
    await expect
      .poll(async () => (await state()).runtime?.steeringCapabilities?.steer)
      .toBe(true);
    const root = (await state()).runtime.activeTurn.userMessageId;
    await window.evaluate(() => {
      globalThis.__watcherUncertainRendered = false;
      const inspectChatPanel = () => {
        if (
          document
            .querySelector('[data-testid="panel-content-chat"]')
            ?.textContent?.includes('Delivery uncertain')
        ) {
          globalThis.__watcherUncertainRendered = true;
        }
      };
      const observer = new MutationObserver(inspectChatPanel);
      observer.observe(document.body, {
        childList: true,
        characterData: true,
        subtree: true,
      });
      globalThis.__watcherUncertainObserver = observer;
      inspectChatPanel();
    });
    const expectNoUncertainUi = async () => {
      await expect(
        panel.getByText('Delivery uncertain', { exact: true }),
      ).toHaveCount(0);
      expect(
        await window.evaluate(
          () => globalThis.__watcherUncertainRendered === true,
        ),
      ).toBe(false);
    };

    await electronApp.evaluate(({ ipcMain }) => {
      const channel = 'app-advisor:watcher-message-delivery';
      const original = ipcMain._invokeHandlers.get(channel);
      if (!original) throw new Error('Missing watcher acknowledgement handler');
      globalThis.__watcherAcks = [];
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, (event, request) => {
        globalThis.__watcherAcks.push(request);
        return original(event, request);
      });
    });
    const ackCount = () =>
      electronApp.evaluate(() => globalThis.__watcherAcks.length);
    const command = {
      type: 'send_watcher_message',
      projectId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      chatId: CHAT_ID,
      watcherId: deliveryId,
      deliveryId,
      text: `[${marker}] [Canopy-Mock-Request:watcher] Watcher completed while working`,
      hiddenContextText:
        '<system_instruction>Use the event as context. Keep working.</system_instruction>',
      watcherFired: { kind: 'Pipeline completion (Deploy)' },
    };
    const deliver = (payload) =>
      electronApp.evaluate(({ BrowserWindow }, payload) => {
        const main = BrowserWindow.getAllWindows().find(
          (window) => !window.isDestroyed(),
        );
        if (!main) throw new Error('Missing watcher destination');
        main.webContents.send('chat:window-command', payload);
      }, payload);
    const sendAndWaitForAck = async (payload) => {
      const previousAcks = await ackCount();
      await deliver(payload);
      await expect.poll(ackCount).toBeGreaterThan(previousAcks);
    };
    const deliveryRow = async () =>
      (await state()).tab?.inputDelivery?.rows.find(
        (row) => row.id === watcherMessageId,
      );
    const expectNoUncertainAttempt = (row) => {
      expect(row).toBeDefined();
      expect(row.state).not.toBe('uncertain');
      expect(
        row.attempts.every((attempt) => attempt.uncertainAt === undefined),
      ).toBe(true);
    };

    await sendAndWaitForAck(command);
    await expect
      .poll(async () => {
        const row = await deliveryRow();
        return Boolean(
          row?.attempts.length &&
          row.reason?.includes('Falling back to ordinary delivery.'),
        );
      })
      .toBe(true);
    const refused = await state();
    const refusedRow = refused.tab.inputDelivery.rows.find(
      (row) => row.id === watcherMessageId,
    );
    expect(refusedRow.attempts.length).toBeGreaterThan(0);
    expect(refusedRow.reason).toContain('Falling back to ordinary delivery.');
    expectNoUncertainAttempt(refusedRow);
    expect(refused.runtime.activeTurn.userMessageId).toBe(root);
    const queuedBubbles = panel.getByTestId('queued-message-bubble');
    await expect(queuedBubbles).toHaveCount(1);
    await expect(queuedBubbles).toContainText(command.text);
    await expectNoUncertainUi();

    await sendAndWaitForAck(command);
    const queuedRetry = await state();
    expect(queuedRetry.tab.inputDelivery.rows).toHaveLength(1);
    expect(
      queuedRetry.tab.messages.filter(
        (message) => message.id === watcherMessageId,
      ),
    ).toHaveLength(0);
    await expect(queuedBubbles).toHaveCount(1);
    await expectNoUncertainUi();
    expect(queuedRetry.runtime.activeTurn.userMessageId).toBe(root);

    // Do not stop the root turn: the restored watcher should start ordinarily
    // only after Codex completes this active response by itself.
    await expect
      .poll(
        async () => (await state()).runtime?.activeTurn?.userMessageId !== root,
        { timeout: 60_000 },
      )
      .toBe(true);
    await expect(panel.getByText(watcherReply, { exact: true })).toBeVisible({
      timeout: 60_000,
    });

    const completed = await state();
    const watcherMessages = completed.tab.messages.filter(
      (message) => message.id === watcherMessageId,
    );
    expect(watcherMessages).toHaveLength(1);
    expect(watcherMessages[0].watcherFired).toEqual(command.watcherFired);
    expect(
      watcherMessages[0].blocks.some(
        (block) => block.type === 'text' && block.steering === true,
      ),
    ).toBe(false);
    await expect(panel.getByText(watcherReply, { exact: true })).toHaveCount(1);
    expectNoUncertainAttempt(
      completed.tab.inputDelivery.rows.find(
        (row) => row.id === watcherMessageId,
      ),
    );
    await expectNoUncertainUi();

    await sendAndWaitForAck(command);
    const redelivered = await state();
    expect(redelivered.tab.inputDelivery.rows).toHaveLength(1);
    expect(
      redelivered.tab.messages.filter(
        (message) => message.id === watcherMessageId,
      ),
    ).toHaveLength(1);
    expectNoUncertainAttempt(
      redelivered.tab.inputDelivery.rows.find(
        (row) => row.id === watcherMessageId,
      ),
    );
    await expect(queuedBubbles).toHaveCount(0);
    await expect(panel.getByText(watcherReply, { exact: true })).toHaveCount(1);
    await expectNoUncertainUi();
    await window.evaluate(() =>
      globalThis.__watcherUncertainObserver?.disconnect(),
    );
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
    cleanupDemoWorkspaces(demo);
  }
});

test('uncertain watcher deliveries can be dismissed durably without resending', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-watcher-dismiss-'),
  );
  const demo = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedUncertainWatcherDeliveries(userDataDir);
  let electronApp;
  try {
    ({ electronApp } = await launchCanopy({ userDataDir }));
    const open = async () => {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell();
      await app.openMainPage();
      await app.selectWorktree(WORKTREE_ID);
      return window;
    };
    let window = await open();
    const rows = window.getByTestId('input-delivery-row');
    await expect(rows).toHaveCount(3);
    await expect(rows.first()).toContainText('Delivery uncertain');
    const dismiss = rows
      .first()
      .getByRole('button', { name: 'Dismiss message', exact: true });
    const dismissCorner = dismiss.locator('..');
    await window.mouse.move(0, 0);
    await expect(dismissCorner).toHaveCSS('opacity', '0');
    await rows.first().getByTestId('input-delivery-bubble').hover();
    await expect(dismissCorner).toHaveCSS('opacity', '1');
    await expect(dismiss).toBeVisible();
    await window.mouse.move(0, 0);
    await expect(dismissCorner).toHaveCSS('opacity', '0');
    await dismiss.focus();
    await expect(dismissCorner).toHaveCSS('opacity', '1');
    const cdp = await window.context().newCDPSession(window);
    await cdp.send('Emulation.setTouchEmulationEnabled', {
      enabled: true,
      maxTouchPoints: 1,
    });
    await expect
      .poll(() =>
        window.evaluate(() => matchMedia('(pointer: coarse)').matches),
      )
      .toBe(true);
    const touchTarget = await dismiss.boundingBox();
    expect(touchTarget?.width).toBeGreaterThanOrEqual(44);
    expect(touchTarget?.height).toBeGreaterThanOrEqual(44);
    const viewportWidth = await window.evaluate(() => window.innerWidth);
    expect(touchTarget?.x + touchTarget?.width).toBeLessThanOrEqual(
      viewportWidth,
    );
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false });
    await dismiss.press('Enter');
    await expect(rows).toHaveCount(2);
    await expect(
      window.locator('[data-slate-editor="true"]:visible').first(),
    ).toBeFocused();
    const state = () =>
      window.evaluate(async () => {
        const snapshot = await window.api.chat.getState({
          projectId: 'demo-ts-pnpm-vite',
          worktreeId: 'demo-main',
        });
        return snapshot.tabsFile.tabs.find(
          (tab) => tab.id === 'uncertain-watchers',
        );
      });
    const tab = await state();
    expect(tab.inputDelivery.rows[0].dismissedAt).toEqual(expect.any(Number));
    expect(tab.inputDelivery.rows[0].state).toBe('uncertain');
    expect(tab.inputDelivery.rows[0].attempts).toHaveLength(1);
    expect(tab.queuedMessages ?? []).toHaveLength(0);
    expect(tab.messages).toHaveLength(1);
    await window.reload();
    window = await open();
    await expect(window.getByTestId('input-delivery-row')).toHaveCount(2);
    await closeCanopy(electronApp, userDataDir, { keepUserData: true });
    electronApp = undefined;
    ({ electronApp } = await launchCanopy({ userDataDir }));
    window = await open();
    await expect(window.getByTestId('input-delivery-row')).toHaveCount(2);
    await window.getByTestId('input-delivery-bubble').first().hover();
    await window.getByTestId('input-delivery-dismiss').first().click();
    await expect(window.getByTestId('input-delivery-row')).toHaveCount(1);
    await window.getByTestId('input-delivery-bubble').hover();
    await window.getByTestId('input-delivery-dismiss').click();
    await expect(window.getByTestId('input-delivery-row')).toHaveCount(0);
    expect((await state()).messages).toHaveLength(1);
  } finally {
    if (electronApp) await closeCanopy(electronApp, userDataDir);
    cleanupDemoWorkspaces(demo);
  }
});
