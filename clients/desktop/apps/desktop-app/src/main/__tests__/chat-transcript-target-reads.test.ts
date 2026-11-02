import { fitBoundedBlockPage } from '../canopy-runtime/bounded-block-page';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import * as standaloneHistory from '../lib/standalone-history';
import * as archivedContainers from '../lib/archived-containers';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type {
  DelegationChildRow,
  DelegatedAgentCallBlock,
  PersistedChatMessage,
} from '@canopy/agent-transcript';
import { ChatStorageV2 } from '../lib/chat-storage-v2';
import { ChatDeltaJournalWriter } from '../lib/chat-delta-journal/writer';
import { ChatStateV2Backend } from '../services/chat-state-v2-backend';
import { TRANSCRIPT_PAGE_SIZE } from '@canopy/agent-transcript/transcript-storage';
import type { TranscriptTarget } from '@canopy/protocol/canopy-core';
import {
  format4Scope,
  reopenFormat4Scope,
  snapshotFormat4Files,
} from './helpers/chat-format4-scope';
import { message, scopeSource } from './helpers/chat-delta-journal-harness';
import type { CanopyHandlerContext } from '@canopy/core-runtime';
import { createCoreChatReadAdapter } from '../canopy-runtime/core-chat-read-adapter';
import { createDesktopRuntime } from '../canopy-runtime/desktop-runtime';
import { ChatStateService } from '../services/chat-state-service';
import { ChatStateV2Repository } from '../services/chat-state-v2-repository';
import {
  encodeChatTranscriptReadCursor,
  decodeChatTranscriptReadCursor,
} from '../lib/chat-transcript-read-cursor';
import { ChatTranscriptArtifacts } from '../lib/chat-transcript-artifacts';
import { delegationStreamKey } from '../lib/transcript-stream-paths';
import * as transcriptLog from '../lib/chat-transcript-log';
import {
  delegationBlockId,
  delegationChildMessages,
} from '@canopy/agent-transcript';
import { ChatDelegationLogs } from '../lib/chat-delegation-log';
import { MissingDelegationTranscriptSourceError } from '../lib/chat-delegation-legacy-read';
import type { AgentDelegationTranscriptItem } from '@canopy/protocol/delegation';

jest.setTimeout(120_000);

const scope = { projectId: 'project', worktreeId: 'scope' };
const target = {
  kind: 'delegation' as const,
  chatId: 'chat',
  delegationId: 'delegate',
  runGeneration: 1,
};

function child(sequence: number, final = true): DelegationChildRow {
  return {
    id: `agent:row-${sequence}`,
    role: 'assistant',
    timestamp: sequence + 2,
    parentBlockId: 'delegated-agent-delegate',
    delegationSequence: sequence,
    itemRevision: 0,
    final,
    blocks: [{ type: 'text', text: `selected child needle ${sequence}` }],
  };
}

function card(): DelegatedAgentCallBlock {
  return {
    type: 'delegated_agent_call',
    delegationId: target.delegationId,
    runGeneration: target.runGeneration,
    status: 'running',
    outputTruncated: false,
    agentBlockId: 'delegated-agent-delegate',
    sequence: 1,
    parentHarnessId: 'claude',
    parentTurnId: 'prompt',
    parentToolCallId: 'spawn',
    createdAt: 1,
    routeSnapshot: {
      selectedModelId: 'model',
      runtimeModelId: 'model',
      harnessId: 'claude',
      runtimeKind: 'local-sdk',
      runnerRegistrationId: 'claude-local',
      runtimeVersion: '1',
      adapterVersion: '1',
      modelSource: 'test',
      providerType: 'test',
      assignmentRevision: 'assignment-1',
      billingAuthority: 'native',
      aiCreditsRouted: false,
      capabilities: ['read'],
      supportedThinkingLevels: ['low'],
      capabilitySnapshotHash: 'capability-1',
      capabilityGeneration: 1,
      policyRevision: 'policy-1',
    },
    selectedModelId: 'model',
    runtimeModelId: 'model',
    targetHarnessId: 'claude',
    description: 'Review',
    prompt: 'Review it',
    executionMode: 'background',
    transcriptStore: 'chat-stream-v2',
  };
}

describe('transcript target reads', () => {
  let root: string;
  const repositories: ChatStateV2Repository[] = [];
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'chat-target-reads-'));
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    for (const repository of repositories.splice(0))
      await repository.drainAll();
    await rm(root, { recursive: true, force: true });
  });

  async function fixture(
    primary: PersistedChatMessage[] = [message('parent', 'primary only')],
  ): Promise<{
    backend: Awaited<ReturnType<typeof format4Scope>>['backend'];
    service: ChatStateService;
  }> {
    const { backend } = await format4Scope(
      root,
      'scope',
      scopeSource([
        { id: 'chat', messages: primary },
        { id: 'other', messages: [message('other-parent', 'other primary')] },
      ]),
    );
    await backend.registerTranscriptStream(target);
    await backend.flush();
    backend.releaseJournal();
    const repository = new ChatStateV2Repository({
      resolvePaths: (): {
        tabs: string;
        archives: string;
        journal: string;
      } => ({
        tabs: join(root, 'scope.json'),
        archives: join(root, 'archives.json'),
        journal: join(root, 'journal.jsonl'),
      }),
      enableFormat4: false,
    });
    repositories.push(repository);
    return {
      backend,
      service: new ChatStateService({
        repository,
        recordDiagnostic: jest.fn(),
      }),
    };
  }

  async function legacyFixture(
    source: 'inline' | 'chat-log-v1',
    items: AgentDelegationTranscriptItem[],
    outputTruncated = false,
    format: 2 | 3 | 4 = 4,
  ): Promise<{
    store: ChatStorageV2;
    backend: ChatStateV2Backend;
    logs: ChatDelegationLogs;
  }> {
    const { transcriptStore: _marker, ...base } = card();
    void _marker;
    const legacyCard: DelegatedAgentCallBlock = {
      ...base,
      outputTruncated,
      ...(source === 'inline' ? {} : { transcriptStore: source }),
    };
    const sourceRows = scopeSource([
      {
        id: 'chat',
        messages: [
          { ...message('parent', 'parent body'), blocks: [legacyCard] },
          ...(source === 'inline'
            ? delegationChildMessages(legacyCard.agentBlockId, items)
            : []),
        ],
      },
    ]);
    let store: ChatStorageV2;
    let backend: ChatStateV2Backend;
    if (format === 4)
      ({ store, backend } = await format4Scope(root, 'scope', sourceRows));
    else {
      store = new ChatStorageV2(root, 'scope');
      await store.migrate(sourceRows);
      backend = new ChatStateV2Backend(store, { deltaJournal: {} });
      if (format === 3) await backend.promoteToDeltaJournal();
    }
    const logs = new ChatDelegationLogs(join(store.directory, 'transcripts'));
    if (source === 'chat-log-v1') {
      if (items.length) await logs.append('chat', target, items);
      else {
        await mkdir(dirname(logs.path('chat', target)), { recursive: true });
        await writeFile(logs.path('chat', target), '');
      }
    }
    await backend.state(); // Required scope load/recovery precedes snapshots.
    return { store, backend, logs };
  }

  it.each([2, 3, 4] as const)(
    'reads legacy targets in format %i without any adapter writes',
    async (format) => {
      const { backend, logs } = await legacyFixture(
        'chat-log-v1',
        [
          {
            id: 'text',
            sequence: 0,
            occurredAt: 2,
            type: 'text',
            text: 'before',
          },
        ],
        false,
        format,
      );
      try {
        await logs.append('chat', target, [
          {
            id: 'text',
            sequence: 0,
            occurredAt: 2,
            type: 'text',
            text: 'latest 🌲\ud800',
            author: { kind: 'user' },
            delivery: 'steer',
          },
        ]);
        const before = await snapshotFormat4Files(root);
        const page = await backend.page('chat', undefined, undefined, {
          ...scope,
          target,
        });
        expect(page.messages).toEqual([
          {
            id: 'delegated-agent-delegate:text',
            role: 'user',
            timestamp: 2,
            parentBlockId: 'delegated-agent-delegate',
            delegationSequence: 0,
            delegationAuthor: { kind: 'user' },
            delegationDelivery: 'steer',
            itemRevision: 0,
            final: true,
            blocks: [{ type: 'text', text: 'latest 🌲\ud800' }],
          },
        ]);
        expect(page).not.toHaveProperty('runTruncated');
        expect(
          await backend.blocks({
            ...scope,
            chatId: 'chat',
            target,
            messageId: 'delegated-agent-delegate:text',
            limit: 1,
          }),
        ).toMatchObject({
          blocks: [{ type: 'text', text: 'latest 🌲\ud800' }],
        });
        expect(
          await backend.content({
            ...scope,
            chatId: 'chat',
            target,
            messageId: 'delegated-agent-delegate:text',
            blockOrdinal: 0,
            field: 'text',
            requestId: 'range',
            offset: 0,
            limit: 64,
          }),
        ).toEqual({ text: 'latest 🌲\ud800', byteLength: 20 });
        expect(await snapshotFormat4Files(root)).toEqual(before);
      } finally {
        backend.releaseJournal();
      }
    },
  );

  it.each(['inline', 'chat-log-v1'] as const)(
    'searches a legacy %s target through the reader its pages use',
    async (source) => {
      const { backend } = await legacyFixture(source, [
        {
          id: 'text',
          sequence: 0,
          occurredAt: 2,
          type: 'text',
          text: 'legacy needle',
        },
      ]);
      try {
        const search = await backend.search({
          ...scope,
          chatId: 'chat',
          target,
          query: 'needle',
          requestId: 'legacy-search',
        });
        expect(search.totalCount).toBe(1);
        expect(search.matches).toEqual([
          expect.objectContaining({ turnId: 'delegated-agent-delegate' }),
        ]);
      } finally {
        backend.releaseJournal();
      }
    },
  );

  it.each(['inline', 'chat-log-v1'] as const)(
    'treats a registered stream as authoritative over a %s card',
    async (source) => {
      // Legacy generations never register; a registration is stream evidence.
      const { backend } = await legacyFixture(source, []);
      try {
        await backend.registerTranscriptStream(target);
        await backend.commitChildStream(target, 'registered', [child(0)]);
        const page = await backend.page('chat', undefined, undefined, {
          ...scope,
          target,
        });
        expect(page.messages).toHaveLength(1);
        expect(page.messages[0]).toMatchObject({ id: child(0).id });
      } finally {
        backend.releaseJournal();
      }
    },
  );

  it('refuses a missing log for a log-marked card with a typed error', async () => {
    const { backend, logs } = await legacyFixture('chat-log-v1', []);
    try {
      await rm(logs.path('chat', target));
      const before = await snapshotFormat4Files(root);
      await expect(
        backend.page('chat', undefined, undefined, { ...scope, target }),
      ).rejects.toBeInstanceOf(MissingDelegationTranscriptSourceError);
      expect(await snapshotFormat4Files(root)).toEqual(before);
    } finally {
      backend.releaseJournal();
    }
  });

  it('refuses a missing stream-marked source with a typed error instead of inline fallback', async () => {
    const { backend } = await format4Scope(
      root,
      'scope',
      scopeSource([
        {
          id: 'chat',
          messages: [
            { ...message('parent', 'primary'), blocks: [card()] },
            child(0),
          ],
        },
      ]),
    );
    try {
      await expect(
        backend.page('chat', undefined, undefined, { ...scope, target }),
      ).rejects.toMatchObject({
        name: 'MissingDelegationTranscriptSourceError',
        code: 'missing_source',
        source: 'chat-stream-v2',
      });
    } finally {
      backend.releaseJournal();
    }
  });

  it.each(['card', 'item'] as const)(
    'marks %s-only truncation on later pages, blocks and both tool field ranges',
    async (evidence) => {
      const { backend } = await legacyFixture(
        'inline',
        [
          {
            id: 'tool',
            sequence: 0,
            occurredAt: 2,
            type: 'tool',
            toolName: 'shell',
            input: 'in🌲\ud800',
            output: 'out漢',
            ...(evidence === 'item' ? { truncated: true } : {}),
          },
          {
            id: 'later',
            sequence: 1,
            occurredAt: 3,
            type: 'text',
            text: 'later',
          },
        ],
        evidence === 'card',
      );
      try {
        const request = { ...scope, chatId: 'chat', target };
        const page = await backend.page('chat', undefined, undefined, {
          ...request,
          limit: 1,
        });
        expect(page.messages[0]?.id).toBe('delegated-agent-delegate:later');
        expect(page).toHaveProperty('runTruncated', true);
        const earlier = await backend.page('chat', undefined, undefined, {
          ...request,
          limit: 1,
          cursor: page.cursor,
        });
        expect(earlier).toHaveProperty('runTruncated', true);
        expect(earlier.messages[0]?.id).toBe('delegated-agent-delegate:tool');
        if (evidence === 'item')
          expect(earlier.messages[0]).toHaveProperty('truncated', true);
        else expect(earlier.messages[0]).not.toHaveProperty('truncated');
        const blocks = await backend.blocks({
          ...request,
          messageId: 'delegated-agent-delegate:tool',
          limit: 1,
        });
        expect(blocks).toHaveProperty('runTruncated', true);
        expect(
          await backend.blocks({
            ...request,
            messageId: 'delegated-agent-delegate:tool',
            cursor: blocks.cursor,
            limit: 1,
          }),
        ).toHaveProperty('runTruncated', true);
        expect(
          await backend.content({
            ...request,
            messageId: 'delegated-agent-delegate:tool',
            blockOrdinal: 0,
            field: 'input',
            requestId: 'input',
            offset: 0,
            limit: 64,
          }),
        ).toEqual({ text: 'in🌲\ud800', byteLength: 10, runTruncated: true });
        expect(
          await backend.content({
            ...request,
            messageId: 'delegated-agent-delegate:tool',
            blockOrdinal: 1,
            field: 'output',
            requestId: 'output',
            offset: 0,
            limit: 64,
          }),
        ).toEqual({ text: 'out漢', byteLength: 6, runTruncated: true });
        expect(await backend.page('chat')).not.toHaveProperty('runTruncated');
      } finally {
        backend.releaseJournal();
      }
    },
  );

  it.each(['inline', 'chat-log-v1'] as const)(
    'marks an empty truncated %s run',
    async (source) => {
      const { backend } = await legacyFixture(source, [], true);
      try {
        expect(
          await backend.page('chat', undefined, undefined, {
            ...scope,
            target,
          }),
        ).toMatchObject({ messages: [], totalMessages: 0, runTruncated: true });
      } finally {
        backend.releaseJournal();
      }
    },
  );

  it('refuses legacy page and block cursors across run, scope, archive, revision and deletion; observes cancellation', async () => {
    const { backend, logs } = await legacyFixture('chat-log-v1', [
      {
        id: 'tool',
        sequence: 0,
        occurredAt: 2,
        type: 'tool',
        toolName: 'shell',
        input: 'input',
        output: 'output',
      },
      { id: 'text', sequence: 1, occurredAt: 3, type: 'text', text: 'latest' },
    ]);
    try {
      const request = { ...scope, chatId: 'chat', target };
      const page = await backend.page('chat', undefined, undefined, {
        ...request,
        limit: 1,
      });
      const blocks = await backend.blocks({
        ...request,
        messageId: 'delegated-agent-delegate:tool',
        limit: 1,
      });
      expect(page.cursor).toEqual(expect.any(String));
      expect(blocks.cursor).toEqual(expect.any(String));
      for (const changed of [
        { ...request, projectId: 'other' },
        { ...request, worktreeId: 'other' },
        { ...request, archivedContainerId: 'archive' },
        { ...request, standaloneHistory: true },
        { ...request, target: { ...target, runGeneration: 2 } },
      ]) {
        await expect(
          backend.page('chat', undefined, undefined, {
            ...changed,
            cursor: page.cursor,
          }),
        ).rejects.toThrow();
        await expect(
          backend.blocks({
            ...changed,
            messageId: 'delegated-agent-delegate:tool',
            cursor: blocks.cursor,
            limit: 1,
          }),
        ).rejects.toThrow();
      }
      const controller = new AbortController();
      controller.abort();
      await expect(
        backend.blocks(
          { ...request, messageId: 'delegated-agent-delegate:tool', limit: 1 },
          controller.signal,
        ),
      ).rejects.toMatchObject({ name: 'AbortError' });
      await expect(
        backend.content(
          {
            ...request,
            messageId: 'delegated-agent-delegate:tool',
            blockOrdinal: 0,
            field: 'input',
            requestId: 'cancelled',
            offset: 0,
            limit: 64,
          },
          controller.signal,
        ),
      ).rejects.toMatchObject({ name: 'AbortError' });
      await logs.append('chat', target, [
        {
          id: 'text',
          sequence: 1,
          occurredAt: 3,
          type: 'text',
          text: 'changed',
        },
      ]);
      await expect(
        backend.page('chat', undefined, undefined, {
          ...request,
          cursor: page.cursor,
        }),
      ).rejects.toThrow('Stale transcript stream cursor');
      await expect(
        backend.blocks({
          ...request,
          messageId: 'delegated-agent-delegate:tool',
          cursor: blocks.cursor,
          limit: 1,
        }),
      ).rejects.toThrow('Stale transcript blocks cursor');
      await backend.transact(() => [{ type: 'tab.removed', tabId: 'chat' }], {
        source: 'renderer-command',
      });
      await expect(
        backend.page('chat', undefined, undefined, request),
      ).rejects.toThrow('Unknown child stream');
      await expect(
        backend.blocks({
          ...request,
          messageId: 'delegated-agent-delegate:tool',
          limit: 1,
        }),
      ).rejects.toThrow('Unknown child stream');
      await expect(
        backend.content({
          ...request,
          messageId: 'delegated-agent-delegate:tool',
          blockOrdinal: 0,
          field: 'input',
          requestId: 'deleted',
          offset: 0,
          limit: 64,
        }),
      ).rejects.toThrow('Unknown child stream');
    } finally {
      backend.releaseJournal();
    }
  });

  it.each(['live', 'standalone', 'container'] as const)(
    'dispatches all legacy read results through the %s backend without writes',
    async (lane) => {
      const { backend, store } = await legacyFixture(
        'chat-log-v1',
        [
          {
            id: 'tool',
            sequence: 0,
            occurredAt: 2,
            type: 'tool',
            toolName: 'shell',
            input: 'input',
            output: 'output',
            truncated: true,
          },
        ],
        false,
        2,
      );
      backend.releaseJournal();
      jest
        .spyOn(standaloneHistory, 'getStandaloneHistoryStorage')
        .mockResolvedValue(store);
      jest
        .spyOn(archivedContainers, 'getArchivedContainerChatStorage')
        .mockResolvedValue(store);
      const repository = new ChatStateV2Repository({
        resolvePaths: (): {
          tabs: string;
          archives: string;
          journal: string;
        } => ({
          tabs: join(root, 'scope.json'),
          archives: join(root, 'archives.json'),
          journal: join(root, 'journal.jsonl'),
        }),
      });
      repositories.push(repository);
      const service = new ChatStateService({
        repository,
        recordDiagnostic: jest.fn(),
      });
      const archive =
        lane === 'standalone'
          ? { standaloneHistory: true as const }
          : lane === 'container'
            ? { archivedContainerId: scope.worktreeId }
            : {};
      if (lane === 'live') await service.getState(scope);
      const before = await snapshotFormat4Files(root);
      const dispatcher = createDesktopRuntime({
        chatServices: { getPort: () => service },
      });
      const context: CanopyHandlerContext = {
        requestId: 'legacy-read',
        caller: {
          principalId: 'test',
          clientInstanceId: 'test',
          authorityId: 'local-desktop',
          interfaceKind: 'test',
          grants: ['core.chat.read'],
        },
        metadata: {},
        signal: new AbortController().signal,
      };
      const request = {
        scope: {
          workspaceId: scope.projectId,
          worktreeId: scope.worktreeId,
          chatId: 'chat',
        },
        ...archive,
        target,
      };
      try {
        const page = await dispatcher.query(
          'core.chat.transcript.page',
          request,
          { caller: context.caller },
        );
        expect(page).toHaveProperty('runTruncated', true);
        expect(page.messages[0]).toHaveProperty('truncated', true);
        const blocks = await dispatcher.query(
          'core.chat.transcript.blocks.page',
          { ...request, messageId: 'delegated-agent-delegate:tool', limit: 1 },
          { caller: context.caller },
        );
        expect(blocks).toHaveProperty('runTruncated', true);
        if (!('blocks' in blocks)) throw new Error('Expected raw block page');
        expect(blocks.blocks).toEqual([
          {
            type: 'tool_use',
            toolUseId: 'delegated-agent-delegate:tool',
            toolName: 'shell',
            input: 'input',
          },
        ]);
        expect(
          await dispatcher.query(
            'core.chat.content.read',
            {
              ...request,
              messageId: 'delegated-agent-delegate:tool',
              blockOrdinal: 0,
              field: 'input',
              offset: 0,
              limit: 64,
            },
            { caller: context.caller },
          ),
        ).toEqual({ text: 'input', byteLength: 5, runTruncated: true });
        expect(
          await dispatcher.query(
            'core.chat.content.read',
            {
              ...request,
              messageId: 'delegated-agent-delegate:tool',
              blockOrdinal: 1,
              field: 'output',
              offset: 0,
              limit: 64,
            },
            { caller: context.caller },
          ),
        ).toEqual({ text: 'output', byteLength: 6, runTruncated: true });
        expect(
          await dispatcher.query(
            'core.chat.content.read',
            {
              ...request,
              messageId: 'delegated-agent-delegate:tool',
              blockOrdinal: 1,
              field: 'output',
              offset: 0,
              limit: 64,
              fieldSource: 'logical',
            },
            { caller: context.caller },
          ),
        ).toEqual({ text: 'output', byteLength: 6, runTruncated: true });

        expect(await snapshotFormat4Files(root)).toEqual(before);
      } finally {
        await dispatcher.shutdown();
      }
    },
  );

  it('reads the primary inline tail and registered inline fields only in logical mode', async () => {
    const { backend, service } = await fixture([
      {
        ...message('inline-primary', ''),
        blocks: [
          {
            type: 'tool_result',
            toolUseId: 'primary-tool',
            toolName: 'shell',
            output: 'x'.repeat(4000) + 'T',
            isError: false,
          },
        ],
      },
    ]);
    await backend.commitChildStream(target, 'logical-inline', [child(0)]);
    const primary = {
      ...scope,
      chatId: 'chat',
      messageId: 'inline-primary',
      blockOrdinal: 0,
      field: 'output' as const,
      requestId: 'logical',
      offset: 4000,
      limit: 64,
    };
    await expect(
      service.readTranscriptContent({ ...primary, fieldSource: 'logical' }),
    ).resolves.toEqual({ text: 'T', byteLength: 4001 });
    await expect(backend.content(primary)).rejects.toThrow(
      'Transcript field has no stored body for this row',
    );
    await expect(
      backend.content({
        ...primary,
        target,
        messageId: 'agent:row-0',
        field: 'text',
        offset: 0,
        fieldSource: 'logical',
      }),
    ).resolves.toEqual({ text: 'selected child needle 0', byteLength: 23 });
    await expect(
      backend.content({ ...primary, fieldSource: 'logical', blockOrdinal: 1 }),
    ).rejects.toThrow();
    await expect(
      backend.content({
        ...primary,
        fieldSource: 'logical',
        messageId: 'foreign',
      }),
    ).rejects.toThrow();
  });

  it('opens a registered inline field in logical mode', async () => {
    const { backend } = await fixture();
    await backend.commitChildStream(target, 'logical-stream-red', [child(0)]);
    await expect(
      backend.content({
        ...scope,
        chatId: 'chat',
        target,
        messageId: 'agent:row-0',
        blockOrdinal: 0,
        field: 'text',
        requestId: 'logical-stream',
        offset: 0,
        limit: 64,
        fieldSource: 'logical',
      }),
    ).resolves.toEqual({ text: 'selected child needle 0', byteLength: 23 });
  });

  it('ranges all five logical fields and prefers stored bodies over inline previews', async () => {
    const { backend } = await fixture([
      {
        ...message('fields', ''),
        blocks: [
          { type: 'text', text: 'plain' },
          {
            type: 'tool_use',
            toolName: 'shell',
            toolUseId: 'use',
            input: 'input',
          },
          {
            type: 'tool_result',
            toolName: 'shell',
            toolUseId: 'use',
            output: 'S'.repeat(100000) + 'TAIL',
            isError: false,
          },
          { ...card(), partialText: 'partial', finalText: 'final' },
        ],
      },
    ]);
    const base = {
      ...scope,
      chatId: 'chat',
      messageId: 'fields',
      requestId: 'fields',
      offset: 0,
      limit: 64,
      fieldSource: 'logical' as const,
    };
    for (const [blockOrdinal, field, text] of [
      [0, 'text', 'plain'],
      [1, 'input', 'input'],
      [3, 'partialText', 'partial'],
      [3, 'finalText', 'final'],
    ] as const) {
      await expect(
        backend.content({ ...base, blockOrdinal, field }),
      ).resolves.toEqual({ text, byteLength: text.length });
    }
    await expect(
      backend.content({
        ...base,
        blockOrdinal: 2,
        field: 'output',
        offset: 100000,
      }),
    ).resolves.toEqual({ text: 'TAIL', byteLength: 100004 });
    await expect(
      backend.content({
        ...base,
        blockOrdinal: 2,
        field: 'output',
        offset: 100000,
        fieldSource: 'stored',
      }),
    ).resolves.toEqual({ text: 'TAIL', byteLength: 100004 });
  });

  it('fits real inline rows with backend-minted continuations', async () => {
    const { backend } = await fixture();
    await backend.commitChildStream(target, 'bounded-real', [
      {
        ...child(0),
        blocks: [
          { type: 'text', text: 'one' },
          { type: 'text', text: 'two' },
        ],
      },
      {
        ...child(1),
        blocks: Array.from({ length: 46 }, (_, index) => ({
          type: 'text' as const,
          text: `block-${index}` + 'B'.repeat(24000),
        })),
      },
    ]);
    for (const messageId of ['agent:row-0', 'agent:row-1']) {
      const base = { ...scope, chatId: 'chat', target, messageId, limit: 1 };
      const first = await fitBoundedBlockPage(
        base,
        backend.blocks.bind(backend),
      );
      expect(first.firstBlockOrdinal).toBe(0);
      expect(first.nextBlockOrdinal).toBe(1);
      const second = await fitBoundedBlockPage(
        { ...base, cursor: first.cursor },
        backend.blocks.bind(backend),
      );
      expect(second.firstBlockOrdinal).toBe(1);
      expect(second.entries[0]?.ordinal).toBe(1);
      expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(
        786432,
      );
    }
  });

  it('keeps stream inline fields without a stored body unavailable', async () => {
    const { backend } = await fixture();
    await backend.commitChildStream(target, 'inline-control', [child(0)]);
    await expect(
      backend.content({
        ...scope,
        chatId: 'chat',
        target,
        messageId: 'agent:row-0',
        blockOrdinal: 0,
        field: 'text',
        requestId: 'stream-control',
        offset: 0,
        limit: 64,
      }),
    ).rejects.toThrow('Transcript field has no stored body for this row');
  });

  it('keeps literal primary and stream page bytes unchanged when truncation is absent', async () => {
    const { backend } = await fixture();
    await backend.commitChildStream(target, 'byte-control', [child(0)]);
    expect(JSON.stringify(await backend.page('chat'))).toBe(
      '{"messages":[{"id":"parent","role":"assistant","timestamp":1,"blocks":[{"type":"text","text":"primary only"}]}],"totalMessages":1,"transcriptRevision":0}',
    );
    expect(
      JSON.stringify(
        await backend.page('chat', undefined, undefined, { ...scope, target }),
      ),
    ).toBe(
      '{"messages":[{"id":"agent:row-0","role":"assistant","timestamp":2,"parentBlockId":"delegated-agent-delegate","delegationSequence":0,"itemRevision":0,"final":true,"blocks":[{"type":"text","text":"selected child needle 0"}]}],"totalMessages":1,"transcriptRevision":1}',
    );
  });

  it('does not rebuild a missing derived parent index while resolving legacy targets', async () => {
    const { backend, store } = await legacyFixture(
      'inline',
      [
        {
          id: 'text',
          type: 'text',
          sequence: 0,
          occurredAt: 2,
          text: 'retained',
        },
      ],
      false,
      2,
    );
    try {
      await rm(join(store.directory, 'transcripts', 'chat.index.json'));
      const before = await snapshotFormat4Files(root);
      expect(
        (await backend.page('chat', undefined, undefined, { ...scope, target }))
          .messages[0]?.id,
      ).toBe('delegated-agent-delegate:text');
      expect(await snapshotFormat4Files(root)).toEqual(before);
    } finally {
      backend.releaseJournal();
    }
  });

  it('selects each historical generation by its own exact card', async () => {
    const { transcriptStore: _marker, ...base } = card();
    void _marker;
    const cards: DelegatedAgentCallBlock[] = [1, 2, 3].map((runGeneration) => ({
      ...base,
      runGeneration,
      agentBlockId: delegationBlockId('delegate', runGeneration),
      prompt: `prompt-${runGeneration}`,
      ...(runGeneration === 2
        ? { transcriptStore: 'chat-log-v1' as const }
        : {}),
    }));
    const store = new ChatStorageV2(root, 'scope');
    await store.migrate(
      scopeSource([
        {
          id: 'chat',
          messages: [
            { ...message('parent', 'primary'), blocks: cards },
            {
              ...message('g1', 'generation one'),
              parentBlockId: 'delegated-agent-delegate',
              delegationSequence: 0,
            },
            {
              ...message('g3', 'generation three'),
              parentBlockId: 'delegated-agent-delegate-run-3',
              delegationSequence: 0,
            },
          ],
        },
      ]),
    );
    const logs = new ChatDelegationLogs(join(store.directory, 'transcripts'));
    await logs.append('chat', { delegationId: 'delegate', runGeneration: 2 }, [
      {
        id: 'g2',
        type: 'text',
        sequence: 0,
        occurredAt: 2,
        text: 'generation two',
      },
    ]);
    const backend = new ChatStateV2Backend(store);
    try {
      const first = await backend.page('chat', undefined, undefined, {
        ...scope,
        target,
      });
      const second = await backend.page('chat', undefined, undefined, {
        ...scope,
        target: { ...target, runGeneration: 2 },
      });
      const third = await backend.page('chat', undefined, undefined, {
        ...scope,
        target: { ...target, runGeneration: 3 },
      });
      expect(first.messages.map((row) => [row.id, row.blocks])).toEqual([
        ['g1', [{ type: 'text', text: 'generation one' }]],
      ]);
      expect(second.messages.map((row) => [row.id, row.blocks])).toEqual([
        [
          'delegated-agent-delegate-run-2:g2',
          [{ type: 'text', text: 'generation two' }],
        ],
      ]);
      expect(third.messages.map((row) => [row.id, row.blocks])).toEqual([
        ['g3', [{ type: 'text', text: 'generation three' }]],
      ]);
    } finally {
      backend.releaseJournal();
    }
  });

  it('skips child registry and descriptor traversal when the scope has no streams', async () => {
    const { backend } = await format4Scope(
      root,
      'empty',
      scopeSource([{ id: 'chat', messages: [message('parent', 'unchanged')] }]),
    );
    const targets = jest.spyOn(
      ChatDeltaJournalWriter.prototype,
      'childTargets',
    );
    const descriptor = jest.spyOn(
      ChatDeltaJournalWriter.prototype,
      'childDescriptor',
    );
    await backend.page('chat');
    await backend.blocks({
      ...scope,
      chatId: 'chat',
      messageId: 'parent',
      limit: 10,
    });
    await backend.state();
    expect(targets).not.toHaveBeenCalled();
    expect(descriptor).not.toHaveBeenCalled();
    await backend.flush();
    backend.releaseJournal();
  });

  it.each(['inline', 'chat-log-v1'] as const)(
    'serves a legacy %s target through the public page read',
    async (source) => {
      const { transcriptStore: _marker, ...inlineCard } = card();
      void _marker;
      const selectedCard: DelegatedAgentCallBlock = {
        ...inlineCard,
        ...(source === 'inline' ? {} : { transcriptStore: source }),
        outputTruncated: true,
      };
      const items = [
        {
          id: 'kept',
          type: 'text' as const,
          text: 'retained 🌲\ud800',
          sequence: 0,
          revision: 0,
          occurredAt: 3,
        },
      ];
      const { store, backend } = await format4Scope(
        root,
        'legacy-target',
        scopeSource([
          {
            id: 'chat',
            messages: [
              { ...message('parent', 'primary'), blocks: [selectedCard] },
              ...(source === 'inline'
                ? delegationChildMessages(selectedCard.agentBlockId, items)
                : []),
            ],
          },
        ]),
      );
      try {
        if (source === 'chat-log-v1')
          await new ChatDelegationLogs(
            join(store.directory, 'transcripts'),
          ).append('chat', target, items);
        const page = await backend.page('chat', undefined, undefined, {
          ...scope,
          target,
        });
        expect(page.messages.map((row) => row.id)).toEqual([
          'delegated-agent-delegate:kept',
        ]);
        expect(page).toHaveProperty('runTruncated', true);
        expect(page.messages[0]?.blocks).toEqual([
          { type: 'text', text: 'retained 🌲\ud800' },
        ]);
      } finally {
        backend.releaseJournal();
      }
    },
  );

  it('reads child blocks through the option-off default repository', async () => {
    const { backend, service } = await fixture();
    await backend.commitChildStream(target, 'blocks-option-off', [child(0)]);
    await backend.flush();
    backend.releaseJournal();
    expect(
      await service.getTranscriptBlocks({
        ...scope,
        chatId: 'chat',
        target,
        messageId: child(0).id,
        limit: 10,
      }),
    ).toMatchObject({
      blocks: [{ type: 'text', text: 'selected child needle 0' }],
    });
  });

  it('pages pending child rows through the real port without returning primary rows', async () => {
    const { backend, service } = await fixture();
    await backend.commitChildStream(target, 'pending', [
      child(0),
      child(1, false),
    ]);
    const page = await service.getTranscriptPage({
      ...scope,
      chatId: 'chat',
      target,
    });
    expect(page.messages.map((row) => row.id)).toEqual([
      'agent:row-0',
      'agent:row-1',
    ]);
    expect(page.cursor).toBeUndefined();
    expect(page.transcriptRevision).toBeGreaterThan(0);
  });

  it('rejects targets outside the registered parent and generation', async () => {
    const { service } = await fixture();
    const invalid: TranscriptTarget[] = [
      { ...target, chatId: 'other' },
      { ...target, delegationId: 'unregistered' },
      { ...target, runGeneration: 2 },
    ];
    for (const foreign of invalid)
      await expect(
        service.getTranscriptPage({
          ...scope,
          chatId: 'chat',
          target: foreign,
        }),
      ).rejects.toThrow('Unknown child stream');
  });

  it('reads a large stream through sequence pages without whole-log or block expansion', async () => {
    const { backend } = await fixture();
    await backend.commitChildStream(
      target,
      'history',
      Array.from({ length: TRANSCRIPT_PAGE_SIZE + 140 }, (_, index) =>
        child(index),
      ),
    );
    await backend.flush();
    const whole = jest.spyOn(transcriptLog, 'readCompleteTranscriptMessages');
    const expand = jest.spyOn(
      ChatTranscriptArtifacts.prototype,
      'expandBlocks',
    );
    const first = await backend.page('chat', undefined, undefined, {
      ...scope,
      chatId: 'chat',
      target,
    });
    expect(first.messages.length).toBeLessThan(TRANSCRIPT_PAGE_SIZE + 140);
    expect(first.cursor).toEqual(expect.any(String));
    const second = await backend.page('chat', undefined, undefined, {
      ...scope,
      chatId: 'chat',
      target,
      cursor: first.cursor,
    });
    expect(second.messages.at(-1)?.delegationSequence).toBeLessThan(
      first.messages[0]?.delegationSequence ?? 0,
    );
    expect(
      whole.mock.calls.filter(([path]) => path.includes('delegations')),
    ).toEqual([]);
    expect(expand).not.toHaveBeenCalled();
  });
  it('binds stream cursors to equal-revision targets, archive identity, scope and revision', async () => {
    const { backend } = await fixture();
    const secondTarget = { ...target, delegationId: 'second' };
    await backend.registerTranscriptStream(secondTarget);
    const rows = Array.from({ length: TRANSCRIPT_PAGE_SIZE + 40 }, (_, index) =>
      child(index),
    );
    await backend.commitChildStream(target, 'first-history', rows);
    await backend.commitChildStream(secondTarget, 'second-history', rows);
    const request = { ...scope, chatId: 'chat', target };
    const page = await backend.page('chat', undefined, undefined, request);
    expect(page.cursor).toEqual(expect.any(String));
    await expect(
      backend.page('chat', undefined, undefined, {
        ...request,
        target: {
          runGeneration: 1,
          delegationId: 'delegate',
          chatId: 'chat',
          kind: 'delegation',
        },
        cursor: page.cursor,
      }),
    ).resolves.toMatchObject({ transcriptRevision: page.transcriptRevision });
    for (const context of [
      { ...request, target: secondTarget },
      { ...request, archivedContainerId: 'archive' },
      { ...request, standaloneHistory: true },
      { ...request, worktreeId: 'other-scope' },
    ])
      await expect(
        backend.page('chat', undefined, undefined, {
          ...context,
          cursor: page.cursor,
        }),
      ).rejects.toThrow('Stale transcript stream cursor');
    for (const cursor of ['not-a-cursor', 'x'.repeat(2049)])
      await expect(
        backend.page('chat', undefined, undefined, { ...request, cursor }),
      ).rejects.toThrow('Stale transcript stream cursor');
    await expect(
      backend.page('chat', undefined, undefined, {
        ...scope,
        chatId: 'chat',
        cursor: page.cursor,
      }),
    ).rejects.toThrow('Stale transcript stream cursor');
    await expect(
      backend.blocks({
        ...request,
        messageId: child(TRANSCRIPT_PAGE_SIZE + 39).id,
        cursor: page.cursor,
        limit: 1,
      }),
    ).rejects.toThrow('Stale transcript blocks cursor');
    await backend.commitChildStream(target, 'new-row', [
      child(TRANSCRIPT_PAGE_SIZE + 40),
    ]);
    await expect(
      backend.page('chat', undefined, undefined, {
        ...request,
        cursor: page.cursor,
      }),
    ).rejects.toThrow('Stale transcript stream cursor');
    await expect(backend.page('chat', 10, undefined, request)).rejects.toThrow(
      'Stale transcript stream cursor',
    );
  });

  it('rejects child reads in format 2/3 and after parent deletion', async () => {
    const store = new ChatStorageV2(root, 'legacy');
    await store.migrate(
      scopeSource([{ id: 'chat', messages: [message('parent', 'legacy')] }]),
    );
    const legacy = new ChatStateV2Backend(store, { deltaJournal: {} });
    const request = { ...scope, chatId: 'chat', target };
    for (const promote of [false, true]) {
      if (promote) await legacy.promoteToDeltaJournal();
      await expect(
        legacy.page('chat', undefined, undefined, request),
      ).rejects.toThrow('Unknown child stream');
      await expect(legacy.registerTranscriptStream(target)).rejects.toThrow(
        'requires format 4',
      );
      await expect(
        legacy.commitChildStream(target, 'unsupported', [child(0)]),
      ).rejects.toThrow('not enabled');
      expect(await legacy.page('chat')).toEqual(
        await legacy.page('chat', undefined, undefined, {
          ...scope,
          chatId: 'chat',
        }),
      );
    }
    legacy.releaseJournal();
    const { backend } = await fixture();
    await backend.transact(() => [{ type: 'tab.removed', tabId: 'chat' }], {
      source: 'renderer-command',
    });
    await expect(
      backend.page('chat', undefined, undefined, request),
    ).rejects.toThrow('Unknown child stream');
  });

  it('authorizes child content and tool bodies through the selected row and full reference', async () => {
    const { backend, service } = await fixture();
    const toolRow: DelegationChildRow = {
      ...child(0),
      blocks: [
        {
          type: 'tool_result',
          toolName: 'shell',
          toolUseId: 'call',
          output: 'secret body '.repeat(10000),
          isError: false,
        },
        { type: 'text', text: 'large text '.repeat(10000) },
        { type: 'text', text: 'inline' },
      ],
    };
    await backend.commitChildStream(target, 'tool-body', [toolRow]);
    const foreignTarget = { ...target, delegationId: 'foreign-body' };
    await backend.registerTranscriptStream(foreignTarget);
    await backend.commitChildStream(foreignTarget, 'foreign-tool-body', [
      {
        ...toolRow,
        blocks: [
          {
            type: 'tool_result',
            toolName: 'shell',
            toolUseId: 'call',
            output: 'foreign body '.repeat(10000),
            isError: false,
          },
        ],
      },
    ]);

    const request = { ...scope, chatId: 'chat', target, messageId: toolRow.id };
    const first = await service.getTranscriptBlocks({ ...request, limit: 1 });
    expect(first).toMatchObject({
      firstBlockOrdinal: 0,
      blockCount: 3,
      nextBlockOrdinal: 1,
    });
    const block = first.blocks[0];
    if (block?.type !== 'tool_result' || !block.fullOutputRef)
      throw new Error('Missing tool body');
    const output = {
      ...request,
      requestId: 'read',
      toolUseId: 'call',
      reference: block.fullOutputRef,
      offset: 0,
      limit: 6,
    };
    await expect(
      service.readToolOutput({ ...output, target: foreignTarget }),
    ).rejects.toThrow('does not own');
    expect(await service.readToolOutput(output)).toMatchObject({
      text: 'secret',
      nextOffset: 6,
    });
    expect(
      await service.readTranscriptContent({
        ...request,
        requestId: 'field',
        blockOrdinal: 0,
        field: 'output',
        offset: 0,
        limit: 6,
      }),
    ).toMatchObject({ text: 'secret' });
    await expect(
      service.readToolOutput({ ...output, messageId: 'parent' }),
    ).rejects.toThrow('does not own');
    await expect(
      service.readToolOutput({ ...output, toolUseId: 'foreign' }),
    ).rejects.toThrow('does not own');
    await expect(
      service.readToolOutput({
        ...output,
        reference: {
          ...output.reference,
          byteLength: output.reference.byteLength + 1,
        },
      }),
    ).rejects.toThrow('does not own');
    await expect(
      service.readTranscriptContent({
        ...request,
        messageId: 'missing-row',
        requestId: 'missing-body',
        blockOrdinal: 0,
        field: 'output',
        offset: 0,
        limit: 6,
      }),
    ).rejects.toThrow('Transcript field has no stored body for this row');
    await expect(
      service.readTranscriptContent({
        ...request,
        requestId: 'inline',
        blockOrdinal: 2,
        field: 'text',
        offset: 0,
        limit: 6,
      }),
    ).rejects.toThrow('Transcript field has no stored body for this row');
    const next = await service.getTranscriptBlocks({
      ...request,
      cursor: first.cursor,
      limit: 2,
    });
    expect(next).toMatchObject({ firstBlockOrdinal: 1, blockCount: 3 });
    expect(next.cursor).toBeUndefined();
    expect(next.nextBlockOrdinal).toBeUndefined();
    const search = await service.searchTranscript({
      ...scope,
      chatId: 'chat',
      target,
      query: 'large text',
      requestId: 'search',
    });
    expect(search.totalCount).toBeGreaterThan(0);
    expect(search.matches[0]?.turnId).toBe('delegated-agent-delegate');
  });

  it('rejects a block continuation at the impossible zero position', async () => {
    const { backend } = await fixture();
    await backend.commitChildStream(target, 'zero-cursor', [
      {
        ...child(0),
        blocks: [
          { type: 'text', text: 'one' },
          { type: 'text', text: 'two' },
        ],
      },
    ]);
    const request = {
      ...scope,
      chatId: 'chat',
      target,
      messageId: child(0).id,
      limit: 1,
    };
    const first = await backend.blocks(request);
    await expect(
      backend.blocks({
        ...request,
        target: { ...target, delegationId: 'unknown-target' },
        cursor: first.cursor,
      }),
    ).rejects.toThrow('Stale transcript blocks cursor');
    const cursor = encodeChatTranscriptReadCursor(request, {
      kind: 'blocks',
      revision: first.transcriptRevision,
      position: 0,
      messageId: child(0).id,
    });
    await expect(backend.blocks({ ...request, cursor })).rejects.toThrow(
      'Stale transcript blocks cursor',
    );
  });

  it('binds block cursors to row, target, archive and revision', async () => {
    const { backend } = await fixture();
    await backend.commitChildStream(target, 'block-rows', [
      {
        ...child(0),
        blocks: [
          { type: 'text', text: 'one' },
          { type: 'text', text: 'two' },
        ],
      },
      {
        ...child(1),
        blocks: [
          { type: 'text', text: 'three' },
          { type: 'text', text: 'four' },
        ],
      },
    ]);
    const request = {
      ...scope,
      chatId: 'chat',
      target,
      messageId: child(0).id,
      limit: 1,
    };
    const first = await backend.blocks(request);
    for (const firstBlockOrdinal of [-1, 0.5, Number.NaN])
      await expect(
        backend.blocks({ ...request, firstBlockOrdinal }),
      ).rejects.toThrow('Invalid transcript block range');
    for (const context of [
      { ...request, messageId: child(1).id },
      { ...request, archivedContainerId: 'archive' },
      { ...request, standaloneHistory: true },
      { ...request, worktreeId: 'other' },
      { ...request, firstBlockOrdinal: 0 },
    ])
      await expect(
        backend.blocks({ ...context, cursor: first.cursor }),
      ).rejects.toThrow('Stale transcript blocks cursor');
    await backend.commitChildStream(target, 'advance', [child(2)]);
    await expect(
      backend.blocks({ ...request, cursor: first.cursor }),
    ).rejects.toThrow('Stale transcript blocks cursor');
  });

  it.each(['open journal', 'cold catalog'] as const)(
    'overlays journaled card state and revision on primary pages, block pages and snapshots across checkpoints (%s)',
    async (mode) => {
      const parent = { ...message('parent', ''), blocks: [card()] };
      const { backend: writer, service } = await fixture([parent]);
      await writer.commitChildStream(target, 'card-state', [], {
        key: 'card-state',
        descriptorUpdate: {
          version: 1,
          target,
          expectedStreamRevision: 0,
          nextStreamRevision: 1,
          status: 'settled',
          settleReceipt: {
            mutationId: 'card-state',
            scopeRevision: (await writer.revision()) + 1,
            streamRevision: 1,
            committedRowCount: 0,
            committedByteLength: 0,
            committedSha256: createHash('sha256').update('').digest('hex'),
          },
          cardState: {
            version: 1,
            status: 'completed',
            resultIndex: 2,
            error: null,
            usage: null,
            workspaceRevision: null,
            workspaceDiscarded: true,
            stopOutcome: null,
            controlOutcome: null,
            attribution: null,
            capabilitySummary: null,
            nestedChildSummary: null,
            partialPreview: null,
            finalPreview: 'descriptor answer',
          },
        },
      });
      let backend = writer;
      if (mode === 'cold catalog') {
        await writer.demoteFromDeltaJournal();
        writer.releaseJournal();
        backend = reopenFormat4Scope(root, 'scope', {
          enableFormat4: false,
          deltaJournal: false,
        }).backend;
      }
      for (const checkpoint of [false, true]) {
        if (checkpoint) await backend.flush();
        const revisionBefore = await backend.revision();
        const filesBefore = await snapshotFormat4Files(root);
        const page = await backend.page('chat');
        const blocks = await backend.blocks({
          ...scope,
          chatId: 'chat',
          messageId: 'parent',
          limit: 10,
        });
        const state = await backend.state({ chatIds: ['chat'] });
        expect(await backend.revision()).toBe(revisionBefore);
        expect(await snapshotFormat4Files(root)).toEqual(filesBefore);
        for (const block of [
          page.messages[0]?.blocks[0],
          blocks.blocks[0],
          state.tabsFile.tabs[0]?.messages[0]?.blocks[0],
        ])
          expect(block).toMatchObject({
            status: 'completed',
            finalText: 'descriptor answer',
            resultIndex: 2,
            workspaceDiscarded: true,
            streamRevision: 1,
          });
      }
      backend.releaseJournal();
      // Repository startup owns journal admission/derived-index recovery. Measure
      // the projection after that existing lifecycle has completed.
      await service.getState(scope);
      const filesBefore = await snapshotFormat4Files(root);
      const snapshot = await service.getState(scope);
      expect(await snapshotFormat4Files(root)).toEqual(filesBefore);
      expect(snapshot.tabsFile.tabs[0]?.messages[0]?.blocks[0]).toMatchObject({
        status: 'completed',
        finalText: 'descriptor answer',
        streamRevision: 1,
      });
    },
  );

  it('keeps service startup journal admission separate from card overlays', async () => {
    const { backend, service } = await fixture([message('parent', 'No card')]);
    await backend.demoteFromDeltaJournal();
    backend.releaseJournal();
    const registryIndex = join(
      root,
      'chat-storage-v2',
      'scope',
      'transcripts',
      'delegations',
      'chat',
      'v2',
      'registry.index.json',
    );
    // An intentionally stale derived index is recoverable without a card.
    await writeFile(registryIndex, '{}');
    const before = await snapshotFormat4Files(root);
    expect(
      before.some((file) => file.path.endsWith('/delta-journal-v2.log')),
    ).toBe(false);
    // There is no delegation card to overlay, but scope startup still admits
    // the existing journal. This control does not claim startup is read-only.
    const snapshot = await service.getState(scope);
    const after = await snapshotFormat4Files(root);
    expect(
      after.some((file) => file.path.endsWith('/delta-journal-v2.log')),
    ).toBe(true);
    const rebuilt: unknown = JSON.parse(await readFile(registryIndex, 'utf8'));
    expect(rebuilt).toHaveProperty('version', 1);
    expect(rebuilt).toHaveProperty('entries', expect.any(Object));
    expect(snapshot.tabsFile.tabs[0]?.messages[0]?.blocks).toEqual([
      { type: 'text', text: 'No card' },
    ]);
  });

  it.each([
    ['open journal', 0],
    ['cold catalog', 0],
    ['open journal', 1],
    ['cold catalog', 1],
  ] as const)(
    'stamps a null-CardState descriptor without writes (%s, revision %s)',
    async (mode, streamRevision) => {
      const parent = { ...message('parent', ''), blocks: [card()] };
      const { backend: writer } = await fixture([parent]);
      // A row-only commit advances the real descriptor without creating CardState.
      if (streamRevision === 1)
        await writer.commitChildStream(target, 'row-only', [child(0)]);
      else await writer.revision(); // Open the registered journal for the zero case.
      let backend = writer;
      if (mode === 'cold catalog') {
        await writer.demoteFromDeltaJournal();
        writer.releaseJournal();
        backend = reopenFormat4Scope(root, 'scope', {
          enableFormat4: false,
          deltaJournal: false,
        }).backend;
      }
      const revisionBefore = await backend.revision();
      const filesBefore = await snapshotFormat4Files(root);
      const page = await backend.page('chat');
      const blocks = await backend.blocks({
        ...scope,
        chatId: 'chat',
        messageId: 'parent',
        limit: 10,
      });
      const state = await backend.state({ chatIds: ['chat'] });
      expect(await backend.revision()).toBe(revisionBefore);
      expect(await snapshotFormat4Files(root)).toEqual(filesBefore);
      backend.releaseJournal();
      for (const block of [
        page.messages[0]?.blocks[0],
        blocks.blocks[0],
        state.tabsFile.tabs[0]?.messages[0]?.blocks[0],
      ])
        expect(block).toEqual({ ...card(), streamRevision });
    },
  );

  it('retains explicit ceiling-3 child rejection in standalone and container branches', async () => {
    const store = new ChatStorageV2(root, 'archive', undefined, {
      maxManifestVersion: 3,
    });
    await store.migrate(
      scopeSource([
        {
          id: 'chat',
          messages: [
            {
              ...message('parent', 'archived primary'),
              blocks: [
                { type: 'text', text: 'archived primary' },
                {
                  type: 'tool_result',
                  toolUseId: 'archive-call',
                  toolName: 'shell',
                  output: 'archive output '.repeat(10000),
                  isError: false,
                },
              ],
            },
          ],
        },
      ]),
    );
    jest
      .spyOn(standaloneHistory, 'getStandaloneHistoryStorage')
      .mockResolvedValue(store);
    jest
      .spyOn(archivedContainers, 'getArchivedContainerChatStorage')
      .mockResolvedValue(store);
    const service = new ChatStateService({ recordDiagnostic: jest.fn() });
    for (const archive of [
      { standaloneHistory: true },
      { archivedContainerId: 'container' },
    ]) {
      const request = { ...scope, chatId: 'chat', ...archive };
      expect((await service.getTranscriptPage(request)).messages[0]?.id).toBe(
        'parent',
      );
      const primaryBlocks = await service.getTranscriptBlocks({
        ...request,
        messageId: 'parent',
        firstBlockOrdinal: 1,
        limit: 1,
      });
      const archivedTool = primaryBlocks.blocks[0];
      if (archivedTool?.type !== 'tool_result' || !archivedTool.fullOutputRef)
        throw new Error('Missing archive tool body');
      expect(primaryBlocks.blockCount).toBe(2);
      expect(
        await service.readTranscriptContent({
          ...request,
          messageId: 'parent',
          blockOrdinal: 1,
          field: 'output',
          requestId: 'primary-archive-content',
          offset: 0,
          limit: 7,
        }),
      ).toMatchObject({ text: 'archive' });
      expect(
        await service.readToolOutput({
          ...request,
          messageId: 'parent',
          toolUseId: 'archive-call',
          reference: archivedTool.fullOutputRef,
          requestId: 'primary-archive-output',
          offset: 0,
          limit: 7,
        }),
      ).toMatchObject({ text: 'archive' });
      const selected = { ...request, target, messageId: child(0).id };
      await expect(service.getTranscriptPage(selected)).rejects.toThrow(
        'Unknown child stream',
      );
      await expect(
        service.getTranscriptBlocks({ ...selected, limit: 1 }),
      ).rejects.toThrow('Unknown child stream');
      await expect(
        service.readTranscriptContent({
          ...selected,
          requestId: 'archive-content',
          blockOrdinal: 0,
          field: 'text',
          offset: 0,
          limit: 10,
        }),
      ).rejects.toThrow('Unknown child stream');
      await expect(
        service.readToolOutput({
          ...selected,
          requestId: 'archive-tool',
          toolUseId: 'call',
          offset: 0,
          limit: 10,
          reference: {
            version: 1,
            artifactId: `sha256-v1-${'a'.repeat(64)}`,
            sha256: 'a'.repeat(64),
            byteLength: 1,
            encoding: 'utf-8',
            mediaType: 'text/plain',
          },
        }),
      ).rejects.toThrow('Unknown child stream');
    }
  });

  it('reads ceiling-4 archives through direct backends with distinct cursor identities', async () => {
    const { backend } = await fixture();
    await backend.commitChildStream(
      target,
      'archive-rows',
      Array.from({ length: TRANSCRIPT_PAGE_SIZE + 40 }, (_, index) =>
        child(index),
      ),
    );
    await backend.flush();
    backend.releaseJournal();
    const archive = new ChatStateV2Backend(
      new ChatStorageV2(root, 'scope', undefined, { maxManifestVersion: 4 }),
      { deltaJournal: {}, enableFormat4: true },
    );
    for (const identity of [
      { archivedContainerId: 'container' },
      { standaloneHistory: true },
    ]) {
      const request = { ...scope, chatId: 'chat', target, ...identity };
      const first = await archive.page('chat', undefined, undefined, request);
      expect(first.messages.length).toBeGreaterThan(0);
      expect(first.cursor).toEqual(expect.any(String));
      expect(
        (
          await archive.page('chat', undefined, undefined, {
            ...request,
            cursor: first.cursor,
          })
        ).messages[0]?.id,
      ).toBe(child(0).id);
    }
  });

  it('exercises all five adapter operations over a real service and format-4 repository', async () => {
    const { backend, service } = await fixture();
    const row: DelegationChildRow = {
      ...child(0),
      blocks: [
        {
          type: 'tool_result',
          toolName: 'shell',
          toolUseId: 'adapter-call',
          output: 'adapter body '.repeat(10000),
          isError: false,
        },
        { type: 'text', text: 'adapter needle' },
      ],
    };
    await backend.commitChildStream(target, 'adapter-row', [row]);
    const handlers = createCoreChatReadAdapter({ getPort: () => service });
    const context: CanopyHandlerContext = {
      requestId: 'adapter-read',
      caller: {
        principalId: 'test',
        clientInstanceId: 'test',
        authorityId: 'local-desktop',
        interfaceKind: 'test',
        grants: ['core.chat.read'],
      },
      metadata: {},
      signal: new AbortController().signal,
    };
    const portableScope = {
      workspaceId: scope.projectId,
      worktreeId: scope.worktreeId,
      chatId: 'chat',
    };
    const request = { scope: portableScope, target };
    const page = await handlers['core.chat.transcript.page'](request, context);
    expect(page.messages[0]?.id).toBe(row.id);
    const blocks = await handlers['core.chat.transcript.blocks.page'](
      { ...request, messageId: row.id, limit: 1 },
      context,
    );
    if (!('blocks' in blocks)) throw new Error('Expected raw block page');
    const block = blocks.blocks[0];
    if (
      typeof block !== 'object' ||
      block === null ||
      !('type' in block) ||
      block.type !== 'tool_result' ||
      !('fullOutputRef' in block)
    )
      throw new Error('Missing portable tool body');
    // The portable block schema is deliberately broad; the typed port result supplies the same reference.
    const stored = (
      await service.getTranscriptBlocks({
        ...scope,
        chatId: 'chat',
        target,
        messageId: row.id,
        limit: 1,
      })
    ).blocks[0];
    if (stored?.type !== 'tool_result' || !stored.fullOutputRef)
      throw new Error('Missing stored tool body');
    expect(
      await handlers['core.chat.toolOutput.read'](
        {
          ...request,
          messageId: row.id,
          toolUseId: 'adapter-call',
          reference: stored.fullOutputRef,
          offset: 0,
          limit: 7,
        },
        context,
      ),
    ).toMatchObject({ text: 'adapter' });
    expect(
      await handlers['core.chat.content.read'](
        {
          ...request,
          messageId: row.id,
          blockOrdinal: 0,
          field: 'output',
          offset: 0,
          limit: 7,
        },
        context,
      ),
    ).toMatchObject({ text: 'adapter' });
    expect(
      await handlers['core.chat.transcript.search'](
        { ...request, query: 'needle' },
        context,
      ),
    ).toMatchObject({
      totalCount: 1,
      matches: [{ turnId: 'delegated-agent-delegate' }],
    });
  });
  it('reads chunks and an early tool output in an old paged child row without expansion', async () => {
    const { backend } = await fixture();
    const old: DelegationChildRow = {
      ...child(0),
      blocks: [
        {
          type: 'tool_result',
          toolName: 'shell',
          toolUseId: 'old-call',
          output: 'early output '.repeat(10000),
          isError: false,
        },
        ...Array.from({ length: 300 }, (_, index) => ({
          type: 'text' as const,
          text: `${index}:` + 'x'.repeat(6000),
        })),
      ],
    };
    await backend.commitChildStream(target, 'old-paged', [old]);
    await backend.commitChildStream(
      target,
      'new-history',
      Array.from({ length: TRANSCRIPT_PAGE_SIZE + 40 }, (_, index) =>
        child(index + 1),
      ),
    );
    await backend.flush();
    const expand = jest.spyOn(
      ChatTranscriptArtifacts.prototype,
      'expandBlocks',
    );
    const whole = jest.spyOn(transcriptLog, 'readCompleteTranscriptMessages');
    const request = { ...scope, chatId: 'chat', target, messageId: old.id };
    const first = await backend.blocks({ ...request, limit: 1 });
    expect(first.blockCount).toBe(301);
    const block = first.blocks[0];
    if (block?.type !== 'tool_result' || !block.fullOutputRef)
      throw new Error('Missing old output body');
    for (const offset of [0, 6, 0]) {
      expect(
        await backend.content({
          ...request,
          requestId: 'chunk',
          blockOrdinal: 0,
          field: 'output',
          offset,
          limit: 6,
        }),
      ).toMatchObject({ text: 'early output '.slice(offset, offset + 6) });
      expect(
        await backend.toolOutput(
          'chat',
          old.id,
          'old-call',
          block.fullOutputRef,
          offset,
          6,
          undefined,
          {
            ...request,
            requestId: 'old-output',
            toolUseId: 'old-call',
            reference: block.fullOutputRef,
            offset,
            limit: 6,
          },
        ),
      ).toMatchObject({ text: 'early output '.slice(offset, offset + 6) });
    }
    const last = await backend.blocks({
      ...request,
      firstBlockOrdinal: 300,
      limit: 2,
    });
    expect(last.blocks).toHaveLength(1);
    expect(last.cursor).toBeUndefined();
    expect(expand).not.toHaveBeenCalled();
    expect(
      whole.mock.calls.filter(([path]) => path.includes('delegations')),
    ).toEqual([]);
  });
  it('reads open child rows after the scope leaves its journal', async () => {
    const { backend } = await fixture();
    await backend.commitChildStream(target, 'demoted-rows', [
      child(0),
      child(1, false),
    ]);
    await backend.flush();
    expect(await backend.demoteFromDeltaJournal()).toBe(true);
    const request = { ...scope, chatId: 'chat', target };
    const page = await backend.page('chat', undefined, undefined, request);
    expect(page.messages.map((row) => row.id)).toEqual([
      child(0).id,
      child(1).id,
    ]);
    const blocks = await backend.blocks({
      ...request,
      messageId: child(1).id,
      limit: 10,
    });
    expect(blocks.blocks).toEqual(child(1, false).blocks);
    const search = await backend.search({
      ...request,
      query: 'needle 1',
      requestId: 'demoted-search',
    });
    expect(search.matches.map((match) => match.messageId)).toEqual([
      child(1).id,
    ]);
  });

  it('refuses a same-length edit to a committed child log read without a journal', async () => {
    const { backend } = await fixture();
    await backend.commitChildStream(target, 'demoted-final', [child(0)]);
    await backend.flush();
    expect(await backend.demoteFromDeltaJournal()).toBe(true);
    const request = { ...scope, chatId: 'chat', target };
    expect(
      (await backend.page('chat', undefined, undefined, request)).messages,
    ).toHaveLength(1);
    const log = join(
      root,
      'chat-storage-v2',
      'scope',
      'transcripts',
      'delegations',
      'chat',
      'v2',
      delegationStreamKey(target),
      'transcript.jsonl',
    );
    const original = await readFile(log, 'utf8');
    await writeFile(log, original.replace('needle 0', 'needle 9'));
    await expect(
      backend.page('chat', undefined, undefined, request),
    ).rejects.toThrow();
  });

  it('keeps interleaved open, committed and newly journaled rows in display order across pages', async () => {
    const { backend } = await fixture();
    await backend.commitChildStream(target, 'interleaved-history', [
      child(0, false),
      ...Array.from({ length: TRANSCRIPT_PAGE_SIZE + 10 }, (_, index) =>
        child(index + 1, index + 1 !== 60),
      ),
    ]);
    await backend.flush();
    await backend.commitChildStream(target, 'later-open', [
      child(TRANSCRIPT_PAGE_SIZE + 11, false),
    ]);
    const pages: string[][] = [];
    let cursor: string | undefined;
    do {
      const page = await backend.page('chat', undefined, undefined, {
        ...scope,
        chatId: 'chat',
        target,
        ...(cursor === undefined ? {} : { cursor }),
      });
      pages.unshift(page.messages.map((row) => row.id));
      cursor = page.cursor;
    } while (cursor !== undefined);
    expect(pages.flat()).toEqual(
      Array.from(
        { length: TRANSCRIPT_PAGE_SIZE + 12 },
        (_, index) => child(index).id,
      ),
    );
    await backend.commitChildStream(target, 'finalize-old-open', [
      { ...child(0), itemRevision: 1 },
    ]);
    await backend.flush();
    const last = await backend.page('chat', undefined, undefined, {
      ...scope,
      chatId: 'chat',
      target,
    });
    const older = await backend.page('chat', undefined, undefined, {
      ...scope,
      chatId: 'chat',
      target,
      cursor: last.cursor,
    });
    expect([...older.messages, ...last.messages].map((row) => row.id)).toEqual(
      pages.flat(),
    );
  });
});

describe('transcript read cursor codec', () => {
  it('versions and bounds tokens and binds operation, scope, target, row and archive identity', () => {
    const context = { ...scope, chatId: 'chat', target };
    const token = encodeChatTranscriptReadCursor(context, {
      kind: 'blocks',
      revision: 7,
      position: 3,
      messageId: 'row',
    });
    expect(token.length).toBeLessThanOrEqual(2048);
    expect(
      decodeChatTranscriptReadCursor(token, 'blocks', context, 'row'),
    ).toMatchObject({ version: 1, revision: 7, position: 3 });
    expect(() =>
      decodeChatTranscriptReadCursor(token, 'stream', context),
    ).toThrow('Stale transcript stream cursor');
    for (const foreign of [
      { ...context, projectId: 'foreign' },
      { ...context, target: { ...target, runGeneration: 2 } },
      { ...context, archivedContainerId: 'archive' },
      { ...context, standaloneHistory: true },
      { ...context, standaloneHistory: true, archivedContainerId: 'archive' },
    ])
      expect(() =>
        decodeChatTranscriptReadCursor(token, 'blocks', foreign, 'row'),
      ).toThrow('Stale transcript blocks cursor');
    expect(() =>
      decodeChatTranscriptReadCursor(token, 'blocks', context, 'foreign-row'),
    ).toThrow('Stale transcript blocks cursor');
    for (const invalid of [
      '',
      'x'.repeat(2049),
      token + '=',
      Buffer.from('{"version":2}').toString('base64url'),
    ])
      expect(() =>
        decodeChatTranscriptReadCursor(invalid, 'blocks', context, 'row'),
      ).toThrow('Stale transcript blocks cursor');
  });
});
