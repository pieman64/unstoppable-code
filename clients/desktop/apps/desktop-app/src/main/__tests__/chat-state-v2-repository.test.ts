import { createRepositoryTranscriptPortFixture } from './helpers/repository-transcript-port-fixture';
import { delegationTranscriptMessages } from '@canopy/agent-transcript';
import type { CardStateV1 } from '@canopy/protocol/canopy-core';
import { format4Scope } from './helpers/chat-format4-scope';
import { scopeSource } from './helpers/chat-delta-journal-harness';
import { ChatDeltaJournalWriter } from '../lib/chat-delta-journal/writer';
import type { McpActivationRecord } from '@canopy/protocol/mcp-servers';
import type { ChatStateV2RepositoryOptions } from '../services/chat-state-v2-repository';
import type { TranscriptDescriptor } from '@canopy/agent-transcript/transcript-storage';
import { promises as fsPromises } from 'node:fs';
import { Dir } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ChatStateV2Repository } from '../services/chat-state-v2-repository';
import { ChatStateV2Backend } from '../services/chat-state-v2-backend';
import { ChatStateRevisionConflictError } from '../services/chat-state-repository';
import { ChatStateRepositoryLoadError } from '../services/chat-state-contracts';
import { ChatStorageV2 } from '../lib/chat-storage-v2';
import * as legacyChatMigration from '../lib/legacy-chat-migration';
import * as delegationRecovery from '../agents/delegation/recovery';
import * as recordV3 from '@canopy/desktop-shared/node/delegation/record-v3';
import { routeFixture } from '../../../../../packages/desktop-shared/src/node/delegation/__tests__/fixtures';
import type { StoredDelegationLegacy } from '@canopy/desktop-shared/node/delegation/broker';
import { FileDelegationStorage } from '@canopy/desktop-shared/node/delegation/storage';
import { ChatStateService } from '../services/chat-state-service';
import * as resolveWorktree from '../lib/resolve-worktree';
import * as dataPaths from '../lib/paths';
import { managedDelegationRecordReader } from '../agents/delegation/host-read-composition';
import {
  CapturedTranscriptPreview,
  ChatTranscriptLog,
} from '../lib/chat-transcript-log';
import { ChatTranscriptArtifacts } from '../lib/chat-transcript-artifacts';
import {
  ArtifactMaintenanceCapacityError,
  ChatArtifactMaintenance,
} from '../lib/chat-artifact-maintenance';
import { ChatStorageTransactions } from '../lib/chat-storage-transactions';
import { DELTA_JOURNAL_FILE_NAME } from '../lib/chat-delta-journal/format';
import { VisualStagingStoreImpl } from '../lib/visual-staging';
import { ChatVisualStagingSweep } from '../lib/chat-visual-staging-sweep';
import {
  chatVisualStagingPublicationGeneration,
  chatVisualStagingScopesMarkerExists,
  chatVisualStagingScopesMarkerPath,
  removeChatVisualStagingScopesMarker,
  resetChatVisualStagingScopesMarkerForTests,
  withChatVisualStagingScopesMarker,
} from '../lib/visual-staging-scopes-marker';
import {
  VISUAL_STAGING_RETENTION_MS,
  type ProviderVisualAdmission,
  type PromotedVisual,
  type StageVisualDocument,
} from '../lib/chat-visual-contracts';
import {
  STANDALONE_CHAT_PROJECT_ID,
  type ChatCoreMutation,
  type PersistedChatMessage,
} from '@canopy/desktop-shared/types';
import { resetResolvedCanopyDataDirForTests } from '@canopy/desktop-shared/canopy-paths';

import {
  drainAfterTest,
  drainOpenRepositories,
} from './helpers/chat-delta-journal-scope';

function repositoryForTest(
  options: ChatStateV2RepositoryOptions = {},
): ChatStateV2Repository {
  return drainAfterTest(new ChatStateV2Repository(options));
}

const scope = { projectId: 'workspace', worktreeId: 'scope' };
const row: PersistedChatMessage = {
  id: 'user',
  role: 'user',
  timestamp: 1,
  blocks: [{ type: 'text', text: 'preserved' }],
};

function recoveryRecord(version: 1 | 2): StoredDelegationLegacy {
  const id = `00000000-0000-4000-8000-00000000000${version}`;
  return {
    version,
    ...(version === 2 ? { transcriptRevision: 1 } : {}),
    parent: {
      ...scope,
      harnessId: 'codex',
      chatId: 'chat',
      sessionKey: 's2/recovery/chat',
      turnId: row.id,
      toolCallId: `spawn-${version}`,
      runtimeGeneration: 1,
      depth: 0,
    },
    task: {
      modelId: 'model',
      description: 'Recover legacy sibling',
      prompt: 'Retained task',
      contextPolicy: 'task_only',
      isolation: 'shared_worktree',
      executionMode: 'background',
    },
    callKey: 'a'.repeat(64),
    route: routeFixture({
      selectedModelId: 'model',
      runtimeModelId: 'model',
      harnessId: 'codex',
    }),
    requestHash: 'b'.repeat(64),
    createdAt: 100,
    state: {
      delegationId: id,
      runGeneration: 1,
      sequence: 1,
      status: 'running',
      outputTruncated: false,
      transcript: [
        {
          id: 'retained',
          type: 'text',
          text: 'Retained answer',
          sequence: 1,
          occurredAt: 110,
        },
      ],
    },
    launch: {
      version: 1,
      delegationId: id,
      runGeneration: 1,
      launchKey: 'a'.repeat(64),
      phase: 'starting',
    },
    delivery: { status: 'unclaimed' },
  };
}

function streamRecoveryRecord(): ReturnType<
  typeof recordV3.decodeStoredDelegationV3
> {
  const legacy = recoveryRecord(2);
  const id = '00000000-0000-4000-8000-000000000003';
  return recordV3.decodeStoredDelegationV3({
    ...legacy,
    version: 3,
    state: {
      delegationId: id,
      runGeneration: 1,
      sequence: 1,
      status: 'running',
      outputTruncated: false,
    },
    launch: { ...legacy.launch, delegationId: id },
    readMetadata: {
      originAt: 100,
      lastActivityAt: 120,
      current: {
        store: 'stream',
        target: {
          kind: 'delegation',
          chatId: 'chat',
          delegationId: id,
          runGeneration: 1,
        },
      },
    },
    registration: {
      runGeneration: 1,
      createdAt: 100,
      store: 'stream',
      origin: { kind: 'launch' },
      executionMode: 'background',
    },
    receipts: { commandReceipts: [], stopReceipts: [] },
  });
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function asAsync<T>(source: Iterable<T>): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<T> {
      const iterator = source[Symbol.iterator]();
      return {
        next(): Promise<IteratorResult<T>> {
          return Promise.resolve(iterator.next());
        },
      };
    },
  };
}

async function locateMessage(
  repository: ChatStateV2Repository,
  chatId: string,
  messageId: string,
): Promise<'missing' | 'active' | { committed: true; last: boolean }> {
  return repository.locateMessage(scope, chatId, messageId);
}

// These tests do real filesystem and git work. Under a loaded multi-worker
// Jest run they have exceeded Jest's default 5 s, so leave headroom here.
jest.setTimeout(30_000);

describe('v2 scope repository admission', () => {
  let root: string;
  let paths: { tabs: string; archives: string; journal: string };
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'chat-v2-repository-'));
    paths = {
      tabs: join(root, 'chats', 'scope.json'),
      archives: join(root, 'chat-archives', 'scope.json'),
      journal: join(root, 'chat-journals', 'scope.jsonl'),
    };
    await mkdir(dirname(paths.tabs), { recursive: true });
    await writeFile(
      paths.tabs,
      JSON.stringify({
        version: 1,
        activeTabId: 'chat',
        tabs: [
          {
            id: 'chat',
            title: 'Chat',
            createdAt: '2026-09-05',
            messages: [row],
          },
        ],
      }),
    );
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await drainOpenRepositories();
    await rm(root, { recursive: true, force: true });
  });
  const options = (): ChatStateV2RepositoryOptions => ({
    resolvePaths: (): typeof paths => paths,
  });

  it('preserves per-execution outcomes through V2 restart after an unrelated next prompt', async () => {
    const repository = repositoryForTest(options());
    const timers: PersistedChatMessage[] = [
      'completed',
      'cancelled',
      'failed',
      undefined,
    ].map((outcome, index) => ({
      id: `T${index}:timer`,
      role: 'system',
      timestamp: 100 + index,
      blocks: [
        {
          type: 'turn_timer',
          turnId: `T${index}`,
          userMessageId: row.id,
          startedAt: 100 + index,
          completedAt: 200 + index,
          ...(outcome === 'completed' ||
          outcome === 'cancelled' ||
          outcome === 'failed'
            ? { outcome }
            : {}),
        },
      ],
    }));
    const nextPrompt: PersistedChatMessage = {
      ...row,
      id: 'next-prompt',
      timestamp: 300,
    };
    await repository.transact(
      scope,
      [...timers, nextPrompt].map((message) => ({
        type: 'message.upserted',
        chatId: 'chat',
        message,
      })),
      { source: 'migration' },
    );
    await repository.drainAll();
    const reopened = repositoryForTest(options());
    const saved = await reopened.getState(scope, {
      chatIds: ['chat'],
      fullTranscript: true,
    });
    expect(saved.tabsFile.tabs[0].messages).toEqual([
      row,
      ...timers,
      nextPrompt,
    ]);
  });

  it('installs the pure source in the default service repository before its first format-3 load', async () => {
    jest
      .spyOn(resolveWorktree, 'resolveChatTabsFilePath')
      .mockReturnValue(paths.tabs);
    jest
      .spyOn(resolveWorktree, 'resolveChatArchivesFilePath')
      .mockReturnValue(paths.archives);
    jest
      .spyOn(resolveWorktree, 'resolveChatJournalFilePath')
      .mockReturnValue(paths.journal);
    jest.spyOn(dataPaths, 'getWorktreeDataDir').mockReturnValue(root);
    const storage = new FileDelegationStorage(join(root, 'delegation', 'runs'));
    const stream = streamRecoveryRecord();
    // Materialize a format-3 backing before constructing the production default.
    const seed = repositoryForTest(options());
    await seed.getState(scope);
    await seed.drainAll();
    expect(await ChatStorageV2.fromLegacyPaths(paths).format()).toBe('v3');
    for (const record of [recoveryRecord(1), recoveryRecord(2), stream])
      await storage.commit(record);
    const metadata = jest.spyOn(recordV3, 'readMetadataOfRecord');
    const recovery = jest.spyOn(
      delegationRecovery,
      'loadDelegationRecoveryMutations',
    );
    const load = jest.spyOn(ChatStateV2Repository.prototype, 'getState');
    const service = new ChatStateService();
    expect(load).not.toHaveBeenCalled();
    expect(metadata).not.toHaveBeenCalled();
    expect(recovery).not.toHaveBeenCalled();
    try {
      await service.getCompatibilityTabs(scope, {
        chatIds: ['chat'],
        fullTranscript: true,
        rawStreamCards: true,
      });
      expect(recovery).toHaveBeenCalledTimes(1);
      expect(recovery.mock.calls[0]?.[3]?.readMetadata).toBe(metadata);
      expect(metadata).toHaveBeenCalledTimes(3);
      expect(
        metadata.mock.calls.map(([record], index) => ({
          record,
          result: metadata.mock.results[index],
        })),
      ).toEqual(
        expect.arrayContaining([
          {
            record: recoveryRecord(1),
            result: { type: 'return', value: undefined },
          },
          {
            record: recoveryRecord(2),
            result: { type: 'return', value: undefined },
          },
          {
            record: stream,
            result: { type: 'return', value: stream.readMetadata },
          },
        ]),
      );
    } finally {
      await service.drain();
    }
  });

  it('finishes real serialized mixed recovery without registry, descriptor, stored-row or reader re-entry', async () => {
    jest.spyOn(dataPaths, 'getWorktreeDataDir').mockReturnValue(root);
    const stream = streamRecoveryRecord();
    const seeded = await format4Scope(
      root,
      'scope',
      scopeSource([{ id: 'chat', messages: [row] }]),
    );
    const reference = await seeded.backend.storage.transcripts.artifacts.put(
      'chat',
      'a'.repeat(80_000),
    );
    const parent = delegationTranscriptMessages({
      delegationId: stream.state.delegationId,
      runGeneration: 1,
      sequence: 1,
      parentHarnessId: 'codex',
      parentTurnId: row.id,
      parentToolCallId: stream.parent.toolCallId,
      createdAt: 100,
      task: stream.task,
      snapshot: {
        ...stream.state,
        routeSnapshot: {
          selectedModelId: 'model',
          runtimeModelId: 'model',
          harnessId: 'codex',
          runtimeKind: 'sdk',
          runnerRegistrationId: 'runner',
          runtimeVersion: '1',
          adapterVersion: '1',
          modelSource: 'agent',
          providerType: 'openai',
          assignmentRevision: '1',
          billingAuthority: 'local',
          aiCreditsRouted: false,
          capabilities: [],
          supportedThinkingLevels: [],
          capabilitySnapshotHash: 'hash',
          capabilityGeneration: 1,
          policyRevision: '1',
        },
      },
      transcript: [],
    })[0];
    const block = parent?.blocks[0];
    if (!parent || block?.type !== 'delegated_agent_call')
      throw new Error('Missing stream card');
    const stored: PersistedChatMessage = {
      ...parent,
      blocks: [
        {
          ...block,
          transcriptStore: 'chat-stream-v2',
          partialTextRef: reference,
          finalTextRef: reference,
        },
      ],
    };
    try {
      await seeded.backend.transact(
        () => [{ type: 'message.upserted', chatId: 'chat', message: stored }],
        { source: 'provider' },
      );
      await seeded.backend.flush();
    } finally {
      seeded.backend.releaseJournal();
      await seeded.backend.disposeArtifactMaintenance();
    }
    const records = [recoveryRecord(1), recoveryRecord(2), stream];
    const storage = new FileDelegationStorage(join(root, 'delegation', 'runs'));
    for (const record of records) await storage.commit(record);
    const fail = (): never => {
      throw new Error('Recovery must not re-enter a serialized read port');
    };
    const forbidden = [
      jest
        .spyOn(ChatStateV2Repository.prototype, 'result')
        .mockImplementation(fail),
      jest
        .spyOn(ChatStateV2Repository.prototype, 'receipt')
        .mockImplementation(fail),
      jest
        .spyOn(ChatStateV2Repository.prototype, 'resultBySettlementKey')
        .mockImplementation(fail),
      jest
        .spyOn(ChatStateV2Repository.prototype, 'resultByGeneration')
        .mockImplementation(fail),
      jest
        .spyOn(ChatStateV2Repository.prototype, 'generation')
        .mockImplementation(fail),
      jest
        .spyOn(ChatStateV2Repository.prototype, 'resultsPage')
        .mockImplementation(fail),
      jest
        .spyOn(ChatStateV2Repository.prototype, 'generationsPage')
        .mockImplementation(fail),
      jest
        .spyOn(ChatStateV2Repository.prototype, 'resultAnswerRange')
        .mockImplementation(fail),
      jest
        .spyOn(ChatStateV2Repository.prototype, 'itemAdmission')
        .mockImplementation(fail),
      jest
        .spyOn(ChatStateV2Repository.prototype, 'appendDelegationReceipt')
        .mockImplementation(fail),
      jest
        .spyOn(ChatStateV2Repository.prototype, 'registerGeneration')
        .mockImplementation(fail),
      jest
        .spyOn(ChatStateV2Repository.prototype, 'settleDelegationResult')
        .mockImplementation(fail),
      jest
        .spyOn(ChatStateV2Repository.prototype, 'readStoredParentMessage')
        .mockImplementation(fail),
      jest
        .spyOn(ChatStateV2Repository.prototype, 'getChildStreamState')
        .mockImplementation(fail),
      jest
        .spyOn(ChatStateV2Backend.prototype, 'childStreamDescriptor')
        .mockImplementation(fail),
      jest
        .spyOn(ChatStateV2Backend.prototype, 'result')
        .mockImplementation(fail),
      jest
        .spyOn(ChatStateV2Backend.prototype, 'receipt')
        .mockImplementation(fail),
      jest
        .spyOn(ChatStateV2Backend.prototype, 'resultBySettlementKey')
        .mockImplementation(fail),
      jest
        .spyOn(ChatStateV2Backend.prototype, 'resultByGeneration')
        .mockImplementation(fail),
      jest
        .spyOn(ChatStateV2Backend.prototype, 'generation')
        .mockImplementation(fail),
      jest
        .spyOn(ChatStateV2Backend.prototype, 'resultsPage')
        .mockImplementation(fail),
      jest
        .spyOn(ChatStateV2Backend.prototype, 'generationsPage')
        .mockImplementation(fail),
      jest
        .spyOn(ChatStateV2Backend.prototype, 'resultAnswerRange')
        .mockImplementation(fail),
      jest
        .spyOn(ChatStateV2Backend.prototype, 'itemAdmission')
        .mockImplementation(fail),
      jest
        .spyOn(ChatStateV2Backend.prototype, 'registerGeneration')
        .mockImplementation(fail),
      jest
        .spyOn(ChatStateV2Backend.prototype, 'settleDelegationResult')
        .mockImplementation(fail),
      jest
        .spyOn(ChatStateV2Backend.prototype, 'appendDelegationReceipt')
        .mockImplementation(fail),
      jest
        .spyOn(ChatStateV2Backend.prototype, 'readStoredParentMessage')
        .mockImplementation(fail),
      jest
        .spyOn(ChatDeltaJournalWriter.prototype, 'childDescriptor')
        .mockImplementation(fail),
      jest
        .spyOn(managedDelegationRecordReader, 'resolveActivity')
        .mockImplementation(fail),
      jest
        .spyOn(managedDelegationRecordReader, 'resolveGenerationHeader')
        .mockImplementation(fail),
      jest
        .spyOn(managedDelegationRecordReader, 'resolveGenerationList')
        .mockImplementation(fail),
      jest
        .spyOn(managedDelegationRecordReader, 'resolveGenerationOutcome')
        .mockImplementation(fail),
    ];
    const recovery = jest.spyOn(
      delegationRecovery,
      'loadDelegationRecoveryMutations',
    );
    // Recovery orders mutations by directory listing order, which differs by platform.
    const load = jest.spyOn(FileDelegationStorage.prototype, 'load');
    const repository = repositoryForTest({
      ...options(),
      enableFormat4: true,
      delegationReadMetadata: recordV3.readMetadataOfRecord,
    });
    const state = await repository.getState(scope, {
      chatIds: ['chat'],
      fullTranscript: true,
      rawStreamCards: true,
    });
    expect(repository.getLifecycle(scope)).toBe('ready');
    expect(recovery).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledTimes(1);
    const loaded = load.mock.results[0];
    if (loaded?.type !== 'return') throw new Error('Expected loaded records');
    const expected = delegationRecovery.delegationRecoveryMutations(
      scope,
      {
        version: 1,
        activeTabId: 'chat',
        tabs: [
          {
            id: 'chat',
            title: 'Chat',
            createdAt: '2026-09-05',
            messages: [row, stored],
          },
        ],
      },
      { version: 1, archived: [] },
      await loaded.value,
      recordV3.readMetadataOfRecord,
    );
    expect(await recovery.mock.results[0]?.value).toEqual(expected);
    expect(expected.length).toBeGreaterThan(0);
    const messages = state.tabsFile.tabs[0]?.messages ?? [];
    expect(messages.find((message) => message.id === stored.id)).toEqual(
      stored,
    );
    const cards = messages
      .flatMap((message) => message.blocks)
      .filter((candidate) => candidate.type === 'delegated_agent_call');
    for (const legacy of records.slice(0, 2)) {
      expect(cards).toContainEqual(
        expect.objectContaining({
          delegationId: legacy.state.delegationId,
          status: 'interrupted',
        }),
      );
    }
    expect(
      cards.filter(
        (candidate) => candidate.delegationId === stream.state.delegationId,
      ),
    ).toEqual(stored.blocks);
    for (const method of forbidden) expect(method).not.toHaveBeenCalled();
  });
  it('loads startup recovery from raw cards with injected metadata and no registry re-entry', async () => {
    const readMetadata = jest.fn(() => undefined);
    // Assign structurally so the red still compiles before the option is added.
    const recoveryOptions = {
      ...options(),
      delegationReadMetadata: readMetadata,
    };
    const repository = repositoryForTest(recoveryOptions);
    jest
      .spyOn(delegationRecovery, 'hasDelegationRecoveryRecords')
      .mockResolvedValue(true);
    const recovery = jest
      .spyOn(delegationRecovery, 'loadDelegationRecoveryMutations')
      .mockResolvedValue([]);
    const state = jest.spyOn(ChatStateV2Backend.prototype, 'state');
    const generation = jest.spyOn(ChatStateV2Backend.prototype, 'generation');
    const descriptor = jest.spyOn(
      ChatStateV2Backend.prototype,
      'childStreamDescriptor',
    );
    await repository.getState(scope);
    expect(state).toHaveBeenNthCalledWith(1, {
      chatIds: ['chat'],
      fullTranscript: true,
      rawStreamCards: true,
    });
    expect(recovery).toHaveBeenCalledTimes(1);
    expect(recovery.mock.calls[0]?.[0]).toEqual(scope);
    expect(recovery.mock.calls[0]?.[1].tabs.map((tab) => tab.id)).toEqual([
      'chat',
    ]);
    expect(recovery.mock.calls[0]?.[2].archived).toEqual([]);
    expect(recovery.mock.calls[0]?.slice(3)).toEqual([{ readMetadata }]);
    expect(generation).not.toHaveBeenCalled();
    expect(descriptor).not.toHaveBeenCalled();
  });

  it('preserves raw stream-card reference pairs when startup recovery changes a legacy sibling', async () => {
    const seeded = await format4Scope(
      root,
      'scope',
      scopeSource([{ id: 'chat', messages: [row] }]),
    );
    const reference = await seeded.backend.storage.transcripts.artifacts.put(
      'chat',
      'a'.repeat(80_000),
    );
    const parent = delegationTranscriptMessages({
      delegationId: 'child',
      runGeneration: 1,
      sequence: 1,
      parentHarnessId: 'claude',
      parentTurnId: 'turn',
      parentToolCallId: 'spawn',
      createdAt: 1,
      task: {
        description: 'Stored task',
        prompt: 'Stored prompt',
        executionMode: 'background',
      },
      snapshot: {
        delegationId: 'child',
        status: 'running',
        finalText: 'stored preview',
        outputTruncated: true,
        routeSnapshot: {
          selectedModelId: 'model',
          runtimeModelId: 'model',
          harnessId: 'claude',
          runtimeKind: 'local',
          runnerRegistrationId: 'claude-local',
          runtimeVersion: '1',
          adapterVersion: '1',
          modelSource: 'catalog',
          providerType: 'claude',
          assignmentRevision: 'test-assignment',
          billingAuthority: 'local',
          aiCreditsRouted: false,
          capabilities: [],
          supportedThinkingLevels: [],
          capabilitySnapshotHash: 'test-capabilities',
          capabilityGeneration: 1,
          policyRevision: 'test-policy',
        },
      },
      transcript: [],
    })[0];
    const block = parent?.blocks[0];
    if (!parent || block?.type !== 'delegated_agent_call')
      throw new Error('Missing fixture card');
    const stored: PersistedChatMessage = {
      ...parent,
      blocks: [
        {
          ...block,
          transcriptStore: 'chat-stream-v2',
          finalTextRef: reference,
        },
      ],
    };
    const target = {
      kind: 'delegation',
      chatId: 'chat',
      delegationId: 'child',
      runGeneration: 1,
    } satisfies Parameters<ChatStateV2Backend['registerTranscriptStream']>[0];
    const cardState: CardStateV1 = {
      version: 1,
      status: 'running',
      resultIndex: null,
      error: null,
      usage: null,
      workspaceRevision: null,
      workspaceDiscarded: false,
      stopOutcome: null,
      controlOutcome: null,
      attribution: null,
      capabilitySummary: null,
      nestedChildSummary: null,
      partialPreview: null,
      finalPreview: 'descriptor preview',
    };
    try {
      await seeded.backend.transact(
        () => [{ type: 'message.upserted', chatId: 'chat', message: stored }],
        { source: 'provider' },
      );
      await seeded.backend.registerTranscriptStream(target);
      const descriptor = await seeded.backend.childStreamDescriptor(target);
      if (!descriptor) throw new Error('Missing fixture descriptor');
      await seeded.backend.updateChildStreamCardState(
        target,
        descriptor.streamRevision,
        cardState,
      );
      await seeded.backend.flush();
    } finally {
      seeded.backend.releaseJournal();
      await seeded.backend.disposeArtifactMaintenance();
    }
    jest
      .spyOn(delegationRecovery, 'hasDelegationRecoveryRecords')
      .mockResolvedValue(true);
    const recovery = jest
      .spyOn(delegationRecovery, 'loadDelegationRecoveryMutations')
      .mockImplementation((_scope, tabs) => {
        const tab = tabs.tabs.find((candidate) => candidate.id === 'chat');
        if (!tab) throw new Error('Missing recovery tab');
        return Promise.resolve([
          {
            type: 'messages.replaced',
            chatId: 'chat',
            removedMessageIds: [],
            messages: tab.messages.map((message) =>
              message.id === row.id
                ? {
                    ...message,
                    blocks: [
                      { type: 'text', text: 'legacy sibling recovered' },
                    ],
                  }
                : message,
            ),
          },
        ]);
      });
    const generation = jest.spyOn(ChatStateV2Backend.prototype, 'generation');
    const streamDescriptor = jest.spyOn(
      ChatDeltaJournalWriter.prototype,
      'childDescriptor',
    );
    const body = jest.spyOn(ChatTranscriptArtifacts.prototype, 'readRange');
    const repository = repositoryForTest({ ...options(), enableFormat4: true });
    const raw = await repository.getState(scope, {
      chatIds: ['chat'],
      fullTranscript: true,
      rawStreamCards: true,
    });
    expect(recovery).toHaveBeenCalledTimes(1);
    expect(generation).not.toHaveBeenCalled();
    expect(streamDescriptor).not.toHaveBeenCalled();
    expect(body).not.toHaveBeenCalled();
    expect(
      raw.tabsFile.tabs[0]?.messages.find(
        (message) => message.id === stored.id,
      ),
    ).toEqual(stored);
    expect(
      raw.tabsFile.tabs[0]?.messages.find((message) => message.id === row.id)
        ?.blocks,
    ).toEqual([{ type: 'text', text: 'legacy sibling recovered' }]);
    const overlaid = await repository.getState(scope, {
      chatIds: ['chat'],
      fullTranscript: true,
    });
    const projected = overlaid.tabsFile.tabs[0]?.messages.find(
      (message) => message.id === stored.id,
    )?.blocks[0];
    expect(projected).toMatchObject({ finalText: 'descriptor preview' });
    expect(projected).not.toHaveProperty('finalTextRef');
    expect(streamDescriptor).toHaveBeenCalled();
    expect(body).not.toHaveBeenCalled();
    await repository.flushScope(scope);
    const fresh = new ChatStateV2Backend(
      ChatStorageV2.fromLegacyPaths(paths, { maxManifestVersion: 4 }),
      { enableFormat4: true, deltaJournal: {} },
    );
    try {
      await fresh.load();
      const freshRaw = await fresh.state({
        chatIds: ['chat'],
        fullTranscript: true,
        rawStreamCards: true,
      });
      expect(
        freshRaw.tabsFile.tabs[0]?.messages.find(
          (message) => message.id === stored.id,
        ),
      ).toEqual(stored);
    } finally {
      fresh.releaseJournal();
      await fresh.disposeArtifactMaintenance();
    }
  });

  it('reads a stored parent row without invoking the state selection overlay', async () => {
    const repository = repositoryForTest(options());
    await repository.getState(scope);
    const state = jest.spyOn(ChatStateV2Backend.prototype, 'state');
    await expect(
      repository.readStoredParentMessage(scope, 'chat', 'user'),
    ).resolves.toEqual(row);
    expect(state).not.toHaveBeenCalled();
  });

  it.each([
    { limit: 0 },
    { limit: 201 },
    { limit: 1.5 },
    { encodedBudget: -1 },
    { encodedBudget: 4 * 1024 * 1024 + 1 },
    { streamRevision: -1 },
    { beforeSequence: 0 },
    { beforeSequence: 1.5 },
  ])(
    'rejects a malformed compatibility request before loading storage: %p',
    async (invalid) => {
      const repository = repositoryForTest(options());
      const load = jest.spyOn(ChatStateV2Backend.prototype, 'load');
      await expect(
        repository.childStreamCompatibilityPage(scope, {
          target: {
            kind: 'delegation',
            chatId: 'chat',
            delegationId: 'child',
            runGeneration: 1,
          },
          streamRevision: 0,
          limit: 5,
          encodedBudget: 1024,
          ...invalid,
        }),
      ).resolves.toMatchObject({ ok: false, code: 'invalid_request' });
      expect(load).not.toHaveBeenCalled();
    },
  );

  it('returns not-found for compatibility pages whose target stream is absent', async () => {
    const seeded = await format4Scope(
      root,
      'scope',
      scopeSource([{ id: 'chat', messages: [row] }]),
    );
    await seeded.backend.flush();
    seeded.backend.releaseJournal();
    await seeded.backend.disposeArtifactMaintenance();
    const repository = repositoryForTest({ ...options(), enableFormat4: true });
    await expect(
      repository.childStreamCompatibilityPage(scope, {
        target: {
          kind: 'delegation',
          chatId: 'chat',
          delegationId: 'child',
          runGeneration: 1,
        },
        streamRevision: 0,
        limit: 5,
        encodedBudget: 1024,
      }),
    ).resolves.toMatchObject({ ok: false, code: 'not_found' });
  });

  it('does not arm an idle checkpoint for child-only journal records', () => {
    const repository = repositoryForTest(options());
    const entry = {
      lifecycle: 'ready',
      deleting: false,
      backend: {
        wantsRepromotion: (): boolean => false,
        pendingJournalRecords: (): number => 1,
        journalCheckpointDue: (): boolean => false,
        pendingPrimaryRecordCount: (): number => 0,
        journalIdleCheckpointWanted: (): boolean => true,
      },
      journalIdleTimer: undefined,
    };
    const schedule: unknown = Reflect.get(repository, 'scheduleJournalWork');
    if (typeof schedule !== 'function') throw new Error('Missing scheduler');
    Reflect.apply(schedule, repository, [entry]);
    expect(entry.journalIdleTimer).toBeUndefined();
  });
  const previewIt =
    typeof Reflect.get(
      ChatStateV2Repository.prototype,
      'consumeTranscriptPreview',
    ) === 'function'
      ? it
      : it.skip;
  const consumePreview = <T>(
    repository: ChatStateV2Repository,
    consume: (
      messages: AsyncIterable<PersistedChatMessage>,
      descriptor: TranscriptDescriptor,
    ) => Promise<T>,
  ): Promise<T> => {
    const preview: unknown = Reflect.get(
      repository,
      'consumeTranscriptPreview',
    );
    if (typeof preview !== 'function')
      throw new Error('Preview reader is unavailable');
    return Promise.resolve(
      Reflect.apply(preview, repository, [scope, 'chat', consume]),
    );
  };

  it('migrates on first admission, scopes aliases to one owner and resumes without v1 files', async () => {
    const repository = repositoryForTest(options());
    await repository.getState(scope);
    await expect(readFile(paths.tabs)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await repository.transact(
      scope,
      [
        {
          type: 'tab.metadata_patched',
          tabId: 'chat',
          patch: { unread: true },
        },
      ],
      { source: 'automation' },
    );
    expect(
      (await repository.getState({ projectId: 'alias', worktreeId: 'alias' }))
        .tabsFile.tabs[0].unread,
    ).toBe(true);
    const resumed = repositoryForTest(options());
    expect((await resumed.page(scope, 'chat')).messages).toEqual([row]);
    expect(await resumed.getRevision(scope)).toBe(1);
  });

  it('preserves sources and delays cutover when an active host owns the scope', async () => {
    let live = true;
    const repository = repositoryForTest({
      ...options(),
      hasLiveDependency: (): boolean => live,
    });
    await expect(repository.getState(scope)).rejects.toMatchObject({
      code: 'recovery_error',
    });
    expect(await ChatStorageV2.fromLegacyPaths(paths).authority()).toBe('v1');
    live = false;
    expect((await repository.page(scope, 'chat')).messages).toEqual([row]);
  });

  it('fences ordinary writes throughout nested deletion and deletes only an empty scope', async () => {
    const repository = repositoryForTest(options());
    await repository.getState(scope);
    await expect(repository.deleteEmptyScope(scope)).rejects.toThrow(
      'semantically empty',
    );
    await repository.runWithScopeDeletion(scope, async () => {
      await repository.runWithScopeDeletion(scope, async () => {
        await expect(
          repository.transact(scope, [], { source: 'automation' }),
        ).rejects.toThrow('being deleted');
      });
      await expect(
        repository.transact(scope, [], { source: 'automation' }),
      ).rejects.toThrow('being deleted');
      await repository.transact(
        scope,
        [{ type: 'tab.removed', tabId: 'chat' }],
        { source: 'automation', allowDuringScopeDeletion: true },
      );
      await repository.deleteEmptyScope(scope);
      // Late continuations inside the deletion window still hold the
      // disposed entry and must drain rather than resurrect the scope.
      await expect(
        repository.transact(scope, [], {
          source: 'automation',
          allowDuringScopeDeletion: true,
        }),
      ).rejects.toThrow('draining');
    });
    expect(repository.getLifecycle(scope)).toBe('disposed');
    await expect(
      readFile(ChatStorageV2.fromLegacyPaths(paths).manifestPath),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('re-admits a deleted scope id as a fresh empty scope once deletion completes', async () => {
    const repository = repositoryForTest(options());
    await repository.getState(scope);
    await repository.runWithScopeDeletion(scope, async () => {
      await repository.transact(
        scope,
        [{ type: 'tab.removed', tabId: 'chat' }],
        { source: 'automation', allowDuringScopeDeletion: true },
      );
      await repository.deleteEmptyScope(scope);
    });
    expect(repository.getLifecycle(scope)).toBe('disposed');
    expect((await repository.getState(scope)).tabsFile.tabs).toEqual([]);
    expect(repository.getLifecycle(scope)).toBe('ready');
    await repository.transact(
      scope,
      [
        {
          type: 'tab.created',
          tab: {
            id: 'again',
            title: 'Again',
            createdAt: '2026-09-06',
            messages: [row],
          },
        },
      ],
      { source: 'renderer-command' },
    );
    await expect(repository.page(scope, 'chat')).rejects.toThrow(
      'Unknown chat',
    );
    expect((await repository.page(scope, 'again')).messages).toEqual([row]);
  });

  it('publishes durable commits in revision order and never rejects an applied commit on listener failure', async () => {
    const invoked: number[] = [];
    const settled: number[] = [];
    let releaseFirst = (): void => undefined;
    let markFirstInvoked = (): void => undefined;
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstInvoked = new Promise<void>((resolve) => {
      markFirstInvoked = resolve;
    });
    const repository = repositoryForTest({
      ...options(),
      onCommit: async (commit): Promise<void> => {
        invoked.push(commit.revision);
        if (commit.revision === 1) {
          markFirstInvoked();
          await first;
        }
        settled.push(commit.revision);
      },
    });
    const patch = (unread: boolean): ChatCoreMutation[] => [
      { type: 'tab.metadata_patched', tabId: 'chat', patch: { unread } },
    ];
    await repository.getState(scope);
    let durableCommits = 0;
    const secondDurable = new Promise<void>((resolve) => {
      repository.subscribeStorageDiagnostics(() => {
        durableCommits += 1;
        if (durableCommits === 2) resolve();
      });
    });
    const one = repository.transact(scope, patch(true), {
      source: 'automation',
    });
    const two = repository.transact(scope, patch(false), {
      source: 'automation',
    });
    await firstInvoked;
    await secondDurable;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(invoked).toEqual([1]);
    expect(settled).toEqual([]);
    releaseFirst();
    await Promise.all([one, two]);
    expect(settled).toEqual([1, 2]);

    const failing = repositoryForTest({
      ...options(),
      onCommit: (): Promise<void> =>
        Promise.reject(new Error('projection failed')),
    });
    const commit = await failing.transact(scope, patch(true), {
      source: 'automation',
    });
    expect(commit.applied).toBe(true);
    expect(commit.revision).toBe(3);
    expect(await failing.getRevision(scope)).toBe(3);
  });

  it('does not publish a replayed import that appended nothing', async () => {
    const listener = jest.fn();
    const repository = repositoryForTest({
      ...options(),
      onCommit: listener,
    });
    const capture = new ChatStorageV2(join(root, 'archive'), 'captured');
    await repository.captureScope(scope, capture);
    const metadata = await repository.getState(scope);
    await repository.transact(scope, [{ type: 'tab.removed', tabId: 'chat' }], {
      source: 'migration',
    });
    listener.mockClear();
    await repository.importScope(scope, capture, metadata, {
      merge: true,
      mutationId: 'import-once',
    });
    expect(listener).toHaveBeenCalledTimes(1);
    await repository.importScope(scope, capture, metadata, {
      merge: true,
      mutationId: 'import-once',
    });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('holds the scope serialization lease across an archive capture executor', async () => {
    const repository = repositoryForTest(options());
    const capture = new ChatStorageV2(join(root, 'archive'), 'captured');
    let releaseExecutor = (): void => undefined;
    let executorEntered = (): void => undefined;
    const entered = new Promise<void>((resolve) => {
      executorEntered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseExecutor = resolve;
    });
    const executor = jest.fn(
      async (source: ChatStorageV2, destination: ChatStorageV2) => {
        executorEntered();
        await gate;
        await source.copyTo(destination);
      },
    );
    const capturePromise = repository.captureScope(
      scope,
      capture,
      false,
      executor,
    );
    await entered;
    let writeSettled = false;
    const write = repository
      .transact(
        scope,
        [
          {
            type: 'tab.metadata_patched',
            tabId: 'chat',
            patch: { unread: true },
          },
        ],
        { source: 'automation' },
      )
      .then(() => {
        writeSettled = true;
      });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(writeSettled).toBe(false);

    releaseExecutor();
    await Promise.all([capturePromise, write]);
    expect(executor).toHaveBeenCalledTimes(1);
    expect(await capture.authority()).toBe('v2');
  });

  it('flushes a scope whose legacy snapshots diverged across a compacted revision gap', async () => {
    await writeFile(
      paths.tabs,
      JSON.stringify({
        version: 1,
        revision: 20,
        activeTabId: 'chat',
        tabs: [
          {
            id: 'chat',
            title: 'Chat',
            createdAt: '2026-09-05',
            messages: [row],
          },
        ],
      }),
    );
    await mkdir(dirname(paths.archives), { recursive: true });
    await writeFile(
      paths.archives,
      JSON.stringify({
        version: 1,
        revision: 5,
        archived: [
          {
            tab: {
              id: 'archived',
              title: 'Archived',
              createdAt: '2026-09-01',
              messages: [{ ...row, id: 'archived-row' }],
            },
            archivedAt: '2026-09-02',
            turnCount: 1,
          },
        ],
      }),
    );
    await mkdir(dirname(paths.journal), { recursive: true });
    await writeFile(
      paths.journal,
      [21, 22]
        .map(
          (revision) =>
            JSON.stringify({
              v: 1,
              revision,
              mutationId: `mutation-${revision}`,
              source: 'provider',
              occurredAt: '2026-09-05',
              mutations: [
                {
                  type: 'tab.metadata_patched',
                  tabId: 'chat',
                  patch: { title: `Chat ${revision}` },
                },
              ],
            }) + '\n',
        )
        .join(''),
    );
    const onStorageDiagnostic = jest.fn();
    const repository = repositoryForTest({
      ...options(),
      onStorageDiagnostic,
    });
    await repository.flushScope(scope);
    expect(repository.getLifecycle(scope)).toBe('ready');
    const state = await repository.getState(scope, { fullTranscript: true });
    expect(state.tabsFile.tabs.map((tab) => tab.title)).toEqual(['Chat 22']);
    expect(state.archivesFile.archived.map((entry) => entry.tab.id)).toEqual([
      'archived',
    ]);
    expect(await repository.getRevision(scope)).toBe(22);
    const recovered: unknown = expect.objectContaining({
      kind: 'legacy_chat_revision_gap_recovered',
      storageAuthority: 'v2',
      ...scope,
      revisionGap: {
        expectedRevision: 6,
        foundRevision: 21,
        newestRevision: 20,
        tabsRevision: 20,
        archiveRevision: 5,
        staleComponent: 'archives',
        skippedMutationCount: 0,
      },
    });
    expect(onStorageDiagnostic).toHaveBeenCalledWith(recovered);
    expect(repository.getStorageDiagnostics(scope)).toEqual([
      recovered,
      expect.objectContaining({ kind: 'delta_journal_promoted', ...scope }),
    ]);
    expect(repository.getDiagnostics(scope)).toEqual([]);
  });

  it('caches a failed recovery until a deliberate release re-attempts it', async () => {
    await mkdir(dirname(paths.journal), { recursive: true });
    await writeFile(
      paths.journal,
      ['conflict-a', 'conflict-b']
        .map(
          (mutationId) =>
            JSON.stringify({
              v: 1,
              revision: 1,
              mutationId,
              source: 'provider',
              occurredAt: '2026-09-05',
              mutations: [
                {
                  type: 'tab.metadata_patched',
                  tabId: 'chat',
                  patch: { unread: true },
                },
              ],
            }) + '\n',
        )
        .join(''),
    );
    const migrate = jest.spyOn(legacyChatMigration, 'migrateLegacyChatScope');
    const repository = repositoryForTest(options());
    const failure = (error: unknown): unknown => error;
    const first: unknown = await repository
      .getState(scope)
      .then(() => undefined, failure);
    const second: unknown = await repository
      .getRevision(scope)
      .then(() => undefined, failure);
    expect(first).toBeInstanceOf(ChatStateRepositoryLoadError);
    expect(second).toBe(first);
    expect(migrate).toHaveBeenCalledTimes(1);
    expect(repository.getLifecycle(scope)).toBe('recovery_error');
    const diagnostics = repository.getDiagnostics(scope);
    expect(diagnostics).toMatchObject([{ kind: 'unrecoverable_journal' }]);
    expect(diagnostics[0]?.message).toContain('Conflicting duplicate');
    await rm(paths.journal);
    expect(await repository.releaseScope(scope)).toBe(true);
    expect(repository.getLifecycle(scope)).toBe('unloaded');
    expect((await repository.getState(scope)).tabsFile.tabs[0].id).toBe('chat');
    expect(migrate).toHaveBeenCalledTimes(2);
    expect(repository.getDiagnostics(scope)).toEqual([]);
  });

  it('retries a transient I/O load failure on the next access without a release', async () => {
    const readError = Object.assign(new Error('temporary read failure'), {
      code: 'EIO',
    });
    const migrate = jest
      .spyOn(legacyChatMigration, 'migrateLegacyChatScope')
      .mockRejectedValueOnce(readError);
    const repository = repositoryForTest(options());
    const first: unknown = await repository.getState(scope).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(first).toBeInstanceOf(ChatStateRepositoryLoadError);
    expect(repository.getLifecycle(scope)).toBe('recovery_error');
    expect((await repository.getState(scope)).tabsFile.tabs[0].id).toBe('chat');
    expect(migrate).toHaveBeenCalledTimes(2);
    expect(repository.getLifecycle(scope)).toBe('ready');
  });

  it('returns typed revision conflicts and does not publish duplicate durable commits', async () => {
    const listener = jest.fn();
    const repository = repositoryForTest({
      ...options(),
      onCommit: listener,
    });
    const mutations = [
      {
        type: 'tab.metadata_patched' as const,
        tabId: 'chat',
        patch: { unread: true },
      },
    ];
    await repository.transact(scope, mutations, {
      source: 'automation',
      mutationId: 'one',
      expectedRevision: 0,
    });
    await repository.transact(scope, mutations, {
      source: 'automation',
      mutationId: 'one',
      expectedRevision: 0,
    });
    expect(listener).toHaveBeenCalledTimes(1);
    await expect(
      repository.transact(scope, mutations, {
        source: 'automation',
        expectedRevision: 0,
      }),
    ).rejects.toBeInstanceOf(ChatStateRevisionConflictError);
  });

  it('captures and restores through a bounded import with independent lossless output', async () => {
    const repository = repositoryForTest(options());
    const output = 'large output 🌲'.repeat(12000);
    await repository.transact(
      scope,
      [
        {
          type: 'message.upserted',
          chatId: 'chat',
          message: {
            ...row,
            id: 'tool',
            role: 'assistant',
            blocks: [
              {
                type: 'tool_result',
                toolUseId: 'call',
                toolName: 'shell',
                output,
                isError: false,
              },
            ],
          },
        },
      ],
      { source: 'provider' },
    );
    const capture = new ChatStorageV2(join(root, 'archive'), 'captured');
    await repository.captureScope(scope, capture);
    const metadata = await repository.getState(scope);
    const targetPaths = {
      tabs: join(root, 'restored', 'chats', 'scope.json'),
      archives: join(root, 'restored', 'chat-archives', 'scope.json'),
      journal: join(root, 'restored', 'chat-journals', 'scope.jsonl'),
    };
    const target = repositoryForTest({
      resolvePaths: (): typeof paths => targetPaths,
    });
    await target.importScope(scope, capture, metadata);
    expect(
      await readFile(
        join(
          ChatStorageV2.fromLegacyPaths(targetPaths).directory,
          'transcripts',
          'chat.jsonl',
        ),
      ),
    ).toEqual(
      await readFile(join(capture.directory, 'transcripts', 'chat.jsonl')),
    );
    await rm(capture.directory, { recursive: true });
    // A restart retires the old writer before admitting the scope again.
    await target.drainAll();
    const restarted = repositoryForTest({
      resolvePaths: (): typeof paths => targetPaths,
    });
    const full = await restarted.consumeTranscript(
      scope,
      'chat',
      true,
      async (messages) => {
        const rows = [];
        for await (const message of messages) rows.push(message);
        return rows;
      },
    );
    expect(full[1].blocks[0]).toMatchObject({ output });
    expect(await ChatStorageV2.fromLegacyPaths(targetPaths).format()).toBe(
      'v3',
    );
    await expect(
      restarted.importScope(scope, capture, metadata),
    ).rejects.toThrow('existing chat data');
    expect((await restarted.page(scope, 'chat')).totalMessages).toBe(2);
  }, 30_000);

  it('rejects a paginated UI snapshot as an authoritative history replacement', async () => {
    const messages = [
      row,
      ...Array.from(
        { length: 1502 },
        (_, index): PersistedChatMessage => ({
          ...row,
          id: `reply-${index}`,
          role: 'assistant',
          timestamp: index + 2,
        }),
      ),
    ];
    await writeFile(
      paths.tabs,
      JSON.stringify({
        version: 1,
        activeTabId: 'chat',
        tabs: [
          { id: 'chat', title: 'Chat', createdAt: '2026-09-05', messages },
        ],
      }),
    );
    const repository = repositoryForTest(options());
    const paged = await repository.getState(scope, {
      chatIds: ['chat'],
      pageOnly: true,
    });
    expect(paged.tabsFile.tabs[0].messages).toHaveLength(1001);
    await expect(
      repository.replaceCompatibilityTabs(scope, paged.tabsFile, {
        authoritative: true,
      }),
    ).rejects.toThrow('complete transcript');
    expect((await repository.page(scope, 'chat')).totalMessages).toBe(1503);
  }, 120_000);

  it('locates missing, active, last, and nonlast messages', async () => {
    const messages = [
      { ...row, id: 'committed-first' },
      { ...row, id: 'committed-last', role: 'assistant' as const },
    ];
    await writeFile(
      paths.tabs,
      JSON.stringify({
        version: 1,
        activeTabId: 'chat',
        tabs: [
          { id: 'chat', title: 'Chat', createdAt: '2026-09-05', messages },
        ],
      }),
    );
    const repository = repositoryForTest(options());
    await repository.getState(scope);

    expect(await locateMessage(repository, 'chat', 'unknown')).toBe('missing');
    expect(await locateMessage(repository, 'chat', 'committed-first')).toEqual({
      committed: true,
      last: false,
    });
    expect(await locateMessage(repository, 'chat', 'committed-last')).toEqual({
      committed: true,
      last: true,
    });

    await repository.transact(
      scope,
      [
        {
          type: 'runtime.patched',
          chatId: 'chat',
          runtime: { status: 'streaming', queuedMessageIds: [] },
        },
        {
          type: 'message.upserted',
          chatId: 'chat',
          message: {
            ...row,
            id: 'active-assistant',
            role: 'assistant',
            blocks: [{ type: 'text', text: 'in progress' }],
          },
        },
      ],
      { source: 'provider' },
    );
    expect(await locateMessage(repository, 'chat', 'active-assistant')).toBe(
      'active',
    );
    expect(await locateMessage(repository, 'chat', 'committed-last')).toEqual({
      committed: true,
      last: false,
    });
  });

  it('locates a committed row outside the current page without scanning history', async () => {
    const messages = Array.from(
      { length: 1_105 },
      (_, index): PersistedChatMessage => ({
        ...row,
        id: `offpage-${index}`,
        role: index === 0 ? 'user' : 'assistant',
        timestamp: index + 1,
      }),
    );
    await writeFile(
      paths.tabs,
      JSON.stringify({
        version: 1,
        activeTabId: 'chat',
        tabs: [
          { id: 'chat', title: 'Chat', createdAt: '2026-09-05', messages },
        ],
      }),
    );
    const repository = repositoryForTest(options());
    await repository.getState(scope);
    const page = await repository.page(scope, 'chat');
    expect(page.messages.some((message) => message.id === 'offpage-0')).toBe(
      false,
    );

    const iterate = jest.spyOn(ChatTranscriptLog.prototype, 'iterate');
    const iterateLogical = jest.spyOn(
      ChatTranscriptLog.prototype,
      'iterateLogical',
    );
    expect(await locateMessage(repository, 'chat', 'offpage-0')).toEqual({
      committed: true,
      last: false,
    });
    expect(iterate).not.toHaveBeenCalled();
    expect(iterateLogical).not.toHaveBeenCalled();
  }, 30_000);

  it('reads journal-projected active rows without changing the journal', async () => {
    const repository = repositoryForTest({
      ...options(),
      deltaJournalIdleCheckpointMs: 60_000,
    });
    await repository.getState(scope);
    const store = ChatStorageV2.fromLegacyPaths(paths);
    expect(await store.format()).toBe('v3');
    await repository.transact(
      scope,
      [
        {
          type: 'runtime.patched',
          chatId: 'chat',
          runtime: { status: 'streaming', queuedMessageIds: [] },
        },
        {
          type: 'message.upserted',
          chatId: 'chat',
          message: {
            ...row,
            id: 'journal-active',
            role: 'assistant',
            blocks: [{ type: 'text', text: 'journal projection' }],
          },
        },
      ],
      { source: 'provider' },
    );

    const journalPath = join(store.directory, DELTA_JOURNAL_FILE_NAME);
    const before = await readFile(journalPath);
    const revision = await repository.getRevision(scope);
    expect(await locateMessage(repository, 'chat', 'journal-active')).toBe(
      'active',
    );
    expect(await readFile(journalPath)).toEqual(before);
    expect(await repository.getRevision(scope)).toBe(revision);
  }, 30_000);

  it.each(['connecting', 'replaced-block', 'omitted'] as const)(
    'keeps canonical MCP recovery rows through a %s compatibility save',
    async (staleKind) => {
      const repository = repositoryForTest(options());
      const connecting: McpActivationRecord = {
        version: 1,
        ownerId: 'owner',
        activationId: 'activation',
        attemptId: 'attempt',
        originatingMessageId: row.id,
        providerSessionId: 'session',
        provider: 'claude',
        trigger: 'selection',
        requiredTargets: [
          { kind: 'standalone', serverId: 'server', configId: 'config' },
        ],
        desiredGeneration: 1,
        phase: 'connecting',
        cancelled: false,
        admission: 'not_sent',
        retryEligible: false,
      };
      const activationRow: PersistedChatMessage = {
        id: `mcp-activation-${createHash('sha256').update(row.id).digest('hex').slice(0, 24)}`,
        role: 'system',
        timestamp: 2,
        blocks: [{ type: 'mcp_activation', record: connecting }],
      };
      await repository.transact(
        scope,
        [
          {
            type: 'tab.metadata_patched',
            tabId: 'chat',
            patch: { mcpActivation: connecting },
          },
          { type: 'message.upserted', chatId: 'chat', message: activationRow },
        ],
        { source: 'migration' },
      );
      const stale = (
        await repository.getState(scope, {
          chatIds: ['chat'],
          fullTranscript: true,
        })
      ).tabsFile;
      if (staleKind === 'omitted') stale.tabs[0].messages = [row];
      if (staleKind === 'replaced-block')
        stale.tabs[0].messages = [
          row,
          {
            ...activationRow,
            blocks: [{ type: 'text', text: 'stale activation' }],
          },
        ];
      const completed: McpActivationRecord = {
        ...connecting,
        phase: 'completed',
        admission: 'accepted',
      };
      const completedRow: PersistedChatMessage = {
        ...activationRow,
        blocks: [{ type: 'mcp_activation', record: completed }],
      };
      await repository.transact(
        scope,
        [
          {
            type: 'tab.metadata_patched',
            tabId: 'chat',
            patch: { mcpActivation: completed },
          },
          { type: 'message.upserted', chatId: 'chat', message: completedRow },
        ],
        { source: 'migration' },
      );
      await repository.replaceCompatibilityTabs(scope, stale, {
        changedTabIds: ['chat'],
      });
      await repository.drainAll();
      const reopened = repositoryForTest(options());
      const saved = (
        await reopened.getState(scope, {
          chatIds: ['chat'],
          fullTranscript: true,
        })
      ).tabsFile.tabs[0];
      expect(saved.mcpActivation).toEqual(completed);
      expect(saved.messages).toEqual([row, completedRow]);
    },
  );

  it('activates a selectively imported tab in the same transaction', async () => {
    const repository = repositoryForTest(options());
    await repository.transact(
      scope,
      [
        {
          type: 'tab.created',
          tab: {
            id: 'existing',
            title: 'Existing',
            createdAt: '2026-09-05',
            messages: [row],
          },
        },
        { type: 'tab.active_changed', activeTabId: 'existing' },
      ],
      { source: 'renderer-command' },
    );

    const current = await repository.getState(scope);
    const resumed = {
      id: 'resumed',
      title: 'Resumed',
      createdAt: '2026-09-06',
      messages: [{ ...row, id: 'resumed-user' }],
    };
    const result = await repository.replaceCompatibilityTabs(
      scope,
      {
        ...current.tabsFile,
        tabs: [...current.tabsFile.tabs, resumed],
        activeTabId: resumed.id,
      },
      { changedTabIds: [resumed.id], activeTabId: resumed.id },
    );

    expect(result.tabsFile.activeTabId).toBe(resumed.id);
  });

  it('copies chats between scopes without replacing lean siblings and retries exactly once', async () => {
    const destinationScope = { ...scope, worktreeId: 'destination' };
    const destinationPaths = {
      tabs: join(root, 'chats', 'destination.json'),
      archives: join(root, 'chat-archives', 'destination.json'),
      journal: join(root, 'chat-journals', 'destination.jsonl'),
    };
    const repository = repositoryForTest({
      resolvePaths: (target): typeof paths =>
        target.worktreeId === 'destination' ? destinationPaths : paths,
    });
    await repository.transact(
      destinationScope,
      [
        {
          type: 'tab.created',
          tab: {
            id: 'lean',
            title: 'Keep lean',
            createdAt: '2026-09-05',
            messages: [{ ...row, id: 'lean-user' }],
          },
        },
      ],
      { source: 'renderer-command' },
    );
    const sourceMetadata = await repository.getState(scope);
    await repository.copyChats(scope, destinationScope, sourceMetadata);
    const revision = await repository.getRevision(destinationScope);
    await repository.copyChats(scope, destinationScope, sourceMetadata);
    expect(await repository.getRevision(destinationScope)).toBe(revision);
    expect(
      (await repository.page(destinationScope, 'lean')).messages[0].id,
    ).toBe('lean-user');
    await repository.transact(scope, [{ type: 'tab.removed', tabId: 'chat' }], {
      source: 'migration',
    });
    expect((await repository.page(destinationScope, 'chat')).messages).toEqual([
      row,
    ]);
  });

  it('streams a canonical cross-scope branch through its requested message anchor', async () => {
    const destinationScope = { ...scope, worktreeId: 'anchored-destination' };
    const repository = repositoryForTest({
      resolvePaths: (target): typeof paths => ({
        tabs: join(root, 'chats', `${target.worktreeId}.json`),
        archives: join(root, 'chat-archives', `${target.worktreeId}.json`),
        journal: join(root, 'chat-journals', `${target.worktreeId}.jsonl`),
      }),
    });
    await repository.transact(
      scope,
      [
        {
          type: 'message.upserted',
          chatId: 'chat',
          message: { ...row, id: 'second', timestamp: 2 },
        },
        {
          type: 'message.upserted',
          chatId: 'chat',
          message: { ...row, id: 'third', timestamp: 3 },
        },
      ],
      { source: 'provider' },
    );
    const metadata = await repository.getState(scope);
    await repository.copyChats(
      scope,
      destinationScope,
      metadata,
      undefined,
      undefined,
      { chat: 'second' },
    );
    expect((await repository.page(destinationScope, 'chat')).messages).toEqual([
      row,
      { ...row, id: 'second', timestamp: 2 },
    ]);
  });

  it('checks cross-scope authorization after preparing payloads but before publishing', async () => {
    const destinationScope = { ...scope, worktreeId: 'guarded-destination' };
    const repository = repositoryForTest({
      resolvePaths: (target): typeof paths => ({
        tabs: join(root, 'chats', `${target.worktreeId}.json`),
        archives: join(root, 'chat-archives', `${target.worktreeId}.json`),
        journal: join(root, 'chat-journals', `${target.worktreeId}.jsonl`),
      }),
    });
    const beforePublish = jest.fn<void, []>(() => {
      throw new Error('approval changed');
    });

    await expect(
      repository.copyChats(
        scope,
        destinationScope,
        await repository.getState(scope),
        undefined,
        undefined,
        undefined,
        beforePublish,
      ),
    ).rejects.toThrow('approval changed');

    expect(beforePublish).toHaveBeenCalledTimes(1);
    expect((await repository.getState(destinationScope)).tabsFile.tabs).toEqual(
      [],
    );
    await expect(repository.page(destinationScope, 'chat')).rejects.toThrow(
      'Unknown chat',
    );
  });

  it('requires an awaiting-input turn to settle before copying its retained question', async () => {
    const destinationScope = { ...scope, worktreeId: 'destination' };
    const repository = repositoryForTest({
      resolvePaths: (target): typeof paths => ({
        tabs: join(root, 'chats', `${target.worktreeId}.json`),
        archives: join(root, 'chat-archives', `${target.worktreeId}.json`),
        journal: join(root, 'chat-journals', `${target.worktreeId}.jsonl`),
      }),
    });
    const question = {
      requestId: 'retained-question',
      chatId: 'chat',
      questions: [],
    };
    await repository.transact(
      scope,
      [
        { type: 'pending_question.upserted', question },
        {
          type: 'runtime.patched',
          chatId: 'chat',
          runtime: { status: 'awaiting_input', queuedMessageIds: [] },
        },
      ],
      { source: 'provider' },
    );
    await expect(
      repository.copyChats(
        scope,
        destinationScope,
        await repository.getState(scope),
      ),
    ).rejects.toThrow('active turns to settle');
    await repository.transact(
      scope,
      [
        {
          type: 'runtime.patched',
          chatId: 'chat',
          runtime: { status: 'interrupted', queuedMessageIds: [] },
        },
      ],
      { source: 'provider' },
    );
    await repository.copyChats(
      scope,
      destinationScope,
      await repository.getState(scope),
    );
    expect(
      (await repository.getState(destinationScope)).tabsFile.pendingQuestions,
    ).toEqual([question]);
    expect((await repository.page(destinationScope, 'chat')).messages).toEqual([
      row,
    ]);
  });

  it('streams path rewrites and restores a removed source from its durable capture', async () => {
    const destinationScope = { ...scope, worktreeId: 'destination' };
    const repository = repositoryForTest({
      resolvePaths: (target): typeof paths => ({
        tabs: join(root, 'chats', `${target.worktreeId}.json`),
        archives: join(root, 'chat-archives', `${target.worktreeId}.json`),
        journal: join(root, 'chat-journals', `${target.worktreeId}.jsonl`),
      }),
    });
    const captured = new ChatStorageV2(join(root, 'split-backup'), 'scope');
    await repository.captureScope(scope, captured);
    const metadata = await repository.getState(scope);
    await repository.copyChats(
      scope,
      destinationScope,
      metadata,
      undefined,
      (message) => ({
        ...message,
        attachmentPaths: ['/destination/attachment.txt'],
      }),
    );
    expect(
      (await repository.page(destinationScope, 'chat')).messages[0]
        .attachmentPaths,
    ).toEqual(['/destination/attachment.txt']);
    await repository.transact(scope, [{ type: 'tab.removed', tabId: 'chat' }], {
      source: 'migration',
    });
    await repository.importScope(scope, captured, metadata, { merge: true });
    expect((await repository.page(scope, 'chat')).messages).toEqual([row]);
  }, 30_000);

  it('holds an export read lease through consumption and reconstructs full tool output', async () => {
    const repository = repositoryForTest(options());
    const output = 'full output 🌲\n'.repeat(9000);
    await repository.transact(
      scope,
      [
        {
          type: 'message.upserted',
          chatId: 'chat',
          message: {
            ...row,
            id: 'tool',
            role: 'assistant',
            blocks: [
              {
                type: 'tool_result',
                toolUseId: 'call',
                toolName: 'shell',
                output,
                isError: false,
              },
            ],
          },
        },
      ],
      { source: 'provider' },
    );
    const page = await repository.page(scope, 'chat');
    expect(JSON.stringify(page).length).toBeLessThan(output.length);
    const block = page.messages[1].blocks[0];
    if (block.type !== 'tool_result' || !block.fullOutputRef)
      throw new Error('Missing output reference');
    const iterateSpy = jest.spyOn(ChatTranscriptLog.prototype, 'iterate');
    const range = await repository.toolOutput(
      scope,
      'chat',
      'tool',
      'call',
      block.fullOutputRef,
      0,
      32,
    );
    expect(output.startsWith(range.text)).toBe(true);
    expect(Buffer.byteLength(range.text)).toBeLessThanOrEqual(32);
    expect(range.nextOffset).toBe(Buffer.byteLength(range.text));
    if (range.nextOffset === undefined)
      throw new Error('Missing next tool output offset');
    await repository.toolOutput(
      scope,
      'chat',
      'tool',
      'call',
      block.fullOutputRef,
      range.nextOffset,
      32,
    );
    expect(iterateSpy).not.toHaveBeenCalled();
    await repository.transact(
      scope,
      [
        {
          type: 'message.upserted',
          chatId: 'chat',
          message: {
            ...row,
            blocks: [{ type: 'text', text: 'updated' }],
          },
        },
      ],
      { source: 'provider' },
    );
    iterateSpy.mockClear();
    await repository.toolOutput(
      scope,
      'chat',
      'tool',
      'call',
      block.fullOutputRef,
      0,
      32,
    );
    expect(iterateSpy).not.toHaveBeenCalled();
    await repository.transact(
      scope,
      [{ type: 'message.upserted', chatId: 'chat', message: row }],
      { source: 'provider' },
    );
    await expect(
      repository.toolOutput(
        scope,
        'unknown',
        'tool',
        'call',
        block.fullOutputRef,
        0,
        32,
      ),
    ).rejects.toThrow('Unknown chat');
    await expect(
      repository.toolOutput(
        scope,
        'chat',
        'tool',
        'different-call',
        block.fullOutputRef,
        0,
        32,
      ),
    ).rejects.toThrow('does not own');
    const full = await repository.consumeTranscript(
      scope,
      'chat',
      true,
      async (messages) => {
        const result = [];
        for await (const message of messages) result.push(message);
        return result;
      },
    );
    expect(full[1].blocks[0]).toEqual({
      type: 'tool_result',
      toolUseId: 'call',
      toolName: 'shell',
      output,
      isError: false,
    });
    await expect(
      repository.page(scope, 'chat', 1, page.transcriptRevision - 1),
    ).rejects.toThrow("Couldn't load messages.");
    let release = (): void => undefined;
    let entered = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const reader = repository.consumeTranscript(
      scope,
      'chat',
      false,
      async (messages) => {
        entered();
        await held;
        const ids: string[] = [];
        for await (const message of messages) ids.push(message.id);
        return ids;
      },
    );
    await started;
    let mutationStarted = false;
    const writer = repository.transactWith(
      scope,
      () => {
        mutationStarted = true;
        return [{ type: 'message.removed', chatId: 'chat', messageId: 'tool' }];
      },
      { source: 'automation' },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(mutationStarted).toBe(false);
    release();
    expect(await reader).toEqual(['user', 'tool']);
    await writer;
    expect((await repository.page(scope, 'chat')).messages).toEqual([row]);
  }, 30_000);

  it('does not hold the scope writer behind a preview projection consumer', async () => {
    const repository = repositoryForTest(options());
    await repository.getState(scope);
    let releaseReader = (): void => undefined;
    let readerEntered = (): void => undefined;
    let writerEntered = (): void => undefined;
    const heldReader = new Promise<void>((resolve) => {
      releaseReader = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      readerEntered = resolve;
    });
    const writerStarted = new Promise<void>((resolve) => {
      writerEntered = resolve;
    });
    const consume = async (
      messages: AsyncIterable<PersistedChatMessage>,
    ): Promise<string[]> => {
      const ids: string[] = [];
      for await (const message of messages) {
        if (!ids.length) {
          readerEntered();
          await heldReader;
        }
        ids.push(message.id);
      }
      return ids;
    };
    const preview: unknown = Reflect.get(
      repository,
      'consumeTranscriptPreview',
    );
    const reader: Promise<unknown> =
      typeof preview === 'function'
        ? Promise.resolve(
            Reflect.apply(preview, repository, [scope, 'chat', consume]),
          )
        : repository.consumeTranscript(scope, 'chat', false, consume);
    await entered;
    const writer = repository.transactWith(
      scope,
      () => {
        writerEntered();
        return [
          {
            type: 'tab.metadata_patched',
            tabId: 'chat',
            patch: { unread: true },
          },
        ];
      },
      { source: 'automation' },
    );
    let writerStartedWhileHeld = false;
    try {
      writerStartedWhileHeld =
        (await Promise.race([
          writerStarted.then(() => true),
          new Promise<boolean>((resolve) =>
            setTimeout(() => resolve(false), 300),
          ),
        ])) === true;
    } finally {
      releaseReader();
    }
    expect(await reader).toEqual(['user']);
    await writer;
    expect(writerStartedWhileHeld).toBe(true);
    await repository.drainAll();
  }, 30_000);

  previewIt(
    'projects one captured committed and active generation through atomic replacement',
    async () => {
      const repository = repositoryForTest(options());
      await repository.transact(
        scope,
        [
          {
            type: 'runtime.patched',
            chatId: 'chat',
            runtime: { status: 'streaming', queuedMessageIds: [] },
          },
          {
            type: 'message.upserted',
            chatId: 'chat',
            message: {
              id: 'active',
              role: 'assistant',
              timestamp: 2,
              blocks: [{ type: 'text', text: 'old active' }],
            },
          },
        ],
        { source: 'provider', chatIds: ['chat'] },
      );
      const descriptor = (await repository.getState(scope)).tabsFile.tabs[0]
        .transcript;
      expect(descriptor).toBeDefined();
      let release = (): void => undefined;
      let entered = (): void => undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const reader = consumePreview(repository, async (messages, captured) => {
        const rows: PersistedChatMessage[] = [];
        for await (const message of messages) {
          if (!rows.length) {
            entered();
            await held;
          }
          rows.push(message);
        }
        return { rows, captured };
      });
      await started;
      let writerSettledWhileHeld = false;
      let writer: Promise<unknown> | undefined;
      try {
        writer = repository.transact(
          scope,
          [
            {
              type: 'message.upserted',
              chatId: 'chat',
              message: {
                id: 'active',
                role: 'assistant',
                timestamp: 2,
                blocks: [{ type: 'text', text: 'new active' }],
              },
            },
          ],
          { source: 'provider', chatIds: ['chat'] },
        );
        writerSettledWhileHeld = await Promise.race([
          writer.then(() => true),
          new Promise<boolean>((resolve) =>
            setTimeout(() => resolve(false), 1000),
          ),
        ]);
      } finally {
        release();
      }
      await writer;
      const captured = await reader;
      expect(writerSettledWhileHeld).toBe(true);
      expect(captured.rows.map((message) => message.id)).toEqual([
        'user',
        'active',
      ]);
      expect(captured.rows[1].blocks).toEqual([
        { type: 'text', text: 'old active' },
      ]);
      expect(captured.captured).toEqual(descriptor);
      expect(
        (await repository.page(scope, 'chat')).messages.at(-1)?.blocks,
      ).toEqual([{ type: 'text', text: 'new active' }]);
      await repository.drainAll();
    },
    30_000,
  );

  previewIt(
    'rejects an in-place committed-prefix edit after capture',
    async () => {
      const repository = repositoryForTest(options());
      await repository.getState(scope);
      let release = (): void => undefined;
      let entered = (): void => undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const reader = consumePreview(repository, async (messages) => {
        let last: PersistedChatMessage | undefined;
        for await (const message of messages) {
          if (!last) {
            entered();
            await held;
          }
          last = message;
        }
        if (!last) throw new Error('Captured transcript was empty');
        return last;
      });
      await started;
      const committedPath = join(
        ChatStorageV2.fromLegacyPaths(paths).directory,
        'transcripts',
        'chat.jsonl',
      );
      const original = await readFile(committedPath, 'utf8');
      expect(original).toContain('preserved');
      try {
        await writeFile(
          committedPath,
          original.replace('preserved', 'different'),
        );
      } finally {
        release();
      }
      await expect(reader).rejects.toThrow(
        /changed|digest|integrity|mismatch/i,
      );
      await repository.drainAll();
    },
    30_000,
  );

  previewIt(
    'reads only the captured committed prefix when the log grows',
    async () => {
      const repository = repositoryForTest(options());
      const descriptor = (await repository.getState(scope)).tabsFile.tabs[0]
        .transcript;
      let release = (): void => undefined;
      let entered = (): void => undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const reader = consumePreview(repository, async (messages, captured) => {
        const ids: string[] = [];
        for await (const message of messages) {
          if (!ids.length) {
            entered();
            await held;
          }
          ids.push(message.id);
        }
        return { ids, captured };
      });
      await started;
      try {
        const transcript = new ChatTranscriptLog(
          join(ChatStorageV2.fromLegacyPaths(paths).directory, 'transcripts'),
        );
        await transcript.append('chat', [
          {
            id: 'later',
            role: 'assistant',
            timestamp: 2,
            blocks: [{ type: 'text', text: 'new committed row' }],
          },
        ]);
      } finally {
        release();
      }
      expect(await reader).toEqual({ ids: ['user'], captured: descriptor });
      await repository.drainAll();
    },
    30_000,
  );

  previewIt(
    'rejects an in-place active-sidecar edit after capture',
    async () => {
      const repository = repositoryForTest(options());
      await repository.transact(
        scope,
        [
          {
            type: 'runtime.patched',
            chatId: 'chat',
            runtime: { status: 'streaming', queuedMessageIds: [] },
          },
          {
            type: 'message.upserted',
            chatId: 'chat',
            message: {
              id: 'active',
              role: 'assistant',
              timestamp: 2,
              blocks: [{ type: 'text', text: 'old active' }],
            },
          },
        ],
        { source: 'provider', chatIds: ['chat'] },
      );
      // Materialize the active checkpoint whose captured identity this test edits.
      await repository.flushScope(scope);
      let release = (): void => undefined;
      let entered = (): void => undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const reader = consumePreview(repository, async (messages) => {
        const ids: string[] = [];
        for await (const message of messages) {
          if (!ids.length) {
            entered();
            await held;
          }
          ids.push(message.id);
        }
        return ids;
      });
      await started;
      const activePath = join(
        ChatStorageV2.fromLegacyPaths(paths).directory,
        'transcripts',
        'chat.active.json',
      );
      const original = await readFile(activePath, 'utf8');
      expect(original).toContain('old active');
      try {
        await writeFile(
          activePath,
          original.replace('old active', 'new active'),
        );
        // A same-length rewrite can land in the same filesystem timestamp tick
        // as the capture on fast CI hosts. Advance mtime explicitly so the
        // edit is visible to the stat signature on the held inode.
        const changedAt = new Date(Date.now() + 60_000);
        await utimes(activePath, changedAt, changedAt);
      } finally {
        release();
      }
      await expect(reader).rejects.toThrow(
        /changed|active|integrity|mismatch/i,
      );
      await repository.drainAll();
    },
    30_000,
  );

  previewIt(
    'lets deletion finish while its own preview consumer is suspended',
    async () => {
      const repository = repositoryForTest(options());
      await repository.getState(scope);
      let deletion: Promise<void> | undefined;
      let deletionSettledWhileConsumerWaited = false;
      const reader = consumePreview(repository, async (messages) => {
        for await (const message of messages) {
          expect(message.id).toBe('user');
          deletion = repository.runWithScopeDeletion(scope, async () => {
            await repository.transact(
              scope,
              [{ type: 'tab.removed', tabId: 'chat' }],
              { source: 'automation', allowDuringScopeDeletion: true },
            );
            await repository.deleteEmptyScope(scope);
          });
          deletionSettledWhileConsumerWaited = await Promise.race([
            deletion.then(() => true),
            new Promise<boolean>((resolve) =>
              setTimeout(() => resolve(false), 1500),
            ),
          ]);
          if (!deletionSettledWhileConsumerWaited)
            throw new Error('Deletion waited for the preview consumer');
        }
        return 'stale preview';
      });
      try {
        await expect(reader).rejects.toBeDefined();
        expect(deletionSettledWhileConsumerWaited).toBe(true);
        expect(repository.getLifecycle(scope)).toBe('disposed');
      } finally {
        await deletion?.catch(() => undefined);
        await repository.drainAll();
      }
    },
    30_000,
  );

  previewIt(
    'projects a legacy canonical descriptor without a committed digest',
    async () => {
      const first = repositoryForTest(options());
      await first.getState(scope);
      await first.drainAll();
      const livePath = join(
        ChatStorageV2.fromLegacyPaths(paths).directory,
        'live-index.json',
      );
      const live: unknown = JSON.parse(await readFile(livePath, 'utf8'));
      if (
        typeof live !== 'object' ||
        live === null ||
        !isUnknownArray(Reflect.get(live, 'tabs'))
      )
        throw new Error('Missing migrated live index');
      const tabs: unknown = Reflect.get(live, 'tabs');
      if (!isUnknownArray(tabs)) throw new Error('Missing migrated live tabs');
      const tab = tabs[0];
      const transcript: unknown =
        typeof tab === 'object' && tab !== null
          ? Reflect.get(tab, 'transcript')
          : undefined;
      if (typeof transcript !== 'object' || transcript === null)
        throw new Error('Missing migrated transcript descriptor');
      Reflect.deleteProperty(transcript, 'committedDigest');
      await writeFile(livePath, JSON.stringify(live));
      const reopened = repositoryForTest(options());
      const result = await consumePreview(
        reopened,
        async (messages, captured) => {
          const ids: string[] = [];
          for await (const message of messages) ids.push(message.id);
          return { ids, captured };
        },
      );
      expect(result.ids).toEqual(['user']);
      expect(result.captured.committedDigest).toMatch(/^[a-f0-9]{64}$/);
      await reopened.drainAll();
    },
    30_000,
  );

  previewIt(
    'streams only active rows when the consumer reuses the committed prefix',
    async () => {
      const repository = repositoryForTest(options());
      await repository.getState(scope);
      const collect = async (
        messages: AsyncIterable<PersistedChatMessage>,
      ): Promise<string[]> => {
        const ids: string[] = [];
        for await (const message of messages) ids.push(message.id);
        return ids;
      };

      const full = await repository.consumeTranscriptPreview(
        scope,
        'chat',
        async (messages, descriptor, read) => ({
          ids: await collect(messages),
          read,
          committedMessageCount: descriptor.committedMessageCount,
        }),
      );
      expect(full).toEqual({
        ids: [row.id],
        read: { committedIncluded: true },
        committedMessageCount: 1,
      });

      const offered: TranscriptDescriptor[] = [];
      const reused = await repository.consumeTranscriptPreview(
        scope,
        'chat',
        async (messages, _descriptor, read) => ({
          ids: await collect(messages),
          read,
        }),
        undefined,
        {
          reuseCommittedPrefix: (descriptor): boolean => {
            offered.push(descriptor);
            return true;
          },
        },
      );
      expect(reused).toEqual({ ids: [], read: { committedIncluded: false } });
      expect(
        offered.map((descriptor) => descriptor.committedMessageCount),
      ).toEqual([1]);
      await repository.drainAll();
    },
    30_000,
  );

  previewIt(
    'does not re-admit a deleted scope for a stale preview task',
    async () => {
      const repository = repositoryForTest(options());
      await repository.getState(scope);
      await repository.runWithScopeDeletion(scope, async () => {
        await repository.transact(
          scope,
          [{ type: 'tab.removed', tabId: 'chat' }],
          { source: 'automation', allowDuringScopeDeletion: true },
        );
        await repository.deleteEmptyScope(scope);
      });
      const preview: unknown = Reflect.get(
        repository,
        'consumeTranscriptPreview',
      );
      if (typeof preview !== 'function')
        throw new Error('Preview reader is unavailable');
      await expect(
        Promise.resolve(
          Reflect.apply(preview, repository, [
            scope,
            'chat',
            (): Promise<string> => Promise.resolve('stale'),
            (): boolean => false,
          ]),
        ),
      ).rejects.toThrow(/superseded|draining/);
      expect(repository.getLifecycle(scope)).toBe('disposed');
      await expect(
        readFile(ChatStorageV2.fromLegacyPaths(paths).manifestPath),
      ).rejects.toMatchObject({ code: 'ENOENT' });
      await repository.drainAll();
    },
    30_000,
  );

  previewIt(
    'retries a failed close when capture becomes stale before registration',
    async () => {
      const repository = repositoryForTest(options());
      const diagnostics: string[] = [];
      repository.subscribeStorageDiagnostics((diagnostic) => {
        diagnostics.push(diagnostic.kind);
      });
      await repository.getState(scope);
      const originalCapture: unknown = Reflect.get(
        ChatTranscriptLog.prototype,
        'capturePreview',
      );
      if (typeof originalCapture !== 'function')
        throw new Error('Missing transcript preview capture method');
      let current = true;
      let closeAttempts = 0;
      let captured:
        | Awaited<ReturnType<ChatTranscriptLog['capturePreview']>>
        | undefined;
      jest
        .spyOn(ChatTranscriptLog.prototype, 'capturePreview')
        .mockImplementation(async function (
          this: ChatTranscriptLog,
          chatId,
          canonical,
        ) {
          const preview: unknown = await Reflect.apply(originalCapture, this, [
            chatId,
            canonical,
          ]);
          if (!(preview instanceof CapturedTranscriptPreview))
            throw new Error('Expected captured transcript preview');
          captured = preview;
          const actualClose = preview.close.bind(preview);
          preview.close = async (): Promise<void> => {
            closeAttempts += 1;
            if (closeAttempts === 1)
              throw new Error('injected preview close EIO');
            await actualClose();
          };
          current = false;
          return preview;
        });
      try {
        await expect(
          repository.consumeTranscriptPreview(
            scope,
            'chat',
            (): Promise<string> => Promise.resolve('stale'),
            () => current,
          ),
        ).rejects.toThrow('injected preview close EIO');
        expect(closeAttempts).toBe(1);
        expect(diagnostics).toEqual([
          'delta_journal_promoted',
          'transcript_preview_close_failed',
        ]);
        await repository.drainAll();
        expect(closeAttempts).toBe(2);
        expect(repository.getLifecycle(scope)).toBe('disposed');
        expect(diagnostics).toEqual([
          'delta_journal_promoted',
          'transcript_preview_close_failed',
        ]);
      } finally {
        await captured?.close();
      }
    },
    30_000,
  );

  previewIt(
    'retries a failed preview close on a second repository drain',
    async () => {
      const repository = repositoryForTest(options());
      await repository.getState(scope);
      const originalCapture: unknown = Reflect.get(
        ChatTranscriptLog.prototype,
        'capturePreview',
      );
      if (typeof originalCapture !== 'function')
        throw new Error('Missing transcript preview capture method');
      let closeAttempts = 0;
      let captured:
        | Awaited<ReturnType<ChatTranscriptLog['capturePreview']>>
        | undefined;
      jest
        .spyOn(ChatTranscriptLog.prototype, 'capturePreview')
        .mockImplementation(async function (
          this: ChatTranscriptLog,
          chatId,
          canonical,
        ) {
          const preview: unknown = await Reflect.apply(originalCapture, this, [
            chatId,
            canonical,
          ]);
          if (!(preview instanceof CapturedTranscriptPreview))
            throw new Error('Expected captured transcript preview');
          captured = preview;
          const actualClose = preview.close.bind(preview);
          preview.close = async (): Promise<void> => {
            closeAttempts += 1;
            if (closeAttempts === 1)
              throw new Error('injected preview close EIO');
            await actualClose();
          };
          return preview;
        });
      let enter = (): void => undefined;
      let release = (): void => undefined;
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const reader = consumePreview(repository, async (messages) => {
        for await (const message of messages) {
          enter();
          await held;
          return message.id;
        }
        return 'empty';
      });
      try {
        await entered;
        await expect(repository.drainAll()).rejects.toThrow(
          'Chat scope drain failed',
        );
        expect(closeAttempts).toBe(1);
        await repository.drainAll();
        expect(closeAttempts).toBe(2);
        expect(repository.getLifecycle(scope)).toBe('disposed');
      } finally {
        release();
        await reader.catch(() => undefined);
        await captured?.close();
      }
    },
    30_000,
  );

  previewIt(
    'does not let a consumer mutate its validation descriptor',
    async () => {
      const repository = repositoryForTest(options());
      await repository.getState(scope);
      const ids = await consumePreview(
        repository,
        async (messages, descriptor) => {
          descriptor.committedDigest = '0'.repeat(64);
          descriptor.committedMessageCount = 999;
          const result: string[] = [];
          for await (const message of messages) result.push(message.id);
          return result;
        },
      );
      expect(ids).toEqual(['user']);
      await repository.drainAll();
    },
  );

  it('drains automatic bounded artifact maintenance after settling and reloads the retained output', async () => {
    const repository = repositoryForTest(options());
    const oldOutput = 'obsolete repository output\n'.repeat(9000);
    const finalOutput = 'retained repository output\n'.repeat(9000);
    const artifactName = (output: string): string =>
      `sha256-v1-${createHash('sha256').update(output).digest('hex')}.txt`;
    const toolMessage = (output: string): PersistedChatMessage => ({
      ...row,
      id: 'tool',
      role: 'assistant',
      blocks: [
        {
          type: 'tool_result',
          toolUseId: 'call',
          toolName: 'Read',
          output,
          isError: false,
        },
      ],
    });
    const directory = join(
      ChatStorageV2.fromLegacyPaths(paths).directory,
      'transcripts',
      'tool-output',
      'chat',
    );
    await repository.transact(
      scope,
      [
        {
          type: 'runtime.patched',
          chatId: 'chat',
          runtime: { status: 'streaming', queuedMessageIds: [] },
        },
        {
          type: 'message.upserted',
          chatId: 'chat',
          message: toolMessage(oldOutput),
        },
      ],
      { source: 'provider' },
    );
    await repository.transact(
      scope,
      [
        {
          type: 'message.upserted',
          chatId: 'chat',
          message: toolMessage(finalOutput),
        },
      ],
      { source: 'provider' },
    );
    expect((await readdir(directory)).sort()).toEqual(
      [artifactName(oldOutput), artifactName(finalOutput)].sort(),
    );
    await repository.transact(
      scope,
      [
        {
          type: 'runtime.patched',
          chatId: 'chat',
          runtime: { status: 'completed', queuedMessageIds: [] },
        },
      ],
      { source: 'provider' },
    );
    for (let attempt = 0; attempt < 200; attempt++) {
      if ((await readdir(directory)).length === 1) break;
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    expect(await readdir(directory)).toEqual([artifactName(finalOutput)]);
    await repository.drainAll();

    const reopened = repositoryForTest(options());
    const full = await reopened.consumeTranscript(
      scope,
      'chat',
      true,
      async (messages) => {
        let last: PersistedChatMessage | undefined;
        for await (const message of messages) last = message;
        return last;
      },
    );
    expect(full?.blocks[0]).toEqual(toolMessage(finalOutput).blocks[0]);
  }, 30_000);

  it('does not spin on a persistent maintenance error and cancels idle work on drain', async () => {
    const maintenance = jest
      .spyOn(ChatStateV2Backend.prototype, 'maintainArtifacts')
      .mockRejectedValue(new Error('persistent EIO'));
    const repository = repositoryForTest(options());
    await repository.getState(scope);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(maintenance).toHaveBeenCalledTimes(1);
    expect(repository.getArtifactMaintenanceStatus(scope).failure).toContain(
      'persistent EIO',
    );
    await repository.drainAll();
    const callsAfterDrain = maintenance.mock.calls.length;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(maintenance).toHaveBeenCalledTimes(callsAfterDrain);
    expect(callsAfterDrain).toBeLessThanOrEqual(2);
  });

  it('clears deferred cleanup bookkeeping when its chat is deleted', async () => {
    jest
      .spyOn(ChatStateV2Backend.prototype, 'maintainArtifacts')
      .mockRejectedValue(new Error('persistent EIO'));
    const repository = repositoryForTest(options());
    await repository.getState(scope);
    for (
      let attempt = 0;
      attempt < 100 &&
      repository.getArtifactMaintenanceStatus(scope).deferredChats === 0;
      attempt++
    )
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(repository.getArtifactMaintenanceStatus(scope).deferredChats).toBe(
      1,
    );
    expect(repository.getArtifactMaintenanceStatus(scope).failure).toContain(
      'persistent EIO',
    );
    await repository.transact(scope, [{ type: 'tab.removed', tabId: 'chat' }], {
      source: 'automation',
    });
    expect(repository.getArtifactMaintenanceStatus(scope).deferredChats).toBe(
      0,
    );
    expect(
      repository.getArtifactMaintenanceStatus(scope).failure,
    ).toBeUndefined();
    await repository.drainAll();
  }, 30_000);

  it('clears deferred cleanup when a scope import retires the chat', async () => {
    await writeFile(
      paths.tabs,
      JSON.stringify({
        version: 1,
        activeTabId: 'chat',
        tabs: [
          { id: 'chat', title: 'Chat', createdAt: '2026-09-05', messages: [] },
        ],
      }),
    );
    jest
      .spyOn(ChatStateV2Backend.prototype, 'maintainArtifacts')
      .mockRejectedValue(new Error('persistent EIO'));
    const repository = repositoryForTest(options());
    const state = await repository.getState(scope);
    for (
      let attempt = 0;
      attempt < 100 &&
      repository.getArtifactMaintenanceStatus(scope).deferredChats === 0;
      attempt++
    )
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(repository.getArtifactMaintenanceStatus(scope).deferredChats).toBe(
      1,
    );
    const empty = new ChatStorageV2(join(root, 'empty'), 'captured');
    await empty.migrate(() =>
      Promise.resolve({
        revision: 0,
        index: { activeTabId: '', runtimeByChatId: {} },
        recovery: {
          receipts: [],
          mutationIds: [],
          removedTabIds: [],
          removedArchiveEntryIds: [],
          removedMessageIds: [],
        },
        chats: asAsync([]),
      }),
    );
    await repository.importScope(scope, empty, {
      tabsFile: { ...state.tabsFile, activeTabId: '', tabs: [] },
      archivesFile: { ...state.archivesFile, archived: [] },
    });
    expect(repository.getArtifactMaintenanceStatus(scope).deferredChats).toBe(
      0,
    );
    expect(
      repository.getArtifactMaintenanceStatus(scope).failure,
    ).toBeUndefined();
    await repository.drainAll();
  }, 30_000);

  it('abandons an ineligible maintenance job so its reserved slot is released', async () => {
    const eligible = jest
      .spyOn(ChatStateV2Backend.prototype, 'artifactMaintenanceEligible')
      .mockReturnValue(false);
    const abandon = jest.spyOn(
      ChatStateV2Backend.prototype,
      'abandonArtifactMaintenance',
    );
    const repository = repositoryForTest(options());
    await repository.getState(scope);
    for (
      let attempt = 0;
      attempt < 100 && !abandon.mock.calls.length;
      attempt++
    )
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(eligible).toHaveBeenCalledWith('chat');
    expect(abandon).toHaveBeenCalledWith('chat');
    await repository.drainAll();
  }, 30_000);

  it('rearms capacity-only maintenance after a scope deletion fence', async () => {
    const listeners: Array<() => void> = [];
    const disposers: Array<jest.Mock<void, []>> = [];
    jest
      .spyOn(
        ChatStateV2Backend.prototype,
        'onArtifactMaintenanceCapacityAvailable',
      )
      .mockImplementation((listener) => {
        listeners.push(listener);
        const dispose = jest.fn<void, []>();
        disposers.push(dispose);
        return dispose;
      });
    const maintenance = jest
      .spyOn(ChatStateV2Backend.prototype, 'maintainArtifacts')
      .mockRejectedValueOnce(
        new ArtifactMaintenanceCapacityError('busy maintenance slots'),
      )
      .mockResolvedValue({ complete: true, scannedBytes: 0, removed: 0 });
    const repository = repositoryForTest(options());
    await repository.getState(scope);
    for (let attempt = 0; attempt < 100 && !listeners.length; attempt++)
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(listeners).toHaveLength(1);
    await repository.runWithScopeDeletion(scope, () => {
      expect(disposers[0]).toHaveBeenCalledTimes(1);
      return Promise.resolve();
    });
    expect(listeners).toHaveLength(2);
    listeners[1]();
    for (
      let attempt = 0;
      attempt < 100 && maintenance.mock.calls.length < 2;
      attempt++
    )
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(maintenance).toHaveBeenCalledTimes(2);
    expect(repository.getArtifactMaintenanceStatus(scope).deferredChats).toBe(
      0,
    );
    await repository.drainAll();
  }, 30_000);

  it('continues a healthy chat after another chat maintenance fails', async () => {
    const repository = repositoryForTest(options());
    const initial = await repository.getState(scope);
    await repository.transact(
      scope,
      [
        {
          type: 'tab.created',
          tab: {
            ...initial.tabsFile.tabs[0],
            id: 'healthy',
            title: 'Healthy',
            messages: [],
          },
        },
      ],
      { source: 'automation' },
    );
    const toolMessage = (id: string, output: string): PersistedChatMessage => ({
      ...row,
      id: `tool-${id}`,
      role: 'assistant',
      blocks: [
        {
          type: 'tool_result',
          toolUseId: `call-${id}`,
          toolName: 'Read',
          output,
          isError: false,
        },
      ],
    });
    const old = 'old output\n'.repeat(9000);
    const final = 'final output\n'.repeat(9000);
    for (const chatId of ['chat', 'healthy']) {
      await repository.transact(
        scope,
        [
          {
            type: 'runtime.patched',
            chatId,
            runtime: { status: 'streaming', queuedMessageIds: [] },
          },
          {
            type: 'message.upserted',
            chatId,
            message: toolMessage(chatId, old),
          },
        ],
        { source: 'provider' },
      );
      await repository.transact(
        scope,
        [
          {
            type: 'message.upserted',
            chatId,
            message: toolMessage(chatId, final),
          },
        ],
        { source: 'provider' },
      );
    }
    const transcript = new ChatTranscriptLog(
      join(ChatStorageV2.fromLegacyPaths(paths).directory, 'transcripts'),
    );
    const original = transcript.artifactReferenceSlice.bind(transcript);
    jest
      .spyOn(ChatTranscriptLog.prototype, 'artifactReferenceSlice')
      .mockImplementation(function (
        this: ChatTranscriptLog,
        chatId: string,
        offset: number,
        maxBytes: number,
        expected?: TranscriptDescriptor,
      ) {
        if (chatId === 'chat')
          return Promise.reject(new Error('persistent EIO'));
        return original(chatId, offset, maxBytes, expected);
      });
    const maintenance = jest.spyOn(
      ChatStateV2Backend.prototype,
      'maintainArtifacts',
    );
    await repository.transact(
      scope,
      ['chat', 'healthy'].map((chatId) => ({
        type: 'runtime.patched' as const,
        chatId,
        runtime: { status: 'completed' as const, queuedMessageIds: [] },
      })),
      { source: 'provider' },
    );
    const healthyDirectory = join(
      ChatStorageV2.fromLegacyPaths(paths).directory,
      'transcripts',
      'tool-output',
      'healthy',
    );
    for (let attempt = 0; attempt < 200; attempt++) {
      if ((await readdir(healthyDirectory)).length === 1) break;
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    expect(await readdir(healthyDirectory)).toHaveLength(1);
    expect(
      maintenance.mock.calls.filter(([chatId]) => chatId === 'chat'),
    ).toHaveLength(1);
    expect(repository.getArtifactMaintenanceStatus(scope).deferredChats).toBe(
      1,
    );
    expect(repository.getArtifactMaintenanceStatus(scope).failure).toContain(
      'persistent EIO',
    );
    expect(repository.getStorageDiagnostics(scope)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'artifact_maintenance_failed' }),
      ]),
    );
    await repository.drainAll();
  }, 30_000);

  it('flushes canonical storage even when a maintenance directory cannot close', async () => {
    const repository = repositoryForTest(options());
    await repository.getState(scope);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    const toolMessage = (output: string): PersistedChatMessage => ({
      ...row,
      id: 'tool-result',
      role: 'assistant',
      blocks: [
        {
          type: 'tool_result',
          toolUseId: 'call',
          toolName: 'Read',
          output,
          isError: false,
        },
      ],
    });
    await repository.transact(
      scope,
      [
        {
          type: 'runtime.patched',
          chatId: 'chat',
          runtime: { status: 'streaming', queuedMessageIds: [] },
        },
        {
          type: 'message.upserted',
          chatId: 'chat',
          message: toolMessage('old output\n'.repeat(9000)),
        },
      ],
      { source: 'provider' },
    );
    await repository.transact(
      scope,
      [
        {
          type: 'message.upserted',
          chatId: 'chat',
          message: toolMessage('new output\n'.repeat(9000)),
        },
      ],
      { source: 'provider' },
    );
    const currentStore = ChatStorageV2.fromLegacyPaths(paths);
    const probe = new ChatArtifactMaintenance(
      new ChatStorageTransactions(currentStore),
      currentStore.directory,
    );
    try {
      expect(await probe.hasWork('chat')).toBe(true);
    } finally {
      await probe.dispose();
    }
    // Warmed direct candidates need no new directory walk. Evict derived
    // state so this fault fixture exercises cold discovery and close.
    await repository.runWithScopeDeletion(scope, () => Promise.resolve());
    const originalOpen: unknown = Reflect.get(
      ChatTranscriptArtifacts.prototype,
      'openCandidateDirectory',
    );
    if (typeof originalOpen !== 'function')
      throw new Error('Missing artifact candidate directory opener');
    const restoreCloses: Array<() => void> = [];
    const opened = jest
      .spyOn(ChatTranscriptArtifacts.prototype, 'openCandidateDirectory')
      .mockImplementation(async function (
        this: ChatTranscriptArtifacts,
        ...args: Parameters<ChatTranscriptArtifacts['openCandidateDirectory']>
      ) {
        const directory: unknown = await Reflect.apply(
          originalOpen,
          this,
          args,
        );
        if (directory !== undefined && !(directory instanceof Dir))
          throw new Error('Expected opened artifact directory');
        if (directory) {
          const closeHandle = directory.close.bind(directory);
          restoreCloses.push(() => {
            directory.close = closeHandle;
          });
          directory.close = (): Promise<void> =>
            Promise.reject(new Error('directory close EIO'));
        }
        return directory;
      });
    const flush = jest.spyOn(ChatStateV2Backend.prototype, 'flush');
    try {
      const settled = await repository.transact(
        scope,
        [
          {
            type: 'runtime.patched',
            chatId: 'chat',
            runtime: { status: 'completed', queuedMessageIds: [] },
          },
        ],
        { source: 'provider' },
      );
      expect(settled.applied).toBe(true);
      expect(
        (await repository.getState(scope)).runtimeByChatId.chat.status,
      ).toBe('completed');
      const admissionDeadline = Date.now() + 15_000;
      while (opened.mock.calls.length === 0 && Date.now() < admissionDeadline) {
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
      expect(opened).toHaveBeenCalledWith('chat', 'tool-output');
      const failureDeadline = Date.now() + 5_000;
      while (
        !repository.getArtifactMaintenanceStatus(scope).failure &&
        Date.now() < failureDeadline
      ) {
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
      expect(restoreCloses).toHaveLength(1);
      expect(repository.getArtifactMaintenanceStatus(scope).failure).toContain(
        'directory close EIO',
      );
      await expect(repository.drainAll()).rejects.toThrow(
        'Chat scope drain failed',
      );
      expect(flush).toHaveBeenCalled();
      expect(repository.getLifecycle(scope)).toBe('draining');
      for (const restoreClose of restoreCloses) restoreClose();
      await repository.drainAll();
      expect(repository.getLifecycle(scope)).toBe('disposed');
    } finally {
      opened.mockRestore();
      for (const restoreClose of restoreCloses) restoreClose();
      const store = ChatStorageV2.fromLegacyPaths(paths);
      await new ChatArtifactMaintenance(
        new ChatStorageTransactions(store),
        store.directory,
      ).dispose();
    }
  }, 30_000);

  it('removes an active journal message without rewriting committed history', async () => {
    const repository = repositoryForTest(options());
    await repository.getState(scope);
    await repository.transact(
      scope,
      [
        {
          type: 'runtime.patched',
          chatId: 'chat',
          runtime: { status: 'streaming', queuedMessageIds: [] },
        },
        {
          type: 'message.upserted',
          chatId: 'chat',
          message: {
            ...row,
            id: 'active-assistant',
            role: 'assistant',
            blocks: [{ type: 'text', text: 'in progress' }],
          },
        },
      ],
      { source: 'provider' },
    );
    const transcript = new ChatTranscriptLog(
      join(ChatStorageV2.fromLegacyPaths(paths).directory, 'transcripts'),
    );
    expect(await transcript.activeMessages('chat')).toEqual([]);
    expect((await repository.page(scope, 'chat')).messages).toEqual([
      row,
      expect.objectContaining({ id: 'active-assistant' }),
    ]);
    const iterateSpy = jest.spyOn(ChatTranscriptLog.prototype, 'iterate');

    await repository.transact(
      scope,
      [
        {
          type: 'message.removed',
          chatId: 'chat',
          messageId: 'active-assistant',
        },
      ],
      { source: 'provider' },
    );

    expect(iterateSpy).not.toHaveBeenCalled();
    expect((await repository.page(scope, 'chat')).messages).toEqual([row]);
  });
});

describe('v2 scope repository legacy path resolution', () => {
  let root: string;
  let repository: ChatStateV2Repository | undefined;
  const originalDataDir = process.env.CANOPY_DATA_DIR;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'chat-v2-repository-sentinel-'));
    process.env.CANOPY_DATA_DIR = root;
    resetResolvedCanopyDataDirForTests();
  });
  afterEach(async () => {
    try {
      await repository?.drainAll();
    } finally {
      if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
      else process.env.CANOPY_DATA_DIR = originalDataDir;
      resetResolvedCanopyDataDirForTests();
      await drainOpenRepositories();
      await rm(root, { recursive: true, force: true });
      repository = undefined;
    }
  });

  it('migrates the cowork home archives when the standalone sentinel admits the scope first', async () => {
    const workspaceDir = join(root, 'workspaces', 'cowork-1');
    await mkdir(join(workspaceDir, 'chats'), { recursive: true });
    await mkdir(join(workspaceDir, 'chat-archives'), { recursive: true });
    await writeFile(
      join(workspaceDir, 'chats', 'home.json'),
      JSON.stringify({
        version: 1,
        activeTabId: 'chat',
        tabs: [
          {
            id: 'chat',
            title: 'Chat',
            createdAt: '2026-09-05',
            messages: [row],
          },
        ],
      }),
    );
    await writeFile(
      join(workspaceDir, 'chat-archives', 'home.json'),
      JSON.stringify({
        version: 1,
        archived: [
          {
            tab: {
              id: 'archived',
              title: 'Archived',
              createdAt: '2026-09-04',
              messages: [{ ...row, id: 'archived-user' }],
            },
            archivedAt: '2026-09-05T00:00:00.000Z',
            turnCount: 1,
          },
        ],
      }),
    );

    repository = repositoryForTest();
    const sentinelState = await repository.getState({
      projectId: STANDALONE_CHAT_PROJECT_ID,
      worktreeId: 'cowork-1',
    });
    expect(
      sentinelState.archivesFile.archived.map((entry) => entry.tab.id),
    ).toEqual(['archived']);
    expect(sentinelState.tabsFile.tabs.map((tab) => tab.id)).toEqual(['chat']);
    // The real cowork key is an alias of the same scope and sees the same
    // migrated archive index.
    expect(
      (
        await repository.getState({
          projectId: 'cowork-1',
          worktreeId: 'home',
        })
      ).archivesFile.archived.map((entry) => entry.tab.id),
    ).toEqual(['archived']);
    await expect(
      readFile(join(workspaceDir, 'chat-archives', 'home.json')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('format-4 registry receipt repository facade', () => {
  it('serializes concurrent receipt conflicts, preserves replay without a journal and rejects disposed writes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'repository-receipt-facade-'));
    const fixture = await createRepositoryTranscriptPortFixture(root)();
    const entry: Parameters<
      ChatStateV2Repository['appendDelegationReceipt']
    >[1] = {
      version: 1,
      kind: 'receipt',
      chatId: 'chat',
      receiptKind: 'stop',
      key: 'a'.repeat(64),
      delegationId: 'child',
      runGeneration: 1,
      operationId: 'abcdef12-3456-7890-abcd-1234567890ab',
      requestHash: 'b'.repeat(64),
      operation: 'stop',
      admittedAt: 1,
      reply: { kind: 'stop', ackStatus: 'completed', runGeneration: 1 },
    };
    try {
      const attempts = await Promise.allSettled([
        fixture.repository.appendDelegationReceipt(fixture.scope, entry),
        fixture.repository.appendDelegationReceipt(fixture.scope, {
          ...entry,
          admittedAt: 2,
        }),
      ]);
      expect(attempts[0]).toEqual({
        status: 'fulfilled',
        value: { entry, replayed: false },
      });
      expect(attempts[1]).toMatchObject({
        status: 'rejected',
        reason: { failure: { code: 'conflict' } },
      });
      await fixture.noJournal();
      expect(await fixture.service.receipt(fixture.scope, entry)).toEqual(
        entry,
      );
      expect(
        await fixture.service.appendDelegationReceipt(fixture.scope, entry),
      ).toEqual({ entry, replayed: true });
      expect(await fixture.store.journalFile()).toBeUndefined();
      const disposed = fixture.repository;
      await fixture.close();
      await expect(
        disposed.appendDelegationReceipt(fixture.scope, entry),
      ).rejects.toThrow();
    } finally {
      await fixture.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('chat visual staging repository lifecycle', () => {
  const visualScope = { projectId: 'workspace', worktreeId: 'scope' };
  const baseTime = 1_800_000_000_000;
  const visualId = 'vis_123e4567-e89b-12d3-a456-426614174000';
  const secondVisualId = 'vis_123e4567-e89b-12d3-a456-426614174001';
  let root: string;
  let originalDataDir: string | undefined;
  let paths: { tabs: string; archives: string; journal: string };
  let now: number;
  let repositories: ChatStateV2Repository[];

  function documentFor(id: string = visualId): StageVisualDocument {
    return {
      visualId: id,
      html: `<!doctype html><html><body>${id}</body></html>`,
      title: 'Staged visual',
      maxHeight: 400,
    };
  }

  async function seedLegacyScope(): Promise<void> {
    await mkdir(dirname(paths.tabs), { recursive: true });
    await writeFile(
      paths.tabs,
      JSON.stringify({
        version: 1,
        activeTabId: 'chat',
        tabs: [
          {
            id: 'chat',
            title: 'Chat',
            createdAt: '2026-09-05',
            messages: [row],
          },
        ],
      }),
    );
  }

  function createRepository(
    extra: Partial<ChatStateV2RepositoryOptions> = {},
  ): ChatStateV2Repository {
    const repository = new ChatStateV2Repository({
      resolvePaths: (): typeof paths => paths,
      now: (): number => now,
      ...extra,
    });
    repositories.push(repository);
    return repository;
  }

  async function stageAt(
    directory: string,
    chatId: string,
    document: StageVisualDocument,
  ): Promise<VisualStagingStoreImpl> {
    const staging = new VisualStagingStoreImpl(directory, {
      now: (): number => now,
    });
    await staging.initialize(now);
    await withChatVisualStagingScopesMarker(
      () => staging.stage({ chatId }, document, now),
      root,
    );
    return staging;
  }

  async function runVisualSweep(
    repository: ChatStateV2Repository,
  ): Promise<void> {
    const pass: unknown = Reflect.get(repository, 'sweepVisualStagingScopes');
    if (typeof pass !== 'function')
      throw new Error('Visual staging sweep is unavailable');
    await Promise.resolve(Reflect.apply(pass, repository, []));
  }

  function promotedVisual(document: StageVisualDocument): PromotedVisual {
    const digest = '0'.repeat(64);
    return {
      chatId: 'chat',
      visualId: document.visualId,
      reference: {
        version: 1,
        visualId: document.visualId,
        artifactId: `sha256-v1-${digest}`,
        byteLength: 1,
        sha256: digest,
        mediaType: 'text/html',
        title: document.title,
        maxHeight: document.maxHeight,
      },
    };
  }

  function isBackendAdmissionImplementation(
    value: unknown,
  ): value is ChatStateV2Backend['admit'] {
    return typeof value === 'function';
  }

  function isVisualStageImplementation(
    value: unknown,
  ): value is VisualStagingStoreImpl['stage'] {
    return typeof value === 'function';
  }

  function isVisualRemoveImplementation(
    value: unknown,
  ): value is VisualStagingStoreImpl['remove'] {
    return typeof value === 'function';
  }

  function isVisualRemoveChatImplementation(
    value: unknown,
  ): value is VisualStagingStoreImpl['removeChat'] {
    return typeof value === 'function';
  }

  function visualStageImplementation(): VisualStagingStoreImpl['stage'] {
    const method: unknown = Reflect.get(
      VisualStagingStoreImpl.prototype,
      'stage',
    );
    if (!isVisualStageImplementation(method))
      throw new Error('Visual staging method is unavailable');
    return method;
  }

  function visualRemoveImplementation(): VisualStagingStoreImpl['remove'] {
    const method: unknown = Reflect.get(
      VisualStagingStoreImpl.prototype,
      'remove',
    );
    if (!isVisualRemoveImplementation(method))
      throw new Error('Visual removal method is unavailable');
    return method;
  }

  function visualRemoveChatImplementation(): VisualStagingStoreImpl['removeChat'] {
    const method: unknown = Reflect.get(
      VisualStagingStoreImpl.prototype,
      'removeChat',
    );
    if (!isVisualRemoveChatImplementation(method))
      throw new Error('Visual chat removal method is unavailable');
    return method;
  }

  function forcePromotedVisual(document: StageVisualDocument): void {
    const admit = jest.spyOn(ChatStateV2Backend.prototype, 'admit');
    const candidate: unknown = admit.getMockImplementation();
    if (!isBackendAdmissionImplementation(candidate))
      throw new Error('Backend admission implementation is unavailable');
    const originalAdmit = candidate;
    let remaining = 1;
    admit.mockImplementation(async function (
      this: ChatStateV2Backend,
      build: Parameters<ChatStateV2Backend['admit']>[0],
      options: Parameters<ChatStateV2Backend['admit']>[1],
      admission: ProviderVisualAdmission | undefined,
    ) {
      const result = await originalAdmit.call(this, build, options, admission);
      if (!result.commit.applied || remaining === 0) return result;
      remaining -= 1;
      return {
        ...result,
        commit: {
          ...result.commit,
          promotedVisuals: [promotedVisual(document)],
        },
      };
    });
  }

  beforeEach(async () => {
    originalDataDir = process.env.CANOPY_DATA_DIR;
    root = await mkdtemp(join(tmpdir(), 'chat-visual-repository-'));
    process.env.CANOPY_DATA_DIR = root;
    resetResolvedCanopyDataDirForTests();
    resetChatVisualStagingScopesMarkerForTests();
    now = baseTime;
    repositories = [];
    paths = {
      tabs: join(root, 'chats', 'scope.json'),
      archives: join(root, 'chat-archives', 'scope.json'),
      journal: join(root, 'chat-journals', 'scope.jsonl'),
    };
    await seedLegacyScope();
  });

  afterEach(async () => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    await Promise.allSettled(
      repositories.map((repository) => repository.drainAll()),
    );
    if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
    else process.env.CANOPY_DATA_DIR = originalDataDir;
    resetResolvedCanopyDataDirForTests();
    resetChatVisualStagingScopesMarkerForTests();
    await rm(root, { recursive: true, force: true });
  });

  it('writes the marker before staging and serializes staging with commits', async () => {
    const repository = createRepository();
    let stageEntered: () => void = () => undefined;
    let releaseStage: () => void = () => undefined;
    const enteredStage = new Promise<void>((resolve) => {
      stageEntered = resolve;
    });
    const stageGate = new Promise<void>((resolve) => {
      releaseStage = resolve;
    });
    const originalStage = visualStageImplementation();
    let mutationSettled = false;
    const markerPath = chatVisualStagingScopesMarkerPath(root);
    jest
      .spyOn(VisualStagingStoreImpl.prototype, 'stage')
      .mockImplementation(async function (
        this: VisualStagingStoreImpl,
        target: Parameters<VisualStagingStoreImpl['stage']>[0],
        document: Parameters<VisualStagingStoreImpl['stage']>[1],
        stageTime: Parameters<VisualStagingStoreImpl['stage']>[2],
      ) {
        expect(await readFile(markerPath, 'utf8')).toContain('"version":1');
        stageEntered();
        await stageGate;
        return originalStage.call(this, target, document, stageTime);
      });
    await repository.getState(visualScope);
    const staging = repository.stageVisual(
      visualScope,
      { chatId: 'chat' },
      documentFor(),
    );
    try {
      await enteredStage;
      const mutation = repository
        .transact(
          visualScope,
          [
            {
              type: 'tab.metadata_patched',
              tabId: 'chat',
              patch: { unread: true },
            },
          ],
          { source: 'automation' },
        )
        .then(() => {
          mutationSettled = true;
        });
      await Promise.resolve();
      expect(mutationSettled).toBe(false);
      releaseStage();
      await staging;
      await mutation;
      expect(mutationSettled).toBe(true);
    } finally {
      releaseStage();
    }
  });

  it('rejects unknown chats and visual ids already held by the owner ledger', async () => {
    const repository = createRepository();
    await repository.getState(visualScope);
    await expect(
      repository.stageVisual(visualScope, { chatId: 'missing' }, documentFor()),
    ).rejects.toThrow('Unknown chat');
    expect(await repository.evictScope(visualScope)).toBe(true);
    const storage = ChatStorageV2.fromLegacyPaths(paths);
    await writeFile(
      join(storage.directory, 'recovery-index.json'),
      JSON.stringify({
        version: 2,
        receipts: [],
        mutationIds: [],
        removedTabIds: [],
        removedArchiveEntryIds: [],
        removedMessageIds: [],
        visualOwnersByChatId: {
          chat: {
            [visualId]: {
              messageId: 'owner-message',
              toolUseId: 'owner-call',
              claimedAt: baseTime,
            },
          },
        },
      }),
    );
    await expect(
      repository.stageVisual(visualScope, { chatId: 'chat' }, documentFor()),
    ).rejects.toThrow('already owned');
  });

  it('initializes staging before a provider admission reads a staged entry', async () => {
    const repository = createRepository();
    await repository.getState(visualScope);
    const document = documentFor();
    await repository.stageVisual(visualScope, { chatId: 'chat' }, document);
    const admit = jest.spyOn(ChatStateV2Backend.prototype, 'admit');
    const candidate: unknown = admit.getMockImplementation();
    if (!isBackendAdmissionImplementation(candidate))
      throw new Error('Backend admission implementation is unavailable');
    const originalAdmit = candidate;
    let observedHtml: string | undefined;
    admit.mockImplementation(async function (
      this: ChatStateV2Backend,
      build: Parameters<ChatStateV2Backend['admit']>[0],
      options: Parameters<ChatStateV2Backend['admit']>[1],
      admission: ProviderVisualAdmission | undefined,
    ) {
      if (admission)
        observedHtml = (
          await admission.staging.readCandidate('chat', document.visualId)
        )?.html;
      return originalAdmit.call(this, build, options, admission);
    });
    await repository.transactProviderEventWith(
      visualScope,
      () => [
        {
          type: 'tab.metadata_patched',
          tabId: 'chat',
          patch: { unread: true },
        },
      ],
      { source: 'provider' },
      { resolveToolKey: () => undefined },
    );
    expect(observedHtml).toBe(document.html);
  });

  it('keeps nonvisual transactions equivalent and only passes provider admission on the trusted method', async () => {
    const publicationOrder: number[] = [];
    const repository = createRepository({
      onCommit: (commit): void => {
        publicationOrder.push(commit.revision);
      },
    });
    await repository.getState(visualScope);
    const admit = jest.spyOn(ChatStateV2Backend.prototype, 'admit');
    const build = (): ChatCoreMutation[] => [
      {
        type: 'tab.metadata_patched',
        tabId: 'chat',
        patch: { unread: true },
      },
    ];
    const regular = await repository.transactWith(visualScope, build, {
      source: 'provider',
    });
    const provider = await repository.transactProviderEventWith(
      visualScope,
      build,
      { source: 'provider' },
      { resolveToolKey: () => undefined },
    );
    expect([regular.revision, provider.revision]).toEqual([1, 2]);
    expect(publicationOrder).toEqual([1, 2]);
    expect(admit.mock.calls[0]?.[2]).toBeUndefined();
    expect(admit.mock.calls[1]?.[2]?.resolveToolKey).toBeDefined();
  });

  it('cleans promoted staging only after publication without delaying queued acknowledgements', async () => {
    const publishedRevisions: number[] = [];
    const repository = createRepository({
      onCommit: (commit): void => {
        publishedRevisions.push(commit.revision);
      },
    });
    await repository.getState(visualScope);
    const document = documentFor();
    await repository.stageVisual(visualScope, { chatId: 'chat' }, document);
    forcePromotedVisual(document);
    let enteredRemoval: () => void = () => undefined;
    let releaseRemoval: () => void = () => undefined;
    const removalEntered = new Promise<void>((resolve) => {
      enteredRemoval = resolve;
    });
    const removalGate = new Promise<void>((resolve) => {
      releaseRemoval = resolve;
    });
    const originalRemove = visualRemoveImplementation();
    jest
      .spyOn(VisualStagingStoreImpl.prototype, 'remove')
      .mockImplementation(async function (this: VisualStagingStoreImpl, id) {
        expect(publishedRevisions).toContain(1);
        enteredRemoval();
        await removalGate;
        await originalRemove.call(this, id);
      });
    let firstQueued: () => void = () => undefined;
    const queued = new Promise<void>((resolve) => {
      firstQueued = resolve;
    });
    const first = repository.transactProviderEventWith(
      visualScope,
      () => [
        {
          type: 'tab.metadata_patched',
          tabId: 'chat',
          patch: { unread: true },
        },
      ],
      { source: 'provider', onQueued: firstQueued },
      { resolveToolKey: () => undefined },
    );
    await queued;
    const second = repository.transactWith(
      visualScope,
      () => [
        {
          type: 'tab.metadata_patched',
          tabId: 'chat',
          patch: { unread: false },
        },
      ],
      { source: 'automation' },
    );
    try {
      const [firstCommit, secondCommit] = await Promise.all([first, second]);
      await removalEntered;
      expect(firstCommit.revision).toBe(1);
      expect(secondCommit.revision).toBe(2);
      expect(publishedRevisions).toEqual([1, 2]);
    } finally {
      releaseRemoval();
    }
    await repository.drainAll();
  });

  it('skips promoted cleanup after the scope has been evicted', async () => {
    let publicationStarted: () => void = () => undefined;
    let releasePublication: () => void = () => undefined;
    const publicationEntered = new Promise<void>((resolve) => {
      publicationStarted = resolve;
    });
    const publicationGate = new Promise<void>((resolve) => {
      releasePublication = resolve;
    });
    const repository = createRepository({
      onCommit: async (): Promise<void> => {
        publicationStarted();
        await publicationGate;
      },
    });
    await repository.getState(visualScope);
    const document = documentFor();
    await repository.stageVisual(visualScope, { chatId: 'chat' }, document);
    forcePromotedVisual(document);
    const remove = jest.spyOn(VisualStagingStoreImpl.prototype, 'remove');
    const transaction = repository.transactProviderEventWith(
      visualScope,
      () => [
        {
          type: 'tab.metadata_patched',
          tabId: 'chat',
          patch: { unread: true },
        },
      ],
      { source: 'provider' },
      { resolveToolKey: () => undefined },
    );
    try {
      await publicationEntered;
      expect(await repository.evictScope(visualScope)).toBe(true);
    } finally {
      releasePublication();
    }
    await transaction;
    await repository.drainAll();
    expect(remove).not.toHaveBeenCalled();
  });

  it('retains staging while archiving a chat and removes it after permanent deletion', async () => {
    const archivedId = 'chat';
    const deletedId = 'chat-to-delete';
    await writeFile(
      paths.tabs,
      JSON.stringify({
        version: 1,
        activeTabId: archivedId,
        tabs: [
          {
            id: archivedId,
            title: 'Chat',
            createdAt: '2026-09-05',
            messages: [row],
          },
          {
            id: deletedId,
            title: 'Delete',
            createdAt: '2026-09-05',
            messages: [row],
          },
        ],
      }),
    );
    const repository = createRepository();
    const state = await repository.getState(visualScope);
    const archivedChat = state.tabsFile.tabs.find(
      (tab) => tab.id === archivedId,
    );
    if (!archivedChat) throw new Error('Archive fixture chat is missing');
    await repository.stageVisual(
      visualScope,
      { chatId: archivedId },
      documentFor(),
    );
    await repository.stageVisual(
      visualScope,
      { chatId: deletedId },
      documentFor(secondVisualId),
    );
    const removedChats: string[] = [];
    const originalRemoveChat = visualRemoveChatImplementation();
    let archiveCleanup: () => void = () => undefined;
    let deleteCleanup: () => void = () => undefined;
    const archivedRemoved = new Promise<void>((resolve) => {
      archiveCleanup = resolve;
    });
    const liveRemoved = new Promise<void>((resolve) => {
      deleteCleanup = resolve;
    });
    jest
      .spyOn(VisualStagingStoreImpl.prototype, 'removeChat')
      .mockImplementation(async function (
        this: VisualStagingStoreImpl,
        chatId,
      ) {
        removedChats.push(chatId);
        if (chatId === archivedId) archiveCleanup();
        if (chatId === deletedId) deleteCleanup();
        await originalRemoveChat.call(this, chatId);
      });
    await repository.transact(
      visualScope,
      [
        { type: 'tab.removed', tabId: archivedId },
        {
          type: 'archive.upserted',
          entry: {
            tab: archivedChat,
            archivedAt: '2026-09-06T00:00:00.000Z',
            turnCount: 1,
          },
        },
      ],
      { source: 'automation' },
    );
    expect(removedChats).toEqual([]);
    await repository.transact(
      visualScope,
      [
        {
          type: 'archive.removed',
          chatId: archivedId,
          archiveEntryId: archivedId,
        },
      ],
      { source: 'automation' },
    );
    await archivedRemoved;
    await repository.transact(
      visualScope,
      [{ type: 'tab.removed', tabId: deletedId }],
      { source: 'automation' },
    );
    await liveRemoved;
    expect(removedChats).toEqual([archivedId, deletedId]);
  });

  it('does one marker stat without listing directories and drain stops the scheduler', async () => {
    jest.useFakeTimers();
    const start = jest.spyOn(ChatVisualStagingSweep.prototype, 'start');
    start.mockImplementation(() => undefined);
    const stop = jest.spyOn(ChatVisualStagingSweep.prototype, 'stop');
    const repository = createRepository();
    await repository.getState(visualScope);
    expect(start).toHaveBeenCalledTimes(1);
    const stat = jest.spyOn(fsPromises, 'stat');
    const readdir = jest.spyOn(fsPromises, 'readdir');
    await runVisualSweep(repository);
    expect(stat).toHaveBeenCalledTimes(1);
    expect(stat).toHaveBeenCalledWith(chatVisualStagingScopesMarkerPath(root));
    expect(readdir).not.toHaveBeenCalled();
    await repository.drainAll();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('sweeps loaded and unloaded roots but leaves archive and history storage alone', async () => {
    jest.useFakeTimers();
    jest
      .spyOn(ChatVisualStagingSweep.prototype, 'start')
      .mockImplementation(() => undefined);
    const storage = ChatStorageV2.fromLegacyPaths(paths);
    const loadedStagePath = join(storage.directory, 'visual-staging');
    const unloadedStagePath = join(
      root,
      'workspaces',
      'workspace-one',
      'chat-storage-v2',
      'unloaded-scope',
      'visual-staging',
    );
    const appStagePath = join(
      root,
      'app-workspaces',
      'app-scope',
      'chat-storage-v2',
      'unloaded-app-scope',
      'visual-staging',
    );
    const archivedStagePath = join(
      root,
      'workspaces',
      'workspace-one',
      'archived-containers',
      'container-one',
      'chat-storage-v2',
      'retained-scope',
      'visual-staging',
    );
    const historyStagePath = join(
      root,
      'workspaces',
      'workspace-one',
      'chat-history',
      'history-one',
      'chat-storage-v2',
      'retained-scope',
      'visual-staging',
    );
    await stageAt(
      unloadedStagePath,
      'unloaded-chat',
      documentFor(secondVisualId),
    );
    await stageAt(
      appStagePath,
      'app-chat',
      documentFor('vis_123e4567-e89b-12d3-a456-426614174002'),
    );
    await stageAt(
      archivedStagePath,
      'retained-chat',
      documentFor('vis_123e4567-e89b-12d3-a456-426614174003'),
    );
    await stageAt(
      historyStagePath,
      'history-chat',
      documentFor('vis_123e4567-e89b-12d3-a456-426614174004'),
    );
    const repository = createRepository();
    await repository.getState(visualScope);
    await stageAt(loadedStagePath, 'chat', documentFor());
    now += VISUAL_STAGING_RETENTION_MS + 1;
    await runVisualSweep(repository);
    await repository.drainAll();
    for (const directory of [loadedStagePath, unloadedStagePath, appStagePath])
      await expect(readdir(directory)).resolves.toHaveLength(0);
    await expect(readdir(archivedStagePath)).resolves.toHaveLength(2);
    await expect(readdir(historyStagePath)).resolves.toHaveLength(2);
    await expect(
      readFile(chatVisualStagingScopesMarkerPath(root)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps the marker until young orphan and temporary files age out', async () => {
    jest
      .spyOn(ChatVisualStagingSweep.prototype, 'start')
      .mockImplementation(() => undefined);
    const stagePath = join(
      root,
      'workspaces',
      'workspace-one',
      'chat-storage-v2',
      'crashed-scope',
      'visual-staging',
    );
    await mkdir(stagePath, { recursive: true });
    const orphanPath = join(stagePath, `${secondVisualId}.html`);
    const temporaryPath = join(stagePath, '.interrupted.tmp');
    await writeFile(orphanPath, '<p>orphan</p>');
    await writeFile(temporaryPath, 'partial');
    // A crash left both files just now, by the repository clock.
    for (const path of [orphanPath, temporaryPath])
      await utimes(path, now / 1000, now / 1000);
    await withChatVisualStagingScopesMarker(() => Promise.resolve(), root);
    const repository = createRepository();

    await runVisualSweep(repository);
    await expect(readdir(stagePath)).resolves.toHaveLength(2);
    expect(await chatVisualStagingScopesMarkerExists(root)).toBe(true);

    now += VISUAL_STAGING_RETENTION_MS + 1;
    await runVisualSweep(repository);
    await expect(readdir(stagePath)).resolves.toHaveLength(0);
    expect(await chatVisualStagingScopesMarkerExists(root)).toBe(false);
  });

  it('keeps the marker when a stage starts during a clean pass', async () => {
    const sweepGeneration = chatVisualStagingPublicationGeneration();
    let enteredStage: () => void = () => undefined;
    let releaseStage: () => void = () => undefined;
    const stageStarted = new Promise<void>((resolve) => {
      enteredStage = resolve;
    });
    const stageGate = new Promise<void>((resolve) => {
      releaseStage = resolve;
    });
    const operation = withChatVisualStagingScopesMarker(async () => {
      enteredStage();
      await stageGate;
    }, root);
    try {
      await stageStarted;
      expect(
        await removeChatVisualStagingScopesMarker(sweepGeneration, root),
      ).toBe(false);
    } finally {
      releaseStage();
    }
    await operation;
    expect(await chatVisualStagingScopesMarkerExists(root)).toBe(true);
  });
});
