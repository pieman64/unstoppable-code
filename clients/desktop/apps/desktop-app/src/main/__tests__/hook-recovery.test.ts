import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  InitiatedWorkEngine,
  type InitiatedWorkAdmission,
} from '@canopy/core-runtime/node/initiated-work';
import { OperationService } from '@canopy/core-runtime/node/operations';
import { OperationLedger } from '@canopy/core-runtime/node/operations/ledger';
import type { HookDescriptor } from '@canopy/desktop-shared/types';
import {
  InitiatedWorkHookOriginContextSchema,
  parseInitiatedWorkRunRecord,
  type OperationRecord,
} from '@canopy/protocol/canopy-core';

const state: {
  engine: InitiatedWorkEngine | null;
  worktrees: string[];
  hook: HookDescriptor | null;
  paused: string[];
  snapshot: boolean;
  prNumber: number;
  executed: string[];
  runLog: { runId: string; status: string; stoppedBy?: string } | null;
} = {
  engine: null,
  worktrees: [],
  hook: null,
  paused: [],
  snapshot: true,
  prNumber: 1,
  executed: [],
  runLog: null,
};

jest.mock('../canopy-runtime/desktop-runtime', () => ({
  getActiveDesktopRuntime: (): unknown => ({ initiatedWork: state.engine }),
  getActiveDesktopRuntimeIfAccepting: (): unknown => ({
    initiatedWork: state.engine,
  }),
}));
jest.mock('../lib/project-owner', () => ({
  resolveProjectSavedOwner: jest.fn(() => Promise.resolve({ kind: 'none' })),
}));
jest.mock('../services/hooks-service', () => ({
  resolveHookForRun: jest.fn(() =>
    Promise.resolve({
      workspaceId: 'p',
      hook: state.hook,
      cwd: '/checkout',
      repoStorageKey: 'project-root',
    }),
  ),
}));
jest.mock('../services/split-lock-service', () => ({
  assertNotSplitLocked: jest.fn(),
}));
jest.mock('../lib/github-pr-hook-state', () => ({
  PR_ADVANCE_SOURCE: 'github.pr',
  settlePrTrackingState: jest.fn(() => Promise.resolve()),
  readCurrentPrTrackingSnapshot: jest.fn(() =>
    Promise.resolve({
      snapshot: state.snapshot
        ? {
            capturedAt: 'now',
            repository: { fullName: 'acme/repo' },
            pr: { number: state.prNumber },
          }
        : null,
      currentSnapshotPath: '/state/current.json',
      previousSnapshotPath: '/state/previous.json',
    }),
  ),
}));
jest.mock('../lib/workspace-persistence', () => ({
  // The core hook source reads the pause from the worktree list (CAN-4146).
  readWorkspaceWorktrees: jest.fn(() =>
    Promise.resolve(
      state.worktrees.map((id) => ({ id, pausedHookKeys: state.paused })),
    ),
  ),
  readWorkspaceWorktreesDetailed: jest.fn(() =>
    Promise.resolve({
      worktrees: state.worktrees.map((id) => ({ id })),
      authority: 'ok',
    }),
  ),
}));
jest.mock('../lib/preferences-store', () => ({
  readPreferencesFile: jest.fn(() =>
    Promise.resolve({ scriptTimeoutMinutes: 10 }),
  ),
}));
jest.mock('../lib/hook-log-store', () => ({
  findHookRunForOperation: jest.fn(() =>
    Promise.resolve(
      state.runLog
        ? {
            ...state.runLog,
            exitCode: 0,
            timedOut: false,
            durationMs: 12,
          }
        : null,
    ),
  ),
}));
jest.mock('../lib/hook-runner', () => ({
  resumedHookRunBody: (options: {
    occurrenceKey?: string;
  }): {
    gates: [];
    execute: () => Promise<unknown>;
  } => ({
    gates: [],
    execute: () => {
      state.executed.push(options.occurrenceKey ?? '');
      return Promise.resolve({
        value: { success: true },
        result: { status: 'succeeded', exitCode: 0, durationMs: 1 },
      });
    },
  }),
}));
jest.mock('../lib/main-process-logging', () => ({
  logMainProcessWarn: jest.fn(),
}));

import { createHookResumer } from '../lib/hook-recovery';

const HOOK: HookDescriptor = {
  hookKey: 'project:pr:create',
  triggerName: 'pr:create',
  label: 'PR created',
  target: 'project',
  actions: [{ type: 'command', command: 'echo hi' }],
};

let dir: string;
let operations: OperationService;

function open(recoverable: boolean): void {
  operations = new OperationService({
    openLedger: (): OperationLedger =>
      OperationLedger.open(join(dir, 'operation-ledger.sqlite')),
  });
  state.engine = new InitiatedWorkEngine({
    operations,
    ...(recoverable ? { recoverableOrigins: ['hook'] as const } : {}),
  });
}

function admission(occurrenceKey: string): InitiatedWorkAdmission {
  return {
    origin: {
      kind: 'hook',
      sourceId: HOOK.hookKey,
      occurrenceKey,
      context: {
        triggerName: 'pr:create',
        target: 'project',
        invocation: 'automatic',
        projectOwner: { kind: 'personal' },
        // GitHub occurrence keys name their pull request themselves.
        ...(occurrenceKey.startsWith('github:')
          ? {}
          : { pullRequest: { repository: 'acme/repo', number: 1 } }),
      },
    },
    owner: { kind: 'system', id: 'local' },
    scope: { workspaceId: 'p', worktreeId: 'w' },
    targetKey: 'p\0w\0project\0',
  };
}

async function acceptThenRestart(keys: string[]): Promise<string[]> {
  const engine = state.engine;
  if (!engine) throw new Error('no engine');
  const accepted = await engine.acceptOccurrence({
    head: { source: 'github.pr', subject: 'p\0w\0project-root', value: 'h1' },
    runs: keys.map((key) => admission(key)),
  });
  operations.close();
  open(true);
  return accepted.map((entry) =>
    entry.status === 'accepted' ? entry.operationId : '',
  );
}

async function recover(): Promise<void> {
  const engine = state.engine;
  if (!engine) throw new Error('no engine');
  engine.registerResumer(
    'hook',
    createHookResumer(() => null),
  );
  await engine.whenRecovered();
}

async function record(operationId: string): Promise<OperationRecord> {
  const operation = await operations.get(operationId);
  if (!operation) throw new Error('missing operation');
  return operation;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hook-recovery-'));
  Object.assign(state, {
    worktrees: ['w'],
    hook: HOOK,
    paused: [],
    snapshot: true,
    prNumber: 1,
    executed: [],
    runLog: null,
  });
  open(true);
});

afterEach(() => {
  operations.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('hook restart recovery (CAN-4145)', () => {
  it('runs accepted hook firings that never started, in their accepted order', async () => {
    const [first, second] = await acceptThenRestart(['o-1', 'o-2']);
    await recover();
    await new Promise((resolve) => setImmediate(resolve));
    expect(state.executed).toEqual(['o-1', 'o-2']);
    for (const operationId of [first, second])
      expect(await record(operationId)).toMatchObject({
        status: 'completed',
        restart: { class: 'resumable', disposition: 'resumed' },
      });
  });

  it.each([
    [
      'its worktree is gone',
      { worktrees: [] },
      'This worktree no longer exists.',
    ],
    [
      'its hook is no longer configured',
      { hook: null },
      'This hook is no longer configured.',
    ],
    [
      'its pull request is no longer tracked',
      { snapshot: false },
      'This pull request is no longer tracked.',
    ],
  ])('ends a firing visibly when %s', async (_case, change, message) => {
    const [operationId] = await acceptThenRestart(['o-1']);
    Object.assign(state, change);
    await recover();
    expect(state.executed).toEqual([]);
    expect(await record(operationId)).toMatchObject({
      status: 'failed',
      error: { code: 'core.initiatedWork.run.invalidated', message },
    });
  });

  it('ends a firing for a pull request the worktree no longer tracks, and runs one it still does', async () => {
    const [stale, current] = await acceptThenRestart([
      'github:acme/repo#1:pr:create:2026-11-02T10:00:00.000Z',
      'github:Acme/Repo#2:pr:create:2026-11-02T11:00:00.000Z',
    ]);
    state.prNumber = 2;
    await recover();
    await new Promise((resolve) => setImmediate(resolve));
    expect(await record(stale)).toMatchObject({
      status: 'failed',
      error: { code: 'core.initiatedWork.run.invalidated' },
    });
    expect(state.executed).toEqual([
      'github:Acme/Repo#2:pr:create:2026-11-02T11:00:00.000Z',
    ]);
    expect((await record(current)).status).toBe('completed');
  });

  it('waits out an unreadable worktree list instead of ending the firing', async () => {
    const [operationId] = await acceptThenRestart(['o-1']);
    const persistence = jest.requireMock<{
      readWorkspaceWorktreesDetailed: jest.Mock;
    }>('../lib/workspace-persistence');
    const readsBefore =
      persistence.readWorkspaceWorktreesDetailed.mock.calls.length;
    persistence.readWorkspaceWorktreesDetailed
      .mockRejectedValueOnce(new Error('registry unavailable'))
      .mockResolvedValueOnce({ worktrees: [], authority: 'partial' });
    await recover();
    for (
      let attempt = 0;
      attempt < 300 && state.executed.length === 0;
      attempt += 1
    )
      await new Promise((resolve) => setTimeout(resolve, 50));
    expect(state.executed).toEqual(['o-1']);
    expect(
      persistence.readWorkspaceWorktreesDetailed.mock.calls.length -
        readsBefore,
    ).toBe(3);
    expect((await record(operationId)).status).toBe('completed');
  }, 20_000);

  it('ends a recovered pre-commit failure hook visibly, since its payload is not kept', async () => {
    const engine = state.engine;
    if (!engine) throw new Error('no engine');
    const precommit = admission('o-1');
    const [accepted] = await engine.acceptOccurrence({
      runs: [
        {
          ...precommit,
          origin: {
            ...precommit.origin,
            sourceId: 'project:worktree:precommit:failure',
            context: {
              triggerName: 'worktree:precommit:failure',
              target: 'project',
              invocation: 'automatic',
              projectOwner: { kind: 'personal' },
            },
          },
        },
      ],
    });
    if (accepted.status !== 'accepted') throw new Error('not accepted');
    operations.close();
    open(true);
    await recover();
    expect(state.executed).toEqual([]);
    expect(await record(accepted.operationId)).toMatchObject({
      status: 'failed',
      error: { code: 'core.initiatedWork.run.invalidated' },
    });
  });

  it('settles a recovered run cancelled while its worktree read is failing', async () => {
    const [operationId] = await acceptThenRestart(['o-1']);
    const persistence = jest.requireMock<{
      readWorkspaceWorktreesDetailed: jest.Mock;
    }>('../lib/workspace-persistence');
    let failRead = (): void => undefined;
    persistence.readWorkspaceWorktreesDetailed.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          failRead = (): void => reject(new Error('registry unavailable'));
        }),
    );
    const engine = state.engine;
    if (!engine) throw new Error('no engine');
    engine.registerResumer(
      'hook',
      createHookResumer(() => null),
    );
    await operations.ready();
    await new Promise((resolve) => setImmediate(resolve));
    await operations.cancel(operationId, {
      requestedBy: 'user-1',
      reason: 'Stopped.',
    });
    failRead();
    await engine.whenRecovered();
    expect(state.executed).toEqual([]);
    expect((await record(operationId)).status).toBe('cancelled');
  });

  it.each([
    ['for a pull request the worktree no longer tracks', true],
    ['without a known pull request', false],
  ] as const)(
    'ends a manual run requested %s',
    async (_case, withPullRequest) => {
      const engine = state.engine;
      if (!engine) throw new Error('no engine');
      const manual = admission('portal:command-1');
      const context = InitiatedWorkHookOriginContextSchema.parse(
        manual.origin.context,
      );
      const [accepted] = await engine.acceptOccurrence({
        runs: [
          {
            ...manual,
            origin: {
              ...manual.origin,
              context: {
                triggerName: context.triggerName,
                target: context.target,
                invocation: 'manual',
                projectOwner: context.projectOwner,
                ...(withPullRequest
                  ? { pullRequest: { repository: 'acme/repo', number: 1 } }
                  : {}),
              },
            },
          },
        ],
      });
      if (accepted.status !== 'accepted') throw new Error('not accepted');
      operations.close();
      open(true);
      state.prNumber = 2;
      await recover();
      expect(state.executed).toEqual([]);
      expect(await record(accepted.operationId)).toMatchObject({
        status: 'failed',
        error: { code: 'core.initiatedWork.run.invalidated' },
      });
    },
  );

  it('records a firing whose hook was paused while the core was down as skipped', async () => {
    const [operationId] = await acceptThenRestart(['o-1']);
    state.paused = [HOOK.hookKey];
    await recover();
    expect(state.executed).toEqual([]);
    const operation = await record(operationId);
    expect(operation.status).toBe('completed');
    expect(
      parseInitiatedWorkRunRecord(operation.outcome)?.gates.at(-1),
    ).toMatchObject({ gate: 'pause', decision: 'skipped' });
  });

  it.each([
    [
      'finished',
      { runId: 'run-1', status: 'success' },
      {
        status: 'completed',
        outcome: { artifacts: [{ kind: 'runLog', id: 'run-1' }] },
      },
    ],
    [
      'was skipped by its command gate',
      { runId: 'run-1', status: 'cancelled', stoppedBy: 'commandGate' },
      {
        status: 'completed',
        outcome: {
          disposition: 'skipped',
          artifacts: [{ kind: 'runLog', id: 'run-1' }],
          result: { status: 'stopped' },
        },
      },
    ],
    [
      'was cancelled',
      { runId: 'run-1', status: 'cancelled' },
      { status: 'cancelled' },
    ],
    [
      'was cut off',
      { runId: 'run-1', status: 'running' },
      { status: 'failed', error: { code: 'core.operation.interrupted' } },
    ],
    [
      'left no log',
      null,
      { status: 'failed', error: { code: 'core.operation.interrupted' } },
    ],
  ])(
    'reconciles a run that may have started by its run log when it %s, never running it again',
    async (_case, runLog, expected) => {
      const engine = state.engine;
      if (!engine) throw new Error('no engine');
      const [accepted] = await engine.acceptOccurrence({
        runs: [admission('o-1')],
      });
      if (accepted.status !== 'accepted') throw new Error('not accepted');
      await operations.transition(accepted.operationId, 'running');
      operations.close();
      open(true);
      state.runLog = runLog;
      await recover();
      expect(state.executed).toEqual([]);
      expect(await record(accepted.operationId)).toMatchObject(expected);
    },
  );
});
