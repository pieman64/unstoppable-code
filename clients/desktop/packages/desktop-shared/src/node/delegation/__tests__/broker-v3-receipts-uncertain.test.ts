import { createHash, randomUUID } from 'node:crypto';
import { InMemoryDelegationTranscriptPort } from '../in-memory-transcript-port';
import type { DelegationTranscriptReceiptEntry } from '../transcript-port';
import {
  decodeStoredDelegationV3,
  type StoredDelegationV3,
} from '../record-v3';
import { fitDelegationReceiptAck } from '../receipt-reply';
import type { StoredDelegation, AgentDelegationBrokerOptions } from '../broker';
import { routeFixture } from './fixtures';
import {
  baseTask,
  createBrokerHarness,
  MemoryDelegationStorage,
  rootParent,
  waitForLaunch,
  flushBroker,
} from './broker-harness';

class CrashPort extends InMemoryDelegationTranscriptPort {
  readonly journal: DelegationTranscriptReceiptEntry[] = [];
  constructor() {
    super({ owns: (): boolean => true, ownsChat: (): boolean => true });
  }
  override async appendReceipt(
    value: DelegationTranscriptReceiptEntry,
  ): ReturnType<InMemoryDelegationTranscriptPort['appendReceipt']> {
    const result = await super.appendReceipt(value);
    if (result.ok) this.journal.push(structuredClone(value));
    return result;
  }
  async snapshot(): Promise<CrashPort> {
    const port = new CrashPort();
    for (const [key, value] of Array.from(this.streams))
      port.streams.set(key, structuredClone(value));
    for (const [key, value] of Array.from(this.registries))
      port.registries.set(key, structuredClone(value));
    for (const [key, value] of Array.from(this.answers))
      port.answers.set(key, { ...value, bytes: Buffer.from(value.bytes) });
    for (const value of this.journal) {
      const result = await port.appendReceipt(value);
      if (!result.ok) throw new Error('Snapshot receipt conflict');
    }
    return port;
  }
}
class FaultStorage extends MemoryDelegationStorage {
  commits = 0;
  fault?: 'before' | 'after';
  attempted?: StoredDelegationV3;
  override async commit(record: StoredDelegation): Promise<void> {
    this.commits++;
    if (record.version === 3)
      decodeStoredDelegationV3(JSON.parse(JSON.stringify(record)));
    const fault = this.fault;
    this.fault = undefined;
    if (fault && record.version === 3) this.attempted = structuredClone(record);
    if (fault === 'before')
      throw new Error('Uncertain storage rejection before rename');
    await super.commit(record);
    if (fault === 'after')
      throw new Error('Uncertain storage rejection after rename');
  }
  snapshot(): FaultStorage {
    const storage = new FaultStorage();
    for (const [id, record] of Array.from(this.records))
      storage.records.set(id, structuredClone(record));
    return storage;
  }
}
function read(
  storage: MemoryDelegationStorage,
  id: string,
): StoredDelegationV3 {
  const record = storage.records.get(id);
  if (record?.version !== 3) throw new Error('Expected stream record');
  return record;
}
async function fixture(
  overrides: Partial<AgentDelegationBrokerOptions> = {},
  storage = new FaultStorage(),
): Promise<
  ReturnType<typeof createBrokerHarness> & {
    storage: FaultStorage;
    port: CrashPort;
    id: string;
  }
> {
  const port = new CrashPort();
  const f = createBrokerHarness(
    {
      ...overrides,
      testOnlyStreamGeneration: true,
      transcriptPort: port,
      resolveRoute: () =>
        Promise.resolve({
          ok: true,
          value: routeFixture({ capabilities: ['read', 'progress', 'resume'] }),
        }),
    },
    storage,
  );
  await f.broker.initialize();
  const spawn = await f.broker.spawn(rootParent, baseTask);
  if (!spawn.ok) throw new Error('Expected spawn');
  const id = spawn.value.delegationId;
  await waitForLaunch(f.runner, id);
  await f.runner.sink?.({
    delegationId: id,
    runGeneration: 1,
    sequence: 1,
    occurredAt: Date.now(),
    event: { type: 'started', nativeSessionId: 'uncertain-native' },
  });
  return { ...f, storage, port, id };
}
const parent = (key: string): typeof rootParent => ({
  ...rootParent,
  toolCallId: key,
});
const steer = (
  id: string,
): { delegationId: string; operation: 'steer'; message: string } => ({
  delegationId: id,
  operation: 'steer',
  message: 'once',
});
async function fill(f: Awaited<ReturnType<typeof fixture>>): Promise<void> {
  await f.broker['updateAsync'](f.id, (current) => {
    if (current.version !== 3) throw new Error('Expected stream');
    const commandReceipts = Array.from({ length: 64 }, (_, index) => {
      const key = createHash('sha256').update(`old-${index}`).digest('hex');
      const fitted = fitDelegationReceiptAck(
        {
          chatId: rootParent.chatId,
          delegationId: f.id,
          receiptKind: 'command',
          key,
          requestHash: key,
          operationId: randomUUID(),
          operation: 'steer',
          runGeneration: 1,
          admittedAt: index + 1,
        },
        {
          ok: true,
          outcome: 'completed',
          snapshot: {
            delegationId: f.id,
            status: 'running',
            outputTruncated: false,
          },
        },
      );
      if (
        !fitted.ok ||
        fitted.entry.receiptKind !== 'command' ||
        fitted.entry.reply.kind !== 'command'
      )
        throw new Error('Expected fitted command');
      return {
        ...fitted.entry,
        receiptKind: fitted.entry.receiptKind,
        reply: fitted.entry.reply,
      };
    });
    return Promise.resolve({
      ...current,
      receipts: { ...current.receipts, commandReceipts },
    });
  });
}

const unavailable = { ok: false, error: { retryable: true } };
describe('stream receipt uncertain record commits', () => {
  afterEach(() => jest.restoreAllMocks());
  it.each(['before', 'after'] as const)(
    'quarantines %s-write rejection after rollover and restart alone decides absence',
    async (fault) => {
      const f = await fixture();
      let reopened: ReturnType<typeof createBrokerHarness> | undefined;
      try {
        await fill(f);
        const old = structuredClone(
          read(f.storage, f.id).receipts.commandReceipts[0],
        );
        f.storage.fault = fault;
        await expect(
          f.broker.manage(parent('uncertain'), steer(f.id)),
        ).resolves.toMatchObject(unavailable);
        const attempted = f.storage.attempted;
        if (!attempted) throw new Error('Expected attempted candidate');
        const fresh = attempted.receipts.commandReceipts.at(-1);
        expect(fresh?.reply.ack).toMatchObject({
          ok: true,
          outcome: 'accepted',
        });
        const commits = f.storage.commits;
        const canonical = structuredClone(read(f.storage, f.id));
        await expect(
          f.broker.manage(parent('uncertain'), steer(f.id)),
        ).resolves.toMatchObject(unavailable);
        await expect(
          f.broker.manage(parent('new-key'), steer(f.id)),
        ).resolves.toMatchObject(unavailable);
        expect(f.storage.commits).toBe(commits);
        expect(f.runner.steeringRequests).toHaveLength(0);
        expect(read(f.storage, f.id)).toEqual(canonical);
        // Capture both canonical stores before any graceful cleanup.
        const crash = f.storage.snapshot();
        const port = await f.port.snapshot();
        expect(port.journal.find((entry) => entry.key === old?.key)).toEqual(
          old,
        );
        expect(
          canonical.receipts.commandReceipts.some(
            (entry) => entry.key === old?.key,
          ),
        ).toBe(fault === 'before');
        reopened = createBrokerHarness(
          { testOnlyStreamGeneration: true, transcriptPort: port },
          crash,
        );
        await reopened.broker.initialize();
        const recovered = read(crash, f.id);
        if (fault === 'after') {
          const receipt = recovered.receipts.commandReceipts.find(
            (entry) => entry.key === fresh?.key,
          );
          expect(receipt).toMatchObject({
            operationId: fresh?.operationId,
            reply: { ack: fresh?.reply.ack, final: { status: 'failed' } },
          });
          const stable = structuredClone(receipt);
          const secondCrash = crash.snapshot();
          const secondPort = await port.snapshot();
          await reopened.broker.close();
          reopened = createBrokerHarness(
            { testOnlyStreamGeneration: true, transcriptPort: secondPort },
            secondCrash,
          );
          await reopened.broker.initialize();
          expect(
            read(secondCrash, f.id).receipts.commandReceipts.find(
              (entry) => entry.key === fresh?.key,
            ),
          ).toEqual(stable);
        } else {
          expect(
            recovered.receipts.commandReceipts.some(
              (entry) => entry.key === fresh?.key,
            ),
          ).toBe(false);
          await expect(
            reopened.broker.manage(parent('uncertain'), steer(f.id)),
          ).resolves.not.toMatchObject(unavailable);
          expect(
            read(crash, f.id).receipts.commandReceipts.some(
              (entry) => entry.key === fresh?.key,
            ),
          ).toBe(true);
        }
        expect(reopened.runner.starts).toHaveLength(0);
      } finally {
        await reopened?.broker.close();
        await f.broker.close();
      }
    },
  );

  it('reserves the chat key before lock release, including another accessible target, without revealing identity', async () => {
    const f = await fixture();
    try {
      const second = await f.broker.spawn(parent('second-spawn'), baseTask);
      if (!second.ok) throw new Error('Expected second target');
      await waitForLaunch(f.runner, second.value.delegationId);
      const lookup = jest.spyOn(f.port, 'receipt');
      f.storage.fault = 'after';
      const first = f.broker.manage(parent('shared'), steer(f.id));
      const secondTry = f.broker.manage(
        parent('shared'),
        steer(second.value.delegationId),
      );
      const results = await Promise.all([first, secondTry]);
      expect(results).toMatchObject([unavailable, unavailable]);
      expect(JSON.stringify(results)).not.toContain(f.id);
      expect(lookup).toHaveBeenCalledTimes(1);
      expect(f.runner.steeringRequests).toHaveLength(0);
    } finally {
      await f.broker.close();
    }
  });

  it('blocks already queued runtime, transcript, completion, settlement and shutdown writes, aborting and releasing the running child', async () => {
    const f = await fixture();
    try {
      const native = f.runner.starts[0];
      const slot = f.broker['runs'].get(f.id)?.admission;
      expect(slot).toBeDefined();
      f.storage.fault = 'after';
      const commit = f.storage.commit.bind(f.storage);
      let queued: Promise<PromiseSettledResult<unknown>[]> | undefined;
      jest.spyOn(f.storage, 'commit').mockImplementation((record) => {
        if (f.storage.fault)
          queued = Promise.allSettled([
            f.broker['update'](f.id, (current) => {
              if (current.deadlineAt === undefined) {
                throw new Error('Expected active deadline');
              }
              return {
                ...current,
                deadlineAt: current.deadlineAt + 1,
              };
            }),
            f.runner.sink?.({
              delegationId: f.id,
              runGeneration: 1,
              sequence: 2,
              occurredAt: Date.now(),
              event: {
                type: 'transcript_receipt',
                streamRevision: 1,
                mutationKey: 'queued',
                items: [],
                replayed: false,
              },
            }),
            f.runner.sink?.({
              delegationId: f.id,
              runGeneration: 1,
              sequence: 3,
              occurredAt: Date.now(),
              event: {
                type: 'terminal',
                status: 'completed',
                finalText: 'queued completion',
              },
            }),
          ]);
        return commit(record);
      });
      await expect(
        f.broker.manage(parent('running-fault'), steer(f.id)),
      ).resolves.toMatchObject(unavailable);
      expect((await queued)?.[0]?.status).toBe('rejected');
      const canonical = structuredClone(read(f.storage, f.id));
      const commits = f.storage.commits;
      const crash = f.storage.snapshot();
      const port = await f.port.snapshot();
      await f.runner.sink?.({
        delegationId: f.id,
        runGeneration: 1,
        sequence: 2,
        occurredAt: Date.now(),
        event: {
          type: 'transcript_receipt',
          streamRevision: 1,
          mutationKey: 'late',
          items: [],
          replayed: false,
        },
      });
      await f.runner.sink?.({
        delegationId: f.id,
        runGeneration: 1,
        sequence: 3,
        occurredAt: Date.now(),
        event: {
          type: 'terminal',
          status: 'completed',
          finalText: 'late completion',
        },
      });
      await flushBroker();
      expect(native?.signal.aborted).toBe(true);
      expect(f.broker['runs'].has(f.id)).toBe(false);
      expect(f.broker['handoffs'].has(f.id)).toBe(false);
      expect(slot?.lease()).toBeUndefined();
      expect(f.runner.closed).toHaveLength(1);
      await expect(f.broker.close()).resolves.toBeUndefined();
      expect(f.storage.commits).toBe(commits);
      expect(read(f.storage, f.id)).toEqual(canonical);
      const recovered = createBrokerHarness(
        { testOnlyStreamGeneration: true, transcriptPort: port },
        crash,
      );
      try {
        await recovered.broker.initialize();
        expect(
          read(crash, f.id).receipts.commandReceipts.at(-1)?.reply.ack,
        ).toEqual(canonical.receipts.commandReceipts.at(-1)?.reply.ack);
        expect(recovered.runner.starts).toHaveLength(0);
      } finally {
        await recovered.broker.close();
      }
    } finally {
      await f.broker.close();
    }
  });

  it.each(['failure', 'first stop', 'alias'] as const)(
    'keeps an uncertain %s in its own recovery path without a failure receipt',
    async (producer) => {
      const f = await fixture();
      let reopened: ReturnType<typeof createBrokerHarness> | undefined;
      let release: (() => void) | undefined;
      try {
        if (producer === 'alias') {
          const gate = new Promise<void>((resolve) => {
            release = resolve;
          });
          jest.spyOn(f.runner, 'stop').mockImplementation(async () => {
            await gate;
            return { stopped: true };
          });
          await f.broker.requestStop(parent('first'), f.id);
          await flushBroker();
        }
        f.storage.fault = 'after';
        const operation = (): ReturnType<typeof f.broker.requestStop> =>
          producer === 'failure'
            ? f.broker.manage(parent('producer'), {
                delegationId: f.id,
                operation: 'resume',
                message: 'not terminal',
              })
            : f.broker.requestStop(parent('producer'), f.id);
        await expect(operation()).resolves.toMatchObject(unavailable);
        const canonical = structuredClone(read(f.storage, f.id));
        const crash = f.storage.snapshot();
        const port = await f.port.snapshot();
        await expect(operation()).resolves.toMatchObject(unavailable);
        expect(read(f.storage, f.id)).toEqual(canonical);
        reopened = createBrokerHarness(
          { testOnlyStreamGeneration: true, transcriptPort: port },
          crash,
        );
        await reopened.broker.initialize();
        if (producer === 'failure')
          expect(read(crash, f.id).receipts.commandReceipts).toEqual(
            canonical.receipts.commandReceipts,
          );
        else {
          expect(read(crash, f.id).receipts.commandReceipts).toHaveLength(0);
          expect(read(crash, f.id).receipts.activeStop).toBeUndefined();
          const replay = await reopened.broker.requestStop(
            parent('producer'),
            f.id,
          );
          expect(replay.ok).toBe(true);
          if (!replay.ok) throw new Error('Expected recovered stop replay');
          expect(['completed', 'failed']).toContain(
            replay.value.stopRequested?.status,
          );
        }
        expect(reopened.runner.stopped).toHaveLength(0);
      } finally {
        release?.();
        await reopened?.broker.close();
        await f.broker.close();
      }
    },
  );
});

describe('rollover crash cuts and local validation', () => {
  afterEach(() => jest.restoreAllMocks());
  it.each([
    'before append',
    'after append',
    'durable failed append',
    'after commit',
  ] as const)(
    'reopens both stores at %s without changing immutable receipt bytes',
    async (cut) => {
      const f = await fixture();
      let reopened: ReturnType<typeof createBrokerHarness> | undefined;
      try {
        await fill(f);
        const prior = structuredClone(read(f.storage, f.id));
        const old = prior.receipts.commandReceipts[0];
        const append = f.port.appendReceipt.bind(f.port);
        let crash: FaultStorage | undefined;
        let port: CrashPort | undefined;
        jest
          .spyOn(f.port, 'appendReceipt')
          .mockImplementation(async (value) => {
            if (cut !== 'before append') await append(value);
            crash = f.storage.snapshot();
            port = await f.port.snapshot();
            if (cut === 'after commit')
              return { ok: true, value: { entry: value, replayed: false } };
            return {
              ok: false,
              error: {
                code: 'storage_failure',
                message: cut,
                retryable: true,
              },
            };
          });
        if (cut === 'after commit') {
          // Snapshot in the commit itself: before dispatch or graceful close.
          let snapshotted = false;
          const commit = f.storage.commit.bind(f.storage);
          jest.spyOn(f.storage, 'commit').mockImplementation(async (record) => {
            await commit(record);
            if (
              !snapshotted &&
              record.version === 3 &&
              record.receipts.commandReceipts.at(-1)?.key !==
                prior.receipts.commandReceipts.at(-1)?.key &&
              !record.receipts.commandReceipts.at(-1)?.reply.final
            ) {
              snapshotted = true;
              crash = f.storage.snapshot();
              port = await f.port.snapshot();
            }
          });
        }
        const result = await f.broker.manage(parent(`cut-${cut}`), steer(f.id));
        if (cut === 'after commit') expect(result.ok).toBe(true);
        else {
          expect(result).toMatchObject(unavailable);
          expect(read(f.storage, f.id)).toEqual(prior);
          expect(f.runner.steeringRequests).toHaveLength(0);
        }
        if (!crash || !port)
          throw new Error('Expected crash snapshot before cleanup');
        const snapshot = read(crash, f.id);
        expect(
          snapshot.receipts.commandReceipts.some(
            (entry) => entry.key === old?.key,
          ),
        ).toBe(cut !== 'after commit');
        if (cut !== 'before append')
          expect(port.journal.find((entry) => entry.key === old?.key)).toEqual(
            old,
          );
        reopened = createBrokerHarness(
          { testOnlyStreamGeneration: true, transcriptPort: port },
          crash,
        );
        await reopened.broker.initialize();
        if (cut === 'after commit') {
          const fresh = snapshot.receipts.commandReceipts.at(-1);
          expect(
            read(crash, f.id).receipts.commandReceipts.at(-1),
          ).toMatchObject({
            operationId: fresh?.operationId,
            reply: { ack: fresh?.reply.ack, final: { status: 'failed' } },
          });
        } else {
          const retry = await reopened.broker.manage(
            parent(`cut-${cut}`),
            steer(f.id),
          );
          expect(retry).not.toMatchObject(unavailable);
          // Retry of the evictee is byte-identical even though reopen interrupted execution.
          expect(port.journal.find((entry) => entry.key === old?.key)).toEqual(
            old,
          );
        }
        expect(reopened.runner.starts).toHaveLength(0);
      } finally {
        await reopened?.broker.close();
        await f.broker.close();
      }
    },
  );

  it('keeps a local projected-codec rejection definite, with immediate same-process retry', async () => {
    const f = await fixture();
    try {
      await fill(f);
      const prepare = f.broker['prepareV3Update'].bind(f.broker);
      f.broker['prepareV3Update'] = (prior, candidate): StoredDelegationV3 => ({
        ...prepare(prior, candidate),
        deadlineAt: 0,
      });
      const commits = f.storage.commits;
      await expect(
        f.broker.manage(parent('codec'), steer(f.id)),
      ).resolves.toMatchObject(unavailable);
      expect(f.storage.commits).toBe(commits);
      expect(f.port.journal).toHaveLength(0);
      f.broker['prepareV3Update'] = prepare;
      await expect(
        f.broker.manage(parent('codec'), steer(f.id)),
      ).resolves.toMatchObject({ ok: true });
      expect(f.runner.steeringRequests).toHaveLength(1);
    } finally {
      await f.broker.close();
    }
  });
});

describe('uncertain dispatch and settlement barriers', () => {
  afterEach(() => jest.restoreAllMocks());
  it('checks quarantine at control, continuation, create and stop entry even when the caller already passed admission', async () => {
    const f = await fixture();
    try {
      const run = f.broker['runs'].get(f.id);
      const slot = run?.admission;
      if (!slot) throw new Error('Expected running admission slot');
      f.storage.fault = 'after';
      await expect(
        f.broker.manage(parent('fence'), steer(f.id)),
      ).resolves.toMatchObject(unavailable);
      const record = f.storage.attempted;
      const command = record?.control;
      if (!record || !command) throw new Error('Expected attempted control');
      const starts = f.runner.starts.length;
      await expect(
        f.broker['performControl'](rootParent, f.id, command, new Map()),
      ).rejects.toThrow();
      const create = jest
        .fn<
          ReturnType<(typeof f.broker)['create']>,
          Parameters<(typeof f.broker)['create']>
        >()
        .mockResolvedValue({
          ok: false,
          error: {
            code: 'runtime_error',
            message: 'must not dispatch',
            retryable: true,
          },
        });
      const original = f.broker['create'];
      f.broker['create'] = create;
      const controller = new AbortController();
      await f.broker['launchContinuation'](
        rootParent,
        f.id,
        record,
        controller,
        slot,
      );
      expect(create).not.toHaveBeenCalled();
      expect(controller.signal.aborted).toBe(true);
      f.broker['create'] = original;
      await expect(
        f.broker['create'](
          rootParent,
          record.task,
          record.callKey,
          record.requestHash,
          new AbortController(),
          record,
        ),
      ).resolves.toMatchObject({ ok: false });
      await expect(f.broker.stop(rootParent, f.id)).resolves.toMatchObject(
        unavailable,
      );
      expect(f.runner.starts).toHaveLength(starts);
      expect(f.runner.stopped).toHaveLength(0);
      expect(f.runner.steeringRequests).toHaveLength(0);
    } finally {
      await f.broker.close();
    }
  });

  it.each(['intent', 'locator', 'notification marker'] as const)(
    'preserves the originating settlement %s rejection but drops queued events until canonical reopen',
    async (stage) => {
      const f = await fixture();
      let reopened: ReturnType<typeof createBrokerHarness> | undefined;
      try {
        const commit = f.storage.commit.bind(f.storage);
        let faulted = false;
        let queuedEvents: Promise<PromiseSettledResult<unknown>[]> | undefined;
        jest.spyOn(f.storage, 'commit').mockImplementation((record) => {
          if (
            !faulted &&
            record.version === 3 &&
            ((stage === 'intent' && record.settling) ||
              (stage === 'locator' &&
                record.latestResult &&
                !record.latestResult.notified) ||
              (stage === 'notification marker' &&
                record.latestResult?.notified))
          ) {
            faulted = true;
            f.storage.fault = 'after';
            queuedEvents = Promise.allSettled([
              f.runner.sink?.({
                delegationId: f.id,
                runGeneration: 1,
                sequence: 3,
                occurredAt: Date.now(),
                event: {
                  type: 'transcript_receipt',
                  streamRevision: 1,
                  mutationKey: 'queued-behind-settlement',
                  items: [],
                  replayed: false,
                },
              }),
              f.runner.sink?.({
                delegationId: f.id,
                runGeneration: 1,
                sequence: 4,
                occurredAt: Date.now(),
                event: {
                  type: 'terminal',
                  status: 'completed',
                  finalText: 'must be dropped',
                },
              }),
            ]);
          }
          return commit(record);
        });
        await expect(
          f.runner.sink?.({
            delegationId: f.id,
            runGeneration: 1,
            sequence: 2,
            occurredAt: Date.now(),
            event: {
              type: 'terminal',
              status: 'completed',
              finalText: 'canonical answer',
            },
          }),
        ).rejects.toThrow(
          stage === 'notification marker'
            ? 'Receipt admission did not commit'
            : 'Settlement pending',
        );
        expect(faulted).toBe(true);
        expect((await queuedEvents)?.map((result) => result.status)).toEqual([
          'fulfilled',
          'fulfilled',
        ]);
        const canonical = structuredClone(read(f.storage, f.id));
        const crash = f.storage.snapshot();
        const port = await f.port.snapshot();
        const commits = f.storage.commits;
        await expect(
          f.broker['updateAsync'](f.id, (current) => {
            if (current.deadlineAt === undefined) {
              throw new Error('Expected active deadline');
            }
            return Promise.resolve({
              ...current,
              deadlineAt: current.deadlineAt + 1,
            });
          }),
        ).rejects.toThrow();
        await expect(
          f.broker['settleStreamRecord'](canonical),
        ).rejects.toThrow();
        await expect(f.broker.close()).resolves.toBeUndefined();
        expect(f.storage.commits).toBe(commits);
        expect(read(f.storage, f.id)).toEqual(canonical);
        reopened = createBrokerHarness(
          { testOnlyStreamGeneration: true, transcriptPort: port },
          crash,
        );
        await reopened.broker.initialize();
        expect(read(crash, f.id).state.status).toBe('completed');
        expect(read(crash, f.id).latestResult?.resultIndex).toBe(1);
        expect(reopened.runner.starts).toHaveLength(0);
      } finally {
        await reopened?.broker.close();
        await f.broker.close();
      }
    },
  );
});

describe('host receipt uncertainty and authorized reservations', () => {
  afterEach(() => jest.restoreAllMocks());
  it.each(['direct', 'materialized', 'coalesced'] as const)(
    'recovers a persisted %s host receipt with its original identity and ack',
    async (mode) => {
      const f = await fixture({ capacity: 1 });
      let reopened: ReturnType<typeof createBrokerHarness> | undefined;
      try {
        if (mode !== 'direct') {
          await f.runner.sink?.({
            delegationId: f.id,
            runGeneration: 1,
            sequence: 2,
            occurredAt: Date.now(),
            event: { type: 'terminal', status: 'completed' },
          });
          await flushBroker();
        }
        if (mode === 'coalesced') {
          const blocker = await f.broker.spawn(parent('blocker'), baseTask);
          if (!blocker.ok) throw new Error('Expected blocker');
          await waitForLaunch(f.runner, blocker.value.delegationId);
          await expect(
            f.broker.deliverHostMessage(f.id, 'initial queued', randomUUID()),
          ).resolves.toMatchObject({ ok: true });
          expect(f.broker.inspect(rootParent, f.id)?.phase).toBe('queued');
        }
        const starts = f.runner.starts.length;
        const attemptId = randomUUID();
        f.storage.fault = 'after';
        await expect(
          f.broker.deliverHostMessage(f.id, 'uncertain host', attemptId),
        ).resolves.toMatchObject(unavailable);
        const canonical = structuredClone(read(f.storage, f.id));
        const fresh = canonical.receipts.commandReceipts.at(-1);
        const crash = f.storage.snapshot();
        const port = await f.port.snapshot();
        const commits = f.storage.commits;
        const lookup = jest.spyOn(f.port, 'receipt');
        await expect(
          f.broker.deliverHostMessage(f.id, 'uncertain host', attemptId),
        ).resolves.toMatchObject(unavailable);
        expect(lookup).not.toHaveBeenCalled();
        expect(f.storage.commits).toBe(commits);
        expect(f.runner.starts).toHaveLength(starts);
        expect(f.runner.steeringRequests).toHaveLength(0);
        reopened = createBrokerHarness(
          { testOnlyStreamGeneration: true, transcriptPort: port },
          crash,
        );
        await reopened.broker.initialize();
        const recovered = read(crash, f.id).receipts.commandReceipts.find(
          (entry) => entry.key === fresh?.key,
        );
        expect(recovered).toMatchObject({
          operationId: fresh?.operationId,
          reply: { ack: fresh?.reply.ack },
        });
        if (mode === 'coalesced') expect(recovered).toEqual(fresh);
        else expect(recovered?.reply.final?.status).toBe('failed');
        expect(reopened.runner.starts).toHaveLength(0);
      } finally {
        await reopened?.broker.close();
        await f.broker.close();
      }
    },
  );
});

describe('reservations across record versions (PR review)', () => {
  it('refuses a reserved chat key retried against a legacy target', async () => {
    const storage = new FaultStorage();
    const legacy = createBrokerHarness({}, storage);
    await legacy.broker.initialize();
    const spawned = await legacy.broker.spawn(parent('legacy-spawn'), baseTask);
    if (!spawned.ok) throw new Error('Expected legacy spawn');
    const legacyId = spawned.value.delegationId;
    await waitForLaunch(legacy.runner, legacyId);
    await legacy.broker.close();
    expect(storage.records.get(legacyId)?.version).not.toBe(3);
    const f = await fixture({}, storage);
    try {
      f.storage.fault = 'after';
      expect(
        await f.broker.manage(parent('shared'), steer(f.id)),
      ).toMatchObject(unavailable);
      const starts = f.runner.starts.length;
      const commits = f.storage.commits;
      const retried = await f.broker.manage(parent('shared'), {
        delegationId: legacyId,
        operation: 'follow_up',
        message: 'once',
      });
      expect(retried).toMatchObject(unavailable);
      expect(JSON.stringify(retried)).not.toContain(f.id);
      expect(f.runner.starts).toHaveLength(starts);
      expect(f.storage.commits).toBe(commits);
    } finally {
      await f.broker.close();
    }
  });

  it('refuses a reserved stop key retried against a legacy target', async () => {
    const storage = new FaultStorage();
    const legacy = createBrokerHarness({}, storage);
    await legacy.broker.initialize();
    const spawned = await legacy.broker.spawn(parent('legacy-stop'), baseTask);
    if (!spawned.ok) throw new Error('Expected legacy spawn');
    const legacyId = spawned.value.delegationId;
    await waitForLaunch(legacy.runner, legacyId);
    await legacy.broker.close();
    const f = await fixture({}, storage);
    try {
      f.storage.fault = 'after';
      expect(
        await f.broker.requestStop(parent('shared-stop'), f.id),
      ).toMatchObject(unavailable);
      const stop = jest.spyOn(f.runner, 'stop');
      const commits = f.storage.commits;
      const retried = await f.broker.requestStop(
        parent('shared-stop'),
        legacyId,
      );
      expect(retried).toMatchObject(unavailable);
      expect(JSON.stringify(retried)).not.toContain(f.id);
      expect(stop).not.toHaveBeenCalled();
      expect(f.storage.commits).toBe(commits);
    } finally {
      await f.broker.close();
    }
  });
});
