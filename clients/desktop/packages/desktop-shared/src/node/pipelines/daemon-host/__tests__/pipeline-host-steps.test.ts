// CAN-5771: an owner-bound daemon run's host steps are raised from the
// pipeline host to the supervisor, which this test plays, over an in-memory
// channel with a real executor, a temp data root and a temp worktree.
import { EventEmitter } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ConnectedExecutionHostChannel } from '@canopy/core-platform/execution-host/channel';
import type {
  PipelineHostLaunch,
  PipelineHostMessage,
  PipelineHostRequest,
  PipelineHostStepSettlement,
} from '@canopy/core-runtime/node/pipeline/host';
import type {
  CanopyJsonValue,
  WorkerPipelineHostRequest,
} from '@canopy/protocol/canopy-core';
import { PIPELINE_NEEDS_DESKTOP_MESSAGE } from '@canopy/execution-engine/pipelines/host-actions';
import { stepTimedOutMessage } from '@canopy/execution-engine/node/pipelines/step-timeout';
import { getProjectActionsDir } from '@canopy/execution-engine/pipelines/config-paths';
import { loadExecutionState } from '../../executor/execution-state';
import type { PipelineHostActionResult } from '../../executor/types';
import { createDaemonHostStepPort } from '../host-steps';
import { servePipelineHost } from '../server';

jest.setTimeout(60_000);

const BUNDLED_ACTIONS = resolve(__dirname, '../../../../../resources/actions');

class MemoryChannel
  extends EventEmitter
  implements ConnectedExecutionHostChannel
{
  readonly posted: PipelineHostMessage[] = [];
  exitCode: number | null = null;

  postMessage(message: PipelineHostMessage): void {
    this.posted.push(message);
    super.emit('posted', message);
  }

  exit(code: number): void {
    this.exitCode = code;
  }

  congested(): boolean {
    return false;
  }

  onceDrained(listener: () => void): void {
    listener();
  }

  onDisconnect(): void {}
}

let nextId = 1;
let channel: MemoryChannel;
let dataRoot: string;
let worktree: string;
const savedDataDir = process.env.CANOPY_DATA_DIR;

function request(op: PipelineHostRequest): Promise<PipelineHostMessage> {
  const id = nextId++;
  return new Promise((done) => {
    const listener = (message: PipelineHostMessage): void => {
      if (message.kind !== 'response' || message.id !== id) return;
      channel.off('posted', listener);
      done(message);
    };
    channel.on('posted', listener);
    channel.emit('message', { data: { id, request: op } });
  });
}

function waitFor<M extends PipelineHostMessage>(
  predicate: (message: PipelineHostMessage) => message is M,
): Promise<M> {
  const found = channel.posted.find(predicate);
  if (found) return Promise.resolve(found);
  return new Promise((done) => {
    const listener = (message: PipelineHostMessage): void => {
      if (!predicate(message)) return;
      channel.off('posted', listener);
      done(message);
    };
    channel.on('posted', listener);
  });
}

type HostRequestMessage = Extract<PipelineHostMessage, { kind: 'hostRequest' }>;

function hostRequestFor(executionId: string): Promise<HostRequestMessage> {
  return waitFor(
    (message): message is HostRequestMessage =>
      message.kind === 'hostRequest' &&
      message.request.executionId === executionId,
  );
}

type ExecutionMessage = Extract<PipelineHostMessage, { kind: 'execution' }>;

function executionIn(
  executionId: string,
  statuses: readonly string[],
): Promise<ExecutionMessage> {
  return waitFor(
    (message): message is ExecutionMessage =>
      message.kind === 'execution' &&
      message.executionId === executionId &&
      statuses.includes(message.execution.status),
  );
}

function launchOf(
  executionId: string,
  steps: CanopyJsonValue[],
  ownerBound: boolean,
): PipelineHostLaunch {
  return {
    params: {
      executionId,
      pipelineId: 'pipeline',
      definitionSource: 'inline',
      runScope: 'worktree',
      workspaceId: 'workspace',
      worktreeId: 'worktree',
      owner: 'personal',
      initiationSource: 'user',
    },
    launch: {
      pipeline: { name: 'Daemon run', on: 'dispatch', jobs: { j: { steps } } },
      cwd: worktree,
      repoPath: worktree,
      bundledActionsDir: BUNDLED_ACTIONS,
      env: {},
      secretEnv: {},
      ...(ownerBound && { ownerBound: true }),
    },
    processEnvironment: { PATH: process.env.PATH ?? '' },
  };
}

function settle(
  hostRequest: WorkerPipelineHostRequest,
  settlement: PipelineHostStepSettlement,
): Promise<PipelineHostMessage> {
  return request({
    op: 'hostSettled',
    requestId: hostRequest.requestId,
    settlement,
  });
}

async function storedStep(
  executionId: string,
  stepId: string,
): Promise<{
  status?: string;
  error?: string;
  outputs?: Record<string, string>;
}> {
  const stored = await loadExecutionState(
    executionId,
    join(dataRoot, 'pipeline-executions'),
  );
  const step = stored?.jobs.j?.steps?.[stepId];
  return {
    status: step?.status,
    error: step?.error,
    outputs: step?.outputs,
  };
}

function stepLogs(executionId: string): string {
  const logs = join(dataRoot, 'pipeline-executions', executionId, 'logs');
  return readdirSync(logs)
    .map((file) => readFileSync(join(logs, file), 'utf8'))
    .join('\n');
}

const createWorktree = (
  extra: Record<string, CanopyJsonValue> = {},
): Record<string, CanopyJsonValue> => ({
  id: 'make',
  uses: 'builtin/create-worktree',
  with: { workspace_id: 'workspace', branch: 'b' },
  ...extra,
});

beforeEach(async () => {
  dataRoot = realpathSync(mkdtempSync(join(tmpdir(), 'host-steps-data-')));
  worktree = realpathSync(mkdtempSync(join(tmpdir(), 'host-steps-tree-')));
  process.env.CANOPY_DATA_DIR = dataRoot;
  channel = new MemoryChannel();
  servePipelineHost({ channel, inspectProcess: null });
  expect(await request({ op: 'configure', dataRoot })).toMatchObject({
    ok: true,
  });
});

afterEach(async () => {
  await request({ op: 'checkpoint' });
  if (savedDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = savedDataDir;
  rmSync(dataRoot, { recursive: true, force: true });
  rmSync(worktree, { recursive: true, force: true });
});

describe('daemon pipeline host steps (CAN-5771)', () => {
  it("a create-worktree step finishes with the owner's result and host-local path", async () => {
    const created = realpathSync(
      mkdtempSync(join(tmpdir(), 'host-steps-new-')),
    );
    try {
      expect(
        await request({
          op: 'start',
          start: launchOf('run-1', [createWorktree()], true),
        }),
      ).toMatchObject({ ok: true });
      const raised = await hostRequestFor('run-1');
      expect(raised.request.request.action).toBe('create-worktree');
      await settle(raised.request, {
        kind: 'settled',
        result: { status: 'success', outputs: { branch_name: 'b' } },
        values: { pathOutputs: { path: created }, timeout: 'none' },
      });
      await executionIn('run-1', ['success', 'failure']);
      const step = await storedStep('run-1', 'make');
      expect(step.status).toBe('success');
      expect(step.outputs).toMatchObject({ branch_name: 'b', path: created });
    } finally {
      rmSync(created, { recursive: true, force: true });
    }
  });

  it('an absent owner fails the step needs_desktop, as in process without a desktop', async () => {
    await request({
      op: 'start',
      start: launchOf('run-1', [createWorktree()], true),
    });
    const raised = await hostRequestFor('run-1');
    await settle(raised.request, { kind: 'unavailable' });
    await executionIn('run-1', ['failure']);
    const step = await storedStep('run-1', 'make');
    expect(step.status).toBe('failure');
    expect(step.error).toBe(PIPELINE_NEEDS_DESKTOP_MESSAGE);
    expect(Object.values(step.outputs ?? {})).toContain('needs_desktop');
  });

  it('cancelling the run withdraws the request', async () => {
    await request({
      op: 'start',
      start: launchOf('run-1', [createWorktree()], true),
    });
    await hostRequestFor('run-1');
    await request({ op: 'cancel', executionId: 'run-1', mode: 'drain' });
    await executionIn('run-1', ['cancelled']);
    const withdrawals = channel.posted.filter(
      (message) =>
        message.kind === 'hostRequestWithdrawn' &&
        message.executionId === 'run-1',
    );
    expect(withdrawals).toHaveLength(1);
    expect((await storedStep('run-1', 'make')).status).toBe('cancelled');
  });

  it("at the deadline the owner's finalized result ends the step", async () => {
    await request({
      op: 'start',
      start: launchOf(
        'run-1',
        [createWorktree({ timeout_minutes: 0.002 })],
        true,
      ),
    });
    const raised = await hostRequestFor('run-1');
    await new Promise((done) => setTimeout(done, 400));
    await settle(raised.request, {
      kind: 'settled',
      result: {
        status: 'failure',
        failureReason: 'target_not_ready',
        message: 'The target was not ready.',
        outputs: {},
      },
      values: { pathOutputs: {}, timeout: 'finalized' },
    });
    await executionIn('run-1', ['failure']);
    const step = await storedStep('run-1', 'make');
    expect(step.error).toBe('The target was not ready.');
    expect(Object.values(step.outputs ?? {})).toContain('target_not_ready');
    expect(stepLogs('run-1')).toContain('timed out (target_not_ready)');
  });

  it('at the deadline with no finalizer the step is a plain timeout', async () => {
    await request({
      op: 'start',
      start: launchOf(
        'run-1',
        [createWorktree({ timeout_minutes: 0.002 })],
        true,
      ),
    });
    const raised = await hostRequestFor('run-1');
    await new Promise((done) => setTimeout(done, 400));
    await settle(raised.request, {
      kind: 'settled',
      result: {
        status: 'failure',
        failureReason: null,
        message: 'The host step failed unexpectedly.',
        outputs: {},
      },
      values: { pathOutputs: {}, timeout: 'unfinalized' },
    });
    await executionIn('run-1', ['failure']);
    const step = await storedStep('run-1', 'make');
    expect(step.error).toBe(stepTimedOutMessage(0.002 * 60_000));
    expect(stepLogs('run-1')).toContain('[host:create-worktree] timed out');
  });

  // CAN-5095: main answers owner requests only for launches with model steps,
  // so a node action must not ask for Claude Mod admission in any other.
  it('an owner-bound run without model steps runs a node action without asking its owner', async () => {
    const action = join(getProjectActionsDir(worktree), 'probe');
    mkdirSync(action, { recursive: true });
    writeFileSync(
      join(action, 'action.yml'),
      'name: probe\nruns:\n  using: node\n  main: index.js\n',
    );
    writeFileSync(
      join(action, 'index.js'),
      "require('node:fs').appendFileSync(process.env.CANOPY_OUTPUT, 'ran=yes\\n');\n",
    );
    expect(
      await request({
        op: 'start',
        start: launchOf(
          'run-1',
          [{ id: 'probe', uses: 'project/probe' }],
          true,
        ),
      }),
    ).toMatchObject({ ok: true });
    // Nothing here answers the owner, so an owner request would hang the step.
    const first = await waitFor(
      (message): message is PipelineHostMessage =>
        message.kind === 'hostRequest' ||
        (message.kind === 'execution' &&
          message.executionId === 'run-1' &&
          ['success', 'failure'].includes(message.execution.status)),
    );
    expect(first.kind).toBe('execution');
    expect(await storedStep('run-1', 'probe')).toMatchObject({
      status: 'success',
      outputs: { ran: 'yes' },
    });
    expect(
      channel.posted.filter((message) => message.kind === 'hostRequest'),
    ).toEqual([]);
  });

  it('a launch that is not owner-bound refuses host steps', async () => {
    const refused = await request({
      op: 'start',
      start: launchOf('run-1', [createWorktree()], false),
    });
    expect(refused).toMatchObject({ ok: false, error: { code: 'host_steps' } });
    expect(existsSync(join(dataRoot, 'pipeline-executions', 'run-1'))).toBe(
      false,
    );
  });

  it('pause pauses only owner-bound runs', async () => {
    await request({
      op: 'start',
      start: launchOf(
        'bound',
        [
          {
            id: 'wait',
            uses: 'builtin/wait-for-agent-reply',
            with: { project_id: 'workspace', task_id: 't', chat_id: 'c' },
          },
        ],
        true,
      ),
    });
    await hostRequestFor('bound');
    // A run that is not owner-bound cannot hold a host step; it waits in a
    // shell step instead.
    await request({
      op: 'start',
      start: launchOf('free', [{ id: 'wait', run: 'sleep 30' }], false),
    });
    const paused = await request({
      op: 'pause',
      executionIds: ['bound', 'free'],
    });
    expect(paused).toMatchObject({ ok: true, value: { pausedCount: 1 } });
    await executionIn('bound', ['paused']);
    const stored = await loadExecutionState(
      'free',
      join(dataRoot, 'pipeline-executions'),
    );
    expect(stored?.status).toBe('running');
    await request({ op: 'cancel', executionId: 'free', mode: 'drain' });
  });
});

describe('daemon host-step port deadline (CAN-5771)', () => {
  it('a deadline abort that lands just before deadlineAt still takes the finalized answer', async () => {
    const port = createDaemonHostStepPort({
      raise: () => undefined,
      withdraw: () => undefined,
    });
    let finalizer:
      | (() => Promise<PipelineHostActionResult | undefined>)
      | undefined;
    const abort = new AbortController();
    const caller = {
      executionId: 'run-1',
      jobId: 'j',
      stepId: 'make',
      attempt: 0,
      iteration: 1,
      idempotencyKey: 'pipeline-host:run-1:j::make:0:1',
    };
    const running = port.run(
      {
        action: 'create-worktree',
        inputs: {
          projectId: 'workspace',
          branch: { kind: 'new', name: 'b' },
          repair: false,
          setup: 'skip',
        },
      },
      caller,
      abort.signal,
      {
        deadlineAt: Date.now() + 20,
        artifactsDir: join(tmpdir(), 'host-steps-artifacts'),
        registerTimeoutFinalizer: (finalize) => {
          finalizer = finalize;
        },
      },
    );
    running.catch(() => undefined);
    // The executor's deadline timer is scheduled from the event loop's cached
    // time, so under load it can fire before the clock reaches deadlineAt.
    abort.abort();
    port.settle(caller.idempotencyKey, {
      kind: 'settled',
      result: {
        status: 'failure',
        failureReason: 'target_not_ready',
        message: 'The target was not ready.',
        outputs: {},
      },
      values: { pathOutputs: {}, timeout: 'finalized' },
    });
    expect(await finalizer?.()).toMatchObject({
      status: 'failure',
      failureReason: 'target_not_ready',
    });
  });
});
