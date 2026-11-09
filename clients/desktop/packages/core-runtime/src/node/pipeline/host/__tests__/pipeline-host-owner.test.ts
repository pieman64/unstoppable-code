// CAN-5771: the supervisor relays an owner-bound run's host steps to the
// daemon's owner channel and settlements back, waits for an owner, and
// pauses owner-bound runs once the owner is gone. A fake host records
// requests and lets each test answer.
import { EventEmitter } from 'node:events';
import type {
  CanopyHostExecution,
  WorkerPipelineExecution,
  WorkerPipelineExecutionStartParams,
  WorkerPipelineHostRequest,
  WorkerPipelineHostRequestsItem,
  WorkerPipelineHostStepValues,
} from '@canopy/protocol/canopy-core';
import type { CanopyHandlerContext } from '../../../../runtime/types';
import { NO_EXECUTION_SECRETS } from '../../../execution-secrets';
import { createPipelineOwnerChannel } from '../../execution';
import {
  PipelineHostSupervisor,
  type PipelineHostLaunch,
  type PipelineHostMessage,
  type PipelineHostProcess,
  type PipelineHostRequest,
  type PipelineHostRequestMessage,
} from '..';

class FakeHost extends EventEmitter implements PipelineHostProcess {
  readonly requests: PipelineHostRequestMessage[] = [];

  postMessage(message: PipelineHostRequestMessage): void {
    this.requests.push(message);
    const { request } = message;
    if (request.op === 'configure' || request.op === 'hostSettled')
      this.reply(message.id, null);
    if (request.op === 'checkpoint')
      this.reply(message.id, { checkpointedCount: 0 });
    if (request.op === 'exit') {
      this.reply(message.id, null);
      queueMicrotask(() => this.emit('exit', 0));
    }
  }

  kill(): boolean {
    return true;
  }

  of<O extends PipelineHostRequest['op']>(
    op: O,
  ): Array<Extract<PipelineHostRequest, { op: O }>> {
    return this.requests
      .map(({ request }) => request)
      .filter(
        (request): request is Extract<PipelineHostRequest, { op: O }> =>
          request.op === op,
      );
  }

  last(op: PipelineHostRequest['op']): PipelineHostRequestMessage {
    const found = [...this.requests]
      .reverse()
      .find((message) => message.request.op === op);
    if (!found) throw new Error(`No ${op} request.`);
    return found;
  }

  reply(id: number, value: unknown): void {
    this.send({ kind: 'response', id, ok: true, value });
  }

  send(message: PipelineHostMessage): void {
    queueMicrotask(() => this.emit('message', message));
  }

  /** Delivers messages in one turn, as one read chunk does. */
  sendTogether(...messages: PipelineHostMessage[]): void {
    queueMicrotask(() => {
      for (const message of messages) this.emit('message', message);
    });
  }
}

function startParams(executionId: string): WorkerPipelineExecutionStartParams {
  return {
    executionId,
    pipelineId: 'pipeline',
    definitionSource: 'inline',
    runScope: 'worktree',
    workspaceId: 'workspace',
    worktreeId: 'worktree',
    owner: 'personal',
    initiationSource: 'user',
  };
}

function hostExecution(ownerBound: boolean): CanopyHostExecution {
  return {
    childEnvironment: { PATH: '/usr/bin' },
    pipelineLaunch: {
      pipeline: { name: 'p', on: 'dispatch', jobs: {} },
      cwd: '/work/tree',
      bundledActionsDir: '/app/actions',
      env: {},
      secretEnv: {},
      ...(ownerBound && { ownerBound: true }),
    },
  };
}

function projection(executionId: string): WorkerPipelineExecution {
  return {
    executionId,
    pipelineId: 'pipeline',
    name: 'p',
    status: 'running',
    runScope: 'worktree',
    definitionSource: 'inline',
    owner: 'personal',
    workspaceId: 'workspace',
    worktreeId: 'worktree',
    parentExecutionId: null,
    startedAt: '2026-11-06T00:00:00.000Z',
    completedAt: null,
    pendingPauseCount: 0,
    error: null,
  };
}

function hostRequest(
  executionId: string,
  requestId: string,
): WorkerPipelineHostRequest {
  return {
    requestId,
    executionId,
    jobId: 'j',
    stepId: 's',
    childExecutionId: null,
    attempt: 0,
    iteration: 0,
    owner: 'personal',
    deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    request: {
      action: 'create-worktree',
      projectId: 'workspace',
      branch: { kind: 'new', name: 'b' },
      repair: false,
      setup: 'skip',
    },
  };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 8; index += 1)
    await new Promise((resolve) => setImmediate(resolve));
}

const context = {} as CanopyHandlerContext;

function harness(): {
  hosts: FakeHost[];
  supervisor: PipelineHostSupervisor;
  channel: ReturnType<typeof createPipelineOwnerChannel>;
  launch: jest.Mock<PipelineHostProcess, []>;
} {
  const hosts: FakeHost[] = [];
  const channel = createPipelineOwnerChannel();
  const launch = jest.fn<PipelineHostProcess, []>(() => {
    const host = new FakeHost();
    hosts.push(host);
    return host;
  });
  const supervisor = new PipelineHostSupervisor({
    launch,
    configure: { dataRoot: '/data' },
    resolveLaunch: (params, execution): Promise<PipelineHostLaunch> =>
      Promise.resolve({
        params,
        launch: execution.pipelineLaunch,
        processEnvironment: execution.childEnvironment,
      }),
    idleStopMs: 600_000,
    owner: channel,
  });
  return { hosts, supervisor, channel, launch };
}

/** An owner subscription through the channel's own stream handler. */
async function subscribeOwner(
  channel: ReturnType<typeof createPipelineOwnerChannel>,
): Promise<{ items: WorkerPipelineHostRequestsItem[]; stop: () => void }> {
  const items: WorkerPipelineHostRequestsItem[] = [];
  const stopped = await channel.handlers.streams[
    'worker.pipeline.hostRequests'
  ]({}, context, {
    emit: (item: WorkerPipelineHostRequestsItem) => {
      items.push(item);
      return { epoch: 'e', sequence: items.length };
    },
    emitAt: () => null,
    end: () => undefined,
    endAt: () => undefined,
  } as never);
  return { items, stop: stopped ?? ((): void => undefined) };
}

async function startRun(
  h: ReturnType<typeof harness>,
  executionId: string,
  ownerBound: boolean,
): Promise<FakeHost> {
  const result = h.supervisor.start(
    startParams(executionId),
    new AbortController().signal,
    NO_EXECUTION_SECRETS,
    hostExecution(ownerBound),
  );
  await settle();
  const host = h.hosts[h.hosts.length - 1];
  host.reply(host.last('start').id, projection(executionId));
  await result;
  return host;
}

beforeEach(() => {
  jest.useFakeTimers({
    doNotFake: ['setImmediate', 'queueMicrotask', 'nextTick'],
  });
});
afterEach(() => {
  jest.useRealTimers();
});

describe('pipeline host supervisor owner channel (CAN-5771)', () => {
  it('relays a host request to the owner and its settlement and host-local values back', async () => {
    const h = harness();
    const owner = await subscribeOwner(h.channel);
    const host = await startRun(h, 'run-1', true);
    const request = hostRequest('run-1', 'request-1');
    host.send({ kind: 'hostRequest', request });
    await settle();
    expect(owner.items).toEqual([request]);
    const values: WorkerPipelineHostStepValues = {
      pathOutputs: { path: '/work/new-tree' },
      timeout: 'none',
    };
    await h.channel.handlers.instructions[
      'worker.pipeline.hostRequest.respond'
    ](
      {
        executionId: 'run-1',
        requestId: 'request-1',
        result: { status: 'success', outputs: { branch: 'b' } },
      },
      {
        ...context,
        execution: { childEnvironment: {}, pipelineHostStep: values },
      },
    );
    await settle();
    expect(host.of('hostSettled')).toEqual([
      {
        op: 'hostSettled',
        requestId: 'request-1',
        settlement: {
          kind: 'settled',
          result: { status: 'success', outputs: { branch: 'b' } },
          values,
        },
      },
    ]);
    owner.stop();
    await h.supervisor.stop();
  });

  it('relays a model step owner request and its owner values back (CAN-5095)', async () => {
    const h = harness();
    const owner = await subscribeOwner(h.channel);
    const host = await startRun(h, 'run-1', true);
    const request: WorkerPipelineHostRequest = {
      ...hostRequest('run-1', 'owner:run-1:1'),
      request: { action: 'owner.model.policy', check: 'active' },
    };
    host.send({ kind: 'hostRequest', request });
    await settle();
    expect(owner.items).toEqual([request]);
    await h.channel.handlers.instructions[
      'worker.pipeline.hostRequest.respond'
    ](
      {
        executionId: 'run-1',
        requestId: 'owner:run-1:1',
        result: {
          status: 'owner',
          value: { kind: 'model.policy', answer: true },
        },
      },
      {
        ...context,
        execution: {
          childEnvironment: {},
          pipelineOwnerValues: {
            requestId: 'owner:run-1:1',
            env: { ROUTE: 'host-local' },
          },
        },
      },
    );
    await settle();
    expect(host.of('hostSettled')).toEqual([
      {
        op: 'hostSettled',
        requestId: 'owner:run-1:1',
        settlement: {
          kind: 'owner',
          settlement: {
            result: {
              status: 'owner',
              value: { kind: 'model.policy', answer: true },
            },
            values: {
              requestId: 'owner:run-1:1',
              env: { ROUTE: 'host-local' },
            },
          },
        },
      },
    ]);
    owner.stop();
    await h.supervisor.stop();
  });

  it('holds a host request up to 10 s for an owner, then answers unavailable', async () => {
    const h = harness();
    const owner = await subscribeOwner(h.channel);
    const host = await startRun(h, 'run-1', true);
    owner.stop();
    host.send({
      kind: 'hostRequest',
      request: hostRequest('run-1', 'request-1'),
    });
    await settle();
    jest.advanceTimersByTime(9_999);
    await settle();
    expect(host.of('hostSettled')).toEqual([]);
    jest.advanceTimersByTime(1);
    await settle();
    expect(host.of('hostSettled')).toEqual([
      {
        op: 'hostSettled',
        requestId: 'request-1',
        settlement: { kind: 'unavailable' },
      },
    ]);

    host.send({
      kind: 'hostRequest',
      request: hostRequest('run-1', 'request-2'),
    });
    await settle();
    jest.advanceTimersByTime(5_000);
    const late = await subscribeOwner(h.channel);
    await settle();
    expect(
      late.items.map((item) => ('withdrawn' in item ? null : item.requestId)),
    ).toEqual(['request-2']);
    late.stop();
    await h.supervisor.stop();
  });

  it('a withdrawal from the host withdraws the request and announces it', async () => {
    const h = harness();
    const owner = await subscribeOwner(h.channel);
    const host = await startRun(h, 'run-1', true);
    host.send({
      kind: 'hostRequest',
      request: hostRequest('run-1', 'request-1'),
    });
    await settle();
    host.send({
      kind: 'hostRequestWithdrawn',
      executionId: 'run-1',
      requestId: 'request-1',
    });
    await settle();
    expect(owner.items[1]).toEqual({
      withdrawn: true,
      executionId: 'run-1',
      requestId: 'request-1',
    });
    await expect(
      h.channel.handlers.instructions['worker.pipeline.hostRequest.respond'](
        {
          executionId: 'run-1',
          requestId: 'request-1',
          result: { status: 'success', outputs: {} },
        },
        context,
      ),
    ).resolves.toMatchObject({ outcome: 'already_settled' });
    expect(host.of('hostSettled')).toEqual([]);
    owner.stop();
    await h.supervisor.stop();
  });

  it('pauses owner-bound executions 10 s after the owner goes, and a returning owner cancels it', async () => {
    const h = harness();
    const owner = await subscribeOwner(h.channel);
    const host = await startRun(h, 'bound', true);
    await startRun(h, 'free', false);
    owner.stop();
    jest.advanceTimersByTime(9_000);
    const back = await subscribeOwner(h.channel);
    jest.advanceTimersByTime(5_000);
    await settle();
    expect(host.of('pause')).toEqual([]);

    back.stop();
    jest.advanceTimersByTime(10_000);
    await settle();
    expect(host.of('pause')).toEqual([
      { op: 'pause', executionIds: ['bound'] },
    ]);
    host.reply(host.last('pause').id, { pausedCount: 1 });
    await settle();
    await h.supervisor.stop();
  });

  it('relays a host request that arrives with its start response', async () => {
    const h = harness();
    const owner = await subscribeOwner(h.channel);
    const result = h.supervisor.start(
      startParams('run-1'),
      new AbortController().signal,
      NO_EXECUTION_SECRETS,
      hostExecution(true),
    );
    await settle();
    const host = h.hosts[0];
    const request = hostRequest('run-1', 'request-1');
    host.sendTogether(
      {
        kind: 'response',
        id: host.last('start').id,
        ok: true,
        value: projection('run-1'),
      },
      { kind: 'hostRequest', request },
    );
    await result;
    await settle();
    expect(owner.items).toEqual([request]);
    owner.stop();
    await h.supervisor.stop();
  });

  it('pauses an owner-bound run whose start finished after the owner had gone', async () => {
    const h = harness();
    const owner = await subscribeOwner(h.channel);
    const result = h.supervisor.start(
      startParams('run-1'),
      new AbortController().signal,
      NO_EXECUTION_SECRETS,
      hostExecution(true),
    );
    await settle();
    const host = h.hosts[0];
    owner.stop();
    jest.advanceTimersByTime(10_000);
    await settle();
    host.reply(host.last('start').id, projection('run-1'));
    await result;
    await settle();
    expect(host.of('pause')).toEqual([
      { op: 'pause', executionIds: ['run-1'] },
    ]);
    host.reply(host.last('pause').id, { pausedCount: 1 });
    await settle();
    await h.supervisor.stop();
  });

  it('refuses an owner-bound start while no owner is subscribed', async () => {
    const h = harness();
    await expect(
      h.supervisor.start(
        startParams('run-1'),
        new AbortController().signal,
        NO_EXECUTION_SECRETS,
        hostExecution(true),
      ),
    ).rejects.toMatchObject({
      payload: { code: 'worker.pipeline.ownerUnavailable' },
    });
    expect(h.launch).not.toHaveBeenCalled();
    await h.supervisor.stop();
  });
});
