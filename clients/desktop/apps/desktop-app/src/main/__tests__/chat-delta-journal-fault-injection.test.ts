/**
 * Fault injection: a crash after every write, sync and rename of the commit
 * and checkpoint sequences, then recovery.
 *
 * A clean run of a fixed sequence (commits creating, streaming, finalizing,
 * patching, deleting and replacing chats, with tool outputs externalized to
 * artifacts, receipts and tombstones, and checkpoints in between) counts the
 * durability events: every counted file write, file sync, atomic rename and
 * directory sync, plus the writer's own boundaries. Then, for every event n,
 * a fresh copy of the starting scope runs the sequence and the process
 * "dies" at event n: from then on every file-system mutation fails. For the
 * journal, the unsynced suffix may additionally be lost (power loss), leaving
 * a torn tail.
 *
 * After each crash the scope must reopen without `recovery_error` at some
 * revision between the last acknowledged and the last attempted commit, and
 * equal the clean run at that revision: no acknowledged commit lost, nothing
 * unsynced applied, no empty or truncated transcript, receipts and tombstones
 * intact. Retrying a synced but unacknowledged commit returns
 * `applied: false`; finishing the sequence then reaches the clean final
 * state through an intact hash chain.
 */
import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import fs, { cp, mkdtemp, rm, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PersistedChatMessage } from '@canopy/desktop-shared/types';
import * as workCounters from '@canopy/desktop-shared/node/work-counters';
import { ChatStorageV2 } from '../lib/chat-storage-v2';
import type { ChatStorageIndexes } from '../lib/chat-storage-transactions';
import { DELTA_JOURNAL_FILE_NAME } from '../lib/chat-delta-journal/format';
import { readDeltaJournal } from '../lib/chat-delta-journal/replay';
import {
  ChatDeltaJournalWriter,
  promoteToDeltaJournal,
  type DeltaJournalCommitInput,
  type DeltaJournalWrite,
} from '../lib/chat-delta-journal/writer';
import {
  createV2Scope,
  message,
  replayedScopeState,
  seededRandom,
  toolMessage,
  type ScopeState,
} from './helpers/chat-delta-journal-harness';

class SimulatedCrash extends Error {
  public override readonly name = 'SimulatedCrash';
}

/**
 * A simulated crash, raw or as the cause of a typed storage failure: on
 * Windows a folder flush after the crash opens read-write and so reports it
 * as a `DirectoryFlushError` (CAN-5151 D1).
 */
function isSimulatedCrash(error: unknown): boolean {
  for (let current = error, depth = 0; depth < 8; depth += 1) {
    if (current instanceof SimulatedCrash) return true;
    if (!(current instanceof Error)) return false;
    current = current.cause;
  }
  return false;
}

type Step =
  | { kind: 'checkpoint' }
  | {
      kind: 'commit';
      mutationId: string;
      edit: (next: ChatStorageIndexes) => void;
      writes: DeltaJournalWrite[];
    };

const EMPTY_DESCRIPTOR = {
  format: 'complete-message-jsonl-v1' as const,
  committedMessageCount: 0,
  committedByteLength: 0,
  transcriptRevision: 0,
  hasActiveSidecar: false,
};

const big = (label: string): PersistedChatMessage =>
  toolMessage(label, `${label} output 🌲\n`.repeat(5000));

function setRuntime(
  next: ChatStorageIndexes,
  chatId: string,
  status: 'idle' | 'streaming',
): void {
  next.live.runtimeByChatId = {
    ...next.live.runtimeByChatId,
    [chatId]: {
      status,
      queuedMessageIds: [],
      ...(status === 'streaming'
        ? { activeTurn: { userMessageId: 'p1', startedAt: 5 } }
        : {}),
    },
  };
}

const STEPS: Step[] = [
  {
    kind: 'commit',
    mutationId: 'create-new',
    edit: (next): void => {
      next.live.tabs.push({
        id: 'new',
        title: 'New',
        createdAt: '2026-10-01',
        transcript: { ...EMPTY_DESCRIPTOR },
      });
    },
    writes: [
      {
        chatId: 'new',
        kind: 'append',
        messages: [message('n0', 'new chat', 'user'), big('n1')],
      },
    ],
  },
  {
    kind: 'commit',
    mutationId: 'stream-start',
    edit: (next): void => setRuntime(next, 'chat', 'streaming'),
    writes: [
      {
        chatId: 'chat',
        kind: 'active',
        messages: [message('p1', 'prompt', 'user'), message('a1', 'partial')],
      },
    ],
  },
  {
    kind: 'commit',
    mutationId: 'stream-more',
    edit: (): void => undefined,
    writes: [
      {
        chatId: 'chat',
        kind: 'active-upsert',
        messages: [message('a1', 'partial, then more'), big('a2')],
      },
    ],
  },
  { kind: 'checkpoint' },
  {
    kind: 'commit',
    mutationId: 'stream-end',
    edit: (next): void => setRuntime(next, 'chat', 'idle'),
    writes: [
      {
        chatId: 'chat',
        kind: 'append',
        messages: [
          message('p1', 'prompt', 'user'),
          message('a1', 'partial, then more'),
          big('a2'),
        ],
      },
    ],
  },
  {
    kind: 'commit',
    mutationId: 'remove-first',
    edit: (next): void => {
      next.recovery.removedMessageIds = [
        ...next.recovery.removedMessageIds,
        'm0',
      ];
      next.recovery.receipts = [
        ...next.recovery.receipts,
        {
          commandId: 'command-remove',
          revision: next.live.revision,
          outcome: 'applied',
        },
      ];
    },
    writes: [
      {
        chatId: 'chat',
        kind: 'patch',
        patches: [message('a1', 'edited after the turn')],
        removedMessageIds: ['m0'],
        tail: [],
      },
    ],
  },
  {
    kind: 'commit',
    mutationId: 'delete-new',
    edit: (next): void => {
      next.live.tabs = next.live.tabs.filter((tab) => tab.id !== 'new');
      next.recovery.removedTabIds = [...next.recovery.removedTabIds, 'new'];
    },
    writes: [{ chatId: 'new', kind: 'delete' }],
  },
  {
    kind: 'commit',
    mutationId: 'replace-chat',
    edit: (next): void => {
      next.live.tabs = next.live.tabs.map((tab) =>
        tab.id === 'chat' ? { ...tab, title: 'Replaced' } : tab,
      );
    },
    writes: [
      {
        chatId: 'chat',
        kind: 'replace',
        messages: [message('r0', 'imported', 'user'), message('r1', 'reply')],
      },
    ],
  },
  { kind: 'checkpoint' },
];

function commitInput(
  writer: ChatDeltaJournalWriter,
  step: Extract<Step, { kind: 'commit' }>,
): DeltaJournalCommitInput {
  const current = writer.indexes();
  const next = structuredClone(current);
  next.live.revision += 1;
  next.archive.revision += 1;
  next.recovery.mutationIds = [...next.recovery.mutationIds, step.mutationId];
  step.edit(next);
  return {
    expectedRevision: current.live.revision,
    next,
    writes: step.writes,
    mutationIds: [step.mutationId],
  };
}

/** Transcript revisions count operations, which recovery may repeat. */
function withoutTranscriptRevisions(_key: string, value: unknown): unknown {
  if (_key === 'transcriptRevision') return undefined;
  if (typeof value === 'string' && value.startsWith('{')) {
    const parsed: unknown = JSON.parse(value, (key: string, inner: unknown) =>
      key === 'transcriptRevision' ? undefined : inner,
    );
    return parsed;
  }
  return value;
}

function normalized(state: ScopeState): string {
  return JSON.stringify(state, withoutTranscriptRevisions);
}

interface Run {
  acknowledged: number;
  attempted: number;
}

describe('delta journal fault injection', () => {
  let root: string;
  let template: string;
  let events = 0;
  let crashAt = Number.POSITIVE_INFINITY;
  let dead = false;
  let journalSynced = 0;
  let journalPath = '';
  const references = new Map<number, string>();

  /** One durability event in the scope under test (not reader scratch). */
  const event = (path: string): void => {
    if (!path.startsWith(root)) return;
    if (dead) throw new SimulatedCrash('process is gone');
    events += 1;
    if (events === crashAt) {
      dead = true;
      throw new SimulatedCrash(`crash at event ${events}`);
    }
  };

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'chat-delta-journal-faults-'));
    template = join(root, 'template');
    const store = await createV2Scope(template, 'scope', [
      {
        id: 'chat',
        messages: [message('m0', 'hello', 'user'), message('m1', 'answer')],
      },
    ]);
    await promoteToDeltaJournal(store);
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  beforeEach(() => {
    const open = fs.open;
    jest.spyOn(fs, 'open').mockImplementation(async (path, flags, mode) => {
      if (dead && flags !== undefined && flags !== 'r')
        throw new SimulatedCrash('process is gone');
      const handle = await open(path, flags, mode);
      // The syscall's cost is irrelevant; its position in the order is
      // what the counters below observe.
      handle.sync = (): Promise<void> => Promise.resolve();
      return handle;
    });
    const gone = (): Promise<never> =>
      Promise.reject(new SimulatedCrash('process is gone'));
    const remove = fs.rm;
    jest
      .spyOn(fs, 'rm')
      .mockImplementation((path, options) =>
        dead ? gone() : remove(path, options),
      );
    const move = fs.rename;
    jest
      .spyOn(fs, 'rename')
      .mockImplementation((from, to) => (dead ? gone() : move(from, to)));
    const shorten = fs.truncate;
    jest
      .spyOn(fs, 'truncate')
      .mockImplementation((path, length) =>
        dead ? gone() : shorten(path, length),
      );
    const counted = <T extends [string, ...unknown[]]>(
      original: (...args: T) => void,
    ): ((...args: T) => void) => {
      return (...args: T): void => {
        original(...args);
        event(args[0]);
      };
    };
    const write = counted(workCounters.recordChatStorageFileWrite);
    const replacement = counted(
      workCounters.recordChatStorageAtomicReplacement,
    );
    const directory = counted(workCounters.recordChatStorageDirectorySync);
    jest
      .spyOn(workCounters, 'recordChatStorageFileWrite')
      .mockImplementation(write);
    const sync = workCounters.recordChatStorageFileSync;
    jest
      .spyOn(workCounters, 'recordChatStorageFileSync')
      .mockImplementation((path) => {
        sync(path);
        if (path === journalPath && !dead)
          journalSynced = statSync(journalPath).size;
        event(path);
      });
    jest
      .spyOn(workCounters, 'recordChatStorageAtomicReplacement')
      .mockImplementation((path) => {
        // A rotated journal was synced as a temporary before its rename.
        if (path === journalPath && !dead)
          journalSynced = statSync(journalPath).size;
        replacement(path);
      });
    jest
      .spyOn(workCounters, 'recordChatStorageDirectorySync')
      .mockImplementation(directory);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  async function freshScope(label: string): Promise<ChatStorageV2> {
    const target = join(root, label);
    await cp(template, target, { recursive: true });
    const store = new ChatStorageV2(target, 'scope');
    journalPath = join(store.directory, DELTA_JOURNAL_FILE_NAME);
    journalSynced = statSync(journalPath).size;
    return store;
  }

  /** Copy a scope (directory and manifest) to a new root. */
  async function freshCopy(
    source: ChatStorageV2,
    label: string,
  ): Promise<ChatStorageV2> {
    const target = join(root, label);
    await cp(join(source.directory, '..', '..'), target, { recursive: true });
    const store = new ChatStorageV2(target, 'scope');
    journalPath = join(store.directory, DELTA_JOURNAL_FILE_NAME);
    return store;
  }

  /** The bytes of every quarantined journal tail, in quarantine order. */
  async function quarantined(store: ChatStorageV2): Promise<Buffer[]> {
    const names = (await fs.readdir(store.directory))
      .filter((name) => /^delta-journal-tail-quarantine-\d+\.bin$/.test(name))
      .sort();
    return Promise.all(
      names.map((name) => fs.readFile(join(store.directory, name))),
    );
  }

  /** Run the sequence from the writer's current revision. */
  async function run(
    writer: ChatDeltaJournalWriter,
    progress: Run,
    onCommitted?: (revision: number) => Promise<void>,
  ): Promise<void> {
    let revision = 0;
    for (const step of STEPS) {
      if (step.kind === 'checkpoint') {
        if (revision >= writer.revision) await writer.checkpoint();
        continue;
      }
      revision += 1;
      if (revision <= writer.revision) continue;
      progress.attempted = revision;
      const result = await writer.commit(commitInput(writer, step));
      expect(result.applied).toBe(true);
      progress.acknowledged = revision;
      await onCommitted?.(revision);
    }
  }

  it('recovers every acknowledged commit after a crash at any event', async () => {
    // The clean run: reference states and the number of events.
    const clean = await freshScope('clean');
    crashAt = Number.POSITIVE_INFINITY;
    events = 0;
    const writer = await ChatDeltaJournalWriter.open(clean);
    events = 0;
    references.set(0, normalized(await replayedScopeState(clean)));
    await run(writer, { acknowledged: 0, attempted: 0 }, async (revision) => {
      references.set(revision, normalized(await replayedScopeState(clean)));
    });
    const total = events;
    const final = normalized(await replayedScopeState(clean));
    expect(total).toBeGreaterThan(40);

    const random = seededRandom(97);
    const outcomes = {
      commitCrashes: 0,
      checkpointCrashes: 0,
      replayedUnacknowledged: 0,
      tornTails: 0,
      quarantinedTails: 0,
      nestedCrashes: 0,
    };
    for (let n = 1; n <= total; n += 1) {
      const store = await freshScope(`crash-${n}`);
      events = 0;
      dead = false;
      crashAt = Number.POSITIVE_INFINITY;
      const crashing = await ChatDeltaJournalWriter.open(store);
      events = 0;
      crashAt = n;
      const progress: Run = { acknowledged: 0, attempted: 0 };
      const crash: unknown = await run(crashing, progress).then(
        () => undefined,
        (error: unknown) => error,
      );
      if (!isSimulatedCrash(crash))
        throw new Error(
          `Crash at event ${n} of ${total} did not happen: ${String(crash)}`,
        );
      if (progress.attempted > progress.acknowledged)
        outcomes.commitCrashes += 1;
      else outcomes.checkpointCrashes += 1;
      dead = false;
      crashAt = Number.POSITIVE_INFINITY;
      // Power loss: the journal may keep only part of its unsynced suffix,
      // or all of it with garbage content (a full-length unsynced write).
      const size = statSync(journalPath).size;
      let garbledTail: Buffer | undefined;
      const loss = random();
      if (size > journalSynced && loss < 0.4) {
        await truncate(
          journalPath,
          journalSynced + Math.floor(random() * (size - journalSynced)),
        );
        outcomes.tornTails += 1;
      } else if (size - journalSynced > 40 && loss < 0.8) {
        const bytes = await fs.readFile(journalPath);
        bytes[
          journalSynced +
            40 +
            Math.floor(random() * (size - journalSynced - 40))
        ] ^= 0x5a;
        await fs.writeFile(journalPath, bytes);
        garbledTail = bytes.subarray(journalSynced);
        outcomes.quarantinedTails += 1;
      }
      let recovered: ChatDeltaJournalWriter;
      try {
        recovered = await ChatDeltaJournalWriter.open(store);
      } catch (error) {
        throw new Error(
          `Recovery failed after a crash at event ${n} of ${total}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (garbledTail) {
        // Excluded from replay, kept byte for byte, and truncated.
        expect(statSync(journalPath).size).toBe(journalSynced);
        expect(await quarantined(store)).toEqual([garbledTail]);
      }
      const revision = recovered.revision;
      if (revision < progress.acknowledged || revision > progress.attempted)
        throw new Error(
          `Crash at event ${n}: recovered revision ${revision} outside [${progress.acknowledged}, ${progress.attempted}]`,
        );
      const state = normalized(await replayedScopeState(store));
      if (state !== references.get(revision))
        throw new Error(
          `Crash at event ${n}: state at revision ${revision} differs from the clean run`,
        );
      if (revision > progress.acknowledged) {
        outcomes.replayedUnacknowledged += 1;
        // The synced but unacknowledged commit is retried with the same
        // mutation id: it is already applied and is not applied twice.
        let ordinal = 0;
        const step = STEPS.find(
          (candidate) =>
            candidate.kind === 'commit' && (ordinal += 1) === revision,
        );
        if (step?.kind !== 'commit') throw new Error('Missing step');
        const before = createHash('sha256')
          .update(await fs.readFile(journalPath))
          .digest('hex');
        expect(recovered.hasMutation(step.mutationId)).toBe(true);
        expect(await recovered.commit(commitInput(recovered, step))).toEqual({
          applied: false,
          revision,
        });
        expect(
          createHash('sha256')
            .update(await fs.readFile(journalPath))
            .digest('hex'),
        ).toBe(before);
      }
      let finishing = recovered;
      if (n % 5 === 0) {
        // A second crash while recovery's continuation (and any resumed
        // checkpoint) runs; recovery must be restartable.
        events = 0;
        crashAt = 1 + Math.floor(random() * 40);
        const second: Run = { acknowledged: revision, attempted: revision };
        const nested: unknown = await run(finishing, second)
          .then(() => finishing.checkpoint())
          .then(
            () => undefined,
            (error: unknown) => error,
          );
        dead = false;
        crashAt = Number.POSITIVE_INFINITY;
        if (nested !== undefined && !isSimulatedCrash(nested))
          throw Object.assign(
            new Error(`Continuation after event ${n} failed`),
            {
              cause: nested,
            },
          );
        if (nested) outcomes.nestedCrashes += 1;
        finishing = await ChatDeltaJournalWriter.open(store);
        if (
          finishing.revision < second.acknowledged ||
          finishing.revision > second.attempted ||
          normalized(await replayedScopeState(store)) !==
            references.get(finishing.revision)
        )
          throw new Error(`Nested crash after event ${n} lost state`);
      }
      await run(finishing, {
        acknowledged: finishing.revision,
        attempted: finishing.revision,
      });
      await finishing.checkpoint();
      // The chain is intact and the outcome matches the clean run.
      await readDeltaJournal(store.directory, 'scope');
      if (normalized(await replayedScopeState(store)) !== final)
        throw new Error(`Crash at event ${n}: final state differs`);
      await rm(join(root, `crash-${n}`), { recursive: true, force: true });
    }
    if (process.env.DELTA_JOURNAL_FAULT_LOG === '1')
      process.stderr.write(
        `fault injection: ${total} events, ${JSON.stringify(outcomes)}\n`,
      );
    // Both edges of the acknowledgement boundary were exercised.
    expect(outcomes.commitCrashes).toBeGreaterThan(10);
    expect(outcomes.checkpointCrashes).toBeGreaterThan(10);
    expect(outcomes.replayedUnacknowledged).toBeGreaterThan(0);
    expect(outcomes.tornTails).toBeGreaterThan(0);
    expect(outcomes.quarantinedTails).toBeGreaterThan(0);
    expect(outcomes.nestedCrashes).toBeGreaterThan(5);
  }, 600_000);

  it('quarantines a garbled tail exactly once across a crash at any recovery step', async () => {
    // A scope whose last record was written in full but never synced, then
    // damaged by power loss: complete length, bad checksum.
    const source = await freshScope('garbled-source');
    dead = false;
    crashAt = Number.POSITIVE_INFINITY;
    const writer = await ChatDeltaJournalWriter.open(source);
    const first = STEPS[0];
    if (first.kind !== 'commit') throw new Error('Missing step');
    await writer.commit(commitInput(writer, first));
    const expected = normalized(await replayedScopeState(source));
    const validEnd = statSync(journalPath).size;
    const second = STEPS[1];
    if (second.kind !== 'commit') throw new Error('Missing step');
    await writer.commit(commitInput(writer, second));
    const bytes = await fs.readFile(journalPath);
    bytes[bytes.length - 7] ^= 0x5a;
    await fs.writeFile(journalPath, bytes);
    const tail = bytes.subarray(validEnd);

    // Count the recovery's durability events once, without crashing.
    const probe = await freshCopy(source, 'garbled-probe');
    events = 0;
    await ChatDeltaJournalWriter.open(probe);
    const total = events;
    expect(total).toBeGreaterThanOrEqual(4);

    for (let k = 1; k <= total; k += 1) {
      const store = await freshCopy(source, `garbled-${k}`);
      events = 0;
      crashAt = k;
      await expect(ChatDeltaJournalWriter.open(store)).rejects.toBeInstanceOf(
        SimulatedCrash,
      );
      dead = false;
      crashAt = Number.POSITIVE_INFINITY;
      // Recovery after the crash: one quarantine with the exact bytes, no
      // leftover temporary, the tail truncated, the state unchanged.
      const recovered = await ChatDeltaJournalWriter.open(store);
      expect(await quarantined(store)).toEqual([tail]);
      expect(
        (await fs.readdir(store.directory)).filter((name) =>
          name.endsWith('.tmp'),
        ),
      ).toEqual([]);
      expect(statSync(journalPath).size).toBe(validEnd);
      expect(normalized(await replayedScopeState(store))).toBe(expected);
      // A further reopen changes nothing, and appends continue.
      await ChatDeltaJournalWriter.open(store);
      expect(await quarantined(store)).toEqual([tail]);
      await recovered.commit(commitInput(recovered, second));
      expect(recovered.revision).toBe(2);
      await rm(join(root, `garbled-${k}`), { recursive: true, force: true });
    }
  }, 120_000);
});
