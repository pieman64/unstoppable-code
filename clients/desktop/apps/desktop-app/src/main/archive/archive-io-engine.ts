import { ChatStorageV2 } from '../lib/chat-storage-v2';
import {
  copyArchivePayload,
  removeArchiveDirectory,
  resetArchiveDirectory,
} from './archive-file-operations';
import {
  completeArchiveGitCapture,
  captureArchiveGit,
  deleteArchiveBranches,
  measureArchiveDiskUsage,
  prepareArchiveTeardown,
  removeArchiveWorktree,
  type ArchiveChildObserver,
} from './archive-git-operations';
import type {
  ArchiveIoOperationRequest,
  ArchiveIoResultMap,
  ArchiveIoOperationType,
} from './archive-io-protocol';

export interface ArchiveIoEngineHooks {
  progress(stage: string, counts?: { files?: number; bytes?: number }): void;
  child: ArchiveChildObserver;
}

function chatStorage(descriptor: {
  workspaceRoot: string;
  scopeId: string;
  legacyPaths?: readonly string[];
}): ChatStorageV2 {
  return new ChatStorageV2(
    descriptor.workspaceRoot,
    descriptor.scopeId,
    descriptor.legacyPaths,
  );
}

export function executeArchiveIoRequest<T extends ArchiveIoOperationType>(
  request: Extract<ArchiveIoOperationRequest, { type: T }>,
  signal: AbortSignal,
  hooks: ArchiveIoEngineHooks,
): Promise<ArchiveIoResultMap[T]>;
export async function executeArchiveIoRequest(
  request: ArchiveIoOperationRequest,
  signal: AbortSignal,
  hooks: ArchiveIoEngineHooks,
): Promise<ArchiveIoResultMap[ArchiveIoOperationType]> {
  if (signal.aborted) throw new Error('Archive I/O request cancelled.');
  hooks.progress('started');
  switch (request.type) {
    case 'copy-chat-storage': {
      const source = chatStorage(request.input.source);
      const destination = chatStorage(request.input.destination);
      await source.copyTo(destination);
      if (signal.aborted) throw new Error('Archive I/O request cancelled.');
      hooks.progress('chat-storage-copied');
      return { copied: true };
    }
    case 'copy-payload': {
      const result = await copyArchivePayload({
        ...request.input,
        signal,
        onProgress: (counts) => hooks.progress('payload-copying', counts),
      });
      return result;
    }
    case 'capture-git':
      return captureArchiveGit({
        ...request.input,
        signal,
        child: hooks.child,
        onProgress: (stage) => hooks.progress(stage),
      });
    case 'complete-git-capture':
      await completeArchiveGitCapture(request.input);
      return { completed: true };
    case 'prepare-teardown':
      return prepareArchiveTeardown({
        ...request.input,
        signal,
        child: hooks.child,
      });
    case 'remove-worktree':
      await removeArchiveWorktree({
        ...request.input,
        signal,
        child: hooks.child,
      });
      return { removed: true };
    case 'remove-directory':
      await removeArchiveDirectory({ ...request.input, signal });
      return { removed: true };
    case 'reset-directory': {
      const removedEntries = await resetArchiveDirectory({
        ...request.input,
        signal,
      });
      return { removedEntries };
    }
    case 'delete-branches': {
      const deleted = await deleteArchiveBranches({
        ...request.input,
        signal,
        child: hooks.child,
      });
      return { deleted };
    }
    case 'measure-disk-usage':
      return measureArchiveDiskUsage({
        ...request.input,
        signal,
        child: hooks.child,
      });
  }
}
