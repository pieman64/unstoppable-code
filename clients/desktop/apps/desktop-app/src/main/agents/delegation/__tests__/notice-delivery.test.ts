import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAND } from '@canopy/brand/current';
import type {
  StoredDelegateOutput,
  StoredDelegation,
} from '@canopy/desktop-shared/node/delegation/broker';
import { createDelegationRunState } from '@canopy/desktop-shared/node/delegation/lifecycle';
import { delegationControlSchema } from '@canopy/desktop-shared/node/delegation/storage';
import type { DelegationParentContext } from '@canopy/desktop-shared/node/delegation';
import {
  ChildMessageAdmissionRefusedError,
  type ManagedChildMessageInbox,
} from '../child-messages';
import type {
  deliverGeneratedWatcherMessageToChat,
  GeneratedWatcherMessageDeliveryOutcome,
} from '../../../services/watcher-chat-delivery';
import {
  DelegationNoticeAckStore,
  noticeBatchId,
  noticeId,
} from '../notice-acks';
import {
  DelegationNoticeDelivery,
  delegationNoticeRootParentKey,
  noticeDeliveryOperationId,
} from '../notice-delivery';

type GeneratedWatcherMessageRequest = Parameters<
  typeof deliverGeneratedWatcherMessageToChat
>[0];

type ChildMessageDelivery = ManagedChildMessageInbox['deliver'];
type ChildMessageDeliveryMock = jest.MockedFunction<ChildMessageDelivery>;
type MockedChildMessageInbox = Pick<ManagedChildMessageInbox, 'deliver'> & {
  readonly deliver: ChildMessageDeliveryMock;
};

function childMessageDeliveryMock(
  implementation: ChildMessageDelivery = (): ReturnType<ChildMessageDelivery> =>
    Promise.resolve({ ok: true, value: undefined }),
): ChildMessageDeliveryMock {
  return jest.fn<
    ReturnType<ChildMessageDelivery>,
    Parameters<ChildMessageDelivery>
  >(implementation);
}

function childMessageInboxMock(
  implementation?: ChildMessageDelivery,
): MockedChildMessageInbox {
  return { deliver: childMessageDeliveryMock(implementation) };
}

const mockDeliverGeneratedWatcherMessageToChat = jest.fn<
  Promise<GeneratedWatcherMessageDeliveryOutcome>,
  [GeneratedWatcherMessageRequest]
>();

jest.mock('../../../services/watcher-chat-delivery', () => ({
  deliverGeneratedWatcherMessageToChat: (
    request: GeneratedWatcherMessageRequest,
  ): Promise<GeneratedWatcherMessageDeliveryOutcome> =>
    mockDeliverGeneratedWatcherMessageToChat(request),
}));

interface TestScope {
  readonly directory: string;
  readonly store: DelegationNoticeAckStore;
}

interface RecordOptions {
  readonly chatId?: string;
  readonly name?: string;
  readonly parentDelegationId?: string;
  readonly callerParentDelegationId?: string;
  readonly status?: 'pending' | 'running' | 'completed';
}

const temporaryDirectories: string[] = [];

async function makeScope(): Promise<TestScope> {
  const directory = await mkdtemp(
    join(tmpdir(), 'delegation-notice-delivery-'),
  );
  temporaryDirectories.push(directory);
  const store = new DelegationNoticeAckStore(directory);
  await store.load();
  store.markBaselined();
  await store.flush();
  return { directory, store };
}

function record(
  delegationId: string,
  options: RecordOptions = {},
): StoredDelegation {
  const parentDelegationId = options.parentDelegationId;
  return {
    version: 2,
    ...(parentDelegationId ? { parentDelegationId } : {}),
    parent: {
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: options.chatId ?? 'chat',
      harnessId: 'claude',
      sessionKey: `session-${delegationId}`,
      turnId: 'turn',
      toolCallId: 'tool-call',
      runtimeGeneration: 1,
      depth: parentDelegationId ? 2 : 0,
      ...(options.callerParentDelegationId
        ? { parentDelegationId: options.callerParentDelegationId }
        : {}),
    },
    task: {
      modelId: 'model',
      name: options.name ?? `name-${delegationId}`,
      description: `Task ${delegationId}`,
      prompt: 'Do the task.',
      executionMode: 'background',
      contextPolicy: 'task_only',
      isolation: 'shared_worktree',
    },
    state: {
      ...createDelegationRunState(delegationId, 1),
      status: options.status ?? 'running',
    },
    callKey: `call-${delegationId}`,
    requestHash: `hash-${delegationId}`,
    createdAt: 1,
    launch: {
      version: 1,
      delegationId,
      launchKey: `launch-${delegationId}`,
      runGeneration: 1,
      phase: 'settled',
      terminalStatus: 'completed',
    },
    delivery: { status: 'unclaimed' },
  };
}

function output(
  delegationId: string,
  options: {
    readonly resultIndex?: number;
    readonly runGeneration?: number;
    readonly status?: StoredDelegateOutput['status'];
    readonly stopReason?: StoredDelegateOutput['stopReason'];
    readonly settledAt?: number;
    readonly error?: StoredDelegateOutput['error'];
    readonly outputTruncated?: boolean;
    readonly finalText?: string;
  } = {},
): StoredDelegateOutput {
  return {
    resultIndex: options.resultIndex ?? 1,
    runGeneration: options.runGeneration ?? 1,
    status: options.status ?? 'completed',
    settledAt: options.settledAt ?? 10,
    outputTruncated: options.outputTruncated ?? false,
    ...(options.stopReason ? { stopReason: options.stopReason } : {}),
    ...(options.error ? { error: options.error } : {}),
    ...(options.finalText ? { finalText: options.finalText } : {}),
  };
}

function parentContext(stored: StoredDelegation): DelegationParentContext {
  return stored.parent;
}

function delivery(
  scope: TestScope,
  records: readonly StoredDelegation[],
  outputs: ReadonlyMap<string, readonly StoredDelegateOutput[]>,
  childMessages: MockedChildMessageInbox = childMessageInboxMock(),
): DelegationNoticeDelivery {
  return new DelegationNoticeDelivery({
    store: scope.store,
    records: (): Promise<readonly StoredDelegation[]> =>
      Promise.resolve(records),
    results: (
      stored: StoredDelegation,
    ): Promise<readonly StoredDelegateOutput[]> =>
      Promise.resolve(outputs.get(stored.state.delegationId) ?? []),
    childMessages,
    onError: jest.fn(),
  });
}

async function waitFor(
  condition: () => boolean,
  description: string,
): Promise<void> {
  const deadline = process.hrtime.bigint() + 2_000_000_000n;
  while (process.hrtime.bigint() < deadline) {
    if (condition()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

async function waitForAck(
  scope: TestScope,
  delegationId: string,
  reason?: string,
): Promise<void> {
  await waitFor(() => {
    const ack = scope.store.ack(delegationId);
    return (
      ack !== undefined &&
      (reason === undefined || ack.suppressedReason === reason)
    );
  }, `notice acknowledgement for ${delegationId}`);
}

afterEach(async () => {
  jest.clearAllMocks();
  jest.useRealTimers();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

beforeEach(() => {
  mockDeliverGeneratedWatcherMessageToChat.mockReset();
  mockDeliverGeneratedWatcherMessageToChat.mockResolvedValue('submitted');
});

describe('DelegationNoticeDelivery', () => {
  it('batches near-simultaneous siblings into one watcher-shaped root delivery without delegate output', async () => {
    const scope = await makeScope();
    const siblings = [record('one'), record('two'), record('three')];
    const service = delivery(scope, siblings, new Map());

    await service.start();
    for (const sibling of siblings) {
      await service.settled(
        parentContext(sibling),
        sibling.state.delegationId,
        output(sibling.state.delegationId, {
          finalText: 'DO NOT INCLUDE THIS CHILD OUTPUT',
        }),
      );
    }
    await waitForAck(scope, 'one');
    await service.close();

    expect(mockDeliverGeneratedWatcherMessageToChat).toHaveBeenCalledTimes(1);
    const firstCall = mockDeliverGeneratedWatcherMessageToChat.mock.calls[0];
    if (!firstCall) throw new Error('Expected a generated watcher delivery.');
    const request = firstCall[0];
    expect(request).toEqual(
      expect.objectContaining({
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
        watcherFired: { kind: 'Delegate finished' },
      }),
    );
    expect(typeof request.delegationNoticeBatchId).toBe('string');
    expect(typeof request.userMessageId).toBe('string');
    expect(request.delegationNoticeBatchId).toBe(request.userMessageId);
    expect(request.watcherDeliveryId).toBeUndefined();
    expect(request.text).toContain(`${BRAND.displayName} delegate finished.`);
    expect(request.text).toContain('name-one: completed');
    expect(request.text).toContain('name-two: completed');
    expect(request.text).toContain('name-three: completed');
    expect(request.hiddenContextText).not.toContain(
      'DO NOT INCLUDE THIS CHILD OUTPUT',
    );
    expect(request.hiddenContextText).toContain(
      `<${BRAND.tools.namespace}_watcher_event>`,
    );
    expect(scope.store.pending()).toEqual([]);
    for (const sibling of siblings) {
      expect(scope.store.ack(sibling.state.delegationId)).toEqual({
        resultIndex: 1,
      });
    }
  });

  it('flushes immediately when a settlement has no active sibling', async () => {
    const scope = await makeScope();
    const only = record('only');
    const service = delivery(scope, [only], new Map());

    await service.start();
    await service.settled(parentContext(only), 'only', output('only'));
    await waitFor(
      () => mockDeliverGeneratedWatcherMessageToChat.mock.calls.length === 1,
      'immediate root notice delivery',
    );

    expect(mockDeliverGeneratedWatcherMessageToChat).toHaveBeenCalledTimes(1);
    await waitForAck(scope, 'only');
    expect(scope.store.ack('only')).toEqual({ resultIndex: 1 });
    await service.close();
  });

  it('refreshes all sibling statuses for live settlements without hydrating sibling histories', async () => {
    const scope = await makeScope();
    let currentRecords: readonly StoredDelegation[] = [];
    const results = jest.fn<Promise<readonly StoredDelegateOutput[]>, []>(() =>
      Promise.resolve([]),
    );
    const service = new DelegationNoticeDelivery({
      store: scope.store,
      records: (): Promise<readonly StoredDelegation[]> =>
        Promise.resolve(currentRecords),
      results,
      childMessages: childMessageInboxMock(),
      onError: jest.fn(),
    });
    const siblings = [
      record('discovered-one'),
      record('discovered-two'),
      record('discovered-three'),
    ];

    await service.start();
    currentRecords = siblings;
    for (const sibling of siblings) {
      await service.settled(
        parentContext(sibling),
        sibling.state.delegationId,
        output(sibling.state.delegationId),
      );
    }
    await waitForAck(scope, 'discovered-one');

    expect(results).not.toHaveBeenCalled();
    expect(mockDeliverGeneratedWatcherMessageToChat).toHaveBeenCalledTimes(1);
    expect(
      mockDeliverGeneratedWatcherMessageToChat.mock.calls[0]?.[0].text,
    ).toContain('name-discovered-three: completed');
    await service.close();
  });

  it('uses a still-running task description when its name is blank', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    const scope = await makeScope();
    const settled = record('settled-with-active-sibling');
    const activeSibling = record('description-fallback', { name: '   ' });
    const service = delivery(scope, [settled, activeSibling], new Map());

    await service.start();
    await service.settled(
      parentContext(settled),
      settled.state.delegationId,
      output(settled.state.delegationId),
    );
    await jest.advanceTimersByTimeAsync(750);
    await waitFor(
      (): boolean =>
        mockDeliverGeneratedWatcherMessageToChat.mock.calls.length === 1,
      'notice with the active sibling description',
    );

    const request = mockDeliverGeneratedWatcherMessageToChat.mock.calls[0]?.[0];
    expect(request?.hiddenContextText).toContain('Task description-fallback');
    await service.close();
  });

  it('retries a failed journal write before later batches for the same chat', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'delegation-notice-order-'));
    temporaryDirectories.push(directory);
    const first = record('journal-first');
    const firstBatchId = noticeBatchId([noticeId('journal-first', 1, 1)]);
    let shouldFailFirstJournal = false;
    const store = new DelegationNoticeAckStore(directory, {
      writeFile: async (filePath: string, data: string): Promise<void> => {
        const state: unknown = JSON.parse(data);
        const firstJournalIsPresent =
          typeof state === 'object' &&
          state !== null &&
          'pending' in state &&
          Array.isArray(state.pending) &&
          state.pending.some(
            (batch: unknown) =>
              typeof batch === 'object' &&
              batch !== null &&
              'batchId' in batch &&
              batch.batchId === firstBatchId,
          );
        if (shouldFailFirstJournal && firstJournalIsPresent) {
          shouldFailFirstJournal = false;
          throw new Error('first batch journal write failed');
        }
        await writeFile(filePath, data, 'utf8');
      },
    });
    await store.load();
    store.markBaselined();
    await store.flush();
    shouldFailFirstJournal = true;
    const second = record('journal-second');
    let currentRecords: readonly StoredDelegation[] = [first];
    const errors: unknown[] = [];
    const service = new DelegationNoticeDelivery({
      store,
      records: (): Promise<readonly StoredDelegation[]> =>
        Promise.resolve(currentRecords),
      results: (): Promise<readonly StoredDelegateOutput[]> =>
        Promise.resolve([]),
      childMessages: childMessageInboxMock(),
      onError: (error: unknown): void => {
        errors.push(error);
      },
    });

    await service.start();
    await service.settled(
      parentContext(first),
      'journal-first',
      output('journal-first'),
    );
    await waitFor(
      () => errors.length === 1,
      'first parent batch journal failure',
    );
    currentRecords = [first, second];
    await service.settled(
      parentContext(second),
      'journal-second',
      output('journal-second'),
    );

    // The next notice for the same chat retries the failed batch first.
    await waitFor(
      () => mockDeliverGeneratedWatcherMessageToChat.mock.calls.length === 2,
      'retried first batch and the later batch',
    );
    expect(
      mockDeliverGeneratedWatcherMessageToChat.mock.calls.map(
        ([request]) => request.userMessageId,
      ),
    ).toEqual([
      firstBatchId,
      noticeBatchId([noticeId('journal-second', 1, 1)]),
    ]);
    await waitFor(() => store.pending().length === 0, 'both batches cleared');
    await service.close();
  });

  it('retries a root batch whose dispatch failed when the next notice for that chat arrives', async () => {
    const scope = await makeScope();
    const first = record('dispatch-first');
    const second = record('dispatch-second');
    mockDeliverGeneratedWatcherMessageToChat.mockRejectedValueOnce(
      new Error('transient dispatch failure'),
    );
    let currentRecords: readonly StoredDelegation[] = [first];
    const service = new DelegationNoticeDelivery({
      store: scope.store,
      records: (): Promise<readonly StoredDelegation[]> =>
        Promise.resolve(currentRecords),
      results: (): Promise<readonly StoredDelegateOutput[]> =>
        Promise.resolve([]),
      childMessages: childMessageInboxMock(),
      onError: jest.fn(),
    });

    await service.start();
    await service.settled(
      parentContext(first),
      'dispatch-first',
      output('dispatch-first'),
    );
    await waitFor(
      () => mockDeliverGeneratedWatcherMessageToChat.mock.calls.length === 1,
      'failed first dispatch',
    );
    currentRecords = [first, second];
    await service.settled(
      parentContext(second),
      'dispatch-second',
      output('dispatch-second'),
    );
    await waitForAck(scope, 'dispatch-second');
    await waitForAck(scope, 'dispatch-first');

    expect(
      mockDeliverGeneratedWatcherMessageToChat.mock.calls.map(
        ([request]) => request.userMessageId,
      ),
    ).toEqual([
      noticeBatchId([noticeId('dispatch-first', 1, 1)]),
      noticeBatchId([noticeId('dispatch-first', 1, 1)]),
      noticeBatchId([noticeId('dispatch-second', 1, 1)]),
    ]);
    expect(scope.store.ack('dispatch-first')).toEqual({ resultIndex: 1 });
    await service.close();
  });

  it('retries a failed root hand-off when the next notice arrived during that hand-off', async () => {
    const scope = await makeScope();
    const first = record('inflight-first');
    const second = record('inflight-second');
    let rejectFirst: ((error: Error) => void) | undefined;
    mockDeliverGeneratedWatcherMessageToChat.mockImplementationOnce(
      () =>
        new Promise<GeneratedWatcherMessageDeliveryOutcome>(
          (_resolve, reject) => {
            rejectFirst = reject;
          },
        ),
    );
    let currentRecords: readonly StoredDelegation[] = [first];
    const service = new DelegationNoticeDelivery({
      store: scope.store,
      records: (): Promise<readonly StoredDelegation[]> =>
        Promise.resolve(currentRecords),
      results: (): Promise<readonly StoredDelegateOutput[]> =>
        Promise.resolve([]),
      childMessages: childMessageInboxMock(),
      onError: jest.fn(),
    });

    await service.start();
    await service.settled(
      parentContext(first),
      'inflight-first',
      output('inflight-first'),
    );
    await waitFor(() => rejectFirst !== undefined, 'first hand-off in flight');
    currentRecords = [first, second];
    await service.settled(
      parentContext(second),
      'inflight-second',
      output('inflight-second'),
    );
    rejectFirst?.(new Error('transient dispatch failure'));
    await waitForAck(scope, 'inflight-second');
    await waitForAck(scope, 'inflight-first');

    expect(
      mockDeliverGeneratedWatcherMessageToChat.mock.calls.map(
        ([request]) => request.userMessageId,
      ),
    ).toEqual([
      noticeBatchId([noticeId('inflight-first', 1, 1)]),
      noticeBatchId([noticeId('inflight-first', 1, 1)]),
      noticeBatchId([noticeId('inflight-second', 1, 1)]),
    ]);
    await service.close();
  });

  it('journals a nested batch durably before replay hands it to the parent inbox after a failed write', async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'delegation-notice-nested-'),
    );
    temporaryDirectories.push(directory);
    const nested = record('journal-nested', {
      parentDelegationId: 'journal-parent',
    });
    const batchId = noticeBatchId([noticeId('journal-nested', 1, 1)]);
    let failNextJournal = false;
    const store = new DelegationNoticeAckStore(directory, {
      writeFile: async (filePath: string, data: string): Promise<void> => {
        if (failNextJournal && data.includes(batchId)) {
          failNextJournal = false;
          throw new Error('nested journal write failed');
        }
        await writeFile(filePath, data, 'utf8');
      },
    });
    await store.load();
    store.markBaselined();
    await store.flush();
    failNextJournal = true;
    const durableAtHandOff: boolean[] = [];
    const childMessages = childMessageInboxMock(async () => {
      const durable = await readFile(
        join(directory, 'notice-acks.json'),
        'utf8',
      );
      durableAtHandOff.push(durable.includes(batchId));
      return { ok: true, value: undefined };
    });
    const service = new DelegationNoticeDelivery({
      store,
      records: (): Promise<readonly StoredDelegation[]> =>
        Promise.resolve([nested]),
      results: (): Promise<readonly StoredDelegateOutput[]> =>
        Promise.resolve([]),
      childMessages,
      onError: jest.fn(),
    });

    await service.start();
    await service.settled(
      parentContext(nested),
      'journal-nested',
      output('journal-nested'),
    );
    await waitFor(() => !failNextJournal, 'failed nested journal write');
    await service.replayForChat({
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
    });
    await waitFor(
      () => store.ack('journal-nested') !== undefined,
      'nested ack',
    );

    expect(durableAtHandOff).toEqual([true]);
    await service.close();
  });

  it('refuses a stopped child notice to a completed parent fenced by Stop all', async () => {
    const scope = await makeScope();
    const parent = record('fenced-parent', { status: 'completed' });
    const child = record('fenced-child', {
      parentDelegationId: 'fenced-parent',
    });
    const childMessages = childMessageInboxMock(
      (_id, _message, _deliveryId, _failure, admit) =>
        admit && !admit()
          ? Promise.reject(new ChildMessageAdmissionRefusedError())
          : Promise.resolve({ ok: true, value: undefined }),
    );
    const service = delivery(scope, [parent, child], new Map(), childMessages);

    await service.start();
    await service.fenceChat({
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
    });
    await service.settled(
      parentContext(child),
      'fenced-child',
      output('fenced-child', {
        status: 'cancelled',
        stopReason: 'user_cancelled',
      }),
    );
    await waitForAck(scope, 'fenced-child', 'parent_stopped');
    await service.close();

    expect(scope.store.ack('fenced-child')).toEqual({
      resultIndex: 1,
      suppressedReason: 'parent_stopped',
    });
  });

  it('drops notices buffered before revocation and still delivers a later delegate', async () => {
    const scope = await makeScope();
    const earlier = record('revoked-earlier');
    const sibling = record('revoked-sibling');
    const later = record('revoked-later');
    let currentRecords: readonly StoredDelegation[] = [earlier, sibling];
    const service = new DelegationNoticeDelivery({
      store: scope.store,
      records: (): Promise<readonly StoredDelegation[]> =>
        Promise.resolve(currentRecords),
      results: (): Promise<readonly StoredDelegateOutput[]> =>
        Promise.resolve([]),
      childMessages: childMessageInboxMock(),
      onError: jest.fn(),
    });
    const rootKey = delegationNoticeRootParentKey(
      'project',
      'worktree',
      'chat',
    );

    await service.start();
    // The running sibling holds the earlier notice in its window.
    await service.settled(
      parentContext(earlier),
      'revoked-earlier',
      output('revoked-earlier'),
    );
    await service.revokeParent(rootKey, 'policy_revoked');
    expect(mockDeliverGeneratedWatcherMessageToChat).not.toHaveBeenCalled();
    expect(scope.store.ack('revoked-earlier')).toEqual({
      resultIndex: 1,
      suppressedReason: 'policy_revoked',
    });

    currentRecords = [earlier, later];
    await service.settled(
      parentContext(later),
      'revoked-later',
      output('revoked-later'),
    );
    await waitForAck(scope, 'revoked-later');
    expect(mockDeliverGeneratedWatcherMessageToChat).toHaveBeenCalledTimes(1);
    expect(
      mockDeliverGeneratedWatcherMessageToChat.mock.calls[0]?.[0].text,
    ).toContain('name-revoked-later');
    await service.close();
  });

  it('keeps a windowed notice unacknowledged across app shutdown and delivers it after restart', async () => {
    const scope = await makeScope();
    const windowed = record('quit-windowed');
    const sibling = record('quit-sibling');
    const service = delivery(scope, [windowed, sibling], new Map());

    await service.start();
    // The running sibling holds the debounce window open.
    await service.settled(
      parentContext(windowed),
      'quit-windowed',
      output('quit-windowed'),
    );
    await service.close();

    expect(mockDeliverGeneratedWatcherMessageToChat).not.toHaveBeenCalled();
    expect(scope.store.ack('quit-windowed')).toBeUndefined();

    const restartedStore = new DelegationNoticeAckStore(scope.directory);
    await restartedStore.load();
    const restarted = delivery(
      { directory: scope.directory, store: restartedStore },
      [record('quit-windowed', { status: 'completed' })],
      new Map([['quit-windowed', [output('quit-windowed')]]]),
    );
    await restarted.start();
    await waitFor(
      () => restartedStore.ack('quit-windowed') !== undefined,
      'restart delivery of the windowed notice',
    );
    expect(mockDeliverGeneratedWatcherMessageToChat).toHaveBeenCalledTimes(1);
    expect(restartedStore.ack('quit-windowed')).toEqual({ resultIndex: 1 });
    await restarted.close();
  });

  it('delivers a notice deferred by shutdown even after a later generation is stopped by that shutdown', async () => {
    const scope = await makeScope();
    const windowed = record('quit-later-gen');
    const sibling = record('quit-later-sibling');
    const service = delivery(scope, [windowed, sibling], new Map());

    await service.start();
    await service.settled(
      parentContext(windowed),
      'quit-later-gen',
      output('quit-later-gen'),
    );
    await service.close();
    // The quit then stops the delegate's next generation.
    await service.settled(
      parentContext(windowed),
      'quit-later-gen',
      output('quit-later-gen', {
        resultIndex: 2,
        runGeneration: 2,
        status: 'cancelled',
        stopReason: 'shutdown',
      }),
    );
    await waitForAck(scope, 'quit-later-gen', 'shutdown');

    const restartedStore = new DelegationNoticeAckStore(scope.directory);
    await restartedStore.load();
    const restarted = delivery(
      { directory: scope.directory, store: restartedStore },
      [record('quit-later-gen', { status: 'completed' })],
      new Map([
        [
          'quit-later-gen',
          [
            output('quit-later-gen'),
            output('quit-later-gen', {
              resultIndex: 2,
              runGeneration: 2,
              status: 'cancelled',
              stopReason: 'shutdown',
            }),
          ],
        ],
      ]),
    );
    await restarted.start();
    await waitFor(
      () => mockDeliverGeneratedWatcherMessageToChat.mock.calls.length === 1,
      'restart delivery of the deferred first generation',
    );
    await waitFor(
      () => restartedStore.owed().length === 0,
      'owed deferred notice settled',
    );
    expect(
      mockDeliverGeneratedWatcherMessageToChat.mock.calls[0]?.[0].userMessageId,
    ).toBe(noticeBatchId([noticeId('quit-later-gen', 1, 1)]));
    await restarted.close();
    expect(mockDeliverGeneratedWatcherMessageToChat).toHaveBeenCalledTimes(1);
  });

  it('keeps a journaled batch pending across app shutdown after a failed dispatch', async () => {
    const scope = await makeScope();
    const child = record('quit-pending');
    const batchId = noticeBatchId([noticeId('quit-pending', 1, 1)]);
    mockDeliverGeneratedWatcherMessageToChat.mockRejectedValueOnce(
      new Error('transient dispatch failure'),
    );
    const service = delivery(scope, [child], new Map());

    await service.start();
    await service.settled(
      parentContext(child),
      'quit-pending',
      output('quit-pending'),
    );
    await waitFor(
      () => mockDeliverGeneratedWatcherMessageToChat.mock.calls.length === 1,
      'failed dispatch',
    );
    await service.close();

    expect(scope.store.ack('quit-pending')).toBeUndefined();
    const restartedStore = new DelegationNoticeAckStore(scope.directory);
    await restartedStore.load();
    expect(restartedStore.pending().map(({ batchId: id }) => id)).toEqual([
      batchId,
    ]);
    const restarted = delivery(
      { directory: scope.directory, store: restartedStore },
      [record('quit-pending', { status: 'completed' })],
      new Map([['quit-pending', [output('quit-pending')]]]),
    );
    await restarted.start();
    await waitFor(
      () => restartedStore.ack('quit-pending') !== undefined,
      'restart replay of the pending batch',
    );
    expect(mockDeliverGeneratedWatcherMessageToChat).toHaveBeenCalledTimes(2);
    expect(restartedStore.pending()).toEqual([]);
    await restarted.close();
  });

  it('refuses to resume a stopped parent delegate and records the suppression', async () => {
    const scope = await makeScope();
    const parent = record('stopped-parent');
    const nested = record('nested-of-stopped', {
      parentDelegationId: 'stopped-parent',
    });
    const childMessages = childMessageInboxMock(
      (_id, _message, _deliveryId, _failure, admit) =>
        admit && !admit()
          ? Promise.reject(new ChildMessageAdmissionRefusedError())
          : Promise.resolve({ ok: true, value: undefined }),
    );
    const service = delivery(scope, [parent, nested], new Map(), childMessages);

    await service.start();
    await service.settled(
      parentContext(parent),
      'stopped-parent',
      output('stopped-parent', {
        status: 'cancelled',
        stopReason: 'user_cancelled',
      }),
    );
    await service.settled(
      parentContext(nested),
      'nested-of-stopped',
      output('nested-of-stopped'),
    );
    await waitForAck(scope, 'nested-of-stopped', 'parent_stopped');
    await service.close();

    expect(childMessages.deliver).toHaveBeenCalledTimes(1);
    expect(scope.store.ack('nested-of-stopped')).toEqual({
      resultIndex: 1,
      suppressedReason: 'parent_stopped',
    });
  });

  it.each([
    'parent_cancelled',
    'ancestor_stopped',
    'shutdown',
    'policy_revoked',
  ] as const)(
    'acknowledges and never batches a result stopped by %s',
    async (stopReason) => {
      const scope = await makeScope();
      const child = record('stopped');
      const service = delivery(scope, [child], new Map());

      await service.start();
      await service.settled(
        parentContext(child),
        'stopped',
        output('stopped', { status: 'cancelled', stopReason }),
      );
      await waitForAck(scope, 'stopped', stopReason);
      await service.close();

      expect(mockDeliverGeneratedWatcherMessageToChat).not.toHaveBeenCalled();
      expect(scope.store.ack('stopped')).toEqual({
        resultIndex: 1,
        suppressedReason: stopReason,
      });
    },
  );

  it('acknowledges an already-settled teardown result silently during startup replay', async () => {
    const scope = await makeScope();
    const stopped = record('stopped-before-restart');
    const service = delivery(
      scope,
      [stopped],
      new Map([
        [
          'stopped-before-restart',
          [output('stopped-before-restart', { stopReason: 'shutdown' })],
        ],
      ]),
    );

    await service.start();

    expect(mockDeliverGeneratedWatcherMessageToChat).not.toHaveBeenCalled();
    expect(scope.store.ack('stopped-before-restart')).toEqual({
      resultIndex: 1,
      suppressedReason: 'shutdown',
    });
    await service.close();
  });

  it.each([
    ['gone', 'parent_gone', 'parent_gone'],
    [
      'terminal presenter',
      'terminal_presenter',
      'terminal_presenter_unsupported',
    ],
  ] as const)(
    'acknowledges a root delivery suppressed by a %s result',
    async (_description, outcome, reason) => {
      const scope = await makeScope();
      const child = record('root-child');
      mockDeliverGeneratedWatcherMessageToChat.mockResolvedValue(outcome);
      const service = delivery(scope, [child], new Map());

      await service.start();
      await service.settled(
        parentContext(child),
        'root-child',
        output('root-child'),
      );
      await waitForAck(scope, 'root-child', reason);
      await service.close();

      expect(scope.store.ack('root-child')).toEqual({
        resultIndex: 1,
        suppressedReason: reason,
      });
    },
  );

  it('uses the stored immediate delegate parent and suppresses permanent child refusal as parent_gone', async () => {
    const scope = await makeScope();
    const nested = record('nested', {
      parentDelegationId: 'immediate-parent',
      callerParentDelegationId: 'continuation-caller',
    });
    const childMessages = childMessageInboxMock(
      (): ReturnType<ChildMessageDelivery> =>
        Promise.resolve({
          ok: false as const,
          error: {
            code: 'parent_unavailable' as const,
            message: 'The parent cannot resume.',
            retryable: false,
          },
        }),
    );
    const service = delivery(scope, [nested], new Map(), childMessages);

    await service.start();
    await service.settled(parentContext(nested), 'nested', output('nested'));
    await waitForAck(scope, 'nested', 'parent_gone');
    await service.close();

    expect(childMessages.deliver).toHaveBeenCalledTimes(1);
    expect(childMessages.deliver.mock.calls[0]?.[0]).toBe('immediate-parent');
    const deliveryId = childMessages.deliver.mock.calls[0]?.[2];
    // The broker stores the delivery as a control whose operationId is a UUID.
    expect(
      delegationControlSchema.shape.operationId.safeParse(deliveryId).success,
    ).toBe(true);
    expect(deliveryId).not.toBe(noticeBatchId([noticeId('nested', 1, 1)]));
    expect(mockDeliverGeneratedWatcherMessageToChat).not.toHaveBeenCalled();
    expect(scope.store.ack('nested')).toEqual({
      resultIndex: 1,
      suppressedReason: 'parent_gone',
    });
  });

  it('reconstructs an unready nested batch from the live outcome and retries on root attach even when retryable is false', async () => {
    const scope = await makeScope();
    let currentRecords: readonly StoredDelegation[] = [];
    const nested = record('new-nested', {
      parentDelegationId: 'restored-parent',
    });
    const childMessages = childMessageInboxMock();
    childMessages.deliver
      .mockResolvedValueOnce({
        ok: false as const,
        error: {
          code: 'parent_unavailable' as const,
          message: 'The owning parent session is not ready.',
          retryable: false,
        },
      })
      .mockResolvedValueOnce({ ok: true as const, value: undefined });
    const service = new DelegationNoticeDelivery({
      store: scope.store,
      records: (): Promise<readonly StoredDelegation[]> =>
        Promise.resolve(currentRecords),
      results: (): Promise<readonly StoredDelegateOutput[]> =>
        Promise.resolve([]),
      childMessages,
      onError: jest.fn(),
    });

    await service.start();
    currentRecords = [nested];
    await service.settled(
      parentContext(nested),
      'new-nested',
      output('new-nested'),
    );
    await waitFor(
      () => scope.store.pending().length === 1,
      'pending nested notice after parent-not-ready refusal',
    );
    await service.replayForChat({
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
    });

    expect(childMessages.deliver).toHaveBeenCalledTimes(2);
    // The retry reuses the delivery ID, so the broker deduplicates it.
    const [firstId, retryId] = childMessages.deliver.mock.calls.map(
      (call) => call[2],
    );
    expect(retryId).toBe(firstId);
    expect(
      delegationControlSchema.shape.operationId.safeParse(firstId).success,
    ).toBe(true);
    expect(scope.store.ack('new-nested')).toEqual({ resultIndex: 1 });
    await service.close();
  });

  it('retries a failed nested hand-off at once under a new operation ID', async () => {
    const scope = await makeScope();
    const nested = record('failed-control', {
      parentDelegationId: 'failed-control-parent',
    });
    const childMessages = childMessageInboxMock();
    // The broker recorded the first attempt's control as failed, so the same
    // operation ID would only replay that failure.
    childMessages.deliver
      .mockRejectedValueOnce(new Error('The host message did not complete.'))
      .mockResolvedValue({ ok: true as const, value: undefined });
    const service = delivery(scope, [nested], new Map(), childMessages);

    await service.start();
    await service.settled(
      parentContext(nested),
      'failed-control',
      output('failed-control'),
    );
    await waitFor(
      () => scope.store.ack('failed-control') !== undefined,
      'nested notice delivered on its immediate retry',
    );

    const [firstId, retryId] = childMessages.deliver.mock.calls.map(
      (call) => call[2],
    );
    expect(childMessages.deliver).toHaveBeenCalledTimes(2);
    expect(firstId).toBe(
      noticeDeliveryOperationId(
        noticeBatchId([noticeId('failed-control', 1, 1)]),
      ),
    );
    expect(retryId).not.toBe(firstId);
    expect(
      delegationControlSchema.shape.operationId.safeParse(retryId).success,
    ).toBe(true);
    await service.close();
  });

  it('retries a nested batch whose hand-off failed when that parent settles its own run', async () => {
    const scope = await makeScope();
    const parent = record('settling-parent');
    const child = record('settling-child', {
      parentDelegationId: 'settling-parent',
    });
    const childMessages = childMessageInboxMock();
    childMessages.deliver
      .mockRejectedValueOnce(new Error('The host message did not complete.'))
      .mockRejectedValueOnce(new Error('The host message did not complete.'))
      .mockResolvedValue({ ok: true as const, value: undefined });
    const onError = jest.fn();
    const service = new DelegationNoticeDelivery({
      store: scope.store,
      records: (): Promise<readonly StoredDelegation[]> =>
        Promise.resolve([parent, child]),
      results: (): Promise<readonly StoredDelegateOutput[]> =>
        Promise.resolve([]),
      childMessages,
      onError,
    });

    await service.start();
    await service.settled(
      parentContext(child),
      'settling-child',
      output('settling-child'),
    );
    await waitFor(
      () => onError.mock.calls.length === 2,
      'failed hand-off and its immediate retry',
    );
    // No other child notice arrives; the parent's own run ending retries it.
    await service.settled(
      parentContext(parent),
      'settling-parent',
      output('settling-parent'),
    );
    await waitFor(
      () => scope.store.ack('settling-child') !== undefined,
      'nested notice retried when its parent settled',
    );

    expect(childMessages.deliver).toHaveBeenCalledTimes(3);
    expect(scope.store.ack('settling-child')).toEqual({ resultIndex: 1 });
    await service.close();
  });

  it('retries a nested batch whose hand-off threw when its parent gets another notice', async () => {
    const scope = await makeScope();
    const first = record('threw-first', { parentDelegationId: 'busy-parent' });
    const second = record('threw-second', {
      parentDelegationId: 'busy-parent',
    });
    const childMessages = childMessageInboxMock();
    childMessages.deliver
      .mockRejectedValueOnce(new Error('control write failed'))
      .mockResolvedValue({ ok: true as const, value: undefined });
    const onError = jest.fn();
    const service = new DelegationNoticeDelivery({
      store: scope.store,
      records: (): Promise<readonly StoredDelegation[]> =>
        Promise.resolve([first, second]),
      results: (): Promise<readonly StoredDelegateOutput[]> =>
        Promise.resolve([]),
      childMessages,
      onError,
    });

    await service.start();
    await service.settled(
      parentContext(first),
      'threw-first',
      output('threw-first'),
    );
    await waitFor(() => onError.mock.calls.length === 1, 'thrown hand-off');
    await service.settled(
      parentContext(second),
      'threw-second',
      output('threw-second'),
    );
    await waitFor(
      () =>
        scope.store.ack('threw-first') !== undefined &&
        scope.store.ack('threw-second') !== undefined,
      'both nested notices delivered without a root attach',
    );

    expect(scope.store.ack('threw-first')).toEqual({ resultIndex: 1 });
    expect(scope.store.ack('threw-second')).toEqual({ resultIndex: 1 });
    expect(scope.store.pending()).toEqual([]);
    await service.close();
  });

  it('joins concurrent attach replay to the startup hand-off and never replays the root batch', async () => {
    const scope = await makeScope();
    const rootChild = record('attach-root-pending');
    const nestedChild = record('attach-nested-pending', {
      parentDelegationId: 'attach-parent',
    });
    const rootBatchId = noticeBatchId([noticeId('attach-root-pending', 1, 1)]);
    const nestedBatchId = noticeBatchId([
      noticeId('attach-nested-pending', 1, 1),
    ]);
    await scope.store.recordPending({
      batchId: rootBatchId,
      parentKey: delegationNoticeRootParentKey('project', 'worktree', 'chat'),
      noticeIds: [noticeId('attach-root-pending', 1, 1)],
    });
    await scope.store.recordPending({
      batchId: nestedBatchId,
      parentKey: 'delegate:attach-parent',
      noticeIds: [noticeId('attach-nested-pending', 1, 1)],
    });
    let resolveChildDelivery: (() => void) | undefined;
    const childMessages = childMessageInboxMock(
      (): ReturnType<ChildMessageDelivery> =>
        new Promise((resolve) => {
          resolveChildDelivery = (): void =>
            resolve({ ok: true, value: undefined });
        }),
    );
    const service = delivery(
      scope,
      [rootChild, nestedChild],
      new Map([
        ['attach-root-pending', [output('attach-root-pending')]],
        ['attach-nested-pending', [output('attach-nested-pending')]],
      ]),
      childMessages,
    );

    await service.start();
    await waitFor(
      () => childMessages.deliver.mock.calls.length === 1,
      'startup child notice hand-off',
    );
    const target = {
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
    };
    const firstReplay = service.replayForChat(target);
    const secondReplay = service.replayForChat(target);
    resolveChildDelivery?.();
    await Promise.all([firstReplay, secondReplay]);

    expect(childMessages.deliver).toHaveBeenCalledTimes(1);
    expect(childMessages.deliver.mock.calls[0]?.[2]).toBe(
      noticeDeliveryOperationId(nestedBatchId),
    );
    expect(mockDeliverGeneratedWatcherMessageToChat).toHaveBeenCalledTimes(1);
    expect(
      mockDeliverGeneratedWatcherMessageToChat.mock.calls[0]?.[0].userMessageId,
    ).toBe(rootBatchId);
    expect(scope.store.pending()).toEqual([]);
    await service.close();
  });

  it('leaves actor-not-ready child delivery pending and replays only that child batch when its root attaches', async () => {
    const scope = await makeScope();
    const rootChild = record('root-pending');
    const nestedChild = record('nested-pending', {
      parentDelegationId: 'parent-delegate',
    });
    const rootOutput = output('root-pending');
    const nestedOutput = output('nested-pending');
    const resultMap = new Map<string, readonly StoredDelegateOutput[]>([
      ['root-pending', [rootOutput]],
      ['nested-pending', [nestedOutput]],
    ]);
    const rootBatchId = noticeBatchId([noticeId('root-pending', 1, 1)]);
    const nestedBatchId = noticeBatchId([noticeId('nested-pending', 1, 1)]);
    await scope.store.recordPending({
      batchId: rootBatchId,
      parentKey: delegationNoticeRootParentKey('project', 'worktree', 'chat'),
      noticeIds: [noticeId('root-pending', 1, 1)],
    });
    await scope.store.recordPending({
      batchId: nestedBatchId,
      parentKey: 'delegate:parent-delegate',
      noticeIds: [noticeId('nested-pending', 1, 1)],
    });

    const childMessages = childMessageInboxMock();
    childMessages.deliver
      .mockResolvedValueOnce({
        ok: false as const,
        error: {
          code: 'parent_unavailable' as const,
          message: 'The owning parent session is not ready.',
          retryable: true,
        },
      })
      .mockResolvedValueOnce({ ok: true as const, value: undefined });
    mockDeliverGeneratedWatcherMessageToChat.mockRejectedValueOnce(
      new Error('root hand-off has not been accepted'),
    );
    const service = delivery(
      scope,
      [rootChild, nestedChild],
      resultMap,
      childMessages,
    );

    await service.start();
    expect(scope.store.pending().map(({ batchId }) => batchId)).toEqual([
      rootBatchId,
      nestedBatchId,
    ]);
    await service.replayForChat({
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
    });

    expect(childMessages.deliver).toHaveBeenCalledTimes(2);
    expect(childMessages.deliver.mock.calls.map((call) => call[2])).toEqual([
      noticeDeliveryOperationId(nestedBatchId),
      noticeDeliveryOperationId(nestedBatchId),
    ]);
    expect(mockDeliverGeneratedWatcherMessageToChat).toHaveBeenCalledTimes(1);
    expect(scope.store.pending().map(({ batchId }) => batchId)).toEqual([
      rootBatchId,
    ]);
    expect(scope.store.ack('nested-pending')).toEqual({ resultIndex: 1 });
    await service.close();
  });

  it('replays a pending batch with fixed membership before a live settlement arriving during replay', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    const scope = await makeScope();
    const first = record('first');
    const later = record('later');
    const firstNoticeId = noticeId('first', 1, 1);
    const firstBatchId = noticeBatchId([firstNoticeId]);
    await scope.store.recordPending({
      batchId: firstBatchId,
      parentKey: delegationNoticeRootParentKey('project', 'worktree', 'chat'),
      noticeIds: [firstNoticeId],
    });
    let acceptReplay: ((outcome: 'already_delivered') => void) | undefined;
    mockDeliverGeneratedWatcherMessageToChat.mockReturnValueOnce(
      new Promise((resolve) => {
        acceptReplay = resolve;
      }),
    );
    const service = delivery(
      scope,
      [first, later],
      new Map([['first', [output('first')]]]),
    );

    const starting = service.start();
    await waitFor(
      () => mockDeliverGeneratedWatcherMessageToChat.mock.calls.length === 1,
      'startup pending notice hand-off',
    );
    const pendingRequest =
      mockDeliverGeneratedWatcherMessageToChat.mock.calls[0]?.[0];
    const liveSettlement = service.settled(
      parentContext(later),
      'later',
      output('later'),
    );
    await liveSettlement;
    acceptReplay?.('already_delivered');
    await starting;
    await jest.advanceTimersByTimeAsync(750);
    await waitFor(
      () => mockDeliverGeneratedWatcherMessageToChat.mock.calls.length === 2,
      'live notice after replay',
    );

    expect(pendingRequest.delegationNoticeBatchId).toBe(firstBatchId);
    expect(pendingRequest.userMessageId).toBe(firstBatchId);
    expect(mockDeliverGeneratedWatcherMessageToChat).toHaveBeenCalledTimes(2);
    const liveRequest =
      mockDeliverGeneratedWatcherMessageToChat.mock.calls[1]?.[0];
    expect(liveRequest.delegationNoticeBatchId).not.toBe(firstBatchId);
    expect(liveRequest.text).toContain('name-later: completed');
    expect(liveRequest.text).not.toContain('name-first: completed');
    await service.close();
  });

  it('retries the same pending membership after a crash before root acceptance', async () => {
    const scope = await makeScope();
    const child = record('crash-before-acceptance');
    const childOutput = output('crash-before-acceptance');
    const member = noticeId(child.state.delegationId, 1, 1);
    const batchId = noticeBatchId([member]);
    await scope.store.recordPending({
      batchId,
      parentKey: delegationNoticeRootParentKey('project', 'worktree', 'chat'),
      noticeIds: [member],
    });
    mockDeliverGeneratedWatcherMessageToChat.mockRejectedValueOnce(
      new Error('dispatch never accepted'),
    );
    const firstService = delivery(
      scope,
      [child],
      new Map([[child.state.delegationId, [childOutput]]]),
    );

    await firstService.start();
    await waitFor(
      () => mockDeliverGeneratedWatcherMessageToChat.mock.calls.length === 1,
      'root delivery attempt before acceptance',
    );
    const firstRequest =
      mockDeliverGeneratedWatcherMessageToChat.mock.calls[0]?.[0];
    expect(
      scope.store.pending().map(({ batchId: pendingId }) => pendingId),
    ).toEqual([batchId]);
    expect(scope.store.pending()[0]?.message).toEqual({
      text: firstRequest.text,
      hiddenContextText: firstRequest.hiddenContextText,
      watcherFired: firstRequest.watcherFired,
    });
    expect(scope.store.ack(child.state.delegationId)).toBeUndefined();

    const restoredStore = new DelegationNoticeAckStore(scope.directory);
    await expect(restoredStore.load()).resolves.toEqual({ baselined: true });
    const retryService = new DelegationNoticeDelivery({
      store: restoredStore,
      records: (): Promise<readonly StoredDelegation[]> =>
        Promise.resolve([
          record(child.state.delegationId, { name: 'renamed-after-restart' }),
        ]),
      results: (): Promise<readonly StoredDelegateOutput[]> =>
        Promise.resolve([childOutput]),
      childMessages: childMessageInboxMock(),
      onError: jest.fn(),
    });
    mockDeliverGeneratedWatcherMessageToChat.mockResolvedValueOnce('submitted');

    await retryService.start();

    expect(mockDeliverGeneratedWatcherMessageToChat).toHaveBeenCalledTimes(2);
    expect(
      mockDeliverGeneratedWatcherMessageToChat.mock.calls.map(
        ([request]) => request.userMessageId,
      ),
    ).toEqual([batchId, batchId]);
    expect(
      mockDeliverGeneratedWatcherMessageToChat.mock.calls[1]?.[0].text,
    ).toBe(firstRequest.text);
    expect(
      mockDeliverGeneratedWatcherMessageToChat.mock.calls[1]?.[0]
        .hiddenContextText,
    ).toBe(firstRequest.hiddenContextText);
    expect(restoredStore.pending()).toEqual([]);
    expect(restoredStore.ack(child.state.delegationId)).toEqual({
      resultIndex: 1,
    });
    await retryService.close();
  });

  it('replays after root acceptance but before the acknowledgement write without duplicating the row', async () => {
    const scope = await makeScope();
    const child = record('crash-after-acceptance');
    const childOutput = output('crash-after-acceptance');
    const member = noticeId(child.state.delegationId, 1, 1);
    const batchId = noticeBatchId([member]);
    const replayMessage = {
      text: 'original task label: completed',
      hiddenContextText:
        '<system_instruction>original payload bytes</system_instruction>',
      watcherFired: { kind: 'Delegate finished' },
    };
    await scope.store.recordPending({
      batchId,
      parentKey: delegationNoticeRootParentKey('project', 'worktree', 'chat'),
      noticeIds: [member],
      message: replayMessage,
    });
    let failAckWrite = true;
    const failingStore = new DelegationNoticeAckStore(scope.directory, {
      writeFile: async (filePath: string, data: string): Promise<void> => {
        const state: unknown = JSON.parse(data);
        const hasAcknowledgement =
          typeof state === 'object' &&
          state !== null &&
          'acks' in state &&
          typeof state.acks === 'object' &&
          state.acks !== null &&
          Object.keys(state.acks).length > 0;
        if (failAckWrite && hasAcknowledgement) {
          failAckWrite = false;
          throw new Error('crash after accepted row, before ack persistence');
        }
        await writeFile(filePath, data, 'utf8');
      },
    });
    await failingStore.load();
    const reportedErrors: unknown[] = [];
    const firstService = new DelegationNoticeDelivery({
      store: failingStore,
      records: (): Promise<readonly StoredDelegation[]> =>
        Promise.resolve([child]),
      results: (): Promise<readonly StoredDelegateOutput[]> =>
        Promise.resolve([childOutput]),
      childMessages: childMessageInboxMock(),
      onError: (error: unknown): void => {
        reportedErrors.push(error);
      },
    });
    mockDeliverGeneratedWatcherMessageToChat.mockResolvedValueOnce('submitted');

    await firstService.start();
    await waitFor(
      () => reportedErrors.length === 1,
      'acknowledgement persistence failure',
    );

    expect(mockDeliverGeneratedWatcherMessageToChat).toHaveBeenCalledTimes(1);
    expect(mockDeliverGeneratedWatcherMessageToChat.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining(replayMessage),
    );
    expect(reportedErrors).toEqual([
      expect.objectContaining({
        message: 'crash after accepted row, before ack persistence',
      }),
    ]);
    const restoredStore = new DelegationNoticeAckStore(scope.directory);
    await expect(restoredStore.load()).resolves.toEqual({ baselined: true });
    expect(
      restoredStore.pending().map(({ batchId: pendingId }) => pendingId),
    ).toEqual([batchId]);
    expect(restoredStore.ack(child.state.delegationId)).toBeUndefined();

    const retryService = new DelegationNoticeDelivery({
      store: restoredStore,
      records: (): Promise<readonly StoredDelegation[]> =>
        Promise.resolve([
          record(child.state.delegationId, { name: 'renamed-task' }),
          record('new-still-running-sibling'),
        ]),
      results: (
        candidate: StoredDelegation,
      ): Promise<readonly StoredDelegateOutput[]> =>
        Promise.resolve(
          candidate.state.delegationId === child.state.delegationId
            ? [childOutput]
            : [],
        ),
      childMessages: childMessageInboxMock(),
      onError: jest.fn(),
    });
    mockDeliverGeneratedWatcherMessageToChat.mockResolvedValueOnce(
      'already_delivered',
    );
    await retryService.start();

    expect(mockDeliverGeneratedWatcherMessageToChat).toHaveBeenCalledTimes(2);
    expect(
      mockDeliverGeneratedWatcherMessageToChat.mock.calls.map(
        ([request]) => request.userMessageId,
      ),
    ).toEqual([batchId, batchId]);
    expect(mockDeliverGeneratedWatcherMessageToChat.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining(replayMessage),
    );
    expect(restoredStore.pending()).toEqual([]);
    expect(restoredStore.ack(child.state.delegationId)).toEqual({
      resultIndex: 1,
    });
    await retryService.close();
  });

  it('replays the exact nested hidden payload after acceptance and an acknowledgement-write crash', async () => {
    const scope = await makeScope();
    const child = record('crash-after-child-acceptance', {
      parentDelegationId: 'immediate-parent',
    });
    const childOutput = output('crash-after-child-acceptance');
    const member = noticeId(child.state.delegationId, 1, 1);
    const batchId = noticeBatchId([member]);
    const replayMessage = {
      text: 'original nested task label: completed',
      hiddenContextText:
        '<system_instruction>original nested payload bytes</system_instruction>',
      watcherFired: { kind: 'Delegate finished' },
    };
    await scope.store.recordPending({
      batchId,
      parentKey: 'delegate:immediate-parent',
      noticeIds: [member],
      message: replayMessage,
    });
    let failAckWrite = true;
    const failingStore = new DelegationNoticeAckStore(scope.directory, {
      writeFile: async (filePath: string, data: string): Promise<void> => {
        const state: unknown = JSON.parse(data);
        const hasAcknowledgement =
          typeof state === 'object' &&
          state !== null &&
          'acks' in state &&
          typeof state.acks === 'object' &&
          state.acks !== null &&
          Object.keys(state.acks).length > 0;
        if (failAckWrite && hasAcknowledgement) {
          failAckWrite = false;
          throw new Error('nested acceptance preceded ack persistence');
        }
        await writeFile(filePath, data, 'utf8');
      },
    });
    await failingStore.load();
    const errors: unknown[] = [];
    const firstChildMessages = childMessageInboxMock();
    const firstService = new DelegationNoticeDelivery({
      store: failingStore,
      records: (): Promise<readonly StoredDelegation[]> =>
        Promise.resolve([child]),
      results: (): Promise<readonly StoredDelegateOutput[]> =>
        Promise.resolve([childOutput]),
      childMessages: firstChildMessages,
      onError: (error: unknown): void => {
        errors.push(error);
      },
    });

    await firstService.start();
    await waitFor(
      () => errors.length === 1,
      'nested acknowledgement persistence failure',
    );
    const firstCall = firstChildMessages.deliver.mock.calls[0];
    expect(firstCall?.[1]).toBe(replayMessage.hiddenContextText);
    expect(firstCall?.[2]).toBe(noticeDeliveryOperationId(batchId));

    const restoredStore = new DelegationNoticeAckStore(scope.directory);
    await expect(restoredStore.load()).resolves.toEqual({ baselined: true });
    const changedChild = record(child.state.delegationId, {
      parentDelegationId: 'immediate-parent',
      name: 'renamed nested task',
    });
    const retryChildMessages = childMessageInboxMock();
    const retryService = new DelegationNoticeDelivery({
      store: restoredStore,
      records: (): Promise<readonly StoredDelegation[]> =>
        Promise.resolve([changedChild]),
      results: (): Promise<readonly StoredDelegateOutput[]> =>
        Promise.resolve([childOutput]),
      childMessages: retryChildMessages,
      onError: jest.fn(),
    });

    await retryService.start();

    expect(retryChildMessages.deliver).toHaveBeenCalledTimes(1);
    expect(retryChildMessages.deliver.mock.calls[0]?.[1]).toBe(
      replayMessage.hiddenContextText,
    );
    expect(retryChildMessages.deliver.mock.calls[0]?.[2]).toBe(
      noticeDeliveryOperationId(batchId),
    );
    expect(restoredStore.pending()).toEqual([]);
    expect(restoredStore.ack(child.state.delegationId)).toEqual({
      resultIndex: 1,
    });
    await retryService.close();
  });

  it('suppresses a parent-close batch window and records the teardown reason before flushing the store', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    const scope = await makeScope();
    const first = record('close-first');
    const second = record('close-second');
    const service = delivery(scope, [first, second], new Map());

    await service.start();
    await service.settled(
      parentContext(first),
      'close-first',
      output('close-first'),
    );
    await service.closeParent(
      delegationNoticeRootParentKey('project', 'worktree', 'chat'),
      'parent_cancelled',
    );

    expect(mockDeliverGeneratedWatcherMessageToChat).not.toHaveBeenCalled();
    expect(scope.store.ack('close-first')).toEqual({
      resultIndex: 1,
      suppressedReason: 'parent_cancelled',
    });
    await service.close();
  });

  it('records root closure before startup replay can enqueue a settled result', async () => {
    const scope = await makeScope();
    const child = record('close-during-start');
    let releaseRecords:
      | ((records: readonly StoredDelegation[]) => void)
      | undefined;
    let signalRecordsRequested: (() => void) | undefined;
    const recordsRequested = new Promise<void>((resolve) => {
      signalRecordsRequested = resolve;
    });
    const service = new DelegationNoticeDelivery({
      store: scope.store,
      records: (): Promise<readonly StoredDelegation[]> => {
        signalRecordsRequested?.();
        return new Promise<readonly StoredDelegation[]>((resolve) => {
          releaseRecords = resolve;
        });
      },
      results: (): Promise<readonly StoredDelegateOutput[]> =>
        Promise.resolve([output('close-during-start')]),
      childMessages: childMessageInboxMock(),
      onError: jest.fn(),
    });

    const starting = service.start();
    await recordsRequested;
    const closing = service.closeParent(
      delegationNoticeRootParentKey('project', 'worktree', 'chat'),
      'parent_cancelled',
    );
    releaseRecords?.([child]);
    await Promise.all([starting, closing]);

    expect(mockDeliverGeneratedWatcherMessageToChat).not.toHaveBeenCalled();
    expect(scope.store.ack('close-during-start')).toEqual({
      resultIndex: 1,
      suppressedReason: 'parent_cancelled',
    });
    await service.close();
  });

  it('clears the old root-tree close reason when the same chat attaches again', async () => {
    const scope = await makeScope();
    let currentRecords: readonly StoredDelegation[] = [];
    const service = new DelegationNoticeDelivery({
      store: scope.store,
      records: (): Promise<readonly StoredDelegation[]> =>
        Promise.resolve(currentRecords),
      results: (): Promise<readonly StoredDelegateOutput[]> =>
        Promise.resolve([]),
      childMessages: childMessageInboxMock(),
      onError: jest.fn(),
    });
    const target = {
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
    };
    const rootKey = delegationNoticeRootParentKey(
      target.projectId,
      target.worktreeId,
      target.chatId,
    );

    await service.closeParent(rootKey, 'parent_gone');
    await service.replayForChat(target);
    const nextDelegate = record('delegate-after-reattach');
    currentRecords = [nextDelegate];
    await service.settled(
      parentContext(nextDelegate),
      'delegate-after-reattach',
      output('delegate-after-reattach'),
    );
    await waitForAck(scope, 'delegate-after-reattach');

    expect(mockDeliverGeneratedWatcherMessageToChat).toHaveBeenCalledTimes(1);
    expect(scope.store.ack('delegate-after-reattach')).toEqual({
      resultIndex: 1,
    });
    await service.close();
  });

  it('does not wait for an active nested hand-off while closing its root tree', async () => {
    const scope = await makeScope();
    const nested = record('close-active-child', {
      parentDelegationId: 'active-parent',
    });
    let resolveChildDelivery: (() => void) | undefined;
    const childMessages = childMessageInboxMock(
      (): ReturnType<ChildMessageDelivery> =>
        new Promise((resolve) => {
          resolveChildDelivery = (): void =>
            resolve({ ok: true, value: undefined });
        }),
    );
    const service = delivery(scope, [nested], new Map(), childMessages);

    await service.start();
    await service.settled(
      parentContext(nested),
      'close-active-child',
      output('close-active-child'),
    );
    await waitFor(
      () => childMessages.deliver.mock.calls.length === 1,
      'nested notice hand-off before root close',
    );
    await service.closeParent(
      delegationNoticeRootParentKey('project', 'worktree', 'chat'),
      'ancestor_stopped',
    );

    resolveChildDelivery?.();
    await service.close();
    expect(scope.store.ack('close-active-child')).toEqual({ resultIndex: 1 });
  });
});
