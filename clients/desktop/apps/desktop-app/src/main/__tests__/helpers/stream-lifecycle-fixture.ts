import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PersistedChatMessage } from '@canopy/desktop-shared/types';
import type { ChatScopeKey } from '../../services/chat-state-contracts';
import { ChatStateService } from '../../services/chat-state-service';
import { ChatArtifactMaintenance } from '../../lib/chat-artifact-maintenance';
import {
  encodeStreamDescriptor,
  parseStreamDescriptor,
  streamRegistryPaths,
} from '../../lib/chat-delta-journal/stream-registry';
import { delegationStreamKey } from '../../lib/transcript-stream-paths';
import {
  portableFixture,
  portableRows,
  BODY_TEXT,
  OLD_TEXT,
  PAGED_TEXT,
} from './stream-portable-fixture';
import { child, parent, card } from './stream-closure-copy-fixture';
import {
  format4Scope,
  reopenFormat4Scope,
  snapshotFormat4Files,
} from './chat-format4-scope';
import { scopeSource } from './chat-delta-journal-harness';
import { repositoryAt } from './chat-delta-journal-scope';
import type { ChatStateV2Repository } from '../../services/chat-state-v2-repository';
import { FileDelegationStorage } from '@canopy/desktop-shared/node/delegation/storage';
import {
  decodeStoredDelegationV3,
  readMetadataOfRecord,
} from '@canopy/desktop-shared/node/delegation/record-v3';
import { createDelegationRunState } from '@canopy/desktop-shared/node/delegation/lifecycle';
import { H_PARENT, H_ID } from './delegation-promotion-fixture';
import { ChatStorageV2 } from '../../lib/chat-storage-v2';
import { ChatStateV2Backend } from '../../services/chat-state-v2-backend';
import { CardStateV2Schema } from '@canopy/protocol/canopy-core';

export const ANSWER = 'descriptor-only lifecycle answer';
export const SOURCE = { projectId: 'p', worktreeId: 'source' };
export const DESTINATION = { projectId: 'p', worktreeId: 'destination' };
export const LIFECYCLE_TARGET = {
  kind: 'delegation' as const,
  chatId: 'chat',
  delegationId: H_ID,
  runGeneration: 1,
};
export const LIFECYCLE_BLOCK = `delegated-agent-${H_ID}`;
export interface LifecycleFixture {
  source: ReturnType<typeof reopenFormat4Scope>;
  destination: ReturnType<typeof reopenFormat4Scope>;
  repository: ChatStateV2Repository;
  service: ChatStateService;
  answer: Awaited<
    ReturnType<ChatStateV2Backend['storage']['transcripts']['artifacts']['put']>
  >;
}
export async function scopeSnapshot(
  root: string,
  scopeId: string,
): Promise<{
  files: Awaited<ReturnType<typeof snapshotFormat4Files>>;
  manifest: string;
}> {
  const store = new ChatStorageV2(root, scopeId);
  return {
    files: await snapshotFormat4Files(store.directory),
    manifest: await readFile(store.manifestPath, 'utf8'),
  };
}

async function settleStream(
  source: ReturnType<typeof reopenFormat4Scope>,
  count: number,
): Promise<void> {
  const target = LIFECYCLE_TARGET;
  await source.backend.commitChildStream(target, 'final-oldest', [
    {
      ...child(true, OLD_TEXT, 1),
      id: 'row-0',
      parentBlockId: LIFECYCLE_BLOCK,
    },
  ]);
  await source.backend.flush();
  const log = await readFile(
    streamRegistryPaths(
      join(source.store.directory, 'transcripts'),
      'chat',
      delegationStreamKey(target),
    ).log,
  );
  const descriptor = await source.backend.childStreamDescriptor(target);
  if (!descriptor) throw new Error('Fixture stream is missing');
  await source.backend.commitChildStream(target, 'settled', [], {
    key: 'settled',
    descriptorUpdate: {
      version: 1,
      target,
      expectedStreamRevision: descriptor.streamRevision,
      nextStreamRevision: descriptor.streamRevision + 1,
      status: 'settled',
      settleReceipt: {
        mutationId: 'settled',
        scopeRevision: (await source.backend.revision()) + 1,
        streamRevision: descriptor.streamRevision + 1,
        committedRowCount: count,
        committedByteLength: log.length,
        committedSha256: createHash('sha256').update(log).digest('hex'),
      },
    },
  });
}

export async function settleLater(
  fixture: Awaited<ReturnType<typeof lifecycleFixture>>,
  root: string,
): Promise<void> {
  expect(await fixture.repository.evictScope(SOURCE)).toBe(true);
  const source = reopenFormat4Scope(root, 'source', { enableFormat4: false });
  await settleStream(source, 107);
  await source.backend.demoteFromDeltaJournal();
}

export async function emptyDestination(
  root: string,
  scopeId: string,
  format4: boolean,
): Promise<ReturnType<typeof reopenFormat4Scope>> {
  if (format4) {
    const destination = await format4Scope(root, scopeId, scopeSource([]));
    await destination.backend.demoteFromDeltaJournal();
    return destination;
  }
  const store = new ChatStorageV2(root, scopeId);
  await store.migrate(scopeSource([]));
  const backend = new ChatStateV2Backend(store, { deltaJournal: {} });
  await backend.promoteToDeltaJournal();
  expect(await store.format()).toBe('v3');
  backend.releaseJournal();
  return { store, backend };
}

export async function lifecycleFixture(
  root: string,
  settled: boolean,
  destinationFormat4 = true,
): Promise<LifecycleFixture> {
  const target = LIFECYCLE_TARGET;
  const portable = await portableFixture(root, 'portable-source');
  const rows = (await portableRows(portable.backend)).filter(
    (row) => row.parentBlockId === 'delegated-agent-delegate',
  );
  const source = await format4Scope(
    root,
    'source',
    scopeSource([
      {
        id: 'chat',
        messages: [
          {
            ...parent(),
            blocks: [
              { ...card(), delegationId: H_ID, agentBlockId: LIFECYCLE_BLOCK },
            ],
          },
        ],
      },
    ]),
  );
  await source.backend.registerTranscriptStream(target);
  await source.backend.commitChildStream(
    target,
    'portable-fixture',
    rows.map((row, i) => ({
      ...child(i !== 0),
      id: row.id,
      blocks: row.blocks,
      delegationSequence: i,
      parentBlockId: LIFECYCLE_BLOCK,
    })),
  );
  if (settled) await settleStream(source, 106);
  await source.backend.demoteFromDeltaJournal();
  const answer = await source.backend.storage.transcripts.artifacts.put(
    'chat',
    ANSWER,
  );
  const paths = streamRegistryPaths(
    join(source.store.directory, 'transcripts'),
    'chat',
    delegationStreamKey(target),
  );
  const descriptor = parseStreamDescriptor(await readFile(paths.descriptor));
  const cardState = CardStateV2Schema.safeParse({
    version: 2,
    cardRevision: 1,
    status: 'running',
    outputTruncated: false,
    routeSnapshot: card().routeSnapshot,
    // Canonical answer metadata may precede the stream settle receipt.
    canonical: {
      status: 'completed',
      resultIndex: 1,
      finalText: 'answer preview',
      finalTextRef: answer,
    },
  });
  if (!cardState.success)
    throw new Error(JSON.stringify(cardState.error.issues));
  await writeFile(
    paths.descriptor,
    encodeStreamDescriptor({ ...descriptor, cardState: cardState.data }),
  );
  const destination = await emptyDestination(
    root,
    'destination',
    destinationFormat4,
  );
  const state = createDelegationRunState(H_ID, 1);
  const record = decodeStoredDelegationV3({
    version: 3,
    parent: {
      ...H_PARENT,
      ...SOURCE,
      chatId: 'chat',
      sessionKey: 'p/source/chat',
    },
    task: {
      modelId: 'model',
      description: 'task',
      prompt: 'prompt',
      executionMode: 'background',
      contextPolicy: 'task_only',
      isolation: 'shared_worktree',
    },
    callKey: 'c'.repeat(64),
    requestHash: 'a'.repeat(64),
    createdAt: 100,
    state: {
      ...state,
      status: settled ? 'completed' : 'running',
      startedAt: 100,
      ...(settled ? { finishedAt: 200 } : {}),
    },
    launch: {
      version: 1,
      delegationId: H_ID,
      launchKey: 'c'.repeat(64),
      runGeneration: 1,
      phase: 'reserved',
    },
    delivery: { status: 'unclaimed' },
    readMetadata: {
      originAt: 100,
      lastActivityAt: 120,
      current: { store: 'stream', target },
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
  const records = new FileDelegationStorage(join(root, 'delegation-runs'));
  await records.commit(record);
  expect((await records.loadOne(H_ID))?.version).toBe(3);
  const repository = repositoryAt(root, {
    enableFormat4: false,
    delegationReadMetadata: readMetadataOfRecord,
    deltaJournalIdleCheckpointMs: 3600_000,
  });
  const service = new ChatStateService({
    repository,
    recordDiagnostic: (): void => {},
    cleanupSession: (): Promise<void> => Promise.resolve(),
  });
  return { source, destination, repository, service, answer };
}

export async function inlineRows(
  repository: ChatStateV2Repository,
  scope: ChatScopeKey,
  chatId: string,
): Promise<PersistedChatMessage[]> {
  return repository.consumeTranscript(
    scope,
    chatId,
    true,
    async (source) => {
      const rows: PersistedChatMessage[] = [];
      for await (const row of source) rows.push(row);
      return rows;
    },
    { inlineDelegationChildren: true },
  );
}

export function assertInlineRows(rows: PersistedChatMessage[]): void {
  expect(rows.find((row) => row.id === 'parent')?.blocks).toEqual([
    expect.objectContaining({
      type: 'delegated_agent_call',
      delegationId: H_ID,
      finalText: ANSWER,
    }),
  ]);
  const children = rows.filter((row) => row.parentBlockId === LIFECYCLE_BLOCK);
  expect(children.map((row) => row.id)).toEqual(
    Array.from({ length: 106 }, (_, i) => `row-${i}`),
  );
  expect(children[0]?.blocks).toEqual([{ type: 'text', text: OLD_TEXT }]);
  expect(children[1]?.blocks).toEqual([
    { type: 'text', text: 'first logical block' },
    ...Array.from({ length: 20 }, () => ({ type: 'text', text: PAGED_TEXT })),
    {
      type: 'tool_result',
      toolUseId: 'tool',
      toolName: 'Read',
      output: BODY_TEXT,
      isError: false,
    },
  ]);
  expect(JSON.stringify(rows)).not.toContain('transcriptStore');
}

export async function maintain(
  fixture: Awaited<ReturnType<typeof lifecycleFixture>>,
  root: string,
  scope: ChatScopeKey,
  chatId: string,
): Promise<void> {
  await fixture.repository.flushScope(scope);
  // Evict before an independent checkpoint/maintenance instance touches its files.
  expect(await fixture.repository.evictScope(scope)).toBe(true);
  const store = reopenFormat4Scope(root, scope.worktreeId, {
    enableFormat4: false,
  });
  await store.backend.demoteFromDeltaJournal();
  const maintenance = new ChatArtifactMaintenance(
    store.backend.storage,
    store.store.directory,
  );
  try {
    let complete = false;
    for (let i = 0; i < 64 && !complete; i++)
      complete = (await maintenance.maintain(chatId, 1024 * 1024)).complete;
    expect(complete).toBe(true);
  } finally {
    await maintenance.dispose();
  }
  expect(
    await readFile(
      join(
        root,
        'chat-storage-v2',
        scope.worktreeId,
        'transcripts',
        'tool-output',
        chatId,
        `${fixture.answer.artifactId}.txt`,
      ),
      'utf8',
    ),
  ).toBe(ANSWER);
}
