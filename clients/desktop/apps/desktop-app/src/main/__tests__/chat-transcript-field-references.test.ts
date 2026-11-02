/**
 * Phase 07a write seams: the field policy follows the manifest the scope
 * transaction selected. Format 4 publishes final generalized fields once and
 * verifies prepared rows; formats 2 and 3, and a ceiling-4 scope that was
 * never promoted, keep the legacy bytes.
 */
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  DelegatedAgentCallBlock,
  PersistedChatMessage,
} from '@canopy/agent-transcript/types';
import type { DelegationChildRow } from '@canopy/agent-transcript';
import { transcriptBodyReferences } from '@canopy/agent-transcript/transcript-storage';
import {
  ChatStorageV2,
  assertChatStorageIndexes,
} from '../lib/chat-storage-v2';
import {
  ChatTranscriptArtifacts,
  type TranscriptFieldPolicy,
} from '../lib/chat-transcript-artifacts';
import { applyTranscriptEffect } from '../lib/chat-delta-journal/materialize';
import {
  ChatTranscriptLog,
  TranscriptStreamStore,
} from '../lib/chat-transcript-log';
import {
  delegationStreamKey,
  delegationTranscriptPaths,
} from '../lib/transcript-stream-paths';
import type { TranscriptFieldPreparation } from '../services/chat-state-contracts';
import { openReplayedChatScope } from '../lib/chat-delta-journal/reader';
import { ChatDeltaJournalIntegrityError } from '../lib/chat-delta-journal/format';
import { ChatStateV2Backend } from '../services/chat-state-v2-backend';
import { format4Scope, reopenFormat4Scope } from './helpers/chat-format4-scope';
import { message, scopeSource } from './helpers/chat-delta-journal-harness';

jest.setTimeout(240_000);

const target = {
  kind: 'delegation' as const,
  chatId: 'chat',
  delegationId: 'child',
  runGeneration: 0,
};

function large(label: string, bytes = 100 * 1024): string {
  const unit = `${label} 🌲字 body\n`;
  const half = unit.repeat(Math.ceil(bytes / 2 / Buffer.byteLength(unit)));
  return `${label} begin\n${half}${label} sentinel-middle\n${half}${label} end`;
}

function delegatedCard(
  fields: Partial<DelegatedAgentCallBlock>,
): DelegatedAgentCallBlock {
  return {
    type: 'delegated_agent_call',
    delegationId: 'child-1',
    status: 'completed',
    outputTruncated: false,
    agentBlockId: 'delegated-agent-child-1',
    runGeneration: 1,
    sequence: 1,
    parentHarnessId: 'claude',
    parentTurnId: 'user-1',
    parentToolCallId: 'call-1',
    createdAt: 1000,
    routeSnapshot: {
      selectedModelId: 'model',
      runtimeModelId: 'model',
      harnessId: 'claude',
      runtimeKind: 'sdk',
      runnerRegistrationId: 'claude-runner',
      runtimeVersion: '1',
      adapterVersion: '1',
      modelSource: 'agent',
      providerType: 'anthropic',
      assignmentRevision: '1',
      billingAuthority: 'local',
      aiCreditsRouted: false,
      capabilities: [],
      supportedThinkingLevels: [],
      capabilitySnapshotHash: 'hash',
      capabilityGeneration: 1,
      policyRevision: '1',
    },
    selectedModelId: 'model',
    runtimeModelId: 'model',
    targetHarnessId: 'claude',
    description: 'Review',
    prompt: 'Read the source.',
    executionMode: 'background',
    ...fields,
  };
}

/** Every generalized carrier plus tool output, each above the threshold. */
function largeFieldRow(id = 'large'): PersistedChatMessage {
  return {
    id,
    role: 'assistant',
    timestamp: 2,
    blocks: [
      { type: 'text', text: large('text') },
      { type: 'thinking', text: large('thinking') },
      {
        type: 'tool_use',
        toolUseId: 'call-1',
        toolName: 'shell',
        input: large('input'),
      },
      {
        type: 'tool_result',
        toolUseId: 'call-1',
        toolName: 'shell',
        output: large('output'),
        isError: false,
      },
      delegatedCard({
        partialText: large('partial'),
        finalText: large('final'),
      }),
    ],
  };
}

async function committedRow(
  backend: ChatStateV2Backend,
  id: string,
  fullOutputs = false,
): Promise<PersistedChatMessage | undefined> {
  return backend.consumeTranscript('chat', fullOutputs, async (messages) => {
    for await (const candidate of messages)
      if (candidate.id === id) return candidate;
    return undefined;
  });
}

async function upsert(
  backend: ChatStateV2Backend,
  row: PersistedChatMessage,
  status?: 'streaming',
): Promise<void> {
  await backend.transact(
    () => [
      { type: 'message.upserted', chatId: 'chat', message: row },
      ...(status
        ? [
            {
              type: 'runtime.patched' as const,
              chatId: 'chat',
              runtime: { status, queuedMessageIds: [] },
            },
          ]
        : []),
    ],
    { source: 'automation' },
  );
}

async function artifactNames(
  directory: string,
  chatId = 'chat',
): Promise<string[]> {
  try {
    return (
      await readdir(join(directory, 'transcripts', 'tool-output', chatId))
    )
      .filter((name) => name.endsWith('.txt'))
      .sort();
  } catch {
    return [];
  }
}

describe('format-gated transcript field references', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'chat-field-references-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('publishes final fields once on format 4 and re-upserts an unchanged row without a patch', async () => {
    const { store, backend } = await format4Scope(
      root,
      'scope',
      scopeSource([{ id: 'chat', messages: [message('parent', 'hello')] }]),
    );
    try {
      const row = largeFieldRow();
      await upsert(backend, row);
      await backend.flush();
      const stored = await committedRow(backend, 'large');
      expect(
        stored && transcriptBodyReferences(stored).map((entry) => entry.field),
      ).toEqual([
        'text',
        'text',
        'input',
        'output',
        'partialText',
        'finalText',
      ]);
      // Previews keep the head and tail; the middle lives only in artifacts.
      expect(JSON.stringify(stored)).not.toContain('sentinel-middle');
      const log = join(store.directory, 'transcripts', 'chat.jsonl');
      const bytes = await readFile(log);
      const identity = await stat(log, { bigint: true });
      const files = await artifactNames(store.directory);
      expect(files).toHaveLength(6);

      await upsert(backend, row);
      await backend.flush();
      expect(await readFile(log)).toEqual(bytes);
      expect((await stat(log, { bigint: true })).ino).toBe(identity.ino);
      expect(await artifactNames(store.directory)).toEqual(files);
      // The prepared form is identical too, so its re-upsert is no patch either.
      if (stored) await upsert(backend, stored);
      await backend.flush();
      expect(await readFile(log)).toEqual(bytes);
      expect(await committedRow(backend, 'large', true)).toEqual(row);
    } finally {
      await backend.disposeArtifactMaintenance();
    }
  });

  it('keeps an open format-4 row inline and publishes it when the turn ends', async () => {
    const { store, backend } = await format4Scope(
      root,
      'scope',
      scopeSource([{ id: 'chat', messages: [message('parent', 'hello')] }]),
    );
    try {
      const row = message('open', large('open'));
      await upsert(backend, row, 'streaming');
      await backend.flush();
      expect(await artifactNames(store.directory)).toEqual([]);
      // The open row is stored inline and whole, with no reference.
      expect(await committedRow(backend, 'open')).toEqual(row);
      await backend.transact(
        () => [
          {
            type: 'runtime.patched',
            chatId: 'chat',
            runtime: { status: 'idle', queuedMessageIds: [] },
          },
        ],
        { source: 'automation' },
      );
      await backend.flush();
      const stored = await committedRow(backend, 'open');
      expect(stored?.blocks[0]).toMatchObject({ type: 'text' });
      expect(stored && transcriptBodyReferences(stored)).toHaveLength(1);
      expect(await committedRow(backend, 'open', true)).toEqual(row);
    } finally {
      await backend.disposeArtifactMaintenance();
    }
  });

  it.each(['format 2', 'format 3', 'ceiling 4 unpromoted'] as const)(
    'writes legacy bytes on a %s scope',
    async (format) => {
      const store = new ChatStorageV2(
        root,
        'scope',
        undefined,
        format === 'ceiling 4 unpromoted' ? { maxManifestVersion: 4 } : {},
      );
      await store.migrate(
        scopeSource([{ id: 'chat', messages: [message('parent', 'hello')] }]),
      );
      const backend = new ChatStateV2Backend(store, {
        ...(format === 'format 2' ? {} : { deltaJournal: {} }),
        ...(format === 'ceiling 4 unpromoted' ? { enableFormat4: true } : {}),
      });
      try {
        if (format !== 'format 2') await backend.promoteToDeltaJournal();
        expect(await store.format()).toBe(format === 'format 2' ? 'v2' : 'v3');
        const row = largeFieldRow();
        await upsert(backend, row);
        await backend.flush();
        const oracleRoot = join(root, 'oracle');
        const oracle = await new ChatTranscriptArtifacts(
          oracleRoot,
        ).externalize('chat', row);
        expect(JSON.stringify(await committedRow(backend, 'large'))).toBe(
          JSON.stringify(oracle),
        );
        expect(await artifactNames(store.directory)).toEqual(
          (await readdir(join(oracleRoot, 'tool-output', 'chat'))).sort(),
        );
      } finally {
        await backend.disposeArtifactMaintenance();
      }
    },
  );

  it.each([
    ['just over 1 MiB', 1024 * 1024 + 7],
    ['just over 16 MiB', 16 * 1024 * 1024 + 7],
  ])(
    'retains a %s command body as a verified reference on both targets',
    async (_label, bytes) => {
      const { store, backend } = await format4Scope(
        root,
        'scope',
        scopeSource([{ id: 'chat', messages: [message('parent', 'hello')] }]),
      );
      const output = large('command', bytes);
      const tool = (id: string): PersistedChatMessage => ({
        id,
        role: 'assistant',
        timestamp: 2,
        blocks: [
          {
            type: 'tool_result',
            toolUseId: `${id}-call`,
            toolName: 'shell',
            output,
            isError: false,
          },
        ],
      });
      const child: DelegationChildRow = {
        ...tool('agent:tool'),
        parentBlockId: 'agent',
        delegationSequence: 0,
        itemRevision: 0,
        final: true,
      };
      try {
        await upsert(backend, tool('primary'));
        await backend.registerTranscriptStream(target);
        await backend.commitChildStream(target, 'child-tool', [child]);
        await backend.flush();
      } finally {
        await backend.disposeArtifactMaintenance();
      }
      const reopened = reopenFormat4Scope(root, 'scope');
      try {
        const stored = await committedRow(reopened.backend, 'primary');
        const reference = stored && transcriptBodyReferences(stored)[0];
        expect(reference?.field).toBe('output');
        expect(Buffer.byteLength(JSON.stringify(stored), 'utf8')).toBeLessThan(
          128 * 1024,
        );
        expect(await committedRow(reopened.backend, 'primary', true)).toEqual(
          tool('primary'),
        );
        const view = await openReplayedChatScope(
          { directory: store.directory, scopeId: 'scope' },
          assertChatStorageIndexes,
          { maxManifestVersion: 4 },
        );
        try {
          const page = await view.stream(target);
          const [row] = page.rows;
          expect(row && transcriptBodyReferences(row)).toEqual([
            {
              blockOrdinal: 0,
              field: 'output',
              reference: reference?.reference,
            },
          ]);
        } finally {
          await view.dispose();
        }
        const capture = new ChatStorageV2(root, 'capture', undefined, {
          maxManifestVersion: 4,
        });
        await store.copyTo(capture);
        const copied = new ChatTranscriptArtifacts(
          join(capture.directory, 'transcripts'),
          true,
        );
        if (!reference) throw new Error('Missing reference');
        await copied.verify('chat', reference.reference);
        const head = (
          await copied.readRange('chat', reference.reference, 0, 64)
        ).text;
        expect(head.length).toBeGreaterThan(0);
        expect(output.startsWith(head)).toBe(true);
      } finally {
        await reopened.backend.disposeArtifactMaintenance();
      }
    },
  );

  it('fails recovery of a pending final row whose large field has no reference, without publishing', async () => {
    const { store, backend } = await format4Scope(
      root,
      'scope',
      scopeSource([{ id: 'chat', messages: [message('parent', 'hello')] }]),
    );
    await backend.registerTranscriptStream(target);
    const row: DelegationChildRow = {
      ...message('agent:text', large('unbacked')),
      parentBlockId: 'agent',
      delegationSequence: 0,
      itemRevision: 0,
      final: true,
    };
    // Simulate a record written without preparation (an older or faulty writer).
    const externalize = jest
      .spyOn(ChatTranscriptArtifacts.prototype, 'externalize')
      .mockImplementation((_chatId, value) => Promise.resolve(value));
    try {
      await backend.commitChildStream(target, 'unbacked', [row]);
    } finally {
      externalize.mockRestore();
      await backend.disposeArtifactMaintenance();
    }
    const before = await artifactNames(store.directory);
    await expect(
      openReplayedChatScope(
        { directory: store.directory, scopeId: 'scope' },
        assertChatStorageIndexes,
        { maxManifestVersion: 4 },
      ),
    ).rejects.toThrow(ChatDeltaJournalIntegrityError);
    const reopened = reopenFormat4Scope(root, 'scope');
    try {
      await expect(reopened.backend.load()).rejects.toThrow(
        ChatDeltaJournalIntegrityError,
      );
    } finally {
      await reopened.backend.disposeArtifactMaintenance();
    }
    expect(await artifactNames(store.directory)).toEqual(before);
  });

  it('reads a stored field range only through the row that owns it', async () => {
    const { store, backend } = await format4Scope(
      root,
      'scope',
      scopeSource([{ id: 'chat', messages: [message('parent', 'hello')] }]),
    );
    const row = largeFieldRow();
    const child: DelegationChildRow = {
      ...largeFieldRow('agent:item'),
      parentBlockId: 'agent',
      delegationSequence: 0,
      itemRevision: 0,
      final: true,
    };
    try {
      await upsert(backend, row);
      await backend.registerTranscriptStream(target);
      await backend.commitChildStream(target, 'child-fields', [child]);
      await backend.flush();
    } finally {
      await backend.disposeArtifactMaintenance();
    }
    const transcripts = join(store.directory, 'transcripts');
    const readAll = async (
      read: (offset: number) => Promise<{ text: string; nextOffset?: number }>,
    ): Promise<string> => {
      const parts: string[] = [];
      for (let offset: number | undefined = 0; offset !== undefined; ) {
        const part = await read(offset);
        parts.push(part.text);
        offset = part.nextOffset;
      }
      return parts.join('');
    };
    const primary = new ChatTranscriptLog(transcripts, undefined, {
      readOnly: true,
    });
    const childStore = new TranscriptStreamStore(
      delegationTranscriptPaths(transcripts, target),
      new ChatTranscriptArtifacts(transcripts, true),
      undefined,
      { readOnly: true, childMode: true },
    );
    const key = delegationStreamKey(target);
    const fields = [
      { blockOrdinal: 0, field: 'text', body: large('text') },
      { blockOrdinal: 1, field: 'text', body: large('thinking') },
      { blockOrdinal: 2, field: 'input', body: large('input') },
      { blockOrdinal: 3, field: 'output', body: large('output') },
      { blockOrdinal: 4, field: 'partialText', body: large('partial') },
      { blockOrdinal: 4, field: 'finalText', body: large('final') },
    ] as const;
    for (const { blockOrdinal, field, body } of fields) {
      expect(
        await readAll((offset) =>
          primary.readFieldRange(
            'chat',
            'large',
            { blockOrdinal, field },
            offset,
          ),
        ),
      ).toBe(body);
      expect(
        await readAll((offset) =>
          childStore.readFieldRange(
            key,
            'agent:item',
            { blockOrdinal, field },
            offset,
            4096,
          ),
        ),
      ).toBe(body);
    }
    await expect(
      primary.readFieldRange('chat', 'large', {
        blockOrdinal: 0,
        field: 'input',
      }),
    ).rejects.toThrow('no stored body');
    await expect(
      primary.readFieldRange('chat', 'parent', {
        blockOrdinal: 0,
        field: 'text',
      }),
    ).rejects.toThrow('no stored body');
    await expect(
      primary.readFieldRange('chat', 'missing', {
        blockOrdinal: 0,
        field: 'text',
      }),
    ).rejects.toThrow('no stored body');
    // '🌲' is four UTF-8 bytes: offset 1 into it is never a character start.
    const textRef = (await primary.readMessage('chat', 'large'))?.blocks[0];
    expect(textRef?.type === 'text' && textRef.textRef).toBeTruthy();
    await expect(
      primary.readFieldRange(
        'chat',
        'large',
        { blockOrdinal: 0, field: 'text' },
        Buffer.byteLength('text begin\ntext ') + 1,
      ),
    ).rejects.toThrow('splits a UTF-8 character');
  });

  it('prepares final fields in a checkpointed format-4 file transaction', async () => {
    const created = await format4Scope(
      root,
      'scope',
      scopeSource([{ id: 'chat', messages: [message('parent', 'hello')] }]),
    );
    await created.backend.demoteFromDeltaJournal();
    await created.backend.disposeArtifactMaintenance();
    const { store, backend } = reopenFormat4Scope(root, 'scope', {
      deltaJournal: false,
    });
    try {
      expect(await store.format()).toBe('v4');
      expect(await store.journalFile()).toBeUndefined();
      const row = largeFieldRow();
      await upsert(backend, row);
      const stored = await committedRow(backend, 'large');
      expect(stored && transcriptBodyReferences(stored)).toHaveLength(6);
      const log = join(store.directory, 'transcripts', 'chat.jsonl');
      const bytes = await readFile(log);
      await upsert(backend, row);
      expect(await readFile(log)).toEqual(bytes);
      expect(await committedRow(backend, 'large', true)).toEqual(row);
    } finally {
      await backend.disposeArtifactMaintenance();
    }
  });

  it('offers the field preparation port only on format 4 and discards its body on rollback', async () => {
    const { store, backend } = await format4Scope(
      root,
      'scope',
      scopeSource([{ id: 'chat', messages: [message('parent', 'hello')] }]),
    );
    try {
      let port: TranscriptFieldPreparation | undefined;
      const body = large('streamed');
      await expect(
        backend.transact(
          async (_current, _revision, context) => {
            port = context.transcriptFields;
            await context.transcriptFields?.publish('chat', [
              body.slice(0, 1000),
              body.slice(1000),
            ]);
            throw new Error('build failed');
          },
          { source: 'automation' },
        ),
      ).rejects.toThrow('build failed');
      expect(port?.format).toBe(4);
      expect(await artifactNames(store.directory)).toEqual([]);
      await expect(
        backend.transact(
          async (_current, _revision, context) => {
            await context.transcriptFields?.publish('elsewhere', ['x']);
            return [];
          },
          { source: 'automation' },
        ),
      ).rejects.toThrow('not in this scope');
      const reference = await new Promise<
        Awaited<ReturnType<TranscriptFieldPreparation['publish']>>
      >((resolve, reject) => {
        backend
          .transact(
            async (_current, _revision, context) => {
              const published = await context.transcriptFields?.publish(
                'chat',
                [body],
              );
              if (!published) throw new Error('No port');
              resolve(published);
              return [
                {
                  type: 'message.upserted',
                  chatId: 'chat',
                  message: {
                    id: 'streamed',
                    role: 'assistant',
                    timestamp: 3,
                    blocks: [
                      { type: 'text', text: 'preview', textRef: published },
                    ],
                  },
                },
              ];
            },
            { source: 'automation' },
          )
          .catch(reject);
      });
      await backend.flush();
      expect(await artifactNames(store.directory)).toEqual([
        `${reference.artifactId}.txt`,
      ]);
      expect((await committedRow(backend, 'streamed', true))?.blocks).toEqual([
        { type: 'text', text: body },
      ]);
    } finally {
      await backend.disposeArtifactMaintenance();
    }
    const legacy = new ChatStorageV2(root, 'legacy');
    await legacy.migrate(
      scopeSource([{ id: 'chat', messages: [message('parent', 'hello')] }]),
    );
    const legacyBackend = new ChatStateV2Backend(legacy, { deltaJournal: {} });
    try {
      await legacyBackend.promoteToDeltaJournal();
      let offered: TranscriptFieldPreparation | undefined;
      await legacyBackend.transact(
        (_current, _revision, context) => {
          offered = context.transcriptFields;
          return [];
        },
        { source: 'automation' },
      );
      expect(offered).toBeUndefined();
    } finally {
      await legacyBackend.disposeArtifactMaintenance();
    }
  });
});

describe('paged transcript block consumers', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'chat-paged-block-consumers-'));
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  it('resolves field ordinals and tool-output ownership through bounded page reads', async () => {
    const transcripts = join(root, 'transcripts');
    const artifacts = new ChatTranscriptArtifacts(transcripts);
    const body = 'paged tool output';
    const reference = await artifacts.put('chat', body);
    const manifest = await artifacts.put('chat', 'unused mocked manifest');
    const stored: PersistedChatMessage = {
      id: 'paged',
      role: 'assistant',
      timestamp: 2,
      blocks: [],
      blocksRef: { version: 1, manifest, blockCount: 2 },
    };
    const logical: PersistedChatMessage = {
      id: 'paged',
      role: 'assistant',
      timestamp: 2,
      blocks: [
        { type: 'text', text: 'prefix' },
        {
          type: 'tool_result',
          toolUseId: 'call-1',
          toolName: 'shell',
          output: 'preview',
          isError: false,
          fullOutputRef: reference,
        },
      ],
    };
    // The append's index pass expands the row; point and ownership reads
    // must then open only the pages they need, never the whole row.
    const expandBlocks = jest
      .spyOn(ChatTranscriptArtifacts.prototype, 'expandBlocks')
      .mockImplementation((_chatId, message) =>
        Promise.resolve(message.id === 'paged' ? logical : message),
      );
    const readBlocks = jest
      .spyOn(ChatTranscriptArtifacts.prototype, 'readBlocks')
      .mockImplementation((_chatId, message, first, limit) =>
        Promise.resolve(
          (message.id === 'paged' ? logical : message).blocks.slice(
            first,
            first + limit,
          ),
        ),
      );
    const iterateBlocks = jest
      .spyOn(ChatTranscriptArtifacts.prototype, 'iterateBlocks')
      .mockImplementation(async function* (_chatId, message) {
        for (const block of (message.id === 'paged' ? logical : message).blocks)
          yield await Promise.resolve(block);
      });
    const externalize = jest
      .spyOn(ChatTranscriptArtifacts.prototype, 'externalize')
      .mockImplementation((_chatId, message) => Promise.resolve(message));
    const log = new ChatTranscriptLog(transcripts);
    await log.initialize('chat');
    try {
      await log.append('chat', [stored]);
      expandBlocks.mockClear();

      await expect(
        log.readFieldRange('chat', 'paged', {
          blockOrdinal: 1,
          field: 'output',
        }),
      ).resolves.toMatchObject({ text: body });
      expect(
        readBlocks.mock.calls.map((call) => [call[1].id, call[2], call[3]]),
      ).toContainEqual(['paged', 1, 1]);
      expect(
        await log.ownsToolOutputReference('chat', 'paged', 'call-1', reference),
      ).toBe(true);
      expect(
        await log.ownsToolOutputReference(
          'chat',
          'paged',
          'other-call',
          reference,
        ),
      ).toBe(false);
      expect(
        await log.ownsToolOutputReference('chat', 'paged', 'call-1', {
          ...reference,
          byteLength: reference.byteLength + 1,
        }),
      ).toBe(false);
      expect(iterateBlocks).toHaveBeenCalled();
      expect(expandBlocks).not.toHaveBeenCalled();
    } finally {
      expandBlocks.mockRestore();
      readBlocks.mockRestore();
      iterateBlocks.mockRestore();
      externalize.mockRestore();
    }
  });

  it('expands turn-index inputs without expanding the returned page rows', async () => {
    const transcripts = join(root, 'transcripts');
    const artifacts = new ChatTranscriptArtifacts(transcripts);
    const manifest = await artifacts.put('chat', 'unused mocked manifest');
    const stored: PersistedChatMessage = {
      id: 'paged-turn',
      role: 'assistant',
      timestamp: 2,
      blocks: [],
      blocksRef: { version: 1, manifest, blockCount: 1 },
    };
    const logical: PersistedChatMessage = {
      id: 'paged-turn',
      role: 'assistant',
      timestamp: 2,
      blocks: [{ type: 'turn_timer', completedAt: 3 }],
    };
    const expandBlocks = jest
      .spyOn(ChatTranscriptArtifacts.prototype, 'expandBlocks')
      .mockImplementation((_chatId, message) =>
        Promise.resolve(message.id === 'paged-turn' ? logical : message),
      );
    const externalize = jest
      .spyOn(ChatTranscriptArtifacts.prototype, 'externalize')
      .mockImplementation((_chatId, message) => Promise.resolve(message));
    const log = new ChatTranscriptLog(transcripts);
    await log.initialize('chat');
    try {
      await log.append('chat', [stored]);

      const page = await log.page('chat', undefined, { view: 'turns' });

      expect(expandBlocks.mock.calls.map((call) => call[1].id)).toContain(
        'paged-turn',
      );
      expect(page.messages).toEqual([stored]);
    } finally {
      expandBlocks.mockRestore();
      externalize.mockRestore();
    }
  });
});

// Captured before any spy replaces it; always invoked with `.call(instance)`.
// eslint-disable-next-line @typescript-eslint/unbound-method -- spy pass-through needs the original method; remove when jest exposes it
const original = ChatTranscriptArtifacts.prototype.externalize;

describe('format-4 materialization verifies prepared rows', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'chat-field-materialize-'));
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  /** Record every externalize policy and any publication while `work` runs. */
  async function observe(work: () => Promise<void>): Promise<{
    policies: Array<TranscriptFieldPolicy['kind']>;
    published: number;
  }> {
    const policies: Array<TranscriptFieldPolicy['kind']> = [];
    const externalize = jest
      .spyOn(ChatTranscriptArtifacts.prototype, 'externalize')
      .mockImplementation(function (
        this: ChatTranscriptArtifacts,
        chatId,
        value,
        created,
        policy,
      ) {
        policies.push(policy?.kind ?? 'legacy');
        return original.call(this, chatId, value, created, policy);
      });
    const put = jest.spyOn(ChatTranscriptArtifacts.prototype, 'put');
    const putStream = jest.spyOn(
      ChatTranscriptArtifacts.prototype,
      'putStream',
    );
    try {
      await work();
      return {
        policies,
        published: put.mock.calls.length + putStream.mock.calls.length,
      };
    } finally {
      externalize.mockRestore();
      put.mockRestore();
      putStream.mockRestore();
    }
  }

  it('checkpoints and reads a pending textRef record in verify mode without publishing', async () => {
    const { store, backend } = await format4Scope(
      root,
      'scope',
      scopeSource([{ id: 'chat', messages: [message('parent', 'hello')] }]),
    );
    const body = large('prepared');
    const reference = await new ChatTranscriptArtifacts(
      join(store.directory, 'transcripts'),
    ).put('chat', body);
    const final: PersistedChatMessage = {
      id: 'prepared',
      role: 'assistant',
      timestamp: 2,
      blocks: [{ type: 'text', text: 'preview', textRef: reference }],
    };
    const open: PersistedChatMessage = {
      id: 'open',
      role: 'assistant',
      timestamp: 3,
      blocks: [{ type: 'text', text: 'open preview', textRef: reference }],
    };
    try {
      await upsert(backend, final);
      await upsert(backend, open, 'streaming');
      expect(backend.pendingJournalRecords()).toBeGreaterThan(0);
      const files = await artifactNames(store.directory);
      expect(files).toEqual([`${reference.artifactId}.txt`]);

      const read = await observe(async () => {
        const view = await openReplayedChatScope(
          { directory: store.directory, scopeId: 'scope' },
          assertChatStorageIndexes,
          { maxManifestVersion: 4 },
        );
        try {
          expect(
            await view.transcript('chat').readMessage('chat', 'open'),
          ).toEqual(open);
          expect(
            await view.transcript('chat').readMessage('chat', 'prepared'),
          ).toEqual(final);
        } finally {
          await view.dispose();
        }
      });
      expect(read.policies.length).toBeGreaterThan(0);
      expect(new Set(read.policies)).toEqual(new Set(['format4-verify']));
      expect(read.published).toBe(0);

      const checkpoint = await observe(() => backend.flush());
      expect(backend.pendingJournalRecords()).toBe(0);
      expect(checkpoint.policies.length).toBeGreaterThan(0);
      expect(new Set(checkpoint.policies)).toEqual(new Set(['format4-verify']));
      expect(checkpoint.published).toBe(0);
      expect(await artifactNames(store.directory)).toEqual(files);
      expect(await committedRow(backend, 'prepared')).toEqual(final);
      expect((await committedRow(backend, 'prepared', true))?.blocks).toEqual([
        { type: 'text', text: body },
      ]);
    } finally {
      await backend.disposeArtifactMaintenance();
    }
  });

  it('fails a pending primary record with an unbacked large final field as an integrity error', async () => {
    const { store, backend } = await format4Scope(
      root,
      'scope',
      scopeSource([{ id: 'chat', messages: [message('parent', 'hello')] }]),
    );
    // A writer that skipped preparation; verification stays real.
    jest
      .spyOn(ChatTranscriptArtifacts.prototype, 'externalize')
      .mockImplementation(function (
        this: ChatTranscriptArtifacts,
        chatId,
        value,
        created,
        policy,
      ) {
        return policy?.kind === 'format4'
          ? Promise.resolve(value)
          : original.call(this, chatId, value, created, policy);
      });
    try {
      await upsert(backend, message('unbacked', large('unbacked'))).catch(
        () => undefined,
      );
    } finally {
      jest.restoreAllMocks();
      await backend.disposeArtifactMaintenance();
    }
    const before = await artifactNames(store.directory);
    await expect(
      openReplayedChatScope(
        { directory: store.directory, scopeId: 'scope' },
        assertChatStorageIndexes,
        { maxManifestVersion: 4 },
      ),
    ).rejects.toThrow(ChatDeltaJournalIntegrityError);
    const reopened = reopenFormat4Scope(root, 'scope');
    try {
      await expect(reopened.backend.load()).rejects.toThrow(
        ChatDeltaJournalIntegrityError,
      );
    } finally {
      await reopened.backend.disposeArtifactMaintenance();
    }
    expect(await artifactNames(store.directory)).toEqual(before);
  });

  it.each(['append', 'replace'] as const)(
    'refuses to materialize an unbacked large final row from a %s effect',
    async (kind) => {
      const transcripts = join(root, 'transcripts');
      const log = new ChatTranscriptLog(transcripts);
      await log.initialize('chat');
      const row = message('unbacked', large('unbacked'));
      const effect =
        kind === 'append'
          ? { chatId: 'chat', kind, create: false, messages: [row] }
          : {
              chatId: 'chat',
              kind,
              create: false,
              messages: [row],
              activeTailCount: 0,
              priorTranscriptRevision: 0,
            };
      await expect(
        applyTranscriptEffect(
          log,
          transcripts,
          effect,
          1,
          join(root, 'work'),
          'format4-verify',
        ),
      ).rejects.toThrow('without a lossless artifact');
      expect(await artifactNames(root)).toEqual([]);
      // The same row is an open active row: inline and whole is valid.
      await applyTranscriptEffect(
        log,
        transcripts,
        { chatId: 'chat', kind: 'active', create: false, messages: [row] },
        1,
        join(root, 'work'),
        'format4-verify',
      );
      expect(await log.readMessage('chat', 'unbacked')).toEqual(row);
    },
  );

  it('keeps a large inline row committed before promotion through a patch, verifying only the record rows', async () => {
    const transcripts = join(root, 'transcripts');
    const log = new ChatTranscriptLog(transcripts);
    await log.initialize('chat');
    // Format 3 committed this final row inline; promotion converts no row.
    const legacy: PersistedChatMessage = {
      id: 'legacy',
      role: 'assistant',
      timestamp: 2,
      blocks: [
        {
          type: 'tool_use',
          toolUseId: 'call-1',
          toolName: 'write',
          input: large('input'),
        },
      ],
    };
    await log.append('chat', [message('parent', 'hello'), legacy]);
    const patch = (
      patched: PersistedChatMessage,
      revision: number,
    ): Promise<void> =>
      applyTranscriptEffect(
        log,
        transcripts,
        {
          chatId: 'chat',
          kind: 'patch',
          patches: [patched],
          removedMessageIds: [],
          tail: [],
          activeTailCount: 0,
          priorTranscriptRevision: revision - 1,
        },
        revision,
        join(root, 'work'),
        'format4-verify',
      );
    await patch(message('parent', 'hello again'), 2);
    expect(await log.readMessage('chat', 'legacy')).toEqual(legacy);
    expect(await log.readMessage('chat', 'parent')).toEqual(
      message('parent', 'hello again'),
    );
    // A row the record carries must still have been prepared.
    await expect(
      patch(message('parent', large('unbacked')), 3),
    ).rejects.toThrow('without a lossless artifact');
    expect(await artifactNames(root)).toEqual([]);
  });

  it('converges an active write over its finalized row and refuses a different one', async () => {
    const transcripts = join(root, 'transcripts');
    const log = new ChatTranscriptLog(transcripts);
    await log.initialize('chat');
    const open = message('open', large('open'));
    await log.append('chat', [open], undefined, undefined, 'format4');
    const files = await artifactNames(root);
    expect(files).toHaveLength(1);
    // Replay re-applies the turn's open write after finalization.
    await log.writeActive('chat', [open], undefined, 'format4-verify');
    expect(await log.activeMessages('chat')).toEqual([]);
    await expect(
      log.writeActive(
        'chat',
        [message('open', large('other'))],
        undefined,
        'format4-verify',
      ),
    ).rejects.toThrow('Active message conflicts with committed history');
    expect(await artifactNames(root)).toEqual(files);
  });

  it('checkpoints and reopens a patched scope holding a large inline row from before promotion', async () => {
    const legacy: PersistedChatMessage = {
      id: 'legacy',
      role: 'assistant',
      timestamp: 2,
      blocks: [
        {
          type: 'tool_use',
          toolUseId: 'call-1',
          toolName: 'write',
          input: large('input'),
        },
      ],
    };
    const { store, backend } = await format4Scope(
      root,
      'scope',
      scopeSource([
        { id: 'chat', messages: [message('parent', 'hello'), legacy] },
      ]),
    );
    try {
      expect(await committedRow(backend, 'legacy')).toEqual(legacy);
      // The patch rewrites the log and checkpoints through materialization.
      await upsert(backend, message('parent', 'hello again'));
      const view = await openReplayedChatScope(
        { directory: store.directory, scopeId: 'scope' },
        assertChatStorageIndexes,
        { maxManifestVersion: 4 },
      );
      try {
        expect(
          await view.transcript('chat').readMessage('chat', 'legacy'),
        ).toEqual(legacy);
      } finally {
        await view.dispose();
      }
      await backend.flush();
      expect(backend.pendingJournalRecords()).toBe(0);
    } finally {
      await backend.disposeArtifactMaintenance();
    }
    const reopened = reopenFormat4Scope(root, 'scope');
    try {
      await reopened.backend.load();
      expect(await committedRow(reopened.backend, 'legacy')).toEqual(legacy);
      expect(await committedRow(reopened.backend, 'parent')).toEqual(
        message('parent', 'hello again'),
      );
    } finally {
      await reopened.backend.disposeArtifactMaintenance();
    }
  });
});
