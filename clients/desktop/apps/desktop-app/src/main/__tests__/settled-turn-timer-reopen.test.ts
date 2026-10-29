/* eslint-disable @typescript-eslint/explicit-function-return-type, @typescript-eslint/require-await */
import { mkdtempSync, rmSync } from 'node:fs';
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

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  jest.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function isTimer(message: PersistedChatMessage): boolean {
  return message.blocks.some((block) => block.type === 'turn_timer');
}

/**
 * A resumed turn that has answered and not yet completed: the resume queue
 * dispatched a "Continue" prompt through the portal send path, whose
 * untracked prompt ingestion names the timer `<chatId>:<sha256>:0`.
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
    steer: async () => false,
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
    const state = await target.getState(SCOPE, { chatIds: [CHAT_ID] });
    return {
      status: state.runtimeByChatId[CHAT_ID]?.status,
      timers: state.tabsFile.tabs[0].messages.filter(isTimer),
    };
  };
  const complete = () =>
    ingest(
      { type: 'result', subtype: 'success', result: 'Done', ...tagged },
      TURN,
    );
  return { target, ingest, read, clock, complete };
}

/** Reproduces the incident chat: the answered resumed turn then completed. */
async function settledResumedTurn() {
  const { ingest, read, clock, complete } = await answeredResumedTurn();
  clock.now += 1_000;
  await complete();
  const settled = await read();
  expect(settled.status).toBe('completed');
  expect(settled.timers).toHaveLength(1);
  expect(settled.timers[0].id).toMatch(/^chat-1:[0-9a-f]{64}:0$/);
  expect(settled.timers[0].blocks[0]).toEqual({
    type: 'turn_timer',
    startedAt: STARTED_AT,
    completedAt: STARTED_AT + 2_000,
  });
  const replace = jest.spyOn(ChatTranscriptLog.prototype, 'replace');
  return { ingest, read, clock, settledTimer: settled.timers[0], replace };
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

  it('continues repeated background revivals on new timer rows without rewriting committed history', async () => {
    const f = await settledResumedTurn();
    for (const wake of [1, 2]) {
      f.clock.now += 50_000;
      const resumedAt = f.clock.now;
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
      const running = live.timers[live.timers.length - 1].blocks[0];
      expect(running).toMatchObject({
        type: 'turn_timer',
        startedAt: STARTED_AT,
        resumedAt,
        completedAt: null,
      });
      f.clock.now += 3_000;
      await f.ingest({ type: 'result', subtype: 'success', result: 'ok' });
      const settled = await f.read();
      expect(settled.status).toBe('completed');
      expect(settled.timers).toHaveLength(1 + wake);
      expect(settled.timers[0]).toEqual(f.settledTimer);
      expect(settled.timers[settled.timers.length - 1].blocks[0]).toMatchObject(
        { completedAt: f.clock.now, resumedAt },
      );
    }
    const { timers } = await f.read();
    // Visible duration counts work only: 2 s + 3 s + 3 s; idle gaps are paused.
    const last = timers[timers.length - 1].blocks[0];
    expect(last.type).toBe('turn_timer');
    if (last.type === 'turn_timer' && last.completedAt !== null)
      expect(
        last.completedAt - STARTED_AT - (last.accumulatedPausedDurationMs ?? 0),
      ).toBe(8_000);
    expect(f.replace).not.toHaveBeenCalled();
  });

  it('does not rewrite the committed timer when a tool result revives the turn before assistant work', async () => {
    const f = await settledResumedTurn();
    f.clock.now += 50_000;
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

describe('a turn timer pause released after its turn settled', () => {
  const OWNER = 'approval:delegate';

  async function pausedAtCompletion() {
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
    // A delegate's approval pauses its parent's timer outside the parent's
    // event commit chain, so it can land before the parent's terminal event.
    f.clock.now += 500;
    const pausedAt = f.clock.now;
    await update((messages) => pauseOpenTurnTimer(messages, pausedAt, OWNER));
    f.clock.now += 500;
    await f.complete();
    const settled = await f.read();
    expect(settled.status).toBe('completed');
    expect(settled.timers[0].blocks[0]).toMatchObject({
      pausedAt,
      resumedAt: null,
      completedAt: null,
    });
    return { ...f, update, pausedAt };
  }

  it('completes the timer instead of restarting it', async () => {
    const f = await pausedAtCompletion();
    f.clock.now += 3_000;
    const releasedAt = f.clock.now;
    await f.update((messages, runtime) =>
      releaseTurnTimerPause(messages, runtime, OWNER, releasedAt),
    );
    const after = await f.read();
    expect(after.status).toBe('completed');
    expect(after.timers).toHaveLength(1);
    expect(after.timers[0].blocks[0]).toEqual({
      type: 'turn_timer',
      startedAt: STARTED_AT,
      pausedAt: f.pausedAt,
      resumedAt: releasedAt,
      accumulatedPausedDurationMs: releasedAt - f.pausedAt,
      completedAt: releasedAt,
    });
  });

  it('keeps the timer paused while another owner still holds it', async () => {
    const f = await pausedAtCompletion();
    await f.update((messages) =>
      pauseOpenTurnTimer(messages, f.clock.now, 'approval:other'),
    );
    f.clock.now += 3_000;
    const releasedAt = f.clock.now;
    await f.update((messages, runtime) =>
      releaseTurnTimerPause(messages, runtime, OWNER, releasedAt),
    );
    const after = await f.read();
    expect(after.timers[0].blocks[0]).toMatchObject({
      pausedAt: f.pausedAt,
      resumedAt: null,
      completedAt: null,
      pauseOwnerIds: ['approval:other'],
    });
  });
});
