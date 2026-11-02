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
/** A watcher delivery's user message id (`watcher-<deliveryId>`). */
const REPLAYED = 'watcher-delivery-1';
const LATER = 'later-turn';
const NOW = 1_790_795_411_486;
const REPLAYED_MUTATION = `${CHAT_ID}:${REPLAYED}:user-prompt`;
const CHAT = { ...SCOPE, chatId: CHAT_ID };
/** The id main minted for the delivery's timer when it first ran, days ago. */
const HISTORICAL_TIMER_ID = `${CHAT_ID}:${REPLAYED_MUTATION}:0`;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function userRow(id: string, text: string, at: number): PersistedChatMessage {
  return { id, role: 'user', timestamp: at, blocks: [{ type: 'text', text }] };
}

const historicalTimer: PersistedChatMessage = {
  id: HISTORICAL_TIMER_ID,
  role: 'system',
  timestamp: NOW - 100_000,
  blocks: [
    {
      type: 'turn_timer',
      startedAt: NOW - 100_000,
      completedAt: NOW - 90_000,
    },
  ],
};

function isTimer(message: PersistedChatMessage): boolean {
  return message.blocks.some((block) => block.type === 'turn_timer');
}

function promptEvent(id: string, text: string) {
  return {
    type: 'canopy_user_prompt',
    original_text: text,
    canopy_turn_user_message_id: id,
    provider: 'claude',
    canopy_persisted_messages: [userRow(id, text, NOW)],
  };
}

/**
 * A chat whose committed transcript already holds a watcher delivery and its
 * settled timer, followed by a later completed turn. The delivery's original
 * mutation id has long been evicted from the bounded idempotency window.
 */
async function chatWithDeliveredWatcher() {
  const dir = mkdtempSync(join(tmpdir(), 'reprocessed-prompt-timer-'));
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
  const clock = { now: NOW };
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
      title: 'Watcher destination',
      providerType: 'claude',
      model: 'claude-opus-4-6',
    },
  });
  const history: PersistedChatMessage[] = [
    userRow(REPLAYED, 'Watcher fired', NOW - 100_000),
    historicalTimer,
    {
      id: 'delivery-answer',
      role: 'assistant',
      timestamp: NOW - 90_000,
      blocks: [{ type: 'text', text: 'Handled the watcher' }],
    },
  ];
  await repository.transact(
    SCOPE,
    history.map((message) => ({
      type: 'message.upserted' as const,
      chatId: CHAT_ID,
      message,
    })),
    { source: 'automation', mutationId: 'seed-history' },
  );
  // A later turn runs through the real ingest path and settles.
  await target.ingestProviderEvent({
    ...SCOPE,
    chatId: CHAT_ID,
    turnUserMessageId: LATER,
    mutationId: `${CHAT_ID}:${LATER}:user-prompt`,
    data: promptEvent(LATER, 'Later work'),
  });
  await observeTurn(
    target,
    turnStarted(CHAT, {
      sequence: 1,
      turnId: 'later-execution',
      atMs: clock.now,
      userMessageIds: [LATER],
    }),
  );
  clock.now += 1_000;
  const tagged = { canopy_turn_user_message_id: LATER };
  let sequence = 0;
  const ingestLater = (data: Record<string, unknown>) =>
    target.ingestProviderEvent({
      ...SCOPE,
      chatId: CHAT_ID,
      turnUserMessageId: LATER,
      mutationId: `${CHAT_ID}:${LATER}:provider:${sequence++}`,
      data: { ...data, ...tagged },
    });
  await ingestLater({ type: 'system', subtype: 'init', session_id: 's' });
  await ingestLater({
    type: 'assistant',
    uuid: 'later-answer',
    message: {
      id: 'later-answer',
      content: [{ type: 'text', text: 'Later done' }],
    },
  });
  clock.now += 1_000;
  await observeTurn(
    target,
    turnEnded(CHAT, {
      sequence: 2,
      turnId: 'later-execution',
      atMs: clock.now,
      userMessageIds: [LATER],
    }),
  );
  await ingestLater({ type: 'result', subtype: 'success', result: 'ok' });
  const read = async () => {
    const state = await target.getState(SCOPE);
    return {
      status: state.runtimeByChatId[CHAT_ID]?.status,
      messages: state.tabsFile.tabs[0].messages,
    };
  };
  const settled = await read();
  expect(settled.status).toBe('completed');
  expect(settled.messages.map((message) => message.id)).toContain(
    HISTORICAL_TIMER_ID,
  );
  expect(settled.messages[settled.messages.length - 1].id).not.toBe(REPLAYED);
  return { target, read, clock };
}

// These tests do real filesystem and git work. Under a loaded multi-worker
// Jest run they have exceeded Jest's default 5 s, so leave headroom here.
jest.setTimeout(60_000);

describe('re-processed user prompt turn timer ids', () => {
  it('re-sends a prompt already in the transcript without reusing its settled timer id', async () => {
    const f = await chatWithDeliveredWatcher();
    f.clock.now += 60_000;
    const resentAt = f.clock.now;

    await expect(
      f.target.ingestProviderEvent({
        ...SCOPE,
        chatId: CHAT_ID,
        turnUserMessageId: REPLAYED,
        mutationId: REPLAYED_MUTATION,
        data: promptEvent(REPLAYED, 'Watcher fired'),
      }),
    ).resolves.toBe(true);
    await observeTurn(
      f.target,
      turnStarted(CHAT, {
        sequence: 3,
        turnId: 'resent-execution',
        atMs: resentAt,
        userMessageIds: [REPLAYED],
      }),
    );

    const { messages } = await f.read();
    const ids = messages.map((message) => message.id);
    expect(new Set(ids).size).toBe(ids.length);
    // The historical timer keeps its settled completion, untouched.
    expect(
      messages.find((message) => message.id === HISTORICAL_TIMER_ID),
    ).toEqual(historicalTimer);
    // The prompt moved to the dispatch position with one open timer for the
    // new turn; every other timer stays completed.
    const promptIndex = ids.indexOf(REPLAYED);
    expect(promptIndex).toBe(messages.length - 2);
    // Canonical timer ids come from the turn, so a re-sent prompt can't
    // collide with the timer its first run committed.
    const timer = messages[messages.length - 1];
    expect(timer.id).toBe('resent-execution:timer');
    expect(timer.blocks).toEqual([
      expect.objectContaining({
        type: 'turn_timer',
        startedAt: resentAt,
        completedAt: null,
      }),
    ]);
    const openTimers = messages.filter(
      (message) =>
        isTimer(message) &&
        message.blocks.some(
          (block) => block.type === 'turn_timer' && block.completedAt === null,
        ),
    );
    expect(openTimers).toEqual([timer]);
  });
});
