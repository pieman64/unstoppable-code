/**
 * Phase 10, recovery: with default journal storage, an in-progress
 * turn's rows exist only in memory and in journal records (no checkpoint
 * rewrites them into the active sidecar while the turn runs), so a restart
 * rebuilds the turn from the journal. The awaiting-user state and the turn
 * timer's pause owners are mutations like any other and must replay
 * identically; each has its own test. A long turn killed midway recovers
 * through its last acknowledged event, with both intact.
 */
import { appendFile, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  pauseOpenTurnTimer,
  resumePausedTurnTimer,
} from '@canopy/agent-transcript';
import type {
  ChatCoreMutation,
  ChatRuntimeState,
  PersistedChatMessage,
  PersistedPendingQuestion,
} from '@canopy/desktop-shared/types';
import type { ChatStateV2Repository } from '../services/chat-state-v2-repository';
import { createV2Scope } from './helpers/chat-delta-journal-harness';
import {
  drainOpenRepositories,
  manifestVersion,
  measureWork,
  repositoryAt,
  storeAt,
  text,
  upsert,
} from './helpers/chat-delta-journal-scope';
import {
  TURN_STARTED_AT,
  toolResultRow,
  toolUseRow,
  turnEnd,
  turnStart,
} from './helpers/chat-delta-journal-turn';

const SCOPE = { projectId: 'workspace', worktreeId: 'scope' };

/**
 * A tool's output on the assistant side of the turn, as provider sessions
 * persist it; a user-role row would end the turn-timer search.
 */
function toolOutput(call: number): PersistedChatMessage {
  return { ...toolResultRow('turn', call), role: 'assistant' };
}
const IDLE_MS = 20;
/** Repositories that stand in for a process that died never checkpoint. */
const INERT = { deltaJournalIdleCheckpointMs: 3_600_000 };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runtime(status: ChatRuntimeState['status']): ChatCoreMutation {
  return {
    type: 'runtime.patched',
    chatId: 'chat',
    runtime: {
      status,
      queuedMessageIds: [],
      activeTurn: { userMessageId: 'turn', startedAt: TURN_STARTED_AT },
    },
  };
}

const QUESTION: PersistedPendingQuestion = {
  requestId: 'ask-1',
  chatId: 'chat',
  toolUseId: 'turn-ask-tool',
  questions: [
    {
      id: '0',
      question: 'Which branch should the fix land on?',
      options: ['main', 'release'],
      allowOther: true,
    },
  ],
};

/** The ask-user prompt: its row, the pending question, awaiting input. */
function askUser(): ChatCoreMutation[] {
  return [
    upsert('chat', text('turn-ask', 'Which branch should the fix land on?')),
    { type: 'pending_question.upserted', question: QUESTION },
    runtime('awaiting_input'),
  ];
}

/** The user answers: the question is settled and the turn streams again. */
function answer(): ChatCoreMutation[] {
  return [
    {
      type: 'pending_question.upserted',
      question: {
        ...QUESTION,
        answers: [{ questionId: '0', answer: 'release' }],
        answeredAt: TURN_STARTED_AT + 9_000,
      },
    },
    runtime('streaming'),
  ];
}

let ordinal = 0;
async function commit(
  repository: ChatStateV2Repository,
  mutations: ChatCoreMutation[],
): Promise<void> {
  ordinal += 1;
  await repository.transact(SCOPE, mutations, {
    source: 'provider',
    mutationId: `event-${ordinal}`,
    chatIds: ['chat'],
  });
}

async function fullState(repository: ChatStateV2Repository): Promise<string> {
  return JSON.stringify(
    await repository.getState(SCOPE, {
      chatIds: ['chat'],
      fullTranscript: true,
    }),
  );
}

async function messages(
  repository: ChatStateV2Repository,
): Promise<PersistedChatMessage[]> {
  const state = await repository.getState(SCOPE, {
    chatIds: ['chat'],
    fullTranscript: true,
  });
  return state.tabsFile.tabs.find((tab) => tab.id === 'chat')?.messages ?? [];
}

/** Commit the rows a turn-timer helper changed, as the approval service does. */
async function updateTimer(
  repository: ChatStateV2Repository,
  change: (rows: PersistedChatMessage[]) => PersistedChatMessage[],
): Promise<void> {
  const rows = await messages(repository);
  const next = change(rows);
  const changed = next.filter((row, index) => row !== rows[index]);
  expect(changed).toHaveLength(1);
  await commit(
    repository,
    changed.map((row) => upsert('chat', row)),
  );
}

function timerBlock(rows: readonly PersistedChatMessage[]): unknown {
  return rows
    .find((row) => row.id === 'turn-timer')
    ?.blocks.find((block) => block.type === 'turn_timer');
}

async function sidecarExists(root: string): Promise<boolean> {
  try {
    await stat(
      join(storeAt(root, 'scope').directory, 'transcripts', 'chat.active.json'),
    );
    return true;
  } catch {
    return false;
  }
}

describe('delta journal active-turn recovery (phase 10)', () => {
  let root: string;
  jest.setTimeout(300_000);

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'chat-delta-journal-recovery-'));
    ordinal = 0;
  });

  afterEach(async () => {
    await drainOpenRepositories();

    await rm(root, { recursive: true, force: true });
  });

  async function seed(scopeRoot: string): Promise<void> {
    await createV2Scope(scopeRoot, 'scope', [
      { id: 'chat', messages: [text('m0', 'hello', 'user'), text('m1', 'hi')] },
    ]);
  }

  /**
   * The same steps without a crash: the state a recovered journal run
   * must finish in.
   */
  async function referenceRun(
    run: (repository: ChatStateV2Repository) => Promise<void>,
  ): Promise<string> {
    const scopeRoot = join(root, 'reference');
    await seed(scopeRoot);

    const repository = repositoryAt(scopeRoot);
    await repository.getState(SCOPE);
    const previous = ordinal;
    ordinal = 0;
    try {
      await run(repository);
      return await fullState(repository);
    } finally {
      ordinal = previous;
      await repository.drainAll();
    }
  }

  it('replays the awaiting-user state of an in-progress turn after a crash', async () => {
    const scopeRoot = join(root, 'on');
    await seed(scopeRoot);

    const first = repositoryAt(scopeRoot, {
      deltaJournalIdleCheckpointMs: IDLE_MS,
    });
    await first.getState(SCOPE);
    expect(await manifestVersion(storeAt(scopeRoot, 'scope'))).toBe(3);
    const beforeCrash = async (
      repository: ChatStateV2Repository,
    ): Promise<void> => {
      await commit(repository, turnStart('chat', 'turn'));
      await commit(repository, [upsert('chat', toolUseRow('turn', 0))]);
      await commit(repository, [upsert('chat', toolOutput(0))]);
      await commit(repository, askUser());
    };
    const afterCrash = async (
      repository: ChatStateV2Repository,
    ): Promise<void> => {
      await commit(repository, answer());
      await commit(repository, [upsert('chat', toolUseRow('turn', 1))]);
      await commit(repository, [upsert('chat', toolOutput(1))]);
      await commit(repository, turnEnd('chat', 'turn'));
    };
    await beforeCrash(first);
    // Idle windows pass: the turn stays in the journal.
    await sleep(IDLE_MS * 10);
    const acknowledged = await fullState(first);
    // The process dies: no drain, no checkpoint.
    const second = repositoryAt(scopeRoot, INERT);
    expect(await fullState(second)).toBe(acknowledged);
    const recovered = await second.getState(SCOPE, { chatIds: ['chat'] });
    expect(recovered.runtimeByChatId.chat?.status).toBe('awaiting_input');
    expect(recovered.runtimeByChatId.chat?.activeTurn?.userMessageId).toBe(
      'turn',
    );
    expect(recovered.tabsFile.pendingQuestions).toEqual([QUESTION]);
    expect((await messages(second)).map((row) => row.id)).toContain('turn-ask');
    // The revived turn goes on: the user answers and the turn finishes.
    await afterCrash(second);
    const final = await fullState(second);
    await second.drainAll();
    const reference = await referenceRun(async (repository) => {
      await beforeCrash(repository);
      await afterCrash(repository);
    });
    expect(final).toBe(reference);
  });

  it('replays the turn timer’s pause owners after a crash', async () => {
    const scopeRoot = join(root, 'on');
    await seed(scopeRoot);

    const first = repositoryAt(scopeRoot, {
      deltaJournalIdleCheckpointMs: IDLE_MS,
    });
    await first.getState(SCOPE);
    const beforeCrash = async (
      repository: ChatStateV2Repository,
    ): Promise<void> => {
      await commit(repository, turnStart('chat', 'turn'));
      await commit(repository, [upsert('chat', toolUseRow('turn', 0))]);
      // Two approval prompts pause the timer; the first one is answered.
      await updateTimer(repository, (rows) =>
        pauseOpenTurnTimer(rows, TURN_STARTED_AT + 1_000, 'approval-a'),
      );
      await updateTimer(repository, (rows) =>
        pauseOpenTurnTimer(rows, TURN_STARTED_AT + 2_000, 'approval-b'),
      );
      await updateTimer(repository, (rows) =>
        resumePausedTurnTimer(rows, TURN_STARTED_AT + 3_000, 'approval-a'),
      );
    };
    const afterCrash = async (
      repository: ChatStateV2Repository,
    ): Promise<void> => {
      // The second prompt is answered after the restart.
      await updateTimer(repository, (rows) =>
        resumePausedTurnTimer(rows, TURN_STARTED_AT + 7_000, 'approval-b'),
      );
      resumed.push(timerBlock(await messages(repository)));
      await commit(repository, [upsert('chat', toolOutput(0))]);
      await commit(repository, turnEnd('chat', 'turn'));
    };
    const resumed: unknown[] = [];
    await beforeCrash(first);
    await sleep(IDLE_MS * 10);
    const acknowledgedTimer = timerBlock(await messages(first));
    expect(acknowledgedTimer).toEqual({
      type: 'turn_timer',
      startedAt: TURN_STARTED_AT,
      completedAt: null,
      pausedAt: TURN_STARTED_AT + 1_000,
      resumedAt: null,
      pauseOwnerIds: ['approval-b'],
    });
    const acknowledged = await fullState(first);
    const second = repositoryAt(scopeRoot, INERT);
    expect(await fullState(second)).toBe(acknowledged);
    expect(timerBlock(await messages(second))).toEqual(acknowledgedTimer);
    await afterCrash(second);
    // The released owner resumed the timer from the replayed pause.
    expect(resumed[0]).toEqual({
      type: 'turn_timer',
      startedAt: TURN_STARTED_AT,
      completedAt: null,
      pausedAt: TURN_STARTED_AT + 1_000,
      resumedAt: TURN_STARTED_AT + 7_000,
      accumulatedPausedDurationMs: 6_000,
    });
    const final = await fullState(second);
    await second.drainAll();
    const reference = await referenceRun(async (repository) => {
      await beforeCrash(repository);
      await afterCrash(repository);
    });
    expect(final).toBe(reference);
  });

  it('recovers a long active turn killed midway through its last acknowledged event', async () => {
    const scopeRoot = join(root, 'on');
    await seed(scopeRoot);

    const first = repositoryAt(scopeRoot, {
      deltaJournalIdleCheckpointMs: IDLE_MS,
    });
    await first.getState(SCOPE);
    await commit(first, turnStart('chat', 'turn'));
    const sidecarAtTurnStart = await sidecarExists(scopeRoot);
    const turn = measureWork();
    let events = 0;
    const event = async (mutations: ChatCoreMutation[]): Promise<void> => {
      await commit(first, mutations);
      events += 1;
      // Tool calls pause the turn: idle windows come and go.
      if (events % 25 === 0) await sleep(IDLE_MS * 3);
    };
    for (let call = 0; call < 150; call += 1) {
      await event([upsert('chat', toolUseRow('turn', call))]);
      if (call === 60)
        await updateTimer(first, (rows) =>
          pauseOpenTurnTimer(rows, TURN_STARTED_AT + 60_000, 'approval-a'),
        );
      if (call === 90) await event(askUser());
      if (call === 120) await event(answer());
      await event([upsert('chat', toolOutput(call))]);
    }
    await event(askUser());
    await sleep(IDLE_MS * 10);
    const work = turn();
    // Nothing rewrote the turn into the active sidecar while it ran.
    expect(work.writtenByClass.activeSidecar ?? 0).toBe(0);
    expect(work.checkpoints).toBe(0);
    expect(await sidecarExists(scopeRoot)).toBe(sidecarAtTurnStart);
    const acknowledged = await fullState(first);
    // Killed while writing the next record: an unsynced partial frame.
    await appendFile(
      join(storeAt(scopeRoot, 'scope').directory, 'delta-journal.log'),
      Buffer.from('CDJ1\u0000\u0000\u0004\u0000partial', 'binary'),
    );
    const second = repositoryAt(scopeRoot, INERT);
    expect(await fullState(second)).toBe(acknowledged);
    const state = await second.getState(SCOPE, { chatIds: ['chat'] });
    expect(state.runtimeByChatId.chat?.status).toBe('awaiting_input');
    expect(state.tabsFile.pendingQuestions).toEqual([QUESTION]);
    const rows = await messages(second);
    expect(timerBlock(rows)).toEqual(
      expect.objectContaining({ pauseOwnerIds: ['approval-a'] }),
    );
    expect(
      rows.filter((row) => row.id.startsWith('turn-result-')),
    ).toHaveLength(150);
    await second.drainAll();
  });
});
