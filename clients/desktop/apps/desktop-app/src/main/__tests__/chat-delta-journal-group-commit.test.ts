/**
 * Group commit in the delta-journal writer (phase 11, P1 §B): leader/follower
 * batching of admitted records.
 *
 * - A lone record is appended and synced at once.
 * - Records admitted while a sync is in flight share one append and one sync.
 * - A batch is capped at 256 records or 1 MiB, even under continuous load,
 *   and each batch is acknowledged as soon as its own sync completes.
 * - Records are acknowledged in revision order, never before their batch is
 *   durable; mutation-id dedup holds across a batch.
 * - A failed batch rejects every record in and behind it, including whole
 *   batches queued after it, and requires a reopen; checkpoint and inline
 *   commit wait for an open batch. A transaction that then finds the writer
 *   unusable was never queued, so its artifacts are discarded; those of a
 *   queued record are kept.
 * - Recovery: a batch that was appended but never synced ends the log at its
 *   first damaged frame, even when later frames of the same batch arrived
 *   intact; damage a later batch follows still fails closed.
 */
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as workCounters from '@canopy/desktop-shared/node/work-counters';
import type { ChatStorageV2 } from '../lib/chat-storage-v2';
import { CreatedArtifacts } from '../lib/chat-transcript-artifacts';
import {
  ChatDeltaJournalIntegrityError,
  DELTA_JOURNAL_FILE_NAME,
  decodeDeltaJournalRecord,
  scanDeltaJournalFrames,
} from '../lib/chat-delta-journal/format';
import {
  GROUP_COMMIT_MAX_BYTES,
  GROUP_COMMIT_MAX_RECORDS,
} from '../lib/chat-delta-journal/group-commit';
import {
  ChatDeltaJournalWriter,
  promoteToDeltaJournal,
  type DeltaJournalBoundary,
  type DeltaJournalCommitInput,
  type DeltaJournalDiagnostic,
} from '../lib/chat-delta-journal/writer';
import {
  createV2Scope,
  message,
  replayedScopeState,
} from './helpers/chat-delta-journal-harness';
import { settlesWithin } from './helpers/chat-delta-journal-sync-gate';

/** A gate a test opens to let held work continue. */
interface Gate {
  wait: Promise<void>;
  open: () => void;
}

function gate(): Gate {
  let open = (): void => undefined;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

/** Fails instead of hanging when `work` does not settle in time. */
async function within<T>(work: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timed out: ${label}`)),
          5_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** A metadata-only commit against the writer's latest admitted state. */
function titleCommit(
  writer: ChatDeltaJournalWriter,
  mutationId: string,
  title: string,
): DeltaJournalCommitInput {
  const current = writer.indexes();
  const revision = current.live.revision + 1;
  return {
    expectedRevision: current.live.revision,
    next: {
      live: {
        ...current.live,
        revision,
        tabs: current.live.tabs.map((tab) =>
          tab.id === 'chat' ? { ...tab, title } : tab,
        ),
      },
      archive: { ...current.archive, revision },
      recovery: {
        ...current.recovery,
        mutationIds: [...current.recovery.mutationIds, mutationId],
      },
    },
    writes: [],
    mutationIds: [mutationId],
  };
}

describe('delta journal group commit', () => {
  let root: string;
  let store: ChatStorageV2;
  let journalPath: string;
  /** Bytes of every journal append, in order. */
  let journalWrites: number[];
  let journalSyncs: number;
  /** Boundaries in the order the writer reached them. */
  let boundaries: DeltaJournalBoundary[];
  /** Holds the writer at the named boundary, on its nth occurrence. */
  let holds: Map<string, Gate>;
  /** Fails the writer at the named boundary, on its nth occurrence. */
  let failures: Set<string>;
  let diagnostics: DeltaJournalDiagnostic[];

  jest.setTimeout(120_000);

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'chat-delta-journal-group-commit-'));
    store = await createV2Scope(root, 'scope', [
      { id: 'chat', messages: [message('m0', 'hello', 'user')] },
    ]);
    await promoteToDeltaJournal(store);
    journalPath = join(store.directory, DELTA_JOURNAL_FILE_NAME);
    journalWrites = [];
    journalSyncs = 0;
    boundaries = [];
    holds = new Map();
    failures = new Set();
    diagnostics = [];
    const write = workCounters.recordChatStorageFileWrite;
    jest
      .spyOn(workCounters, 'recordChatStorageFileWrite')
      .mockImplementation((path, bytes, serialized) => {
        if (path === journalPath) journalWrites.push(bytes);
        write(path, bytes, serialized);
      });
    const sync = workCounters.recordChatStorageFileSync;
    jest
      .spyOn(workCounters, 'recordChatStorageFileSync')
      .mockImplementation((path) => {
        if (path === journalPath) journalSyncs += 1;
        sync(path);
      });
  });

  afterEach(async () => {
    for (const held of Array.from(holds.values())) held.open();
    jest.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  async function open(): Promise<ChatDeltaJournalWriter> {
    const counts = new Map<DeltaJournalBoundary, number>();
    return ChatDeltaJournalWriter.open(store, {
      onDiagnostic: (diagnostic): void => {
        diagnostics.push(diagnostic);
      },
      onBoundary: async (boundary): Promise<void> => {
        const count = (counts.get(boundary) ?? 0) + 1;
        counts.set(boundary, count);
        boundaries.push(boundary);
        const key = `${boundary}#${count}`;
        if (failures.has(key)) throw new Error(`injected failure at ${key}`);
        await holds.get(key)?.wait;
      },
    });
  }

  /** Hold the writer after its nth journal append, before that sync. */
  function holdBeforeSync(nth: number): Gate {
    const held = gate();
    holds.set(`record-written#${nth}`, held);
    return held;
  }

  /** Wait until the journal has received `count` appends. */
  async function appended(count: number): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (journalWrites.length < count) {
      if (Date.now() > deadline)
        throw new Error(`Timed out: ${count} journal appends`);
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  }

  /** Admit a record; the returned promise is its durability. */
  async function admit(
    writer: ChatDeltaJournalWriter,
    id: string,
    title = `title ${id}`,
  ): Promise<{ revision: number; durable: Promise<void> }> {
    const admission = await within(
      writer.admit(titleCommit(writer, id, title)),
      `admission of ${id} must not wait for a sync in flight`,
    );
    expect(admission.result.applied).toBe(true);
    return {
      revision: admission.result.revision,
      durable: admission.durable,
    };
  }

  async function records(): Promise<
    Array<{ offset: number; toRevision: number; batchStart?: number }>
  > {
    const scan = scanDeltaJournalFrames(await readFile(journalPath));
    return scan.frames.flatMap((frame) => {
      const record = decodeDeltaJournalRecord(frame);
      return record.type === 'commit'
        ? [
            {
              offset: frame.offset,
              toRevision: record.toRevision,
              ...(record.batchStart !== undefined
                ? { batchStart: record.batchStart }
                : {}),
            },
          ]
        : [];
    });
  }

  it('appends and syncs a lone record at once', async () => {
    const writer = await open();
    const base = writer.revision;
    const before = journalSyncs;
    const first = await admit(writer, 'a');
    await within(first.durable, 'a lone record is not delayed');
    expect(journalWrites).toHaveLength(1);
    expect(journalSyncs - before).toBe(1);
    // The next lone record, after the first is durable, is again its own
    // append and sync.
    const second = await admit(writer, 'b');
    await within(second.durable, 'a lone record is not delayed');
    expect(journalWrites).toHaveLength(2);
    expect(journalSyncs - before).toBe(2);
    expect([first.revision, second.revision]).toEqual([base + 1, base + 2]);
    // Neither names a batch: the journal equals one written record by record.
    expect((await records()).map((record) => record.batchStart)).toEqual([
      undefined,
      undefined,
    ]);
  });

  it('writes records admitted during a sync with one append and one sync', async () => {
    const writer = await open();
    const base = writer.revision;
    const before = journalSyncs;
    const held = holdBeforeSync(1);
    const settled: number[] = [];
    const admitted = [];
    for (const id of ['a', 'b', 'c', 'd', 'e']) {
      const admission = await admit(writer, id);
      void admission.durable.then(() => settled.push(admission.revision));
      admitted.push(admission);
    }
    // Admitted state is visible to the next admission at once.
    expect(writer.revision).toBe(base + 5);
    // Only the leader was appended; nothing is acknowledged before its sync.
    await appended(1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(journalWrites).toHaveLength(1);
    expect(journalSyncs - before).toBe(0);
    expect(settled).toEqual([]);
    held.open();
    await within(
      Promise.all(admitted.map((admission) => admission.durable)),
      'batched records become durable',
    );
    // Two appends and two syncs for five commits.
    expect(journalWrites).toHaveLength(2);
    expect(journalSyncs - before).toBe(2);
    expect(boundaries).toEqual([
      'record-written',
      'record-synced',
      'record-written',
      'record-synced',
    ]);
    // Acknowledged strictly in revision order.
    expect(settled).toEqual([1, 2, 3, 4, 5].map((step) => base + step));
    // The followers name the batch they were appended with.
    const written = await records();
    const batchStart = written[1].offset;
    expect(written.map((record) => record.batchStart)).toEqual([
      undefined,
      undefined,
      batchStart,
      batchStart,
      batchStart,
    ]);
    // A reopen replays every record.
    const reopened = await open();
    expect(reopened.revision).toBe(base + 5);
    expect(reopened.pendingRecordCount).toBe(5);
  });

  it('caps a batch at 256 records under continuous load', async () => {
    const writer = await open();
    const base = writer.revision;
    const held = holdBeforeSync(1);
    const total = 1 + GROUP_COMMIT_MAX_RECORDS * 2 + 10;
    const settledAtSync: number[] = [];
    const admitted = [];
    for (let index = 0; index < total; index += 1) {
      const admission = await admit(writer, `m${index}`, 't');
      // The journal syncs completed when this record was acknowledged.
      void admission.durable.then(() => settledAtSync.push(journalSyncs));
      admitted.push(admission);
    }
    const before = journalSyncs;
    held.open();
    await within(
      Promise.all(admitted.map((admission) => admission.durable)),
      'capped batches become durable',
    );
    // The leader, two full batches, the remainder.
    expect(journalWrites).toHaveLength(4);
    expect(journalSyncs - before).toBe(4);
    const written = await records();
    expect(written).toHaveLength(total);
    const sizes = new Map<number, number>();
    for (const record of written) {
      const start = record.batchStart ?? record.offset;
      sizes.set(start, (sizes.get(start) ?? 0) + 1);
    }
    expect(Array.from(sizes.values())).toEqual([
      1,
      GROUP_COMMIT_MAX_RECORDS,
      GROUP_COMMIT_MAX_RECORDS,
      10,
    ]);
    // A full batch does not wait for the records behind it: each record is
    // acknowledged by its own batch's sync.
    expect(settledAtSync).toEqual([
      before + 1,
      ...Array.from(
        { length: GROUP_COMMIT_MAX_RECORDS },
        (): number => before + 2,
      ),
      ...Array.from(
        { length: GROUP_COMMIT_MAX_RECORDS },
        (): number => before + 3,
      ),
      ...Array.from({ length: 10 }, (): number => before + 4),
    ]);
    expect((await open()).revision).toBe(base + total);
  });

  it('caps a batch at 1 MiB and writes a larger record alone', async () => {
    const writer = await open();
    const held = holdBeforeSync(1);
    const admitted = [await admit(writer, 'leader')];
    // Seven records of about 300 KiB: three fit under 1 MiB.
    for (let index = 0; index < 7; index += 1)
      admitted.push(
        await admit(writer, `big-${index}`, `${index}`.repeat(300 * 1024)),
      );
    // One record above the cap, then a small one.
    admitted.push(
      await admit(writer, 'huge', 'h'.repeat(GROUP_COMMIT_MAX_BYTES + 1)),
    );
    admitted.push(await admit(writer, 'small'));
    held.open();
    await within(
      Promise.all(admitted.map((admission) => admission.durable)),
      'byte-capped batches become durable',
    );
    const batches = journalWrites.slice(1);
    expect(batches).toHaveLength(5);
    // [3, 3, 1 + nothing more fits, the oversized record alone, the rest].
    for (const bytes of [batches[0], batches[1], batches[2], batches[4]])
      expect(bytes).toBeLessThanOrEqual(GROUP_COMMIT_MAX_BYTES);
    expect(batches[3]).toBeGreaterThan(GROUP_COMMIT_MAX_BYTES);
    const written = await records();
    const counts = new Map<number, number>();
    for (const record of written) {
      const start = record.batchStart ?? record.offset;
      counts.set(start, (counts.get(start) ?? 0) + 1);
    }
    expect(Array.from(counts.values())).toEqual([1, 3, 3, 1, 1, 1]);
  });

  it('applies a mutation id once across a batch and acknowledges its retry after the batch', async () => {
    const writer = await open();
    const base = writer.revision;
    const held = holdBeforeSync(1);
    const leader = await admit(writer, 'leader');
    const original = await admit(writer, 'retried');
    // The retry of a record that is admitted but not durable yet.
    let retryDurable = false;
    const retry = await within(
      writer.admit(titleCommit(writer, 'retried', 'again')),
      'a retry is admitted without waiting',
    );
    expect(retry.result).toEqual({ applied: false, revision: base + 2 });
    void retry.durable.then(() => {
      retryDurable = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    // Not acknowledged before the record it repeats is durable.
    expect(retryDurable).toBe(false);
    held.open();
    await within(
      Promise.all([leader.durable, original.durable, retry.durable]),
      'the retry is acknowledged with its batch',
    );
    expect(writer.revision).toBe(base + 2);
    expect(writer.hasMutation('retried')).toBe(true);
    expect(await records()).toHaveLength(2);
    // After a restart the retry is still a no-op.
    const reopened = await open();
    const again = await reopened.commit(
      titleCommit(reopened, 'retried', 'again'),
    );
    expect(again).toEqual({ applied: false, revision: base + 2 });
  });

  it('acknowledges a retry with the records admitted before it, not the batches admitted after', async () => {
    const writer = await open();
    const base = writer.revision;
    const first = await admit(writer, 'a');
    await within(first.durable, 'a is durable');
    // 'x' is appended and held before its sync.
    const held = holdBeforeSync(2);
    const x = await admit(writer, 'x');
    // A retry of the durable 'a', while 'x' is in flight.
    const retry = await within(
      writer.admit(titleCommit(writer, 'a', 'again')),
      'a retry is admitted without waiting',
    );
    expect(retry.result).toEqual({ applied: false, revision: base + 2 });
    // A batch admitted after the retry fails.
    failures.add('record-written#3');
    const late = await admit(writer, 'late');
    late.durable.catch(() => undefined);
    held.open();
    await within(x.durable, 'x is durable');
    // The retry depends only on what was admitted before it.
    await expect(
      within(retry.durable, 'the retry settles'),
    ).resolves.toBeUndefined();
    await expect(late.durable).rejects.toThrow('injected failure');
  });

  it('rejects every record of a failed batch and the records behind it', async () => {
    const writer = await open();
    const base = writer.revision;
    const held = holdBeforeSync(1);
    // The second append fails after its write: its records may be on disk.
    failures.add('record-written#2');
    const leader = await admit(writer, 'leader');
    const batch = [await admit(writer, 'b1'), await admit(writer, 'b2')];
    const late = titleCommit(writer, 'late', 'late');
    const outcomes: string[] = [];
    batch.forEach((admission, index): void => {
      void admission.durable.then(
        () => outcomes.push(`resolved ${index}`),
        () => outcomes.push(`rejected ${index}`),
      );
    });
    held.open();
    await within(leader.durable, 'the leader is durable');
    await expect(batch[0].durable).rejects.toThrow('injected failure');
    await expect(batch[1].durable).rejects.toThrow('injected failure');
    expect(outcomes).toEqual(['rejected 0', 'rejected 1']);
    // The writer is unusable: nothing more is admitted or written.
    expect(writer.isOpen()).toBe(false);
    await expect(writer.admit(late)).rejects.toThrow('must be reopened');
    const writes = journalWrites.length;
    // A reopen decides from the bytes on disk: the leader, and here the
    // whole written batch, since the process did not lose its page cache.
    const reopened = await open();
    expect(reopened.revision).toBe(base + 3);
    expect(journalWrites).toHaveLength(writes);
  });

  it('rejects the batches queued behind a failed batch', async () => {
    const writer = await open();
    const base = writer.revision;
    const heldLeader = holdBeforeSync(1);
    const heldSecond = holdBeforeSync(2);
    // The second batch fails after its sync returned: it may be durable.
    failures.add('record-synced#2');
    const leader = await admit(writer, 'leader');
    const second = [await admit(writer, 'b1'), await admit(writer, 'b2')];
    heldLeader.open();
    await within(leader.durable, 'the leader is durable');
    // The second batch is appended and held before its sync, so records
    // admitted now open a third batch behind it.
    await appended(2);
    const third = [await admit(writer, 'c1'), await admit(writer, 'c2')];
    const outcomes = [...second, ...third].map((admission) =>
      admission.durable.then(
        () => 'resolved',
        (error: unknown) =>
          error instanceof Error ? error.message : String(error),
      ),
    );
    heldSecond.open();
    expect(
      await within(Promise.all(outcomes), 'every record behind it settles'),
    ).toEqual(
      Array.from({ length: 4 }, () => 'injected failure at record-synced#2'),
    );
    // The third batch was never written, and nothing more is.
    expect(journalWrites).toHaveLength(2);
    expect(writer.isOpen()).toBe(false);
    // A reopen replays what reached the disk: the leader and the second
    // batch. The third batch is absent.
    const reopened = await open();
    expect(reopened.revision).toBe(base + 3);
  });

  it('discards the artifacts of a transaction that finds the writer unusable, and keeps those of a queued record', async () => {
    const writer = await open();
    const held = holdBeforeSync(1);
    // The leader's batch fails after its sync returned: it may be durable.
    failures.add('record-synced#1');
    /** A file a transaction externalized before it reached the writer. */
    const artifact = async (
      name: string,
    ): Promise<{ path: string; created: CreatedArtifacts }> => {
      const path = join(root, name);
      await writeFile(path, name);
      const created = new CreatedArtifacts();
      created.add(path);
      return { path, created };
    };
    const exists = (path: string): Promise<boolean> =>
      stat(path).then(
        () => true,
        () => false,
      );
    const queued = await artifact('queued.txt');
    const leader = await within(
      writer.admit({
        ...titleCommit(writer, 'leader', 'leader'),
        created: queued.created,
      }),
      'the leader is admitted',
    );
    leader.durable.catch(() => undefined);
    // Both wait for the writer while the leader's batch is in flight: the
    // inline commit drains the queue first, the admission follows it.
    const inline = await artifact('inline.txt');
    const inlineCommit = writer.commit({
      ...titleCommit(writer, 'inline', 'inline'),
      created: inline.created,
    });
    const late = await artifact('late.txt');
    const lateAdmission = writer.admit({
      ...titleCommit(writer, 'late', 'late'),
      created: late.created,
    });
    const outcomes = [inlineCommit, lateAdmission].map((work) =>
      work.then(
        () => 'resolved',
        (error: unknown) => (error instanceof Error ? error.message : ''),
      ),
    );
    await appended(1);
    held.open();
    await expect(leader.durable).rejects.toThrow('injected failure');
    expect(await within(Promise.all(outcomes), 'both are rejected')).toEqual([
      'Delta journal writer must be reopened',
      'Delta journal writer must be reopened',
    ]);
    // Neither record was queued, so neither can be durable: nothing
    // references its files.
    expect(await exists(inline.path)).toBe(false);
    expect(await exists(late.path)).toBe(false);
    // The leader was written and may be durable: its file stays.
    expect(await exists(queued.path)).toBe(true);
    expect(journalWrites).toHaveLength(1);
  });

  it('makes a checkpoint and an inline commit wait for an open batch', async () => {
    const writer = await open();
    const base = writer.revision;
    const held = holdBeforeSync(1);
    const admitted = [
      await admit(writer, 'a'),
      await admit(writer, 'b'),
      await admit(writer, 'c'),
    ];
    let batchDurable = false;
    void Promise.all(admitted.map((admission) => admission.durable)).then(
      () => {
        batchDurable = true;
      },
    );
    let durableAtCheckpoint: boolean | undefined;
    const checkpoint = writer.checkpoint().then((indexes) => {
      durableAtCheckpoint = batchDurable;
      return indexes;
    });
    const inline = writer.commit({
      expectedRevision: base + 3,
      next: titleCommit(writer, 'inline', 'inline').next,
      writes: [],
      mutationIds: ['inline'],
    });
    await appended(1);
    // Long enough for a checkpoint that did not wait to run to completion,
    // even on a loaded host: it must not start while the batch is unsynced.
    expect(await settlesWithin(checkpoint, 1_000)).toBe(false);
    expect(journalWrites).toHaveLength(1);
    held.open();
    const indexes = await within(checkpoint, 'the checkpoint runs');
    // Every admitted record was durable, then checkpointed.
    expect(durableAtCheckpoint).toBe(true);
    expect(indexes.live.revision).toBe(base + 3);
    await within(
      Promise.all(admitted.map((admission) => admission.durable)),
      'the batch is durable',
    );
    expect(await within(inline, 'the inline commit runs')).toMatchObject({
      applied: true,
      revision: base + 4,
    });
    expect(writer.pendingRecordCount).toBe(1);
    expect((await replayedScopeState(store)).revision).toBe(base + 4);
  });

  describe('recovery of a batch that was never synced', () => {
    it('drops the batch from its first damaged frame, keeping the tail for inspection', async () => {
      const writer = await open();
      const base = writer.revision;
      const leader = await admit(writer, 'leader');
      await within(leader.durable, 'the leader is durable');
      // 'x' is appended alone and held before its sync; 'y' and 'z' are
      // then appended together, and held before theirs.
      const heldX = holdBeforeSync(2);
      const heldBatch = holdBeforeSync(3);
      const x = await admit(writer, 'x');
      const y = await admit(writer, 'y');
      const z = await admit(writer, 'z');
      for (const admission of [y, z]) admission.durable.catch(() => undefined);
      heldX.open();
      await within(x.durable, 'x is durable');
      // Wait for the second batch's append.
      await appended(3);
      const written = await records();
      expect(written.map((record) => record.batchStart)).toEqual([
        undefined,
        undefined,
        undefined,
        written[2].offset,
      ]);
      // Power loss: the unsynced batch's first frame is garbage, its second
      // frame arrived intact.
      const bytes = await readFile(journalPath);
      bytes[written[2].offset + 60] ^= 0x5a;
      await writeFile(journalPath, bytes);
      void heldBatch;
      const reopened = await open();
      // Neither record of the unsynced batch is visible.
      expect(reopened.revision).toBe(base + 2);
      expect(diagnostics).toEqual([
        expect.objectContaining({
          kind: 'delta_journal_torn_tail_dropped',
          journalTailReason: 'checksum_mismatch',
          recordBytes: bytes.length - written[2].offset,
          journalQuarantineFile: 'delta-journal-tail-quarantine-1.bin',
        }),
      ]);
      expect(
        (await readdir(store.directory)).filter((name) =>
          name.startsWith('delta-journal-tail-quarantine-'),
        ),
      ).toEqual(['delta-journal-tail-quarantine-1.bin']);
      // The journal continues after the verified prefix.
      const next = await reopened.commit(titleCommit(reopened, 'after', 'x'));
      expect(next).toMatchObject({ applied: true, revision: base + 3 });
      expect((await replayedScopeState(store)).revision).toBe(base + 3);
    });

    it('fails closed when damage precedes a later batch', async () => {
      const writer = await open();
      const leader = await admit(writer, 'leader');
      await within(leader.durable, 'the leader is durable');
      const held = holdBeforeSync(2);
      const x = await admit(writer, 'x');
      const y = await admit(writer, 'y');
      const z = await admit(writer, 'z');
      held.open();
      await within(
        Promise.all([x.durable, y.durable, z.durable]),
        'both batches are durable',
      );
      // 'y' and 'z' were synced and acknowledged; a record of the batch
      // before them is damaged.
      const written = await records();
      const bytes = await readFile(journalPath);
      bytes[written[1].offset + 60] ^= 0x5a;
      await writeFile(journalPath, bytes);
      await expect(open()).rejects.toThrow(ChatDeltaJournalIntegrityError);
      // And so does damage inside an acknowledged batch that a later record
      // follows.
      const restored = Buffer.from(bytes);
      restored[written[1].offset + 60] ^= 0x5a;
      await writeFile(journalPath, restored);
      const reopened = await open();
      await reopened.commit(titleCommit(reopened, 'after', 'x'));
      const after = await readFile(journalPath);
      after[written[2].offset + 60] ^= 0x5a;
      await writeFile(journalPath, after);
      await expect(open()).rejects.toThrow(ChatDeltaJournalIntegrityError);
    });
  });
});
