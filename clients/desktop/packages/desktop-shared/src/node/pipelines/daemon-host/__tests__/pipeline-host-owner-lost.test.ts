// CAN-6102: the pipeline host pauses an owner-bound run whose remote owner is
// lost with `owner_lost`, and keeps `app_shutdown` for a local owner's loss,
// driven over an in-memory channel with a real executor, a temp data root and
// a temp worktree.
import { EventEmitter } from 'node:events';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ConnectedExecutionHostChannel } from '@canopy/core-platform/execution-host/channel';
import type {
  PipelineHostLaunch,
  PipelineHostMessage,
  PipelineHostRequest,
} from '@canopy/core-runtime/node/pipeline/host';
import type { CanopyJsonValue } from '@canopy/protocol/canopy-core';
import { loadExecutionState } from '../../executor/execution-state';
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
      ownerBound: true,
    },
    processEnvironment: { PATH: process.env.PATH ?? '' },
  };
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

async function pausedKinds(
  executionId: string,
  reason: 'owner_lost' | undefined,
): Promise<{ stored: string[]; published: string[] | undefined }> {
  await request({
    op: 'start',
    start: launchOf(executionId, [{ id: 'sleep', run: 'sleep 30' }]),
  });
  await waitFor(
    (message) => message.kind === 'process' && message.state === 'started',
  );
  const paused = await request({
    op: 'pause',
    executionIds: [executionId],
    ...(reason && { reason }),
  });
  expect(paused).toMatchObject({ ok: true, value: { pausedCount: 1 } });
  const stored = await loadExecutionState(
    executionId,
    join(dataRoot, 'pipeline-executions'),
  );
  expect(stored?.status).toBe('paused');
  const event = await waitFor(
    (message) =>
      message.kind === 'execution' &&
      message.executionId === executionId &&
      message.execution.status === 'paused',
  );
  return {
    stored: (stored?.status_reasons ?? []).map((item) => item.kind),
    published:
      event.kind === 'execution'
        ? event.execution.statusReasonKinds
        : undefined,
  };
}

describe('pipeline host owner-loss pause (CAN-6102)', () => {
  it('records owner_lost when a remote owner is lost', async () => {
    await expect(pausedKinds('run-remote', 'owner_lost')).resolves.toEqual({
      stored: ['owner_lost'],
      published: ['owner_lost'],
    });
  });

  it('keeps app_shutdown when a local owner is lost', async () => {
    await expect(pausedKinds('run-local', undefined)).resolves.toEqual({
      stored: ['app_shutdown'],
      published: ['app_shutdown'],
    });
  });
});
