import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { C12Backing } from './helpers/delegation-c12-harness';
import type { DelegationTranscriptResultEntry } from '@canopy/desktop-shared/node/delegation/transcript-port';
import type { DeltaJournalBoundary } from '../lib/chat-delta-journal/writer';

jest.mock('../services/background-execution-context', () => ({
  ...jest.requireActual<object>('../services/background-execution-context'),
  backgroundExecutionContextEnabled: (): boolean => false,
}));
// Cold imports of the real repository, broker and host exceed 5 s under CI load.
jest.setTimeout(60_000);

let mockRoot = '';
jest.mock('../lib/paths', () => ({
  ...jest.requireActual<object>('../lib/paths'),
  getWorktreeDataDir: (projectId: string, worktreeId: string): string =>
    join(mockRoot, projectId, worktreeId),
}));
jest.mock('../lib/canopy-cloud-account-store', () => ({
  loadCanopyCloudAccount: (): Promise<null> => Promise.resolve(null),
  subscribeCanopyCloudAccountChanges: (): (() => void) => () => undefined,
}));
jest.mock('../agents/delegation/route-runtime', () => ({
  DelegationRouteRuntime: jest.fn(() => ({ dispose: (): void => undefined })),
}));
jest.mock('../power/wake-lock-service', () => ({
  getWakeLockService: (): { acquire(): void; release(): void } => ({
    acquire: (): void => undefined,
    release: (): void => undefined,
  }),
}));

let backing: C12Backing | undefined;
let previousDataDir: string | undefined;
beforeEach(async () => {
  mockRoot = await mkdtemp(join(tmpdir(), 'c12-matrix-'));
  previousDataDir = process.env.CANOPY_DATA_DIR;
  process.env.CANOPY_DATA_DIR = join(mockRoot, 'data');
  const paths = await import('@canopy/desktop-shared/canopy-paths');
  paths.resetResolvedCanopyDataDirForTests();
});
afterEach(async () => {
  try {
    await backing?.dispose();
    backing = undefined;
    const singleton = await import('../services/chat-state-service');
    await singleton.getChatStateService().drain();
    singleton.resetChatStateServiceForTests();
    const { getAppAdvisorWatcherService } =
      await import('../app-advisor/watchers');
    getAppAdvisorWatcherService().shutdown();
    await getAppAdvisorWatcherService().drain();
  } finally {
    // Core-module spies (fs) outlive this file's registry: always restore them.
    backing = undefined;
    jest.restoreAllMocks();
    if (previousDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
    else process.env.CANOPY_DATA_DIR = previousDataDir;
    await rm(mockRoot, { recursive: true, force: true });
  }
});

it('a dropped durable card event converges on revision-gap reload; equal replay emits nothing', async () => {
  const { c12Backing, value, target } =
    await import('./helpers/delegation-c12-harness');
  backing = await c12Backing(mockRoot);
  const f = backing;
  await f.start();
  const before = value(await f.port.open({ target: target(1) }));
  const pair = (await f.record()).cardPublication;
  if (!pair) throw new Error('Missing running draft');
  const seen: number[] = [];
  let droppedRevision: number | undefined;
  f.repository.setCommitListener((commit) => {
    if (commit.cardChanges?.length && droppedRevision === undefined) {
      droppedRevision = commit.revision;
      throw new Error('observer delivery lost after durability');
    }
    seen.push(commit.revision);
  });
  const { materializeCardDraft } =
    await import('@canopy/desktop-shared/node/delegation/card-publication');
  const draft = materializeCardDraft(await f.record());
  if (!draft) throw new Error('Missing materialized draft');
  const request = {
    target: target(1),
    cardRevision: pair.cardRevision + 1,
    cardDraft: { ...draft, workspaceDiscarded: true },
  };
  value(await f.port.updateCardState(request));
  expect(droppedRevision).toBeDefined();
  expect(seen).not.toContain(droppedRevision);
  const admitted = value(await f.port.open({ target: target(1) }));
  expect(admitted.cardState).toMatchObject({
    cardRevision: pair.cardRevision + 1,
    workspaceDiscarded: true,
  });
  const revision = await f.repository.getRevision(f.scope);
  value(await f.port.updateCardState(request));
  expect(await f.repository.getRevision(f.scope)).toBe(revision);
  expect(value(await f.port.open({ target: target(1) }))).toEqual(admitted);
  // A later visible commit reveals the missed revision to a connected client.
  value(
    await f.port.updateCardState({
      ...request,
      cardRevision: pair.cardRevision + 2,
      cardDraft: {
        ...request.cardDraft,
        control: {
          operationId: 'discard',
          operation: 'discard',
          status: 'completed',
        },
      },
    }),
  );
  expect(
    seen.some((entry) => entry > (droppedRevision ?? Number.MAX_SAFE_INTEGER)),
  ).toBe(true);
  expect(admitted.streamRevision).toBeGreaterThan(before.streamRevision);
  await f.reopenRepository();
  expect(
    value(await f.port.open({ target: target(1) })).cardState,
  ).toMatchObject({
    cardRevision: pair.cardRevision + 2,
    workspaceDiscarded: true,
    control: { operation: 'discard', status: 'completed' },
  });
});

it('actorless readers preserve stored running state and do not repair or invent interruption', async () => {
  const { c12Backing, value, target, chatId, delegationId } =
    await import('./helpers/delegation-c12-harness');
  backing = await c12Backing(mockRoot);
  const f = backing;
  await f.start();
  const image = await f.record();
  await f.simulateExit();
  const singleton = await import('../services/chat-state-service');
  singleton.resetChatStateServiceForTests(f.service);
  const { AgentDelegationBroker } =
    await import('@canopy/desktop-shared/node/delegation/broker');
  const initialize = jest
    .spyOn(AgentDelegationBroker.prototype, 'initialize')
    .mockImplementation(() => {
      throw new Error('Actorless read initialized broker');
    });
  const sessions = await import('../agents/session-manager');
  const actor = jest
    .spyOn(sessions, 'getOrCreateSession')
    .mockImplementation(() => {
      throw new Error('Actorless read created session');
    });
  const managed = await import('../agents/delegation/service');
  const advisor = await import('../app-advisor/delegation-read-actions');
  const before = JSON.stringify(await f.record());
  const descriptor = value(await f.port.open({ target: target(1) }));
  const roots = await managed.readManagedDelegationRootsForUser(f.scope);
  expect(roots).toMatchObject([{ chatId, total: 1, live: 0 }]);
  expect(
    await managed.readManagedDelegationTreeForUser({ ...f.scope, chatId }),
  ).toMatchObject([
    { snapshot: { status: 'running', nativeSessionId: 'c12-native' } },
  ]);
  expect(
    await managed.readManagedDelegationTranscriptForUser({
      ...f.scope,
      chatId,
      delegationId,
      runGeneration: 1,
      limit: 10,
    }),
  ).toMatchObject({ ok: true, snapshot: { status: 'running' } });
  expect(
    await advisor.dispatchDelegationReadAction({
      type: 'delegation.tree',
      ...f.scope,
      chatId,
    }),
  ).toMatchObject({ ok: true, result: [{ snapshot: { status: 'running' } }] });
  expect(
    await advisor.dispatchDelegationReadAction({
      type: 'delegation.transcript',
      ...f.scope,
      chatId,
      delegationId,
      runGeneration: 1,
      limit: 10,
    }),
  ).toMatchObject({ ok: true, result: { snapshot: { status: 'running' } } });
  const tabs = await f.service.getCompatibilityTabs(f.scope, {
    chatIds: [chatId],
  });
  const card = tabs.tabs
    .find((tab) => tab.id === chatId)
    ?.messages?.flatMap((message) => message.blocks ?? [])
    .find((block) => block.type === 'delegated_agent_call');
  expect(card).toMatchObject({
    status: 'running',
    nativeSessionId: 'c12-native',
  });
  const { createDelegationRecordReader } =
    await import('../agents/delegation/record-reader');
  const reader = createDelegationRecordReader({
    scope: f.scope,
    port: f.service,
  });
  expect(
    await reader.resolveGenerationOutcome(
      { record: image, readMetadata: image.readMetadata },
      1,
    ),
  ).toEqual({ kind: 'unsettled' });
  expect(JSON.stringify(await f.record())).toBe(before);
  expect(value(await f.port.open({ target: target(1) }))).toEqual(descriptor);
  expect(initialize).not.toHaveBeenCalled();
  expect(actor).not.toHaveBeenCalled();
});

it('a cached real host scope actor initializes its broker only once', async () => {
  const { c12Backing, delegationId, value, chatId, target, eventually } =
    await import('./helpers/delegation-c12-harness');
  backing = await c12Backing(mockRoot);
  const f = backing;
  const singleton = await import('../services/chat-state-service');
  singleton.resetChatStateServiceForTests(f.service);
  const brokerModule =
    await import('@canopy/desktop-shared/node/delegation/broker');
  const { AgentDelegationBroker } = brokerModule;
  const initialize = jest.spyOn(AgentDelegationBroker.prototype, 'initialize');
  const { AgentRunnerRegistry } =
    await import('@canopy/desktop-shared/node/delegation/runner-registry');
  const { FakeRunner, routeFixture } =
    await import('@canopy/desktop-shared/node/delegation/__tests__/fixtures');
  const { baseTask } =
    await import('../../../../../packages/desktop-shared/src/node/delegation/__tests__/broker-harness');
  const { parent } = await import('./helpers/delegation-two-scope-backing');
  const runner = new FakeRunner('local-sdk');
  const registry = new AgentRunnerRegistry();
  registry.register({
    apiVersion: 1,
    registrationId: 'third-local',
    adapter: runner,
  });
  const constructed: InstanceType<typeof AgentDelegationBroker>[] = [];
  const ports: NonNullable<
    ConstructorParameters<typeof AgentDelegationBroker>[0]['transcriptPort']
  >[] = [];
  // Only execution dependencies and the dormant gate are replaced. The actual
  // host constructs its own storage, transcript port, callbacks and scope actor.
  jest
    .spyOn(brokerModule, 'AgentDelegationBroker')
    .mockImplementation((input) => {
      if (!input.transcriptPort)
        throw new Error('Host omitted its repository port');
      ports.push(input.transcriptPort);
      const broker = new AgentDelegationBroker({
        ...input,
        registry,
        testOnlyStreamGeneration: true,
        preflight: (): Promise<{ ok: true; value: undefined }> =>
          Promise.resolve({ ok: true, value: undefined }),
        resolveRoute: (): Promise<{
          ok: true;
          value: ReturnType<typeof routeFixture>;
        }> => Promise.resolve({ ok: true, value: routeFixture() }),
        authorize: (): Promise<{ ok: true; value: undefined }> =>
          Promise.resolve({ ok: true, value: undefined }),
        releaseRoute: (): void => undefined,
        observeParentWorkspace: undefined,
        observeWorkspace: undefined,
      });
      constructed.push(broker);
      return broker;
    });
  const { createManagedDelegationSession, shutdownManagedDelegations } =
    await import('../agents/delegation/service');
  const options = { ...f.scope, chatId: 'colliding-chat', cwd: mockRoot };
  let providerIngress = Promise.resolve();
  const parents: Parameters<
    InstanceType<typeof AgentDelegationBroker>['spawn']
  >[0][] = [];
  try {
    for (const turn of ['first', 'second']) {
      const session = await createManagedDelegationSession({
        harness: 'claude',
        sessionKey: parent(f.scope).sessionKey,
        currentOptions: () => options,
        currentTurn: () => turn,
        getWindow: () => null,
        onTranscript: (transcript): void => {
          // Attached hosts deliver through the provider's ordinary ingestion;
          // the void callback is NOT a durable acknowledgement to the broker.
          providerIngress = providerIngress.then(async () => {
            await f.service.ingestProviderEventWithOutcome({
              ...f.scope,
              chatId,
              data: {
                type: 'canopy_delegation',
                delegation: transcript,
                canopy_turn_user_message_id: transcript.parentTurnId,
              },
              mutationId: `real-host:${turn}:${transcript.runGeneration}:${transcript.sequence}`,
            });
          });
        },
      });
      const context = session.parent.context(turn, 'call-1');
      if (!context)
        throw new Error('Host session omitted its live parent context');
      parents.push(context);
    }
    expect(initialize).toHaveBeenCalledTimes(1);
    const broker = constructed[0];
    const port = ports[0];
    if (!broker || !port) throw new Error('Host did not construct its broker');
    const crypto = (await import('node:crypto')).default;
    const uuid = jest
      .spyOn(crypto, 'randomUUID')
      .mockReturnValueOnce(delegationId);
    const liveParent = parents[1];
    if (!liveParent) throw new Error('Missing live host parent');
    expect(await broker.spawn(liveParent, baseTask)).toMatchObject({
      ok: true,
      value: { delegationId },
    });
    uuid.mockRestore();
    await eventually(
      () => Promise.resolve(runner.starts.length === 1),
      'host runner started',
    );
    await eventually(
      async () => (await f.rawCard()) !== undefined,
      'host raw creation card',
    );
    const raw = JSON.stringify(await f.rawCard());
    jest.spyOn(port, 'settle').mockResolvedValueOnce({
      ok: false,
      error: {
        code: 'storage_failure',
        message: 'real host settle fault',
        retryable: true,
      },
    });
    await runner
      .sink?.({
        delegationId,
        runGeneration: 1,
        sequence: 1,
        occurredAt: 200,
        event: {
          type: 'terminal',
          status: 'completed',
          finalText: 'real host exact answer',
        },
      })
      .catch(() => undefined);
    await eventually(
      async () => (await f.record()).latestResult?.notified === true,
      'host result notified',
    );
    const result = value(
      await f.port.result({ chatId, delegationId, resultIndex: 1 }),
    );
    expect(result.answer).toMatchObject({ kind: 'body', role: 'final' });
    expect(
      value(
        await f.port.resultAnswerRange({
          chatId,
          delegationId,
          resultIndex: 1,
          offset: 0,
          limit: 1024,
        }),
      ).text,
    ).toBe('real host exact answer');
    expect(value(await f.port.open({ target: target(1) }))).toMatchObject({
      status: 'settled',
      cardState: { canonical: { resultIndex: 1 } },
    });
    expect(JSON.stringify(await f.rawCard())).toBe(raw);
    expect(runner.starts).toHaveLength(1);
    expect(initialize).toHaveBeenCalledTimes(1);
  } finally {
    await providerIngress;
    await shutdownManagedDelegations();
  }
});

it('baseline: settles exact content once through the real format 4 repository', async () => {
  const { c12Backing, value, chatId, delegationId, target, eventually } =
    await import('./helpers/delegation-c12-harness');
  backing = await c12Backing(mockRoot);
  const f = backing;
  await f.start();
  const raw = JSON.stringify(await f.rawCard());
  await f.terminal('exact answer 🌳');
  await eventually(
    async () => (await f.record()).latestResult?.notified === true,
  );
  const result = value(
    await f.port.result({ chatId, delegationId, resultIndex: 1 }),
  );
  expect(result).toMatchObject({
    resultIndex: 1,
    runGeneration: 1,
    outcome: { status: 'completed', finishedAt: 200 },
    answer: { kind: 'body', role: 'final' },
  });
  expect(value(await f.port.open({ target: target(1) }))).toMatchObject({
    status: 'settled',
    cardState: { canonical: { resultIndex: 1 } },
  });
  expect(JSON.stringify(await f.rawCard())).toBe(raw);
  expect(f.harness.runner.starts).toHaveLength(1);
  expect(f.notifications).toHaveLength(1);
});

/** Assert disk-backed content and the exact replay receipt, not just calls. */
async function assertSettled(
  f: C12Backing,
  text: string | undefined,
  status = 'completed',
): Promise<DelegationTranscriptResultEntry> {
  const { value, chatId, delegationId, target, eventually } =
    await import('./helpers/delegation-c12-harness');
  await eventually(
    async () => (await f.record()).latestResult?.notified === true,
  );
  await f.harness.broker.flushCardPublication(target(1));
  const record = await f.record();
  const result = value(
    await f.port.result({ chatId, delegationId, resultIndex: 1 }),
  );
  expect(result).toMatchObject({
    resultIndex: 1,
    runGeneration: 1,
    outcome: { status },
    answer:
      text === undefined
        ? { kind: 'none' }
        : text === ''
          ? { kind: 'empty', role: 'final' }
          : { kind: 'body', role: 'final' },
  });
  expect(record.latestResult).toMatchObject({
    resultIndex: 1,
    status,
    notified: true,
  });
  expect(record.settling).toBeUndefined();
  expect(
    value(await f.port.resultsPage({ chatId, delegationId, limit: 10 }))
      .results,
  ).toEqual([result]);
  const descriptor = value(await f.port.open({ target: target(1) }));
  expect(descriptor).toMatchObject({
    status: 'settled',
    cardState: {
      canonical: { resultIndex: 1 },
      cardRevision: record.cardPublication?.cardRevision,
    },
  });
  if (descriptor.cardState?.version !== 2)
    throw new Error('Missing V2 card state');
  const {
    cardRevision: _revision,
    canonical: _canonical,
    ...durableDraft
  } = descriptor.cardState;
  void _revision;
  void _canonical;
  const { materializeCardDraft } =
    await import('@canopy/desktop-shared/node/delegation/card-publication');
  expect(durableDraft).toEqual(materializeCardDraft(record));
  expect(f.notifications[f.notifications.length - 1]?.[2]).toMatchObject({
    resultIndex: 1,
    status,
    runGeneration: 1,
  });
  if (text !== undefined && text !== '') {
    let body = '';
    let offset = 0;
    for (;;) {
      const range = value(
        await f.port.resultAnswerRange({
          chatId,
          delegationId,
          resultIndex: 1,
          offset,
          limit: 16_384,
        }),
      );
      body += range.text;
      if (range.nextOffset === undefined) break;
      offset = range.nextOffset;
    }
    expect(body).toBe(text);
  }
  return result;
}

const physicalSteps: readonly (
  | 'open'
  | 'write'
  | 'sync'
  | 'rename'
  | 'directory-sync'
)[] = ['open', 'write', 'sync', 'rename', 'directory-sync'];

const physicalFamilies: readonly ('record' | 'artifact')[] = [
  'record',
  'artifact',
];
it.each(
  physicalSteps.flatMap((step) =>
    physicalFamilies.map((family) => ({ step, family })),
  ),
)(
  '$family post-step $step rejection is ambiguous acknowledgement, not a failed operation',
  async ({ step, family }) => {
    const { c12Backing, PhysicalFault } =
      await import('./helpers/delegation-c12-harness');
    backing = await c12Backing(mockRoot);
    const f = backing;
    await f.start();
    const fault = new PhysicalFault(family, step, mockRoot, 'after');
    fault.enabled = family === 'artifact';
    fault.install();
    if (family === 'record') {
      const commit = f.storage.commit.bind(f.storage);
      let armed = false;
      jest.spyOn(f.storage, 'commit').mockImplementation(async (record) => {
        if (
          !armed &&
          'version' in record &&
          record.version === 3 &&
          record.settling
        ) {
          armed = true;
          fault.enabled = true;
        }
        await commit(record);
      });
    }
    await f.terminal('post-step exact retained answer').catch(() => undefined);
    expect(fault.hits).toBe(1);
    expect(fault.completed).toBe(true);
    expect(f.notifications).toEqual([]);
    const result = await assertSettled(f, 'post-step exact retained answer');
    expect(result.outcome).toMatchObject({
      status: 'completed',
      finishedAt: 200,
    });
    expect(f.harness.runner.starts).toHaveLength(1);
    if (family === 'artifact') {
      await f.reopenRepository();
      expect(await assertSettled(f, 'post-step exact retained answer')).toEqual(
        result,
      );
    }
  },
);

it.each(['admission', 'descriptor-sync', 'descriptor-post-sync'])(
  'card update %s retains its exact pair and never falsely resolves a barrier',
  async (cut) => {
    const {
      c12Backing,
      PhysicalFault,
      value,
      target,
      delegationId,
      eventually,
    } = await import('./helpers/delegation-c12-harness');
    let armed = false;
    let hits = 0;
    backing = await c12Backing(mockRoot, {
      boundary: (point) => {
        if (
          armed &&
          cut === 'descriptor-post-sync' &&
          point === 'record-synced' &&
          hits++ === 0
        )
          return Promise.reject(new Error('card post-sync'));
        return Promise.resolve();
      },
    });
    const f = backing;
    await f.start();
    const raw = JSON.stringify(await f.rawCard());
    const fault = new PhysicalFault('frame', 'sync', mockRoot);
    fault.enabled = false;
    if (cut === 'descriptor-sync') fault.install();
    const update = f.port.updateCardState.bind(f.port);
    let attempted = false;
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const updates = jest
      .spyOn(f.port, 'updateCardState')
      .mockImplementation(async (...args) => {
        if (attempted) await held;
        attempted = true;
        armed = true;
        if (cut === 'descriptor-sync' && fault.hits === 0) fault.enabled = true;
        try {
          if (cut === 'admission' && hits++ === 0)
            return {
              ok: false,
              error: {
                code: 'storage_failure',
                message: 'card admission',
                retryable: true,
              },
            };
          return await update(...args);
        } finally {
          armed = false;
        }
      });
    // The runtime's truncation observation changes a persisted draft field.
    await f.harness.runner.sink?.({
      delegationId,
      runGeneration: 1,
      sequence: 2,
      occurredAt: 150,
      event: { type: 'progress', text: 'bounded progress', truncated: true },
    });
    await eventually(() => Promise.resolve(attempted));
    let resolved = false;
    const barrier = f.harness.broker
      .flushCardPublication(target(1))
      .then(() => {
        resolved = true;
      });
    try {
      for (let i = 0; i < 5; i++)
        await new Promise<void>((resolve) => setImmediate(resolve));
      expect(resolved).toBe(false);
      if (cut !== 'admission') await f.reopenRepository();
    } finally {
      release();
    }
    await barrier;
    const first = updates.mock.calls[0]?.[0];
    expect(updates.mock.calls.length).toBeGreaterThan(1);
    expect(
      updates.mock.calls.every(
        ([request]) => JSON.stringify(request) === JSON.stringify(first),
      ),
    ).toBe(true);
    expect(
      value(await f.port.open({ target: target(1) })).cardState,
    ).toMatchObject({
      cardRevision: (await f.record()).cardPublication?.cardRevision,
      outputTruncated: true,
    });
    expect(JSON.stringify(await f.rawCard())).toBe(raw);
    expect(f.harness.runner.starts).toHaveLength(1);
  },
);

it.each<'before' | 'after'>(['before', 'after'])(
  'latest transcript receipt storage failure %s rename preserves actual rows and replay receipt',
  async (cut) => {
    const { c12Backing, value, target, delegationId } =
      await import('./helpers/delegation-c12-harness');
    const { delegationBlockId } = await import('@canopy/agent-transcript');
    backing = await c12Backing(mockRoot);
    const f = backing;
    await f.start();
    const request: Parameters<C12Backing['port']['appendChanges']>[0] = {
      target: target(1),
      mutationKey: 'receipt-fault',
      changes: [
        {
          row: {
            id: 'receipt-row',
            role: 'assistant',
            timestamp: 150,
            parentBlockId: delegationBlockId(delegationId, 1),
            delegationSequence: 1,
            delegationSegment: 'receipt-segment',
            itemRevision: 0,
            final: true,
            blocks: [{ type: 'text', text: 'durably admitted row' }],
          },
        },
      ],
    };
    const receipt = value(await f.port.appendChanges(request));
    const commit = f.storage.commit.bind(f.storage);
    let hits = 0;
    jest.spyOn(f.storage, 'commit').mockImplementation(async (record) => {
      if (
        hits === 0 &&
        'version' in record &&
        record.version === 3 &&
        record.latestReceipt?.mutationKey === 'receipt-fault'
      ) {
        hits++;
        if (cut === 'after') await commit(record);
        throw new Error('latest receipt write');
      }
      await commit(record);
    });
    await f.harness.runner
      .sink?.({
        delegationId,
        runGeneration: 1,
        sequence: 2,
        occurredAt: 150,
        event: {
          type: 'transcript_receipt',
          streamRevision: receipt.streamRevision,
          mutationKey: receipt.mutationKey,
          items: receipt.items,
          replayed: false,
        },
      })
      .catch(() => undefined);
    expect(hits).toBe(1);
    expect(f.notifications).toEqual([]);
    expect(value(await f.port.appendChanges(request))).toEqual({
      ...receipt,
      replayed: true,
    });
    expect(
      value(
        await f.port.page({
          target: target(1),
          streamRevision: receipt.streamRevision,
          limit: 10,
        }),
      ).rows,
    ).toEqual([request.changes[0]?.row]);
    await f.restart(true);
    expect(f.harness.runner.starts).toHaveLength(0);
    expect(value(await f.port.appendChanges(request))).toEqual({
      ...receipt,
      replayed: true,
    });
  },
);

it.each([
  undefined,
  '',
  'small exact answer',
  'externalized answer 🌲'.repeat(9000),
])(
  'answer case %# retains none/empty/body distinctions after settle refusal',
  async (text) => {
    const { c12Backing } = await import('./helpers/delegation-c12-harness');
    backing = await c12Backing(mockRoot);
    const f = backing;
    await f.start();
    jest.spyOn(f.port, 'settle').mockResolvedValueOnce({
      ok: false,
      error: {
        code: 'storage_failure',
        message: 'before admission',
        retryable: true,
      },
    });
    await f.terminal(text).catch(() => undefined);
    expect(f.notifications).toEqual([]);
    await assertSettled(f, text);
    expect(f.harness.runner.starts).toHaveLength(1);
  },
);

it.each(['refused', 'durable-ack-lost'])(
  'registration %s before dispatch has zero runner calls, no successful creation or fallback',
  async (cut) => {
    const { c12Backing, value, chatId, delegationId } =
      await import('./helpers/delegation-c12-harness');
    backing = await c12Backing(mockRoot);
    const f = backing;
    const register = f.port.registerGeneration.bind(f.port);
    const failed = jest
      .spyOn(f.port, 'registerGeneration')
      .mockImplementationOnce(async (...args) => {
        if (cut === 'durable-ack-lost') value(await register(...args));
        return {
          ok: false,
          error: { code: 'storage_failure', message: cut, retryable: true },
        };
      });
    expect((await f.spawn()).ok).toBe(false);
    expect(f.harness.runner.starts).toHaveLength(0);
    expect((await f.record()).latestResult).toBeUndefined();
    expect(f.notifications).toEqual([]);
    failed.mockRestore();
    await f.restart(true);
    expect(f.harness.runner.starts).toHaveLength(0);
    const recovered = value(
      await f.port.result({ chatId, delegationId, resultIndex: 1 }),
    );
    expect(recovered.outcome.status).toBe('cancelled');
    expect(recovered.answer).toEqual({ kind: 'none' });
  },
);

it('registration succeeds but descriptor open refuses after execution: exact identity repairs', async () => {
  const { c12Backing } = await import('./helpers/delegation-c12-harness');
  backing = await c12Backing(mockRoot);
  const f = backing;
  await f.start();
  jest.spyOn(f.port, 'open').mockResolvedValueOnce({
    ok: false,
    error: {
      code: 'storage_failure',
      message: 'open refused',
      retryable: true,
    },
  });
  await f.terminal('open retry body').catch(() => undefined);
  await assertSettled(f, 'open retry body');
  expect(f.harness.runner.starts).toHaveLength(1);
});

it.each(['before-bytes', 'after-intent'])(
  'process exit %s respects the durable intent boundary',
  async (cut) => {
    const { c12Backing, value, delegationId, chatId, target } =
      await import('./helpers/delegation-c12-harness');
    backing = await c12Backing(mockRoot);
    const f = backing;
    await f.start();
    const commit = f.storage.commit.bind(f.storage);
    let hits = 0;
    const fault = jest
      .spyOn(f.storage, 'commit')
      .mockImplementation(async (record) => {
        if (
          hits === 0 &&
          'version' in record &&
          record.version === 3 &&
          record.settling
        ) {
          hits++;
          if (cut === 'after-intent') await commit(record);
          throw new Error(cut);
        }
        await commit(record);
      });
    await f
      .terminal('volatile answer must not be invented after process exit')
      .catch(() => undefined);
    expect(hits).toBe(1);
    expect(f.notifications).toEqual([]);
    const image = await f.record();
    expect(image.settling !== undefined).toBe(cut === 'after-intent');
    fault.mockRestore();
    await f.restart(true);
    expect(f.harness.runner.starts).toHaveLength(0);
    const result = value(
      await f.port.result({ chatId, delegationId, resultIndex: 1 }),
    );
    if (cut === 'after-intent') {
      expect(result.settlementKey).toBe(image.settling?.settlementKey);
      expect(result.outcome).toMatchObject({
        status: 'completed',
        finishedAt: 200,
      });
      expect(result.answer).toMatchObject({ kind: 'lost', role: 'final' });
      expect(
        await f.port.resultAnswerRange({
          chatId,
          delegationId,
          resultIndex: 1,
          offset: 0,
          limit: 1024,
        }),
      ).toMatchObject({ ok: false, error: { code: 'answer_unavailable' } });
      const { overlayStreamBackedDelegationCard } =
        await import('@canopy/agent-transcript/lib/delegation-card-state');
      const card = (await f.rawCard())?.blocks?.find(
        (block) => block.type === 'delegated_agent_call',
      );
      const state = value(await f.port.open({ target: target(1) })).cardState;
      if (!card || card.type !== 'delegated_agent_call' || !state)
        throw new Error('Missing card');
      expect(overlayStreamBackedDelegationCard(card, state)).toMatchObject({
        status: 'completed',
        answerUnavailable: true,
      });
    } else {
      expect(result.outcome.status).toBe('interrupted');
      expect(result.answer).toEqual({ kind: 'none' });
    }
    const receipt = result.settlement;
    await f.restart();
    expect(
      value(await f.port.result({ chatId, delegationId, resultIndex: 1 })),
    ).toEqual({ ...result, settlement: receipt });
    expect(f.harness.runner.starts).toHaveLength(0);
  },
);

it.each(['before', 'after'])(
  'registry effect append %s operation preserves the durable frame on reopen',
  async (cut) => {
    const { c12Backing, value } =
      await import('./helpers/delegation-c12-harness');
    const { DelegationRegistryStore } =
      await import('../lib/chat-delta-journal/delegation-registry-store');
    backing = await c12Backing(mockRoot);
    const f = backing;
    await f.start();
    // The wrapper explicitly reapplies the original instance below.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const append = DelegationRegistryStore.prototype.append;
    let hits = 0;
    jest
      .spyOn(DelegationRegistryStore.prototype, 'append')
      .mockImplementation(async function (
        this: InstanceType<typeof DelegationRegistryStore>,
        ...args
      ) {
        if (
          hits === 0 &&
          args[1].some((effect) => effect.kind === 'delegation-result')
        ) {
          hits++;
          if (cut === 'after') await append.apply(this, args);
          throw new Error(`registry append ${cut}`);
        }
        await append.apply(this, args);
      });
    const settle = jest.spyOn(f.port, 'settle');
    await f.terminal('registry exact body').catch(() => undefined);
    expect(hits).toBe(1);
    await f.reopenRepository();
    const result = await assertSettled(f, 'registry exact body');
    const request = settle.mock.calls[0]?.[0];
    if (!request) throw new Error('Missing request');
    expect(value(await f.port.settle(request)).result).toEqual(result);
    expect(f.harness.runner.starts).toHaveLength(1);
  },
);

it.each(['locator-before', 'locator-after', 'marker-before', 'marker-after'])(
  '%s does not undo canonical settlement or notify before durable locator',
  async (cut) => {
    const { c12Backing, value, chatId, delegationId } =
      await import('./helpers/delegation-c12-harness');
    backing = await c12Backing(mockRoot);
    const f = backing;
    await f.start();
    const commit = f.storage.commit.bind(f.storage);
    let hits = 0;
    const fault = jest
      .spyOn(f.storage, 'commit')
      .mockImplementation(async (record) => {
        if (
          hits === 0 &&
          'version' in record &&
          record.version === 3 &&
          record.latestResult &&
          (cut.startsWith('marker')
            ? record.latestResult.notified
            : !record.latestResult.notified)
        ) {
          hits++;
          if (cut.endsWith('after')) await commit(record);
          throw new Error(cut);
        }
        await commit(record);
      });
    await f.terminal('durable locator body').catch(() => undefined);
    expect(hits).toBe(1);
    const canonical = value(
      await f.port.result({ chatId, delegationId, resultIndex: 1 }),
    );
    expect(canonical.answer).toMatchObject({ kind: 'body' });
    if (cut.startsWith('locator')) expect(f.notifications).toHaveLength(0);
    else expect(f.notifications).toHaveLength(1);
    // A marker failure may release the body, as specified; a fresh broker
    // re-notifies the same durable locator. Locator failures repair in-process.
    if (cut.startsWith('marker')) {
      fault.mockRestore();
      await f.restart(true);
    }
    const result = await assertSettled(f, 'durable locator body');
    expect(result).toEqual(canonical);
    expect(f.harness.runner.starts).toHaveLength(
      cut.startsWith('marker') ? 0 : 1,
    );
  },
);

it('held locator permits durable terminal visibility but not watcher notification', async () => {
  const { c12Backing, value, chatId, delegationId } =
    await import('./helpers/delegation-c12-harness');
  backing = await c12Backing(mockRoot);
  const f = backing;
  await f.start();
  let release = (): void => undefined;
  let entered = (): void => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const commit = f.storage.commit.bind(f.storage);
  let paused = false;
  jest.spyOn(f.storage, 'commit').mockImplementation(async (record) => {
    if (
      !paused &&
      'version' in record &&
      record.version === 3 &&
      record.latestResult
    ) {
      paused = true;
      entered();
      await held;
    }
    await commit(record);
  });
  const terminal = f.terminal('held locator exact body');
  try {
    await waiting;
    expect(
      value(await f.port.result({ chatId, delegationId, resultIndex: 1 }))
        .answer,
    ).toMatchObject({ kind: 'body' });
    expect((await f.record()).latestResult).toBeUndefined();
    expect(f.notifications).toHaveLength(0);
  } finally {
    release();
  }
  await terminal;
  await assertSettled(f, 'held locator exact body');
  expect(f.harness.runner.starts).toHaveLength(1);
});

it('notify failure retries its original durable locator and outcome without relaunch', async () => {
  const { c12Backing, eventually } =
    await import('./helpers/delegation-c12-harness');
  const notify = jest
    .fn()
    .mockRejectedValueOnce(new Error('delivery offline'))
    .mockResolvedValue(undefined);
  backing = await c12Backing(mockRoot, { broker: { onSettled: notify } });
  const f = backing;
  await f.start();
  await f.terminal('notified answer').catch(() => undefined);
  await eventually(
    async () => (await f.record()).latestResult?.notified === true,
  );
  expect(notify).toHaveBeenCalledTimes(2);
  expect(notify.mock.calls[1]).toEqual(notify.mock.calls[0]);
  expect(f.harness.runner.starts).toHaveLength(1);
});

it.each(['before', 'after'])(
  'trusted partial terminal + open final row: externalization fails %s operation',
  async (cut) => {
    const crypto = await import('node:crypto');
    const { delegationBlockId } = await import('@canopy/agent-transcript');
    const contract =
      await import('@canopy/desktop-shared/node/delegation/broker-settlement-contract');
    const { ChatTranscriptArtifacts } =
      await import('../lib/chat-transcript-artifacts');
    const { c12Backing, value, target, delegationId, chatId, eventually } =
      await import('./helpers/delegation-c12-harness');
    backing = await c12Backing(mockRoot);
    const f = backing;
    await f.start();
    const text = 'trusted partial terminal body 🌱';
    const content = 'open row exact content 🪴'.repeat(4000);
    value(
      await f.port.appendChanges({
        target: target(1),
        mutationKey: 'open-row',
        changes: [
          {
            row: {
              id: 'partial-open-row',
              role: 'assistant',
              timestamp: 150,
              parentBlockId: delegationBlockId(delegationId, 1),
              delegationSequence: 1,
              delegationSegment: 'trusted-terminal',
              itemRevision: 0,
              final: false,
              blocks: [{ type: 'text', text: content }],
            },
          },
        ],
      }),
    );
    const raw = JSON.stringify(await f.rawCard());
    // Explicit trusted terminal fixture, not an in-flight delta presented as final.
    jest.spyOn(contract, 'captureSettlementAnswer').mockReturnValueOnce({
      answer: {
        role: 'partial',
        length: text.length,
        sha256: crypto
          .createHash('sha256')
          .update(Buffer.from(text, 'utf16le'))
          .digest('hex'),
      },
      settleAnswer: { role: 'partial', text },
    });
    // The wrapper explicitly reapplies the original instance below.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const externalize = ChatTranscriptArtifacts.prototype.externalize;
    let hits = 0;
    jest
      .spyOn(ChatTranscriptArtifacts.prototype, 'externalize')
      .mockImplementation(async function (
        this: InstanceType<typeof ChatTranscriptArtifacts>,
        ...args
      ) {
        if (
          hits === 0 &&
          args[1].id === 'partial-open-row' &&
          'final' in args[1] &&
          args[1].final
        ) {
          hits++;
          if (cut === 'after') await externalize.apply(this, args);
          throw new Error(`final-row externalize ${cut}`);
        }
        return externalize.apply(this, args);
      });
    await f.terminal(text).catch(() => undefined);
    expect(hits).toBe(1);
    expect(f.notifications).toEqual([]);
    await eventually(
      async () => (await f.record()).latestResult?.notified === true,
    );
    const result = value(
      await f.port.result({ chatId, delegationId, resultIndex: 1 }),
    );
    expect(result.answer).toMatchObject({ kind: 'body', role: 'partial' });
    expect(
      value(
        await f.port.resultAnswerRange({
          chatId,
          delegationId,
          resultIndex: 1,
          offset: 0,
          limit: 1024,
        }),
      ).text,
    ).toBe(text);
    const page = value(
      await f.port.page({
        target: target(1),
        streamRevision: result.settlement.contentRevision,
        limit: 10,
      }),
    );
    expect(page.rows).toMatchObject([
      { id: 'partial-open-row', final: true, itemRevision: 1 },
    ]);
    let rowBody = '';
    let offset = 0;
    for (;;) {
      const range = value(
        await f.port.contentRange({
          target: target(1),
          streamRevision: result.settlement.contentRevision,
          messageId: 'partial-open-row',
          blockOrdinal: 0,
          field: 'text',
          offset,
          limit: 16_384,
        }),
      );
      rowBody += range.text;
      if (range.nextOffset === undefined) break;
      offset = range.nextOffset;
    }
    expect(rowBody).toBe(content);
    expect(JSON.stringify(await f.rawCard())).toBe(raw);
    expect(f.harness.runner.starts).toHaveLength(1);
  },
);

it.each<'user_cancelled' | 'deadline_exceeded' | 'policy_revoked'>([
  'user_cancelled',
  'deadline_exceeded',
  'policy_revoked',
])(
  'real stop path preserves %s attribution through publication repair',
  async (reason) => {
    const { c12Backing, value, target, chatId, delegationId, eventually } =
      await import('./helpers/delegation-c12-harness');
    const { parent } = await import('./helpers/delegation-two-scope-backing');
    backing = await c12Backing(mockRoot);
    const f = backing;
    await f.start();
    jest.spyOn(f.port, 'settle').mockResolvedValueOnce({
      ok: false,
      error: {
        code: 'storage_failure',
        message: 'stop publication offline',
        retryable: true,
      },
    });
    jest.spyOn(f.harness.runner, 'stop').mockImplementation(async (handle) => {
      f.harness.runner.stopped.push(handle.runId);
      await f.harness.runner.sinks.get(handle.runId)?.({
        delegationId,
        runGeneration: 1,
        sequence: 50,
        occurredAt: 250,
        event: {
          type: 'terminal',
          status:
            reason === 'deadline_exceeded' ? 'deadline_exceeded' : 'cancelled',
        },
      });
      return { stopped: true };
    });
    if (reason === 'policy_revoked')
      await expect(
        f.harness.broker.revokeHarness('third-harness'),
      ).rejects.toThrow('Provider delegation revocation was incomplete');
    else
      expect(
        (await f.harness.broker.stop(parent(f.scope), delegationId, reason)).ok,
      ).toBe(false); // the failed durable settle cannot be acknowledged yet
    await eventually(
      async () => (await f.record()).latestResult?.notified === true,
    );
    const result = value(
      await f.port.result({ chatId, delegationId, resultIndex: 1 }),
    );
    expect(result.outcome).toMatchObject({
      status:
        reason === 'deadline_exceeded' ? 'deadline_exceeded' : 'cancelled',
      stopReason: reason,
    });
    const { overlayStreamBackedDelegationCard } =
      await import('@canopy/agent-transcript/lib/delegation-card-state');
    const card = (await f.rawCard())?.blocks?.find(
      (block) => block.type === 'delegated_agent_call',
    );
    const state = value(await f.port.open({ target: target(1) })).cardState;
    if (!card || card.type !== 'delegated_agent_call' || !state)
      throw new Error('Missing card');
    expect(overlayStreamBackedDelegationCard(card, state)).toMatchObject({
      stopReason: reason,
      cancelledByUser: reason === 'user_cancelled',
    });
    expect(f.harness.runner.stopped).toHaveLength(1);
    expect(f.harness.runner.starts).toHaveLength(1);
  },
);

it.each(physicalSteps)(
  'intent record: actual failed %s is repaired in-process with the original answer',
  async (step) => {
    const { c12Backing, PhysicalFault, delegationId } =
      await import('./helpers/delegation-c12-harness');
    backing = await c12Backing(mockRoot);
    const f = backing;
    await f.start();
    const raw = JSON.stringify(await f.rawCard());
    const fault = new PhysicalFault('record', step, mockRoot);
    fault.enabled = false;
    fault.install();
    const commit = f.storage.commit.bind(f.storage);
    let armed = false;
    let intended:
      | { settlementKey: string; assertedResultIndex: number }
      | undefined;
    jest.spyOn(f.storage, 'commit').mockImplementation(async (record) => {
      if (
        !armed &&
        'version' in record &&
        record.version === 3 &&
        record.settling
      ) {
        armed = true;
        fault.enabled = true;
        intended = record.settling;
      }
      await commit(record);
    });
    await f.terminal('original outcome, exact body 🌲').catch(() => undefined);
    expect(fault.hits).toBe(1);
    const uncertain = await f.storage.loadOne(delegationId);
    expect(uncertain?.version === 3 && uncertain.latestResult).toBeUndefined();
    expect(f.notifications).toEqual([]);
    const settled = await assertSettled(f, 'original outcome, exact body 🌲');
    expect(settled.settlementKey).toBe(intended?.settlementKey);
    expect(settled.resultIndex).toBe(intended?.assertedResultIndex);
    expect(settled.outcome).toMatchObject({
      status: 'completed',
      finishedAt: 200,
    });
    expect(f.harness.runner.starts).toHaveLength(1);
    expect(JSON.stringify(await f.rawCard())).toBe(raw);
  },
);

it.each(physicalSteps)(
  'answer artifact: actual failed %s never acknowledges missing content',
  async (step) => {
    const { c12Backing, PhysicalFault, value, target } =
      await import('./helpers/delegation-c12-harness');
    backing = await c12Backing(mockRoot);
    const f = backing;
    await f.start();
    const fault = new PhysicalFault('artifact', step, mockRoot);
    fault.install();
    const settle = jest.spyOn(f.port, 'settle');
    const text = 'large exact Unicode answer 🌲\n'.repeat(6000);
    await f.terminal(text).catch(() => undefined);
    expect(fault.hits).toBe(1);
    expect(f.notifications).toEqual([]);
    expect(value(await f.port.open({ target: target(1) })).status).toBe('open');
    expect((await f.record()).latestResult).toBeUndefined();
    const result = await assertSettled(f, text);
    await f.reopenRepository();
    expect(await assertSettled(f, text)).toEqual(result);
    const original = settle.mock.calls[0]?.[0];
    if (!original) throw new Error('No settle request');
    expect(
      settle.mock.calls.every(
        ([request]) =>
          request.settlementKey === original.settlementKey &&
          request.resultIndex === 1 &&
          JSON.stringify(request.answer) === JSON.stringify(original.answer),
      ),
    ).toBe(true);
    const replay = value(await f.port.settle(original));
    expect(replay.result).toEqual(result);
    expect(replay.settlement).toMatchObject({
      replayed: true,
      streamRevision: result.settlement.streamRevision,
      contentRevision: result.settlement.contentRevision,
    });
    expect(f.harness.runner.starts).toHaveLength(1);
  },
);

it.each<'open' | 'write' | 'sync'>(['open', 'write', 'sync'])(
  'settle frame: actual failed %s reopens without a second result',
  async (step) => {
    const { c12Backing, PhysicalFault, value, chatId, delegationId } =
      await import('./helpers/delegation-c12-harness');
    const fault = new PhysicalFault('frame', step, mockRoot);
    fault.enabled = false;
    let armed = false;
    backing = await c12Backing(mockRoot, {
      boundary: (point) => {
        if (!armed && point === 'finalize-journal') {
          armed = true;
          fault.enabled = true;
        }
        return Promise.resolve();
      },
    });
    const f = backing;
    await f.start();
    fault.install();
    const requests = jest.spyOn(f.port, 'settle');
    await f.terminal('frame body').catch(() => undefined);
    expect(fault.hits).toBe(1);
    expect(f.notifications).toEqual([]);
    await f.reopenRepository();
    const result = await assertSettled(f, 'frame body');
    const request = requests.mock.calls[0]?.[0];
    if (!request) throw new Error('Missing request');
    expect(value(await f.port.settle(request)).result).toEqual(result);
    expect(
      value(await f.port.resultsPage({ chatId, delegationId, limit: 10 }))
        .results,
    ).toHaveLength(1);
    expect(f.harness.runner.starts).toHaveLength(1);
  },
);

it.each<DeltaJournalBoundary>([
  'registry-answer-published',
  'finalize-artifact',
  'finalize-journal',
  'record-written',
  'record-synced',
  'registry-settle-admitted',
])(
  'post-step hook %s is not misreported as a failed physical step',
  async (cut) => {
    const { c12Backing, value } =
      await import('./helpers/delegation-c12-harness');
    let armed = false;
    let hits = 0;
    backing = await c12Backing(mockRoot, {
      boundary: (point) => {
        if (armed && point === cut && hits++ === 0)
          return Promise.reject(new Error(`post-step ${cut}`));
        return Promise.resolve();
      },
    });
    const f = backing;
    await f.start();
    const original = f.port.settle.bind(f.port);
    const settle = jest
      .spyOn(f.port, 'settle')
      .mockImplementation(async (...args) => {
        armed = true;
        try {
          return await original(...args);
        } finally {
          armed = false;
        }
      });
    await f.terminal('post-step durable identity').catch(() => undefined);
    expect(hits).toBeGreaterThanOrEqual(1);
    if (
      cut === 'record-written' ||
      cut === 'record-synced' ||
      cut === 'registry-settle-admitted'
    )
      await f.reopenRepository();
    const result = await assertSettled(f, 'post-step durable identity');
    const request = settle.mock.calls[0]?.[0];
    if (!request) throw new Error('Missing request');
    expect(value(await f.port.settle(request)).result).toEqual(result);
    expect(f.harness.runner.starts).toHaveLength(1);
  },
);
