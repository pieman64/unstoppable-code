import { createHash } from 'node:crypto';
import type {
  AgentDelegationBroker,
  AgentDelegationBrokerOptions,
  StoredDelegation,
} from '../broker';
import { InMemoryDelegationTranscriptPort } from '../in-memory-transcript-port';
import type { StoredDelegationV3 } from '../record-v3';
import type { DelegationTranscriptReceiptIdentity } from '../transcript-port';
import {
  baseTask,
  type BrokerHarness,
  createBrokerHarness,
  flushBroker,
  MemoryDelegationStorage,
  rootParent,
  waitForLaunch,
} from './broker-harness';
import { routeFixture } from './fixtures';

type TimedValue<Value> =
  | { readonly kind: 'settled'; readonly value: Value }
  | { readonly kind: 'timeout' };

interface StreamHarness extends BrokerHarness {
  readonly port: InMemoryDelegationTranscriptPort;
  readonly storage: MemoryDelegationStorage;
  readonly id: string;
}

interface V3PreparationSpy {
  calls(): number;
  restore(): void;
}

function deferred(): { readonly promise: Promise<void>; release(): void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, release: () => resolve() };
}

function resolveWithin<Value>(
  promise: Promise<Value>,
  timeoutMs = 1000,
): Promise<TimedValue<Value>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<TimedValue<Value>>((resolve) => {
    timer = setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs);
  });
  const settled = promise.then(
    (value): TimedValue<Value> => ({ kind: 'settled', value }),
  );
  return Promise.race([settled, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

async function createStreamHarness(
  options: Partial<AgentDelegationBrokerOptions> = {},
): Promise<StreamHarness> {
  const port = new InMemoryDelegationTranscriptPort({
    owns: (): boolean => true,
    ownsChat: (): boolean => true,
  });
  const storage = new MemoryDelegationStorage();
  const harness = createBrokerHarness(
    {
      testOnlyStreamGeneration: true,
      transcriptPort: port,
      ...options,
    },
    storage,
  );
  await harness.broker.initialize();
  const spawned = await harness.broker.spawn(rootParent, baseTask);
  if (!spawned.ok) throw new Error('Expected a stream delegation');
  await waitForLaunch(harness.runner, spawned.value.delegationId);
  return { ...harness, port, storage, id: spawned.value.delegationId };
}

function streamRecord(
  storage: MemoryDelegationStorage,
  id: string,
): StoredDelegationV3 {
  const record = storage.records.get(id);
  if (!record || record.version !== 3)
    throw new Error('Expected a stored v3 record');
  return record;
}

function withLaterDeadline(record: StoredDelegation): StoredDelegation {
  return {
    ...record,
    deadlineAt: (record.deadlineAt ?? record.createdAt + 100_000) + 1,
  };
}

function watchV3Preparation(broker: AgentDelegationBroker): V3PreparationSpy {
  const original = broker['prepareV3Update'].bind(broker);
  let calls = 0;
  broker['prepareV3Update'] = (current, candidate): StoredDelegationV3 => {
    calls += 1;
    return original(current, candidate);
  };
  return {
    calls: (): number => calls,
    restore: (): void => {
      broker['prepareV3Update'] = original;
    },
  };
}

async function waitForCompletedStop(
  storage: MemoryDelegationStorage,
  id: string,
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const record = storage.records.get(id);
    if (
      record?.version === 3 &&
      record.receipts.stopFence?.status === 'completed'
    )
      return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('The stream stop did not complete');
}

const resumable: Pick<AgentDelegationBrokerOptions, 'resolveRoute'> = {
  resolveRoute: () =>
    Promise.resolve({
      ok: true,
      value: routeFixture({
        capabilities: ['read', 'progress', 'resume'],
      }),
    }),
};

describe('v3 receipt concurrency and async record transactions', () => {
  it('commits a helper-prepared candidate without preparing it twice', async () => {
    const harness = await createStreamHarness();
    const preparation = watchV3Preparation(harness.broker);
    const commit = jest.spyOn(harness.storage, 'commit');
    try {
      const current = streamRecord(harness.storage, harness.id);
      const updated = await harness.broker['updateAsync'](
        harness.id,
        (current) => {
          const candidate = withLaterDeadline(current);
          return Promise.resolve(
            harness.broker['prepareAsyncCandidate'](current, candidate),
          );
        },
      );
      expect(preparation.calls()).toBe(1);
      expect(commit).toHaveBeenCalledTimes(1);
      expect(updated.version).toBe(3);
      expect(streamRecord(harness.storage, harness.id).deadlineAt).toBe(
        (current.deadlineAt ?? current.createdAt + 100_000) + 1,
      );
    } finally {
      preparation.restore();
      await harness.broker.close();
    }
  });

  it('prepares and validates an unprepared async return exactly once', async () => {
    const harness = await createStreamHarness();
    const preparation = watchV3Preparation(harness.broker);
    const commit = jest.spyOn(harness.storage, 'commit');
    try {
      const current = streamRecord(harness.storage, harness.id);
      const updated = await harness.broker['updateAsync'](
        harness.id,
        (record) => Promise.resolve(withLaterDeadline(record)),
      );
      expect(preparation.calls()).toBe(1);
      expect(commit).toHaveBeenCalledTimes(1);
      expect(updated.version).toBe(3);
      expect(streamRecord(harness.storage, harness.id).deadlineAt).toBe(
        (current.deadlineAt ?? current.createdAt + 100_000) + 1,
      );
    } finally {
      preparation.restore();
      await harness.broker.close();
    }
  });

  it('rejects a prepared object mutated after validation before commit', async () => {
    const harness = await createStreamHarness();
    const preparation = watchV3Preparation(harness.broker);
    const commit = jest.spyOn(harness.storage, 'commit');
    try {
      const update = harness.broker['updateAsync'](harness.id, (current) => {
        const prepared = harness.broker['prepareAsyncCandidate'](
          current,
          withLaterDeadline(current),
        );
        if (prepared.version !== 3) throw new Error('Expected a v3 candidate');
        Object.assign(prepared, {
          deadlineAt: (prepared.deadlineAt ?? prepared.createdAt + 100_000) + 1,
        });
        return Promise.resolve(prepared);
      });
      await expect(update).rejects.toThrow(
        'Record transaction changed after validation',
      );
      expect(preparation.calls()).toBe(1);
      expect(commit).not.toHaveBeenCalled();
    } finally {
      preparation.restore();
      await harness.broker.close();
    }
  });

  it('rejects a replacement object after helper validation before commit', async () => {
    const harness = await createStreamHarness();
    const preparation = watchV3Preparation(harness.broker);
    const commit = jest.spyOn(harness.storage, 'commit');
    try {
      const update = harness.broker['updateAsync'](harness.id, (current) => {
        const prepared = harness.broker['prepareAsyncCandidate'](
          current,
          withLaterDeadline(current),
        );
        if (prepared.version !== 3) throw new Error('Expected a v3 candidate');
        const replacement: StoredDelegation = {
          ...prepared,
          deadlineAt: (prepared.deadlineAt ?? prepared.createdAt + 100_000) + 1,
        };
        return Promise.resolve(replacement);
      });
      await expect(update).rejects.toThrow(
        'Record transaction changed after validation',
      );
      expect(preparation.calls()).toBe(1);
      expect(commit).not.toHaveBeenCalled();
    } finally {
      preparation.restore();
      await harness.broker.close();
    }
  });

  it('serializes async transactions with update on the same record chain', async () => {
    const harness = await createStreamHarness();
    const callbackEntered = deferred();
    const releasePrepare = deferred();
    const starting = streamRecord(harness.storage, harness.id);
    let observedActivity: number | undefined;
    try {
      const transaction = harness.broker['updateAsync'](
        harness.id,
        async (current) => {
          callbackEntered.release();
          await releasePrepare.promise;
          return withLaterDeadline(current);
        },
      );
      await callbackEntered.promise;
      const queuedUpdate = harness.broker['update'](harness.id, (current) => {
        if (current.version !== 3) throw new Error('Expected a v3 record');
        observedActivity = current.deadlineAt;
        return withLaterDeadline(current);
      });
      expect(observedActivity).toBeUndefined();
      releasePrepare.release();
      await transaction;
      await queuedUpdate;
      expect(observedActivity).toBe(
        (starting.deadlineAt ?? starting.createdAt + 100_000) + 1,
      );
      expect(streamRecord(harness.storage, harness.id).deadlineAt).toBe(
        (starting.deadlineAt ?? starting.createdAt + 100_000) + 2,
      );
    } finally {
      releasePrepare.release();
      await harness.broker.close();
    }
  });

  it('rejects same-key nesting immediately and releases the lock after throws', async () => {
    const harness = await createStreamHarness();
    const lock = harness.broker['receiptLock'];
    const identity: DelegationTranscriptReceiptIdentity = {
      chatId: rootParent.chatId,
      receiptKind: 'command',
      key: 'a'.repeat(64),
    };
    try {
      await expect(
        lock.run(identity, () =>
          lock.run(identity, () => Promise.resolve('nested')),
        ),
      ).rejects.toThrow('Receipt lock defect: non-reentrant identity');
      await expect(
        lock.run(identity, () => Promise.reject(new Error('expected throw'))),
      ).rejects.toThrow('expected throw');
      await expect(
        lock.run(identity, () => Promise.resolve('released')),
      ).resolves.toBe('released');
    } finally {
      await harness.broker.close();
    }
  });

  it('serializes one command identity across two delegations in the chat', async () => {
    const harness = await createStreamHarness();
    const secondSpawn = await harness.broker.spawn(
      { ...rootParent, toolCallId: 'second-spawn' },
      baseTask,
    );
    if (!secondSpawn.ok) throw new Error('Expected a second stream delegation');
    await waitForLaunch(harness.runner, secondSpawn.value.delegationId);
    const lookupEntered = deferred();
    const releaseLookup = deferred();
    const originalReceipt = harness.port.receipt.bind(harness.port);
    let reads = 0;
    jest.spyOn(harness.port, 'receipt').mockImplementation(async (identity) => {
      reads += 1;
      if (reads === 1) {
        lookupEntered.release();
        await releaseLookup.promise;
      }
      return originalReceipt(identity);
    });
    const parent = { ...rootParent, toolCallId: 'same-command-key' };
    const firstInput = {
      delegationId: harness.id,
      operation: 'steer',
      message: 'continue',
    };
    const secondInput = {
      ...firstInput,
      delegationId: secondSpawn.value.delegationId,
    };
    let second: ReturnType<AgentDelegationBroker['manage']> | undefined;
    try {
      const first = harness.broker.manage(parent, firstInput);
      await lookupEntered.promise;
      expect(harness.broker['controlCalls'].size).toBe(1);
      harness.broker['controlCalls'].clear();
      second = harness.broker.manage(parent, secondInput);
      await flushBroker();
      expect(reads).toBe(1);
      releaseLookup.release();
      const [firstResult, secondResult] = await Promise.all([first, second]);
      expect(firstResult.ok).toBe(true);
      expect(secondResult).toMatchObject({
        ok: false,
        error: { code: 'invalid_request' },
      });
      expect(harness.runner.steeringRequests).toHaveLength(1);
      expect(harness.broker['controlCalls'].size).toBe(0);
    } finally {
      releaseLookup.release();
      if (second) await second.catch(() => undefined);
      await harness.broker.close();
    }
  });

  it('releases stop admission ownership before dispatching the native stop', async () => {
    const harness = await createStreamHarness();
    const stopEntered = deferred();
    const releaseStop = deferred();
    const parent = { ...rootParent, toolCallId: 'stop-lock-release' };
    jest.spyOn(harness.runner, 'stop').mockImplementation(async (handle) => {
      harness.runner.stopped.push(handle.runId);
      stopEntered.release();
      await releaseStop.promise;
      return { stopped: true };
    });
    let replay: ReturnType<AgentDelegationBroker['requestStop']> | undefined;
    try {
      const accepted = await harness.broker.requestStop(parent, harness.id);
      expect(accepted.ok).toBe(true);
      const started = await resolveWithin(stopEntered.promise);
      expect(started.kind).toBe('settled');
      replay = harness.broker.requestStop(parent, harness.id);
      const result = await resolveWithin(replay);
      expect(result.kind).toBe('settled');
      if (result.kind === 'settled') expect(result.value.ok).toBe(true);
    } finally {
      releaseStop.release();
      if (replay) await replay.catch(() => undefined);
      await harness.broker.close();
    }
  });

  it('releases receipt ownership before launching a resumed generation', async () => {
    const harness = await createStreamHarness(resumable);
    const initialSink = harness.runner.sinks.get(harness.id);
    if (!initialSink) throw new Error('Expected initial runner sink');
    await initialSink({
      delegationId: harness.id,
      runGeneration: 1,
      sequence: 1,
      occurredAt: Date.now(),
      event: { type: 'started', nativeSessionId: 'native' },
    });
    const initialStop = await harness.broker.requestStop(
      { ...rootParent, toolCallId: 'initial-stop' },
      harness.id,
    );
    expect(initialStop.ok).toBe(true);
    await waitForCompletedStop(harness.storage, harness.id);

    const launchEntered = deferred();
    const releaseLaunch = deferred();
    const resumeParent = { ...rootParent, toolCallId: 'resume-launch' };
    const resumeIdentity: DelegationTranscriptReceiptIdentity = {
      chatId: resumeParent.chatId,
      receiptKind: 'command',
      key: createHash('sha256')
        .update(
          JSON.stringify([
            resumeParent.harnessId,
            resumeParent.projectId,
            resumeParent.worktreeId,
            resumeParent.chatId,
            resumeParent.turnId,
            resumeParent.toolCallId,
            resumeParent.parentDelegationId,
            resumeParent.parentRunGeneration,
          ]),
        )
        .digest('hex'),
    };
    const originalStart = harness.runner.start.bind(harness.runner);
    jest
      .spyOn(harness.runner, 'start')
      .mockImplementation(async (request, sink) => {
        if (request.runGeneration === 2) {
          await harness.broker['receiptLock'].run(resumeIdentity, async () => {
            launchEntered.release();
            await releaseLaunch.promise;
          });
        }
        return originalStart(request, sink);
      });
    const stopLookupEntered = deferred();
    const originalReceipt = harness.port.receipt.bind(harness.port);
    jest.spyOn(harness.port, 'receipt').mockImplementation(async (identity) => {
      if (identity.receiptKind === 'stop') stopLookupEntered.release();
      return originalReceipt(identity);
    });
    let resume: ReturnType<AgentDelegationBroker['manage']> | undefined;
    let stop: ReturnType<AgentDelegationBroker['requestStop']> | undefined;
    try {
      resume = harness.broker.manage(resumeParent, {
        delegationId: harness.id,
        operation: 'resume',
        message: 'continue',
      });
      const launched = await resolveWithin(launchEntered.promise);
      expect(launched.kind).toBe('settled');
      stop = harness.broker.requestStop(
        { ...rootParent, toolCallId: 'stop-during-launch' },
        harness.id,
      );
      const lookedUp = await resolveWithin(stopLookupEntered.promise);
      expect(lookedUp.kind).toBe('settled');
      releaseLaunch.release();
      const [resumeResult, stopResult] = await Promise.all([resume, stop]);
      expect(resumeResult.ok).toBe(true);
      expect(stopResult.ok).toBe(true);
    } finally {
      releaseLaunch.release();
      if (resume) await resume.catch(() => undefined);
      if (stop) await stop.catch(() => undefined);
      await harness.broker.close();
    }
  });

  it('cleans settled stream control calls and keeps the legacy 4096 ceiling', async () => {
    const harness = await createStreamHarness();
    const lookupEntered = deferred();
    const releaseLookup = deferred();
    let reads = 0;
    const receipt = jest
      .spyOn(harness.port, 'receipt')
      .mockImplementation(async () => {
        reads += 1;
        if (reads === 1) {
          lookupEntered.release();
          await releaseLookup.promise;
        }
        return {
          ok: false,
          error: {
            code: 'storage_failure',
            message: 'Receipt lookup unavailable',
            retryable: true,
          },
        };
      });
    const input = { delegationId: harness.id, operation: 'apply' };
    const parent = { ...rootParent, toolCallId: 'stream-in-flight' };
    try {
      const first = harness.broker.manage(parent, input);
      await lookupEntered.promise;
      expect(harness.broker['controlCalls'].size).toBe(1);
      const duplicate = harness.broker.manage(parent, input);
      expect(duplicate).toBe(first);
      releaseLookup.release();
      const firstResult = await first;
      expect(firstResult).toMatchObject({
        ok: false,
        error: { retryable: true },
      });
      expect(harness.broker['controlCalls'].size).toBe(0);
      const settledRetry = harness.broker.manage(parent, input);
      expect(settledRetry).not.toBe(first);
      await settledRetry;
      expect(receipt).toHaveBeenCalledTimes(2);
      expect(harness.broker['controlCalls'].size).toBe(0);

      for (let index = 0; index < 4100; index += 1) {
        const result = await harness.broker.manage(
          { ...rootParent, toolCallId: `stream-capacity-${index}` },
          input,
        );
        expect(result).toMatchObject({ ok: false, error: { retryable: true } });
      }
      expect(receipt).toHaveBeenCalledTimes(4102);
      expect(harness.broker['controlCalls'].size).toBe(0);
    } finally {
      releaseLookup.release();
      await harness.broker.close();
    }

    const legacy = createBrokerHarness({}, new MemoryDelegationStorage());
    await legacy.broker.initialize();
    try {
      for (let index = 0; index < 4096; index += 1) {
        await legacy.broker.manage(
          { ...rootParent, toolCallId: `legacy-capacity-${index}` },
          { delegationId: 'missing-target', operation: 'apply' },
        );
      }
      expect(legacy.broker['controlCalls'].size).toBe(4096);
      expect(
        await legacy.broker.manage(
          { ...rootParent, toolCallId: 'legacy-capacity-overflow' },
          { delegationId: 'missing-target', operation: 'apply' },
        ),
      ).toMatchObject({
        ok: false,
        error: {
          code: 'capacity_exceeded',
          message: 'The command admission limit was reached.',
          retryable: false,
        },
      });
      expect(legacy.broker['controlCalls'].size).toBe(4096);
    } finally {
      await legacy.broker.close();
    }
  });
});
