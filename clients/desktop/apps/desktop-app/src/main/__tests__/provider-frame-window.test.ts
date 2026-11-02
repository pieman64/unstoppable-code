/* eslint-disable @typescript-eslint/explicit-function-return-type, @typescript-eslint/require-await */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ChatRuntimeState,
  PersistedChatMessage,
} from '@canopy/desktop-shared/types';
import {
  applyClaudeTranscriptEvent,
  applyCodexTranscriptEvent,
  type TranscriptReducerState,
} from '@canopy/agent-transcript';
import { ChatStateV2Repository } from '../services/chat-state-v2-repository';
import { ChatStateService } from '../services/chat-state-service';
import type { CanonicalChatState } from '../services/chat-state-reducer';
import {
  observeTurn,
  turnEnded,
  turnStarted,
  type TurnLifecycleFields,
} from './helpers/turn-lifecycle-events';

// Keep the provider read window small while preserving the production reducer.
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

jest.setTimeout(120_000);

const SCOPE = { projectId: 'workspace-1', worktreeId: 'worktree-1' };
const CHAT_ID = 'chat-1';
const ORIGINAL_HUMAN_ID = 'human-original';
const ORIGINAL_TIMER_ID = 'timer-original';
const WATCHER_PROMPT_ID = 'watcher-prompt';
const CODEX_ROOT_THREAD_ID = 'codex-root-thread';
const BASE_TIME = 1_790_795_411_486;

type Provider = 'claude' | 'codex';

interface ProviderFrameEvent {
  data: Record<string, unknown>;
  reducerEvent: Record<string, unknown>;
}

interface Harness {
  provider: Provider;
  repository: ChatStateV2Repository;
  service: ChatStateService;
  clock: { now: number };
  nextMutationId(label: string): string;
  /** Report a turn's canonical start or end, as the provider adapter does. */
  lifecycle(
    type: 'start' | 'end',
    fields: Omit<TurnLifecycleFields, 'sequence' | 'atMs'>,
  ): Promise<void>;
}

interface DifferentialResult {
  beforeWindow: CanonicalChatState;
  beforeFull: CanonicalChatState;
  afterFull: CanonicalChatState;
  expectedMessages: PersistedChatMessage[];
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function chatMessages(state: CanonicalChatState): PersistedChatMessage[] {
  const tab = state.tabsFile.tabs.find((candidate) => candidate.id === CHAT_ID);
  if (!tab) throw new Error(`Missing seeded chat ${CHAT_ID}`);
  return tab.messages;
}

function timerBlock(
  message: PersistedChatMessage,
):
  | Extract<PersistedChatMessage['blocks'][number], { type: 'turn_timer' }>
  | undefined {
  return message.blocks.find(
    (
      block,
    ): block is Extract<
      PersistedChatMessage['blocks'][number],
      { type: 'turn_timer' }
    > => block.type === 'turn_timer',
  );
}

function timerRows(
  messages: readonly PersistedChatMessage[],
): PersistedChatMessage[] {
  return messages.filter((message) => timerBlock(message) !== undefined);
}

function currentTab(state: CanonicalChatState) {
  const tab = state.tabsFile.tabs.find((candidate) => candidate.id === CHAT_ID);
  if (!tab) throw new Error(`Missing seeded chat ${CHAT_ID}`);
  return tab;
}

function reducerState(state: CanonicalChatState): TranscriptReducerState {
  const tab = currentTab(state);
  const runtime = state.runtimeByChatId[CHAT_ID];
  const streamingStatuses: readonly ChatRuntimeState['status'][] = [
    'starting',
    'streaming',
    'awaiting_input',
    'completing',
  ];
  return {
    messages: tab.messages,
    status:
      runtime?.status === 'failed'
        ? 'error'
        : runtime && streamingStatuses.includes(runtime.status)
          ? 'streaming'
          : 'idle',
    error: runtime?.error?.message ?? null,
    planMode: tab.planMode ?? false,
    ...(tab.providerType ? { providerType: tab.providerType } : {}),
    ...(tab.sdkSessionId ? { sdkSessionId: tab.sdkSessionId } : {}),
    ...(tab.model ? { model: tab.model } : {}),
    ...(tab.usage ? { usage: tab.usage } : {}),
    ...(tab.agentUsage ? { agentUsage: tab.agentUsage } : {}),
    ...(tab.llmProviderUsageLimitBanner
      ? { llmProviderUsageLimitBanner: tab.llmProviderUsageLimitBanner }
      : {}),
  };
}

function pureReduction(
  provider: Provider,
  current: TranscriptReducerState,
  event: ProviderFrameEvent,
  now: number,
  createMessageId: () => string,
): TranscriptReducerState {
  return provider === 'claude'
    ? applyClaudeTranscriptEvent(current, event.reducerEvent, {
        now,
        createMessageId,
        childToolLiveness: { kind: 'unknown' },
      })
    : applyCodexTranscriptEvent(current, event.reducerEvent, {
        now,
        createMessageId,
        childToolLiveness: { kind: 'unknown' },
      });
}

function frameRows(
  messages: readonly PersistedChatMessage[],
  frameIds: ReadonlySet<string>,
): PersistedChatMessage[] {
  return messages.filter((message) => frameIds.has(message.id));
}

function relevantFrameIds(
  before: readonly PersistedChatMessage[],
  expected: readonly PersistedChatMessage[],
  explicitlyIncluded: readonly string[] = [],
): Set<string> {
  const previousIds = new Set(before.map((message) => message.id));
  const frameIds = new Set<string>(explicitlyIncluded);
  for (const message of timerRows(before)) frameIds.add(message.id);
  for (const message of expected)
    if (!previousIds.has(message.id)) frameIds.add(message.id);
  return frameIds;
}

async function makeHarness(provider: Provider): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'provider-frame-window-'));
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
  const clock = { now: BASE_TIME };
  const service = new ChatStateService({
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
  await service.command({
    schemaVersion: 1,
    commandId: `create-${provider}`,
    ...SCOPE,
    command: {
      type: 'chat.create_tab',
      tabId: CHAT_ID,
      title: 'Provider frame window',
      providerType: provider,
    },
  });
  let eventSequence = 0;
  let lifecycleSequence = 0;
  const chat = { ...SCOPE, chatId: CHAT_ID, provider };
  return {
    provider,
    repository,
    service,
    clock,
    nextMutationId: (label) =>
      `${CHAT_ID}:${provider}:${label}:${eventSequence++}`,
    lifecycle: (type, fields) => {
      const event = {
        ...fields,
        sequence: ++lifecycleSequence,
        atMs: clock.now,
      };
      return observeTurn(
        service,
        type === 'start' ? turnStarted(chat, event) : turnEnded(chat, event),
      );
    },
  };
}

function humanPrompt(): PersistedChatMessage {
  return {
    id: ORIGINAL_HUMAN_ID,
    role: 'user',
    timestamp: BASE_TIME,
    blocks: [{ type: 'text', text: 'Please complete the original work.' }],
  };
}

function completedTimer(id: string, completedAt: number): PersistedChatMessage {
  return {
    id,
    role: 'system',
    timestamp: BASE_TIME,
    blocks: [
      {
        type: 'turn_timer',
        startedAt: BASE_TIME,
        completedAt,
      },
    ],
  };
}

function assistantHistoryRow(index: number): PersistedChatMessage {
  return {
    id: `history-row-${index}`,
    role: 'assistant',
    timestamp: BASE_TIME + 2_001 + index,
    blocks: [{ type: 'text', text: `Historical provider row ${index}` }],
  };
}

async function seedTranscript(
  harness: Harness,
  messages: PersistedChatMessage[],
  runtime: ChatRuntimeState = {
    status: 'completed',
    queuedMessageIds: [],
    lastActivityAt: BASE_TIME + 2_000,
  },
): Promise<void> {
  await harness.repository.transact(
    SCOPE,
    [
      {
        type: 'messages.replaced',
        chatId: CHAT_ID,
        messages,
        removedMessageIds: [],
      },
      ...(harness.provider === 'codex'
        ? [
            {
              type: 'tab.metadata_patched' as const,
              tabId: CHAT_ID,
              patch: { sdkSessionId: CODEX_ROOT_THREAD_ID },
            },
          ]
        : []),
      { type: 'runtime.patched', chatId: CHAT_ID, runtime },
    ],
    {
      source: 'import',
      mutationId: `${CHAT_ID}:${harness.provider}:seed-long-transcript`,
      chatIds: [CHAT_ID],
      fullTranscript: true,
    },
  );
}

function longSettledTranscript(trailingRows: number): PersistedChatMessage[] {
  return [
    humanPrompt(),
    completedTimer(ORIGINAL_TIMER_ID, BASE_TIME + 2_000),
    ...Array.from({ length: trailingRows }, (_, index) =>
      assistantHistoryRow(index),
    ),
  ];
}

function wakeEvent(provider: Provider, wakeNumber: number): ProviderFrameEvent {
  if (provider === 'claude') {
    const data = {
      type: 'assistant',
      uuid: `wake-${wakeNumber}`,
      message: {
        id: `wake-${wakeNumber}`,
        content: [{ type: 'text', text: `Background wake ${wakeNumber}` }],
      },
    };
    return { data, reducerEvent: data };
  }
  const event = {
    type: 'turn.started',
    thread_id: CODEX_ROOT_THREAD_ID,
    turn_id: `codex-wake-${wakeNumber}`,
  };
  return { data: { type: 'codex', event }, reducerEvent: event };
}

function settlementEvent(
  provider: Provider,
  wakeNumber: number,
): ProviderFrameEvent {
  if (provider === 'claude') {
    const data = {
      type: 'result',
      subtype: 'success',
      result: `Background wake ${wakeNumber} settled`,
    };
    return { data, reducerEvent: data };
  }
  const event = {
    type: 'turn.completed',
    thread_id: CODEX_ROOT_THREAD_ID,
    turn_id: `codex-wake-${wakeNumber}`,
  };
  return { data: { type: 'codex', event }, reducerEvent: event };
}

async function ingestAndCompareFullRead(
  harness: Harness,
  event: ProviderFrameEvent,
  mutationId: string,
  options: {
    turnUserMessageId?: string;
    frameMessageIds?: readonly string[];
  } = {},
): Promise<DifferentialResult> {
  const beforeWindow = await harness.repository.getState(SCOPE, {
    chatIds: [CHAT_ID],
  });
  const beforeFull = await harness.repository.getState(SCOPE, {
    chatIds: [CHAT_ID],
    fullTranscript: true,
  });
  expect(chatMessages(beforeWindow).length).toBeLessThan(
    chatMessages(beforeFull).length,
  );

  let generatedMessageSequence = 0;
  const createMessageId = (): string =>
    `${CHAT_ID}:${mutationId}:${generatedMessageSequence++}`;
  const reduced = pureReduction(
    harness.provider,
    reducerState(beforeFull),
    event,
    harness.clock.now,
    createMessageId,
  );

  const applied = await harness.service.ingestProviderEvent({
    ...SCOPE,
    chatId: CHAT_ID,
    providerType: harness.provider,
    data: event.data,
    mutationId,
    ...(options.turnUserMessageId
      ? { turnUserMessageId: options.turnUserMessageId }
      : {}),
  });
  expect(applied).toBe(true);

  const afterFull = await harness.repository.getState(SCOPE, {
    chatIds: [CHAT_ID],
    fullTranscript: true,
  });
  // Canonical turn state owns timer rows, so the reducer's own are not the
  // expectation; the tests assert timers directly.
  const expectedMessages = reduced.messages.filter(
    (message) => timerBlock(message) === undefined,
  );

  const frameIds = relevantFrameIds(
    chatMessages(beforeFull),
    expectedMessages,
    options.frameMessageIds,
  );
  // The default provider input is a bounded window and intentionally omits
  // ordinary history. Compare the complete persisted result's reducer-frame
  // rows to a full-read reducer outcome instead of comparing those windows.
  expect(
    frameRows(chatMessages(afterFull), frameIds).filter(
      (message) => timerBlock(message) === undefined,
    ),
  ).toEqual(frameRows(expectedMessages, frameIds));
  const persistedIds = new Set(
    chatMessages(afterFull).map((message) => message.id),
  );
  for (const message of chatMessages(beforeFull))
    expect(persistedIds).toContain(message.id);

  return { beforeWindow, beforeFull, afterFull, expectedMessages };
}

const PROVIDERS: Provider[] = ['claude', 'codex'];
const TRAILING_ROWS = [499, 500, 600, 1_200];
const LONG_TURN_CASES = PROVIDERS.flatMap((provider) =>
  TRAILING_ROWS.map((trailingRows) => ({ provider, trailingRows })),
);

describe('provider event reduction beyond the bounded transcript window', () => {
  it.each(LONG_TURN_CASES)(
    '$provider resumes and settles twice with $trailingRows trailing rows',
    async ({ provider, trailingRows }) => {
      const harness = await makeHarness(provider);
      await seedTranscript(harness, longSettledTranscript(trailingRows));

      const initialMessages = await harness.repository.getState(SCOPE, {
        chatIds: [CHAT_ID],
        fullTranscript: true,
      });
      expect(timerRows(chatMessages(initialMessages))).toHaveLength(1);

      const committedTimer = timerRows(chatMessages(initialMessages))[0];
      for (const wakeNumber of [1, 2]) {
        harness.clock.now += 50_000;
        const resumedAt = harness.clock.now;
        const wake = wakeEvent(provider, wakeNumber);
        const turnId = `wake-turn-${wakeNumber}`;
        await harness.lifecycle('start', { turnId });
        await ingestAndCompareFullRead(
          harness,
          wake,
          harness.nextMutationId(`wake-${wakeNumber}`),
        );
        const live = await harness.repository.getState(SCOPE, {
          chatIds: [CHAT_ID],
          fullTranscript: true,
        });
        const liveTimers = timerRows(chatMessages(live));
        expect(liveTimers).toHaveLength(wakeNumber + 1);
        // The wake gets its own timer; committed timers keep their bytes.
        expect(liveTimers[0]).toEqual(committedTimer);
        expect(liveTimers[liveTimers.length - 1].id).toBe(`${turnId}:timer`);
        expect(timerBlock(liveTimers[liveTimers.length - 1])).toMatchObject({
          type: 'turn_timer',
          startedAt: resumedAt,
          completedAt: null,
        });

        harness.clock.now += 3_000;
        const settlement = settlementEvent(provider, wakeNumber);
        // The adapter reports the end when it receives the terminal frame.
        await harness.lifecycle('end', { turnId });
        await ingestAndCompareFullRead(
          harness,
          settlement,
          harness.nextMutationId(`settlement-${wakeNumber}`),
        );
        const settled = await harness.repository.getState(SCOPE, {
          chatIds: [CHAT_ID],
          fullTranscript: true,
        });
        const settledTimers = timerRows(chatMessages(settled));
        expect(settledTimers).toHaveLength(wakeNumber + 1);
        expect(settledTimers[0]).toEqual(committedTimer);
        expect(
          timerBlock(settledTimers[settledTimers.length - 1]),
        ).toMatchObject({
          type: 'turn_timer',
          startedAt: resumedAt,
          completedAt: harness.clock.now,
        });
      }
    },
  );
});

describe('watcher provider prompts are user-turn boundaries in reducer windows', () => {
  it('keeps a watcher boundary when the latest-human anchor belongs to an older prompt', async () => {
    const harness = await makeHarness('claude');
    const watcherPrompt: PersistedChatMessage = {
      id: WATCHER_PROMPT_ID,
      role: 'user',
      userMessageSource: 'watcher',
      watcherFired: { kind: 'Pipeline completion (Deploy)' },
      timestamp: BASE_TIME + 2_001,
      blocks: [{ type: 'text', text: 'Continue after the pipeline finishes.' }],
    };
    await seedTranscript(harness, [
      humanPrompt(),
      completedTimer(ORIGINAL_TIMER_ID, BASE_TIME + 2_000),
      watcherPrompt,
      ...Array.from({ length: 600 }, (_, index) => assistantHistoryRow(index)),
    ]);

    const full = await harness.repository.getState(SCOPE, {
      chatIds: [CHAT_ID],
      fullTranscript: true,
    });
    const fullIds = chatMessages(full).map((message) => message.id);
    // Older than the newest page (page size mocked to 20).
    expect(fullIds.indexOf(WATCHER_PROMPT_ID)).toBeLessThan(
      fullIds.length - 20,
    );
    const window = await harness.repository.getState(SCOPE, {
      chatIds: [CHAT_ID],
    });
    const windowIds = new Set(
      chatMessages(window).map((message) => message.id),
    );
    expect(windowIds).toContain(ORIGINAL_HUMAN_ID);
    // The reducer window carries the watcher boundary from the turn frame.
    expect(windowIds).toContain(WATCHER_PROMPT_ID);

    harness.clock.now += 45_000;
    const event = wakeEvent('claude', 1);
    await harness.lifecycle('start', {
      turnId: 'watcher-turn',
      userMessageIds: [WATCHER_PROMPT_ID],
    });
    await ingestAndCompareFullRead(
      harness,
      event,
      harness.nextMutationId('watcher-boundary-wake'),
      { turnUserMessageId: WATCHER_PROMPT_ID },
    );

    const after = await harness.repository.getState(SCOPE, {
      chatIds: [CHAT_ID],
      fullTranscript: true,
    });
    const messages = chatMessages(after);
    const timers = timerRows(messages);
    expect(timers).toHaveLength(2);
    expect(timerBlock(timers[0])).toMatchObject({
      completedAt: BASE_TIME + 2_000,
    });
    expect(timerBlock(timers[1])).toMatchObject({
      type: 'turn_timer',
      completedAt: null,
    });
    expect(timerBlock(timers[1])).not.toHaveProperty('resumedAt');
  });
});

function codexAgentCard(): PersistedChatMessage {
  return {
    id: 'codex-agent-spawn-1',
    role: 'assistant',
    timestamp: BASE_TIME + 1,
    codexThreadId: CODEX_ROOT_THREAD_ID,
    codexTurnId: 'codex-turn-with-agent',
    blocks: [
      {
        type: 'codex_agent_call',
        agentBlockId: 'codex-agent-spawn-1',
        callId: 'spawn-1',
        tool: 'spawnAgent',
        status: 'inProgress',
        senderThreadId: CODEX_ROOT_THREAD_ID,
        receiverThreadIds: ['codex-child-thread'],
        prompt: 'Review the change.',
        agentsStates: { 'codex-child-thread': { status: 'running' } },
      },
    ],
  };
}

describe('out-of-window Codex agent card completion', () => {
  it('updates the existing card in place without detaching its child transcript', async () => {
    const harness = await makeHarness('codex');
    const card = codexAgentCard();
    const child: PersistedChatMessage = {
      id: 'codex-child-output',
      role: 'assistant',
      timestamp: BASE_TIME + 2,
      codexThreadId: 'codex-child-thread',
      codexTurnId: 'child-turn-1',
      parentBlockId: card.id,
      blocks: [{ type: 'text', text: 'The review is complete.' }],
    };
    const currentUser: PersistedChatMessage = {
      id: 'codex-turn-with-agent',
      role: 'user',
      timestamp: BASE_TIME,
      blocks: [{ type: 'text', text: 'Review this change.' }],
    };
    await seedTranscript(harness, [
      currentUser,
      card,
      child,
      ...Array.from({ length: 100 }, (_, index) => assistantHistoryRow(index)),
    ]);

    const before = await harness.repository.getState(SCOPE, {
      chatIds: [CHAT_ID],
      fullTranscript: true,
    });
    const beforeMessages = chatMessages(before);
    const originalCardPosition = beforeMessages.findIndex(
      (message) => message.id === card.id,
    );
    expect(originalCardPosition).toBeGreaterThanOrEqual(0);
    // Older than the newest page (page size mocked to 20).
    expect(originalCardPosition).toBeLessThan(beforeMessages.length - 20);
    const beforeWindow = await harness.repository.getState(SCOPE, {
      chatIds: [CHAT_ID],
    });
    // The reducer window carries the card from the turn frame.
    expect(
      chatMessages(beforeWindow).some((message) => message.id === card.id),
    ).toBe(true);

    harness.clock.now += 5_000;
    const event = {
      type: 'item.completed',
      thread_id: CODEX_ROOT_THREAD_ID,
      turn_id: 'codex-turn-with-agent',
      item: {
        id: 'wait-1',
        type: 'collab_agent_tool_call',
        tool: 'wait',
        status: 'completed',
        sender_thread_id: CODEX_ROOT_THREAD_ID,
        receiver_thread_ids: ['codex-child-thread'],
        agents_states: { 'codex-child-thread': { status: 'completed' } },
      },
    };
    const result = await ingestAndCompareFullRead(
      harness,
      { data: { type: 'codex', event }, reducerEvent: event },
      harness.nextMutationId('codex-agent-completed'),
      { frameMessageIds: [card.id, child.id] },
    );

    const messages = chatMessages(result.afterFull);
    const matchingCards = messages.filter((message) =>
      message.blocks.some(
        (block) =>
          block.type === 'codex_agent_call' && block.agentBlockId === card.id,
      ),
    );
    expect(matchingCards).toHaveLength(1);
    expect(matchingCards[0]?.id).toBe(card.id);
    expect(messages.findIndex((message) => message.id === card.id)).toBe(
      originalCardPosition,
    );
    expect(
      matchingCards[0]?.blocks.find(
        (block) => block.type === 'codex_agent_call',
      ),
    ).toMatchObject({ status: 'completed' });
    expect(
      messages.find((message) => message.id === child.id)?.parentBlockId,
    ).toBe(card.id);
  });
});
