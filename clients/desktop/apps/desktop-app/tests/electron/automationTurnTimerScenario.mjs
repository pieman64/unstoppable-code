import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import {
  createFixture,
  conversationRequests,
  closeFixture,
} from './codexPipelineRuntime.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { launchCanopy } from './launchCanopy.mjs';
import { readChatStorageTabs } from './readChatStorage.mjs';
import { seedAutomations } from './seeders/index.mjs';

export const AUTOMATION_TIMER_ACTIVITY_ID = 'automation-new-chat-timer';
export const AUTOMATION_TIMER_PROMPT =
  'Check the timer for this automation turn.';
export const AUTOMATION_TIMER_REPLY = 'Automation timer fixture completed.';

/**
 * `nativeSend` seeds the Home composer's deferred scheduled task, the one
 * worktree prompt that keeps the native send (D4) and with it the
 * `chat:hook-tab-started` notification. Other worktree prompts create their
 * chat through the shared port (CAN-5379), which the renderer learns about from
 * the canonical change stream instead.
 */
export function seedAutomationTurnTimerScenario({ nativeSend = false } = {}) {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-automation-turn-timer-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedAutomations({
    userDataDir,
    activities: [
      {
        version: 1,
        id: AUTOMATION_TIMER_ACTIVITY_ID,
        name: 'New Codex chat timer',
        enabled: true,
        schedule: {
          kind: 'one_time',
          runAt: '2099-06-01T15:00:00.000Z',
          timezone: 'local',
        },
        action: {
          type: 'worktree_prompt',
          workspaceId: 'demo-ts-pnpm-vite',
          baseWorktreeId: 'demo-main',
          prompt: AUTOMATION_TIMER_PROMPT,
          model: 'gpt-6-sol',
          ...(nativeSend ? { purpose: 'scheduled_task' } : {}),
        },
        createdAt: '2026-09-24T00:00:00.000Z',
        updatedAt: '2026-09-24T00:00:00.000Z',
        failureCount: 0,
      },
    ],
  });
  const fixture = createFixture('staged', AUTOMATION_TIMER_REPLY);
  return { userDataDir, fixture };
}

export async function runAutomationAndOpenNewChat({
  userDataDir,
  fixture,
  delayHookNotification = false,
}) {
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: fixture.env,
  });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openAutomationsPage();
    if (delayHookNotification) {
      // Hold only the real new-worktree start notification. The backend can
      // commit the prompt/timer and stream messages while the renderer hydrates
      // the new worktree; delivering the older tab snapshot afterward checks
      // that it cannot erase the live transcript.
      await electronApp.evaluate(({ BrowserWindow }) => {
        const sender = BrowserWindow.getAllWindows()[0].webContents;
        const originalSend = sender.send;
        globalThis.__automationTimerHeldHook = null;
        globalThis.__automationTimerRestoreHook = () => {
          sender.send = originalSend;
        };
        sender.send = function (channel, ...args) {
          if (
            channel === 'chat:hook-tab-started' &&
            args[0]?.projectId === 'demo-ts-pnpm-vite' &&
            args[0]?.worktreeId !== 'demo-main'
          ) {
            globalThis.__automationTimerHeldHook = {
              sender,
              originalSend,
              channel,
              args: structuredClone(args),
            };
            return;
          }
          return originalSend.call(this, channel, ...args);
        };
      });
    }
    await window
      .locator(
        `[data-testid="workflows-library-row"][data-row-key="automation:${AUTOMATION_TIMER_ACTIVITY_ID}"]`,
      )
      .getByTestId('workflows-library-run')
      .click();
    await expect
      .poll(
        () =>
          conversationRequests(fixture.logPath).filter(
            (request) =>
              request.method === 'turn/start' &&
              JSON.stringify(request.params).includes(AUTOMATION_TIMER_PROMPT),
          ).length,
        { timeout: 30_000 },
      )
      .toBe(1);
    if (delayHookNotification) {
      await expect
        .poll(() =>
          electronApp.evaluate(
            () => globalThis.__automationTimerHeldHook !== null,
          ),
        )
        .toBe(true);
    }
    await app.openMainPage();
    const newWorktreeRow = window.locator(
      '[data-testid="worktree-row"][data-project-id="demo-ts-pnpm-vite"]:not([data-worktree-id="demo-main"])',
    );
    await expect(newWorktreeRow).toHaveCount(1);
    const worktreeId = await newWorktreeRow.getAttribute('data-worktree-id');
    expect(worktreeId).toBeTruthy();
    await app.selectWorktree(worktreeId);
    let chatId;
    await expect
      .poll(() => {
        const tabs = readChatStorageTabs(
          path.join(userDataDir, 'workspaces', 'demo-ts-pnpm-vite'),
          worktreeId,
        ).tabs;
        chatId = tabs.find((tab) =>
          tab.messages?.some((message) =>
            message.blocks?.some(
              (block) =>
                block.type === 'text' && block.text === AUTOMATION_TIMER_PROMPT,
            ),
          ),
        )?.id;
        return chatId;
      })
      .toBeTruthy();
    await window.getByTestId(`panel-tab-panel-chat-${chatId}`).click();
    const panel = window
      .getByTestId('panel-content-chat')
      .filter({ hasText: AUTOMATION_TIMER_PROMPT });
    await expect(panel).toBeVisible();
    await expect(
      panel.getByText(AUTOMATION_TIMER_PROMPT, { exact: true }),
    ).toBeVisible();
    await expect(panel.getByTestId('turn-timer')).toHaveAttribute(
      'data-state',
      'live',
    );
    await expect(
      panel.getByText('E2E_CODEX_STREAM_007', { exact: true }),
    ).toBeVisible();
    if (delayHookNotification) {
      await window.evaluate((targetChatId) => {
        globalThis.__automationTimerHookArrived = new Promise((resolve) => {
          const unsubscribe = window.api.chat.onHookTabStarted((event) => {
            if (event.chatId !== targetChatId) return;
            unsubscribe();
            resolve();
          });
        });
      }, chatId);
      await deliverHeldAutomationHook(electronApp);
      await window.evaluate(async () => {
        await globalThis.__automationTimerHookArrived;
        await new Promise((resolve) => requestAnimationFrame(resolve));
        await new Promise((resolve) => requestAnimationFrame(resolve));
      });
    }
    return {
      electronApp,
      window,
      panel,
      timerVisibleAfterHook: await panel.getByTestId('turn-timer').isVisible(),
    };
  } catch (error) {
    releaseAutomationTurn(fixture);
    await restoreAutomationHookDelivery(electronApp);
    await closeFixture(electronApp, userDataDir, fixture.runtimeDir);
    throw error;
  }
}

async function deliverHeldAutomationHook(electronApp) {
  await electronApp.evaluate(() => {
    const held = globalThis.__automationTimerHeldHook;
    if (!held) throw new Error('Expected the automation chat start event');
    globalThis.__automationTimerRestoreHook?.();
    globalThis.__automationTimerRestoreHook = null;
    globalThis.__automationTimerHeldHook = null;
    held.originalSend.call(held.sender, held.channel, ...held.args);
  });
}

export async function restoreAutomationHookDelivery(electronApp) {
  await electronApp.evaluate(() => {
    globalThis.__automationTimerRestoreHook?.();
    globalThis.__automationTimerRestoreHook = null;
    globalThis.__automationTimerHeldHook = null;
  });
}

export function releaseAutomationTurn(fixture) {
  if (existsSync(fixture.runtimeDir)) {
    writeFileSync(fixture.releasePath, 'release\n');
  }
}
