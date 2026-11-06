import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  CanopyCallerDescriptor,
  OperationRecord,
} from '@canopy/protocol/canopy-core';
import type { TurnEventSink } from '@canopy/core-runtime/node/agent/turns';
import {
  createCoreOperationAdapter,
  type CoreOperationAdapter,
} from '../../canopy-runtime/core-operation-adapter';
import {
  createDesktopRuntime,
  type DesktopCanopyDispatcher,
} from '../../canopy-runtime/desktop-runtime';
import { stopChatTurnExactly } from '../../canopy-runtime/chat-turn-stop';
import { stopChatTurn } from '../../lib/chat-turn-stop';
import { cancelStandaloneChat } from '../../services/standalone-chat-service';
import {
  TurnWorkerUnavailableError,
  beginChatTurnRun,
  emitChatTurnWait,
  type BeginChatTurnRunRequest,
} from '../turn-runs';

jest.mock('../../canopy-runtime/chat-turn-stop', () => ({
  stopChatTurnExactly: jest.fn(() => Promise.resolve(null)),
}));
// The provider stops silently: Stop settles the turn in chat state only.
jest.mock('../../lib/chat-turn-cancel', () => ({
  cancelChatTurn: jest.fn(() => Promise.resolve({ outcome: 'interrupted' })),
  captureChatTurnStop: jest.fn(),
  captureChatTurnStopsForChat: jest.fn(() => []),
  adoptPreparingSendSession: jest.fn((context: unknown) => context),
  isChatTurnStopCurrent: jest.fn(() => true),
}));
jest.mock('../../services/chat-queue-service', () => ({
  getChatQueueService: (): object => ({ onTurnTerminal: jest.fn() }),
}));
jest.mock('../../services/chat-state-service', () => ({
  getChatStateService: (): object => ({
    ingestProviderEvent: jest.fn(() => Promise.resolve()),
    getCompatibilityArchives: jest.fn(() => Promise.resolve({ archived: [] })),
  }),
}));

const stop = jest.mocked(stopChatTurnExactly);
const scope = { workspaceId: 'ws', worktreeId: 'wt', chatId: 'chat' };
const request: BeginChatTurnRunRequest = {
  scope,
  turnId: 'message',
  eventNamespace: 'initial',
  providerId: 'claude',
  model: 'model',
  initiationSource: 'user',
};
const caller: CanopyCallerDescriptor = {
  principalId: 'another-client',
  clientInstanceId: 'test',
  authorityId: 'local-desktop',
  interfaceKind: 'desktop',
  grants: ['core.operation.cancel'],
};

let root: string;
let operations: CoreOperationAdapter;
let runtime: DesktopCanopyDispatcher;
beforeEach(() => {
  stop.mockClear();
  root = mkdtempSync(join(tmpdir(), 'desktop-turn-runs-'));
  operations = createCoreOperationAdapter({
    ledgerPath: () => join(root, 'ledger.sqlite'),
  });
  runtime = createDesktopRuntime({
    operationAdapter: operations,
    shutdownTimeoutMs: 25,
  });
});
afterEach(async () => {
  await runtime.shutdown();
  rmSync(root, { recursive: true, force: true });
});

async function records(): Promise<{
  parent: OperationRecord | undefined;
  child: OperationRecord | undefined;
}> {
  const { items } = await operations.service.list({ limit: 20 });
  return {
    parent: items.find((item) => item.kind === 'core.chat.turn.run'),
    child: items.find((item) => item.kind === 'worker.agent.turn.run'),
  };
}
async function settledRecords(): Promise<{
  parent: OperationRecord | undefined;
  child: OperationRecord | undefined;
}> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const current = await records();
    if (
      current.parent?.status !== 'running' &&
      current.child?.status !== 'running' &&
      current.child?.status !== 'queued'
    )
      return current;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return records();
}

it('records the parent and the worker dispatch before the launch runs', async () => {
  const run = await beginChatTurnRun(request);
  const seen = await run.execute(() => records());
  expect(seen.parent).toMatchObject({ status: 'running', scope });
  expect(seen.child).toMatchObject({
    status: 'running',
    parentOperationId: seen.parent?.operationId,
  });
  run.settle('completed');
  await settledRecords();
});

it('observed provider events reach the handler through the core sink, in order', async () => {
  const sequences: number[] = [];
  const sinkFor = runtime.chatTurnRuns.sinkFor.bind(runtime.chatTurnRuns);
  jest.spyOn(runtime.chatTurnRuns, 'sinkFor').mockImplementation((id) => {
    const sink = sinkFor(id);
    if (!sink) return null;
    const observed: TurnEventSink = (event, local) => {
      sequences.push(event.sequence);
      return sink(event, local);
    };
    return observed;
  });
  const run = await beginChatTurnRun(request);
  const handled: unknown[] = [];
  const onEvent = run.observe((data) => {
    handled.push(data);
  });
  await run.execute(async () => {
    for (const index of [0, 1, 2]) await onEvent({ type: 'event', index });
  });
  expect(handled).toEqual([
    { type: 'event', index: 0 },
    { type: 'event', index: 1 },
    { type: 'event', index: 2 },
  ]);
  expect(sequences).toEqual([0, 1, 2]);
  run.settle('completed');
  await settledRecords();
});

it('settle completed finishes parent and child completed with the event count', async () => {
  const run = await beginChatTurnRun(request);
  const onEvent = run.observe(() => undefined);
  await run.execute(() => onEvent({ type: 'assistant' }));
  run.accepted();
  run.settle('completed');
  const { parent, child } = await settledRecords();
  expect(parent).toMatchObject({ status: 'completed' });
  expect(child).toMatchObject({
    status: 'completed',
    outcome: { status: 'completed', eventCount: 3 },
  });
});

it('core.operation.cancel calls the exact-turn Stop once and settles cancelled', async () => {
  const run = await beginChatTurnRun(request);
  const { parent } = await run.execute(() => records());
  if (!parent) throw new Error('Missing parent');
  for (const reason of ['first stop', 'second stop'])
    await runtime.instruction(
      'core.operation.cancel',
      { operationId: parent.operationId, reason },
      { caller },
    );
  const settled = await settledRecords();
  expect(stop).toHaveBeenCalledTimes(1);
  expect(stop).toHaveBeenCalledWith(
    { projectId: 'ws', worktreeId: 'wt', chatId: 'chat' },
    'message',
  );
  expect(run.signal.aborted).toBe(true);
  expect(settled.parent).toMatchObject({ status: 'cancelled' });
  expect(settled.child).toMatchObject({ status: 'cancelled' });
});

it('a failed exact-turn Stop still settles the cancelled run', async () => {
  stop.mockRejectedValueOnce(new Error('stop failed'));
  const run = await beginChatTurnRun(request);
  const { parent } = await run.execute(() => records());
  if (!parent) throw new Error('Missing parent');
  await runtime.instruction(
    'core.operation.cancel',
    { operationId: parent.operationId, reason: 'stop' },
    { caller },
  );
  const settled = await settledRecords();
  expect(stop).toHaveBeenCalledTimes(1);
  expect(settled.parent).toMatchObject({ status: 'cancelled' });
  expect(settled.child).toMatchObject({ status: 'cancelled' });
});

it('a refused dispatch rejects the waiting execute', async () => {
  jest
    .spyOn(runtime.localWorker, 'dispatch')
    .mockRejectedValueOnce(new Error('refused'));
  const run = await beginChatTurnRun(request);
  const fn = jest.fn();
  await expect(run.execute(fn)).rejects.toBeInstanceOf(
    TurnWorkerUnavailableError,
  );
  expect(fn).not.toHaveBeenCalled();
  expect((await settledRecords()).parent).toMatchObject({ status: 'failed' });
});

it('abandon after accepted is a no-op', async () => {
  const run = await beginChatTurnRun(request);
  await run.execute(() => undefined);
  run.accepted();
  run.abandon(new Error('late'));
  expect((await records()).parent).toMatchObject({ status: 'running' });
  run.settle('completed');
  expect((await settledRecords()).parent).toMatchObject({
    status: 'completed',
  });
});

it('a silent provider stop leaves no live run and the message can be dispatched again', async () => {
  const run = await beginChatTurnRun(request);
  await run.execute(() => undefined);
  run.accepted();
  await stopChatTurn(
    { projectId: 'ws', worktreeId: 'wt', chatId: 'chat' },
    {
      target: { projectId: 'ws', worktreeId: 'wt', chatId: 'chat' },
      session: undefined,
      fence: {
        processOwner: Symbol('owner'),
        turnId: 'provider-turn',
        userMessageId: 'message',
        turnEpoch: 1,
      },
    },
  );
  expect((await settledRecords()).parent).toMatchObject({
    status: 'cancelled',
  });
  expect(runtime.chatTurnRuns.findLive(scope, 'message')).toBeNull();
  const again = await beginChatTurnRun(request);
  await again.execute(() => undefined);
  again.settle('completed');
  await settledRecords();
});

it("a silent stop without a provider fence settles the chat's live run", async () => {
  const run = await beginChatTurnRun(request);
  await run.execute(() => undefined);
  run.accepted();
  await stopChatTurn(
    { projectId: 'ws', worktreeId: 'wt', chatId: 'chat' },
    {
      target: { projectId: 'ws', worktreeId: 'wt', chatId: 'chat' },
      session: undefined,
      fence: undefined,
    },
  );
  expect((await settledRecords()).parent).toMatchObject({
    status: 'cancelled',
  });
  expect(runtime.chatTurnRuns.findLive(scope, 'message')).toBeNull();
});

it('a silent Cowork Stop leaves no live run', async () => {
  const cowork = {
    workspaceId: 'standalone-chat',
    worktreeId: 'cowork-workspace',
    chatId: 'cowork-chat',
  };
  const run = await beginChatTurnRun({ ...request, scope: cowork });
  await run.execute(() => undefined);
  run.accepted();
  await cancelStandaloneChat({
    chatId: 'cowork-chat',
    projectId: 'cowork-workspace',
  });
  expect((await settledRecords()).parent).toMatchObject({
    status: 'cancelled',
  });
  expect(runtime.chatTurnRuns.findLive(cowork, 'message')).toBeNull();
});

it('a settled run takes no more wait envelopes', async () => {
  const run = await beginChatTurnRun(request);
  await run.execute(() => undefined);
  const wait = {
    kind: 'wait_opened',
    waitId: 'question',
    waitKind: 'question',
  } as const;
  expect(emitChatTurnWait(scope, wait)).toBe(true);
  run.settle('completed');
  expect(emitChatTurnWait(scope, wait)).toBe(false);
  await settledRecords();
});
