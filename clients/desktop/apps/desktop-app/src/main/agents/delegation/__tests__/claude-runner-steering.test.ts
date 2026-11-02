const queryMock = jest.fn<unknown, [unknown]>();

jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (params: unknown): unknown => queryMock(params),
  createSdkMcpServer: jest.fn(() => ({ type: 'sdk' })),
  tool: jest.fn((name: string) => ({ name })),
}));

jest.mock('../../claude-process-host-runner', () => ({
  spawnClaudeCodeProcessOffMain: jest.fn(),
}));

jest.mock('../../../pipelines/config-paths', () => ({
  getBundledClaudeBinaryPath: jest.fn(() => '/fake/claude'),
}));

import type { AgentRunRequest } from '@canopy/desktop-shared/node/delegation';
import { createClaudeDelegationRunner } from '../claude-runner';
import { DelegationNativePolicy } from '../native-policy';

const SENTINEL = 'payload-sentinel-delegated-93ab';

const request = {
  delegationId: 'delegation-1',
  runGeneration: 1,
  launchKey: 'launch-1',
  parent: {
    harnessId: 'codex',
    projectId: 'project',
    worktreeId: 'worktree',
    chatId: 'chat',
    sessionKey: 'session',
    turnId: 'turn',
    toolCallId: 'call',
    runtimeGeneration: 1,
    depth: 0,
  },
  task: {
    modelId: 'claude-test',
    description: 'Inspect code',
    prompt: 'Inspect the requested code.',
    executionMode: 'foreground',
    contextPolicy: 'task_only',
    isolation: 'shared_worktree',
  },
  route: {
    selectedModelId: 'claude-test',
    runtimeModelId: 'claude-test',
    harnessId: 'claude',
    runtimeKind: 'claude-sdk',
    runnerRegistrationId: 'claude-local',
    runtimeVersion: '1',
    adapterVersion: '1',
    modelSource: 'test',
    providerType: 'subscription',
    assignmentRevision: 'assignment-1',
    billingAuthority: 'subscription',
    aiCreditsRouted: false,
    capabilities: ['read'],
    supportedThinkingLevels: [],
    capabilitySnapshotHash: 'hash',
    capabilityGeneration: 1,
    policyRevision: 'read-only-1',
  },
  cwd: '/worktree',
  effectivePermission: 'read-only',
  signal: new AbortController().signal,
} satisfies AgentRunRequest;

const capabilities = [
  'msg_lifecycle_v1',
  'interrupt_receipt_v1',
  'interrupt_cancel_queued_v1',
];

function result(): Record<string, unknown> {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'done',
    total_cost_usd: 0,
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

function runner(): ReturnType<typeof createClaudeDelegationRunner> {
  return createClaudeDelegationRunner({
    available: () => Promise.resolve({ available: true }),
    prepare: () =>
      Promise.resolve({
        model: 'claude-test',
        environment: { PATH: '' },
        tools: new DelegationNativePolicy({
          cwd: process.cwd(),
          writePaths: [],
          signal: new AbortController().signal,
          delegationId: request.delegationId,
          mode: () => 'full-access',
          allowed: () => Promise.resolve(true),
          approval: {
            check: () => Promise.resolve({ decision: 'allow' }),
            setMode: (): void => undefined,
            reevaluatePendingApprovals: (): Promise<void> => Promise.resolve(),
            dispose: (): void => undefined,
          },
          emit: (): Promise<void> => Promise.resolve(),
        }),
      }),
    reportError: jest.fn(),
  });
}

beforeEach(() => queryMock.mockReset());
afterEach(() => jest.useRealTimers());

it('keeps a delegated steer unconfirmed until sixty seconds after handoff, never pending', async () => {
  const finish = { release: (): void => undefined };
  const finished = new Promise<void>((resolve) => {
    finish.release = resolve;
  });
  const sent: unknown[] = [];
  let pendingInput: AsyncIterable<unknown> | undefined;
  async function* events(): AsyncGenerator<Record<string, unknown>> {
    yield {
      type: 'system',
      subtype: 'init',
      session_id: 'native-session',
      capabilities,
    };
    await finished;
    yield result();
  }
  queryMock.mockReturnValue(
    Object.assign(events(), {
      close: jest.fn(),
      cancelAsyncMessage: jest.fn(),
      interrupt: jest.fn(),
      streamInput: jest.fn((input: AsyncIterable<unknown>) => {
        pendingInput = input;
        return Promise.resolve();
      }),
    }),
  );
  const delegated = runner();
  let started = (): void => undefined;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const handle = await delegated.start(request, (event) => {
    if (event.event.type === 'started') started();
    return Promise.resolve();
  });
  await ready;
  jest.useFakeTimers({
    doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'],
  });
  const attemptId = '123e4567-e89b-42d3-a456-426614174010';
  try {
    const steer = delegated.steer(handle, {
      delegationId: request.delegationId,
      runGeneration: request.runGeneration,
      attemptId,
      message: `Correction ${SENTINEL}`,
    });
    await jest.advanceTimersByTimeAsync(8000);
    const input = pendingInput;
    if (!input) throw new Error('Expected the SDK input stream');
    for await (const message of input) sent.push(message);
    let settled = false;
    void steer.then(() => {
      settled = true;
    });
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(52000);
    expect(settled).toBe(false);
    await jest.advanceTimersByTimeAsync(8000);
    const admission = await steer;
    expect(sent).toHaveLength(1);
    expect(admission).toEqual({
      kind: 'unknown',
      attemptId,
      reason:
        'Delivery was not confirmed. This message will not be resent automatically.',
      failure: {
        class: 'timeout',
        code: 'delivery-deadline',
        summary:
          'The provider did not confirm the message before the delivery deadline.',
      },
    });
    expect(JSON.stringify(admission)).not.toContain(SENTINEL);
  } finally {
    jest.useRealTimers();
    finish.release();
    await delegated.close(handle);
  }
});

it('does not yield a steer if its attempt was rejected before the provider pulls it', async () => {
  const finish = { release: (): void => undefined };
  const finished = new Promise<void>((resolve) => {
    finish.release = resolve;
  });
  const suppliedInputs: AsyncIterable<unknown>[] = [];
  async function* events(): AsyncGenerator<Record<string, unknown>> {
    yield {
      type: 'system',
      subtype: 'init',
      session_id: 'native-session',
      capabilities,
    };
    await finished;
    yield result();
  }
  queryMock.mockReturnValue(
    Object.assign(events(), {
      close: jest.fn(),
      cancelAsyncMessage: jest.fn(),
      interrupt: jest.fn(),
      streamInput: jest.fn((input: AsyncIterable<unknown>) => {
        suppliedInputs.push(input);
        return Promise.resolve();
      }),
    }),
  );
  const delegated = runner();
  let started = (): void => undefined;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  let terminal = (): void => undefined;
  const ended = new Promise<void>((resolve) => {
    terminal = resolve;
  });
  const handle = await delegated.start(request, (event) => {
    if (event.event.type === 'started') started();
    if (event.event.type === 'terminal') terminal();
    return Promise.resolve();
  });
  await ready;
  const attemptId = '123e4567-e89b-42d3-a456-426614174012';
  const steering = delegated.steer(handle, {
    delegationId: request.delegationId,
    runGeneration: request.runGeneration,
    attemptId,
    message: 'Do not send after rejection.',
  });
  expect(suppliedInputs).toHaveLength(1);

  finish.release();
  await ended;
  await expect(steering).resolves.toMatchObject({
    kind: 'rejected',
    attemptId,
    fallback: 'ordinary',
  });
  const input = suppliedInputs[0];
  if (!input) throw new Error('Expected the SDK input stream');
  const iteratorResult = await input[Symbol.asyncIterator]().next();
  expect(iteratorResult.done).toBe(true);
  await delegated.close(handle);
});

it('marks a delegated steer after the turn ended with the turn-ended refusal', async () => {
  async function* events(): AsyncGenerator<Record<string, unknown>> {
    await Promise.resolve();
    yield {
      type: 'system',
      subtype: 'init',
      session_id: 'native-session',
      capabilities,
    };
    yield result();
  }
  queryMock.mockReturnValue(
    Object.assign(events(), {
      close: jest.fn(),
      cancelAsyncMessage: jest.fn(),
      interrupt: jest.fn(),
      streamInput: jest.fn(() => Promise.resolve()),
    }),
  );
  const delegated = runner();
  let terminal = (): void => undefined;
  const ended = new Promise<void>((resolve) => {
    terminal = resolve;
  });
  const handle = await delegated.start(request, (event) => {
    if (event.event.type === 'terminal') terminal();
    return Promise.resolve();
  });
  await ended;
  const attemptId = '123e4567-e89b-42d3-a456-426614174011';
  await expect(
    delegated.steer(handle, {
      delegationId: request.delegationId,
      runGeneration: request.runGeneration,
      attemptId,
      message: 'Follow up after completion.',
    }),
  ).resolves.toEqual({
    kind: 'rejected',
    attemptId,
    reason: 'The delegated SDK turn has ended',
    fallback: 'ordinary',
    refusal: {
      code: 'turn-ended',
      summary: 'The turn ended before the message was taken.',
    },
  });
  await delegated.close(handle);
});

it('marks a delegated steer that cannot be correlated with the not-correlated refusal', async () => {
  const finish = { release: (): void => undefined };
  const finished = new Promise<void>((resolve) => {
    finish.release = resolve;
  });
  async function* events(): AsyncGenerator<Record<string, unknown>> {
    yield {
      type: 'system',
      subtype: 'init',
      session_id: 'native-session',
      capabilities,
    };
    await finished;
    yield result();
  }
  queryMock.mockReturnValue(
    Object.assign(events(), {
      close: jest.fn(),
      cancelAsyncMessage: jest.fn(),
      interrupt: jest.fn(),
      streamInput: jest.fn(() => Promise.resolve()),
    }),
  );
  const delegated = runner();
  let started = (): void => undefined;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const handle = await delegated.start(request, (event) => {
    if (event.event.type === 'started') started();
    return Promise.resolve();
  });
  await ready;
  try {
    const admission = await delegated.steer(handle, {
      delegationId: request.delegationId,
      runGeneration: request.runGeneration,
      attemptId: 'not-a-uuid',
      message: 'Correction',
    });
    expect(admission).toEqual({
      kind: 'rejected',
      attemptId: 'not-a-uuid',
      reason: 'The delegated session cannot correlate this message',
      refusal: {
        code: 'not-correlated',
        summary: 'The session cannot correlate this message.',
      },
    });
  } finally {
    finish.release();
    await delegated.close(handle);
  }
});
