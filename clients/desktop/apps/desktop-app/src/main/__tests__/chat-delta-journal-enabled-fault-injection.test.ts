/**
 * Fault injection with default journal storage, through the chat state
 * backend the repository uses: a crash after every counted file write, file
 * sync, atomic rename and directory sync of a sequence that promotes a
 * version 2 scope, commits through the journal (streaming records that stay
 * journaled, and records that change committed rows and are checkpointed
 * before they are acknowledged, coalescing the active runs before them),
 * takes the version 2 path for one large mutation (a temporary demotion that
 * holds the write order), promotes again, and finally demotes.
 *
 * After each crash, power loss may also drop or garble the journal's
 * unsynced suffix. A restarted backend must then load without error at a
 * revision between the last acknowledged and the last attempted commit, in a
 * consistent version 2 or version 3 scope, and equal the clean run at that
 * revision: nothing acknowledged lost, nothing unsynced applied, no empty or
 * truncated transcript, receipts and tombstones intact. A synced but
 * unacknowledged commit retried with its mutation id is not applied twice.
 * Finishing the sequence reaches the clean final state, version 2, with no
 * journal left.
 *
 * Transcript revisions are compared out: they count log operations, which a
 * recovered version 2 transaction may legitimately repeat.
 *
 * A second sequence (phase 10) crashes through an in-progress turn kept in
 * the journal: the awaiting-user state and a turn-timer pause owner, an idle
 * checkpoint that waits for the turn, a size checkpoint that writes the
 * turn's rows once, and the turn end whose rows reach the log through the
 * append with no sidecar rewrite.
 *
 * A third sequence (phase 11) crashes inside group commit: a leader record
 * and a batch of three admitted during its sync. A batch that was appended
 * but never synced is not visible after power loss, whether its bytes are
 * gone, cut inside it or damaged in its first frame; whole frames that
 * survive replay per commit; a batch that was synced replays completely even
 * though no commit in it was acknowledged, and retries of its mutation ids
 * return their receipts without applying again.
 */
import { statSync } from 'node:fs';
import fs, { cp, mkdtemp, rm, truncate } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatCoreMutation } from '@canopy/desktop-shared/types';
import type { PersistedChatMessage } from '@canopy/desktop-shared/types';
import * as workCounters from '@canopy/desktop-shared/node/work-counters';
import { ChatStorageV2 } from '../lib/chat-storage-v2';
import {
  DELTA_JOURNAL_FILE_NAME,
  scanDeltaJournalFrames,
} from '../lib/chat-delta-journal/format';
import { readDeltaJournal } from '../lib/chat-delta-journal/replay';
import {
  ChatStateV2Backend,
  type ChatStateV2BackendOptions,
} from '../services/chat-state-v2-backend';
import type {
  ProviderVisualAdmission,
  StagedVisual,
  VisualStagingSidecar,
  VisualStagingStore,
} from '../lib/chat-visual-contracts';
import {
  createV2Scope,
  replayedScopeState,
  seededRandom,
  v2ScopeState,
  type ScopeState,
} from './helpers/chat-delta-journal-harness';
import {
  idle,
  journalFiles,
  manifestVersion,
  streaming,
  text,
  toolResult,
  upsert,
} from './helpers/chat-delta-journal-scope';
import {
  TURN_STARTED_AT,
  timerRow,
  toolUseRow,
  turnEnd,
  turnStart,
} from './helpers/chat-delta-journal-turn';

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

const OPTIONS: ChatStateV2BackendOptions = {
  // One step below is larger than this and takes the version 2 path.
  deltaJournal: { largeRecordBytes: 4096 },
};

const VISUAL_ID = 'vis_123e4567-e89b-42d3-a456-426614174000';
const VISUAL_HTML = '<!doctype html><title>Journal visual</title>';

function visualAdmissionFixture(): {
  admission: ProviderVisualAdmission;
  readStaged: jest.Mock<Promise<StagedVisual | undefined>, [string, string]>;
} {
  const sha256 = createHash('sha256').update(VISUAL_HTML, 'utf8').digest('hex');
  const sidecar: VisualStagingSidecar = {
    version: 1,
    visualId: VISUAL_ID,
    chatId: 'chat',
    toolKey: 'show_visual',
    createdAt: 1,
    sha256,
    byteLength: Buffer.byteLength(VISUAL_HTML, 'utf8'),
    title: 'Journal visual',
    maxHeight: 400,
  };
  const candidate: StagedVisual = { sidecar, html: VISUAL_HTML };
  const readStaged = jest.fn(
    (chatId: string, visualId: string): Promise<StagedVisual | undefined> =>
      Promise.resolve(
        chatId === sidecar.chatId && visualId === sidecar.visualId
          ? candidate
          : undefined,
      ),
  );
  const staging: VisualStagingStore = {
    initialize: (): Promise<void> => Promise.resolve(),
    hasEntries: (): boolean => true,
    stagedIds: (): ReadonlySet<string> => new Set([VISUAL_ID]),
    stage: (): Promise<VisualStagingSidecar> => Promise.resolve(sidecar),
    readCandidate: readStaged,
    remove: (): Promise<void> => Promise.resolve(),
    removeChat: (): Promise<void> => Promise.resolve(),
    sweep: (): Promise<{ removed: number; remaining: number }> =>
      Promise.resolve({ removed: 0, remaining: 1 }),
  };
  return {
    admission: {
      staging,
      resolveToolKey: (call) =>
        call.toolName === 'ShowVisual' ? 'show_visual' : undefined,
      now: (): number => 10_000,
    },
    readStaged,
  };
}

function visualResultMutations(): ChatCoreMutation[] {
  const call: PersistedChatMessage = {
    id: 'visual-call',
    role: 'assistant',
    timestamp: 1,
    blocks: [
      {
        type: 'tool_use',
        toolUseId: 'visual-tool-use',
        toolName: 'ShowVisual',
        input: '{}',
      },
    ],
  };
  const result: PersistedChatMessage = {
    id: 'visual-result',
    role: 'assistant',
    timestamp: 2,
    blocks: [
      {
        type: 'tool_result',
        toolUseId: 'visual-tool-use',
        toolName: 'ShowVisual',
        output: `Rendered ${VISUAL_ID}`,
        isError: false,
      },
    ],
  };
  return [
    { type: 'message.upserted', chatId: 'chat', message: call },
    { type: 'message.upserted', chatId: 'chat', message: result },
  ];
}

type Step =
  | { kind: 'promote' }
  | { kind: 'demote' }
  | { kind: 'flush' }
  /** The repository's idle or size timer firing. */
  | { kind: 'checkpoint-timer' }
  | {
      kind: 'commit';
      mutationId: string;
      mutations: ChatCoreMutation[];
      commandId?: string;
    };

const STEPS: Step[] = [
  { kind: 'promote' },
  {
    kind: 'commit',
    mutationId: 'turn-start',
    mutations: [
      streaming('chat', 'p1'),
      upsert('chat', text('p1', 'go', 'user')),
    ],
  },
  {
    kind: 'commit',
    mutationId: 'stream-1',
    mutations: [upsert('chat', text('a1', 'partial'))],
  },
  {
    kind: 'commit',
    mutationId: 'stream-artifact',
    mutations: [upsert('chat', toolResult('t1', 'tool 🌲\n'.repeat(9000)))],
  },
  {
    kind: 'commit',
    mutationId: 'receipt',
    commandId: 'command-receipt',
    mutations: [
      {
        type: 'tab.metadata_patched',
        tabId: 'chat',
        patch: { title: 'With receipt' },
      },
    ],
  },
  {
    kind: 'commit',
    mutationId: 'stream-2',
    mutations: [upsert('chat', text('a1', 'partial, then more'))],
  },
  {
    kind: 'commit',
    mutationId: 'turn-end',
    mutations: [idle('chat')],
  },
  {
    kind: 'commit',
    mutationId: 'tombstone',
    mutations: [{ type: 'message.removed', chatId: 'chat', messageId: 'm1' }],
  },
  {
    kind: 'commit',
    mutationId: 'journaled-metadata',
    mutations: [
      { type: 'tab.metadata_patched', tabId: 'chat', patch: { unread: true } },
    ],
  },
  { kind: 'flush' },
  {
    kind: 'commit',
    mutationId: 'large',
    mutations: [upsert('chat', text('big', 'a large row '.repeat(800)))],
  },
  { kind: 'promote' },
  {
    kind: 'commit',
    mutationId: 'after-repromotion',
    mutations: [streaming('chat', 'p2')],
  },
  { kind: 'demote' },
];

/** A provider commit of `mutations`. */
function event(mutationId: string, mutations: ChatCoreMutation[]): Step {
  return { kind: 'commit', mutationId, mutations };
}

const AWAITING: ChatCoreMutation = {
  type: 'runtime.patched',
  chatId: 'chat',
  runtime: {
    status: 'awaiting_input',
    queuedMessageIds: [],
    activeTurn: { userMessageId: 'turn', startedAt: TURN_STARTED_AT },
  },
};

const QUESTION = {
  requestId: 'ask-1',
  chatId: 'chat',
  questions: [{ id: '0', question: 'Which branch?', options: ['main'] }],
};

/**
 * Phase 10: an in-progress turn kept in the journal, through its end, in the
 * fewest steps that crash at every boundary of the new paths once: an
 * active-upsert append, the idle trigger deferred while the turn holds active
 * rows, the geometric size trigger writing them once, and the turn end's
 * fused append (stage, sync, intent, finalize) followed by its index
 * checkpoint. The awaiting-user state and a timer pause owner ride along.
 */
const ACTIVE_TURN_STEPS: Step[] = [
  { kind: 'promote' },
  event('turn-start', turnStart('chat', 'turn')),
  event('call-0', [upsert('chat', toolUseRow('turn', 0))]),
  event('ask-and-pause', [
    upsert('chat', text('turn-ask', 'Which branch?')),
    { type: 'pending_question.upserted', question: QUESTION },
    AWAITING,
    upsert(
      'chat',
      timerRow('turn', {
        pausedAt: TURN_STARTED_AT + 1_000,
        resumedAt: null,
        pauseOwnerIds: ['approval-a'],
      }),
    ),
  ]),
  // Small journal: the idle timer waits for the turn and nothing is written.
  { kind: 'checkpoint-timer' },
  // A large draft then its short final form: the journal holds both, the
  // turn only the short one, so the journal passes eight times the turn's
  // rows and the size trigger writes them once.
  event('draft-large', [
    upsert('chat', text('turn-draft', 'draft '.repeat(2_000))),
  ]),
  event('draft-final-and-answer', [
    upsert('chat', text('turn-draft', 'draft')),
    {
      type: 'pending_question.upserted',
      question: {
        ...QUESTION,
        answers: [
          {
            questionId: '0',
            question: 'Which branch?',
            selectedOptions: ['main'],
          },
        ],
        answeredAt: TURN_STARTED_AT + 2_000,
      },
    },
    streaming('chat', 'turn'),
  ]),
  { kind: 'checkpoint-timer' },
  // A run after the size checkpoint, which the turn end's append finalizes.
  event('call-1', [upsert('chat', toolUseRow('turn', 1))]),
  // The turn ends: its rows reach the log through the append.
  event('turn-end', turnEnd('chat', 'turn')),
  { kind: 'demote' },
];

const ACTIVE_TURN_OPTIONS: ChatStateV2BackendOptions = {
  deltaJournal: { checkpointJournalBytes: 1 },
};

function withoutRevisions(key: string, value: unknown): unknown {
  if (key === 'transcriptRevision') return undefined;
  if (typeof value === 'string' && value.startsWith('{'))
    return JSON.parse(value, (inner: string, nested: unknown) =>
      inner === 'transcriptRevision' ? undefined : nested,
    );
  return value;
}

async function scopeState(store: ChatStorageV2): Promise<string> {
  const state: ScopeState =
    (await store.format()) === 'v3'
      ? await replayedScopeState(store)
      : await v2ScopeState(store);
  return JSON.stringify(state, withoutRevisions);
}

interface Progress {
  acknowledged: number;
  attempted: number;
}

describe('default delta journal fault injection', () => {
  let root: string;
  let template: string;
  let events = 0;
  let crashAt = Number.POSITIVE_INFINITY;
  let dead = false;
  let journalPath = '';
  let journalSynced = 0;
  /** While set, a journal sync waits for it (the mid-batch sequence). */
  let journalSyncHold: Promise<void> | undefined;

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
    root = await mkdtemp(join(tmpdir(), 'chat-delta-journal-enabled-faults-'));
    template = join(root, 'template');
    await createV2Scope(template, 'scope', [
      {
        id: 'chat',
        messages: [text('m0', 'hello', 'user'), text('m1', 'answer')],
      },
    ]);
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
      handle.sync = async (): Promise<void> => {
        if (path === journalPath && flags === 'r+') await journalSyncHold;
      };
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
    const makeDirectory = fs.mkdir;
    jest
      .spyOn(fs, 'mkdir')
      .mockImplementation((path, options) =>
        dead ? gone() : makeDirectory(path, options),
      );
    const copy = fs.copyFile;
    jest
      .spyOn(fs, 'copyFile')
      .mockImplementation((from, to, mode) =>
        dead ? gone() : copy(from, to, mode),
      );
    const counted = <T extends [string, ...unknown[]]>(
      original: (...args: T) => void,
    ): ((...args: T) => void) => {
      return (...args: T): void => {
        original(...args);
        event(args[0]);
      };
    };
    // Wrap the originals before the spies replace them.
    const write = counted(workCounters.recordChatStorageFileWrite);
    const directorySync = counted(workCounters.recordChatStorageDirectorySync);
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
    const replacement = workCounters.recordChatStorageAtomicReplacement;
    jest
      .spyOn(workCounters, 'recordChatStorageAtomicReplacement')
      .mockImplementation((path) => {
        if (path === journalPath && !dead)
          journalSynced = statSync(journalPath).size;
        replacement(path);
        event(path);
      });
    jest
      .spyOn(workCounters, 'recordChatStorageDirectorySync')
      .mockImplementation(directorySync);
  });

  afterEach(() => {
    journalSyncHold = undefined;
    jest.restoreAllMocks();
  });

  async function freshScope(label: string): Promise<ChatStorageV2> {
    const target = join(root, label);
    await cp(template, target, { recursive: true });
    const store = new ChatStorageV2(target, 'scope');
    journalPath = join(store.directory, DELTA_JOURNAL_FILE_NAME);
    journalSynced = 0;
    return store;
  }

  it.each([
    { label: 'format 2 metadata journal', deltaJournal: false },
    { label: 'format 3 delta journal', deltaJournal: true },
  ])(
    'recovers a promoted visual and its fence after $label publication',
    async ({ deltaJournal }) => {
      const store = await freshScope(`visual-${deltaJournal ? 'v3' : 'v2'}`);
      const options: ChatStateV2BackendOptions = deltaJournal
        ? { deltaJournal: {} }
        : {};
      const backend = new ChatStateV2Backend(store, options);
      await backend.load();
      if (deltaJournal) await backend.promoteToDeltaJournal();
      const { admission, readStaged } = visualAdmissionFixture();
      const metadataJournalPath = join(
        store.directory,
        'metadata-journal.jsonl',
      );
      const committedPath = deltaJournal ? journalPath : metadataJournalPath;
      const syncPath = deltaJournal
        ? (jest
            .mocked(workCounters.recordChatStorageFileSync)
            .getMockImplementation() ?? ((): void => undefined))
        : (jest
            .mocked(workCounters.recordChatStorageDirectorySync)
            .getMockImplementation() ?? ((): void => undefined));
      const sync = deltaJournal
        ? jest
            .spyOn(workCounters, 'recordChatStorageFileSync')
            .mockImplementation((path) => {
              syncPath(path);
              if (path === committedPath)
                throw new SimulatedCrash('crash after delta journal sync');
            })
        : jest
            .spyOn(workCounters, 'recordChatStorageDirectorySync')
            .mockImplementation((path) => {
              syncPath(path);
              if (path !== store.directory) return;
              try {
                if (statSync(committedPath).size > 0)
                  throw new SimulatedCrash('crash after metadata journal sync');
              } catch (error) {
                if (error instanceof SimulatedCrash) throw error;
              }
            });

      await expect(
        backend.transact(
          () => visualResultMutations(),
          { source: 'provider', chatIds: ['chat'] },
          admission,
        ),
      ).rejects.toThrow(SimulatedCrash);
      sync.mockRestore();
      backend.releaseJournal();
      readStaged.mockClear();

      const recovered = new ChatStateV2Backend(store, options);
      const indexes = await recovered.load();
      const state = await recovered.state({ chatIds: ['chat'] });
      const tab = state.tabsFile.tabs.find(
        (candidate) => candidate.id === 'chat',
      );
      const result = tab?.messages.find(
        (message) => message.id === 'visual-result',
      );
      const resultBlock = result?.blocks.find(
        (block) => block.type === 'tool_result',
      );

      expect(resultBlock).toMatchObject({
        type: 'tool_result',
        visualRef: { visualId: VISUAL_ID },
      });
      expect(indexes.recovery.visualOwnersByChatId?.chat?.[VISUAL_ID]).toEqual({
        messageId: 'visual-result',
        toolUseId: 'visual-tool-use',
        claimedAt: 10_000,
      });
      expect(readStaged).not.toHaveBeenCalled();
      await recovered.disposeArtifactMaintenance();
    },
  );

  async function runStep(
    backend: ChatStateV2Backend,
    step: Step,
  ): Promise<boolean> {
    if (step.kind === 'promote') {
      await backend.promoteToDeltaJournal();
      return false;
    }
    if (step.kind === 'demote') {
      await backend.demoteFromDeltaJournal();
      return false;
    }
    if (step.kind === 'flush') {
      await backend.flush();
      return false;
    }
    if (step.kind === 'checkpoint-timer') {
      await backend.checkpointPendingJournal('timer');
      return false;
    }
    // As the repository commits: admitted for group commit, acknowledged
    // once its record is durable. One commit at a time is a batch of one.
    const { commit, durable } = await backend.admit(() => step.mutations, {
      source: 'provider',
      mutationId: step.mutationId,
      chatIds: ['chat'],
      ...(step.commandId
        ? { commandResult: { commandId: step.commandId, outcome: 'applied' } }
        : {}),
    });
    if (durable) await durable;
    return commit.applied;
  }

  /** Run the steps from \`from\`; the returned index is the next step. */
  async function run(
    backend: ChatStateV2Backend,
    steps: readonly Step[],
    progress: Progress,
    from: number,
    onStep?: (index: number) => Promise<void>,
  ): Promise<number> {
    for (let index = from; index < steps.length; index += 1) {
      const step = steps[index];
      if (step.kind === 'commit') progress.attempted += 1;
      await runStep(backend, step);
      if (step.kind === 'commit') progress.acknowledged += 1;
      await onStep?.(index);
    }
    return steps.length;
  }

  interface Outcomes {
    runs: number;
    v2AfterCrash: number;
    v3AfterCrash: number;
    replayedUnacknowledged: number;
    tornTails: number;
    garbledTails: number;
  }

  /**
   * Run `steps` cleanly, recording the state at every acknowledged revision
   * and the counted events of each step, then crash a fresh copy at every
   * event and check recovery and completion against the clean run.
   */
  async function crashAtEveryEvent(
    steps: readonly Step[],
    options: ChatStateV2BackendOptions,
    seed: number,
    onCleanStep: (index: number, clean: ChatStorageV2) => Promise<void>,
  ): Promise<{ total: number; outcomes: Outcomes; stepEvents: number[] }> {
    const clean = await freshScope('clean');
    crashAt = Number.POSITIVE_INFINITY;
    dead = false;
    const cleanBackend = new ChatStateV2Backend(clean, options);
    await cleanBackend.load();
    events = 0;
    const references = new Map<number, string>();
    references.set(0, await scopeState(clean));
    const cleanProgress: Progress = { acknowledged: 0, attempted: 0 };
    const stepEvents: number[] = [];
    let before = 0;
    await run(cleanBackend, steps, cleanProgress, 0, async (index) => {
      stepEvents.push(events - before);
      references.set(cleanProgress.acknowledged, await scopeState(clean));
      await onCleanStep(index, clean);
      before = events;
    });
    const total = events;
    const final = await scopeState(clean);
    expect(await manifestVersion(clean)).toBe(2);
    expect(await journalFiles(clean)).toEqual([]);
    expect(total).toBeGreaterThan(100);
    await rm(join(root, 'clean'), { recursive: true, force: true });

    const random = seededRandom(seed);
    const outcomes: Outcomes = {
      runs: 0,
      v2AfterCrash: 0,
      v3AfterCrash: 0,
      replayedUnacknowledged: 0,
      tornTails: 0,
      garbledTails: 0,
    };
    for (let n = 1; n <= total; n += 1) {
      const store = await freshScope(`crash-${n}`);
      dead = false;
      crashAt = Number.POSITIVE_INFINITY;
      const crashing = new ChatStateV2Backend(store, options);
      await crashing.load();
      events = 0;
      crashAt = n;
      const progress: Progress = { acknowledged: 0, attempted: 0 };
      let next = 0;
      const crash: unknown = await run(
        crashing,
        steps,
        progress,
        0,
        (index) => {
          next = index + 1;
          return Promise.resolve();
        },
      ).then(
        () => undefined,
        (error: unknown) => error,
      );
      if (crash !== undefined && !isSimulatedCrash(crash))
        throw new Error(
          `Crash at event ${n} of ${total} failed otherwise: ${crash instanceof Error ? crash.message : typeof crash}`,
        );
      // The process is gone at event n. Cleanup after a demotion published
      // its version 2 manifest is best effort, so a crash there may not
      // surface as an error; what follows the crash point still must not
      // have happened (every later write throws) and recovery is checked
      // the same way.
      if (!dead)
        throw new Error(`Crash at event ${n} of ${total} did not happen`);
      outcomes.runs += 1;
      dead = false;
      crashAt = Number.POSITIVE_INFINITY;
      // Power loss: the journal's unsynced suffix may be cut or garbled.
      let size = 0;
      try {
        size = statSync(journalPath).size;
      } catch {
        size = 0;
      }
      const loss = random();
      if (size > journalSynced && journalSynced > 0 && loss < 0.4) {
        await truncate(
          journalPath,
          journalSynced + Math.floor(random() * (size - journalSynced)),
        );
        outcomes.tornTails += 1;
      } else if (size - journalSynced > 40 && journalSynced > 0 && loss < 0.8) {
        const bytes = await fs.readFile(journalPath);
        bytes[
          journalSynced +
            40 +
            Math.floor(random() * (size - journalSynced - 40))
        ] ^= 0x5a;
        await fs.writeFile(journalPath, bytes);
        outcomes.garbledTails += 1;
      }
      // Restart: a new backend loads, recovering whichever format the
      // manifest selects.
      const format = await manifestVersion(store);
      if (format === 3) outcomes.v3AfterCrash += 1;
      else outcomes.v2AfterCrash += 1;
      const recovered = new ChatStateV2Backend(store, options);
      let revision: number;
      try {
        revision = (await recovered.load()).live.revision;
      } catch (error) {
        throw new Error(
          `Recovery failed after a crash at event ${n} of ${total}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (revision < progress.acknowledged || revision > progress.attempted)
        throw new Error(
          `Crash at event ${n}: recovered revision ${revision} outside [${progress.acknowledged}, ${progress.attempted}]`,
        );
      // The hash chain of a surviving journal verifies.
      if ((await manifestVersion(store)) === 3)
        await readDeltaJournal(store.directory, 'scope');
      if ((await scopeState(store)) !== references.get(revision))
        throw new Error(
          `Crash at event ${n}: state at revision ${revision} differs from the clean run`,
        );
      // Finish: retry the interrupted step, then the rest.
      const retry = steps.at(next);
      if (retry?.kind === 'commit' && revision > progress.acknowledged) {
        outcomes.replayedUnacknowledged += 1;
        expect(await runStep(recovered, retry)).toBe(false);
        next += 1;
      }
      const finishing: Progress = {
        acknowledged: revision,
        attempted: revision,
      };
      await run(recovered, steps, finishing, next);
      if ((await scopeState(store)) !== final)
        throw new Error(`Crash at event ${n}: final state differs`);
      if ((await manifestVersion(store)) !== 2)
        throw new Error(`Crash at event ${n}: final scope is not version 2`);
      const leftovers = (await journalFiles(store)).filter(
        (name) => !name.startsWith('delta-journal-tail-quarantine-'),
      );
      if (leftovers.length)
        throw new Error(
          `Crash at event ${n}: journal files remain: ${leftovers.join(', ')}`,
        );
      await rm(join(root, `crash-${n}`), { recursive: true, force: true });
    }
    return { total, outcomes, stepEvents };
  }

  it('recovers every acknowledged commit after a crash at any event', async () => {
    let demotedForLarge = false;
    const { total, outcomes } = await crashAtEveryEvent(
      STEPS,
      OPTIONS,
      909,
      async (index, clean) => {
        const step = STEPS[index];
        // The large commit ran as version 2.
        if (step.kind === 'commit' && step.mutationId === 'large')
          demotedForLarge = (await manifestVersion(clean)) === 2;
      },
    );
    expect(demotedForLarge).toBe(true);
    if (process.env.DELTA_JOURNAL_FAULT_LOG === '1')
      process.stderr.write(
        `enabled fault injection: ${total} events, ${JSON.stringify(outcomes)}\n`,
      );
    expect(outcomes.v2AfterCrash).toBeGreaterThan(5);
    expect(outcomes.v3AfterCrash).toBeGreaterThan(20);
    expect(outcomes.replayedUnacknowledged).toBeGreaterThan(0);
    expect(outcomes.tornTails + outcomes.garbledTails).toBeGreaterThan(0);
  }, 900_000);

  it('recovers an in-progress turn kept in the journal after a crash at any event', async () => {
    const formats: number[] = [];
    const { total, outcomes, stepEvents } = await crashAtEveryEvent(
      ACTIVE_TURN_STEPS,
      ACTIVE_TURN_OPTIONS,
      1010,
      async (_index, clean) => {
        formats.push((await manifestVersion(clean)) ?? 0);
      },
    );
    const timers = ACTIVE_TURN_STEPS.flatMap((step, index) =>
      step.kind === 'checkpoint-timer' ? [stepEvents[index]] : [],
    );
    if (process.env.DELTA_JOURNAL_FAULT_LOG === '1')
      process.stderr.write(
        `active-turn fault injection: ${total} events, timer checkpoints ${JSON.stringify(timers)}, ${JSON.stringify(outcomes)}\n`,
      );
    // The first timer waits for the turn and writes nothing; the second
    // finds the journal past eight times the turn's rows and checkpoints.
    expect(timers[0]).toBe(0);
    expect(timers[1]).toBeGreaterThan(0);
    // Every commit of the turn stayed on the journal path.
    expect(formats.slice(1, -1).every((format) => format === 3)).toBe(true);
    expect(outcomes.v3AfterCrash).toBeGreaterThan(20);
    expect(outcomes.replayedUnacknowledged).toBeGreaterThan(0);
    expect(outcomes.tornTails + outcomes.garbledTails).toBeGreaterThan(0);
  }, 900_000);
  /**
   * Phase 11: a crash inside group commit. The burst below is admitted as a
   * leader record, written alone, and a batch of three admitted while the
   * leader's sync is in flight. Counted events of the burst, in order: the
   * leader's append, the leader's sync, the batch's append, the batch's sync.
   */
  const BURST: Array<Extract<Step, { kind: 'commit' }>> = [
    {
      kind: 'commit',
      mutationId: 'burst-leader',
      mutations: [upsert('chat', text('b1', 'leader'))],
    },
    {
      kind: 'commit',
      mutationId: 'burst-2',
      mutations: [upsert('chat', text('b2', 'first of the batch'))],
    },
    {
      kind: 'commit',
      mutationId: 'burst-3',
      commandId: 'command-burst',
      mutations: [upsert('chat', text('b3', 'second, with a receipt'))],
    },
    {
      kind: 'commit',
      mutationId: 'burst-4',
      mutations: [upsert('chat', text('b1', 'leader, updated'))],
    },
  ];
  const BEFORE_BURST: Step[] = [
    { kind: 'promote' },
    {
      kind: 'commit',
      mutationId: 'turn-start',
      mutations: [
        streaming('chat', 'p1'),
        upsert('chat', text('p1', 'go', 'user')),
      ],
    },
  ];
  const AFTER_BURST: Step[] = [
    { kind: 'commit', mutationId: 'turn-end', mutations: [idle('chat')] },
    { kind: 'demote' },
  ];

  /** What power loss does to the journal bytes that were never synced. */
  type Tail =
    | 'kept'
    | 'dropped'
    | 'cut-inside-second-frame'
    | 'first-frame-damaged';

  it('recovers a consistent state after a crash at every step of a batch', async () => {
    const options: ChatStateV2BackendOptions = { deltaJournal: {} };
    const commitOptions = (
      step: Extract<Step, { kind: 'commit' }>,
    ): Parameters<ChatStateV2Backend['admit']>[1] => ({
      source: 'provider',
      mutationId: step.mutationId,
      chatIds: ['chat'],
      ...(step.commandId
        ? { commandResult: { commandId: step.commandId, outcome: 'applied' } }
        : {}),
    });

    // Reference: the same commits one at a time, with the state at every
    // revision. A batch changes how records reach the disk, not what they
    // mean.
    crashAt = Number.POSITIVE_INFINITY;
    dead = false;
    const reference = await freshScope('batch-reference');
    const referenceBackend = new ChatStateV2Backend(reference, options);
    await referenceBackend.load();
    const references = new Map<number, string>();
    const sequential: Progress = { acknowledged: 0, attempted: 0 };
    references.set(0, await scopeState(reference));
    await run(
      referenceBackend,
      [...BEFORE_BURST, ...BURST],
      sequential,
      0,
      async () => {
        references.set(sequential.acknowledged, await scopeState(reference));
      },
    );
    const base = sequential.acknowledged - BURST.length;
    await run(referenceBackend, AFTER_BURST, sequential, 0);
    const final = await scopeState(reference);
    await rm(join(root, 'batch-reference'), { recursive: true, force: true });

    /** Run the burst as a leader and a batch; resolves when all settled. */
    const burst = async (
      backend: ChatStateV2Backend,
    ): Promise<{ acknowledged: number }> => {
      let release = (): void => undefined;
      journalSyncHold = new Promise<void>((resolve) => {
        release = resolve;
      });
      const durables: Array<Promise<void>> = [];
      try {
        for (const step of BURST) {
          const admission = await backend.admit(
            () => step.mutations,
            commitOptions(step),
          );
          if (!admission.durable)
            throw new Error(`${step.mutationId} was not group committed`);
          durables.push(admission.durable);
        }
      } catch (error) {
        // A crash at the leader's append fails the admissions behind it.
        if (!dead) throw error;
      } finally {
        journalSyncHold = undefined;
        release();
      }
      const outcomes = await Promise.allSettled(durables);
      return {
        acknowledged: outcomes.filter(
          (outcome) => outcome.status === 'fulfilled',
        ).length,
      };
    };

    // A clean batched run: four counted events for four commits.
    const clean = await freshScope('batch-clean');
    const cleanBackend = new ChatStateV2Backend(clean, options);
    await cleanBackend.load();
    await run(cleanBackend, BEFORE_BURST, { acknowledged: 0, attempted: 0 }, 0);
    events = 0;
    expect(await burst(cleanBackend)).toEqual({ acknowledged: BURST.length });
    expect(events).toBe(4);
    expect(await scopeState(clean)).toBe(references.get(base + BURST.length));
    await run(cleanBackend, AFTER_BURST, { acknowledged: 0, attempted: 0 }, 0);
    expect(await scopeState(clean)).toBe(final);
    await rm(join(root, 'batch-clean'), { recursive: true, force: true });

    const cases: Array<{
      crashAtEvent: number;
      tail: Tail;
      /** Burst commits visible after recovery. */
      visible: number;
      quarantined?: true;
    }> = [
      // The leader's append, never synced.
      { crashAtEvent: 1, tail: 'dropped', visible: 0 },
      { crashAtEvent: 1, tail: 'kept', visible: 1 },
      // The leader's sync: durable, not acknowledged; the batch never written.
      { crashAtEvent: 2, tail: 'kept', visible: 1 },
      // The batch's append, never synced.
      { crashAtEvent: 3, tail: 'dropped', visible: 1 },
      { crashAtEvent: 3, tail: 'cut-inside-second-frame', visible: 2 },
      {
        crashAtEvent: 3,
        tail: 'first-frame-damaged',
        visible: 1,
        quarantined: true,
      },
      { crashAtEvent: 3, tail: 'kept', visible: 4 },
      // The batch's sync: durable, no commit in it acknowledged.
      { crashAtEvent: 4, tail: 'kept', visible: 4 },
    ];
    for (let index = 0; index < cases.length; index += 1) {
      const scenario = cases[index];
      const label = `crash at burst event ${scenario.crashAtEvent}, unsynced tail ${scenario.tail}`;
      const store = await freshScope(`batch-crash-${index}`);
      dead = false;
      crashAt = Number.POSITIVE_INFINITY;
      const crashing = new ChatStateV2Backend(store, options);
      await crashing.load();
      await run(crashing, BEFORE_BURST, { acknowledged: 0, attempted: 0 }, 0);
      events = 0;
      crashAt = scenario.crashAtEvent;
      const { acknowledged } = await burst(crashing);
      if (!dead) throw new Error(`${label}: the crash did not happen`);
      // Nothing is acknowledged before its own batch's sync was counted.
      expect(acknowledged).toBe(scenario.crashAtEvent > 2 ? 1 : 0);
      dead = false;
      crashAt = Number.POSITIVE_INFINITY;
      // Power loss: what happens to the bytes past the last synced one.
      const bytes = await fs.readFile(journalPath);
      const frames = scanDeltaJournalFrames(bytes).frames.filter(
        (frame) => frame.offset >= journalSynced,
      );
      if (scenario.tail === 'dropped')
        await truncate(journalPath, journalSynced);
      else if (scenario.tail === 'cut-inside-second-frame')
        await truncate(journalPath, frames[1].offset + 60);
      else if (scenario.tail === 'first-frame-damaged') {
        bytes[frames[0].offset + 60] ^= 0x5a;
        await fs.writeFile(journalPath, bytes);
      }
      const recovered = new ChatStateV2Backend(store, options);
      let revision: number;
      try {
        revision = (await recovered.load()).live.revision;
      } catch (error) {
        throw new Error(
          `${label}: recovery failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      // Never less than what was acknowledged, and exactly the frames that
      // survived whole.
      if (revision !== base + scenario.visible)
        throw new Error(
          `${label}: recovered ${revision - base} burst commits, expected ${scenario.visible}`,
        );
      expect(scenario.visible).toBeGreaterThanOrEqual(acknowledged);
      await readDeltaJournal(store.directory, 'scope');
      if ((await scopeState(store)) !== references.get(revision))
        throw new Error(`${label}: state differs from the clean run`);
      expect(
        (await journalFiles(store)).some((name) =>
          name.startsWith('delta-journal-tail-quarantine-'),
        ),
      ).toBe(scenario.quarantined === true);
      // Retries: a commit that replayed is not applied again, and keeps its
      // receipt; the others apply now.
      for (let position = 0; position < BURST.length; position += 1) {
        const step = BURST[position];
        const replayed = position < scenario.visible;
        if (replayed && step.commandId)
          expect(
            (await recovered.load()).recovery.receipts.map(
              (receipt) => receipt.commandId,
            ),
          ).toContain(step.commandId);
        expect(await runStep(recovered, step)).toBe(!replayed);
      }
      expect(await scopeState(store)).toBe(references.get(base + BURST.length));
      await run(recovered, AFTER_BURST, { acknowledged: 0, attempted: 0 }, 0);
      if ((await scopeState(store)) !== final)
        throw new Error(`${label}: final state differs`);
      expect(await manifestVersion(store)).toBe(2);
      await rm(join(root, `batch-crash-${index}`), {
        recursive: true,
        force: true,
      });
    }
  }, 300_000);
});
