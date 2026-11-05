import { chatChildDeleteFence } from '../../lib/chat-child-delete-fence';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  DelegationChildRow,
  PersistedChatMessage,
} from '@canopy/agent-transcript';
import type { DelegationTranscriptTarget } from '@canopy/desktop-shared/node/delegation/transcript-port';
import type {
  DelegationTranscriptPortConformanceFactory,
  DelegationTranscriptPortConformanceFixture,
  DelegationTranscriptPortFailurePhase,
  DelegationTranscriptRegistryFaultBoundary,
} from '@canopy/desktop-shared/node/delegation/testing/transcript-port-conformance';
import type { CardStateV1 } from '@canopy/protocol/canopy-core';
import type { ChatScopeKey } from '../../services/chat-state-contracts';
import { ChatStateService } from '../../services/chat-state-service';
import { ChatStateV2Repository } from '../../services/chat-state-v2-repository';
import { ChatDeltaJournalWriter } from '../../lib/chat-delta-journal/writer';
import type {
  DeltaJournalAdmission,
  DeltaJournalCommitInput,
  DeltaJournalCommitResult,
} from '../../lib/chat-delta-journal/writer';
import { TranscriptStreamStore } from '../../lib/chat-transcript-log';
import { ChatTranscriptArtifacts } from '../../lib/chat-transcript-artifacts';
import {
  delegationTranscriptPaths,
  delegationStreamKey,
} from '../../lib/transcript-stream-paths';
import { isPersistedToolOutputReference } from '@canopy/agent-transcript/transcript-storage';
import type { ChatStorageV2 } from '../../lib/chat-storage-v2';
import type { ChatStorageIndexes } from '../../lib/chat-storage-transactions';
import { message, scopeSource } from './chat-delta-journal-harness';
import { format4Scope, reopenFormat4Scope } from './chat-format4-scope';
import { RepositoryDelegationTranscriptPort } from '../../agents/delegation/repository-transcript-port';

type DelegationTarget = Extract<
  DelegationTranscriptTarget,
  { kind: 'delegation' }
>;

type RegistryFailureBoundary =
  | 'registry-answer-published'
  | 'registry-settle-admitted';

interface FixtureFaults {
  boundary?:
    | RegistryFailureBoundary
    | DelegationTranscriptRegistryFaultBoundary;
  /** Holds the next journal batch before its sync until resolved. */
  heldSync?: Promise<void>;
}

export interface RepositoryTranscriptPortFixture extends DelegationTranscriptPortConformanceFixture {
  readonly port: RepositoryDelegationTranscriptPort;
  readonly service: ChatStateService;
  readonly repository: ChatStateV2Repository;
  readonly scope: ChatScopeKey;
  readonly store: ChatStorageV2;
  readonly ownedTarget: (
    chatId: string,
    delegationId: string,
    generation: number,
  ) => DelegationTranscriptTarget;
  readonly foreignTarget: DelegationTranscriptTarget;
  readonly reopen: () => Promise<void>;
  readonly checkpoint: () => Promise<void>;
  readonly freshInstance: () => Promise<RepositoryDelegationTranscriptPort>;
  readonly noJournal: () => Promise<RepositoryDelegationTranscriptPort>;
  readonly readStoredParentMessage: (
    chatId: string,
    messageId: string,
  ) => Promise<PersistedChatMessage | undefined>;
  readonly updateCardState: (
    target: DelegationTranscriptTarget,
  ) => Promise<void>;
  readonly seedMetadataLessRows: (
    target: DelegationTranscriptTarget,
    rows: readonly DelegationChildRow[],
  ) => Promise<void>;
  readonly injectStorageFailure: (
    phase: DelegationTranscriptPortFailurePhase,
  ) => void;
  readonly injectRegistryFailure: (boundary: RegistryFailureBoundary) => void;
  /** Holds the next journal write before its sync; returns its release. */
  readonly holdJournalSync: () => () => void;
  readonly close: () => Promise<void>;
}

export interface RepositoryTranscriptPortConformanceFactory extends DelegationTranscriptPortConformanceFactory {
  (): Promise<RepositoryTranscriptPortFixture>;
}

interface FixtureServices {
  readonly port: RepositoryDelegationTranscriptPort;
  readonly service: ChatStateService;
  readonly repository: ChatStateV2Repository;
  drained: boolean;
}

function target(
  chatId: string,
  delegationId: string,
  generation: number,
): DelegationTarget {
  return {
    kind: 'delegation',
    chatId,
    delegationId,
    runGeneration: generation,
  };
}

function requireDelegationTarget(
  value: DelegationTranscriptTarget,
): DelegationTarget {
  if (value.kind !== 'delegation')
    throw new Error('The repository fixture requires a delegation target.');
  return value;
}

function createServices(
  root: string,
  scope: ChatScopeKey,
  faults: FixtureFaults,
  incrementalStreamMetadata: boolean,
): FixtureServices {
  const repository = new ChatStateV2Repository({
    resolvePaths: (): {
      tabs: string;
      archives: string;
      journal: string;
    } => ({
      tabs: join(root, 'scope.json'),
      archives: join(root, 'archives.json'),
      journal: join(root, 'journal.json'),
    }),
    enableFormat4: true,
    ...(incrementalStreamMetadata
      ? { deltaJournalIncrementalStreamMetadata: true }
      : {}),
    deltaJournalOnBoundary: (boundary): Promise<void> => {
      const held = faults.heldSync;
      if (held !== undefined && boundary === 'record-written') {
        faults.heldSync = undefined;
        return held;
      }
      const selected = faults.boundary;
      if (selected !== undefined && String(boundary) === selected) {
        faults.boundary = undefined;
        return Promise.reject(
          new Error(`Injected registry boundary failure: ${selected}`),
        );
      }
      return Promise.resolve();
    },
  });
  const service = new ChatStateService({
    repository,
    recordDiagnostic: jest.fn(),
  });
  return {
    port: new RepositoryDelegationTranscriptPort(service, scope),
    service,
    repository,
    drained: false,
  };
}

function describeFixtureFailure(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  const nested: unknown =
    typeof error === 'object' && error !== null
      ? Reflect.get(error, 'errors')
      : undefined;
  if (Array.isArray(nested)) {
    const failures: readonly unknown[] = nested;
    return new Error(
      `${message}: ${failures.map((failure) => describeFixtureFailure(failure).message).join('; ')}`,
    );
  }
  return error instanceof Error ? error : new Error(message);
}

function nextIndexes(
  indexes: ChatStorageIndexes,
  mutationId: string,
): ChatStorageIndexes {
  return {
    ...indexes,
    live: { ...indexes.live, revision: indexes.live.revision + 1 },
    archive: { ...indexes.archive, revision: indexes.archive.revision + 1 },
    recovery: {
      ...indexes.recovery,
      mutationIds: [...indexes.recovery.mutationIds, mutationId].slice(-4096),
    },
  };
}

async function storagePaths(root: string): Promise<string[]> {
  const paths: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    paths.push(path);
    if (entry.isDirectory()) paths.push(...(await storagePaths(path)));
  }
  return paths.sort();
}

/**
 * Build a real, opted-in format-4 repository fixture for the shared port kit.
 * Each invocation of the returned factory gets its own durable scope.
 */
export function createRepositoryTranscriptPortFixture(
  root: string,
  options: { incrementalStreamMetadata?: boolean } = {},
): RepositoryTranscriptPortConformanceFactory {
  return Object.assign(
    async (): Promise<RepositoryTranscriptPortFixture> => {
      await mkdir(root, { recursive: true });
      const fixtureRoot = await mkdtemp(
        join(root, 'repository-transcript-port-'),
      );
      const scope: ChatScopeKey = {
        projectId: 'transcript-port-project',
        worktreeId: 'scope',
      };
      const { store, backend } = await format4Scope(
        fixtureRoot,
        scope.worktreeId,
        scopeSource(
          ['chat', 'chat-a', 'chat-b', 'conformance-chat'].map((id) => ({
            id,
            messages: [
              message(`parent-${id}`, 'A real parent transcript message.'),
            ],
          })),
        ),
      );
      await backend.flush();
      backend.releaseJournal();
      await backend.disposeArtifactMaintenance();

      const faults: FixtureFaults = {};
      const services: FixtureServices[] = [];
      const createAndTrackServices = (): FixtureServices => {
        const created = createServices(
          fixtureRoot,
          scope,
          faults,
          options.incrementalStreamMetadata === true,
        );
        services.push(created);
        return created;
      };
      let current = createAndTrackServices();
      // Repository-profile absent in-scope chats are removed/tombstoned, not unknown foreign chats.
      for (const chatId of ['absent-receipt-chat', 'absent-repair-chat']) {
        await current.repository.transact(
          scope,
          [
            {
              type: 'tab.created',
              tab: {
                id: chatId,
                title: chatId,
                createdAt: '2026-10-17',
                messages: [],
              },
            },
          ],
          { source: 'automation' },
        );
        await current.repository.transact(
          scope,
          [{ type: 'tab.removed', tabId: chatId }],
          { source: 'automation' },
        );
      }
      const removed = new Set<string>();
      const recreations: Promise<unknown>[] = [];
      let noJournalPaths: string[] | undefined;
      const drainServices = async (): Promise<void> => {
        const outcomes = await Promise.allSettled(
          services
            .filter((entry) => !entry.drained)
            .map(async (entry): Promise<void> => {
              await entry.repository.drainAll();
              entry.drained = true;
            }),
        );
        for (const outcome of outcomes)
          if (outcome.status === 'rejected')
            throw describeFixtureFailure(outcome.reason);
      };
      const resumeCurrent = (): FixtureServices => {
        current = createAndTrackServices();
        return current;
      };
      const close = async (): Promise<void> => {
        await Promise.all(recreations);
        await drainServices();
      };

      const fixture: RepositoryTranscriptPortFixture = {
        get port(): RepositoryDelegationTranscriptPort {
          return current.port;
        },
        get service(): ChatStateService {
          return current.service;
        },
        get repository(): ChatStateV2Repository {
          return current.repository;
        },
        scope,
        store,
        ownedTarget: (
          chatId: string,
          delegationId: string,
          generation: number,
        ): DelegationTranscriptTarget => {
          if (removed.delete(chatId)) {
            // Hold the target while restoring so open cannot overtake its parent.
            const recreation = current.repository.withChildStreamTarget(
              scope,
              target(chatId, delegationId, generation),
              async () => {
                await current.repository.transact(
                  scope,
                  [
                    {
                      type: 'tab.created',
                      tab: {
                        id: chatId,
                        title: chatId,
                        createdAt: '2026-10-17',
                        messages: [],
                      },
                    },
                  ],
                  { source: 'automation' },
                );
                // same-id re-creation is a host restore; the fence restore mirrors copyRunTo
                chatChildDeleteFence(
                  join(store.directory, 'transcripts'),
                ).restore(chatId);
              },
            );
            recreations.push(recreation);
            void recreation.catch(() => undefined); // close observes any failure.
          }
          return target(chatId, delegationId, generation);
        },
        foreignTarget: target('foreign-chat', 'foreign-delegate', 1),
        reopen: async (): Promise<void> => {
          await drainServices();
          resumeCurrent();
        },
        checkpoint: async (): Promise<void> => {
          await current.service.flushScope(scope.projectId, scope.worktreeId);
        },
        freshInstance:
          async (): Promise<RepositoryDelegationTranscriptPort> => {
            await drainServices();
            const fresh = resumeCurrent();
            return new RepositoryDelegationTranscriptPort(fresh.service, scope);
          },
        noJournal: async (): Promise<RepositoryDelegationTranscriptPort> => {
          await drainServices();
          const reopened = reopenFormat4Scope(fixtureRoot, scope.worktreeId);
          try {
            await reopened.backend.demoteFromDeltaJournal();
            reopened.backend.releaseJournal();
            if (await reopened.store.journalFile())
              throw new Error(
                'The no-journal fixture view retained a delta journal.',
              );
          } finally {
            reopened.backend.releaseJournal();
            await reopened.backend.disposeArtifactMaintenance();
          }
          noJournalPaths = await storagePaths(store.directory);
          return resumeCurrent().port;
        },
        assertNoStorageCreated: async (chatId): Promise<void> => {
          expect(await store.journalFile()).toBeUndefined();
          if (!noJournalPaths)
            throw new Error('No no-journal snapshot captured.');
          const paths = await storagePaths(store.directory);
          // Compare the entire closure: hashed registry/locator names cannot hide recreation.
          expect(paths).toEqual(noJournalPaths);
          if (chatId.startsWith('absent-') || removed.has(chatId)) {
            const transcripts = join(store.directory, 'transcripts');
            for (const path of paths) {
              expect(path.startsWith(join(transcripts, `${chatId}.`))).toBe(
                false,
              );
              for (const family of [
                'delegations',
                'tool-output',
                'message-index',
                'content',
                'blocks',
              ]) {
                const owned = join(transcripts, family, chatId);
                expect(path === owned || path.startsWith(`${owned}/`)).toBe(
                  false,
                );
              }
            }
          }
        },
        readStoredToolOutputReference: async (
          value,
          messageId,
          blockOrdinal,
        ) => {
          await current.repository.flushScope(scope);
          const validated = requireDelegationTarget(value);
          const streams = new TranscriptStreamStore(
            delegationTranscriptPaths(
              join(store.directory, 'transcripts'),
              validated,
            ),
            new ChatTranscriptArtifacts(
              join(store.directory, 'transcripts'),
              true,
            ),
            undefined,
            { readOnly: true, childMode: true },
          );
          const row =
            (await streams.childStreamRowById(
              delegationStreamKey(validated),
              messageId,
            )) ??
            (await streams.activeMessages(delegationStreamKey(validated))).find(
              (entry) => entry.id === messageId,
            );
          const block = row?.blocks[blockOrdinal];
          return block?.type === 'tool_result' &&
            isPersistedToolOutputReference(block.fullOutputRef)
            ? block.fullOutputRef
            : undefined;
        },
        removeChat: async (chatId): Promise<void> => {
          await current.repository.transact(
            scope,
            [{ type: 'tab.removed', tabId: chatId }],
            { source: 'automation' },
          );
          removed.add(chatId);
        },
        injectRegistryFault: (boundary): void => {
          if (faults.boundary !== undefined)
            throw new Error('A registry boundary failure is already armed.');
          faults.boundary = boundary;
        },
        readStoredParentMessage: (
          chatId: string,
          messageId: string,
        ): Promise<PersistedChatMessage | undefined> =>
          current.repository.readStoredParentMessage(scope, chatId, messageId),
        updateCardState: async (
          value: DelegationTranscriptTarget,
        ): Promise<void> => {
          await drainServices();
          const validated = requireDelegationTarget(value);
          const reopened = reopenFormat4Scope(fixtureRoot, scope.worktreeId);
          try {
            const descriptor =
              await reopened.backend.childStreamDescriptor(validated);
            if (!descriptor)
              throw new Error('Cannot update the missing child stream card.');
            const cardState: CardStateV1 = {
              version: 1,
              status: 'completed',
              resultIndex: 1,
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
              finalPreview: 'Updated by repository conformance fixture',
            };
            await reopened.backend.updateChildStreamCardState(
              validated,
              descriptor.streamRevision,
              cardState,
            );
          } finally {
            reopened.backend.releaseJournal();
            await reopened.backend.disposeArtifactMaintenance();
          }
          resumeCurrent();
        },
        seedMetadataLessRows: async (
          value: DelegationTranscriptTarget,
          rows: readonly DelegationChildRow[],
        ): Promise<void> => {
          await drainServices();
          const validated = requireDelegationTarget(value);
          const reopened = reopenFormat4Scope(fixtureRoot, scope.worktreeId);
          try {
            if (!(await reopened.backend.childStreamDescriptor(validated)))
              await reopened.backend.registerTranscriptStream(validated);
            reopened.backend.releaseJournal();
            const writer = await ChatDeltaJournalWriter.open(reopened.store);
            const indexes = writer.indexes();
            const mutationId = randomUUID();
            const input = {
              expectedRevision: indexes.live.revision,
              next: nextIndexes(indexes, mutationId),
              writes: [],
              mutationIds: [mutationId],
              childWrites: [{ target: validated, rows: [...rows] }],
            };
            await writer.commit(input);
          } finally {
            reopened.backend.releaseJournal();
            await reopened.backend.disposeArtifactMaintenance();
          }
          resumeCurrent();
        },
        injectStorageFailure: (
          phase: DelegationTranscriptPortFailurePhase,
        ): void => {
          // Fail the next child journal write: a solo commit (settlement,
          // card state, registration) or a group-committed admission that
          // carries child rows. Other records pass through.
          const commitSpy = jest.spyOn(
            ChatDeltaJournalWriter.prototype,
            'commit',
          );
          const admitSpy = jest.spyOn(
            ChatDeltaJournalWriter.prototype,
            'admit',
          );
          const commit = commitSpy.getMockImplementation();
          const admit = admitSpy.getMockImplementation();
          if (commit === undefined || admit === undefined)
            throw new Error(
              'The child journal write implementation is missing.',
            );
          let armed = true;
          const inject = (): void => {
            armed = false;
            if (phase === 'before-write')
              throw new Error('Injected pre-durable child stream failure');
          };
          commitSpy.mockImplementation(async function (
            this: ChatDeltaJournalWriter,
            input: DeltaJournalCommitInput,
          ): Promise<DeltaJournalCommitResult> {
            if (!armed) return commit.call(this, input);
            inject();
            await commit.call(this, input);
            throw new Error('Injected post-durable child stream failure');
          });
          admitSpy.mockImplementation(async function (
            this: ChatDeltaJournalWriter,
            input: DeltaJournalCommitInput,
          ): Promise<DeltaJournalAdmission> {
            if (!armed || !input.childWrites?.length)
              return admit.call(this, input);
            inject();
            const admitted = await admit.call(this, input);
            await admitted.durable;
            throw new Error('Injected post-durable child stream failure');
          });
        },
        injectRegistryFailure: (boundary): void => {
          if (faults.boundary !== undefined)
            throw new Error('A registry boundary failure is already armed.');
          faults.boundary = boundary;
        },
        holdJournalSync: (): (() => void) => {
          let release: () => void = () => undefined;
          faults.heldSync = new Promise<void>((resolve) => {
            release = resolve;
          });
          return release;
        },
        close,
        dispose: close,
      };
      return fixture;
    },
    {
      capabilities: {
        reopen: true,
        storageFailure: true,
        checkpoint: true,
        freshInstance: true,
        noJournal: true,
        faults: true,
        chatRemoval: true,
        registryFaults: true,
        assertNoStorageCreated: true,
        storedToolOutputReference: true,
      },
    },
  );
}
