import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentDelegationTranscript } from '@canopy/protocol/delegation';
import {
  hydrateChatTurnState,
  serializeChatTurnState,
} from '@canopy/agent-transcript/turn';
import type {
  ChatCoreMutation,
  ChatStateChangedEvent,
} from '@canopy/desktop-shared/types';
import {
  initClaudeModels,
  initCodexModels,
} from '@canopy/desktop-shared/types';
import { ChatDeltaJournalWriter } from '../lib/chat-delta-journal/writer';
import { TranscriptStreamStore } from '../lib/chat-transcript-log';
import {
  setChatTranscriptRewriteDiagnosticsForTests,
  type ChatTranscriptFullRewriteDiagnostic,
} from '../services/chat-transcript-rewrite-diagnostics';
import {
  createRepositoryTranscriptPortFixture,
  type RepositoryTranscriptPortFixture,
} from './helpers/repository-transcript-port-fixture';
import { message } from './helpers/chat-delta-journal-harness';

/** A canonical foreground turn, which keeps a live commit's rows active. */
function persistedOpenTurn(
  id: string,
): ReturnType<typeof serializeChatTurnState> {
  const turn = hydrateChatTurnState({
    phase: 'foreground',
    decisionPending: false,
    catchingUp: false,
    current: { id, origin: 'user', startedAtMs: 100, pauses: [] },
    endedTurnIds: [],
    background: { native: [], managed: { live: 0, queued: 0 } },
  });
  if (!turn) throw new Error('Invalid open turn fixture');
  return serializeChatTurnState(turn);
}

function detachedDelegation(runGeneration = 1): AgentDelegationTranscript {
  return {
    delegationId: 'ingested-stream-card',
    runGeneration,
    sequence: runGeneration,
    parentHarnessId: 'codex',
    parentTurnId: 'parent-chat',
    parentToolCallId: 'spawn-call',
    createdAt: 200,
    task: {
      description: 'Detached work',
      prompt: 'Review the change',
      executionMode: 'background',
    },
    snapshot: {
      delegationId: 'ingested-stream-card',
      runGeneration,
      status: 'pending',
      requestedModelId: 'requested-model',
      outputTruncated: false,
    },
    transcript: [],
    transcriptStore: 'chat-stream-v2',
  };
}

async function ingestDelegation(
  fixture: RepositoryTranscriptPortFixture,
  mutationId: string,
  delegation: AgentDelegationTranscript = detachedDelegation(),
): Promise<'applied' | 'not-applied' | 'activity-only'> {
  return fixture.service.ingestProviderEventWithOutcome({
    ...fixture.scope,
    chatId: 'chat',
    mutationId,
    data: { type: 'canopy_delegation', delegation },
  });
}

function laterDelegation(): AgentDelegationTranscript {
  const created = detachedDelegation();
  return {
    ...created,
    sequence: 9,
    task: { ...created.task, prompt: 'A later amended prompt' },
    snapshot: { ...created.snapshot, nativeSessionId: 'later-session' },
  };
}

async function appendNewerRows(
  fixture: RepositoryTranscriptPortFixture,
  count: number,
): Promise<void> {
  const mutations: ChatCoreMutation[] = [];
  for (let index = 0; index < count; index += 1) {
    mutations.push({
      type: 'message.upserted',
      chatId: 'chat',
      message: message(
        `newer-${index}`,
        `Newer message ${index}`,
        'assistant',
        index + 1,
      ),
    });
  }
  await fixture.repository.transact(fixture.scope, mutations, {
    source: 'automation',
    chatIds: ['chat'],
  });
}

describe('S2B E4 delegation stream ingestion writes', () => {
  let root = '';
  let fixture: RepositoryTranscriptPortFixture | undefined;

  beforeAll(() => {
    initClaudeModels([
      { id: 'claude-sonnet-4-6', label: 'Sonnet', contextWindow: 200_000 },
    ]);
    initCodexModels([{ id: 'codex-mini-latest', label: 'Codex Mini' }]);
  });

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'delegation-card-state-s2b-e4-'));
    fixture = await createRepositoryTranscriptPortFixture(root)();
  });

  afterEach(async () => {
    setChatTranscriptRewriteDiagnosticsForTests();
    await fixture?.close();
    jest.restoreAllMocks();
    fixture = undefined;
    await rm(root, { recursive: true, force: true });
  });

  it('appends a first idle tail card with one ordinary append checkpoint', async () => {
    const current = fixture;
    if (!current) throw new Error('Repository fixture was not created');
    await appendNewerRows(current, 1);
    const commit = jest.spyOn(ChatDeltaJournalWriter.prototype, 'admit');
    const checkpoint = jest.spyOn(
      ChatDeltaJournalWriter.prototype,
      'checkpoint',
    );
    const events: ChatStateChangedEvent[] = [];
    const unsubscribe = current.service.subscribe((event) =>
      events.push(event),
    );

    const outcome = await ingestDelegation(current, 'idle-first-card');
    const state = await current.repository.getState(current.scope, {
      chatIds: ['chat'],
      fullTranscript: true,
    });
    const messages = state.tabsFile.tabs.find(
      (tab) => tab.id === 'chat',
    )?.messages;

    expect(outcome).toBe('applied');
    expect(messages?.map((message) => message.id)).toEqual([
      'parent-chat',
      'newer-0',
      'delegated-agent-ingested-stream-card',
    ]);
    expect(commit).toHaveBeenCalledTimes(1);
    const input = commit.mock.calls[0]?.[0];
    if (!input) throw new Error('Idle card did not reach the journal writer');
    expect(input.writes).toHaveLength(1);
    expect(input.writes[0]).toMatchObject({ chatId: 'chat', kind: 'append' });
    expect(checkpoint).toHaveBeenCalledTimes(1);
    expect(await current.store.format()).toBe('v4');
    const changes = events.flatMap((event) => event.changes);
    const upserts = changes.filter(
      (change) => change.type === 'message.upserted',
    );
    expect(upserts).toHaveLength(1);
    expect(upserts[0]).not.toHaveProperty('afterMessageId');
    expect(changes.some((change) => change.type === 'messages.replaced')).toBe(
      false,
    );
    unsubscribe();
  });

  it('makes a later already-hydrated card event storage-, event-, and rewrite-neutral', async () => {
    const current = fixture;
    if (!current) throw new Error('Repository fixture was not created');
    await ingestDelegation(current, 'idle-card-before-replay');

    const commit = jest.spyOn(ChatDeltaJournalWriter.prototype, 'admit');
    const checkpoint = jest.spyOn(
      ChatDeltaJournalWriter.prototype,
      'checkpoint',
    );
    const events: ChatStateChangedEvent[] = [];
    const diagnostics: ChatTranscriptFullRewriteDiagnostic[] = [];
    const unsubscribe = current.service.subscribe((event) =>
      events.push(event),
    );
    setChatTranscriptRewriteDiagnosticsForTests({
      sink: (diagnostic) => diagnostics.push(diagnostic),
      now: () => 200,
    });
    try {
      const outcome = await ingestDelegation(
        current,
        'idle-card-later-event',
        laterDelegation(),
      );
      expect(outcome).not.toBe('applied');
      expect(commit).not.toHaveBeenCalled();
      expect(checkpoint).not.toHaveBeenCalled();
      expect(events).toEqual([]);
      expect(diagnostics).toEqual([]);
    } finally {
      unsubscribe();
    }
  });

  it('keeps a first stream card in an active transcript row without checkpointing', async () => {
    const current = fixture;
    if (!current) throw new Error('Repository fixture was not created');
    await current.repository.transact(
      current.scope,
      [
        {
          type: 'runtime.patched',
          chatId: 'chat',
          runtime: {
            status: 'streaming',
            queuedMessageIds: [],
            activeTurn: { userMessageId: 'parent-chat', startedAt: 100 },
            turn: persistedOpenTurn('parent-chat'),
          },
        },
      ],
      { source: 'automation', chatIds: ['chat'] },
    );

    const commit = jest.spyOn(ChatDeltaJournalWriter.prototype, 'admit');
    const checkpoint = jest.spyOn(
      ChatDeltaJournalWriter.prototype,
      'checkpoint',
    );
    expect(await ingestDelegation(current, 'active-first-card')).toBe(
      'applied',
    );

    expect(commit).toHaveBeenCalledTimes(1);
    const input = commit.mock.calls[0]?.[0];
    if (!input) throw new Error('Active card did not reach the journal writer');
    expect(input.writes).toHaveLength(1);
    expect(input.writes[0]).toMatchObject({
      chatId: 'chat',
      kind: 'active-upsert',
    });
    expect(checkpoint).not.toHaveBeenCalled();
    commit.mockClear();
    expect(
      await ingestDelegation(current, 'active-later-card', laterDelegation()),
    ).not.toBe('applied');
    expect(commit).not.toHaveBeenCalled();
    expect(checkpoint).not.toHaveBeenCalled();
  });

  it('uses only the new generation card lookup when its origin is paged out', async () => {
    const current = fixture;
    if (!current) throw new Error('Repository fixture was not created');
    await ingestDelegation(current, 'generation-one-card');
    await appendNewerRows(current, 510);
    const page = await current.repository.page(current.scope, 'chat');
    expect(page.messages.map((entry) => entry.id)).not.toContain('parent-chat');
    expect(page.messages.map((entry) => entry.id)).not.toContain(
      'delegated-agent-ingested-stream-card',
    );

    const readMessage = jest.spyOn(
      TranscriptStreamStore.prototype,
      'readMessage',
    );
    const outcome = await ingestDelegation(
      current,
      'generation-two-first-card',
      detachedDelegation(2),
    );
    const readIds = readMessage.mock.calls.map((call) => call[1]);
    expect(outcome).toBe('applied');
    expect(readIds).toContain('delegated-agent-ingested-stream-card-run-2');
    expect(readIds).not.toContain('parent-chat');
    expect(readIds).not.toContain('delegated-agent-ingested-stream-card');
  });

  it('finds an existing paged-out card after repository reopen without rewriting it', async () => {
    const current = fixture;
    if (!current) throw new Error('Repository fixture was not created');
    await ingestDelegation(current, 'before-restart-card');
    await appendNewerRows(current, 510);
    const page = await current.repository.page(current.scope, 'chat');
    expect(page.messages.map((entry) => entry.id)).not.toContain(
      'delegated-agent-ingested-stream-card',
    );
    await current.reopen();

    const commit = jest.spyOn(ChatDeltaJournalWriter.prototype, 'admit');
    const checkpoint = jest.spyOn(
      ChatDeltaJournalWriter.prototype,
      'checkpoint',
    );
    const events: ChatStateChangedEvent[] = [];
    const unsubscribe = current.service.subscribe((event) =>
      events.push(event),
    );
    try {
      const outcome = await ingestDelegation(
        current,
        'replay-after-restart',
        laterDelegation(),
      );
      // The reopened scope's reducer frame or a point read supplies the
      // paged-out card; either way it is found, so nothing is rewritten.
      expect(outcome).not.toBe('applied');
      expect(commit).not.toHaveBeenCalled();
      expect(checkpoint).not.toHaveBeenCalled();
      expect(events).toEqual([]);
    } finally {
      unsubscribe();
    }
  });

  it('updates an archived chat on first appearance but makes archived replay neutral', async () => {
    const current = fixture;
    if (!current) throw new Error('Repository fixture was not created');
    const initial = await current.repository.getState(current.scope, {
      chatIds: ['chat'],
      fullTranscript: true,
    });
    const chat = initial.tabsFile.tabs.find((tab) => tab.id === 'chat');
    if (!chat) throw new Error('Seed chat was not found');
    await current.repository.transact(
      current.scope,
      [
        { type: 'tab.removed', tabId: 'chat' },
        {
          type: 'archive.upserted',
          entry: {
            tab: { ...chat, autoArchive: true },
            archivedAt: '2026-10-19',
            turnCount: 1,
          },
        },
      ],
      { source: 'automation', chatIds: ['chat'] },
    );

    const commit = jest.spyOn(ChatDeltaJournalWriter.prototype, 'admit');
    const checkpoint = jest.spyOn(
      ChatDeltaJournalWriter.prototype,
      'checkpoint',
    );
    const events: ChatStateChangedEvent[] = [];
    const unsubscribe = current.service.subscribe((event) =>
      events.push(event),
    );
    try {
      expect(await ingestDelegation(current, 'archive-first-card')).toBe(
        'applied',
      );
      const archived = await current.repository.getState(current.scope, {
        chatIds: ['chat'],
        fullTranscript: true,
      });
      expect(archived.tabsFile.tabs.some((tab) => tab.id === 'chat')).toBe(
        false,
      );
      expect(
        archived.archivesFile.archived
          .find((entry) => entry.tab.id === 'chat')
          ?.tab.messages.some(
            (entry) => entry.id === 'delegated-agent-ingested-stream-card',
          ),
      ).toBe(true);
      expect(events).toHaveLength(1);
      expect(events[0]?.changes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'archive.upserted' }),
        ]),
      );
      expect(commit).toHaveBeenCalledTimes(1);
      expect(commit.mock.calls[0]?.[0].writes).toEqual([
        expect.objectContaining({ chatId: 'chat', kind: 'append' }),
      ]);
      expect(checkpoint).toHaveBeenCalledTimes(1);

      commit.mockClear();
      checkpoint.mockClear();
      events.length = 0;
      const replay = await ingestDelegation(
        current,
        'archive-replay-card',
        laterDelegation(),
      );
      expect(replay).not.toBe('applied');
      expect(commit).not.toHaveBeenCalled();
      expect(checkpoint).not.toHaveBeenCalled();
      expect(events).toEqual([]);
    } finally {
      unsubscribe();
    }
  });

  it.each([undefined, 'chat-log-v1'] as const)(
    'keeps a %s legacy sibling after its parent without descriptor I/O',
    async (store) => {
      const current = fixture;
      if (!current) throw new Error('Repository fixture was not created');
      await current.repository.transact(
        current.scope,
        [
          {
            type: 'message.upserted',
            chatId: 'chat',
            message: message('later-sibling', 'Later row', 'assistant', 300),
          },
        ],
        { source: 'automation', chatIds: ['chat'] },
      );
      const descriptorLookup = jest.spyOn(
        current.service,
        'getChildStreamState',
      );
      const descriptorRead = jest.spyOn(
        ChatDeltaJournalWriter.prototype,
        'childDescriptor',
      );
      const { transcriptStore, ...inline } = detachedDelegation();
      void transcriptStore;
      const legacy: AgentDelegationTranscript =
        store === undefined ? inline : { ...inline, transcriptStore: store };

      expect(
        await ingestDelegation(current, 'legacy-sibling-event', legacy),
      ).toBe('applied');
      const state = await current.repository.getState(current.scope, {
        chatIds: ['chat'],
        fullTranscript: true,
      });
      const messages = state.tabsFile.tabs.find(
        (tab) => tab.id === 'chat',
      )?.messages;
      expect(messages?.map((entry) => entry.id)).toEqual([
        'parent-chat',
        'delegated-agent-ingested-stream-card',
        'later-sibling',
      ]);
      expect(descriptorLookup).not.toHaveBeenCalled();
      expect(descriptorRead).not.toHaveBeenCalled();
    },
  );
});
