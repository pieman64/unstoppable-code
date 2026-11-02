import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import {
  armClaudeQueryPrelude,
  DEFAULT_MOCK_BASE_URL,
  getScenarioActivity,
  readClaudeQueryPreludeState,
  registerScenario,
  seedWorkspaceApprovals,
  seedWorktreeChat,
} from './seeders/index.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { startPerformanceMonitor } from '../performance/monitor.mjs';
import { composerIdleAction } from './composerIdleAction.mjs';

const WORKSPACE_ID = 'demo-ts-pnpm-vite';
const WORKTREE_ID = 'demo-main';
const WORKTREE_BRANCH = 'demo-main';
const CONVERSATION_MARKER = 'Canopy-CFOREGROUNDLIFECYCLE';
const FIRST_REQUEST_TAG = 'foreground-first';
const LATER_REQUEST_TAG = 'foreground-later';
const FIRST_OUTPUT =
  'Foreground launch first output remains active for cancellation.';
const LATER_OUTPUT = 'Foreground later turn completed after cancellation';
const PRELUDE_CONVERSATION_MARKER = 'Canopy-CELKFOLLOWUP';
const PRELUDE_FIRST_REQUEST_TAG = 'prelude-first';
const PRELUDE_REPLACEMENT_REQUEST_TAG = 'prelude-replacement';
const PRELUDE_QUEUED_REQUEST_TAG = 'prelude-queued';
const PRELUDE_FIRST_OUTPUT =
  'Foreground interruption fixture is active before cancellation.';
const PRELUDE_FINAL_OUTPUT = 'Follow-up finished after interruption.';
const PRELUDE_QUEUED_OUTPUT = 'Queued work ran once after the real completion.';
const PRELUDE_QUEUED_INPUT = `[${PRELUDE_CONVERSATION_MARKER}] [Canopy-Mock-Request:${PRELUDE_QUEUED_REQUEST_TAG}] run this queued request next`;
const FIRST_STEP = {
  text: `${FIRST_OUTPUT} `.repeat(4),
  streamMs: 60_000,
  chunkChars: 64,
};
const LATER_STEP = {
  text: LATER_OUTPUT,
  stopReason: 'end_turn',
  streamMs: 1_000,
  chunkChars: 16,
};

async function llmRequestCount(requestTag) {
  const result = await getScenarioActivity(
    DEFAULT_MOCK_BASE_URL,
    CONVERSATION_MARKER,
  );
  return result.activity[`llmRequests:${requestTag}`] ?? 0;
}

async function scenarioLlmRequestCount(marker) {
  const result = await getScenarioActivity(DEFAULT_MOCK_BASE_URL, marker);
  return result.activity.llmRequests ?? 0;
}

async function activeTurnCount(page) {
  return page.evaluate(
    async ({ workspaceId, worktreeId }) => {
      const result = await window.api.chat.activeSessions({
        projectId: workspaceId,
        worktreeId,
      });
      return (result.sessions ?? []).filter((session) => session.turnActive)
        .length;
    },
    { workspaceId: WORKSPACE_ID, worktreeId: WORKTREE_ID },
  );
}

function descendantProcesses(rootPid) {
  const output = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,command='], {
    encoding: 'utf8',
  });
  const rows = output
    .split('\n')
    .map((line) => /^(\s*\d+)\s+(\d+)\s+(.+)$/.exec(line))
    .filter(Boolean)
    .map((match) => ({
      pid: Number(match[1]),
      parentPid: Number(match[2]),
      command: match[3],
    }));
  const descendants = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (descendants.has(row.parentPid) && !descendants.has(row.pid)) {
        descendants.add(row.pid);
        changed = true;
      }
    }
  }
  return rows.filter((row) => row.pid !== rootPid && descendants.has(row.pid));
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

test.describe('foreground Claude lifecycle responsiveness', () => {
  test('activates, cancels, delivers a later turn, keeps IPC live, and reaps the provider', async ({}, testInfo) => {
    test.setTimeout(180_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-foreground-claude-lifecycle-'),
    );
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    seedWorktreeChat({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      providerType: 'claude',
      tabs: [{ id: 't1', title: 'Foreground lifecycle' }],
    });
    await registerScenario(DEFAULT_MOCK_BASE_URL, CONVERSATION_MARKER, {
      llm: {
        steps: [FIRST_STEP, LATER_STEP],
        stepsByRequestTag: {
          [FIRST_REQUEST_TAG]: FIRST_STEP,
          [LATER_REQUEST_TAG]: LATER_STEP,
        },
      },
    });

    const { electronApp } = await launchCanopy({ userDataDir });
    let monitor;
    let closed = false;
    let foregroundProviderPids = [];
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();
      await app.selectWorktree(WORKTREE_BRANCH);

      const panel = window.getByTestId('panel-content-chat');
      const composer = panel.getByRole('textbox').first();
      const assistantMessages = panel.locator('[data-role="assistant"]');
      await expect(panel).toBeVisible();
      await expect(composer).toBeVisible();

      monitor = await startPerformanceMonitor({
        page: window,
        electronApp,
        sampleIntervalMs: 100,
        probeTimeoutMs: 5_000,
      });

      const firstStartedAt = performance.now();
      await composer.fill(
        `[${CONVERSATION_MARKER}] [Canopy-Mock-Request:${FIRST_REQUEST_TAG}] start a cancellable foreground turn`,
      );
      await panel.getByRole('button', { name: 'Send message' }).click();
      await expect
        .poll(() => activeTurnCount(window), { timeout: 60_000 })
        .toBeGreaterThanOrEqual(1);
      const firstTurnActiveMs = performance.now() - firstStartedAt;
      await expect
        .poll(() => llmRequestCount(FIRST_REQUEST_TAG), { timeout: 60_000 })
        .toBeGreaterThanOrEqual(1);
      const firstActivationMs = performance.now() - firstStartedAt;

      const stopButton = window.getByTestId('chat-stop-generation');
      await expect(stopButton).toBeVisible({ timeout: 30_000 });
      if (process.platform !== 'win32') {
        foregroundProviderPids = descendantProcesses(electronApp.process().pid)
          .filter((row) => /(?:^|\s)\S*\/claude(?:\s|$)/.test(row.command))
          .map((row) => row.pid);
        expect(foregroundProviderPids.length).toBeGreaterThan(0);
      }

      await stopButton.click();
      await expect(stopButton).toHaveCount(0, { timeout: 30_000 });
      await expect
        .poll(() => activeTurnCount(window), { timeout: 30_000 })
        .toBe(0);
      await expect(composerIdleAction(panel)).toBeVisible({ timeout: 30_000 });
      await expect(panel.getByRole('alert')).toHaveCount(0);

      const assistantCountBeforeLaterTurn = await assistantMessages.count();
      const requestsBeforeLaterTurn = await llmRequestCount(LATER_REQUEST_TAG);
      const laterStartedAt = performance.now();
      await composer.fill(
        `[${CONVERSATION_MARKER}] [Canopy-Mock-Request:${LATER_REQUEST_TAG}] run the later foreground turn`,
      );
      await panel.getByRole('button', { name: 'Send message' }).click();
      await expect
        .poll(() => activeTurnCount(window), { timeout: 60_000 })
        .toBeGreaterThanOrEqual(1);
      const laterTurnActiveMs = performance.now() - laterStartedAt;
      await expect
        .poll(() => llmRequestCount(LATER_REQUEST_TAG), { timeout: 60_000 })
        .toBeGreaterThan(requestsBeforeLaterTurn);
      const laterActivationMs = performance.now() - laterStartedAt;
      await expect(assistantMessages).toHaveCount(
        assistantCountBeforeLaterTurn + 1,
        { timeout: 60_000 },
      );
      await expect(
        assistantMessages.filter({ hasText: LATER_OUTPUT }).last(),
      ).toBeVisible({ timeout: 60_000 });
      const laterOutputMs = performance.now() - laterStartedAt;
      await expect(composerIdleAction(panel)).toBeVisible({ timeout: 30_000 });
      await expect(panel.getByRole('alert')).toHaveCount(0);

      const monitoring = await monitor.stop();
      monitor = null;
      expect(monitoring.summary.ipcErrorCount).toBe(0);
      expect(monitoring.summary.ipcTimeoutCount).toBe(0);
      expect(monitoring.summary.ipcOuterMs.count).toBeGreaterThanOrEqual(10);
      expect(monitoring.summary.ipcOuterMs.max).toBeLessThan(5_000);
      expect(monitoring.summary.rendererFrameDelayMs.max).toBeLessThan(500);
      await testInfo.attach('foreground-claude-lifecycle-metrics.json', {
        body: Buffer.from(
          JSON.stringify(
            {
              firstTurnActiveMs,
              firstActivationMs,
              laterTurnActiveMs,
              laterActivationMs,
              laterOutputMs,
              ipcOuterMs: monitoring.summary.ipcOuterMs,
              rendererFrameDelayMs: monitoring.summary.rendererFrameDelayMs,
              longTasks: monitoring.summary.longTasks,
              foregroundProviderPids,
            },
            null,
            2,
          ),
        ),
        contentType: 'application/json',
      });

      await closeCanopy(electronApp, userDataDir);
      closed = true;
      if (foregroundProviderPids.length > 0) {
        await expect
          .poll(
            () => foregroundProviderPids.every((pid) => !isProcessAlive(pid)),
            { timeout: 15_000 },
          )
          .toBe(true);
      }
    } finally {
      await monitor?.stop().catch(() => undefined);
      if (!closed) {
        await closeCanopy(electronApp, userDataDir);
      }
    }
  });

  test('tracks a replacement Claude turn when a task-notification prelude arrives before prompt consumption', async () => {
    test.setTimeout(240_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-elk-followup-tracking-'),
    );
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    seedWorkspaceApprovals({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      defaultMode: 'full-access',
    });
    seedWorktreeChat({
      userDataDir,
      workspaceId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      providerType: 'claude',
      activeTabId: 'elk-followup',
      tabs: [
        { id: 'sibling-chat', title: 'Sibling chat' },
        { id: 'elk-followup', title: 'Interrupted follow-up' },
      ],
    });
    const cancellableStep = {
      text: `${PRELUDE_FIRST_OUTPUT} `.repeat(4),
      streamMs: 60_000,
      chunkChars: 48,
    };
    const replacementSteps = [
      {
        thinking:
          'Following the replacement request through its real lifecycle.',
        toolCalls: [
          {
            name: 'mcp__canopy__GetScriptOutput',
            input: { scriptId: 'launch' },
          },
        ],
        stopReason: 'tool_use',
      },
      {
        text: PRELUDE_FINAL_OUTPUT,
        streamMs: 5_000,
        chunkChars: 12,
        stopReason: 'end_turn',
      },
    ];
    const queuedStep = { text: PRELUDE_QUEUED_OUTPUT, stopReason: 'end_turn' };
    await registerScenario(DEFAULT_MOCK_BASE_URL, PRELUDE_CONVERSATION_MARKER, {
      llm: {
        steps: [cancellableStep, ...replacementSteps, queuedStep],
        // Replies follow the request, not the history. The Claude CLI's side
        // requests also count as scenario requests, so Stop can land before
        // the first turn's own request is sent. That turn then leaves no
        // assistant turn, and history-indexed steps would all run one late.
        stepsByRequestTag: {
          [PRELUDE_FIRST_REQUEST_TAG]: cancellableStep,
          [PRELUDE_REPLACEMENT_REQUEST_TAG]: replacementSteps,
          [PRELUDE_QUEUED_REQUEST_TAG]: queuedStep,
        },
      },
    });

    const scope = {
      projectId: WORKSPACE_ID,
      worktreeId: WORKTREE_ID,
      chatId: 'elk-followup',
    };
    let firstLaunch = await launchCanopy({ userDataDir });
    let firstClosed = false;
    let secondLaunch;
    try {
      let window = await firstLaunch.electronApp.firstWindow();
      let app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();
      await app.selectWorktree(WORKTREE_BRANCH);

      let panel = window.locator(
        '[data-testid="panel-content-chat"][data-panel-id="panel-chat-elk-followup"]',
      );
      await expect(panel).toBeVisible({ timeout: 30_000 });
      let composer = panel.getByRole('textbox').first();
      // The prelude seam arms the chat's next SDK query. Stop interrupts the
      // native query and keeps it (turn-state phase 32), so the replacement
      // below streams into this first query rather than starting another.
      await armClaudeQueryPrelude(firstLaunch.electronApp, scope);
      await composer.fill(
        `[${PRELUDE_CONVERSATION_MARKER}] [Canopy-Mock-Request:${PRELUDE_FIRST_REQUEST_TAG}] begin cancellable work`,
      );
      await panel.getByRole('button', { name: 'Send message' }).click();
      await expect
        .poll(() => scenarioLlmRequestCount(PRELUDE_CONVERSATION_MARKER), {
          timeout: 60_000,
        })
        .toBeGreaterThanOrEqual(1);
      const stopButton = panel.getByTestId('chat-stop-generation');
      await expect(stopButton).toBeVisible({ timeout: 30_000 });
      await stopButton.click();
      await expect(stopButton).toHaveCount(0, { timeout: 30_000 });
      await expect
        .poll(() => activeTurnCount(window), { timeout: 30_000 })
        .toBe(0);

      await composer.fill(
        `[${PRELUDE_CONVERSATION_MARKER}] [Canopy-Mock-Request:${PRELUDE_REPLACEMENT_REQUEST_TAG}] finish the replacement request`,
      );
      await panel.getByRole('button', { name: 'Send message' }).click();

      await expect(panel.getByTestId('chat-stop-generation')).toBeVisible({
        timeout: 30_000,
      });
      await composer.fill(PRELUDE_QUEUED_INPUT);
      // The preceding submit can still be releasing the renderer's async
      // send guard. Retry Enter only while the queued draft remains present;
      // once accepted, the cleared editor prevents a duplicate submission.
      await expect
        .poll(
          async () => {
            const draft = await composer.evaluate((element) => {
              const content = element.cloneNode(true);
              content
                .querySelectorAll('[data-slate-placeholder]')
                .forEach((placeholder) => placeholder.remove());
              return (content.textContent ?? '')
                .replaceAll('\uFEFF', '')
                .trim();
            });
            if (draft !== '') await composer.press('Enter');
            return draft;
          },
          { timeout: 15_000 },
        )
        .toBe('');
      await expect(window.getByTestId('queued-message-bubble')).toHaveCount(1, {
        timeout: 30_000,
      });

      await expect
        .poll(
          async () =>
            readClaudeQueryPreludeState(firstLaunch.electronApp, scope),
          { timeout: 60_000 },
        )
        .toMatchObject({ consumedArmCount: 1, preludeEmittedCount: 1 });
      await expect(panel.getByText('Script Output').first()).toBeVisible({
        timeout: 90_000,
      });
      await expect(panel.getByText(PRELUDE_FINAL_OUTPUT).first()).toBeVisible({
        timeout: 90_000,
      });
      await expect(panel.getByText(PRELUDE_QUEUED_OUTPUT).first()).toBeVisible({
        timeout: 90_000,
      });
      // That one query consumed the first, replacement and queued prompts.
      expect(
        (await readClaudeQueryPreludeState(firstLaunch.electronApp, scope))
          .promptConsumedCount,
      ).toBe(3);
      await expect
        .poll(() => scenarioLlmRequestCount(PRELUDE_CONVERSATION_MARKER), {
          timeout: 30_000,
        })
        .toBeGreaterThanOrEqual(4);
      await expect(
        panel.getByText(PRELUDE_QUEUED_OUTPUT, { exact: true }),
      ).toHaveCount(1);
      await expect(panel.getByRole('alert')).toHaveCount(0);
      await expect(panel.getByTestId('turn-timer').last()).toHaveAttribute(
        'data-state',
        'completed',
      );
      await expect(composerIdleAction(panel)).toBeVisible({ timeout: 30_000 });
      await expect
        .poll(() => activeTurnCount(window), { timeout: 30_000 })
        .toBe(0);

      await expect
        .poll(async () => {
          return window.evaluate(
            async ({ expected, queuedInput, scope: chatScope }) => {
              const state = await window.api.chat.getState({
                projectId: chatScope.projectId,
                worktreeId: chatScope.worktreeId,
              });
              const target = state.tabsFile.tabs.find(
                (tab) => tab.id === chatScope.chatId,
              );
              const sibling = state.tabsFile.tabs.find(
                (tab) => tab.id === 'sibling-chat',
              );
              const audit = await window.api.observability.loadSnapshot();
              const completedEntries = audit.recentEntries.filter(
                (entry) =>
                  entry.chatId === chatScope.chatId &&
                  entry.status === 'success',
              );
              const transcripts = await Promise.all(
                completedEntries.map((entry) =>
                  window.api.observability.loadTranscript(entry),
                ),
              );
              return {
                targetHasFinal: JSON.stringify(target?.messages ?? []).includes(
                  expected,
                ),
                targetHasToolResult: JSON.stringify(
                  target?.messages ?? [],
                ).includes('mcp__canopy__GetScriptOutput'),
                queuedUserMessageCount: (target?.messages ?? []).filter(
                  (message) =>
                    message.role === 'user' &&
                    JSON.stringify(message).includes(queuedInput),
                ).length,
                siblingMessageCount: sibling?.messages?.length ?? -1,
                auditCompleted: transcripts.some(
                  (transcript) =>
                    transcript.type === 'success' &&
                    transcript.lines.some((line) => line.includes(expected)),
                ),
              };
            },
            {
              expected: PRELUDE_FINAL_OUTPUT,
              queuedInput: PRELUDE_QUEUED_INPUT,
              scope,
            },
          );
        })
        .toEqual({
          targetHasFinal: true,
          targetHasToolResult: true,
          queuedUserMessageCount: 1,
          siblingMessageCount: 0,
          auditCompleted: true,
        });

      await closeCanopy(firstLaunch.electronApp, userDataDir, {
        keepUserData: true,
      });
      firstClosed = true;

      secondLaunch = await launchCanopy({ userDataDir });
      window = await secondLaunch.electronApp.firstWindow();
      app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();
      await app.selectWorktree(WORKTREE_BRANCH);
      panel = window.locator(
        '[data-testid="panel-content-chat"][data-panel-id="panel-chat-elk-followup"]',
      );
      await expect(panel.getByText(PRELUDE_FINAL_OUTPUT).first()).toBeVisible({
        timeout: 60_000,
      });
      await expect(
        panel.getByText(PRELUDE_QUEUED_OUTPUT, { exact: true }),
      ).toHaveCount(1);
      await expect
        .poll(
          () =>
            window.evaluate(async (chatScope) => {
              const state = await window.api.chat.getState({
                projectId: chatScope.projectId,
                worktreeId: chatScope.worktreeId,
              });
              const target = state.tabsFile.tabs.find(
                (tab) => tab.id === chatScope.chatId,
              );
              return JSON.stringify(target?.messages ?? []).includes(
                'mcp__canopy__GetScriptOutput',
              );
            }, scope),
          { timeout: 30_000 },
        )
        .toBe(true);
      await expect(panel.getByTestId('turn-timer').last()).toHaveAttribute(
        'data-state',
        'completed',
      );
    } finally {
      if (secondLaunch) {
        await closeCanopy(secondLaunch.electronApp, userDataDir);
      } else if (!firstClosed) {
        await closeCanopy(firstLaunch.electronApp, userDataDir);
      }
    }
  });
});
