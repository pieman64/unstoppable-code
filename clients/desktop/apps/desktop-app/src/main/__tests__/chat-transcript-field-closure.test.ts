/**
 * Phase 07a closure: every site that enumerates, verifies, keeps or copies
 * transcript artifacts must see the generalized body references (`textRef`,
 * `inputRef`, `partialTextRef`, `finalTextRef`), not only `fullOutputRef`.
 * Rows are seeded through ordinary store writes carrying already-published
 * references, so each case exercises the closure site and not externalize.
 */
import { mkdtemp, readdir, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  DelegatedAgentCallBlock,
  PersistedChatBlock,
  PersistedChatMessage,
  PersistedToolOutputReference,
} from '@canopy/agent-transcript/types';
import type { DelegationChildRow } from '@canopy/agent-transcript';
import {
  encodeTranscriptBlockManifest,
  encodeTranscriptBlockPage,
  transcriptBodyReferences,
  type TranscriptBlockManifest,
  type TranscriptBlockPage,
} from '@canopy/agent-transcript/transcript-storage';
import { ChatStorageV2 } from '../lib/chat-storage-v2';
import { assertChatStorageIndexes } from '../lib/chat-storage-v2';
import { ChatTranscriptArtifacts } from '../lib/chat-transcript-artifacts';
import { openReplayedChatScope } from '../lib/chat-delta-journal/reader';
import { ChatStateV2Backend } from '../services/chat-state-v2-backend';
import { format4Scope, reopenFormat4Scope } from './helpers/chat-format4-scope';
import { message, scopeSource } from './helpers/chat-delta-journal-harness';

jest.setTimeout(180_000);

const KINDS = [
  'text',
  'thinking',
  'input',
  'partialText',
  'finalText',
] as const;
type Kind = (typeof KINDS)[number];
type References = Record<Kind, PersistedToolOutputReference>;

function body(kind: Kind): string {
  return `${kind} begin\n${`${kind} 🌲字 middle\n`.repeat(6_000)}${kind} end`;
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

function referenceBlocks(references: References): PersistedChatBlock[] {
  return [
    { type: 'text', text: 'text preview', textRef: references.text },
    {
      type: 'thinking',
      text: 'thinking preview',
      textRef: references.thinking,
    },
    {
      type: 'tool_use',
      toolUseId: 'call-1',
      toolName: 'shell',
      input: 'input preview',
      inputRef: references.input,
    },
    delegatedCard({
      partialText: 'partial preview',
      partialTextRef: references.partialText,
      finalText: 'final preview',
      finalTextRef: references.finalText,
    }),
  ];
}

/** Publish one artifact per kind under the parent chat, as externalize would. */
async function publishBodies(
  store: ChatStorageV2,
  chatId = 'chat',
): Promise<References> {
  const artifacts = new ChatTranscriptArtifacts(
    join(store.directory, 'transcripts'),
  );
  const put = (kind: Kind): Promise<PersistedToolOutputReference> =>
    artifacts.put(chatId, body(kind));
  return {
    text: await put('text'),
    thinking: await put('thinking'),
    input: await put('input'),
    partialText: await put('partialText'),
    finalText: await put('finalText'),
  };
}

function artifactNames(references: References): string[] {
  return KINDS.map((kind) => `${references[kind].artifactId}.txt`).sort();
}

function artifactNamesFor(
  references: readonly PersistedToolOutputReference[],
): string[] {
  return references.map(({ artifactId }) => `${artifactId}.txt`).sort();
}

async function pagedRow(
  store: ChatStorageV2,
  references: References,
  chatId = 'chat',
  includeDelegationLog = false,
): Promise<{
  message: PersistedChatMessage;
  artifactReferences: PersistedToolOutputReference[];
}> {
  const blocks = referenceBlocks(references);
  const card = blocks[3];
  if (includeDelegationLog && card?.type === 'delegated_agent_call')
    blocks[3] = { ...card, transcriptStore: 'chat-log-v1' };

  const artifacts = new ChatTranscriptArtifacts(
    join(store.directory, 'transcripts'),
  );
  const page: TranscriptBlockPage = {
    version: 1,
    kind: 'transcript-block-page',
    firstBlockOrdinal: 0,
    blocks,
  };
  const pageReference = await artifacts.put(
    chatId,
    encodeTranscriptBlockPage(page),
  );
  const childManifest: TranscriptBlockManifest = {
    version: 1,
    kind: 'transcript-block-manifest',
    firstBlockOrdinal: 0,
    blockCount: blocks.length,
    entries: [
      {
        kind: 'page',
        firstBlockOrdinal: 0,
        blockCount: blocks.length,
        reference: pageReference,
      },
    ],
  };
  const childManifestReference = await artifacts.put(
    chatId,
    encodeTranscriptBlockManifest(childManifest),
  );
  const rootManifest: TranscriptBlockManifest = {
    version: 1,
    kind: 'transcript-block-manifest',
    firstBlockOrdinal: 0,
    blockCount: blocks.length,
    entries: [
      {
        kind: 'manifest',
        firstBlockOrdinal: 0,
        blockCount: blocks.length,
        reference: childManifestReference,
      },
    ],
  };
  const rootManifestReference = await artifacts.put(
    chatId,
    encodeTranscriptBlockManifest(rootManifest),
  );
  return {
    message: {
      ...primaryRow(references),
      blocks: [],
      blocksRef: {
        version: 1,
        manifest: rootManifestReference,
        blockCount: blocks.length,
      },
    },
    artifactReferences: [
      ...KINDS.map((kind) => references[kind]),
      pageReference,
      childManifestReference,
      rootManifestReference,
    ],
  };
}

async function artifactFiles(
  directory: string,
  chatId: string,
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

async function maintainUntilComplete(
  backend: ChatStateV2Backend,
  chatId = 'chat',
): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const progress = await backend.maintainArtifacts(chatId);
    if (progress.complete) return;
  }
  throw new Error('Artifact maintenance did not complete');
}

const target = {
  kind: 'delegation' as const,
  chatId: 'chat',
  delegationId: 'child',
  runGeneration: 0,
};

function childRow(references: References, final: boolean): DelegationChildRow {
  return {
    id: 'agent:item',
    role: 'assistant',
    timestamp: 2,
    parentBlockId: 'agent',
    delegationSequence: 0,
    itemRevision: 0,
    final,
    blocks: referenceBlocks(references),
  };
}

function primaryRow(references: References): PersistedChatMessage {
  return {
    id: 'seeded',
    role: 'assistant',
    timestamp: 2,
    blocks: referenceBlocks(references),
  };
}

type State =
  | 'primary-committed'
  | 'primary-active'
  | 'child-final'
  | 'child-open';

async function seed(
  backend: ChatStateV2Backend,
  state: State,
  references: References,
): Promise<void> {
  if (state === 'child-final' || state === 'child-open') {
    await backend.registerTranscriptStream(target);
    await backend.commitChildStream(target, `seed-${state}`, [
      childRow(references, state === 'child-final'),
    ]);
    return;
  }
  await backend.transact(
    () => [
      {
        type: 'message.upserted',
        chatId: 'chat',
        message: primaryRow(references),
      },
      ...(state === 'primary-active'
        ? [
            {
              type: 'runtime.patched' as const,
              chatId: 'chat',
              runtime: {
                status: 'streaming' as const,
                queuedMessageIds: [],
              },
            },
          ]
        : []),
    ],
    { source: 'automation' },
  );
}

async function seedMessage(
  backend: ChatStateV2Backend,
  message: PersistedChatMessage,
): Promise<void> {
  await backend.transact(
    () => [
      {
        type: 'message.upserted',
        chatId: 'chat',
        message,
      },
    ],
    { source: 'automation' },
  );
}

describe('generalized field reference closure', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'chat-field-closure-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it.each<State>([
    'primary-committed',
    'primary-active',
    'child-final',
    'child-open',
  ])(
    'keeps every %s body reference through maintenance and capture',
    async (state) => {
      const { store, backend } = await format4Scope(
        root,
        'source',
        scopeSource([{ id: 'chat', messages: [message('parent', 'hello')] }]),
      );
      try {
        const references = await publishBodies(store);
        await seed(backend, state, references);
        await backend.flush();
        await maintainUntilComplete(backend);
        expect(await artifactFiles(store.directory, 'chat')).toEqual(
          artifactNames(references),
        );
        // A capture needs settled turns; the open primary sidecar is covered
        // by maintenance and journal recovery instead.
        if (state === 'primary-active') return;
        const capture = new ChatStorageV2(root, 'capture', undefined, {
          maxManifestVersion: 4,
        });
        await store.copyTo(capture);
        expect(await artifactFiles(capture.directory, 'chat')).toEqual(
          artifactNames(references),
        );
      } finally {
        await backend.disposeArtifactMaintenance();
      }
    },
  );

  it.each<State>(['primary-committed', 'child-final', 'child-open'])(
    'captures every %s body reference and refuses a capture missing one',
    async (state) => {
      const { store, backend } = await format4Scope(
        root,
        'source',
        scopeSource([{ id: 'chat', messages: [message('parent', 'hello')] }]),
      );
      try {
        const references = await publishBodies(store);
        await seed(backend, state, references);
        await backend.flush();
        const capture = new ChatStorageV2(root, 'capture', undefined, {
          maxManifestVersion: 4,
        });
        await store.copyTo(capture);
        expect(await artifactFiles(capture.directory, 'chat')).toEqual(
          artifactNames(references),
        );
        await unlink(
          join(
            store.directory,
            'transcripts',
            'tool-output',
            'chat',
            `${references.finalText.artifactId}.txt`,
          ),
        );
        const missing = new ChatStorageV2(root, 'missing', undefined, {
          maxManifestVersion: 4,
        });
        await expect(store.copyTo(missing)).rejects.toThrow();
        expect(await missing.authority()).toBe('v1');
      } finally {
        await backend.disposeArtifactMaintenance();
      }
    },
  );

  it.each<State>(['primary-active', 'child-final', 'child-open'])(
    'fails journal recovery and lease-free reads of a pending %s record whose body is missing',
    async (state) => {
      const { store, backend } = await format4Scope(
        root,
        'source',
        scopeSource([{ id: 'chat', messages: [message('parent', 'hello')] }]),
      );
      const references = await publishBodies(store);
      await seed(backend, state, references);
      // Not flushed: the record is the only durable copy of these rows.
      await backend.disposeArtifactMaintenance();
      await unlink(
        join(
          store.directory,
          'transcripts',
          'tool-output',
          'chat',
          `${references.input.artifactId}.txt`,
        ),
      );
      await expect(
        openReplayedChatScope(
          { directory: store.directory, scopeId: 'source' },
          assertChatStorageIndexes,
          { maxManifestVersion: 4 },
        ),
      ).rejects.toThrow(/missing or damaged artifact/);
      const reopened = reopenFormat4Scope(root, 'source');
      try {
        await expect(reopened.backend.load()).rejects.toThrow(
          /missing or damaged artifact/,
        );
      } finally {
        await reopened.backend.disposeArtifactMaintenance();
      }
    },
  );

  it('verifies, captures, and expands the complete nested block-page closure', async () => {
    const { store, backend } = await format4Scope(
      root,
      'source',
      scopeSource([{ id: 'chat', messages: [message('parent', 'hello')] }]),
    );
    try {
      const references = await publishBodies(store);
      const paged = await pagedRow(store, references);
      await seedMessage(backend, paged.message);
      await backend.flush();

      const stored = await backend.consumeTranscript(
        'chat',
        false,
        async (messages) => {
          for await (const candidate of messages)
            if (candidate.id === paged.message.id) return candidate;
          return undefined;
        },
      );
      expect(stored).toEqual(paged.message);

      const capture = new ChatStorageV2(root, 'capture', undefined, {
        maxManifestVersion: 4,
      });
      await store.copyTo(capture);
      expect(await artifactFiles(capture.directory, 'chat')).toEqual(
        artifactNamesFor(paged.artifactReferences),
      );

      const full = await backend.consumeTranscript(
        'chat',
        true,
        async (messages) => {
          for await (const candidate of messages)
            if (candidate.id === paged.message.id) return candidate;
          return undefined;
        },
      );
      expect(full?.blocksRef).toBeUndefined();
      expect(full && transcriptBodyReferences(full)).toEqual([]);
      expect(full?.blocks).toEqual([
        { type: 'text', text: body('text') },
        { type: 'thinking', text: body('thinking') },
        {
          type: 'tool_use',
          toolUseId: 'call-1',
          toolName: 'shell',
          input: body('input'),
        },
        delegatedCard({
          partialText: body('partialText'),
          finalText: body('finalText'),
        }),
      ]);
    } finally {
      await backend.disposeArtifactMaintenance();
    }
  });

  it('rejects a prepared paged row whose manifest is missing', async () => {
    const { store, backend } = await format4Scope(
      root,
      'source',
      scopeSource([{ id: 'chat', messages: [message('parent', 'hello')] }]),
    );
    try {
      const references = await publishBodies(store);
      const paged = await pagedRow(store, references);
      const rootManifest = paged.artifactReferences.at(-1);
      if (!rootManifest) throw new Error('Missing test root manifest');
      await unlink(
        join(
          store.directory,
          'transcripts',
          'tool-output',
          'chat',
          `${rootManifest.artifactId}.txt`,
        ),
      );
      await expect(seedMessage(backend, paged.message)).rejects.toThrow();
    } finally {
      await backend.disposeArtifactMaintenance();
    }
  });

  it('rejects capture when a paged block artifact is missing', async () => {
    const { store, backend } = await format4Scope(
      root,
      'source',
      scopeSource([{ id: 'chat', messages: [message('parent', 'hello')] }]),
    );
    try {
      const references = await publishBodies(store);
      const paged = await pagedRow(store, references);
      await seedMessage(backend, paged.message);
      await backend.flush();
      const pageReference = paged.artifactReferences[5];
      if (!pageReference) throw new Error('Missing test page reference');
      await unlink(
        join(
          store.directory,
          'transcripts',
          'tool-output',
          'chat',
          `${pageReference.artifactId}.txt`,
        ),
      );
      const capture = new ChatStorageV2(root, 'missing', undefined, {
        maxManifestVersion: 4,
      });
      await expect(store.copyTo(capture)).rejects.toThrow();
      expect(await capture.authority()).toBe('v1');
    } finally {
      await backend.disposeArtifactMaintenance();
    }
  });

  it('copies every body reference into a fork and expands them for full reads', async () => {
    const { store, backend } = await format4Scope(
      root,
      'source',
      scopeSource([
        { id: 'chat', messages: [message('parent', 'hello')] },
        { id: 'sibling', messages: [message('other', 'hi')] },
      ]),
    );
    try {
      const references = await publishBodies(store);
      const paged = await pagedRow(store, references, 'chat', true);
      await seedMessage(backend, paged.message);
      const childRun = { delegationId: 'child-1', runGeneration: 1 };
      const childItems = [
        {
          id: 'child-item',
          sequence: 0,
          occurredAt: 2,
          type: 'text' as const,
          text: 'child answer',
        },
      ];
      await backend.appendDelegationLog('chat', [
        { run: childRun, items: childItems },
      ]);
      await backend.transact(
        (current) => [
          {
            type: 'tab.created',
            transcriptSourceChatId: 'chat',
            tab: { ...current.tabsFile.tabs[0], id: 'fork', title: 'Fork' },
          },
        ],
        { source: 'automation', chatIds: ['chat'], fullTranscript: true },
      );
      expect(await artifactFiles(store.directory, 'fork')).toEqual(
        artifactNamesFor(paged.artifactReferences),
      );
      await expect(
        backend.readDelegationItems('fork', childRun),
      ).resolves.toEqual(childItems);
      // The source chat's artifacts go with it; the fork must not need them.
      await backend.transact(() => [{ type: 'tab.removed', tabId: 'chat' }], {
        source: 'automation',
      });
      await backend.flush();
      const row = await backend.consumeTranscript(
        'fork',
        true,
        async (messages) => {
          for await (const candidate of messages)
            if (candidate.id === 'seeded') return candidate;
          return undefined;
        },
      );
      expect(row && transcriptBodyReferences(row)).toEqual([]);
      expect(row?.blocks).toEqual([
        { type: 'text', text: body('text') },
        { type: 'thinking', text: body('thinking') },
        {
          type: 'tool_use',
          toolUseId: 'call-1',
          toolName: 'shell',
          input: body('input'),
        },
        delegatedCard({
          partialText: body('partialText'),
          finalText: body('finalText'),
          transcriptStore: 'chat-log-v1',
        }),
      ]);

      const inlined = await backend.consumeTranscript(
        'fork',
        false,
        async (messages) => {
          const rows: PersistedChatMessage[] = [];
          for await (const candidate of messages) rows.push(candidate);
          return rows;
        },
        { inlineDelegationChildren: true },
      );
      const inlinedParent = inlined.find(
        (candidate) => candidate.id === 'seeded',
      );
      expect(inlinedParent?.blocksRef).toBeUndefined();
      const inlinedCard = inlinedParent?.blocks[3];
      if (inlinedCard?.type !== 'delegated_agent_call')
        throw new Error('Expected an inlined delegated card');
      expect(inlinedCard).not.toHaveProperty('transcriptStore');
    } finally {
      await backend.disposeArtifactMaintenance();
    }
  });

  it('copies every body reference on import, independent of the source', async () => {
    const source = await format4Scope(
      root,
      'source',
      scopeSource([{ id: 'chat', messages: [message('parent', 'hello')] }]),
    );
    const destination = await format4Scope(
      root,
      'destination',
      scopeSource([{ id: 'other', messages: [] }]),
    );
    try {
      const references = await publishBodies(source.store);
      const paged = await pagedRow(source.store, references);
      await seedMessage(source.backend, paged.message);
      await source.backend.flush();
      const state = await source.backend.state({
        chatIds: ['chat'],
        fullTranscript: true,
      });
      await destination.backend.importScope(source.store, {
        tabsFile: state.tabsFile,
        archivesFile: state.archivesFile,
      });
      expect(await artifactFiles(destination.store.directory, 'chat')).toEqual(
        artifactNamesFor(paged.artifactReferences),
      );
      await source.backend.disposeArtifactMaintenance();
      await rm(source.store.directory, { recursive: true, force: true });
      const row = await destination.backend.consumeTranscript(
        'chat',
        true,
        async (messages) => {
          for await (const candidate of messages)
            if (candidate.id === 'seeded') return candidate;
          return undefined;
        },
      );
      expect(row?.blocks[0]).toEqual({ type: 'text', text: body('text') });
      expect(row && transcriptBodyReferences(row)).toEqual([]);
    } finally {
      await destination.backend.disposeArtifactMaintenance();
    }
  });

  it('inlines every generalized body on import into a format 3 scope', async () => {
    const source = await format4Scope(
      root,
      'source',
      scopeSource([{ id: 'chat', messages: [message('parent', 'hello')] }]),
    );
    const store = new ChatStorageV2(root, 'destination');
    await store.migrate(scopeSource([{ id: 'other', messages: [] }]));
    const destination = new ChatStateV2Backend(store, { deltaJournal: {} });
    await destination.promoteToDeltaJournal();
    try {
      const references = await publishBodies(source.store);
      await seed(source.backend, 'primary-committed', references);
      await source.backend.flush();
      const state = await source.backend.state({
        chatIds: ['chat'],
        fullTranscript: true,
      });
      await destination.importScope(source.store, {
        tabsFile: state.tabsFile,
        archivesFile: state.archivesFile,
      });
      await destination.flush();
      // A format 3 reader knows no body reference: it would show the
      // preview as the content and reclaim the artifact.
      expect(await artifactFiles(store.directory, 'chat')).toEqual([]);
      const row = await destination.consumeTranscript(
        'chat',
        false,
        async (messages) => {
          for await (const candidate of messages)
            if (candidate.id === 'seeded') return candidate;
          return undefined;
        },
      );
      expect(row && transcriptBodyReferences(row)).toEqual([]);
      expect(row?.blocks).toEqual([
        { type: 'text', text: body('text') },
        { type: 'thinking', text: body('thinking') },
        {
          type: 'tool_use',
          toolUseId: 'call-1',
          toolName: 'shell',
          input: body('input'),
        },
        delegatedCard({
          partialText: body('partialText'),
          finalText: body('finalText'),
        }),
      ]);
    } finally {
      await source.backend.disposeArtifactMaintenance();
      await destination.disposeArtifactMaintenance();
    }
  });

  it('fails closed when importing paged blocks into a format 3 scope', async () => {
    const source = await format4Scope(
      root,
      'source',
      scopeSource([{ id: 'chat', messages: [message('parent', 'hello')] }]),
    );
    const store = new ChatStorageV2(root, 'destination');
    await store.migrate(scopeSource([{ id: 'other', messages: [] }]));
    const destination = new ChatStateV2Backend(store, { deltaJournal: {} });
    await destination.promoteToDeltaJournal();
    try {
      const references = await publishBodies(source.store);
      const paged = await pagedRow(source.store, references);
      await seedMessage(source.backend, paged.message);
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
    } finally {
      await source.backend.disposeArtifactMaintenance();
      await destination.disposeArtifactMaintenance();
    }
  });
});
