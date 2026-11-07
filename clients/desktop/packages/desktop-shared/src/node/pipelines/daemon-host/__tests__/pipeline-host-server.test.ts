// CAN-5086: the pipeline host the daemon relaunches in its execution host
// entry mode, driven over an in-memory channel with a real executor, a temp
// data root and a temp worktree.
import { EventEmitter } from 'node:events';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ConnectedExecutionHostChannel } from '@canopy/core-platform/execution-host/channel';
import type {
  PipelineHostLaunch,
  PipelineHostMessage,
  PipelineHostRequest,
} from '@canopy/core-runtime/node/pipeline/host';
import type { CanopyJsonValue } from '@canopy/protocol/canopy-core';
import * as executor from '../../executor';
import { loadExecutionState } from '../../executor/execution-state';
import type { ExecutionHandle } from '../../executor/types';
import { servePipelineHost } from '../server';

jest.setTimeout(60_000);

const BUNDLED_ACTIONS = resolve(__dirname, '../../../../../resources/actions');

class MemoryChannel
  extends EventEmitter
  implements ConnectedExecutionHostChannel
{
  readonly posted: PipelineHostMessage[] = [];
  exitCode: number | null = null;
  congestion = false;

  postMessage(message: PipelineHostMessage): void {
    this.posted.push(message);
    super.emit('posted', message);
  }

  exit(code: number): void {
    this.exitCode = code;
  }

  congested(): boolean {
    return this.congestion;
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

function waitFor(
  predicate: (message: PipelineHostMessage) => boolean,
): Promise<PipelineHostMessage> {
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

function launchOf(
  executionId: string,
  steps: CanopyJsonValue[],
  overrides: Partial<PipelineHostLaunch['launch']> = {},
  processEnvironment: Record<string, string> = {},
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
      ...overrides,
    },
    processEnvironment: { PATH: process.env.PATH ?? '', ...processEnvironment },
  };
}

function isTerminalExecution(
  executionId: string,
): (message: PipelineHostMessage) => boolean {
  return (message) =>
    message.kind === 'execution' &&
    message.executionId === executionId &&
    ['success', 'failure', 'cancelled'].includes(message.execution.status);
}

function stepLogs(executionId: string): string {
  const logs = join(dataRoot, 'pipeline-executions', executionId, 'logs');
  return readdirSync(logs)
    .map((file) => readFileSync(join(logs, file), 'utf8'))
    .join('\n');
}

beforeEach(async () => {
  dataRoot = realpathSync(mkdtempSync(join(tmpdir(), 'pipeline-host-data-')));
  worktree = realpathSync(mkdtempSync(join(tmpdir(), 'pipeline-host-tree-')));
  // The host inherits the daemon's environment, as a dev daemon's would.
  process.env.CANOPY_DATA_DIR = dataRoot;
  channel = new MemoryChannel();
  servePipelineHost({ channel, inspectProcess: null });
  const configured = await request({ op: 'configure', dataRoot });
  expect(configured).toMatchObject({ ok: true });
});

afterEach(async () => {
  await request({ op: 'checkpoint' });
  if (savedDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = savedDataDir;
  rmSync(dataRoot, { recursive: true, force: true });
  rmSync(worktree, { recursive: true, force: true });
});

describe('servePipelineHost', () => {
  it('runs a shell-step workflow and writes the same execution store the app reads', async () => {
    const started = await request({
      op: 'start',
      start: launchOf(
        'run-shell',
        [
          { id: 'value', run: 'echo "value=$CANOPY_TEST_VALUE"' },
          { id: 'secret', run: 'echo "token=$TOKEN"' },
        ],
        { secretEnv: { TOKEN: 'secret-canary-31f9' } },
        { CANOPY_TEST_VALUE: 'from-core' },
      ),
    });
    expect(started).toMatchObject({ ok: true });
    const done = await waitFor(isTerminalExecution('run-shell'));
    expect(done).toMatchObject({ execution: { status: 'success' } });
    const stored = await loadExecutionState(
      'run-shell',
      join(dataRoot, 'pipeline-executions'),
    );
    expect(stored?.status).toBe('success');
    const logs = stepLogs('run-shell');
    expect(logs).toContain('value=from-core');
    expect(logs).not.toContain('secret-canary-31f9');
  });

  it('refuses a model step before anything runs', async () => {
    const refused = await request({
      op: 'start',
      start: launchOf('run-model', [{ uses: 'builtin/agent-prompt' }]),
    });
    expect(refused).toMatchObject({
      ok: false,
      error: { code: 'model_steps' },
    });
    expect(existsSync(join(dataRoot, 'pipeline-executions', 'run-model'))).toBe(
      false,
    );
  });

  it("uses the launch's Node command for node steps", async () => {
    await request({
      op: 'start',
      start: launchOf(
        'run-node',
        [{ id: 'node', run: 'console.log(process.execPath)', shell: 'node' }],
        { nodeProcess: { command: process.execPath } },
      ),
    });
    const done = await waitFor(isTerminalExecution('run-node'));
    expect(done).toMatchObject({ execution: { status: 'success' } });
    expect(stepLogs('run-node')).toContain(process.execPath);
  });

  it("reports each step's process group and its exit", async () => {
    await request({
      op: 'start',
      start: launchOf('run-group', [{ id: 'sleep', run: 'sleep 2' }]),
    });
    const started = await waitFor(
      (message) => message.kind === 'process' && message.state === 'started',
    );
    if (started.kind !== 'process' || started.state !== 'started')
      throw new Error('Expected a started process.');
    expect(started.processGroupId).toBeGreaterThan(0);
    const exited = await waitFor(
      (message) =>
        message.kind === 'process' &&
        message.state === 'exited' &&
        message.id === started.id,
    );
    expect(exited).toMatchObject({ id: started.id });
    await waitFor(isTerminalExecution('run-group'));
  });

  it('checkpoint pauses a running workflow so it can resume', async () => {
    await request({
      op: 'start',
      start: launchOf('run-pause', [{ id: 'sleep', run: 'sleep 30' }]),
    });
    await waitFor(
      (message) => message.kind === 'process' && message.state === 'started',
    );
    const checkpointed = await request({ op: 'checkpoint' });
    expect(checkpointed).toMatchObject({
      ok: true,
      value: { checkpointedCount: 1 },
    });
    const stored = await loadExecutionState(
      'run-pause',
      join(dataRoot, 'pipeline-executions'),
    );
    expect(stored?.status).toBe('paused');
  });

  // Coordinator ruling: the host checks its data root and never overrides it.
  it('refuses a data root other than its own', async () => {
    const other = realpathSync(
      mkdtempSync(join(tmpdir(), 'pipeline-host-other-')),
    );
    try {
      channel = new MemoryChannel();
      servePipelineHost({ channel, inspectProcess: null });
      const refused = await request({ op: 'configure', dataRoot: other });
      expect(refused).toMatchObject({ ok: false, error: { code: 'closed' } });
      expect(process.env.CANOPY_DATA_DIR).toBe(dataRoot);
      const start = await request({
        op: 'start',
        start: launchOf('run-other', [{ run: 'echo no' }]),
      });
      expect(start).toMatchObject({ ok: false, error: { code: 'closed' } });
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  // Review fix: a checkpoint racing a start still pauses that run.
  it('checkpoints a run whose start is still being admitted', async () => {
    const [started, checkpointed] = await Promise.all([
      request({
        op: 'start',
        start: launchOf('run-race', [{ id: 'sleep', run: 'sleep 30' }]),
      }),
      request({ op: 'checkpoint' }),
    ]);
    expect(started).toMatchObject({ ok: true });
    expect(checkpointed).toMatchObject({
      ok: true,
      value: { checkpointedCount: 1 },
    });
    const stored = await loadExecutionState(
      'run-race',
      join(dataRoot, 'pipeline-executions'),
    );
    expect(stored?.status).toBe('paused');
  });

  // Review fix: an executor failure after start never crashes the host.
  it('observes a run whose completion rejects', async () => {
    await request({
      op: 'start',
      start: launchOf('run-template', [{ id: 'echo', run: 'echo ok' }]),
    });
    await waitFor(isTerminalExecution('run-template'));
    const template = await loadExecutionState(
      'run-template',
      join(dataRoot, 'pipeline-executions'),
    );
    if (!template) throw new Error('Expected the template run.');
    const running = {
      ...template,
      id: 'run-reject',
      status: 'running' as const,
    };
    let current: typeof template = running;
    // The executor creates its completion promise eagerly, as this one is,
    // and records the failure on its state before rejecting.
    const completion = new Promise<never>((_resolve, reject) => {
      setTimeout(() => {
        current = { ...running, status: 'failure', error: 'executor failed' };
        reject(new Error('executor failed'));
      }, 10);
    });
    const fake: ExecutionHandle = {
      id: 'run-reject',
      getState: () => current,
      cancel: () => Promise.resolve(running),
      waitForCompletion: () => completion,
    };
    const unhandled = jest.fn();
    process.on('unhandledRejection', unhandled);
    const spy = jest.spyOn(executor, 'executePipeline').mockResolvedValue(fake);
    try {
      const started = await request({
        op: 'start',
        start: launchOf('run-reject', [{ id: 'echo', run: 'echo ok' }]),
      });
      expect(started).toMatchObject({ ok: true });
      await new Promise((done) => setTimeout(done, 50));
      expect(unhandled).not.toHaveBeenCalled();
      // Review fix: its streams still get the terminal failure.
      expect(
        channel.posted.some(
          (message) =>
            message.kind === 'execution' &&
            message.executionId === 'run-reject' &&
            message.execution.status === 'failure',
        ),
      ).toBe(true);
    } finally {
      spy.mockRestore();
      process.off('unhandledRejection', unhandled);
    }
  });

  // Review fix: cancelling a run no live handle holds still tells its streams.
  it('publishes the outcome of cancelling a paused run', async () => {
    await request({
      op: 'start',
      start: launchOf('run-paused', [{ id: 'sleep', run: 'sleep 30' }]),
    });
    await waitFor(
      (message) => message.kind === 'process' && message.state === 'started',
    );
    await request({ op: 'checkpoint' });
    const cancelled = await request({
      op: 'cancel',
      executionId: 'run-paused',
      mode: 'finalize',
    });
    expect(cancelled).toMatchObject({
      ok: true,
      value: { status: 'cancelled' },
    });
    const published = await waitFor(
      (message) =>
        message.kind === 'execution' &&
        message.executionId === 'run-paused' &&
        message.execution.status === 'cancelled',
    );
    expect(published).toMatchObject({ kind: 'execution' });
  });

  // Review fix: steps start from the PATH of the launch's base environment.
  it("keeps the launch's PATH for its steps", async () => {
    const pathValue = `/canopy-path-marker:${process.env.PATH ?? ''}`;
    await request({
      op: 'start',
      start: launchOf(
        'run-path',
        [{ id: 'path', run: 'echo "path=$PATH"' }],
        {},
        { PATH: pathValue },
      ),
    });
    const done = await waitFor(isTerminalExecution('run-path'));
    expect(done).toMatchObject({ execution: { status: 'success' } });
    expect(stepLogs('run-path')).toContain(`path=${pathValue}`);
  });
});
