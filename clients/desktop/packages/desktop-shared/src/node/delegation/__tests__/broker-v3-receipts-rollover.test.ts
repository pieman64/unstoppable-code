import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { FileDelegationStorage } from '../storage';
import type { DelegationTranscriptReceiptEntry } from '../transcript-port';
import { routeFixture } from './fixtures';
import { InMemoryDelegationTranscriptPort } from '../in-memory-transcript-port';
import {
  decodeStoredDelegationV3,
  type StoredDelegationV3,
  type V3CommandReceiptEntry,
} from '../record-v3';
import {
  fitDelegationReceiptAck,
  fitDelegationReceiptFinal,
  completeDelegationCommandReceipt,
  projectDelegationCommandReplay,
  type DelegationReceiptAckInput,
} from '../receipt-reply';
import { delegationReceiptAckToResult } from '../broker-settlement';
import type { StoredDelegation, AgentDelegationBrokerOptions } from '../broker';
import {
  baseTask,
  createBrokerHarness,
  MemoryDelegationStorage,
  rootParent,
  waitForLaunch,
  flushBroker,
  type BrokerHarness,
} from './broker-harness';

function keyFor(call: string): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        rootParent.harnessId,
        rootParent.projectId,
        rootParent.worktreeId,
        rootParent.chatId,
        rootParent.turnId,
        call,
        rootParent.parentDelegationId,
        rootParent.parentRunGeneration,
      ]),
    )
    .digest('hex');
}
function entry(
  id: string,
  seed: string,
  admittedAt = 1,
): V3CommandReceiptEntry {
  const key = createHash('sha256').update(seed).digest('hex');
  const fitted = fitDelegationReceiptAck(
    {
      chatId: rootParent.chatId,
      delegationId: id,
      receiptKind: 'command',
      key,
      requestHash: key,
      operationId: randomUUID(),
      operation: 'steer',
      runGeneration: 1,
      admittedAt,
    },
    {
      ok: true,
      outcome: 'completed',
      snapshot: { delegationId: id, status: 'running', outputTruncated: false },
    },
  );
  if (
    !fitted.ok ||
    fitted.entry.receiptKind !== 'command' ||
    fitted.entry.reply.kind !== 'command'
  )
    throw new Error('Fixture fitting failed');
  return { ...fitted.entry, receiptKind: 'command', reply: fitted.entry.reply };
}
class ReopenablePort extends InMemoryDelegationTranscriptPort {
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
  async reopen(): Promise<ReopenablePort> {
    const port = new ReopenablePort();
    for (const [key, value] of Array.from(this.streams))
      port.streams.set(key, structuredClone(value));
    for (const [key, value] of Array.from(this.registries))
      port.registries.set(key, structuredClone(value));
    for (const [key, value] of Array.from(this.answers))
      port.answers.set(key, { ...value, bytes: Buffer.from(value.bytes) });
    for (const entry of this.journal) {
      const result = await port.appendReceipt(entry);
      if (!result.ok) throw new Error('Could not reopen immutable receipts');
    }
    return port;
  }
}
class CountingStorage extends MemoryDelegationStorage {
  commits = 0;
  override commit(record: StoredDelegation): Promise<void> {
    this.commits++;
    if (record.version === 3)
      decodeStoredDelegationV3(JSON.parse(JSON.stringify(record)));
    return super.commit(record);
  }
}
interface RolloverFixture extends BrokerHarness {
  readonly storage: CountingStorage;
  readonly port: ReopenablePort;
  readonly id: string;
}
async function fixture(
  overrides: Partial<AgentDelegationBrokerOptions> = {},
  storage = new CountingStorage(),
): Promise<RolloverFixture> {
  const port = new ReopenablePort();
  const f = createBrokerHarness(
    {
      testOnlyStreamGeneration: true,
      transcriptPort: port,
      resolveRoute: () =>
        Promise.resolve({
          ok: true,
          value: routeFixture({ capabilities: ['read', 'progress', 'resume'] }),
        }),
      ...overrides,
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
    event: { type: 'started', nativeSessionId: 'rollover-native' },
  });
  return { ...f, storage, port, id };
}
function read(f: Awaited<ReturnType<typeof fixture>>): StoredDelegationV3 {
  const record = f.storage.records.get(f.id);
  if (record?.version !== 3) throw new Error('Expected stream record');
  return record;
}
async function fill(f: Awaited<ReturnType<typeof fixture>>): Promise<void> {
  await f.broker['updateAsync'](f.id, (current) => {
    if (current.version !== 3) throw new Error('Expected stream');
    return Promise.resolve({
      ...current,
      receipts: {
        ...current.receipts,
        commandReceipts: Array.from({ length: 64 }, (_, index) =>
          entry(f.id, `seed-${index}`),
        ),
      },
    });
  });
}
const steer = (
  id: string,
): { delegationId: string; operation: 'steer'; message: string } => ({
  delegationId: id,
  operation: 'steer',
  message: 'small message',
});

describe('registry-first bounded stream rollover', () => {
  afterEach(() => jest.restoreAllMocks());
  it('admits a command at a full window, archives exact prior bytes and preserves the operational pin', async () => {
    const f = await fixture();
    try {
      await fill(f);
      const oldest = read(f).receipts.commandReceipts[0];
      const append = jest.spyOn(f.port, 'appendReceipt');
      const result = await f.broker.manage(
        { ...rootParent, toolCallId: 'fresh' },
        steer(f.id),
      );
      expect(result.ok).toBe(true);
      await flushBroker();
      expect(append).toHaveBeenCalledWith(oldest);
      expect(read(f).receipts.commandReceipts).toHaveLength(64);
      expect(
        read(f).receipts.commandReceipts.some((r) => r.key === keyFor('fresh')),
      ).toBe(true);
      expect(f.runner.steeringRequests).toHaveLength(1);
      decodeStoredDelegationV3(JSON.parse(JSON.stringify(read(f))));
    } finally {
      await f.broker.close();
    }
  });
  it('rolls attributable failure receipts and replays the old failure after eviction and restart', async () => {
    const f = await fixture();
    try {
      const parent = { ...rootParent, toolCallId: 'failed-first' };
      const input = { delegationId: f.id, operation: 'apply' };
      const first = await f.broker.manage(parent, input);
      expect(first.ok).toBe(false);
      for (let index = 0; index < 70; index++) {
        const result = await f.broker.manage(
          { ...rootParent, toolCallId: `failed-${index}` },
          input,
        );
        expect(result).toEqual(first);
      }
      expect(read(f).receipts.commandReceipts).toHaveLength(64);
      expect(
        read(f).receipts.commandReceipts.some(
          (r) => r.key === keyFor('failed-first'),
        ),
      ).toBe(false);
      const archived = await f.port.receipt({
        chatId: rootParent.chatId,
        receiptKind: 'command',
        key: keyFor('failed-first'),
      });
      expect(archived.ok).toBe(true);
      await f.broker.close();
      const reopened = createBrokerHarness(
        {
          testOnlyStreamGeneration: true,
          transcriptPort: await f.port.reopen(),
        },
        f.storage,
      );
      await reopened.broker.initialize();
      expect(await reopened.broker.manage(parent, input)).toEqual(first);
      expect(reopened.runner.starts).toHaveLength(0);
      await reopened.broker.close();
    } finally {
      await f.broker.close();
    }
  });
  it.each(['structured', 'thrown', 'durable but failed'])(
    'does not write or dispatch after an append is %s',
    async (mode) => {
      const f = await fixture();
      try {
        await fill(f);
        const before = JSON.stringify(read(f));
        const append = f.port.appendReceipt.bind(f.port);
        jest
          .spyOn(f.port, 'appendReceipt')
          .mockImplementation(async (value) => {
            if (mode === 'thrown') throw new Error('append unavailable');
            if (mode === 'durable but failed') await append(value);
            return {
              ok: false,
              error: {
                code: 'storage_failure',
                message: 'append unavailable',
                retryable: true,
              },
            };
          });
        const commit = jest.spyOn(f.storage, 'commit');
        const result = await f.broker.manage(
          { ...rootParent, toolCallId: 'append-fails' },
          steer(f.id),
        );
        expect(result).toMatchObject({ ok: false, error: { retryable: true } });
        expect(commit).not.toHaveBeenCalled();
        expect(JSON.stringify(read(f))).toBe(before);
        expect(f.runner.steeringRequests).toHaveLength(0);
        jest.restoreAllMocks();
        expect(
          (
            await f.broker.manage(
              { ...rootParent, toolCallId: 'append-fails' },
              steer(f.id),
            )
          ).ok,
        ).toBe(true);
      } finally {
        await f.broker.close();
      }
    },
  );
  it('does not resurrect an archived controls entry on receipt-only preparation', async () => {
    const f = await fixture();
    try {
      const old = {
        operationId: randomUUID(),
        key: keyFor('archived'),
        requestHash: keyFor('archived'),
        operation: 'steer' as const,
        status: 'completed' as const,
      };
      await f.broker['updateAsync'](f.id, (current) =>
        Promise.resolve({ ...current, controls: [old] }),
      );
      expect(read(f).receipts.commandReceipts).toEqual([]);
    } finally {
      await f.broker.close();
    }
  });
  it('folds failure admission time but not replay time into activity', async () => {
    const f = await fixture();
    try {
      const baseline = read(f).readMetadata.lastActivityAt;
      jest.spyOn(Date, 'now').mockReturnValue(baseline + 1000);
      const input = { delegationId: f.id, operation: 'apply' };
      const parent = { ...rootParent, toolCallId: 'activity-failure' };
      await f.broker.manage(parent, input);
      const admitted = read(f).receipts.commandReceipts[0];
      expect(read(f).readMetadata.lastActivityAt).toBe(admitted?.admittedAt);
      jest.spyOn(Date, 'now').mockReturnValue(baseline + 2000);
      await f.broker.manage(parent, input);
      expect(read(f).readMetadata.lastActivityAt).toBe(admitted?.admittedAt);
    } finally {
      await f.broker.close();
    }
  });
  it('rolls more than 64 aliases while one native stop is blocked', async () => {
    const f = await fixture();
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stopMock = jest
      .spyOn(f.runner, 'stop')
      .mockImplementation(async () => {
        await blocked;
        return { stopped: true };
      });
    try {
      for (let index = 0; index < 70; index++) {
        expect(
          (
            await f.broker.requestStop(
              { ...rootParent, toolCallId: `alias-${index}` },
              f.id,
            )
          ).ok,
        ).toBe(true);
      }
      expect(stopMock).toHaveBeenCalledTimes(1);
      expect(read(f).receipts.stopReceipts).toHaveLength(64);
      const replay = await f.broker.requestStop(
        { ...rootParent, toolCallId: 'alias-0' },
        f.id,
      );
      expect(replay).toMatchObject({
        ok: true,
        value: { stopRequested: { status: 'accepted' } },
      });
      release?.();
      await flushBroker();
    } finally {
      release?.();
      await f.broker.close();
    }
  });
});

describe('rollover identity, resolution and bounded work evidence', () => {
  afterEach(() => jest.restoreAllMocks());
  it('keeps record bytes bounded at N=2049 and 2N=4098, with one cold registry probe per new key', async () => {
    const f = await fixture();
    try {
      const lookup = jest.spyOn(f.port, 'receipt');
      const append = jest.spyOn(f.port, 'appendReceipt');
      const initial = f.storage.commits;
      const input = { delegationId: f.id, operation: 'apply' };
      const samples = [
        { first: 1, last: 500, count: 0, totalMs: 0 },
        { first: 2000, last: 2500, count: 0, totalMs: 0 },
        { first: 3500, last: 4000, count: 0, totalMs: 0 },
      ];
      let atN = { bytes: 0, commits: 0, appends: 0, reads: 0 };
      for (let index = 0; index < 4098; index++) {
        const started = performance.now();
        const result = await f.broker.manage(
          { ...rootParent, toolCallId: `scale-${index}` },
          input,
        );
        expect(result).toMatchObject({
          ok: false,
          error: { code: 'capability_unavailable' },
        });
        const elapsed = performance.now() - started;
        for (const sample of samples)
          if (index + 1 >= sample.first && index + 1 <= sample.last) {
            sample.totalMs += elapsed;
            sample.count++;
          }
        if ([500, 2500, 4000].includes(index + 1))
          process.stdout.write(
            `S1b TREND ${JSON.stringify(samples.filter((sample) => sample.last === index + 1).map((sample) => ({ ...sample, meanMs: sample.totalMs / sample.count })))}\n`,
          );
        expect(f.broker['controlCalls'].size).toBe(0);
        if (index === 2048)
          atN = {
            bytes: Buffer.byteLength(JSON.stringify(read(f))),
            commits: f.storage.commits - initial,
            appends: append.mock.calls.length,
            reads: lookup.mock.calls.length,
          };
      }
      const at2N = {
        bytes: Buffer.byteLength(JSON.stringify(read(f))),
        commits: f.storage.commits - initial,
        appends: append.mock.calls.length,
        reads: lookup.mock.calls.length,
      };
      expect(atN.commits).toBe(2049);
      expect(at2N.commits).toBe(4098);
      expect(atN.appends).toBe(2049 - 64);
      expect(at2N.appends).toBe(4098 - 64);
      expect(atN.reads).toBe(2049);
      expect(at2N.reads).toBe(4098);
      expect(Math.abs(at2N.bytes - atN.bytes)).toBeLessThan(512);
      expect(read(f).receipts.commandReceipts).toHaveLength(64);
      process.stdout.write(
        `S1b SCALE ${JSON.stringify({ N: atN, twoN: at2N })}\n`,
      );
    } finally {
      await f.broker.close();
    }
  }, 360_000);
  it('pins a resolved operational control, then archives it without resurrection on later updates', async () => {
    const f = await fixture();
    try {
      const parent = { ...rootParent, toolCallId: 'pinned' };
      expect((await f.broker.manage(parent, steer(f.id))).ok).toBe(true);
      await flushBroker();
      const pinned = read(f).receipts.commandReceipts.find(
        (r) => r.key === keyFor('pinned'),
      );
      expect(pinned?.reply.final).not.toBeNull();
      for (let index = 0; index < 70; index++)
        await f.broker.manage(
          { ...rootParent, toolCallId: `pin-failure-${index}` },
          { delegationId: f.id, operation: 'apply' },
        );
      expect(
        read(f).receipts.commandReceipts.find(
          (r) => r.key === keyFor('pinned'),
        ),
      ).toEqual(pinned);
      expect(
        (
          await f.broker.manage(
            { ...rootParent, toolCallId: 'replacement' },
            steer(f.id),
          )
        ).ok,
      ).toBe(true);
      await flushBroker();
      await f.broker.manage(
        { ...rootParent, toolCallId: 'archive-old' },
        { delegationId: f.id, operation: 'apply' },
      );
      expect(
        read(f).receipts.commandReceipts.some(
          (r) => r.key === keyFor('pinned'),
        ),
      ).toBe(false);
      const archived = await f.port.receipt({
        chatId: rootParent.chatId,
        receiptKind: 'command',
        key: keyFor('pinned'),
      });
      expect(archived).toMatchObject({ ok: true, value: pinned });
      const current = read(f);
      await f.broker['updateAsync'](f.id, (record) =>
        Promise.resolve({
          ...record,
          controls: [
            {
              operationId: pinned?.operationId ?? '',
              key: keyFor('pinned'),
              requestHash: pinned?.requestHash ?? '',
              operation: 'steer' as const,
              status: 'completed' as const,
            },
          ],
          deadlineAt: (record.deadlineAt ?? record.createdAt + 100_000) + 1,
        }),
      );
      expect(read(f).receipts.commandReceipts).toEqual(
        current.receipts.commandReceipts,
      );
      expect(
        await f.port.receipt({
          chatId: rootParent.chatId,
          receiptKind: 'command',
          key: keyFor('pinned'),
        }),
      ).toEqual(archived);
    } finally {
      await f.broker.close();
    }
  });
  it('skips a candidate-only supersession final before a durable-but-failed append', async () => {
    const f = await fixture();
    try {
      expect(
        (
          await f.broker.manage(
            { ...rootParent, toolCallId: 'queued-followup' },
            { delegationId: f.id, operation: 'follow_up', message: 'later' },
          )
        ).ok,
      ).toBe(true);
      const follow = read(f).receipts.commandReceipts[0];
      if (!follow) throw new Error('Expected follow-up');
      await f.broker['updateAsync'](f.id, (current) => {
        if (current.version !== 3) throw new Error('Expected stream');
        return Promise.resolve({
          ...current,
          receipts: {
            ...current.receipts,
            commandReceipts: [
              follow,
              ...Array.from({ length: 63 }, (_, index) =>
                entry(f.id, `supersession-${index}`),
              ),
            ],
          },
        });
      });
      const append = f.port.appendReceipt.bind(f.port);
      const calls: V3CommandReceiptEntry[] = [];
      jest.spyOn(f.port, 'appendReceipt').mockImplementation(async (value) => {
        if (value.receiptKind === 'command' && value.reply.kind === 'command') {
          calls.push({ ...value, receiptKind: 'command', reply: value.reply });
        }
        await append(value);
        return {
          ok: false,
          error: {
            code: 'storage_failure',
            message: 'durable but failed',
            retryable: true,
          },
        };
      });
      expect(
        await f.broker.manage(
          { ...rootParent, toolCallId: 'supersedes' },
          { delegationId: f.id, operation: 'interrupt' },
        ),
      ).toMatchObject({ ok: false, error: { retryable: true } });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.key).not.toBe(follow.key);
      expect(read(f).receipts.commandReceipts[0]).toEqual(follow);
      expect(follow.reply.final).toBeNull();
      const crashStorage = new CountingStorage();
      await crashStorage.commit(read(f));
      const reopenedPort = await f.port.reopen();
      jest.restoreAllMocks();
      await f.broker.close();
      const reopened = createBrokerHarness(
        { testOnlyStreamGeneration: true, transcriptPort: reopenedPort },
        crashStorage,
      );
      await reopened.broker.initialize();
      const recovered = crashStorage.records.get(f.id);
      if (recovered?.version !== 3) throw new Error('Expected stream');
      expect(
        recovered.receipts.commandReceipts.find((r) => r.key === follow.key)
          ?.reply.final,
      ).toMatchObject({ status: 'failed' });
      expect(reopened.runner.starts).toHaveLength(0);
      await reopened.broker.close();
    } finally {
      await f.broker.close();
    }
  });
});

const scenarios = [
  'terminal error',
  'terminal success',
  'accepted completed',
  'accepted apply_failed',
  'accepted failure',
  'minimal',
];
function matrixEntry(
  id: string,
  key: string,
  hash: string,
  scenario: string,
): V3CommandReceiptEntry {
  const operationId = randomUUID();
  const ack: DelegationReceiptAckInput =
    scenario === 'terminal error'
      ? {
          ok: false,
          error: {
            code: 'policy_blocked',
            message: 'original terminal failure',
            retryable: false,
          },
        }
      : {
          ok: true,
          outcome: scenario.startsWith('accepted') ? 'accepted' : 'completed',
          snapshot: {
            delegationId: id,
            status: 'running',
            outputTruncated: false,
            ...(scenario === 'minimal'
              ? {}
              : {
                  control: {
                    operationId,
                    operation: 'steer',
                    status: scenario.startsWith('accepted')
                      ? 'accepted'
                      : 'completed',
                  },
                }),
          },
        };
  let fitted = fitDelegationReceiptAck(
    {
      chatId: rootParent.chatId,
      delegationId: id,
      receiptKind: 'command',
      key,
      requestHash: hash,
      operationId,
      operation: 'steer',
      runGeneration: 1,
      admittedAt: 1,
    },
    ack,
  );
  if (!fitted.ok) throw new Error('Expected fit');
  if (scenario.startsWith('accepted'))
    fitted = completeDelegationCommandReceipt(
      fitted.entry,
      fitDelegationReceiptFinal(
        scenario === 'accepted completed'
          ? { status: 'completed' }
          : {
              status: 'failed',
              error: {
                code:
                  scenario === 'accepted apply_failed'
                    ? 'apply_failed'
                    : 'runtime_error',
                message: 'resolved failure',
                retryable: false,
                ...(scenario === 'accepted apply_failed'
                  ? {
                      apply: {
                        reason: 'conflict',
                        guidance: 'not replayed',
                        issues: [],
                        omittedIssues: 3,
                      },
                    }
                  : {}),
              },
            },
      ),
    );
  if (
    !fitted.ok ||
    fitted.entry.receiptKind !== 'command' ||
    fitted.entry.reply.kind !== 'command'
  )
    throw new Error('Expected command');
  return { ...fitted.entry, receiptKind: 'command', reply: fitted.entry.reply };
}
const matrix = scenarios.flatMap((scenario) =>
  ['user', 'agent', 'host direct', 'host materialized', 'host coalesced'].map(
    (origin) => ({ scenario, origin }),
  ),
);
describe('B2 through actual eviction and reopen', () => {
  it.each(matrix)(
    '$scenario / $origin / window, evicted registry, reopened registry',
    async ({ scenario, origin }) => {
      const f = await fixture({ capacity: 1 });
      let reopened: ReturnType<typeof createBrokerHarness> | undefined;
      try {
        const operationId = randomUUID();
        const user = origin === 'user';
        const host = origin.startsWith('host');
        const parent = {
          ...rootParent,
          toolCallId: operationId,
          ...(user ? { controlAuthor: 'user' as const } : {}),
        };
        const input = steer(f.id);
        const key = host
          ? createHash('sha256')
              .update(`host:request-steering:${operationId}`)
              .digest('hex')
          : user
            ? createHash('sha256')
                .update(
                  JSON.stringify([
                    'managed-delegation-user-message',
                    rootParent.projectId,
                    rootParent.worktreeId,
                    rootParent.chatId,
                    operationId,
                  ]),
                )
                .digest('hex')
            : keyFor(operationId);
        const hash = createHash('sha256')
          .update(host ? input.message : JSON.stringify(input))
          .digest('hex');
        if (origin === 'host materialized' || origin === 'host coalesced') {
          await f.runner.sinks.get(f.id)?.({
            delegationId: f.id,
            runGeneration: 1,
            sequence: 2,
            occurredAt: Date.now(),
            event: { type: 'terminal', status: 'completed' },
          });
          for (let index = 0; index < 5; index++) await flushBroker();
        }
        if (origin === 'host coalesced') {
          const blocker = await f.broker.spawn(
            { ...rootParent, toolCallId: 'matrix-blocker' },
            baseTask,
          );
          if (!blocker.ok) throw new Error('Expected blocker');
          await waitForLaunch(f.runner, blocker.value.delegationId);
          expect(
            (
              await f.broker.deliverHostMessage(
                f.id,
                'queued initial host control',
                randomUUID(),
              )
            ).ok,
          ).toBe(true);
          expect(f.broker.inspect(rootParent, f.id)?.phase).toBe('queued');
        }
        const original = matrixEntry(f.id, key, hash, scenario);
        const ackBytes = JSON.stringify(original.reply.ack);
        await f.broker['updateAsync'](f.id, (current) => {
          if (current.version !== 3) throw new Error('Expected stream');
          const pinned = current.receipts.commandReceipts.filter(
            (receipt) => receipt.key === current.control?.key,
          );
          return Promise.resolve({
            ...current,
            legacyPrefix: {
              controls: [
                {
                  operationId: randomUUID(),
                  key: keyFor('matrix-frozen-prefix'),
                  requestHash: hash,
                  operation: 'steer' as const,
                  status: 'failed' as const,
                  firstError: {
                    code: 'policy_blocked' as const,
                    message: 'immutable legacy failure',
                    retryable: false,
                  },
                },
              ],
            },
            receipts: {
              ...current.receipts,
              commandReceipts: [
                original,
                ...pinned,
                ...Array.from({ length: 63 - pinned.length }, (_, index) =>
                  entry(f.id, `matrix-${index}`),
                ),
              ],
            },
          });
        });
        const expected = delegationReceiptAckToResult(
          projectDelegationCommandReplay(
            original.reply,
            user ? 'user' : 'agent',
          ),
        );
        const replay = (
          broker: typeof f.broker,
        ): ReturnType<typeof f.broker.deliverHostMessage> =>
          host
            ? broker.deliverHostMessage(f.id, input.message, operationId)
            : broker.manage(parent, input, user ? operationId : undefined);
        expect(await replay(f.broker)).toEqual(expected);
        await f.broker.manage(
          { ...rootParent, toolCallId: 'evict-matrix' },
          { delegationId: f.id, operation: 'apply' },
        );
        expect(
          read(f).receipts.commandReceipts.some((r) => r.key === key),
        ).toBe(false);
        expect(await replay(f.broker)).toEqual(expected);
        expect(
          await f.port.receipt({
            chatId: rootParent.chatId,
            receiptKind: 'command',
            key,
          }),
        ).toMatchObject({ ok: true, value: original });
        await f.broker.close();
        reopened = createBrokerHarness(
          {
            testOnlyStreamGeneration: true,
            transcriptPort: await f.port.reopen(),
          },
          f.storage,
        );
        await reopened.broker.initialize();
        const commits = f.storage.commits;
        expect(await replay(reopened.broker)).toEqual(expected);
        expect(f.storage.commits).toBe(commits);
        expect(reopened.runner.starts).toHaveLength(0);
        expect(reopened.runner.steeringRequests).toHaveLength(0);
        expect(JSON.stringify(original.reply.ack)).toBe(ackBytes);
      } finally {
        await reopened?.broker.close();
        await f.broker.close();
      }
    },
  );
});
describe('activity events, validation and serialization', () => {
  afterEach(() => jest.restoreAllMocks());
  it('folds first resolution time once, but not later receipt-only updates', async () => {
    const f = await fixture();
    let release: (() => void) | undefined;
    try {
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const original = f.runner.steer.bind(f.runner);
      jest
        .spyOn(f.runner, 'steer')
        .mockImplementation(async (handle, request) => {
          await gate;
          return original(handle, request);
        });
      const admittedAt = read(f).readMetadata.lastActivityAt + 1000;
      jest.spyOn(Date, 'now').mockReturnValue(admittedAt);
      const pending = f.broker.manage(
        { ...rootParent, toolCallId: 'later-resolution' },
        steer(f.id),
      );
      await flushBroker();
      expect(read(f).readMetadata.lastActivityAt).toBe(
        read(f).receipts.commandReceipts[0]?.admittedAt,
      );
      jest.spyOn(Date, 'now').mockReturnValue(admittedAt + 5000);
      release?.();
      expect((await pending).ok).toBe(true);
      await flushBroker();
      const resolved = read(f);
      expect(resolved.readMetadata.lastActivityAt).toBe(admittedAt + 5000);
      expect(resolved.receipts.commandReceipts[0]?.reply.final).toMatchObject({
        status: 'completed',
      });
      jest.spyOn(Date, 'now').mockReturnValue(admittedAt + 9000);
      await f.broker['update'](f.id, (record) => ({
        ...record,
        deadlineAt: (record.deadlineAt ?? record.createdAt + 100_000) + 1,
      }));
      expect(read(f).readMetadata.lastActivityAt).toBe(
        resolved.readMetadata.lastActivityAt,
      );
      expect(read(f).receipts.commandReceipts).toEqual(
        resolved.receipts.commandReceipts,
      );
    } finally {
      release?.();
      await f.broker.close();
    }
  });
  it('does not fold stop outcome commits or alias archival as command activity', async () => {
    const f = await fixture();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    jest.spyOn(f.runner, 'stop').mockImplementation(async () => {
      await gate;
      return { stopped: true };
    });
    try {
      await f.broker.requestStop(
        { ...rootParent, toolCallId: 'activity-stop-0' },
        f.id,
      );
      const before = read(f).readMetadata.lastActivityAt;
      jest.spyOn(Date, 'now').mockReturnValue(before + 1000);
      for (let index = 1; index < 66; index++)
        await f.broker.requestStop(
          { ...rootParent, toolCallId: `activity-stop-${index}` },
          f.id,
        );
      expect(read(f).readMetadata.lastActivityAt).toBe(before);
      const finish = f.broker['finishStreamStop'].bind(f.broker);
      let outcomeActivity = 0;
      f.broker['finishStreamStop'] = async (record, status): Promise<void> => {
        outcomeActivity = read(f).readMetadata.lastActivityAt;
        jest.spyOn(Date, 'now').mockReturnValue(before + 5000);
        await finish(record, status);
      };
      release?.();
      await Promise.all(Array.from(f.broker['commands'].keys()));
      expect(outcomeActivity).toBeGreaterThan(0);
      expect(read(f).readMetadata.lastActivityAt).toBe(outcomeActivity);
      expect(read(f).receipts.activeStop).toBeUndefined();
      const replay = await f.broker.requestStop(
        { ...rootParent, toolCallId: 'activity-stop-0' },
        f.id,
      );
      expect(replay).toMatchObject({
        ok: true,
        value: { stopRequested: { status: 'completed' } },
      });
      expect(read(f).readMetadata.lastActivityAt).toBe(outcomeActivity);
    } finally {
      release?.();
      await f.broker.close();
    }
  });
  it('rejects an invalid bounded projection before append and retries in the same broker', async () => {
    const f = await fixture();
    try {
      await fill(f);
      const prepare = f.broker['prepareV3Update'].bind(f.broker);
      f.broker['prepareV3Update'] = (prior, candidate): StoredDelegationV3 => ({
        ...prepare(prior, candidate),
        deadlineAt: 0,
      });
      const append = jest.spyOn(f.port, 'appendReceipt');
      const commits = f.storage.commits;
      expect(
        await f.broker.manage(
          { ...rootParent, toolCallId: 'invalid-projection' },
          steer(f.id),
        ),
      ).toMatchObject({ ok: false, error: { retryable: true } });
      expect(append).not.toHaveBeenCalled();
      expect(f.storage.commits).toBe(commits);
      f.broker['prepareV3Update'] = prepare;
      expect(
        (
          await f.broker.manage(
            { ...rootParent, toolCallId: 'invalid-projection' },
            steer(f.id),
          )
        ).ok,
      ).toBe(true);
    } finally {
      await f.broker.close();
    }
  });
  it('refuses a full window with no prior-durable eligible command before append', async () => {
    const f = await fixture();
    try {
      await f.broker['updateAsync'](f.id, (current) => {
        if (current.version !== 3) throw new Error('Expected stream');
        const receipts = Array.from({ length: 64 }, (_, index) => {
          const value = matrixEntry(
            f.id,
            keyFor(`unresolved-${index}`),
            keyFor(`unresolved-${index}`),
            'terminal success',
          );
          if (!value.reply.ack.ok) throw new Error('Expected ack');
          return {
            ...value,
            reply: {
              ...value.reply,
              ack: { ...value.reply.ack, outcome: 'accepted' as const },
            },
          };
        });
        return Promise.resolve({
          ...current,
          receipts: { ...current.receipts, commandReceipts: receipts },
        });
      });
      const append = jest.spyOn(f.port, 'appendReceipt');
      const commits = f.storage.commits;
      expect(
        await f.broker.manage(
          { ...rootParent, toolCallId: 'no-evictee' },
          steer(f.id),
        ),
      ).toMatchObject({
        ok: false,
        error: { code: 'capacity_exceeded', retryable: true },
      });
      expect(append).not.toHaveBeenCalled();
      expect(f.storage.commits).toBe(commits);
      expect(f.runner.steeringRequests).toHaveLength(0);
    } finally {
      await f.broker.close();
    }
  });
});

describe('file-serialized stop rollover and resume witness', () => {
  it('pins the successful resume while old aliases are retained, releases it for a new stop and reopens both stores', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'S1b-witness-'));
    const port = new ReopenablePort();
    class ValidatedStorage extends FileDelegationStorage {
      constructor(directory: string) {
        super(directory);
      }
      override commit(record: StoredDelegation): Promise<void> {
        decodeStoredDelegationV3(JSON.parse(JSON.stringify(record)));
        return super.commit(record);
      }
    }
    const storage = new ValidatedStorage(directory);
    const options = {
      testOnlyStreamGeneration: true,
      transcriptPort: port,
      resolveRoute: (): ReturnType<
        AgentDelegationBrokerOptions['resolveRoute']
      > =>
        Promise.resolve({
          ok: true as const,
          value: routeFixture({ capabilities: ['read', 'progress', 'resume'] }),
        }),
    };
    const f = createBrokerHarness(options, storage);
    let reopened: ReturnType<typeof createBrokerHarness> | undefined;
    let release: (() => void) | undefined;
    let releaseB: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    jest.spyOn(f.runner, 'stop').mockImplementation(async () => {
      await gate;
      return { stopped: true };
    });
    try {
      await f.broker.initialize();
      const spawned = await f.broker.spawn(rootParent, baseTask);
      if (!spawned.ok) throw new Error('Expected spawn');
      const id = spawned.value.delegationId;
      await waitForLaunch(f.runner, id);
      await f.runner.sink?.({
        delegationId: id,
        runGeneration: 1,
        sequence: 1,
        occurredAt: Date.now(),
        event: { type: 'started', nativeSessionId: 'witness-native' },
      });
      for (let index = 0; index < 64; index++)
        expect(
          (
            await f.broker.requestStop(
              { ...rootParent, toolCallId: `witness-A-${index}` },
              id,
            )
          ).ok,
        ).toBe(true);
      release?.();
      await Promise.all(Array.from(f.broker['commands'].keys()));
      expect(
        (
          await f.broker.manage(
            { ...rootParent, toolCallId: 'witness-resume' },
            { delegationId: id, operation: 'resume', message: 'continue' },
          )
        ).ok,
      ).toBe(true);
      for (
        let attempt = 0;
        attempt < 200 &&
        !f.runner.starts.some(
          (start) => start.delegationId === id && start.runGeneration === 2,
        );
        attempt++
      )
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
      expect(
        f.runner.starts.some(
          (start) => start.delegationId === id && start.runGeneration === 2,
        ),
      ).toBe(true);
      await f.runner.sinks.get(id)?.({
        delegationId: id,
        runGeneration: 2,
        sequence: 1,
        occurredAt: Date.now(),
        event: { type: 'started', nativeSessionId: 'witness-native' },
      });
      expect(
        (
          await f.broker.manage(
            { ...rootParent, toolCallId: 'witness-replace' },
            steer(id),
          )
        ).ok,
      ).toBe(true);
      for (let index = 0; index < 70; index++)
        await f.broker.manage(
          { ...rootParent, toolCallId: `witness-failure-${index}` },
          { delegationId: id, operation: 'apply' },
        );
      const pinned = await storage.loadOne(id);
      if (pinned?.version !== 3) throw new Error('Expected stream');
      const witness = pinned.receipts.commandReceipts.find(
        (r) => r.key === keyFor('witness-resume'),
      );
      expect(witness?.reply.ack.ok).toBe(true);
      expect(pinned.receipts.stopFence).toBeUndefined();
      expect(pinned.receipts.stopReceipts).toHaveLength(64);
      const gateB = new Promise<void>((resolve) => {
        releaseB = resolve;
      });
      jest.spyOn(f.runner, 'stop').mockImplementation(async () => {
        await gateB;
        return { stopped: true };
      });
      for (let index = 0; index < 65; index++)
        expect(
          (
            await f.broker.requestStop(
              { ...rootParent, toolCallId: `witness-B-${index}` },
              id,
            )
          ).ok,
        ).toBe(true);
      releaseB?.();
      await Promise.all(Array.from(f.broker['commands'].keys()));
      for (let index = 0; index < 65; index++)
        await f.broker.manage(
          { ...rootParent, toolCallId: `released-witness-${index}` },
          { delegationId: id, operation: 'apply' },
        );
      const released = await storage.loadOne(id);
      if (released?.version !== 3) throw new Error('Expected stream');
      expect(
        released.receipts.commandReceipts.some((r) => r.key === witness?.key),
      ).toBe(false);
      expect(
        await f.broker.requestStop(
          { ...rootParent, toolCallId: 'witness-A-0' },
          id,
        ),
      ).toMatchObject({
        ok: true,
        value: { stopRequested: { status: 'completed' } },
      });
      await f.broker.close();
      const reopenedPort = await port.reopen();
      reopened = createBrokerHarness(
        { ...options, transcriptPort: reopenedPort },
        new ValidatedStorage(directory),
      );
      await reopened.broker.initialize();
      expect(
        await reopened.broker.requestStop(
          { ...rootParent, toolCallId: 'witness-A-0' },
          id,
        ),
      ).toMatchObject({
        ok: true,
        value: { stopRequested: { status: 'completed' } },
      });
      expect(reopened.runner.starts).toHaveLength(0);
      const activity = released.readMetadata.lastActivityAt;
      const loaded = await new FileDelegationStorage(directory).loadOne(id);
      if (loaded?.version !== 3) throw new Error('Expected stream');
      expect(loaded.readMetadata.lastActivityAt).toBe(activity);
    } finally {
      release?.();
      releaseB?.();
      await reopened?.broker.close();
      await f.broker.close();
      jest.restoreAllMocks();
      await rm(directory, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('archived aliases retain D1 outcome semantics', () => {
  afterEach(() => jest.restoreAllMocks());
  it.each([
    'pending commit',
    'outcome append',
    'durable outcome append',
    'slot clear',
  ])(
    'repairs %s with an archived first alias and repeated initialization',
    async (cut) => {
      const f = await fixture();
      let release: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      jest.spyOn(f.runner, 'stop').mockImplementation(async () => {
        await gate;
        return { stopped: true };
      });
      let reopened: ReturnType<typeof createBrokerHarness> | undefined;
      try {
        for (let index = 0; index < 65; index++)
          expect(
            (
              await f.broker.requestStop(
                { ...rootParent, toolCallId: `d1-${index}` },
                f.id,
              )
            ).ok,
          ).toBe(true);
        expect(
          read(f).receipts.stopReceipts.some(
            (alias) => alias.key === keyFor('d1-0'),
          ),
        ).toBe(false);
        const append = f.port.appendReceipt.bind(f.port);
        let fault = false;
        jest
          .spyOn(f.port, 'appendReceipt')
          .mockImplementation(async (value) => {
            if (
              value.receiptKind === 'stop_outcome' &&
              cut.includes('append') &&
              !fault
            ) {
              fault = true;
              if (cut.startsWith('durable')) await append(value);
              return {
                ok: false,
                error: {
                  code: 'storage_failure',
                  message: 'D1 outcome unavailable',
                  retryable: true,
                },
              };
            }
            return append(value);
          });
        const commit = f.storage.commit.bind(f.storage);
        jest.spyOn(f.storage, 'commit').mockImplementation((record) => {
          if (
            record.version === 3 &&
            !fault &&
            ((cut === 'pending commit' &&
              record.receipts.activeStop?.pendingTerminalOutcome) ||
              (cut === 'slot clear' &&
                read(f).receipts.activeStop?.pendingTerminalOutcome &&
                !record.receipts.activeStop))
          ) {
            fault = true;
            return Promise.reject(new Error('D1 commit unavailable'));
          }
          return commit(record);
        });
        release?.();
        await Promise.all(Array.from(f.broker['commands'].keys()));
        expect(fault).toBe(true);
        expect(read(f).receipts.activeStop).toBeDefined();
        const crash = new CountingStorage();
        await crash.commit(read(f));
        jest.restoreAllMocks();
        const port = await f.port.reopen();
        reopened = createBrokerHarness(
          { testOnlyStreamGeneration: true, transcriptPort: port },
          crash,
        );
        await reopened.broker.initialize();
        const alias = await reopened.broker.requestStop(
          { ...rootParent, toolCallId: 'd1-0' },
          f.id,
        );
        expect(alias).toMatchObject({
          ok: true,
          value: {
            stopRequested: {
              status: 'completed',
            },
          },
        });
        const recovered = crash.records.get(f.id);
        if (recovered?.version !== 3) throw new Error('Expected stream');
        expect(recovered.receipts.activeStop).toBeUndefined();
        expect(reopened.runner.stopped).toHaveLength(0);
        await reopened.broker.close();
        reopened = createBrokerHarness(
          {
            testOnlyStreamGeneration: true,
            transcriptPort: await port.reopen(),
          },
          crash,
        );
        await reopened.broker.initialize();
        expect(
          await reopened.broker.requestStop(
            { ...rootParent, toolCallId: 'd1-0' },
            f.id,
          ),
        ).toEqual(alias);
        expect(reopened.runner.stopped).toHaveLength(0);
      } finally {
        release?.();
        await reopened?.broker.close();
        await f.broker.close();
      }
    },
  );
  it('keeps failed A distinct from B after eviction and rejects missing non-active outcomes', async () => {
    const f = await fixture();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    jest.spyOn(f.runner, 'stop').mockImplementation(async () => {
      await gate;
      return { stopped: true };
    });
    let reopened: ReturnType<typeof createBrokerHarness> | undefined;
    try {
      for (let index = 0; index < 65; index++)
        await f.broker.requestStop(
          { ...rootParent, toolCallId: `old-A-${index}` },
          f.id,
        );
      const a = read(f);
      const aOperation = a.receipts.activeStop?.operationId;
      await f.broker['finishStreamStop'](a, 'failed');
      for (let index = 0; index < 65; index++)
        await f.broker.requestStop(
          { ...rootParent, toolCallId: `new-B-${index}` },
          f.id,
        );
      const b = read(f);
      expect(b.receipts.activeStop?.operationId).not.toBe(aOperation);
      expect(b.receipts.stopFence?.operationId).toBe(
        b.receipts.activeStop?.operationId,
      );
      await expect(
        f.broker['finishStreamStop'](a, 'completed'),
      ).rejects.toThrow();
      expect(read(f).receipts.activeStop).toEqual(b.receipts.activeStop);
      expect(read(f).receipts.stopFence).toEqual(b.receipts.stopFence);
      expect(
        await f.broker.requestStop(
          { ...rootParent, toolCallId: 'old-A-0' },
          f.id,
        ),
      ).toMatchObject({
        ok: true,
        value: { stopRequested: { operationId: aOperation, status: 'failed' } },
      });
      const crash = new CountingStorage();
      await crash.commit(read(f));
      reopened = createBrokerHarness(
        {
          testOnlyStreamGeneration: true,
          transcriptPort: await f.port.reopen(),
        },
        crash,
      );
      await reopened.broker.initialize();
      expect(
        await reopened.broker.requestStop(
          { ...rootParent, toolCallId: 'old-A-0' },
          f.id,
        ),
      ).toMatchObject({
        ok: true,
        value: { stopRequested: { operationId: aOperation, status: 'failed' } },
      });
      const receipt = f.port.receipt.bind(f.port);
      jest.spyOn(f.port, 'receipt').mockImplementation((identity) =>
        identity.receiptKind === 'stop_outcome' && identity.key === aOperation
          ? Promise.resolve({
              ok: false,
              error: {
                code: 'not_found',
                message: 'missing non-active outcome',
                retryable: false,
              },
            })
          : receipt(identity),
      );
      const commits = f.storage.commits;
      expect(
        await f.broker.requestStop(
          { ...rootParent, toolCallId: 'old-A-0' },
          f.id,
        ),
      ).toMatchObject({ ok: false, error: { retryable: true } });
      expect(f.storage.commits).toBe(commits);
      release?.();
      await Promise.all(Array.from(f.broker['commands'].keys()));
    } finally {
      release?.();
      await reopened?.broker.close();
      await f.broker.close();
    }
  });
});

describe('archival transaction cuts and immutable failed pending outcome', () => {
  afterEach(() => jest.restoreAllMocks());
  it('keeps a durable-but-failed command append in both the prior window and reopened registry without admitting the fresh key', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'S1b-cut3-'));
    const f = await fixture();
    let reopened: ReturnType<typeof createBrokerHarness> | undefined;
    try {
      await fill(f);
      const prior = read(f);
      const evictee = prior.receipts.commandReceipts[0];
      const append = f.port.appendReceipt.bind(f.port);
      jest.spyOn(f.port, 'appendReceipt').mockImplementation(async (value) => {
        await append(value);
        return {
          ok: false,
          error: {
            code: 'storage_failure',
            message: 'durable but failed',
            retryable: true,
          },
        };
      });
      const commits = f.storage.commits;
      const input = { delegationId: f.id, operation: 'apply' };
      expect(
        await f.broker.manage(
          { ...rootParent, toolCallId: 'cut3-fresh' },
          input,
        ),
      ).toMatchObject({ ok: false, error: { retryable: true } });
      expect(f.storage.commits).toBe(commits);
      expect(read(f)).toEqual(prior);
      const storage = new FileDelegationStorage(directory);
      await storage.commit(prior);
      const port = await f.port.reopen();
      jest.restoreAllMocks();
      await f.broker.close();
      reopened = createBrokerHarness(
        { testOnlyStreamGeneration: true, transcriptPort: port },
        new FileDelegationStorage(directory),
      );
      await reopened.broker.initialize();
      const recovered = await storage.loadOne(f.id);
      if (recovered?.version !== 3 || !evictee)
        throw new Error('Expected prior stream window');
      expect(recovered.receipts.commandReceipts).toContainEqual(evictee);
      expect(
        await port.receipt({
          chatId: rootParent.chatId,
          receiptKind: 'command',
          key: evictee.key,
        }),
      ).toEqual({ ok: true, value: evictee });
      expect(
        recovered.receipts.commandReceipts.some(
          (receipt) => receipt.key === keyFor('cut3-fresh'),
        ),
      ).toBe(false);
      expect(
        await reopened.broker.manage(
          { ...rootParent, toolCallId: 'cut3-fresh' },
          input,
        ),
      ).toMatchObject({ ok: false, error: { code: 'capability_unavailable' } });
      expect(
        await port.receipt({
          chatId: rootParent.chatId,
          receiptKind: 'command',
          key: evictee.key,
        }),
      ).toEqual({ ok: true, value: evictee });
      expect(reopened.runner.starts).toHaveLength(0);
    } finally {
      await reopened?.broker.close();
      await f.broker.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('validates one exact bounded candidate before append and queues ordinary writes behind that append', async () => {
    const f = await fixture();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered: (() => void) | undefined;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const append = f.port.appendReceipt.bind(f.port);
    let projected: StoredDelegation | undefined;
    try {
      await fill(f);
      const originalPrepare = f.broker['prepareV3Update'].bind(f.broker);
      let preparations = 0;
      f.broker['prepareV3Update'] = (prior, candidate): StoredDelegationV3 => {
        preparations++;
        return originalPrepare(prior, candidate);
      };
      jest.spyOn(f.port, 'appendReceipt').mockImplementation(async (entry) => {
        projected = f.broker['recordTransaction'].getStore()?.candidate;
        if (projected?.version !== 3)
          throw new Error('Expected prepared candidate');
        expect(projected.receipts.commandReceipts).toHaveLength(64);
        decodeStoredDelegationV3(JSON.parse(JSON.stringify(projected)));
        entered?.();
        await gate;
        return append(entry);
      });
      const commit = jest.spyOn(f.storage, 'commit');
      const pending = f.broker.manage(
        { ...rootParent, toolCallId: 'append-serialization' },
        steer(f.id),
      );
      await Promise.race([
        waiting,
        pending.then(() => {
          throw new Error('Full-window admission never reached append');
        }),
      ]);
      expect(preparations).toBe(1);
      const queued = f.broker['update'](f.id, (record) => ({
        ...record,
        deadlineAt: (record.deadlineAt ?? record.createdAt + 100_000) + 1,
      }));
      await flushBroker();
      expect(commit).not.toHaveBeenCalled();
      expect(f.runner.steeringRequests).toHaveLength(0);
      release?.();
      expect((await pending).ok).toBe(true);
      await queued;
      expect(commit.mock.calls[0]?.[0]).toBe(projected);
    } finally {
      release?.();
      await f.broker.close();
    }
  });
  it('replays a durable pending failed outcome byte-for-byte after eviction and repeated reopen', async () => {
    const f = await fixture();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    jest.spyOn(f.runner, 'stop').mockImplementation(async () => {
      await gate;
      return { stopped: true };
    });
    let reopened: ReturnType<typeof createBrokerHarness> | undefined;
    try {
      for (let index = 0; index < 65; index++)
        expect(
          (
            await f.broker.requestStop(
              { ...rootParent, toolCallId: `failed-pending-${index}` },
              f.id,
            )
          ).ok,
        ).toBe(true);
      const append = f.port.appendReceipt.bind(f.port);
      jest.spyOn(f.port, 'appendReceipt').mockImplementation((value) =>
        value.receiptKind === 'stop_outcome'
          ? Promise.resolve({
              ok: false,
              error: {
                code: 'storage_failure',
                message: 'outcome append blocked',
                retryable: true,
              },
            })
          : append(value),
      );
      await expect(
        f.broker['finishStreamStop'](read(f), 'failed'),
      ).rejects.toThrow();
      const pending = read(f).receipts.activeStop?.pendingTerminalOutcome;
      if (!pending) throw new Error('Expected durable pending failed outcome');
      expect(pending.reply.status).toBe('failed');
      const bytes = JSON.stringify(pending);
      const storage = new CountingStorage();
      await storage.commit(read(f));
      const port = await f.port.reopen();
      jest.restoreAllMocks();
      release?.();
      await Promise.all(Array.from(f.broker['commands'].keys()));
      await f.broker.close();
      jest
        .spyOn(Date, 'now')
        .mockReturnValue(pending.reply.finishedAt + 10_000);
      reopened = createBrokerHarness(
        { testOnlyStreamGeneration: true, transcriptPort: port },
        storage,
      );
      await reopened.broker.initialize();
      const identity = {
        chatId: rootParent.chatId,
        receiptKind: 'stop_outcome' as const,
        key: pending.operationId,
      };
      const outcome = await port.receipt(identity);
      expect(outcome).toEqual({ ok: true, value: pending });
      expect(outcome.ok && JSON.stringify(outcome.value)).toBe(bytes);
      expect(
        await reopened.broker.requestStop(
          { ...rootParent, toolCallId: 'failed-pending-0' },
          f.id,
        ),
      ).toMatchObject({
        ok: true,
        value: { stopRequested: { status: 'failed' } },
      });
      expect(reopened.runner.stopped).toHaveLength(0);
      await reopened.broker.close();
      const nextPort = await port.reopen();
      reopened = createBrokerHarness(
        { testOnlyStreamGeneration: true, transcriptPort: nextPort },
        storage,
      );
      await reopened.broker.initialize();
      expect(await nextPort.receipt(identity)).toEqual({
        ok: true,
        value: pending,
      });
      expect(reopened.runner.stopped).toHaveLength(0);
    } finally {
      release?.();
      await reopened?.broker.close();
      await f.broker.close();
    }
  });
});

describe('archived host deliveries (PR review)', () => {
  function hostEntry(
    id: string,
    domain: 'host:request-steering' | 'host:coalesce',
    attemptId: string,
    message: string,
  ): V3CommandReceiptEntry {
    const key = createHash('sha256')
      .update(`${domain}:${attemptId}`)
      .digest('hex');
    const fitted = fitDelegationReceiptAck(
      {
        chatId: rootParent.chatId,
        delegationId: id,
        receiptKind: 'command',
        key,
        requestHash: createHash('sha256').update(message).digest('hex'),
        operationId: attemptId,
        operation: 'steer',
        runGeneration: 1,
        admittedAt: 1,
      },
      {
        ok: true,
        outcome: 'completed',
        snapshot: {
          delegationId: id,
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
      throw new Error('Fixture fitting failed');
    return {
      ...fitted.entry,
      receiptKind: 'command',
      reply: fitted.entry.reply,
    };
  }
  async function retainFirst(
    f: RolloverFixture,
    first: V3CommandReceiptEntry,
  ): Promise<void> {
    await f.broker['updateAsync'](f.id, (current) => {
      if (current.version !== 3) throw new Error('Expected stream');
      const pinned = current.receipts.commandReceipts.filter(
        (receipt) => receipt.key === current.control?.key,
      );
      return Promise.resolve({
        ...current,
        receipts: {
          ...current.receipts,
          commandReceipts: [
            first,
            ...pinned,
            ...Array.from({ length: 63 - pinned.length }, (_, index) =>
              entry(f.id, `archived-host-${index}`),
            ),
          ],
        },
      });
    });
  }
  async function evict(f: RolloverFixture, key: string): Promise<void> {
    await f.broker.manage(
      { ...rootParent, toolCallId: `evict-${randomUUID()}` },
      { delegationId: f.id, operation: 'apply' },
    );
    expect(read(f).receipts.commandReceipts.some((r) => r.key === key)).toBe(
      false,
    );
  }

  it('waits on a completed host delivery after it rolls over and after reopen', async () => {
    const f = await fixture();
    let reopened: ReturnType<typeof createBrokerHarness> | undefined;
    try {
      const attemptId = randomUUID();
      const host = hostEntry(
        f.id,
        'host:request-steering',
        attemptId,
        'delivered',
      );
      await retainFirst(f, host);
      await expect(
        f.broker.waitHostMessage(f.id, attemptId),
      ).resolves.toBeUndefined();
      await evict(f, host.key);
      await expect(
        f.broker.waitHostMessage(f.id, attemptId),
      ).resolves.toBeUndefined();
      await expect(
        f.broker.waitHostMessage(f.id, randomUUID()),
      ).rejects.toThrow('The host message did not complete.');
      await f.broker.close();
      reopened = createBrokerHarness(
        {
          testOnlyStreamGeneration: true,
          transcriptPort: await f.port.reopen(),
        },
        f.storage,
      );
      await reopened.broker.initialize();
      await expect(
        reopened.broker.waitHostMessage(f.id, attemptId),
      ).resolves.toBeUndefined();
    } finally {
      await reopened?.broker.close();
      await f.broker.close();
    }
  });

  it('replays an archived historical host:coalesce receipt without steering again', async () => {
    const f = await fixture();
    try {
      const attemptId = randomUUID();
      const message = 'historical coalesced message';
      const coalesced = hostEntry(f.id, 'host:coalesce', attemptId, message);
      await retainFirst(f, coalesced);
      const expected = delegationReceiptAckToResult(
        projectDelegationCommandReplay(coalesced.reply, 'agent'),
      );
      const steering = f.runner.steeringRequests.length;
      expect(
        await f.broker.deliverHostMessage(f.id, message, attemptId),
      ).toEqual(expected);
      await evict(f, coalesced.key);
      expect(
        await f.broker.deliverHostMessage(f.id, message, attemptId),
      ).toEqual(expected);
      expect(f.runner.steeringRequests).toHaveLength(steering);
      const primary = createHash('sha256')
        .update(`host:request-steering:${attemptId}`)
        .digest('hex');
      expect(
        read(f).receipts.commandReceipts.some((r) => r.key === primary),
      ).toBe(false);
    } finally {
      await f.broker.close();
    }
  });
});

describe('archived stream keys on legacy targets (PR review round 2)', () => {
  async function withLegacyChild(): Promise<{
    storage: CountingStorage;
    legacyId: string;
  }> {
    const seed = new MemoryDelegationStorage();
    const legacy = createBrokerHarness({}, seed);
    await legacy.broker.initialize();
    const spawned = await legacy.broker.spawn(
      { ...rootParent, toolCallId: 'legacy-spawn' },
      baseTask,
    );
    if (!spawned.ok) throw new Error('Expected legacy spawn');
    await waitForLaunch(legacy.runner, spawned.value.delegationId);
    await legacy.broker.close();
    const storage = new CountingStorage();
    for (const [id, record] of Array.from(seed.records))
      storage.records.set(id, record);
    expect(storage.records.get(spawned.value.delegationId)?.version).not.toBe(
      3,
    );
    return { storage, legacyId: spawned.value.delegationId };
  }

  it('refuses an archived stream command key retried against a legacy target', async () => {
    const { storage, legacyId } = await withLegacyChild();
    const f = await fixture({}, storage);
    try {
      const key = keyFor('archived-shared');
      const archived: V3CommandReceiptEntry = {
        ...entry(f.id, 'archived-shared-seed'),
        key,
      };
      await f.broker['updateAsync'](f.id, (current) => {
        if (current.version !== 3) throw new Error('Expected stream');
        const pinned = current.receipts.commandReceipts.filter(
          (receipt) => receipt.key === current.control?.key,
        );
        return Promise.resolve({
          ...current,
          receipts: {
            ...current.receipts,
            commandReceipts: [
              archived,
              ...pinned,
              ...Array.from({ length: 63 - pinned.length }, (_, index) =>
                entry(f.id, `legacy-archive-${index}`),
              ),
            ],
          },
        });
      });
      await f.broker.manage(
        { ...rootParent, toolCallId: 'evict-legacy-archive' },
        { delegationId: f.id, operation: 'apply' },
      );
      expect(read(f).receipts.commandReceipts.some((r) => r.key === key)).toBe(
        false,
      );
      const starts = f.runner.starts.length;
      const commits = f.storage.commits;
      const retried = await f.broker.manage(
        { ...rootParent, toolCallId: 'archived-shared' },
        { delegationId: legacyId, operation: 'follow_up', message: 'again' },
      );
      expect(retried).toEqual({
        ok: false,
        error: {
          code: 'invalid_request',
          message: 'A command call cannot change its arguments.',
          retryable: false,
        },
      });
      expect(f.runner.starts).toHaveLength(starts);
      expect(f.storage.commits).toBe(commits);
    } finally {
      await f.broker.close();
    }
  });

  it('refuses an archived stream stop alias retried against a legacy target', async () => {
    const { storage, legacyId } = await withLegacyChild();
    const f = await fixture({}, storage);
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stopMock = jest
      .spyOn(f.runner, 'stop')
      .mockImplementation(async () => {
        await blocked;
        return { stopped: true };
      });
    try {
      for (let index = 0; index < 70; index++)
        expect(
          (
            await f.broker.requestStop(
              { ...rootParent, toolCallId: `legacy-alias-${index}` },
              f.id,
            )
          ).ok,
        ).toBe(true);
      const retained = new Set(read(f).receipts.stopReceipts.map((r) => r.key));
      const archivedCall = Array.from(
        { length: 70 },
        (_, index) => `legacy-alias-${index}`,
      ).find((call) => !retained.has(keyFor(call)));
      if (!archivedCall) throw new Error('Expected an archived alias');
      const commits = f.storage.commits;
      const legacyBytes = JSON.stringify(f.storage.records.get(legacyId));
      const retried = await f.broker.requestStop(
        { ...rootParent, toolCallId: archivedCall },
        legacyId,
      );
      expect(retried).toEqual({
        ok: false,
        error: {
          code: 'invalid_request',
          message: 'A stop call cannot change its target.',
          retryable: false,
        },
      });
      expect(stopMock).toHaveBeenCalledTimes(1);
      expect(f.storage.commits).toBe(commits);
      expect(JSON.stringify(f.storage.records.get(legacyId))).toBe(legacyBytes);
    } finally {
      release?.();
      await f.broker.close();
    }
  });
});
