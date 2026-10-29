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
