// User stop controls and the busy root chat for managed delegation
// (docs/planning/2026-09-28-delegation-root-cause/README.md §3 E and F).
//
// The delegation tree belongs to the root chat, not to its provider session:
// the composer's Stop ends only the parent turn, delegates run on after the
// parent goes idle, and the user stops them from the composer's background
// drawer. While any delegate is queued or running the chat stays open and
// shows as working.
//
//   * row-stop-subtree: the composer's Stop ends the parent turn while a
//     delegate and the task it started keep running and stay listed in the
//     drawer; the delegate's row Stop then settles it `Cancelled` and its
//     running child `Stopped by parent`.
//   * stop-all: Stop all delegates asks inline, Keep running dismisses it,
//     and Stop all stops a running and a queued delegation while the
//     parent's own background process keeps running.
//   * single-delegate-stop: a lone delegate stops from its drawer row; the
//     drawer offers Stop all only beside two or more delegates.
//   * busy-chat: with a delegate running and the parent idle, the chat tab
//     shows the working spinner and withholds its ×, Cmd/Ctrl+W, the tab
//     menu's Close and Close group leave it open with a notice, the sidebar
//     row shows working with Archive disabled, a renderer reload keeps all of
//     it, and once the delegate finishes the chat closes normally.
//   * deferred-auto-archive: auto-archive turned on during the run archives
//     the chat only after its delegate finishes.
//   * watch-chain: a delegate that went idle to watch the task it started
//     leaves the running rows as soon as it finishes, while the chat keeps up
//     with a busy tree; the task's row Stop then settles instead of staying at
//     `Stopping…`, and the watching delegate hears of it and finishes.
//   * watch-chain-row-stop: a delegate stopped while it watches its task is
//     not woken into a new run by that task's stop.
//   * watch-chain-stop-all: Stop all ends a chain whose delegate idles on a
//     watch, and that delegate is not woken afterwards.
//
// The `cancel` and `nested-cancel` cases in managed-delegation.spec.mjs cover
// the composer Stop and the row Stop across both harnesses and both execution
// modes; the agent stop's `Stopped by parent` label is covered by its `stop`
// case and managed-delegation-queue.spec.mjs.
//
// Determinism: real Claude binaries run against the scripted inference in
// delegationRuntime.mjs (its `script` hook); each child reads the evidence
// file and then holds on the fixture's barrier until the test releases it.
import {
  mkdtempSync,
  writeFileSync,
  readdirSync,
  readFileSync,
  existsSync,
} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { expect as baseExpect, test } from '@playwright/test';
import { hostOperatingSystem } from '@canopy/core-platform/host-platform';
import { openBackgroundDrawer } from './backgroundDrawer.mjs';
import { CanopyAppDriver } from './canopyApp.mjs';
import {
  seedDemoWorkspaces,
  cleanupDemoWorkspaces,
} from './demoWorkspaces.mjs';
import { seedWorktreeChat, seedWorkspaceApprovals } from './seeders/index.mjs';
import { launchCanopy, closeCanopy } from './launchCanopy.mjs';
import { injectApprovalRequestEvent } from './seeders/injectApprovalRequestEvent.mjs';
import {
  claudeToolName,
  createDelegationInference,
} from './delegationRuntime.mjs';
import { composerIdleAction } from './composerIdleAction.mjs';

// Windows qualification runs under emulation, where native provider turns
// take several times longer than on macOS. Mirrors managed-delegation.spec.mjs.
const hostPlatform = hostOperatingSystem();
const TIMEOUT_SCALE = hostPlatform === 'win32' ? 3 : 1;
const scaled = (ms) => ms * TIMEOUT_SCALE;
const expect = baseExpect.configure({ timeout: scaled(15_000) });

const workspaceId = 'demo-ts-pnpm-vite';
const worktreeId = 'demo-main';
const chatId = 'delegating-parent';
const chatPanelId = `panel-chat-${chatId}`;
const CLOSE_NOTICE =
  'Delegates are still running. Open background work and stop them to close this chat.';

function retainedRuns(userDataDir) {
  const directory = path.join(
    userDataDir,
    'workspaces',
    workspaceId,
    'worktree-data',
    worktreeId,
    'delegation',
    'runs',
  );
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .map((name) =>
      JSON.parse(readFileSync(path.join(directory, name), 'utf8')),
    );
}

function runsByDepth(userDataDir) {
  return Object.fromEntries(
    retainedRuns(userDataDir).map((run) => [run.depth, run]),
  );
}

// Watchers that would wake a delegate, as the watcher service persists them.
function pendingDelegateWatchers(userDataDir) {
  const file = path.join(userDataDir, 'app-advisor-watchers.json');
  if (!existsSync(file)) return [];
  return (JSON.parse(readFileSync(file, 'utf8')).watchers ?? []).filter(
    (watcher) =>
      (watcher.status === 'active' || watcher.status === 'firing') &&
      (watcher.destination?.delegationId !== undefined ||
        watcher.runtimeState?.recipient?.kind === 'delegate'),
  );
}

// Mirrors broker.ts delegationPhase(): 'queued' is 'pending' plus an
// admission record still waiting for the current run generation.
function isQueued(run) {
  return (
    run.state.status === 'pending' &&
    run.admission?.state === 'waiting' &&
    run.admission.runGeneration === run.state.runGeneration
  );
}

function delegatedCard(surface, delegationId) {
  return surface.locator(
    `[data-testid="chat-delegated-agent"][data-delegation-id="${delegationId}"]`,
  );
}

// The first user message a native request carries names its role; later
// tool results may quote a nested task's prompt, so the latest text cannot.
function chainRole(ctx) {
  const first = JSON.stringify(
    (ctx.body.messages ?? ctx.body.input ?? []).find(
      (item) => item.role === 'user',
    )?.content ?? '',
  );
  if (first.includes(ctx.markers.grandchild)) return 'grandchild';
  if (first.includes(ctx.markers.child)) return 'child';
  return ctx.role;
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function setUpFixture({ caseId, script, maxConcurrent, maxDepth }) {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'managed-delegation-stop-'),
  );
  const fixture = await createDelegationInference({
    parent: 'claude',
    child: 'claude',
    mode: 'background',
    caseId,
    script,
  });
  const demo = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  writeFileSync(
    path.join(demo.workspaces[0].worktreePath, 'delegation-evidence.txt'),
    `// ${fixture.canary}\n`,
  );
  seedWorkspaceApprovals({
    userDataDir,
    workspaceId,
    defaultMode: 'full-access',
  });
  writeFileSync(
    path.join(userDataDir, 'preferences.json'),
    JSON.stringify({
      version: 1,
      preferences: {
        managedDelegationMode: 'explicit-only',
        ...(maxConcurrent !== undefined
          ? { managedDelegationMaxConcurrent: maxConcurrent }
          : {}),
        ...(maxDepth !== undefined
          ? { managedDelegationMaxDepth: maxDepth }
          : {}),
        onboardingCompleted: ['v1'],
        defaultChatInterfaceMode: 'canopy',
        defaultWorktreeProvider: 'claude',
        defaultChatProvider: 'claude',
      },
    }),
  );
  seedWorktreeChat({
    userDataDir,
    workspaceId,
    worktreeId,
    tabs: [
      {
        id: chatId,
        title: 'Delegating parent',
        providerType: 'claude',
        executionHarness: 'claude',
        model: 'claude-sonnet-4-6',
        approvalMode: 'full-access',
      },
    ],
  });
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: { CANOPY_MOCK_LLM_BASE_URL: fixture.url },
  });
  return { userDataDir, fixture, demo, electronApp };
}

/** A delegate's drawer row. */
function delegateRow(tray, delegationId) {
  return tray.locator(`[data-tray-row="agent:managed:${delegationId}"]`);
}

async function openDelegatingChat(electronApp) {
  const window = await electronApp.firstWindow();
  const app = new CanopyAppDriver(window);
  await app.waitForShell();
  await app.openMainPage();
  await app.selectWorktree('demo-main');
  const panel = window.getByTestId('panel-content-chat');
  await expect(panel).toBeVisible();
  return { window, app, panel };
}

async function sendParentMessage(window, fixture, text) {
  const composer = window.getByRole('textbox').first();
  await composer.fill(`[${fixture.parentMarker}] ${text}`);
  await window.getByRole('button', { name: 'Send message' }).click();
}

async function waitForChildBlocked(fixture) {
  await expect
    .poll(
      () =>
        fixture.requests.some(
          (request) => request.role === 'child' && request.hasNativeEvidence,
        ),
      { timeout: scaled(120_000) },
    )
    .toBe(true);
}

async function chatState(window) {
  const state = await window.evaluate(
    async ({ projectId, worktreeId }) =>
      window.api.chat.getState({ projectId, worktreeId }),
    { projectId: workspaceId, worktreeId },
  );
  return {
    live: state.tabsFile.tabs.some((tab) => tab.id === chatId),
    archived: state.archives.some((entry) => entry.chatId === chatId),
  };
}

async function finish(testInfo, context, assertionsCompleted) {
  const { userDataDir, fixture, demo, electronApp } = context;
  fixture.releaseChild();
  if (!assertionsCompleted)
    await testInfo.attach('failure-user-data-directory', {
      body: userDataDir,
      contentType: 'text/plain',
    });
  await closeCanopy(electronApp, userDataDir, {
    keepUserData: !assertionsCompleted,
  });
  await fixture.close();
  if (assertionsCompleted) cleanupDemoWorkspaces(demo);
}

test('stop-all: confirms in a dialog, Cancel dismisses, and Stop all leaves the background process', async ({}, testInfo) => {
  test.setTimeout(scaled(240_000));
  // Holds the parent turn open after its tool calls, so the turn's own
  // background process shares the composer's background drawer with the
  // delegations.
  const parentHold = deferred();
  const context = await setUpFixture({
    caseId: 'stop-all',
    maxConcurrent: 1,
    script: async (ctx) => {
      if (ctx.role !== 'parent') return undefined;
      if (!ctx.results)
        return ctx.reply({
          toolCalls: [
            {
              name: ctx.spawnTool,
              input: { ...ctx.spawnInput, description: 'First review' },
            },
            {
              name: ctx.spawnTool,
              input: { ...ctx.spawnInput, description: 'Second review' },
            },
            {
              name: 'Bash',
              input: {
                command: 'sleep 600',
                run_in_background: true,
                description: 'Keep the preview server running',
              },
            },
          ],
          stopReason: 'tool_use',
        });
      await parentHold.promise;
      return ctx.reply({ text: ctx.continued, stopReason: 'end_turn' });
    },
  });
  const { userDataDir, fixture, electronApp } = context;
  let assertionsCompleted = false;
  try {
    const { window, panel } = await openDelegatingChat(electronApp);
    await sendParentMessage(
      window,
      fixture,
      'Delegate two independent reviews and keep the preview server running.',
    );
    await waitForChildBlocked(fixture);
    // One slot: the first delegation runs, the second waits in the queue.
    await expect
      .poll(() => {
        const runs = retainedRuns(userDataDir);
        return (
          runs.length === 2 &&
          runs.filter((run) => run.state.status === 'running').length === 1 &&
          runs.filter(isQueued).length === 1
        );
      })
      .toBe(true);

    const tray = await openBackgroundDrawer(panel, { timeout: scaled(30_000) });
    await expect(tray.getByTestId('background-tray-agent')).toHaveCount(2);
    const process = tray
      .getByTestId('background-tray-row')
      .filter({ hasText: 'Keep the preview server running' });
    await expect(process).toBeVisible({ timeout: scaled(30_000) });
    // Every live delegate row, queued or running, has its own Stop.
    await expect(tray.getByTestId('background-tray-agent-stop')).toHaveCount(2);

    // The heading action confirms in a dialog before stopping anything.
    const stopAll = tray.getByTestId('background-tray-stop-all');
    await expect(stopAll).toHaveText('Stop all delegates');
    await stopAll.click();
    const confirmation = window.getByTestId(
      'background-tray-stop-all-confirmation',
    );
    await expect(confirmation).toContainText('Stop 2 delegations?');
    await expect(
      window.getByTestId('background-tray-stop-all-confirm'),
    ).toHaveText('Stop all');
    const keepRunning = window.getByTestId('background-tray-stop-all-cancel');
    await expect(keepRunning).toHaveAccessibleName('Cancel');
    // Focus moves to the safe choice.
    await expect(keepRunning).toBeFocused();
    await keepRunning.click();
    await expect(confirmation).toHaveCount(0);
    await expect(stopAll).toBeVisible();
    expect(
      retainedRuns(userDataDir).filter(
        (run) => run.state.status === 'cancelled',
      ),
    ).toEqual([]);

    await stopAll.click();
    await window.getByTestId('background-tray-stop-all-confirm').click();
    await expect
      .poll(
        () =>
          retainedRuns(userDataDir).map((run) => ({
            status: run.state.status,
            stopReason: run.state.stopReason,
            cancelledByUser: run.state.cancelledByUser,
          })),
        { timeout: scaled(30_000) },
      )
      .toEqual([
        {
          status: 'cancelled',
          stopReason: 'user_cancelled',
          cancelledByUser: true,
        },
        {
          status: 'cancelled',
          stopReason: 'user_cancelled',
          cancelledByUser: true,
        },
      ]);
    // The queued delegation never launched a native child.
    expect(
      fixture.requests.filter((request) => request.role === 'child').length,
    ).toBeLessThanOrEqual(2);
    // Nothing managed is live any more, so Stop all and the rows go; the
    // parent's own background process is untouched.
    await expect(tray.getByTestId('background-tray-stop-all')).toHaveCount(0);
    await expect(tray.getByTestId('background-tray-agent')).toHaveCount(0);
    await expect(process).toBeVisible();
    await expect(process.getByTestId('background-tray-row-stop')).toBeVisible();
    // A user stop reads `Cancelled` on each card.
    const transcript = panel.getByTestId('chat-message-list-content');
    for (const run of retainedRuns(userDataDir))
      await expect(
        delegatedCard(transcript, run.state.delegationId).getByTestId(
          'delegated-agent-status',
        ),
      ).toHaveText('Cancelled');

    parentHold.resolve();
    await expect(
      panel.getByText(fixture.continued, { exact: true }),
    ).toBeVisible({ timeout: scaled(60_000) });
    assertionsCompleted = true;
  } finally {
    parentHold.resolve();
    await finish(testInfo, context, assertionsCompleted);
  }
});

test('single-delegate-stop: a lone delegate stops from its drawer row, with no Stop all', async ({}, testInfo) => {
  test.setTimeout(scaled(240_000));
  const parentHold = deferred();
  const context = await setUpFixture({
    caseId: 'foreground-only-stop-all',
    script: async (ctx) => {
      if (ctx.role !== 'parent') return undefined;
      if (!ctx.results)
        return ctx.reply({
          toolCalls: [{ name: ctx.spawnTool, input: ctx.spawnInput }],
          stopReason: 'tool_use',
        });
      await parentHold.promise;
      return ctx.reply({ text: ctx.continued, stopReason: 'end_turn' });
    },
  });
  const { userDataDir, fixture, electronApp } = context;
  let assertionsCompleted = false;
  try {
    const { window, panel } = await openDelegatingChat(electronApp);
    await sendParentMessage(window, fixture, 'Delegate an independent review.');
    await waitForChildBlocked(fixture);

    // The drawer offers Stop all only beside two or more delegates; a lone
    // one stops from its row.
    const tray = await openBackgroundDrawer(panel, { timeout: scaled(30_000) });
    await expect(tray.getByTestId('background-tray-agent')).toHaveCount(1);
    await expect(tray.getByTestId('background-tray-row')).toHaveCount(0);
    await expect(tray.getByTestId('background-tray-stop-all')).toHaveCount(0);
    await tray.getByTestId('background-tray-agent-stop').click();
    await expect
      .poll(() => retainedRuns(userDataDir)[0]?.state.status, {
        timeout: scaled(60_000),
      })
      .toBe('cancelled');
    assertionsCompleted = true;
  } finally {
    parentHold.resolve();
    await finish(testInfo, context, assertionsCompleted);
  }
});

test('row-stop-subtree: the composer Stop leaves delegates running, and a row Stop ends the delegate and its task', async ({}, testInfo) => {
  test.setTimeout(scaled(300_000));
  // Holds the parent turn open so its composer Stop is available.
  const parentHold = deferred();
  const context = await setUpFixture({
    caseId: 'row-stop-subtree',
    maxDepth: 2,
    script: async (ctx) => {
      if (ctx.role === 'parent') {
        if (!ctx.results)
          return ctx.reply({
            toolCalls: [
              {
                name: ctx.spawnTool,
                input: { ...ctx.spawnInput, allow_nested_delegation: true },
              },
            ],
            stopReason: 'tool_use',
          });
        await parentHold.promise;
        return ctx.reply({ text: ctx.continued, stopReason: 'end_turn' });
      }
      if (ctx.role !== 'child') return undefined;
      // The delegate starts one task of its own and stays live, waiting on
      // the fixture's barrier, while that task runs.
      if (!ctx.results)
        return ctx.reply({
          toolCalls: [
            {
              name: claudeToolName('DelegateTask'),
              input: {
                model: 'sonnet',
                description: 'Nested evidence review',
                prompt: `[${ctx.markers.grandchild}] Read delegation-evidence.txt and report evidence.`,
                run_in_background: true,
              },
            },
          ],
          stopReason: 'tool_use',
        });
      await ctx.childBarrier;
      return ctx.reply({ text: ctx.finding, stopReason: 'end_turn' });
    },
  });
  const { userDataDir, fixture, electronApp } = context;
  let assertionsCompleted = false;
  try {
    const { window, panel } = await openDelegatingChat(electronApp);
    await sendParentMessage(
      window,
      fixture,
      'Delegate an independent review that may start its own task.',
    );
    await expect
      .poll(
        () =>
          fixture.requests.some(
            (request) =>
              request.role === 'grandchild' && request.hasNativeEvidence,
          ),
        { timeout: scaled(120_000) },
      )
      .toBe(true);
    const byDepth = () =>
      Object.fromEntries(
        retainedRuns(userDataDir).map((run) => [run.depth, run]),
      );
    await expect
      .poll(() => [byDepth()[1]?.state.status, byDepth()[2]?.state.status])
      .toEqual(['running', 'running']);
    const { 1: delegate, 2: task } = byDepth();

    // The composer's Stop ends only the parent turn.
    const composerStop = window.getByTestId('chat-stop-generation');
    await expect(composerStop).toBeVisible();
    await composerStop.click();
    await expect(composerStop).toHaveCount(0, { timeout: scaled(30_000) });
    // Allow a wrong cancellation time to land before reading the runs back.
    await new Promise((resolve) => setTimeout(resolve, scaled(2_000)));
    expect([byDepth()[1]?.state.status, byDepth()[2]?.state.status]).toEqual([
      'running',
      'running',
    ]);
    const tray = await openBackgroundDrawer(panel, { timeout: scaled(30_000) });
    const parentRow = delegateRow(tray, delegate.state.delegationId);
    await expect(parentRow).toBeVisible();
    await expect(delegateRow(tray, task.state.delegationId)).toBeVisible();

    // The delegate's Stop names what it will also end.
    const rowStop = parentRow.getByTestId('background-tray-agent-stop');
    await expect(rowStop).toHaveAccessibleName('Stop delegation');
    await rowStop.hover();
    await expect(
      window
        .getByRole('tooltip')
        .filter({ hasText: 'Stop delegation and the tasks it started' }),
    ).toBeVisible();
    await rowStop.click();
    await expect
      .poll(() => [byDepth()[1]?.state.status, byDepth()[2]?.state.status], {
        timeout: scaled(30_000),
      })
      .toEqual(['cancelled', 'cancelled']);
    expect(byDepth()[1].state).toMatchObject({
      stopReason: 'user_cancelled',
      cancelledByUser: true,
      stoppedBy: { kind: 'user' },
    });
    expect(byDepth()[2].state).toMatchObject({
      stopReason: 'ancestor_stopped',
      stoppedBy: { kind: 'user' },
      error: {
        code: 'terminated_by_parent',
        message:
          "Stopped because you stopped 'Independent error handling review'.",
      },
    });
    await expect(tray.getByTestId('background-tray-agent')).toHaveCount(0);

    // The user's own stop reads `Cancelled`; the task it ended reads
    // `Stopped by parent`.
    const transcript = panel.getByTestId('chat-message-list-content');
    const delegateCard = delegatedCard(
      transcript,
      delegate.state.delegationId,
    ).first();
    const taskCard = delegatedCard(transcript, task.state.delegationId).first();
    await expect(async () => {
      // The stopped turn collapsed its steps behind an "Agent steps" summary.
      for (const summary of await panel
        .getByRole('button', { name: /^Agent steps:/, expanded: false })
        .all())
        await summary.click({ timeout: 2_000 });
      if (!(await taskCard.isVisible())) {
        const toggle = delegateCard
          .getByRole('button', { name: 'Expand delegated task' })
          .first();
        if (await toggle.isVisible()) await toggle.click({ timeout: 2_000 });
      }
      await expect(
        delegateCard.getByTestId('delegated-agent-status').first(),
      ).toHaveText('Cancelled', { timeout: 1_000 });
      await expect(
        taskCard.getByTestId('delegated-agent-status').first(),
      ).toHaveText('Stopped by parent', { timeout: 1_000 });
    }).toPass({ timeout: scaled(30_000) });
    await expect(transcript.getByTestId('delegated-agent-stop')).toHaveCount(0);
    assertionsCompleted = true;
  } finally {
    parentHold.resolve();
    await finish(testInfo, context, assertionsCompleted);
  }
});

test('busy-chat: a chat with a running delegate stays open and working until it finishes', async ({}, testInfo) => {
  test.setTimeout(scaled(300_000));
  const context = await setUpFixture({ caseId: 'busy-chat' });
  const { userDataDir, fixture, electronApp } = context;
  let assertionsCompleted = false;
  try {
    const { window, app, panel } = await openDelegatingChat(electronApp);
    await sendParentMessage(
      window,
      fixture,
      'Delegate an independent review in the background.',
    );
    // The parent's own turn ends while its delegate keeps running.
    await expect(
      panel.getByText(fixture.continued, { exact: true }),
    ).toBeVisible({ timeout: scaled(120_000) });
    await waitForChildBlocked(fixture);
    await expect(composerIdleAction(window)).toBeVisible();
    await expect(window.getByTestId('chat-stop-generation')).toHaveCount(0);
    expect(retainedRuns(userDataDir).map((run) => run.state.status)).toEqual([
      'running',
    ]);

    const tab = window.getByTestId(`panel-tab-${chatPanelId}`);
    const spinner = tab.locator('[aria-label="Thinking"]');
    const tabClose = window.getByTestId(`panel-tab-close-${chatPanelId}`);
    // The branch gets a generated name once the chat starts, so select the
    // row by its worktree id.
    const row = window.locator(
      `[data-testid="worktree-row"][data-worktree-id="${worktreeId}"]`,
    );
    // The parent's own turn has ended, so its delegate draws the row's
    // background spinner, not the streaming one (turn-state 38a and 38b).
    const rowSpinner = row.getByTestId(
      'worktree-row-classic-background-spinner',
    );
    const rowStreaming = row.getByTestId(
      'worktree-row-classic-streaming-spinner',
    );
    const notice = window
      .getByTestId('toast-card')
      .filter({ hasText: CLOSE_NOTICE });

    const expectBusy = async () => {
      // Working, not closable: the spinner holds the tab's leading slot and
      // the tab offers no ×, even under the pointer.
      await expect(spinner).toBeVisible();
      await tab.hover();
      await expect(spinner).toBeVisible();
      await expect(tabClose).toHaveCount(0);
      await expect(rowSpinner).toBeVisible();
      await expect(rowStreaming).toHaveCount(0);
    };
    await expectBusy();

    // A delegate waiting for parent approval no longer streams, but it still
    // owns the worktree and keeps removal actions disabled.
    await injectApprovalRequestEvent(electronApp, {
      requestId: 'delegate-pending-approval',
      projectId: workspaceId,
      worktreeId,
      chatId,
      provider: 'claude',
      title: 'Run delegated command',
      details: { kind: 'command', command: 'git status' },
      suggestedTarget: { kind: 'command', pattern: 'git status' },
    });
    await expect(window.getByTestId('tool-approval-card')).toBeVisible();
    await expect(rowStreaming).toHaveCount(0);
    await row.hover();
    await row.getByTestId('worktree-actions-menu-button').click();
    await expect(
      window.getByTestId('worktree-actions-menu-archive'),
    ).toBeDisabled();
    await window.keyboard.press('Escape');
    await window.getByTestId('tool-approval-allow').click();
    await expect(window.getByTestId('tool-approval-card')).toHaveCount(0);
    await expectBusy();

    // Cmd/Ctrl+W leaves it open and says why.
    await tab.click();
    await window.keyboard.press('ControlOrMeta+w');
    await expect(notice).toBeVisible();
    await expect(tab).toBeVisible();

    // The tab menu's Close is disabled.
    await tab.click({ button: 'right' });
    const menu = window.getByTestId('panel-tab-context-menu');
    await expect(menu).toBeVisible();
    await expect(window.getByTestId('panel-tab-context-close')).toBeDisabled();
    await window.keyboard.press('Escape');
    await expect(menu).toBeHidden();

    // Close group keeps the busy chat (and so its group) open.
    await window.getByTestId('panel-group-menu-group-chat').click();
    await window.getByTestId('panel-group-close-group-chat').click();
    await expect(tab).toBeVisible();
    await expect(window.getByTestId('panel-group-group-chat')).toBeVisible();
    await expect(notice).toBeVisible();
    expect(await chatState(window)).toEqual({ live: true, archived: false });

    // The sidebar row is working, so Archive is disabled.
    await row.hover();
    await row.getByTestId('worktree-actions-menu-button').click();
    await expect(
      window.getByTestId('worktree-actions-menu-archive'),
    ).toBeDisabled();
    await window.keyboard.press('Escape');
    await expect(
      window.getByTestId('worktree-actions-menu-archive'),
    ).toHaveCount(0);

    // A renderer reload rehydrates all of it from main.
    await window.reload();
    await app.waitForShell();
    await app.openMainPage();
    await app.selectWorktree('demo-main');
    await expectBusy();
    expect(retainedRuns(userDataDir).map((run) => run.state.status)).toEqual([
      'running',
    ]);

    // Once the delegate finishes, the chat is an ordinary idle chat.
    fixture.releaseChild();
    await expect
      .poll(() => retainedRuns(userDataDir)[0]?.state.status, {
        timeout: scaled(60_000),
      })
      .toBe('completed');
    await expect(spinner).toHaveCount(0);
    await expect(rowSpinner).toHaveCount(0);
    await row.hover();
    await row.getByTestId('worktree-actions-menu-button').click();
    await expect(
      window.getByTestId('worktree-actions-menu-archive'),
    ).toBeEnabled();
    await window.keyboard.press('Escape');
    await tab.hover();
    await expect(tabClose).toBeVisible();

    await tab.click();
    await window.keyboard.press('ControlOrMeta+w');
    await expect(tab).toHaveCount(0);
    await expect.poll(async () => (await chatState(window)).live).toBe(false);
    assertionsCompleted = true;
  } finally {
    await finish(testInfo, context, assertionsCompleted);
  }
});

test('pending delegate input keeps Archive disabled for an idle parent chat', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'managed-delegation-pending-removal-'),
  );
  const demo = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedWorktreeChat({
    userDataDir,
    workspaceId,
    worktreeId,
    tabs: [{ id: chatId, title: 'Idle parent', providerType: 'claude' }],
  });
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const { window } = await openDelegatingChat(electronApp);
    await electronApp.evaluate(
      ({ BrowserWindow }, activity) => {
        BrowserWindow.getAllWindows()[0].webContents.send(
          'managed-delegation:activity-changed',
          activity,
        );
      },
      { projectId: workspaceId, worktreeId, chatId, live: 1, queued: 0 },
    );
    const row = window.locator(
      `[data-testid="worktree-row"][data-worktree-id="${worktreeId}"]`,
    );
    // An idle parent's live delegate is background work.
    await expect(
      row.getByTestId('worktree-row-classic-background-spinner'),
    ).toBeVisible();
    await injectApprovalRequestEvent(electronApp, {
      requestId: 'idle-parent-pending-approval',
      projectId: workspaceId,
      worktreeId,
      chatId,
      provider: 'claude',
      title: 'Run delegated command',
      details: { kind: 'command', command: 'git status' },
      suggestedTarget: { kind: 'command', pattern: 'git status' },
    });
    await expect(window.getByTestId('tool-approval-card')).toBeVisible();
    await expect(
      row.getByTestId('worktree-row-classic-streaming-spinner'),
    ).toHaveCount(0);
    await row.hover();
    await row.getByTestId('worktree-actions-menu-button').click();
    await expect(
      window.getByTestId('worktree-actions-menu-archive'),
    ).toBeDisabled();
  } finally {
    await closeCanopy(electronApp, userDataDir);
    cleanupDemoWorkspaces(demo);
  }
});

test('deferred-auto-archive: auto-archive turned on during the run waits for the delegate', async ({}, testInfo) => {
  test.setTimeout(scaled(300_000));
  const parentHold = deferred();
  let autoArchiveResult;
  const context = await setUpFixture({
    caseId: 'deferred-auto-archive',
    script: async (ctx) => {
      if (ctx.role !== 'parent') return undefined;
      if (!ctx.results)
        return ctx.reply({
          toolCalls: [{ name: ctx.spawnTool, input: ctx.spawnInput }],
          stopReason: 'tool_use',
        });
      if (!ctx.results.includes('Auto-archive is'))
        return ctx.reply({
          toolCalls: [
            {
              name: claudeToolName('SetAutoArchive'),
              input: { enabled: true },
            },
          ],
          stopReason: 'tool_use',
        });
      autoArchiveResult = ctx.results;
      // Keep the turn open so the user can work the turn's toggle.
      await parentHold.promise;
      return ctx.reply({ text: ctx.continued, stopReason: 'end_turn' });
    },
  });
  const { userDataDir, fixture, electronApp } = context;
  let assertionsCompleted = false;
  try {
    const { window, panel } = await openDelegatingChat(electronApp);
    await sendParentMessage(
      window,
      fixture,
      'Delegate an independent review, then archive this chat when done.',
    );
    await waitForChildBlocked(fixture);
    await expect
      .poll(() => autoArchiveResult !== undefined, {
        timeout: scaled(60_000),
      })
      .toBe(true);
    // The tool reports that archiving waits for the running delegate.
    expect(autoArchiveResult).toContain(
      'Auto-archive is on. This chat will be archived after its delegates finish.',
    );

    // The user turns auto-archive off and back on during the run.
    const disable = panel.getByRole('button', {
      name: 'Disable auto-archive for this turn',
    });
    await expect(disable).toBeVisible({ timeout: scaled(30_000) });
    await disable.click();
    const enable = panel.getByRole('button', {
      name: 'Enable auto-archive for this turn',
    });
    await enable.click();
    const toggle = panel.getByTestId('auto-archive-toggle');
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect(toggle).toHaveAttribute('data-delegates-live', 'true');
    await toggle.hover();
    await expect(
      window.getByRole('tooltip').filter({
        hasText: 'Archives after this turn and its delegates finish',
      }),
    ).toBeVisible();

    // The parent turn completes; the running delegate keeps the chat open.
    parentHold.resolve();
    await expect(
      panel.getByText(fixture.continued, { exact: true }),
    ).toBeVisible({ timeout: scaled(60_000) });
    await expect(window.getByTestId('chat-stop-generation')).toHaveCount(0);
    // Give a premature archive the time it would take to land.
    await new Promise((resolve) => setTimeout(resolve, scaled(3_000)));
    expect(await chatState(window)).toEqual({ live: true, archived: false });
    await expect(window.getByTestId(`panel-tab-${chatPanelId}`)).toBeVisible();
    expect(retainedRuns(userDataDir).map((run) => run.state.status)).toEqual([
      'running',
    ]);

    // A renderer reload must retain the pending archive while the child runs.
    await window.reload();
    await openDelegatingChat(electronApp);
    await expect(window.getByTestId(`panel-tab-${chatPanelId}`)).toBeVisible({
      timeout: scaled(30_000),
    });

    // The delegate finishes, and only then does the chat archive.
    fixture.releaseChild();
    await expect
      .poll(() => retainedRuns(userDataDir)[0]?.state.status, {
        timeout: scaled(60_000),
      })
      .toBe('completed');
    await expect
      .poll(() => chatState(window), { timeout: scaled(30_000) })
      .toEqual({ live: false, archived: true });
    await expect(window.getByTestId(`panel-tab-${chatPanelId}`)).toHaveCount(0);
    assertionsCompleted = true;
  } finally {
    parentHold.resolve();
    await finish(testInfo, context, assertionsCompleted);
  }
});

/**
 * The automatic-notice chain: the parent delegates a review; the review
 * makes a burst of reads, starts a nested task and then ends its
 * turn (or, given `childHold`, keeps it open until the hold settles). The
 * nested task holds on the fixture's barrier.
 */
// Historical scenario IDs keep "watch-chain"; the flow now uses automatic notices.
function watchChainScript({ evidencePath, childHold }) {
  const delegateTask = claudeToolName('DelegateTask');
  return async (ctx) => {
    const role = chainRole(ctx);
    if (role === 'parent') {
      if (ctx.item.hasWatcherEvent)
        return ctx.reply({ text: ctx.integrated, stopReason: 'end_turn' });
      if (!ctx.results)
        return ctx.reply({
          toolCalls: [
            {
              name: ctx.spawnTool,
              input: { ...ctx.spawnInput, allow_nested_delegation: true },
            },
          ],
          stopReason: 'tool_use',
        });

      return ctx.reply({ text: ctx.continued, stopReason: 'end_turn' });
    }
    if (role === 'child') {
      if (ctx.item.hasWatcherEvent)
        return ctx.reply({ text: ctx.finding, stopReason: 'end_turn' });
      // A burst of progress the chat has to keep up with.
      if (!ctx.results)
        return ctx.reply({
          toolCalls: Array.from({ length: 8 }, () =>
            ctx.nativeRead(evidencePath()),
          ),
          stopReason: 'tool_use',
        });
      if (!ctx.context.includes(delegateTask))
        return ctx.reply({
          toolCalls: [
            {
              name: delegateTask,
              input: {
                model: 'sonnet',
                description: 'Nested evidence review',
                prompt: `[${ctx.markers.grandchild}] Read delegation-evidence.txt and report evidence.`,
                run_in_background: true,
              },
            },
          ],
          stopReason: 'tool_use',
        });

      if (childHold) await childHold;
      return ctx.reply({
        text: 'Waiting for the nested review.',
        stopReason: 'end_turn',
      });
    }
    if (role === 'grandchild') {
      await ctx.childBarrier;
      return ctx.reply({ text: ctx.finding, stopReason: 'end_turn' });
    }
    return undefined;
  };
}

/** Sets up the watch chain; its evidence path is known once the demo is seeded. */
async function setUpWatchChain(caseId, childHold) {
  let evidencePath = '';
  const context = await setUpFixture({
    caseId,
    maxDepth: 2,
    script: watchChainScript({ evidencePath: () => evidencePath, childHold }),
  });
  evidencePath = path.join(
    context.demo.workspaces[0].worktreePath,
    'delegation-evidence.txt',
  );
  return context;
}

test('watch-chain: rows keep up with a nested chain, and a row Stop under an idle watching delegate settles', async ({}, testInfo) => {
  test.setTimeout(scaled(300_000));
  const context = await setUpWatchChain('watch-chain');
  const { userDataDir, fixture, electronApp } = context;
  let assertionsCompleted = false;
  try {
    const { window, panel } = await openDelegatingChat(electronApp);
    await sendParentMessage(
      window,
      fixture,
      'Delegate a review that starts its own task; use automatic completion notices.',
    );
    const byDepth = () =>
      Object.fromEntries(
        retainedRuns(userDataDir).map((run) => [run.depth, run]),
      );
    // The delegate ends its turn; its task will send an automatic notice.
    await expect
      .poll(() => [byDepth()[1]?.state.status, byDepth()[2]?.state.status], {
        timeout: scaled(120_000),
      })
      .toEqual(['completed', 'running']);
    const { 1: watching, 2: task } = byDepth();

    // The chat keeps up: the idle delegate leaves the drawer promptly, so
    // only the task it watches offers Stop.
    const tray = await openBackgroundDrawer(panel, { timeout: scaled(30_000) });
    await expect(delegateRow(tray, watching.state.delegationId)).toHaveCount(
      0,
      { timeout: scaled(5_000) },
    );
    const taskRow = delegateRow(tray, task.state.delegationId);
    const taskStop = taskRow.getByTestId('background-tray-agent-stop');
    await expect(taskStop).toBeVisible();

    // The row Stop ends the task, and the row settles rather than staying
    // at Stopping….
    await taskStop.click();
    await expect
      .poll(() => byDepth()[2]?.state.status, { timeout: scaled(30_000) })
      .toBe('cancelled');
    await expect(taskRow).toHaveCount(0, { timeout: scaled(10_000) });
    expect(byDepth()[2].state).toMatchObject({
      stopReason: 'user_cancelled',
      cancelledByUser: true,
    });

    // The watching delegate hears of the stop and finishes its turn.
    await expect
      .poll(
        () => [byDepth()[1]?.state.runGeneration, byDepth()[1]?.state.status],
        { timeout: scaled(60_000) },
      )
      .toEqual([2, 'completed']);
    await expect(panel.getByTestId('background-tray-agent')).toHaveCount(0, {
      timeout: scaled(10_000),
    });
    assertionsCompleted = true;
  } finally {
    await finish(testInfo, context, assertionsCompleted);
  }
});

test('watch-chain-row-stop: a delegate stopped while it watches its task is not woken by that task', async ({}, testInfo) => {
  test.setTimeout(scaled(300_000));
  // Keeps the review's turn open after it starts watching its task.
  const childHold = deferred();
  const context = await setUpWatchChain(
    'watch-chain-row-stop',
    childHold.promise,
  );
  const { userDataDir, fixture, electronApp } = context;
  let assertionsCompleted = false;
  try {
    const { window, panel } = await openDelegatingChat(electronApp);
    await sendParentMessage(
      window,
      fixture,
      'Delegate a review that starts its own task; use automatic completion notices.',
    );
    await expect
      .poll(
        () => [
          runsByDepth(userDataDir)[1]?.state.status,
          runsByDepth(userDataDir)[2]?.state.status,
          pendingDelegateWatchers(userDataDir).length,
        ],
        { timeout: scaled(120_000) },
      )
      .toEqual(['running', 'running', 0]);
    const review = runsByDepth(userDataDir)[1];

    const tray = await openBackgroundDrawer(panel, { timeout: scaled(30_000) });
    await delegateRow(tray, review.state.delegationId)
      .getByTestId('background-tray-agent-stop')
      .click();
    await expect
      .poll(
        () => [
          runsByDepth(userDataDir)[1]?.state.status,
          runsByDepth(userDataDir)[2]?.state.status,
        ],
        { timeout: scaled(30_000) },
      )
      .toEqual(['cancelled', 'cancelled']);
    // Its tree teardown suppresses completion notices, so the task's stop
    // does not wake it into a new run.
    await expect
      .poll(() => pendingDelegateWatchers(userDataDir).length, {
        timeout: scaled(10_000),
      })
      .toBe(0);
    await new Promise((resolve) => setTimeout(resolve, scaled(3_000)));
    expect(runsByDepth(userDataDir)[1].state).toMatchObject({
      runGeneration: 1,
      status: 'cancelled',
      stopReason: 'user_cancelled',
    });
    await expect(tray.getByTestId('background-tray-agent')).toHaveCount(0);
    assertionsCompleted = true;
  } finally {
    childHold.resolve();
    await finish(testInfo, context, assertionsCompleted);
  }
});

test('watch-chain-stop-all: Stop all ends a chain whose delegate idles on a watch, and nothing wakes it', async ({}, testInfo) => {
  test.setTimeout(scaled(300_000));
  const context = await setUpWatchChain('watch-chain-stop-all');
  const { userDataDir, fixture, electronApp } = context;
  let assertionsCompleted = false;
  try {
    const { window, panel } = await openDelegatingChat(electronApp);
    await sendParentMessage(
      window,
      fixture,
      'Delegate a review that starts its own task; use automatic completion notices.',
    );
    // The review idles while its task runs; no watch is registered.
    await expect
      .poll(
        () => [
          runsByDepth(userDataDir)[1]?.state.status,
          runsByDepth(userDataDir)[2]?.state.status,
          pendingDelegateWatchers(userDataDir).length,
        ],
        { timeout: scaled(120_000) },
      )
      .toEqual(['completed', 'running', 0]);

    // Only the task is listed, so the drawer offers no Stop all; stop the
    // chain through the same Stop all request the drawer and App Advisor's
    // `delegation.stop_all` send.
    const tray = await openBackgroundDrawer(panel, { timeout: scaled(30_000) });
    await expect(tray.getByTestId('background-tray-agent')).toHaveCount(1);
    await expect(tray.getByTestId('background-tray-stop-all')).toHaveCount(0);
    await window.evaluate(
      (target) => window.api.managedDelegation.stopAll(target),
      { projectId: workspaceId, worktreeId, chatId },
    );
    await expect
      .poll(() => runsByDepth(userDataDir)[2]?.state.status, {
        timeout: scaled(30_000),
      })
      .toBe('cancelled');
    await expect
      .poll(() => pendingDelegateWatchers(userDataDir).length, {
        timeout: scaled(10_000),
      })
      .toBe(0);
    // The idle review is not woken by its task's stop.
    await new Promise((resolve) => setTimeout(resolve, scaled(3_000)));
    expect(runsByDepth(userDataDir)[1].state).toMatchObject({
      runGeneration: 1,
      status: 'completed',
    });
    await expect(tray.getByTestId('background-tray-agent')).toHaveCount(0);
    assertionsCompleted = true;
  } finally {
    await finish(testInfo, context, assertionsCompleted);
  }
});
