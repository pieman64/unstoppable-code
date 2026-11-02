import { randomUUID } from 'node:crypto';
import type {
  AgentDelegationBrokerOptions,
  AgentDelegationBroker,
  StoredDelegation,
} from '../broker';
import { InMemoryDelegationTranscriptPort } from '../in-memory-transcript-port';
import {
  decodeStoredDelegationV3,
  delegationSettlementKey,
  type StoredDelegationV3,
} from '../record-v3';
import { DELEGATION_STORAGE_RECORD_MAX_BYTES } from '../storage';
import { routeFixture, type FakeRunner } from './fixtures';
import type {
  DelegationTranscriptCardStateRequest,
  DelegationTranscriptPortError,
} from '../transcript-port';
import { materializeCardDraft } from '../card-publication';
import {
  baseTask,
  createBrokerHarness,
  flushBroker,
  MemoryDelegationStorage,
  rootParent,
  waitForLaunch,
} from './broker-harness';

class ReopenableCardPort extends InMemoryDelegationTranscriptPort {
  reopen(): ReopenableCardPort {
    const reopened = new ReopenableCardPort({
      owns: (): boolean => true,
      ownsChat: (): boolean => true,
    });
    for (const [key, value] of Array.from(this.streams))
      reopened.streams.set(key, structuredClone(value));
    for (const [key, value] of Array.from(this.registries))
      reopened.registries.set(key, structuredClone(value));
    for (const [key, value] of Array.from(this.answers))
      reopened.answers.set(key, { ...value, bytes: Buffer.from(value.bytes) });
    return reopened;
  }
}

function streamRecord(
  storage: MemoryDelegationStorage,
  id: string,
): StoredDelegationV3 {
  const record = storage.records.get(id);
  if (record?.version !== 3) throw new Error('Expected a stream record');
  return record;
}

async function fixture(
  options: Partial<AgentDelegationBrokerOptions> = {},
): Promise<{
  broker: AgentDelegationBroker;
  runner: FakeRunner;
  storage: MemoryDelegationStorage;
  port: ReopenableCardPort;
  id: string;
}> {
  const port = new ReopenableCardPort({
    owns: (): boolean => true,
    ownsChat: (): boolean => true,
  });
  const storage = new MemoryDelegationStorage();
  const { broker, runner } = createBrokerHarness(
    { testOnlyStreamGeneration: true, transcriptPort: port, ...options },
    storage,
  );
  await broker.initialize();
  const spawned = await broker.spawn(rootParent, baseTask);
  if (!spawned.ok) throw new Error('Expected admission');
  await waitForLaunch(runner, spawned.value.delegationId);
  await runner.sink?.({
    delegationId: spawned.value.delegationId,
    runGeneration: 1,
    sequence: 1,
    occurredAt: 100,
    event: { type: 'started', nativeSessionId: 'native-card-session' },
  });
  await flushBroker();
  return { broker, runner, storage, port, id: spawned.value.delegationId };
}

function target(
  id: string,
  runGeneration = 1,
): {
  kind: 'delegation';
  chatId: string;
  delegationId: string;
  runGeneration: number;
} {
  return {
    kind: 'delegation',
    chatId: 'chat',
    delegationId: id,
    runGeneration,
  };
}

async function metadata(
  broker: AgentDelegationBroker,
  id: string,
  discarded: boolean,
): Promise<void> {
  await broker['update'](id, (record: StoredDelegation) => ({
    ...record,
    workspaceDiscarded: discarded,
  }));
}

describe('12b broker card publication', () => {
  afterEach(() => jest.restoreAllMocks());

  it('stamps only stream projections and commits a reproducible descriptor pair', async () => {
    const { broker, storage, port, id } = await fixture();
    try {
      expect((await broker.transcripts(rootParent))[0]?.transcriptStore).toBe(
        'chat-stream-v2',
      );
      const record = streamRecord(storage, id);
      expect(record.cardPublication?.cardRevision).toBeGreaterThan(0);
      const descriptor = await port.generation(target(id));
      expect(descriptor).toMatchObject({
        ok: true,
        value: {
          stream: {
            cardState: {
              ...materializeCardDraft(record),
              cardRevision: record.cardPublication?.cardRevision,
            },
          },
        },
      });
    } finally {
      await broker.close();
    }
  });

  it('allocates only fitted durable changes and carries the pair into settle and locator commits', async () => {
    const { broker, storage, port, id } = await fixture();
    const settle = jest.spyOn(port, 'settle');
    try {
      const before =
        streamRecord(storage, id).cardPublication?.cardRevision ?? 0;
      await metadata(broker, id, true);
      expect(streamRecord(storage, id).cardPublication?.cardRevision).toBe(
        before + 1,
      );
      await metadata(broker, id, true);
      expect(streamRecord(storage, id).cardPublication?.cardRevision).toBe(
        before + 1,
      );
      await broker['update'](id, (record) => ({
        ...record,
        state: { ...record.state, status: 'completed', finishedAt: 200 },
      }));
      const record = streamRecord(storage, id);
      expect(settle.mock.calls[0]?.[0]).toMatchObject({
        cardDraft: materializeCardDraft(record),
        cardRevision: record.cardPublication?.cardRevision,
      });
      expect(record.latestResult?.runGeneration).toBe(1);
      expect(record.cardPublication?.draft.workspaceDiscarded).toBe(true);
    } finally {
      await broker.close();
    }
  });

  it('commits the result locator even when the post-settle descriptor read fails', async () => {
    const { broker, storage, port, id } = await fixture();
    const settle = port.settle.bind(port);
    const generation = port.generation.bind(port);
    const unavailable: {
      readonly ok: false;
      readonly error: DelegationTranscriptPortError;
    } = {
      ok: false,
      error: {
        code: 'storage_failure',
        message: 'descriptor read failed',
        retryable: true,
      },
    };
    let settled = false;
    jest.spyOn(port, 'settle').mockImplementation(async (input) => {
      const result = await settle(input);
      settled = true;
      return result;
    });
    jest
      .spyOn(port, 'generation')
      .mockImplementation((input) =>
        settled ? Promise.resolve(unavailable) : generation(input),
      );
    try {
      await metadata(broker, id, true);
      await broker['update'](id, (record) => ({
        ...record,
        state: { ...record.state, status: 'completed', finishedAt: 200 },
      }));
      expect(streamRecord(storage, id).latestResult).toMatchObject({
        runGeneration: 1,
        status: 'completed',
      });
    } finally {
      await broker.close();
    }
  });

  it('does not publish an uncommitted metadata draft', async () => {
    const { broker, storage, port, id } = await fixture();
    const update = jest.spyOn(port, 'updateCardState');
    const original = storage.commit.bind(storage);
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    jest.spyOn(storage, 'commit').mockImplementation(async (record) => {
      if (record.workspaceDiscarded) await held;
      await original(record);
    });
    try {
      const work = metadata(broker, id, true);
      await flushBroker();
      expect(
        update.mock.calls.some(
          ([request]) => request.cardDraft.workspaceDiscarded,
        ),
      ).toBe(false);
      release?.();
      await work;
      await flushBroker();
      expect(
        update.mock.calls.some(
          ([request]) => request.cardDraft.workspaceDiscarded,
        ),
      ).toBe(true);
    } finally {
      release?.();
      await broker.close();
    }
  });

  it('retries the identical request after an uncertain write, past the capped backoff, without another event', async () => {
    const { broker, port, storage, id } = await fixture();
    await broker.flushCardPublication(target(id));
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    const original = port.updateCardState.bind(port);
    let failed = true;
    const update = jest
      .spyOn(port, 'updateCardState')
      .mockImplementation(async (request) => {
        const admitted = await original(request);
        return failed
          ? {
              ok: false,
              error: {
                code: 'storage_failure',
                message: 'lost acknowledgement',
                retryable: true,
              },
            }
          : admitted;
      });
    try {
      await metadata(broker, id, true);
      await flushBroker();
      const revision = streamRecord(storage, id).cardPublication?.cardRevision;
      expect(await port.generation(target(id))).toMatchObject({
        ok: true,
        value: {
          stream: {
            cardState: { cardRevision: revision, workspaceDiscarded: true },
          },
        },
      });
      const barrier = broker.flushCardPublication(target(id));
      let covered = false;
      void barrier.then(() => {
        covered = true;
      });
      for (const delay of [
        250, 500, 1000, 2000, 4000, 8000, 16000, 30000, 30000,
      ]) {
        await jest.advanceTimersByTimeAsync(delay);
        await flushBroker();
      }
      expect(update.mock.calls).toHaveLength(10);
      expect(covered).toBe(false);
      expect(
        update.mock.calls.every(
          ([request]) =>
            JSON.stringify(request) ===
            JSON.stringify(update.mock.calls[0]?.[0]),
        ),
      ).toBe(true);
      failed = false;
      await jest.advanceTimersByTimeAsync(30000);
      await barrier;
      expect(update.mock.calls).toHaveLength(11);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      await broker.close();
      jest.useRealTimers();
    }
  });

  it('replaces only pending work, pins a barrier, and never serializes metadata behind the drain', async () => {
    const { broker, port, storage, id } = await fixture();
    await broker.flushCardPublication(target(id));
    const original = port.updateCardState.bind(port);
    const started: DelegationTranscriptCardStateRequest[] = [];
    let release: (() => void) | undefined;
    jest.spyOn(port, 'updateCardState').mockImplementation(async (request) => {
      started.push(request);
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return original(request);
    });
    try {
      await metadata(broker, id, true);
      await flushBroker();
      const first = streamRecord(storage, id).cardPublication?.cardRevision;
      const pinned = broker.flushCardPublication(target(id));
      await metadata(broker, id, false);
      await broker['update'](id, (record) => ({
        ...record,
        workspaceDiscarded: false,
        capabilityGrant: undefined,
      }));
      await metadata(broker, id, true);
      const latest = streamRecord(storage, id).cardPublication?.cardRevision;
      expect(latest).toBe((first ?? 0) + 2);
      expect(started).toHaveLength(1);
      release?.();
      await pinned;
      await flushBroker();
      expect(started.map((request) => request.cardRevision)).toEqual([
        first,
        latest,
      ]);
      const descriptor = await port.generation(target(id));
      expect(descriptor).toMatchObject({
        ok: true,
        value: {
          stream: {
            cardState: { cardRevision: first, workspaceDiscarded: true },
          },
        },
      });
      release?.();
      await broker.flushCardPublication(target(id));
    } finally {
      release?.();
      await broker.close();
    }
  });

  it.each([
    'conflict',
    'invalid_request',
    'unsupported_format',
    'unauthorized',
    'corruption',
    'answer_unavailable',
    'not_found',
  ] as const)('terminates %s and rejects its barriers', async (code) => {
    const { broker, port, id } = await fixture();
    await broker.flushCardPublication(target(id));
    const update = jest.spyOn(port, 'updateCardState').mockResolvedValue({
      ok: false,
      error: { code, message: 'terminal refusal', retryable: false },
    });
    try {
      await metadata(broker, id, true);
      await expect(broker.flushCardPublication(target(id))).rejects.toThrow(
        code,
      );
      expect(update).toHaveBeenCalledTimes(1);
    } finally {
      await broker.close();
    }
  });

  it('rejects barriers and cancels retry timers before close waits for record chains', async () => {
    const { broker, port, id } = await fixture();
    await broker.flushCardPublication(target(id));
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    jest
      .spyOn(port, 'updateCardState')
      .mockRejectedValue(new Error('storage unavailable'));
    await metadata(broker, id, true);
    const barrier = broker.flushCardPublication(target(id));
    const rejected = expect(barrier).rejects.toThrow('closed');
    await flushBroker();
    expect(jest.getTimerCount()).toBe(1);
    await broker.close();
    await rejected;
    expect(jest.getTimerCount()).toBe(0);
    jest.useRealTimers();
  });

  it('preflights the complete near-limit record before calling storage.commit', async () => {
    const { broker, storage, id } = await fixture();
    const prior = streamRecord(storage, id);
    let near: StoredDelegationV3 = {
      ...prior,
      legacyPrefix: {
        controls: [
          {
            operationId: '00000000-0000-4000-8000-000000000099',
            key: 'a'.repeat(64),
            requestHash: 'b'.repeat(64),
            operation: 'steer',
            status: 'failed',
            firstOutcome: {
              delegationId: id,
              status: 'completed',
              outputTruncated: false,
              finalText: '',
            },
          },
        ],
      },
    };
    const available =
      DELEGATION_STORAGE_RECORD_MAX_BYTES -
      Buffer.byteLength(JSON.stringify(near), 'utf8') -
      10;
    const control = near.legacyPrefix?.controls?.[0];
    if (!control?.firstOutcome)
      throw new Error('Expected legacy outcome fixture');
    near = {
      ...near,
      legacyPrefix: {
        controls: [
          {
            ...control,
            firstOutcome: {
              ...control.firstOutcome,
              finalText:
                'é'.repeat(Math.floor(available / 2)) +
                'x'.repeat(available % 2),
            },
          },
        ],
      },
    };
    decodeStoredDelegationV3(JSON.parse(JSON.stringify(near)));
    broker['records'].set(id, near);
    const commit = jest.spyOn(storage, 'commit');
    try {
      await expect(metadata(broker, id, true)).rejects.toThrow('byte bound');
      expect(commit).not.toHaveBeenCalled();
      expect(broker['records'].get(id)).toBe(near);
    } finally {
      broker['records'].set(id, prior);
      await broker.close();
    }
  });

  it('classifies a higher-counter frozen-field refusal as terminal, never as coverage', async () => {
    const { broker, port, storage, id } = await fixture();
    await broker['update'](id, (record) => ({
      ...record,
      state: { ...record.state, status: 'completed', finishedAt: 200 },
    }));
    await broker.flushCardPublication(target(id));
    const prior = streamRecord(storage, id);
    const pair = prior.cardPublication;
    if (!pair) throw new Error('Expected baseline');
    const violating: StoredDelegationV3 = {
      ...prior,
      cardPublication: {
        ...pair,
        cardRevision: pair.cardRevision + 1,
        draft: { ...pair.draft, nativeSessionId: 'forbidden-after-settle' },
      },
    };
    broker['records'].set(id, violating);
    const update = jest.spyOn(port, 'updateCardState');
    // A committed fixture simulates a counter-valid record with a frozen-rule defect.
    broker['cardPublications'].enqueue(violating);
    try {
      await expect(broker.flushCardPublication(target(id))).rejects.toThrow(
        'frozen fields',
      );
      expect(update.mock.results).toHaveLength(1);
      expect(broker['cardPublications'].watermark(target(id))).toBe(
        pair.cardRevision,
      );
      expect(await port.generation(target(id))).toMatchObject({
        ok: true,
        value: { stream: { cardState: { cardRevision: pair.cardRevision } } },
      });
    } finally {
      broker['records'].set(id, prior);
      await broker.close();
    }
  });

  it.each(['first', 'adopted', 'keyed replay'] as const)(
    'reads descriptor coverage after %s settle and preserves canonical outcome',
    async (mode) => {
      const { broker, port, storage, id } = await fixture();
      await broker.flushCardPublication(target(id));
      const old = streamRecord(storage, id);
      const baseline = old.cardPublication?.cardRevision ?? 0;
      const originalUpdate = port.updateCardState.bind(port);
      let release: (() => void) | undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      jest
        .spyOn(port, 'updateCardState')
        .mockImplementation(async (request) => {
          await held;
          return originalUpdate(request);
        });
      await metadata(broker, id, true);
      await flushBroker();
      const originalSettle = port.settle.bind(port);
      const request = {
        target: target(id),
        settlementKey: delegationSettlementKey('chat', id, 1),
        resultIndex: 1,
        outcome: {
          status: 'completed' as const,
          finishedAt: 200,
          startedAt: 100,
        },
        finalChanges: [],
        answer: null,
        openRows: 'finalize' as const,
      };
      if (mode !== 'first')
        expect((await originalSettle(request)).ok).toBe(true);
      if (mode === 'keyed replay') {
        // Force the first lookups to miss, then the actual settle hits its known key.
        jest.spyOn(port, 'resultBySettlementKey').mockResolvedValueOnce({
          ok: false,
          error: {
            code: 'not_found',
            retryable: false,
            message: 'lookup missed',
          },
        });
        jest.spyOn(port, 'resultByGeneration').mockResolvedValueOnce({
          ok: false,
          error: {
            code: 'not_found',
            retryable: false,
            message: 'lookup missed',
          },
        });
      }
      const settle = jest.spyOn(port, 'settle').mockImplementation((input) =>
        originalSettle({
          ...input,
          ...(mode === 'first'
            ? { cardDraft: materializeCardDraft(old), cardRevision: baseline }
            : {}),
        }),
      );
      const read = jest.spyOn(port, 'generation');
      try {
        await broker['update'](id, (record) => ({
          ...record,
          state: { ...record.state, status: 'completed', finishedAt: 200 },
        }));
        const record = streamRecord(storage, id);
        const required = record.cardPublication?.cardRevision ?? 0;
        const descriptor = await port.generation(target(id));
        expect(descriptor).toMatchObject({
          ok: true,
          value: {
            stream: {
              status: 'settled',
              cardState: { cardRevision: baseline },
            },
            result: { outcome: request.outcome },
          },
        });
        expect(required).toBeGreaterThan(baseline);
        expect(broker['cardPublications'].watermark(target(id))).toBe(baseline);
        expect(read).toHaveBeenCalled();
        expect(settle).toHaveBeenCalledTimes(mode === 'adopted' ? 0 : 1);
        let covered = false;
        const barrier = broker.flushCardPublication(target(id)).then(() => {
          covered = true;
        });
        await flushBroker();
        expect(covered).toBe(false);
        release?.();
        await barrier;
        expect(await port.generation(target(id))).toMatchObject({
          ok: true,
          value: {
            stream: {
              cardState: { cardRevision: required, workspaceDiscarded: true },
            },
            result: { outcome: request.outcome },
          },
        });
      } finally {
        release?.();
        await broker.close();
      }
    },
  );

  it('republishes on fresh initialization twice, rebasing an older record without a pair', async () => {
    const { broker, port, storage, id } = await fixture();
    await broker['update'](id, (record) => ({
      ...record,
      state: { ...record.state, status: 'completed', finishedAt: 200 },
    }));
    await broker.flushCardPublication(target(id));
    await broker.close();
    const prior = streamRecord(storage, id);
    const revision = prior.cardPublication?.cardRevision ?? 0;
    const { cardPublication: ignored, ...old } = prior;
    void ignored;
    storage.records.set(id, { ...old, workspaceDiscarded: true });
    const open = jest.spyOn(port, 'open');
    for (let pass = 0; pass < 2; pass++) {
      const reopened = createBrokerHarness(
        { testOnlyStreamGeneration: true, transcriptPort: port },
        storage,
      );
      try {
        await reopened.broker.initialize();
        // Initialization schedules rebase outside its repair chain.
        await flushBroker();
        await reopened.broker.flushCardPublication(target(id));
        const current = streamRecord(storage, id);
        expect(current.cardPublication?.cardRevision).toBe(revision + 1);
        expect(await port.generation(target(id))).toMatchObject({
          ok: true,
          value: {
            stream: {
              status: 'settled',
              cardState: {
                cardRevision: revision + 1,
                workspaceDiscarded: true,
              },
            },
          },
        });
        expect(reopened.runner.starts).toHaveLength(0);
      } finally {
        await reopened.broker.close();
      }
    }
    expect(open).not.toHaveBeenCalled();
  });

  it('latches two queued prompt amendments in their admission and captures the continuation registration', async () => {
    const { broker, runner, storage, port, id } = await fixture({
      capacity: 1,
      resolveRoute: () =>
        Promise.resolve({
          ok: true,
          value: routeFixture({ capabilities: ['read', 'progress', 'resume'] }),
        }),
    });
    try {
      await runner.sink?.({
        delegationId: id,
        runGeneration: 1,
        sequence: 2,
        occurredAt: 200,
        event: { type: 'terminal', status: 'completed', finalText: 'answer' },
      });
      const busy = await broker.spawn(
        { ...rootParent, toolCallId: 'occupant' },
        baseTask,
      );
      if (!busy.ok) throw new Error('Expected occupant');
      await waitForLaunch(runner, busy.value.delegationId);
      const registered = jest.spyOn(port, 'registerGeneration');
      const continued = await broker.manage(
        { ...rootParent, toolCallId: 'continue' },
        { delegationId: id, operation: 'follow_up', message: 'queued task' },
      );
      expect(continued.ok).toBe(true);
      for (
        let index = 0;
        index < 20 && streamRecord(storage, id).state.runGeneration !== 2;
        index++
      )
        await flushBroker();
      expect(streamRecord(storage, id)).toMatchObject({
        state: { runGeneration: 2 },
        registration: { origin: { kind: 'follow_up' } },
      });
      const before =
        streamRecord(storage, id).cardPublication?.cardRevision ?? 0;
      for (const [index, text] of Array.from(
        ['first amendment', 'second amendment'].entries(),
      )) {
        expect(
          await broker.deliverHostMessage(id, text, randomUUID()),
        ).toMatchObject({ ok: true });
        const current = streamRecord(storage, id);
        expect(current.cardPublication).toMatchObject({
          cardRevision: before + index + 1,
          promptAmended: true,
        });
        expect(materializeCardDraft(current)?.prompt).toBe(
          index === 0
            ? 'queued task\n\nfirst amendment'
            : 'queued task\n\nfirst amendment\n\nsecond amendment',
        );
      }
      await broker.flushCardPublication(target(id, 2));
      const final = streamRecord(storage, id);
      expect(await port.generation(target(id, 2))).toMatchObject({
        ok: true,
        value: {
          stream: {
            cardState: {
              cardRevision: before + 2,
              prompt: 'queued task\n\nfirst amendment\n\nsecond amendment',
            },
          },
        },
      });
      expect(
        registered.mock.calls.some(
          ([entry]) =>
            entry.delegationId === id &&
            entry.runGeneration === 2 &&
            entry.origin.kind === 'follow_up' &&
            entry.origin.authoredItemId ===
              final.registration.origin.authoredItemId,
        ),
      ).toBe(true);
    } finally {
      await broker.close();
    }
  });

  it('leaves legacy projection bytes and port I/O untouched', async () => {
    const port = new InMemoryDelegationTranscriptPort({
      owns: (): boolean => true,
    });
    const register = jest.spyOn(port, 'registerGeneration');
    const update = jest.spyOn(port, 'updateCardState');
    const { broker, runner } = createBrokerHarness({ transcriptPort: port });
    try {
      await broker.initialize();
      const spawned = await broker.spawn(rootParent, baseTask);
      if (!spawned.ok) throw new Error('Expected legacy admission');
      await waitForLaunch(runner, spawned.value.delegationId);
      const transcript = (await broker.transcripts(rootParent))[0];
      expect(transcript).not.toHaveProperty('transcriptStore');
      expect(register).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
    } finally {
      await broker.close();
    }
  });

  it.each([
    'never dispatched',
    'native terminal',
    'unknown dispatch',
    'accepted stop',
  ] as const)(
    'republishes after startup repairs %s without launching',
    async (mode) => {
      const {
        broker,
        runner,
        storage,
        port,
        id: runningId,
      } = await fixture({ capacity: 1 });
      let id = runningId;
      let release: (() => void) | undefined;
      let stopping: Promise<unknown> | undefined;
      if (mode === 'never dispatched') {
        const queued = await broker.spawn(
          { ...rootParent, toolCallId: 'never-dispatched' },
          baseTask,
        );
        if (!queued.ok) throw new Error('Expected queued admission');
        id = queued.value.delegationId;
      } else if (mode === 'accepted stop') {
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        jest.spyOn(runner, 'stop').mockImplementation(async () => {
          await held;
          return { stopped: true };
        });
        stopping = broker.requestStop(rootParent, id);
        await flushBroker();
        expect(streamRecord(storage, id).receipts.activeStop).toBeDefined();
      }
      await broker.flushCardPublication(target(id));
      const saved = structuredClone(streamRecord(storage, id));
      const reopenedPort = port.reopen();
      release?.();
      await stopping;
      await broker.close();
      storage.records.clear();
      storage.records.set(id, { ...saved, workspaceDiscarded: true });
      const notifications: string[] = [];
      const reopened = createBrokerHarness(
        {
          testOnlyStreamGeneration: true,
          transcriptPort: reopenedPort,
          reconcileNative: () =>
            Promise.resolve(
              mode === 'native terminal'
                ? {
                    status: 'terminal',
                    nativeSessionId: 'native-card-session',
                    terminalStatus: 'completed',
                  }
                : { status: 'unknown' },
            ),
          onSettled: (_parent, _id, result) => {
            notifications.push(result.status);
            return Promise.resolve();
          },
        },
        storage,
      );
      try {
        await reopened.broker.initialize();
        await reopened.broker.flushCardPublication(target(id));
        const expected =
          mode === 'native terminal'
            ? 'completed'
            : mode === 'unknown dispatch'
              ? 'interrupted'
              : 'cancelled';
        const current = streamRecord(storage, id);
        expect(current.latestResult).toMatchObject({
          runGeneration: 1,
          status: expected,
          notified: true,
        });
        expect(current.cardPublication?.cardRevision).toBeGreaterThan(
          saved.cardPublication?.cardRevision ?? 0,
        );
        expect(await reopenedPort.generation(target(id))).toMatchObject({
          ok: true,
          value: {
            stream: {
              status: 'settled',
              cardState: {
                cardRevision: current.cardPublication?.cardRevision,
                workspaceDiscarded: true,
                status: 'running',
                outputTruncated: false,
              },
            },
            result: { outcome: { status: expected }, answer: { kind: 'none' } },
          },
        });
        expect(notifications).toEqual([expected]);
        expect(reopened.runner.starts).toHaveLength(0);
      } finally {
        await reopened.broker.close();
      }
    },
  );

  it('retires an older in-flight draft when settle wins and still publishes the latest post-settle metadata', async () => {
    const { broker, storage, port, id } = await fixture();
    await broker.flushCardPublication(target(id));
    const original = port.updateCardState.bind(port);
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const update = jest
      .spyOn(port, 'updateCardState')
      .mockImplementation(async (request) => {
        await held;
        return original(request);
      });
    try {
      await metadata(broker, id, true);
      await flushBroker();
      const inFlight =
        streamRecord(storage, id).cardPublication?.cardRevision ?? 0;
      await metadata(broker, id, false);
      await broker['update'](id, (record) => ({
        ...record,
        state: { ...record.state, status: 'completed', finishedAt: 200 },
      }));
      expect(await port.generation(target(id))).toMatchObject({
        ok: true,
        value: {
          stream: {
            status: 'settled',
            cardState: { cardRevision: inFlight + 1 },
          },
        },
      });
      await metadata(broker, id, true);
      const latest = streamRecord(storage, id).cardPublication?.cardRevision;
      expect(latest).toBe(inFlight + 2);
      release?.();
      await broker.flushCardPublication(target(id));
      expect(
        update.mock.calls.map(([request]) => request.cardRevision),
      ).toEqual([inFlight, latest]);
      expect(broker['cardPublications'].watermark(target(id))).toBe(latest);
      expect(await port.generation(target(id))).toMatchObject({
        ok: true,
        value: {
          stream: {
            cardState: {
              cardRevision: latest,
              status: 'running',
              workspaceDiscarded: true,
            },
          },
          result: { outcome: { status: 'completed', finishedAt: 200 } },
        },
      });
    } finally {
      release?.();
      await broker.close();
    }
  });

  it('prepares a missing publication pair before replaying an older startup settlement intent', async () => {
    const { broker, storage, port, id } = await fixture();
    await broker.flushCardPublication(target(id));
    const refused = jest.spyOn(port, 'settle').mockResolvedValue({
      ok: false,
      error: {
        code: 'storage_failure',
        message: 'retry later',
        retryable: true,
      },
    });
    await expect(
      broker['update'](id, (record) => ({
        ...record,
        state: { ...record.state, status: 'completed', finishedAt: 200 },
      })),
    ).rejects.toThrow('Settlement pending');
    const saved = streamRecord(storage, id);
    expect(saved.settling).toBeDefined();
    await broker.flushCardPublication(target(id));
    const restoredPort = port.reopen();
    refused.mockRestore();
    await broker.close();
    const { cardPublication: ignored, ...old } = saved;
    void ignored;
    storage.records.set(id, old);
    const settle = jest.spyOn(restoredPort, 'settle');
    const reopened = createBrokerHarness(
      { transcriptPort: restoredPort, testOnlyStreamGeneration: true },
      storage,
    );
    try {
      await reopened.broker.initialize();
      await reopened.broker.flushCardPublication(target(id));
      const current = streamRecord(storage, id);
      expect(settle.mock.calls[0]?.[0]).toMatchObject({
        cardRevision: current.cardPublication?.cardRevision,
        cardDraft: {
          version: 2,
          status: 'running',
          outputTruncated: false,
          nativeSessionId: 'native-card-session',
        },
      });
      expect(current.latestResult?.status).toBe('completed');
      expect(reopened.runner.starts).toHaveLength(0);
    } finally {
      await reopened.broker.close();
    }
  });
});
