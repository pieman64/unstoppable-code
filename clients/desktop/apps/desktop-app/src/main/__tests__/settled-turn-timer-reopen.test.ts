/* eslint-disable @typescript-eslint/explicit-function-return-type, @typescript-eslint/require-await */
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pauseOpenTurnTimer } from '@canopy/agent-transcript';
import type {
  ChatRuntimeState,
  PersistedChatMessage,
} from '@canopy/desktop-shared/types';
import { ChatTranscriptLog } from '../lib/chat-transcript-log';
import { releaseTurnTimerPause } from '../lib/settled-turn-timer-guard';
import { ChatStateV2Repository } from '../services/chat-state-v2-repository';
import { ChatStateService } from '../services/chat-state-service';
import {
  setChatTranscriptRewriteDiagnosticsForTests,
  type ChatTranscriptFullRewriteDiagnostic,
} from '../services/chat-transcript-rewrite-diagnostics';
import {
  observeTurn,
  turnEnded,
  turnStarted,
} from './helpers/turn-lifecycle-events';

jest.mock('../observability', () => ({
  getObservabilityService: () => ({ observeSteeringInput: jest.fn() }),
}));
jest.mock('../integration/claude-terminal-session-service', () => ({
  getClaudeTerminalSessionService: () => ({ getState: () => undefined }),
}));
jest.mock('../lib/usage-limited-chats-registry', () => ({
  recordInterruptedChats: () => Promise.resolve(),
}));

const SCOPE = { projectId: 'workspace-1', worktreeId: 'worktree-1' };
const CHAT_ID = 'chat-1';
const TURN = 'resumed-turn';
const STARTED_AT = 1_790_795_411_486;
const tagged = { canopy_turn_user_message_id: TURN };
const CHAT = { ...SCOPE, chatId: CHAT_ID };
const SETTLED_TIMER_ID = 'resumed-execution:timer';

const cleanups: Array<() => Promise<void>> = [];
const rewrites = jest.fn<void, [ChatTranscriptFullRewriteDiagnostic]>();
beforeEach(() => {
  rewrites.mockClear();
  setChatTranscriptRewriteDiagnosticsForTests({ sink: rewrites });
});
afterEach(async () => {
  jest.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) await cleanup();
  setChatTranscriptRewriteDiagnosticsForTests();
});

function isTimer(message: PersistedChatMessage): boolean {
  return message.blocks.some((block) => block.type === 'turn_timer');
}

/**
 * A resumed turn that has answered and not yet completed: the resume queue
 * dispatched a "Continue" prompt through the portal send path.
 */
async function answeredResumedTurn() {
  const dir = mkdtempSync(join(tmpdir(), 'settled-turn-timer-'));
  const repository = new ChatStateV2Repository({
    resolvePaths: () => ({
      tabs: join(dir, 'chats.json'),
      archives: join(dir, 'archives.json'),
      journal: join(dir, 'journal.jsonl'),
    }),
  });
  cleanups.push(async () => {
    await repository.drainAll();
    rmSync(dir, { recursive: true, force: true });
  });
  const clock = { now: STARTED_AT };
  const target = new ChatStateService({
    repository,
    now: () => clock.now,
    createId: () => 'event-id',
    dispatch: async () => undefined,
    onInputPickup: async () => undefined,
    authorizeSend: async () => undefined,
    cleanupSession: async () => undefined,
    recordDiagnostic: jest.fn(),
    inputSession: async () => undefined,
  });
  await target.command({
    schemaVersion: 1,
    commandId: 'create',
    ...SCOPE,
    command: {
      type: 'chat.create_tab',
      tabId: CHAT_ID,
      title: 'Resumed',
      providerType: 'claude',
      model: 'claude-opus-4-6',
    },
  });
  let sequence = 0;
  let lifecycleSequence = 0;
  /** Report a turn's canonical start or end, as the Claude adapter does. */
  const lifecycle = (
    type: 'start' | 'end',
    turnId: string,
    userMessageIds: string[] = [],
  ) => {
    const fields = {
      sequence: ++lifecycleSequence,
      turnId,
      atMs: clock.now,
      userMessageIds,
    };
    return observeTurn(
      target,
      type === 'start' ? turnStarted(CHAT, fields) : turnEnded(CHAT, fields),
    );
  };
  const ingest = (
    data: Record<string, unknown>,
    turnUserMessageId?: string,
  ): Promise<boolean> =>
    target.ingestProviderEvent({
      ...SCOPE,
      chatId: CHAT_ID,
      data,
      mutationId: `${CHAT_ID}:${TURN}:provider:initial:${sequence++}`,
      ...(turnUserMessageId ? { turnUserMessageId } : {}),
    });
  await target.ingestProviderEvent({
    ...SCOPE,
    chatId: CHAT_ID,
    turnUserMessageId: TURN,
    data: {
      type: 'canopy_user_prompt',
      original_text: 'Continue',
      canopy_turn_user_message_id: TURN,
      provider: 'claude',
      canopy_persisted_messages: [
        {
          id: TURN,
          role: 'user',
          timestamp: STARTED_AT,
          blocks: [{ type: 'text', text: 'Continue' }],
        },
      ],
    },
  });
  await lifecycle('start', 'resumed-execution', [TURN]);
  clock.now += 1_000;
  await ingest(
    { type: 'system', subtype: 'init', session_id: 's', ...tagged },
    TURN,
  );
  await ingest(
    {
      type: 'assistant',
      uuid: 'answer',
      message: { id: 'answer', content: [{ type: 'text', text: 'Done' }] },
      ...tagged,
    },
    TURN,
  );
  const read = async () => {
    const state = await target.getState(SCOPE);
    return {
      status: state.runtimeByChatId[CHAT_ID]?.status,
      timers: state.tabsFile.tabs[0].messages.filter(isTimer),
    };
  };
  const complete = async () => {
    await lifecycle('end', 'resumed-execution', [TURN]);
    return ingest(
      { type: 'result', subtype: 'success', result: 'Done', ...tagged },
      TURN,
    );
  };
  return {
    target,
    ingest,
    lifecycle,
    read,
    clock,
    complete,
    repository,
    dir,
  };
}

/** Reproduces the incident chat: the answered resumed turn then completed. */
async function settledResumedTurn() {
  const { ingest, lifecycle, read, clock, complete, repository, dir } =
    await answeredResumedTurn();
  clock.now += 1_000;
  await complete();
  const settled = await read();
  expect(settled.status).toBe('completed');
  expect(settled.timers).toHaveLength(1);
  expect(settled.timers[0].id).toBe(SETTLED_TIMER_ID);
  expect(settled.timers[0].blocks[0]).toMatchObject({
    type: 'turn_timer',
    startedAt: STARTED_AT,
    completedAt: STARTED_AT + 2_000,
  });
  const replace = jest.spyOn(ChatTranscriptLog.prototype, 'replace');
  const committedTimerBytes = () => {
    const path = readdirSync(dir, { recursive: true }).find(
      (entry) =>
        typeof entry === 'string' && entry.endsWith(`${CHAT_ID}.jsonl`),
    );
    if (typeof path !== 'string')
      throw new Error('Missing committed transcript');
    const row = readFileSync(join(dir, path), 'utf8')
      .split('\n')
      .find((line) => line.includes(settled.timers[0].id));
    if (row === undefined) throw new Error('Missing committed timer row');
    return row;
  };
  return {
    ingest,
    lifecycle,
    read,
    clock,
    settledTimer: settled.timers[0],
    replace,
    repository,
    committedTimerBytes,
  };
}

// These tests do real filesystem and git work. Under a loaded multi-worker
// Jest run they have exceeded Jest's default 5 s, so leave headroom here.
jest.setTimeout(30_000);

describe('settled turn timer ownership', () => {
  it('keeps a committed completion when a settled-turn follow-up would reopen it', async () => {
    const f = await settledResumedTurn();
    f.clock.now += 45_000;
    // Admitted by canFollowSettledProviderTurn; the runtime stays settled.
    await f.ingest(
      {
        type: 'system',
        subtype: 'init',
        session_id: 's',
        canopy_turn_revival: true,
        ...tagged,
      },
      TURN,
    );
    const after = await f.read();
    expect(after.status).toBe('completed');
    expect(after.timers).toEqual([f.settledTimer]);
    expect(f.replace).not.toHaveBeenCalled();
  });

  it('gives repeated background wakes their own timer rows without rewriting committed history', async () => {
    const f = await settledResumedTurn();
    for (const wake of [1, 2]) {
      f.clock.now += 50_000;
      const resumedAt = f.clock.now;
      await f.lifecycle('start', `wake-${wake}`);
      await f.ingest({
        type: 'assistant',
        uuid: `wake-${wake}`,
        message: {
          id: `wake-${wake}`,
          content: [{ type: 'text', text: `Wake ${wake}` }],
        },
      });
      const live = await f.read();
      expect(live.status).toBe('streaming');
      expect(live.timers[0]).toEqual(f.settledTimer);
      expect(live.timers[live.timers.length - 1].id).toBe(`wake-${wake}:timer`);
      const running = live.timers[live.timers.length - 1].blocks[0];
      expect(running).toMatchObject({
        type: 'turn_timer',
        startedAt: resumedAt,
        completedAt: null,
      });
      f.clock.now += 3_000;
      await f.lifecycle('end', `wake-${wake}`);
      await f.ingest({ type: 'result', subtype: 'success', result: 'ok' });
      const settled = await f.read();
      expect(settled.status).toBe('completed');
      expect(settled.timers).toHaveLength(1 + wake);
      expect(settled.timers[0]).toEqual(f.settledTimer);
      expect(settled.timers[settled.timers.length - 1].blocks[0]).toMatchObject(
        { startedAt: resumedAt, completedAt: f.clock.now },
      );
    }
    const { timers } = await f.read();
    // Visible duration counts work only: 2 s + 3 s + 3 s; idle gaps between
    // turns belong to no timer.
    const worked = timers
      .map((timer) => timer.blocks[0])
      .reduce((total, block): number => {
        if (block.type !== 'turn_timer' || block.completedAt === null) {
          return total;
        }
        if (block.startedAt === undefined) {
          throw new Error('Completed turn timers must have a start time');
        }
        return total + block.completedAt - block.startedAt;
      }, 0);
    expect(worked).toBe(8_000);
    expect(f.replace).not.toHaveBeenCalled();
  });

  it('does not rewrite the committed timer when a tool result revives the turn before assistant work', async () => {
    const f = await settledResumedTurn();
    f.clock.now += 50_000;
    await f.lifecycle('start', 'tool-result-wake');
    await f.ingest({
      type: 'user',
      uuid: 'late-result',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'background', content: 'ok' },
        ],
      },
    });
    f.clock.now += 1_000;
    await f.ingest({
      type: 'assistant',
      uuid: 'after-result',
      message: {
        id: 'after-result',
        content: [{ type: 'text', text: 'Saw it' }],
      },
    });
    const live = await f.read();
    expect(live.timers[0]).toEqual(f.settledTimer);
    expect(live.timers[live.timers.length - 1].blocks[0]).toMatchObject({
      completedAt: null,
    });
    expect(f.replace).not.toHaveBeenCalled();
  });
});

it.each(
  ['delegation', 'watcher', 'deferred-tools'].flatMap((source) =>
    [undefined, 2000, 1000].map((startOffset) => ({ source, startOffset })),
  ),
)(
  'keeps committed timer bytes for hidden $source deliveries with runtime start $startOffset',
  async ({ source, startOffset }) => {
    const f = await settledResumedTurn();
    if (startOffset !== undefined)
      await f.repository.transact(
        SCOPE,
        [
          {
            type: 'runtime.patched',
            chatId: CHAT_ID,
            runtime: {
              status: 'streaming',
              queuedMessageIds: [],
              activeTurn: {
                userMessageId: TURN,
                startedAt: STARTED_AT + startOffset,
              },
            },
          },
        ],
        { source: 'provider', chatIds: [CHAT_ID] },
      );
    const committed = f.committedTimerBytes();
    f.clock.now += 50000;
    const resumedAt = f.clock.now;
    await f.lifecycle('start', `${source}-wake`);
    for (const delivery of [1, 2]) {
      await f.ingest({
        type: 'canopy_user_prompt',
        canopy_hidden: true,
        canopy_turn_user_message_id: `hidden-${source}-${delivery}`,
        original_text: `${source} continuation`,
        source,
      });
      const live = await f.read();
      expect(live.timers).toHaveLength(2);
      expect(live.timers[0]).toEqual(f.settledTimer);
      expect(f.committedTimerBytes()).toBe(committed);
      expect(live.timers[1].id).toBe(`${source}-wake:timer`);
      expect(live.timers[1].blocks[0]).toMatchObject({
        type: 'turn_timer',
        startedAt: resumedAt,
        completedAt: null,
      });
      f.clock.now += 1000;
    }
    await f.lifecycle('end', `${source}-wake`);
    await f.ingest({ type: 'result', subtype: 'success', result: 'Wake done' });
    const finished = await f.read();
    expect(finished.timers).toHaveLength(2);
    expect(finished.timers[1].blocks[0]).toMatchObject({
      completedAt: f.clock.now,
    });
    expect(f.committedTimerBytes()).toBe(committed);
    expect(
      rewrites.mock.calls.filter(
        ([diagnostic]) =>
          diagnostic.reason === 'patch' &&
          diagnostic.chatTranscriptRewritePatchedBlockTypes.includes(
            'turn_timer',
          ),
      ),
    ).toEqual([]);
    f.replace.mockRestore();
  },
);

describe('a turn timer pause released after its turn settled', () => {
  const OWNER = 'approval:delegate';

  // A delegate's approval pauses its parent's timer outside the parent's event
  // commit chain, so its release can land after the parent's turn settled. The
  // canonical timer changes only through turn effects, so neither the pause
  // nor the late release may reopen it.
  it('leaves the settled timer completed instead of restarting it', async () => {
    const f = await answeredResumedTurn();
    const update = (
      change: (
        messages: PersistedChatMessage[],
        runtime: ChatRuntimeState | undefined,
      ) => PersistedChatMessage[],
    ) =>
      f.target.updateCompatibilityTab(SCOPE, CHAT_ID, (tab, runtime) => {
        const messages = change(tab.messages, runtime);
        return messages === tab.messages ? null : { ...tab, messages };
      });
    f.clock.now += 500;
    const pausedAt = f.clock.now;
    await update((messages) => pauseOpenTurnTimer(messages, pausedAt, OWNER));
    f.clock.now += 500;
    await f.complete();
    const settled = await f.read();
    expect(settled.status).toBe('completed');
    expect(settled.timers[0].blocks[0]).toMatchObject({
      startedAt: STARTED_AT,
      completedAt: STARTED_AT + 2_000,
    });
    f.clock.now += 3_000;
    const releasedAt = f.clock.now;
    await update((messages, runtime) =>
      releaseTurnTimerPause(messages, runtime, OWNER, releasedAt),
    );
    const after = await f.read();
    expect(after.status).toBe('completed');
    expect(after.timers).toEqual(settled.timers);
  });
});
