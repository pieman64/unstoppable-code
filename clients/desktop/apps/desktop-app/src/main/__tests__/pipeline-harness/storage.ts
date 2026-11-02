import { Buffer } from 'node:buffer';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { ChatQueueTarget } from '@canopy/desktop-shared/types';
import type { ChatStateV2Repository } from '../../services/chat-state-v2-repository';
import type { ChatStorageTransactionCheckpoint } from '../../services/chat-state-v2-backend';
import type {
  ChatScopeKey,
  ScopePaths,
} from '../../services/chat-state-contracts';

export interface PipelineStorageOptions {
  storageCheckpoint?: (
    point: ChatStorageTransactionCheckpoint,
  ) => Promise<void>;
}

export interface PipelineStorage {
  readonly root: string;
  readonly repository: ChatStateV2Repository;
  pathsFor(scope: ChatScopeKey): ScopePaths;
  transcriptPath(target: ChatQueueTarget): string;
  readCommittedTranscript(target: ChatQueueTarget): Buffer;
  dispose(): Promise<void>;
}

/**
 * Creates an isolated real V2 repository rooted under the test runner's
 * private TMPDIR. `ChatStorageV2.fromLegacyPaths` derives the canonical V2
 * scope directories from the matching `chats/` compatibility path.
 */
export async function createPipelineStorage(
  options: PipelineStorageOptions = {},
): Promise<PipelineStorage> {
  const configuredTempRoot = process.env.TMPDIR;
  const parent =
    configuredTempRoot && isAbsolute(configuredTempRoot)
      ? configuredTempRoot
      : tmpdir();
  const root = mkdtempSync(join(parent, 'canopy-pipeline-harness-'));
  const pathsFor = (scope: ChatScopeKey): ScopePaths => {
    const scopeId = encodeScopeId(scope);
    return {
      tabs: join(root, 'chats', `${scopeId}.json`),
      archives: join(root, 'chat-archives', `${scopeId}.json`),
      journal: join(root, 'chat-journals', `${scopeId}.jsonl`),
    };
  };
  const { ChatStateV2Repository: Repository } =
    await import('../../services/chat-state-v2-repository');
  const repository = new Repository({
    resolvePaths: pathsFor,
    ...(options.storageCheckpoint
      ? { testHooks: { storageCheckpoint: options.storageCheckpoint } }
      : {}),
  });

  return {
    root,
    repository,
    pathsFor,
    transcriptPath: (target): string => {
      return join(
        root,
        'chat-storage-v2',
        encodeScopeId({
          projectId: target.projectId,
          worktreeId: target.worktreeId,
        }),
        'transcripts',
        `${target.chatId}.jsonl`,
      );
    },
    readCommittedTranscript: (target): Buffer => {
      const path = join(
        root,
        'chat-storage-v2',
        encodeScopeId({
          projectId: target.projectId,
          worktreeId: target.worktreeId,
        }),
        'transcripts',
        `${target.chatId}.jsonl`,
      );
      return existsSync(path) ? readFileSync(path) : Buffer.alloc(0);
    },
    dispose: async (): Promise<void> => {
      try {
        await repository.drainAll();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  };
}

function encodeScopeId(scope: ChatScopeKey): string {
  return Buffer.from(
    `${scope.projectId}\u0000${scope.worktreeId}`,
    'utf8',
  ).toString('base64url');
}
