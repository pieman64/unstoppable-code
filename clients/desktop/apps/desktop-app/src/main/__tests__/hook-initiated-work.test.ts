import type {
  HookDescriptor,
  ScriptRunResponse,
} from '@canopy/desktop-shared/types';
import type { HookAction } from '@canopy/desktop-shared/hooks';
import {
  parseInitiatedWorkRunRecord,
  type OperationRecord,
} from '@canopy/protocol/canopy-core';
import type { RunShellScriptOptions } from '../lib/script-runner';
import type { InitiatedWorkRuntimeHelper } from './helpers/initiated-work-runtime';

jest.mock('../canopy-runtime/desktop-runtime', () => ({
  getActiveDesktopRuntime: (): { initiatedWork: unknown } => ({
    initiatedWork: jest
      .requireActual<InitiatedWorkRuntimeHelper>(
        './helpers/initiated-work-runtime',
      )
      .testInitiatedWork().engine,
  }),
}));
jest.mock('../lib/project-owner', () => ({
  resolveProjectSavedOwner: jest.fn(() =>
    Promise.resolve({ kind: 'organization', organizationId: 'org-1' }),
  ),
}));
jest.mock('../lib/workspace-persistence', () => ({
  readWorkspaceWorktrees: jest.fn(() => Promise.resolve([])),
}));
jest.mock('../lib/hook-pipeline', () => ({
  launchHookPipeline: jest.fn(() =>
    Promise.resolve({
      status: 'started',
      pipelineName: 'Review',
      executionId: 'exec-1',
    }),
  ),
  cancelQueuedHookPipeline: jest.fn(),
}));
jest.mock('../lib/worktree-data-env', () => ({
  buildWorktreeDataEnv: (
    _projectId: string,
    _worktreeId: string,
    env?: NodeJS.ProcessEnv,
  ): NodeJS.ProcessEnv => ({ ...env }),
}));
jest.mock('../lib/hook-log-store', () => ({
  startHookRunLog: jest.fn((args: { hook: HookDescriptor }) =>
    Promise.resolve({
      projectId: 'p',
      worktreeId: 'w',
      hook: args.hook,
      runId: 'run-log-1',
    }),
  ),
  appendHookRunLogLines: jest.fn(() => Promise.resolve()),
  completeHookRunLog: jest.fn(() => Promise.resolve()),
}));

interface PendingShell {
  options: RunShellScriptOptions;
  finish: (response: Partial<ScriptRunResponse>) => void;
}
const mockShells: PendingShell[] = [];
jest.mock('../lib/script-runner', () => ({
  runShellScript: jest.fn(
    (options: RunShellScriptOptions) =>
      new Promise<ScriptRunResponse>((resolve) => {
        const finish = (response: Partial<ScriptRunResponse>): void =>
          resolve({
            success: true,
            exitCode: 0,
            output: '',
            timedOut: false,
            durationMs: 3,
            ...response,
          });
        options.signal?.addEventListener('abort', () =>
          finish({ success: false, exitCode: null }),
        );
        mockShells.push({ options, finish });
      }),
  ),
}));

import { completeHookRunLog, startHookRunLog } from '../lib/hook-log-store';
import {
  cancelQueuedHookPipeline,
  launchHookPipeline,
} from '../lib/hook-pipeline';
import { resolveProjectSavedOwner } from '../lib/project-owner';
import {
  fireHook,
  runHook,
  stopAllRunningHooks,
  stopRunningHook,
} from '../lib/hook-runner';
import { readWorkspaceWorktrees } from '../lib/workspace-persistence';
import {
  acquireSplitLock,
  releaseSplitLock,
  SplitLockError,
} from '../services/split-lock-service';
import { withWorkspaceTargetArchiveDrain } from '../lib/workspace-target-exclusion';
import {
  closeTestInitiatedWork,
  readyTestInitiatedWork,
} from './helpers/initiated-work-runtime';

const mockedStartHookRunLog = jest.mocked(startHookRunLog);
const mockedResolveOwner = jest.mocked(resolveProjectSavedOwner);
const mockedReadWorktrees = jest.mocked(readWorkspaceWorktrees);

function pausedIn(hookKeys: string[]): void {
  mockedReadWorktrees.mockResolvedValue([
    { id: 'w', pausedHookKeys: hookKeys },
  ] as unknown as Awaited<ReturnType<typeof readWorkspaceWorktrees>>);
}

function hook(actions: HookAction[]): HookDescriptor {
  return {
    hookKey: 'project:pr:create',
    triggerName: 'pr:create',
    label: 'PR created',
    actions,
    target: 'project',
  };
}

const COMMAND: HookAction[] = [{ type: 'command', command: 'notify' }];

async function settle(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

async function runs(): Promise<OperationRecord[]> {
  const { operations } = await readyTestInitiatedWork();
  return (
    await operations.list({ kinds: ['core.initiatedWork.run'], limit: 50 })
  ).items;
}

async function latestRun(): Promise<OperationRecord> {
  const [latest] = await runs();
  if (!latest) throw new Error('no run recorded');
  return latest;
}

beforeEach(async () => {
  jest.clearAllMocks();
  mockedReadWorktrees.mockResolvedValue([]);
  mockShells.length = 0;
  closeTestInitiatedWork();
  await readyTestInitiatedWork();
});

afterEach(async () => {
  stopAllRunningHooks();
  await settle();
});

afterAll(() => {
  closeTestInitiatedWork();
});

describe('hooks on the initiated-work engine', () => {
  it('records the hook origin, owner, run log and result of an accepted run', async () => {
    const run = runHook({
      projectId: 'p',
      worktreeId: 'w',
      hook: hook(COMMAND),
      cwd: '/w',
      invocation: 'automatic',
      pause: 'enforce',
      occurrenceKey: 'github:o/r#1:pr:create:2026-10-29T00:00:00Z',
      getWindow: () => null,
    });
    await settle();
    mockShells[0]?.finish({ success: false, exitCode: 4 });
    expect(await run).toMatchObject({ success: false, exitCode: 4 });

    const operation = await latestRun();
    expect(mockedStartHookRunLog).toHaveBeenCalledWith(
      expect.objectContaining({ operationId: operation.operationId }),
    );
    expect(operation).toMatchObject({
      status: 'completed',
      origin: {
        kind: 'hook',
        sourceId: 'project:pr:create',
        occurrenceKey: 'github:o/r#1:pr:create:2026-10-29T00:00:00Z',
        context: {
          triggerName: 'pr:create',
          target: 'project',
          invocation: 'automatic',
          pause: 'enforce',
          projectOwner: { kind: 'organization', organizationId: 'org-1' },
        },
      },
      owner: { kind: 'organization', id: 'org-1' },
      scope: { workspaceId: 'p', worktreeId: 'w' },
    });
    expect(parseInitiatedWorkRunRecord(operation.outcome)).toMatchObject({
      disposition: 'ran',
      artifacts: [{ kind: 'runLog', id: 'run-log-1' }],
      result: { status: 'failed', exitCode: 4 },
    });
  });

  it('runs a repeated occurrence once and answers the repeat with its outcome', async () => {
    const options = {
      projectId: 'p',
      worktreeId: 'w',
      hook: hook(COMMAND),
      cwd: '/w',
      invocation: 'manual' as const,
      pause: 'bypass' as const,
      occurrenceKey: 'portal:command-1',
      getWindow: (): null => null,
    };
    const first = runHook(options);
    const repeat = runHook(options);
    await settle();
    expect(mockShells).toHaveLength(1);
    mockShells[0]?.finish({});
    expect(await first).toMatchObject({ success: true });
    expect(await repeat).toMatchObject({ success: true, exitCode: 0 });
    expect(await runs()).toHaveLength(1);
  });

  it('records a chat if-command stop as a skipped run', async () => {
    const run = runHook({
      projectId: 'p',
      worktreeId: 'w',
      hook: hook([{ type: 'chat', prompt: 'Review', 'if-command': 'gate' }]),
      cwd: '/w',
      invocation: 'automatic',
      pause: 'enforce',
      getWindow: () => null,
    });
    await settle();
    mockShells[0]?.finish({ success: false, exitCode: 2 });
    expect(await run).toMatchObject({ stopped: true, exitCode: 2 });
    const record = parseInitiatedWorkRunRecord((await latestRun()).outcome);
    expect(record).toMatchObject({
      disposition: 'skipped',
      result: { status: 'stopped', exitCode: 2 },
    });
    expect(
      record?.gates.find((outcome) => outcome.gate === 'commandGate'),
    ).toMatchObject({ decision: 'skipped', actionIndex: 0 });
    // The run log tells this skip from a stop request, for restart recovery.
    expect(jest.mocked(completeHookRunLog)).toHaveBeenLastCalledWith(
      expect.objectContaining({ stoppedBy: 'commandGate' }),
    );
  });

  it('refuses and records an organization context the project owner does not match', async () => {
    const orgChat: HookAction[] = [
      { type: 'chat', prompt: 'Review', executionContext: 'org:org-2' },
    ];
    await expect(
      runHook({
        projectId: 'p',
        worktreeId: 'w',
        hook: hook(orgChat),
        cwd: '/w',
        invocation: 'automatic',
        pause: 'enforce',
        getWindow: () => null,
      }),
    ).rejects.toThrow(
      "This hook runs in an organization that doesn't own this project.",
    );
    expect(await latestRun()).toMatchObject({
      status: 'failed',
      error: { code: 'core.initiatedWork.gate.executionContext' },
    });

    // The owner is read again when the next hook fires.
    mockedResolveOwner.mockResolvedValueOnce({ kind: 'unknown' });
    await expect(
      runHook({
        projectId: 'p',
        worktreeId: 'w',
        hook: hook(orgChat),
        cwd: '/w',
        invocation: 'automatic',
        pause: 'enforce',
        getWindow: () => null,
      }),
    ).rejects.toThrow("This project's owner could not be read");
    expect(await latestRun()).toMatchObject({
      status: 'failed',
      error: { code: 'core.initiatedWork.gate.owner' },
    });
    expect(mockShells).toHaveLength(0);
  });

  it('records the deletion fence refusing a hook in an archiving worktree', async () => {
    await withWorkspaceTargetArchiveDrain('p', 'w', async () => {
      await expect(
        runHook({
          projectId: 'p',
          worktreeId: 'w',
          hook: hook(COMMAND),
          cwd: '/w',
          invocation: 'automatic',
          pause: 'enforce',
          getWindow: () => null,
        }),
      ).rejects.toThrow('This worktree is being archived.');
    });
    const operation = await latestRun();
    expect(operation).toMatchObject({
      status: 'failed',
      error: {
        code: 'core.initiatedWork.gate.deletionFence',
        message:
          'This worktree is being archived. Retry after archiving finishes.',
      },
    });
  });

  it('skips and records a paused firing unless the request bypasses the pause', async () => {
    pausedIn(['project:pr:create']);
    expect(
      await runHook({
        projectId: 'p',
        worktreeId: 'w',
        hook: hook(COMMAND),
        cwd: '/w',
        invocation: 'automatic',
        pause: 'enforce',
        occurrenceKey: 'github:o/r#1:pr:create:t1',
        getWindow: () => null,
      }),
    ).toMatchObject({ success: false, stopped: true });
    const paused = await latestRun();
    expect(paused).toMatchObject({
      status: 'completed',
      owner: { kind: 'organization', id: 'org-1' },
      origin: { context: { pause: 'enforce' } },
    });
    expect(parseInitiatedWorkRunRecord(paused.outcome)).toMatchObject({
      disposition: 'skipped',
      gates: [{ gate: 'pause', decision: 'skipped' }],
    });
    expect(mockShells).toHaveLength(0);

    const manual = runHook({
      projectId: 'p',
      worktreeId: 'w',
      hook: hook(COMMAND),
      cwd: '/w',
      invocation: 'manual',
      pause: 'bypass',
      getWindow: () => null,
    });
    await settle();
    mockShells[0]?.finish({});
    expect(await manual).toMatchObject({ success: true });
    const bypassed = await latestRun();
    expect(bypassed.origin.context).toMatchObject({ pause: 'bypass' });
    expect(
      parseInitiatedWorkRunRecord(bypassed.outcome)?.gates.map(
        (outcome) => outcome.gate,
      ),
    ).not.toContain('pause');
  });

  it('refuses and records every firing in a split-locked worktree', async () => {
    acquireSplitLock('p', 'w');
    try {
      for (const invocation of ['automatic', 'manual'] as const) {
        await expect(
          runHook({
            projectId: 'p',
            worktreeId: 'w',
            hook: hook(COMMAND),
            cwd: '/w',
            invocation,
            pause: invocation === 'manual' ? 'bypass' : 'enforce',
            getWindow: () => null,
          }),
        ).rejects.toBeInstanceOf(SplitLockError);
        expect(await latestRun()).toMatchObject({
          status: 'failed',
          error: { code: 'core.initiatedWork.gate.splitLock' },
        });
      }
    } finally {
      releaseSplitLock('p', 'w');
    }
    expect(mockShells).toHaveLength(0);
  });

  it('records a source precondition that refuses a prepared firing', async () => {
    const refusal = new Error(
      'No current PR snapshot exists for this worktree.',
    );
    await expect(
      fireHook(
        {
          projectId: 'p',
          worktreeId: 'w',
          hook: hook(COMMAND),
          invocation: 'manual',
          pause: 'bypass',
          getWindow: () => null,
        },
        () =>
          Promise.resolve({
            kind: 'refused',
            gate: 'activePr',
            error: refusal,
          }),
      ),
    ).rejects.toBe(refusal);
    expect(await latestRun()).toMatchObject({
      status: 'failed',
      error: { code: 'core.initiatedWork.gate.activePr' },
    });
  });

  it('never starts a firing stopped while its gates are being decided', async () => {
    let release = (): void => undefined;
    mockedResolveOwner.mockReturnValueOnce(
      new Promise((resolve) => {
        release = (): void => resolve({ kind: 'personal' });
      }),
    );
    const run = runHook({
      projectId: 'p',
      worktreeId: 'w',
      hook: hook(COMMAND),
      cwd: '/w',
      invocation: 'automatic',
      pause: 'enforce',
      getWindow: () => null,
    });
    await settle();
    const stopped = stopRunningHook({
      projectId: 'p',
      worktreeId: 'w',
      hookKey: 'project:pr:create',
    });
    release();
    expect(await stopped).toMatchObject({ stopped: true });
    expect(await run).toMatchObject({ stopped: true });
    expect(mockShells).toHaveLength(0);
    expect(await runs()).toHaveLength(0);
  });

  it('leaves a workflow it launched to the workflow when the hook is stopped', async () => {
    const run = runHook({
      projectId: 'p',
      worktreeId: 'w',
      hook: hook([
        { type: 'pipeline', source: 'project', id: 'review' },
        { type: 'command', command: 'notify' },
      ]),
      cwd: '/w',
      invocation: 'automatic',
      pause: 'enforce',
      getWindow: () => null,
    });
    for (let turn = 0; turn < 50 && mockShells.length === 0; turn += 1)
      await new Promise((resolve) => setImmediate(resolve));
    expect(jest.mocked(launchHookPipeline)).toHaveBeenCalledTimes(1);
    expect(mockShells).toHaveLength(1);

    await stopRunningHook({
      projectId: 'p',
      worktreeId: 'w',
      hookKey: 'project:pr:create',
    });
    expect(await run).toMatchObject({ stopped: true });
    expect(await latestRun()).toMatchObject({ status: 'cancelled' });
    // The started workflow is the workflow domain's to control from here.
    expect(jest.mocked(cancelQueuedHookPipeline)).not.toHaveBeenCalled();
  });

  it('stops a running hook another client cancels through its operation', async () => {
    const run = runHook({
      projectId: 'p',
      worktreeId: 'w',
      hook: hook(COMMAND),
      cwd: '/w',
      invocation: 'automatic',
      pause: 'enforce',
      getWindow: () => null,
    });
    await settle();
    const { operations } = await readyTestInitiatedWork();
    const running = await latestRun();
    expect(running.status).toBe('running');

    const cancelled = await operations.cancel(running.operationId, {
      reason: 'Stopped from the portal.',
      requestedBy: 'portal-client',
    });
    expect(cancelled.outcome).toBe('requested');
    expect(await run).toMatchObject({ stopped: true, exitCode: null });
    expect(await latestRun()).toMatchObject({
      status: 'cancelled',
      cancellation: {
        requestedBy: 'portal-client',
        reason: 'Stopped from the portal.',
      },
    });
  });
});
