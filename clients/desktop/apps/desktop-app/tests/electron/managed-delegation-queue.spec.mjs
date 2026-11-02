// Queued admission + higher ceiling (docs/planning/2026-09-26-delegation-swarm-cleanup/01-wave-1.md
// §1.2, §2.5, §2.6): with "Maximum concurrent subagents" set to 1, a second
// background spawn waits in the Default queue and starts automatically
// instead of failing with capacity_exceeded, unless the caller opts into
// if_busy: 'reject'. See managed-delegation.spec.mjs for the wider
// parent/child case matrix and delegationRuntime.mjs for the shared mock
// inference harness this file scripts through its `script` hook.
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
import { CanopyAppDriver } from './canopyApp.mjs';
import {
  seedDemoWorkspaces,
  cleanupDemoWorkspaces,
} from './demoWorkspaces.mjs';
import { seedWorktreeChat, seedWorkspaceApprovals } from './seeders/index.mjs';
import { launchCanopy, closeCanopy } from './launchCanopy.mjs';
import { createDelegationInference } from './delegationRuntime.mjs';

// Windows qualification runs under emulation, where native provider turns
// take several times longer than on macOS. Mirrors managed-delegation.spec.mjs.
const hostPlatform = hostOperatingSystem();
const TIMEOUT_SCALE = hostPlatform === 'win32' ? 3 : 1;
const scaled = (ms) => ms * TIMEOUT_SCALE;
const expect = baseExpect.configure({ timeout: scaled(15_000) });

const workspaceId = 'demo-ts-pnpm-vite';
const worktreeId = 'demo-main';

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

// Mirrors broker.ts delegationPhase(): 'queued' is 'pending' plus an
// admission record still waiting for the current run generation.
function isQueued(run) {
  return (
    run.state.status === 'pending' &&
    run.admission?.state === 'waiting' &&
    run.admission.runGeneration === run.state.runGeneration
  );
}

// Turn groups collapse completed assistant turns behind an "Agent steps"
// summary; expand any collapsed ones before asserting on card content
// (mirrors managed-delegation.spec.mjs `revealDelegatedAgent` /
// managed-delegation-history.spec.mjs, generalized to more than one card).
async function revealDelegatedCards(surface, expectedCount) {
  await expect
    .poll(async () => {
      for (const summary of await surface
        .getByRole('button', { name: /^Agent steps:/, expanded: false })
        .all())
        await summary.click();
      return surface.getByTestId('chat-delegated-agent').count();
    })
    .toBe(expectedCount);
}

function delegatedCard(surface, delegationId) {
  return surface.locator(
    `[data-testid="chat-delegated-agent"][data-delegation-id="${delegationId}"]`,
  );
}

// Scripts the parent's very first turn (no tool results yet) to spawn two
// background children with identical input; everything else (both
// children's read-then-block flow, and the parent's own follow-up turns)
// falls through to delegationRuntime.mjs's built-in default handling.
function spawnBothScript(overrides = {}) {
  return (ctx) => {
    if (ctx.role !== 'parent' || ctx.results) return undefined;
    return ctx.reply({
      toolCalls: [
        { name: ctx.spawnTool, input: { ...ctx.spawnInput, ...overrides } },
        { name: ctx.spawnTool, input: { ...ctx.spawnInput, ...overrides } },
      ],
      stopReason: 'tool_use',
    });
  };
}

// Same initial spawn turn, then intercepts the parent's second turn (the
// tool results for both spawns) to call StopDelegate on whichever
// delegation is still queued, read directly off the retained run files
// rather than parsed out of the tool-result text. The parent's second turn
// follows the spawns immediately, so the queued state can end before the
// running child reaches its barrier. The script records the id it saw
// queued in `observed.queuedId` so the test does not have to catch that
// transient state on disk.
function buildStopQueuedScript(userDataDir, observed) {
  let stopped = false;
  return (ctx) => {
    if (ctx.role !== 'parent') return undefined;
    if (!ctx.results)
      return ctx.reply({
        toolCalls: [
          { name: ctx.spawnTool, input: ctx.spawnInput },
          { name: ctx.spawnTool, input: ctx.spawnInput },
        ],
        stopReason: 'tool_use',
      });
    if (!stopped) {
      const queued = retainedRuns(userDataDir).find(isQueued);
      if (!queued)
        throw new Error(
          'Expected a queued delegation record on disk before StopDelegate',
        );
      stopped = true;
      observed.queuedId = queued.state.delegationId;
      return ctx.reply({
        toolCalls: [
          {
            name: ctx.toolName('StopDelegate', 'stop_delegate'),
            input: { delegationId: queued.state.delegationId },
          },
        ],
        stopReason: 'tool_use',
      });
    }
    return undefined;
  };
}

async function setUpQueueFixture({ caseId, scriptFactory, maxConcurrent = 1 }) {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'managed-delegation-queue-'),
  );
  const fixture = await createDelegationInference({
    parent: 'codex',
    child: 'claude',
    mode: 'background',
    caseId,
    script: scriptFactory(userDataDir),
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
        managedDelegationMaxConcurrent: maxConcurrent,
        onboardingCompleted: ['v1'],
        defaultChatInterfaceMode: 'canopy',
        defaultWorktreeProvider: 'codex',
        defaultChatProvider: 'codex',
        codexMultiAgentWorktreeChatsEnabled: false,
      },
    }),
  );
  seedWorktreeChat({
    userDataDir,
    workspaceId,
    worktreeId,
    tabs: [
      {
        id: 'delegating-parent',
        title: 'Delegating parent',
        providerType: 'codex',
        executionHarness: 'codex',
        model: 'gpt-6-sol',
        approvalMode: 'full-access',
      },
    ],
  });
  return { userDataDir, fixture, demo };
}

async function openDelegatingChat(electronApp) {
  const window = await electronApp.firstWindow();
  const app = new CanopyAppDriver(window);
  await app.waitForShell();
  await window.evaluate(() =>
    window.api.savePreferences({ chatDetail: 'detailed' }),
  );
  await app.openMainPage();
  await app.selectWorktree('demo-main');
  const panel = window.getByTestId('panel-content-chat');
  // While a delegation is still active, its card renders twice: once in the
  // durable transcript and once in the "Active agent activity" rail below
  // the composer (ChatMessageList.tsx / AgentActivitySection.tsx). Scope to
  // the transcript surface, which is the only one that outlives completion.
  return {
    window,
    app,
    panel,
    transcript: panel.getByTestId('chat-message-list-content'),
  };
}

async function sendParentMessage(window, fixture, text) {
  const composer = window.getByRole('textbox').first();
  await composer.fill(`[${fixture.parentMarker}] ${text}`);
  await window.getByRole('button', { name: 'Send message' }).click();
}

// Waits until the single admitted child has read the evidence file and is
// held on the shared childBarrier (mirrors the `hasNativeEvidence` wait in
// managed-delegation.spec.mjs). At that point both records are already
// durably committed, since admission for a whole tool_use turn resolves
// synchronously before either child process ever starts.
async function waitForOneChildBlocked(fixture) {
  await expect
    .poll(
      () =>
        fixture.requests.some(
          (request) => request.role === 'child' && request.hasNativeEvidence,
        ),
      { timeout: scaled(120_000) },
    )
    .toBe(true);
  expect(
    fixture.requests.filter((request) => request.role === 'child'),
  ).toHaveLength(2);
}

test('queued-then-running: second spawn waits for a slot, then starts automatically after release', async ({}, testInfo) => {
  test.setTimeout(scaled(240_000));
  const caseId = 'queued-then-running';
  const { userDataDir, fixture, demo } = await setUpQueueFixture({
    caseId,
    scriptFactory: () => spawnBothScript(),
  });
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: { CANOPY_MOCK_LLM_BASE_URL: fixture.url },
  });
  let assertionsCompleted = false;
  try {
    const { window, transcript } = await openDelegatingChat(electronApp);
    await sendParentMessage(
      window,
      fixture,
      'Delegate two independent reviews in the background.',
    );

    await waitForOneChildBlocked(fixture);
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

    // Old behaviour (no queue): the second spawn would fail immediately with
    // capacity_exceeded and never create a record at all.
    expect(
      fixture.requests
        .filter((request) => request.role === 'parent')
        .map((request) => request.results)
        .join('\n'),
    ).not.toContain('capacity_exceeded');

    const runsAfterSpawn = retainedRuns(userDataDir);
    const running = runsAfterSpawn.find(
      (run) => run.state.status === 'running',
    );
    const queued = runsAfterSpawn.find(isQueued);

    await revealDelegatedCards(transcript, 2);
    const runningCard = delegatedCard(transcript, running.state.delegationId);
    const queuedCard = delegatedCard(transcript, queued.state.delegationId);
    await expect(queuedCard).toBeVisible();
    await expect(runningCard).toBeVisible();

    const queueStatus = queuedCard.getByTestId('delegated-agent-queue-status');
    await expect(queueStatus).toBeVisible();
    // Confirmed (see report): the durable transcript projection renders the
    // bare "Queued" label with no live position/waitingFor suffix in this
    // scenario, so this asserts the substring rather than exact text.
    await expect(queueStatus).toContainText('Queued');
    // The clean AgentBlockCard shimmers only while isRunning is true, and
    // DelegatedAgentCard sets running = !queued && (...), so a queued card
    // never shimmers even though it is not settled either.
    await expect(
      queuedCard.locator('[data-step-row-words].canopy-text-shimmer-strong'),
    ).toHaveCount(0);
    // Positive control: the actually-running sibling does shimmer
    // and no queue status, so the absence above is a real distinction.
    await expect(
      runningCard.getByTestId('delegated-agent-queue-status'),
    ).toHaveCount(0);
    await expect(
      runningCard.locator('[data-step-row-words].canopy-text-shimmer-strong'),
    ).toHaveCount(1);

    // A renderer reconnect must project the same admitted/queued generations,
    // not launch the queued task or lose its card. This runs on Linux too.
    const generations = runsAfterSpawn.map((run) => ({
      id: run.state.delegationId,
      generation: run.state.runGeneration,
    }));
    await window.reload();
    await openDelegatingChat(electronApp);
    await revealDelegatedCards(transcript, 2);
    await expect(queueStatus).toContainText('Queued');
    expect(
      retainedRuns(userDataDir).map((run) => ({
        id: run.state.delegationId,
        generation: run.state.runGeneration,
      })),
    ).toEqual(generations);
    expect(retainedRuns(userDataDir).filter(isQueued)).toHaveLength(1);
    expect(
      fixture.requests.filter((request) => request.role === 'child'),
    ).toHaveLength(2);

    fixture.releaseChild();
    await expect
      .poll(
        () => {
          const runs = retainedRuns(userDataDir);
          return (
            runs.length === 2 &&
            runs.every((run) => run.state.status === 'completed')
          );
        },
        { timeout: scaled(60_000) },
      )
      .toBe(true);

    await revealDelegatedCards(transcript, 2);
    await expect(queuedCard).toBeVisible();
    await expect(
      queuedCard.getByTestId('delegated-agent-queue-status'),
    ).toHaveCount(0);

    assertionsCompleted = true;
  } finally {
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
});

test('if-busy-reject: a reject-mode spawn over the limit fails fast with no queued record', async ({}, testInfo) => {
  test.setTimeout(scaled(240_000));
  const caseId = 'if-busy-reject';
  const { userDataDir, fixture, demo } = await setUpQueueFixture({
    caseId,
    scriptFactory: () => spawnBothScript({ if_busy: 'reject' }),
  });
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: { CANOPY_MOCK_LLM_BASE_URL: fixture.url },
  });
  let assertionsCompleted = false;
  try {
    const { window, transcript } = await openDelegatingChat(electronApp);
    await sendParentMessage(
      window,
      fixture,
      'Delegate two independent reviews, failing fast if busy.',
    );

    await waitForOneChildBlocked(fixture);
    expect(retainedRuns(userDataDir)).toHaveLength(1);
    expect(retainedRuns(userDataDir)[0].state.status).toBe('running');
    // The rejected spawn's own result reaches the parent's next request on an
    // independent timeline from the granted child's own first read (one is a
    // synchronous in-process rejection, the other spawns a real native
    // process), so wait for it explicitly rather than assuming an order.
    await expect
      .poll(() =>
        fixture.requests.some(
          (request) =>
            request.role === 'parent' &&
            request.results.includes('capacity_exceeded'),
        ),
      )
      .toBe(true);

    await revealDelegatedCards(transcript, 1);
    await expect(
      transcript.getByTestId('delegated-agent-queue-status'),
    ).toHaveCount(0);

    fixture.releaseChild();
    await expect
      .poll(() => retainedRuns(userDataDir)[0]?.state.status, {
        timeout: scaled(60_000),
      })
      .toBe('completed');
    expect(retainedRuns(userDataDir)).toHaveLength(1);

    assertionsCompleted = true;
  } finally {
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
});

test('stop-queued: StopDelegate on queued work cancels without a native launch', async ({}, testInfo) => {
  test.setTimeout(scaled(240_000));
  const caseId = 'stop-queued';
  const observed = { queuedId: undefined };
  const { userDataDir, fixture, demo } = await setUpQueueFixture({
    caseId,
    scriptFactory: (dir) => buildStopQueuedScript(dir, observed),
  });
  const { electronApp } = await launchCanopy({
    userDataDir,
    env: { CANOPY_MOCK_LLM_BASE_URL: fixture.url },
  });
  let assertionsCompleted = false;
  try {
    const { window, transcript } = await openDelegatingChat(electronApp);
    await sendParentMessage(
      window,
      fixture,
      'Delegate two independent reviews, then stop the queued one.',
    );

    await waitForOneChildBlocked(fixture);
    // The script found the second delegation queued on disk before it
    // called StopDelegate, so that id is the queued one.
    await expect.poll(() => observed.queuedId).toEqual(expect.any(String));
    const queuedId = observed.queuedId;
    await expect
      .poll(() => {
        const runs = retainedRuns(userDataDir);
        return (
          runs.length === 2 &&
          runs.filter((run) => run.state.status === 'running').length === 1
        );
      })
      .toBe(true);
    const running = retainedRuns(userDataDir).find(
      (run) => run.state.status === 'running',
    );
    expect(running.state.delegationId).not.toBe(queuedId);

    // state.status and launch.phase settle through two separate durable
    // writes (broker.ts finishWithoutRun updates state, then awaits the
    // launch journal's own settle()), so wait for both before reading either.
    await expect
      .poll(() => {
        const record = retainedRuns(userDataDir).find(
          (run) => run.state.delegationId === queuedId,
        );
        return (
          record?.state.status === 'cancelled' &&
          record?.launch.phase === 'settled'
        );
      })
      .toBe(true);
    // The stopped delegation never held the barrier, so no second child
    // request should ever have been captured.
    expect(
      fixture.requests.filter((request) => request.role === 'child'),
    ).toHaveLength(2);
    const stoppedRecord = retainedRuns(userDataDir).find(
      (run) => run.state.delegationId === queuedId,
    );
    // The parent agent stopped it through StopDelegate, not the user.
    expect(stoppedRecord.state.stopReason).toBe('stopped_by_parent');
    expect(stoppedRecord.state.cancelledByUser).toBe(false);
    expect(stoppedRecord.state.stoppedBy).toEqual({ kind: 'agent', depth: 0 });
    expect(stoppedRecord.state.error?.code).toBe('terminated_by_parent');
    expect(stoppedRecord.state.nativeSessionId).toBeUndefined();
    // The launch journal always ends 'settled' once the run generation is
    // done (see DelegationLaunchJournal.settle in launch-journal.ts); a
    // delegation that never held an admission slot is distinguished by
    // never having a nativeSessionId, and by its terminalStatus recording
    // the cancellation with no native runtime ever identified.
    expect(stoppedRecord.launch.phase).toBe('settled');
    expect(stoppedRecord.launch.terminalStatus).toBe('cancelled');
    expect(stoppedRecord.launch.nativeSessionId).toBeUndefined();

    // The parent's turn collapses its steps when it completes, which would
    // hide cards expanded before then. Its StopDelegate follow-up ends it
    // quickly, so wait for that before expanding.
    await expect(transcript.getByTestId('turn-timer').last()).toHaveAttribute(
      'data-state',
      'completed',
      { timeout: scaled(60_000) },
    );
    await revealDelegatedCards(transcript, 2);
    const stoppedCard = delegatedCard(transcript, queuedId);
    await expect(stoppedCard).toBeVisible();
    // An agent stop reads as such, not as the user's `Cancelled`.
    await expect(stoppedCard.getByTestId('delegated-agent-status')).toHaveText(
      'Stopped by parent',
    );
    await expect(stoppedCard).not.toContainText('Queued');
    await expect(
      stoppedCard.getByTestId('delegated-agent-queue-status'),
    ).toHaveCount(0);

    fixture.releaseChild();
    await expect
      .poll(
        () => {
          const record = retainedRuns(userDataDir).find(
            (run) => run.state.delegationId === running.state.delegationId,
          );
          return record?.state.status;
        },
        { timeout: scaled(60_000) },
      )
      .toBe('completed');

    assertionsCompleted = true;
  } finally {
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
});

test('quit-queued-relaunch: quitting while a task is queued settles it as cancelled and survives relaunch', async ({}, testInfo) => {
  test.setTimeout(scaled(240_000));
  const caseId = 'quit-queued-relaunch';
  const { userDataDir, fixture, demo } = await setUpQueueFixture({
    caseId,
    scriptFactory: () => spawnBothScript(),
  });
  const launchEnv = { CANOPY_MOCK_LLM_BASE_URL: fixture.url };
  let assertionsCompleted = false;
  let queuedId;
  try {
    const first = await launchCanopy({ userDataDir, env: launchEnv });
    try {
      const { window } = await openDelegatingChat(first.electronApp);
      await sendParentMessage(
        window,
        fixture,
        'Delegate two independent reviews, then quit.',
      );

      await waitForOneChildBlocked(fixture);
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
      queuedId = retainedRuns(userDataDir).find(isQueued).state.delegationId;
      // Deliberately quit without releasing the barrier, matching the plain
      // `quit` action case in managed-delegation.spec.mjs: the running child
      // is still mid-flight when the app closes.
    } finally {
      await closeCanopy(first.electronApp, userDataDir, {
        keepUserData: true,
      });
    }

    const second = await launchCanopy({ userDataDir, env: launchEnv });
    try {
      const { transcript } = await openDelegatingChat(second.electronApp);
      await revealDelegatedCards(transcript, 2);
      const card = delegatedCard(transcript, queuedId);
      await expect(card).toBeVisible();
      await expect(card).toContainText('Cancelled');
      await expect(card).not.toContainText('Interrupted');
      await expect(card).not.toContainText('Queued');
      await expect(
        card.getByTestId('delegated-agent-queue-status'),
      ).toHaveCount(0);

      const record = retainedRuns(userDataDir).find(
        (run) => run.state.delegationId === queuedId,
      );
      expect(record.state.status).toBe('cancelled');
      expect(record.state.stopReason).toBe('shutdown');
      expect(record.state.cancelledByUser).toBe(false);
      // Recovery restores terminal history without replaying a queued or
      // running child. Inference is deterministic; process startup is real.
      expect(
        retainedRuns(userDataDir).every(
          (run) => !['pending', 'running'].includes(run.state.status),
        ),
      ).toBe(true);
      expect(
        fixture.requests.filter((request) => request.role === 'child'),
      ).toHaveLength(2);

      assertionsCompleted = true;
    } finally {
      await closeCanopy(second.electronApp, userDataDir, {
        keepUserData: !assertionsCompleted,
      });
    }
  } finally {
    if (!assertionsCompleted)
      await testInfo.attach('failure-user-data-directory', {
        body: userDataDir,
        contentType: 'text/plain',
      });
    await fixture.close();
    if (assertionsCompleted) cleanupDemoWorkspaces(demo);
  }
});
