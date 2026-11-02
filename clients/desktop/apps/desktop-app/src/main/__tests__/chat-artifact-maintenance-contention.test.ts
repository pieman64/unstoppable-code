import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { PersistedChatMessage } from '@canopy/desktop-shared/types';
import { ChatStateV2Repository } from '../services/chat-state-v2-repository';
import type {
  ChatScopeKey,
  ChatStateStorageDiagnostic,
} from '../services/chat-state-contracts';
import { ChatStorageV2 } from '../lib/chat-storage-v2';
import { ChatTranscriptLog } from '../lib/chat-transcript-log';
import { ChatStorageTransactions } from '../lib/chat-storage-transactions';
import { ChatArtifactMaintenance } from '../lib/chat-artifact-maintenance';
import { delegationTranscriptMessages } from '@canopy/agent-transcript';
import { projectAgentRoute } from '@canopy/desktop-shared/node/delegation';
import { routeFixture } from '@canopy/desktop-shared/node/delegation/__tests__/fixtures';
import { message, scopeSource } from './helpers/chat-delta-journal-harness';
import type { ActiveRowAnchor } from '../lib/chat-transcript-live-positions';

/**
 * Artifact maintenance shares eight reference-hint slots across every scope.
 * These cover more chats than slots: the situation of a desktop with many
 * worktrees, where losing a slot must neither look like a failure nor make a
 * clean chat rescan its whole transcript.
 */
const CHATS = ['first', 'second'];

const toolMessage = (chatId: string, output: string): PersistedChatMessage => ({
  id: `tool-${chatId}`,
  role: 'assistant',
  timestamp: 2,
  blocks: [
    {
      type: 'tool_result',
      toolUseId: `call-${chatId}`,
      toolName: 'Read',
      output,
      isError: false,
    },
  ],
});

describe('artifact maintenance beyond the shared slot budget', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'chat-artifact-contention-'));
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  const pathsFor = (
    worktreeId: string,
  ): { tabs: string; archives: string; journal: string } => ({
    tabs: join(root, worktreeId, 'chats', 'scope.json'),
    archives: join(root, worktreeId, 'chat-archives', 'scope.json'),
    journal: join(root, worktreeId, 'chat-journals', 'scope.jsonl'),
  });

  async function seedScopes(count: number): Promise<ChatScopeKey[]> {
    const scopes = Array.from({ length: count }, (_, index) => ({
      projectId: 'workspace',
      worktreeId: `scope-${index}`,
    }));
    for (const { worktreeId } of scopes) {
      const paths = pathsFor(worktreeId);
      await mkdir(dirname(paths.tabs), { recursive: true });
      await writeFile(
        paths.tabs,
        JSON.stringify({
          version: 1,
          activeTabId: CHATS[0],
          tabs: CHATS.map((id) => ({
            id,
            title: id,
            createdAt: '2026-09-05',
            messages: [],
          })),
        }),
      );
    }
    return scopes;
  }

  const outputCount = async (scopes: ChatScopeKey[]): Promise<number> => {
    let total = 0;
    for (const { worktreeId } of scopes)
      for (const chatId of CHATS)
        total += (
          await readdir(
            join(
              ChatStorageV2.fromLegacyPaths(pathsFor(worktreeId)).directory,
              'transcripts',
              'tool-output',
              chatId,
            ),
          )
        ).length;
    return total;
  };

  const settle = async (): Promise<void> => {
    for (let index = 0; index < 10; index++)
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
  };

  it('keeps anchored output reachable through maintenance and capture after parent settle', async () => {
    const store = new ChatStorageV2(root, 'anchored');
    const parent = message('parent', 'Parent', 'user');
    await store.migrate(scopeSource([{ id: 'chat', messages: [parent] }]));
    const storage = new ChatStorageTransactions(store);
    const log = storage.transcripts;
    const card = delegationTranscriptMessages({
      delegationId: 'maintenance-run',
      runGeneration: 1,
      sequence: 1,
      parentHarnessId: 'claude',
      parentTurnId: parent.id,
      parentToolCallId: 'delegate-call',
      createdAt: 2,
      task: {
        description: 'Read',
        prompt: 'Read',
        executionMode: 'background',
      },
      snapshot: {
        delegationId: 'maintenance-run',
        runGeneration: 1,
        status: 'running',
        outputTruncated: false,
        requestedModelId: 'test-model',
        routeSnapshot: projectAgentRoute(
          routeFixture({
            selectedModelId: 'test-model',
            runtimeModelId: 'test-model',
            harnessId: 'claude',
          }),
        ),
      },
      transcript: [],
    })[0];
    if (!card) throw new Error('Missing delegated card');
    const child: PersistedChatMessage = {
      ...toolMessage('anchored', 'Kept anchored output\n'.repeat(6000)),
      parentBlockId: card.id,
    };
    const ordinary = message('ordinary', 'Parent result');
    const anchors = new Map<string, ActiveRowAnchor>([
      [card.id, { version: 1, runId: card.id, after: parent.id, tie: 0 }],
      [child.id, { version: 1, runId: card.id, after: card.id, tie: 0 }],
    ]);
    await log.writeActive('chat', [card, child, ordinary], anchors);
    await log.append('chat', [ordinary, card, child], anchors, 2);
    expect((await log.activeMessages('chat')).map((row) => row.id)).toEqual([
      card.id,
      child.id,
    ]);
    const block = (await log.activeMessages('chat'))[1]?.blocks[0];
    if (block?.type !== 'tool_result' || !block.fullOutputRef)
      throw new Error('Missing active output reference');
    const orphan = await log.artifacts.put(
      'chat',
      'Orphan output\n'.repeat(6000),
    );
    const maintenance = new ChatArtifactMaintenance(
      storage,
      join(store.directory, 'transcripts'),
    );
    try {
      let complete = false;
      for (let attempt = 0; attempt < 20 && !complete; attempt++)
        complete = (
          await maintenance.maintain(
            'chat',
            1024 * 1024,
            await log.descriptor('chat'),
          )
        ).complete;
      expect(complete).toBe(true);
      await log.artifacts.verify('chat', block.fullOutputRef);
      await expect(log.artifacts.verify('chat', orphan)).rejects.toThrow();
      const captured = await log.capturePreview(
        'chat',
        await log.descriptor('chat'),
      );
      try {
        const rows = [];
        for await (const row of captured.messages()) rows.push(row);
        expect(rows.map((row) => row.id)).toEqual([
          parent.id,
          ordinary.id,
          card.id,
          child.id,
        ]);
      } finally {
        await captured.close();
      }
      expect(await log.activeRowAnchors('chat')).toEqual(anchors);
    } finally {
      await maintenance.dispose();
    }
  });

  it('reclaims every scope without reporting slot waits as failures', async () => {
    const diagnostics: ChatStateStorageDiagnostic[] = [];
    const scopes = await seedScopes(12);
    const repository = new ChatStateV2Repository({
      resolvePaths: (target): ReturnType<typeof pathsFor> =>
        pathsFor(target.worktreeId),
      onStorageDiagnostic: (diagnostic): void => {
        diagnostics.push(diagnostic);
      },
    });
    const old = 'old output\n'.repeat(9000);
    const final = 'final output\n'.repeat(9000);
    for (const scope of scopes) {
      await repository.getState(scope);
      for (const chatId of CHATS) {
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
    }
    diagnostics.length = 0;

    // Every scope's turns end together, so 24 chats compete for 8 slots.
    await Promise.all(
      scopes.map((scope) =>
        repository.transact(
          scope,
          CHATS.map((chatId) => ({
            type: 'runtime.patched' as const,
            chatId,
            runtime: { status: 'completed' as const, queuedMessageIds: [] },
          })),
          { source: 'provider' },
        ),
      ),
    );
    for (
      let attempt = 0;
      attempt < 500 &&
      (await outputCount(scopes)) > scopes.length * CHATS.length;
      attempt++
    )
      await new Promise<void>((resolve) => setTimeout(resolve, 20));

    expect(await outputCount(scopes)).toBe(scopes.length * CHATS.length);
    expect(
      diagnostics.filter(
        (diagnostic) => diagnostic.kind === 'artifact_maintenance_failed',
      ),
    ).toEqual([]);
    await repository.drainAll();
  }, 120_000);

  it('does not rescan clean transcripts after routine commits', async () => {
    const scopes = await seedScopes(6);
    const repository = new ChatStateV2Repository({
      resolvePaths: (target): ReturnType<typeof pathsFor> =>
        pathsFor(target.worktreeId),
    });
    const output = 'kept output\n'.repeat(9000);
    for (const scope of scopes) {
      await repository.getState(scope);
      for (const chatId of CHATS)
        await repository.transact(
          scope,
          [
            {
              type: 'message.upserted',
              chatId,
              message: toolMessage(chatId, output),
            },
          ],
          { source: 'provider' },
        );
    }
    await settle();
    const scans = jest.spyOn(
      ChatTranscriptLog.prototype,
      'artifactReferenceSlice',
    );

    // Twelve clean chats outnumber the eight shared slots.
    for (let round = 0; round < 3; round++)
      for (const scope of scopes)
        for (const chatId of CHATS) {
          await repository.transact(
            scope,
            [
              {
                type: 'runtime.patched',
                chatId,
                runtime: { status: 'completed', queuedMessageIds: [] },
              },
            ],
            { source: 'provider' },
          );
          await settle();
        }

    expect(scans).not.toHaveBeenCalled();
    expect(await outputCount(scopes)).toBe(scopes.length * CHATS.length);
    await repository.drainAll();
  }, 120_000);
});
