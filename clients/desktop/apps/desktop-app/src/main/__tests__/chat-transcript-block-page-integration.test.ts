/** C07/C18: bounded stored rows retain their complete artifact and logical closure. */
import { mkdtemp, readdir, readFile, rm, stat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  DelegatedAgentCallBlock,
  PersistedChatMessage,
  PersistedToolOutputReference,
} from '@canopy/agent-transcript/types';
import type { DelegationChildRow } from '@canopy/agent-transcript';
import type { AgentDelegationTranscriptItem } from '@canopy/protocol/delegation';
import { ChatTranscriptArtifacts } from '../lib/chat-transcript-artifacts';
import {
  ChatTranscriptLog,
  TranscriptStreamStore,
} from '../lib/chat-transcript-log';
import {
  delegationStreamKey,
  delegationTranscriptPaths,
} from '../lib/transcript-stream-paths';
import {
  buildTurnIndex,
  isTranscriptTurnIndex,
} from '../lib/chat-transcript-turn-index';
import { MAX_TRANSCRIPT_ROW_BYTES } from '../lib/chat-transcript-prefix-replace';
import {
  ChatStorageV2,
  assertChatStorageIndexes,
} from '../lib/chat-storage-v2';
import { openReplayedChatScope } from '../lib/chat-delta-journal/reader';
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
const run = { delegationId: 'logged', runGeneration: 1 };
const childItems: AgentDelegationTranscriptItem[] = [
  {
    id: 'answer',
    sequence: 1,
    occurredAt: 1,
    type: 'text',
    text: 'Child answer',
  },
];
const output = 'tool output sentinel\n'.repeat(6000);

function card(): DelegatedAgentCallBlock {
  return {
    type: 'delegated_agent_call',
    ...run,
    status: 'completed',
    outputTruncated: false,
    agentBlockId: 'delegated-agent-logged',
    sequence: 1,
    parentHarnessId: 'claude',
    parentTurnId: 'prompt',
    parentToolCallId: 'spawn',
    createdAt: 1,
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
    prompt: 'Review it',
    executionMode: 'background',
    transcriptStore: 'chat-log-v1',
  };
}

/** Each unbacked text field is below the body threshold; together they exceed the guard. */
function manyBlocks(id = 'paged', withCard = false): PersistedChatMessage {
  return {
    id,
    role: 'assistant',
    timestamp: 2,
    blocks: [
      ...Array.from({ length: 300 }, (_, ordinal) => ({
        type: 'text' as const,
        text: `${ordinal}:` + 'x'.repeat(60 * 1024),
      })),
      {
        type: 'tool_use',
        toolUseId: 'call',
        toolName: 'Read',
        input: 'file.ts',
      },
      {
        type: 'tool_result',
        toolUseId: 'call',
        toolName: 'Read',
        output,
        isError: false,
      },
      ...(withCard ? [card()] : []),
    ],
  };
}

async function upsert(
  backend: ChatStateV2Backend,
  row: PersistedChatMessage,
): Promise<void> {
  await backend.transact(
    () => [{ type: 'message.upserted', chatId: 'chat', message: row }],
    { source: 'automation' },
  );
}

async function rows(
  backend: ChatStateV2Backend,
  chatId = 'chat',
  full = false,
  inline = false,
): Promise<PersistedChatMessage[]> {
  return backend.consumeTranscript(
    chatId,
    full,
    async (source) => {
      const result: PersistedChatMessage[] = [];
      for await (const row of source) result.push(row);
      return result;
    },
    { inlineDelegationChildren: inline },
  );
}

async function names(store: ChatStorageV2, chatId = 'chat'): Promise<string[]> {
  return (
    await readdir(join(store.directory, 'transcripts', 'tool-output', chatId))
  ).sort();
}

async function maintain(backend: ChatStateV2Backend): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await backend.maintainArtifacts('chat')).complete) return;
  }
  throw new Error('Artifact maintenance did not complete');
}

function outputReference(
  row: PersistedChatMessage,
): PersistedToolOutputReference {
  const block = row.blocks.find((block) => block.type === 'tool_result');
  if (block?.type !== 'tool_result' || !block.fullOutputRef)
    throw new Error('Missing tool output');
  return block.fullOutputRef;
}

describe('block page consumer integration', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'chat-block-page-integration-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('keeps bounded primary rows stable through checkpoint, replay, reopen, capture and full reads', async () => {
    const { store, backend } = await format4Scope(
      root,
      'source',
      scopeSource([
        { id: 'chat', messages: [message('prompt', 'hello', 'user')] },
      ]),
    );
    const logical = manyBlocks();
    try {
      await upsert(backend, logical);
      const stored = (await rows(backend)).find((row) => row.id === logical.id);
      if (!stored) throw new Error('Missing paged row');
      expect(stored.blocks).toEqual([]);
      expect(stored.blocksRef?.blockCount).toBe(logical.blocks.length);
      expect(Buffer.byteLength(JSON.stringify(stored))).toBeLessThan(
        MAX_TRANSCRIPT_ROW_BYTES,
      );
      const artifacts = new ChatTranscriptArtifacts(
        join(store.directory, 'transcripts'),
      );
      const expanded = await artifacts.expandBlocks('chat', stored);
      const reference = outputReference(expanded);
      const files = await names(store);
      await backend.flush();
      const logPath = join(store.directory, 'transcripts', 'chat.jsonl');
      const bytes = await readFile(logPath);
      const identity = await stat(logPath, { bigint: true });
      await upsert(backend, logical);
      await backend.flush();
      expect(await readFile(logPath)).toEqual(bytes);
      expect((await stat(logPath, { bigint: true })).ino).toBe(identity.ino);
      await upsert(backend, stored);
      await backend.flush();
      expect(await readFile(logPath)).toEqual(bytes);
      expect(await names(store)).toEqual(files);
      await expect(
        backend.toolOutput('chat', logical.id, 'call', reference, 0, 30),
      ).resolves.toMatchObject({ text: output.slice(0, 30) });
      const foreign = await artifacts.put('chat', 'foreign reference');
      await expect(
        backend.toolOutput('chat', logical.id, 'call', foreign, 0, 30),
      ).rejects.toThrow('does not own');
      await expect(
        backend.toolOutput('chat', logical.id, 'other', reference, 0, 30),
      ).rejects.toThrow('does not own');
      await expect(
        backend.toolOutput(
          'chat',
          logical.id,
          'call',
          { ...reference, byteLength: reference.byteLength + 1 },
          0,
          30,
        ),
      ).rejects.toThrow('does not own');
      await backend.flush();
      const page = await backend.page('chat', undefined, undefined, {
        view: 'turns',
      });
      expect(page.messages.find((row) => row.id === logical.id)).toEqual(
        stored,
      );
      const cached: unknown = JSON.parse(
        await readFile(
          join(store.directory, 'transcripts', 'chat.turns.json'),
          'utf8',
        ),
      );
      if (!isTranscriptTurnIndex(cached)) throw new Error('Missing turn index');
      expect(cached.turns).toEqual(
        await buildTurnIndex([message('prompt', 'hello', 'user'), expanded]),
      );
      const view = await openReplayedChatScope(
        { directory: store.directory, scopeId: 'source' },
        assertChatStorageIndexes,
        { maxManifestVersion: 4 },
      );
      try {
        const row = await view
          .transcript('chat')
          .readMessage('chat', logical.id);
        expect(row).toEqual(stored);
        if (!row) throw new Error('Missing replay row');
        expect(
          await view.transcript('chat').artifacts.expandBlocks('chat', row),
        ).toEqual(expanded);
      } finally {
        await view.dispose();
      }
      const capture = new ChatStorageV2(root, 'capture', undefined, {
        maxManifestVersion: 4,
      });
      await store.copyTo(capture);
      const captured = new ChatTranscriptLog(
        join(capture.directory, 'transcripts'),
        undefined,
        { readOnly: true },
      );
      const capturedRow = await captured.readMessage('chat', logical.id);
      expect(capturedRow).toEqual(stored);
      expect(await names(capture)).toEqual(files);
      const reopened = reopenFormat4Scope(root, 'source');
      try {
        expect(
          (await rows(reopened.backend, 'chat', true)).find(
            (row) => row.id === logical.id,
          ),
        ).toEqual(logical);
        await expect(
          reopened.backend.toolOutput(
            'chat',
            logical.id,
            'call',
            reference,
            0,
            30,
          ),
        ).resolves.toMatchObject({ text: output.slice(0, 30) });
        const log = new ChatTranscriptLog(
          join(store.directory, 'transcripts'),
          undefined,
          { readOnly: true },
        );
        await expect(
          log.readFieldRange(
            'chat',
            logical.id,
            { blockOrdinal: 301, field: 'output' },
            0,
            30,
          ),
        ).resolves.toMatchObject({ text: output.slice(0, 30) });
      } finally {
        await reopened.backend.disposeArtifactMaintenance();
      }
    } finally {
      await backend.disposeArtifactMaintenance();
    }
  });

  it('keeps primary pages and log-backed cards independently on fork and format 4 import', async () => {
    const source = await format4Scope(
      root,
      'source',
      scopeSource([
        { id: 'chat', messages: [message('prompt', 'hello', 'user')] },
        { id: 'sibling', messages: [] },
      ]),
    );
    const destination = await format4Scope(
      root,
      'destination',
      scopeSource([{ id: 'other', messages: [] }]),
    );
    const logical = manyBlocks('paged', true);
    try {
      await upsert(source.backend, logical);
      await source.backend.appendDelegationLog('chat', [
        { run, items: childItems },
      ]);
      await source.backend.flush();
      const state = await source.backend.state({
        chatIds: ['chat'],
        fullTranscript: true,
      });
      await destination.backend.importScope(source.store, {
        tabsFile: state.tabsFile,
        archivesFile: state.archivesFile,
      });
      await source.backend.transact(
        (current) => [
          {
            type: 'tab.created',
            transcriptSourceChatId: 'chat',
            tab: { ...current.tabsFile.tabs[0], id: 'fork', title: 'Fork' },
          },
        ],
        { source: 'automation', chatIds: ['chat'], fullTranscript: true },
      );
      const files = await names(source.store);
      expect(await names(source.store, 'fork')).toEqual(files);
      expect(await names(destination.store)).toEqual(files);
      await source.backend.transact(
        () => [{ type: 'tab.removed', tabId: 'chat' }],
        { source: 'automation' },
      );
      await source.backend.flush();
      for (const [backend, chatId] of [
        [source.backend, 'fork'],
        [destination.backend, 'chat'],
      ] as const) {
        expect(
          (await rows(backend, chatId, true)).find(
            (row) => row.id === logical.id,
          ),
        ).toEqual(logical);
        expect(await backend.readDelegationItems(chatId, run)).toEqual(
          childItems,
        );
        const exported = await rows(backend, chatId, true, true);
        expect(
          exported.some(
            (row) =>
              row.parentBlockId === card().agentBlockId &&
              row.blocks.some(
                (block) =>
                  block.type === 'text' && block.text === 'Child answer',
              ),
          ),
        ).toBe(true);
        expect(
          exported.find((row) => row.id === logical.id)?.blocks,
        ).toHaveLength(logical.blocks.length);
        expect(
          exported.find((row) => row.id === logical.id)?.blocks.at(-1),
        ).not.toHaveProperty('transcriptStore');
      }
      await source.backend.disposeArtifactMaintenance();
      await rm(source.store.directory, { recursive: true, force: true });
      expect(
        (await rows(destination.backend, 'chat', true)).find(
          (row) => row.id === logical.id,
        ),
      ).toEqual(logical);
      expect(
        await destination.backend.readDelegationItems('chat', run),
      ).toEqual(childItems);
    } finally {
      await source.backend.disposeArtifactMaintenance();
      await destination.backend.disposeArtifactMaintenance();
    }
  });

  it('keeps a pending paged child stream through lease-free replay, checkpoint, capture and reopen', async () => {
    const { store, backend } = await format4Scope(
      root,
      'source',
      scopeSource([
        { id: 'chat', messages: [message('prompt', 'hello', 'user')] },
      ]),
    );
    const logical: DelegationChildRow = {
      ...manyBlocks('agent:item'),
      parentBlockId: 'agent',
      delegationSequence: 0,
      itemRevision: 0,
      final: true,
    };
    try {
      await backend.registerTranscriptStream(target);
      await backend.commitChildStream(target, 'child-pages', [logical]);
      expect(backend.pendingJournalRecords()).toBeGreaterThan(0);
      const view = await openReplayedChatScope(
        { directory: store.directory, scopeId: 'source' },
        assertChatStorageIndexes,
        { maxManifestVersion: 4 },
      );
      let stored: DelegationChildRow | undefined;
      try {
        stored = (await view.stream(target)).rows[0];
        expect(stored?.blocksRef?.blockCount).toBe(logical.blocks.length);
        expect(stored?.blocks).toEqual([]);
        if (!stored) throw new Error('Missing child row');
        const artifacts = new ChatTranscriptArtifacts(
          join(store.directory, 'transcripts'),
        );
        const expanded = await artifacts.expandBlocks('chat', stored);
        expect(expanded.blocks.slice(0, 300)).toEqual(
          logical.blocks.slice(0, 300),
        );
      } finally {
        await view.dispose();
      }
      const files = await names(store);
      await backend.commitChildStream(target, 'child-pages-again', [logical]);
      expect(await names(store)).toEqual(files);
      await backend.flush();
      await maintain(backend);
      expect(await names(store)).toEqual(files);
      const capture = new ChatStorageV2(root, 'capture', undefined, {
        maxManifestVersion: 4,
      });
      await store.copyTo(capture);
      expect(await names(capture)).toEqual(files);
      const reopened = await openReplayedChatScope(
        { directory: store.directory, scopeId: 'source' },
        assertChatStorageIndexes,
        { maxManifestVersion: 4 },
      );
      try {
        expect((await reopened.stream(target)).rows[0]).toEqual(stored);
      } finally {
        await reopened.dispose();
      }
      // Captures are checkpoint-only, with no selected journal to replay.
      for (const directory of [store.directory, capture.directory]) {
        const transcripts = join(directory, 'transcripts');
        const child = new TranscriptStreamStore(
          delegationTranscriptPaths(transcripts, target),
          new ChatTranscriptArtifacts(transcripts, true),
          undefined,
          { readOnly: true, childMode: true },
        );
        const key = delegationStreamKey(target);
        expect(await child.readMessage(key, logical.id)).toEqual(stored);
        await expect(
          child.readFieldRange(
            key,
            logical.id,
            { blockOrdinal: 301, field: 'output' },
            0,
            30,
          ),
        ).resolves.toMatchObject({ text: output.slice(0, 30) });
      }
    } finally {
      await backend.disposeArtifactMaintenance();
    }
  });

  it('keeps live pages in GC and reclaims them once the row is removed', async () => {
    const { store, backend } = await format4Scope(
      root,
      'source',
      scopeSource([
        { id: 'chat', messages: [message('prompt', 'hello', 'user')] },
      ]),
    );
    try {
      await upsert(backend, manyBlocks());
      await backend.flush();
      const files = await names(store);
      expect(files.length).toBeGreaterThan(2);
      await maintain(backend);
      expect(await names(store)).toEqual(files);
      await backend.transact(
        () => [{ type: 'message.removed', chatId: 'chat', messageId: 'paged' }],
        { source: 'automation' },
      );
      await backend.flush();
      await maintain(backend);
      expect(await names(store)).toEqual([]);
    } finally {
      await backend.disposeArtifactMaintenance();
    }
  });

  it.each([2, 3])(
    'fails closed importing paged rows into format %s',
    async (version) => {
      const source = await format4Scope(
        root,
        'source',
        scopeSource([{ id: 'chat', messages: [] }]),
      );
      const store = new ChatStorageV2(root, 'destination');
      await store.migrate(scopeSource([{ id: 'other', messages: [] }]));
      const destination = new ChatStateV2Backend(
        store,
        version === 3 ? { deltaJournal: {} } : undefined,
      );
      try {
        if (version === 3) await destination.promoteToDeltaJournal();
        await upsert(source.backend, manyBlocks());
        await source.backend.flush();
        const state = await source.backend.state({
          chatIds: ['chat'],
          fullTranscript: true,
        });
        await expect(
          destination.importScope(source.store, {
            tabsFile: state.tabsFile,
            archivesFile: state.archivesFile,
          }),
        ).rejects.toThrow(/block pages.*format 4/i);
        expect(
          (await destination.state()).tabsFile.tabs.map((tab) => tab.id),
        ).toEqual(['other']);
      } finally {
        await source.backend.disposeArtifactMaintenance();
        await destination.disposeArtifactMaintenance();
      }
    },
  );

  it('refuses capture when a live page or manifest is missing', async () => {
    const { store, backend } = await format4Scope(
      root,
      'source',
      scopeSource([{ id: 'chat', messages: [] }]),
    );
    try {
      await upsert(backend, manyBlocks());
      await backend.flush();
      const stored = (await rows(backend)).find((row) => row.id === 'paged');
      if (!stored?.blocksRef) throw new Error('Missing pages');
      await unlink(
        join(
          store.directory,
          'transcripts',
          'tool-output',
          'chat',
          `${stored.blocksRef.manifest.artifactId}.txt`,
        ),
      );
      const destination = new ChatStorageV2(root, 'capture', undefined, {
        maxManifestVersion: 4,
      });
      await expect(store.copyTo(destination)).rejects.toThrow();
      expect(await destination.authority()).toBe('v1');
    } finally {
      await backend.disposeArtifactMaintenance();
    }
  });
});
