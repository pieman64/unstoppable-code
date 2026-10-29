import { shell, type IpcMainInvokeEvent } from 'electron';
import { posix, win32 } from 'node:path';
import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';
import { CanopyOperationError } from '@canopy/core-runtime';
import {
  IPC_CHANNELS,
  type FileIndexRequest,
  type FileIndexResponse,
  type FileTreeDirectoryRequest,
  type FileTreeDirectoryResponse,
  type FileTreeMutationRequest,
  type FileTreeMutationResponse,
  type FileTreeRootsRequest,
  type FileTreeRootsResponse,
} from '@canopy/desktop-shared/types';
import type { DesktopCanopyDispatcher } from '../canopy-runtime/desktop-runtime';
import { buildFileIndexes, mutateFileTree } from '../services/files-service';
import {
  startFileTreeWatch,
  stopAllFileTreeWatches,
  stopFileTreeWatch,
} from '../services/file-tree-watch-service';
import { registerIpcHandler } from './register';
import { sendToWebContents } from '../lib/web-contents-send';

export type DesktopIpcCallerResolver = (
  event: IpcMainInvokeEvent,
) => CanopyCallerDescriptor;

function rethrowLegacyFileTreeError(error: unknown): never {
  if (error instanceof CanopyOperationError) {
    if (error.runtimeCause instanceof Error) {
      throw error.runtimeCause;
    }
    throw new Error(error.payload.message);
  }
  throw error;
}

const fileTreeTeardownSenders = new Set<number>();

function resolveLegacyRootPaths(
  response: FileTreeRootsResponse,
): ReadonlyMap<string, string> {
  const { roots } = response;
  return new Map(roots.map((root) => [root.repoId, root.absolutePath]));
}

function requireLegacyRootPath(
  rootPaths: ReadonlyMap<string, string>,
  fileRootId: string,
): string {
  const rootPath = rootPaths.get(fileRootId);
  if (rootPath === undefined) {
    throw new Error(`Unable to resolve local file root: ${fileRootId}`);
  }
  return rootPath;
}

function requireLegacyEntryPath(
  legacyEntries: ReadonlyMap<string, string>,
  relativePath: string,
): string {
  const isWindows = process.platform === 'win32';
  const normalizedInput = isWindows
    ? relativePath.replace(/\\/g, '/')
    : relativePath;
  if (
    (isWindows && win32.isAbsolute(relativePath)) ||
    posix.isAbsolute(normalizedInput) ||
    normalizedInput.split('/').some((segment) => segment === '..')
  ) {
    throw new Error('Invalid canonical file-tree relative path.');
  }
  const absolutePath = legacyEntries.get(relativePath);
  if (absolutePath === undefined) {
    throw new Error(`Unable to resolve local file-tree entry: ${relativePath}`);
  }
  return absolutePath;
}

export function registerFileTreeHandlers(
  dispatcher: DesktopCanopyDispatcher,
  resolveCaller: DesktopIpcCallerResolver,
): void {
  registerIpcHandler<[FileIndexRequest], FileIndexResponse>(
    IPC_CHANNELS.fileIndexGet,
    async (_event, request) => buildFileIndexes(request),
  );

  registerIpcHandler<[FileTreeRootsRequest], FileTreeRootsResponse>(
    IPC_CHANNELS.fileTreeRoots,
    async (event, request) => {
      try {
        const { canonicalResult, legacyResult } =
          await dispatcher.queryFileTreeRootsForLegacyIpc(
            {
              scope: {
                workspaceId: request.projectId,
                worktreeId: request.worktreeId,
              },
            },
            { caller: resolveCaller(event) },
            { sender: event.sender },
          );
        const rootPaths = resolveLegacyRootPaths(legacyResult);
        return {
          roots: canonicalResult.roots.map((root) => ({
            repoId: root.fileRootId,
            repoName: root.name,
            absolutePath: requireLegacyRootPath(rootPaths, root.fileRootId),
            rootKind: root.kind,
          })),
        };
      } catch (error) {
        return rethrowLegacyFileTreeError(error);
      }
    },
  );

  registerIpcHandler<[FileTreeDirectoryRequest], FileTreeDirectoryResponse>(
    IPC_CHANNELS.fileTreeDirectory,
    async (event, request) => {
      try {
        const { canonicalResult, legacyResult } =
          await dispatcher.queryFileTreeDirectoryForLegacyIpc(
            {
              scope: {
                workspaceId: request.projectId,
                worktreeId: request.worktreeId,
              },
              fileRootId: request.repoId,
              relativePath: request.relativeDir,
            },
            { caller: resolveCaller(event) },
            { sender: event.sender },
          );
        const legacyEntryPaths = new Map(
          legacyResult.entries.map((entry) => [
            entry.relativePath,
            entry.absolutePath,
          ]),
        );
        return {
          entries: canonicalResult.entries.map((entry) => ({
            name: entry.name,
            relativePath: entry.relativePath,
            absolutePath: requireLegacyEntryPath(
              legacyEntryPaths,
              entry.relativePath,
            ),
            kind: entry.kind,
            isIgnored: entry.isIgnored,
            isIndexExcluded: entry.isIndexExcluded,
            isSymlink: entry.isSymlink,
            hasChildren: entry.hasChildren,
          })),
        };
      } catch (error) {
        return rethrowLegacyFileTreeError(error);
      }
    },
  );

  registerIpcHandler<[FileTreeMutationRequest], FileTreeMutationResponse>(
    IPC_CHANNELS.fileTreeMutate,
    async (_event, request) =>
      mutateFileTree(request, {
        trashItem: (absolutePath) => shell.trashItem(absolutePath),
      }),
  );

  registerIpcHandler<[FileTreeRootsRequest], void>(
    IPC_CHANNELS.fileTreeWatchStart,
    async (event, request) => {
      const ownerId = event.sender.id;
      if (!fileTreeTeardownSenders.has(ownerId)) {
        fileTreeTeardownSenders.add(ownerId);
        event.sender.once('destroyed', () => {
          fileTreeTeardownSenders.delete(ownerId);
          stopAllFileTreeWatches(ownerId);
        });
      }
      await startFileTreeWatch(ownerId, request, (changeEvent) => {
        if (!event.sender.isDestroyed()) {
          sendToWebContents(
            event.sender,
            IPC_CHANNELS.fileTreeChanged,
            changeEvent,
          );
        }
      });
    },
  );

  registerIpcHandler<[FileTreeRootsRequest], void>(
    IPC_CHANNELS.fileTreeWatchStop,
    (event, request) => {
      stopFileTreeWatch(event.sender.id, request);
    },
  );
}
