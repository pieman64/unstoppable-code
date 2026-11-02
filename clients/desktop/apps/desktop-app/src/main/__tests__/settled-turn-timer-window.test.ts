/* eslint-disable @typescript-eslint/explicit-function-return-type, @typescript-eslint/require-await */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PersistedChatMessage } from '@canopy/desktop-shared/types';
import { ChatStateV2Repository } from '../services/chat-state-v2-repository';
import { ChatStateService } from '../services/chat-state-service';
import {
  observeTurn,
  turnEnded,
  turnStarted,
} from './helpers/turn-lifecycle-events';

// A small page makes the reducer window easy to overrun (audit §1, ocelot).
jest.mock('@canopy/agent-transcript/transcript-storage', () => ({
  ...jest.requireActual<object>('@canopy/agent-transcript/transcript-storage'),
  TRANSCRIPT_PAGE_SIZE: 20,
}));
jest.mock('../observability', () => ({
  getObservabilityService: () => ({ observeSteeringInput: jest.fn() }),
}));
jest.mock('../integration/claude-terminal-session-service', () => ({
  getClaudeTerminalSessionService: () => ({ getState: () => undefined }),
}));
jest.mock('../lib/usage-limited-chats-registry', () => ({
  recordInterruptedChats: () => Promise.resolve(),
}));

// Every provider event commits durably; a long turn takes seconds to build.
jest.setTimeout(60_000);

const SCOPE = { projectId: 'workspace-1', worktreeId: 'worktree-1' };
const CHAT_ID = 'chat-1';
const TURN = 'long-turn';
const STARTED_AT = 1_790_795_411_486;
const tagged = { canopy_turn_user_message_id: TURN };
const CHAT = { ...SCOPE, chatId: CHAT_ID };

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function isTimer(message: PersistedChatMessage): boolean {
  return message.blocks.some((block) => block.type === 'turn_timer');
}

/** A settled turn whose timer row sits `trailingRows` rows before its end. */
async function settledLongTurn(trailingRows: number) {
  const dir = mkdtempSync(join(tmpdir(), 'settled-turn-window-'));
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
      title: 'Long turn',
      providerType: 'claude',
      model: 'claude-opus-4-6',
    },
  });
  let sequence = 0;
  const ingest = (data: Record<string, unknown>, turnUserMessageId?: string) =>
    target.ingestProviderEvent({
      ...SCOPE,
      chatId: CHAT_ID,
      data,
      mutationId: `${CHAT_ID}:${TURN}:provider:${sequence++}`,
      ...(turnUserMessageId ? { turnUserMessageId } : {}),
    });
  await target.ingestProviderEvent({
    ...SCOPE,
    chatId: CHAT_ID,
    turnUserMessageId: TURN,
    data: {
      type: 'canopy_user_prompt',
      original_text: 'Work',
      canopy_turn_user_message_id: TURN,
      provider: 'claude',
      canopy_persisted_messages: [
        {
          id: TURN,
          role: 'user',
          timestamp: STARTED_AT,
          blocks: [{ type: 'text', text: 'Work' }],
        },
      ],
    },
  });
  let lifecycleSequence = 0;
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
  await lifecycle('start', 'long-turn-execution', [TURN]);
  clock.now += 1_000;
  await ingest(
    { type: 'system', subtype: 'init', session_id: 's', ...tagged },
    TURN,
  );
  for (let row = 0; row < trailingRows; row += 1) {
    await ingest(
      {
        type: 'assistant',
        uuid: `step-${row}`,
        message: {
          id: `step-${row}`,
          content: [{ type: 'text', text: `Step ${row}` }],
        },
        ...tagged,
      },
      TURN,
    );
  }
  clock.now += 1_000;
  await lifecycle('end', 'long-turn-execution', [TURN]);
  await ingest(
    { type: 'result', subtype: 'success', result: 'Done', ...tagged },
    TURN,
  );
  const timers = async () => {
    const state = await repository.getState(SCOPE, {
      chatIds: [CHAT_ID],
      fullTranscript: true,
    });
    return state.tabsFile.tabs[0].messages.filter(isTimer);
  };
  return { ingest, clock, timers, lifecycle };
}

describe('a wake after the turn outgrows the reducer window', () => {
  it.each([5, 30])(
    'opens its own timer for a background wake %s rows after the timer',
    async (trailingRows) => {
      const f = await settledLongTurn(trailingRows);
      const settled = await f.timers();
      expect(settled).toHaveLength(1);
      expect(settled[0].blocks[0]).toMatchObject({
        startedAt: STARTED_AT,
        completedAt: STARTED_AT + 2_000,
      });

      f.clock.now += 50_000;
      const resumedAt = f.clock.now;
      await f.lifecycle('start', 'wake-turn');
      await f.ingest({
        type: 'assistant',
        uuid: 'wake',
        message: { id: 'wake', content: [{ type: 'text', text: 'Woke' }] },
      });
      const live = await f.timers();
      // The settled turn's timer keeps its bytes; the wake gets its own.
      expect(live).toEqual([settled[0], expect.anything()]);
      expect(live[1].id).toBe('wake-turn:timer');
      expect(live[1].blocks[0]).toMatchObject({
        type: 'turn_timer',
        startedAt: resumedAt,
        completedAt: null,
      });

      f.clock.now += 3_000;
      await f.lifecycle('end', 'wake-turn');
      await f.ingest({ type: 'result', subtype: 'success', result: 'ok' });
      const done = await f.timers();
      expect(done).toEqual([settled[0], expect.anything()]);
      expect(done[1].blocks[0]).toMatchObject({
        startedAt: resumedAt,
        completedAt: f.clock.now,
      });
    },
  );
});
