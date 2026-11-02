import { watch } from 'node:fs';
import { lstat } from 'node:fs/promises';
import {
  allocateAttachmentsRootId,
  createFilesystemWatchRegistry,
  createWorkerFilesystemWatchHandler,
  filesystemWatchError,
  type FilesystemNativeWatch,
  type FilesystemWatchDiagnostic,
  type FilesystemWatchRegistry,
  type FilesystemWatchResolutionPort,
  type FilesystemWatchTarget,
  type FilesystemWatchUnavailablePolicy,
  type WorkerFilesystemWatchHandler,
} from '@canopy/core-runtime/node';
import {
  CanopyOperationError,
  type CanopyHandlerContext,
} from '@canopy/core-runtime';
import {
  SHARED_CONTAINER_VIEWER_PROJECT_ID,
  WORKSPACE_ROOT_REPO_ID,
} from '@canopy/desktop-shared/types';
import {
  getFileBrowserRoots,
  getFileBrowserSupplementalWatchPaths,
  type FileBrowserRoot,
  type FileBrowserRootsResult,
} from '../lib/file-browser-roots';
import { logMainProcessWarn } from '../lib/main-process-logging';
import { getWorkspaceWorktreeDir } from '../lib/paths';
import { validateId } from '../lib/validation';
import {
  isWatchFallbackError,
  warnWatchUnavailableOnce,
} from '../lib/worktree-watch-recovery';
import {
  requireDesktopScope,
  translateFilesServiceError,
  WorkerFilesystemAdapterError,
} from './worker-filesystem-adapter';

export interface WorkerFilesystemWatchServices {
  getFileBrowserRoots(
    projectId: string,
    worktreeId: string,
  ): Promise<FileBrowserRootsResult>;
  getSupplementalWatchPaths(projectId: string, worktreeId: string): string[];
  /** The checkout's `HEAD` file, resolved through a `.git` file or directory. */
  getGitHeadPath(repoPath: string): Promise<string>;
  /** `git rev-parse --git-dir` succeeds in the directory. */
  isGitCheckout(path: string): Promise<boolean>;
  /**
   * The checkout of a multi-repo worktree's `repos/<name>` directory when
   * the worktree's repo entries list it, else null.
   */
  findRepositoryCheckoutPath(
    projectId: string,
    worktreeId: string,
    name: string,
  ): Promise<string | null>;
}

export interface WorkerFilesystemWatchAdapterOptions {
  services?: WorkerFilesystemWatchServices;
  watch?: FilesystemNativeWatch;
  lstat?: (path: string) => Promise<unknown>;
  onAttached?: (context: CanopyHandlerContext) => void;
  onAttachFailed?: (context: CanopyHandlerContext, error: unknown) => void;
  onDiagnostic?: (diagnostic: FilesystemWatchDiagnostic) => void;
  unavailable?: FilesystemWatchUnavailablePolicy;
}

export interface WorkerFilesystemWatchAdapter {
  handlers: { 'worker.filesystem.watch': WorkerFilesystemWatchHandler };
  registry: FilesystemWatchRegistry;
}

const DEFAULT_SERVICES: WorkerFilesystemWatchServices = {
  getFileBrowserRoots,
  getSupplementalWatchPaths: getFileBrowserSupplementalWatchPaths,
  getGitHeadPath: async (repoPath) => {
    // Loaded on first HEAD watch so the file tree never pays for Git helpers.
    const git = await import('../lib/git');
    return (await git.getGitHeadWatchState(repoPath)).headPath;
  },
  isGitCheckout: async (path) => (await import('../lib/git')).isGitRepo(path),
  findRepositoryCheckoutPath: async (projectId, worktreeId, name) => {
    if (name === WORKSPACE_ROOT_REPO_ID) return null;
    const { listWorkspaceWorktreeRepoEntries } =
      await import('../lib/worktree-repo-entries');
    // The path comes from the listing, never from the caller's id.
    const entries = await listWorkspaceWorktreeRepoEntries(
      projectId,
      getWorkspaceWorktreeDir(projectId, worktreeId),
    ).catch(() => []);
    return entries.find((entry) => entry.repoId === name)?.repoPath ?? null;
  },
};

function toOperationError(error: unknown): unknown {
  if (error instanceof CanopyOperationError) return error;
  const translated =
    error instanceof WorkerFilesystemAdapterError
      ? error
      : translateFilesServiceError(error);
  return new CanopyOperationError(
    translated.payload,
    translated.runtimeCause ?? error,
  );
}

/**
 * Resolves watch targets from the desktop's file-browser roots. Concurrent
 * opens for one scope (the file-tree projection opens one per root) share a
 * single roots read.
 */
export function createWorkerFilesystemWatchPort(
  services: WorkerFilesystemWatchServices = DEFAULT_SERVICES,
): FilesystemWatchResolutionPort {
  const inflightRoots = new Map<string, Promise<FileBrowserRootsResult>>();
  const readRoots = (
    projectId: string,
    worktreeId: string,
  ): Promise<FileBrowserRootsResult> => {
    const key = `${projectId}/${worktreeId}`;
    const existing = inflightRoots.get(key);
    if (existing) return existing;
    const read = services.getFileBrowserRoots(projectId, worktreeId);
    inflightRoots.set(key, read);
    const forget = (): void => {
      if (inflightRoots.get(key) === read) inflightRoots.delete(key);
    };
    read.then(forget, forget);
    return read;
  };

  /**
   * A Git-aware root's checkout. Multi-repo worktrees also serve the two
   * checkouts the branch watcher always observed but the catalog does not
   * mark Git-aware (CAN-4899): a workspace root that is a Git checkout
   * without `sourceRepoPath`, and a `repos/` checkout the catalog does not
   * list (one left after `workspace:remove-repo`, or a hand-made directory),
   * matched by its directory name. That name may also be the attachments
   * root's id, which reserves only catalog ids.
   */
  const resolveGitHeadCheckout = async (
    projectId: string,
    worktreeId: string,
    roots: readonly FileBrowserRoot[],
    visible: FileBrowserRoot | undefined,
    unresolved: boolean,
    fileRootId: string,
  ): Promise<string> => {
    if (visible?.gitAware) return visible.absolutePath;
    const multiRepo = roots.some((root) => root.rootKind === 'workspace-root');
    const candidate =
      visible?.rootKind === 'workspace-root'
        ? visible.absolutePath
        : multiRepo
          ? await services.findRepositoryCheckoutPath(
              projectId,
              worktreeId,
              fileRootId,
            )
          : null;
    if (candidate !== null && (await services.isGitCheckout(candidate)))
      return candidate;
    if (unresolved) throw filesystemWatchError('notFound');
    throw filesystemWatchError(
      'invalidState',
      'Only a Git-aware root has a HEAD to watch.',
    );
  };

  const resolveTarget = async (
    request: Parameters<FilesystemWatchResolutionPort['resolveWatchTarget']>[0],
  ): Promise<FilesystemWatchTarget> => {
    const { projectId, worktreeId } = requireDesktopScope(request.scope);
    validateId(projectId, 'projectId');
    validateId(worktreeId, 'worktreeId');
    // Replica promotion already emits shared-containers:replica-changed.
    // Native watchers would pin an obsolete sealed revision while it is pruned.
    if (projectId === SHARED_CONTAINER_VIEWER_PROJECT_ID)
      return { kind: 'inert' };
    const { roots } = await readRoots(projectId, worktreeId);
    const supplemental = services.getSupplementalWatchPaths(
      projectId,
      worktreeId,
    );
    const visible = roots.find((root) => root.repoId === request.fileRootId);
    const hiddenAttachmentsPath =
      !visible &&
      supplemental.length > 0 &&
      !roots.some((root) => root.rootKind === 'attachments') &&
      request.fileRootId ===
        allocateAttachmentsRootId(new Set(roots.map((root) => root.repoId)))
        ? supplemental[0]
        : undefined;
    const rootPath = visible?.absolutePath ?? hiddenAttachmentsPath;
    if (request.subject === 'gitHead') {
      const checkoutPath = await resolveGitHeadCheckout(
        projectId,
        worktreeId,
        roots,
        visible,
        rootPath === undefined,
        request.fileRootId,
      );
      try {
        return {
          kind: 'gitHead',
          headPath: await services.getGitHeadPath(checkoutPath),
        };
      } catch (error) {
        throw filesystemWatchError(
          'invalidState',
          'The root has no readable Git HEAD.',
          error,
        );
      }
    }
    if (rootPath === undefined) throw filesystemWatchError('notFound');
    return {
      kind: 'tree',
      rootPath,
      rootMayBeAbsent:
        hiddenAttachmentsPath !== undefined ||
        visible?.rootKind === 'attachments',
      scopePaths: [
        ...roots.map((root) => ({
          path: root.absolutePath,
          mayBeAbsent: false,
        })),
        ...supplemental.map((path) => ({ path, mayBeAbsent: true })),
      ],
    };
  };

  return {
    resolveWatchTarget: async (request): Promise<FilesystemWatchTarget> => {
      try {
        return await resolveTarget(request);
      } catch (error) {
        throw toOperationError(error);
      }
    },
  };
}

const nodeWatch: FilesystemNativeWatch = (path, options, listener) =>
  watch(path, options, listener);

// CAN-3190's codes and session warning. The tree does not poll: the
// registry's retry and `overflow` already make each subscriber rescan. Only
// `gitHead` streams attach shallow anchors; the branch observer polls those.
const WORKTREE_WATCH_UNAVAILABLE: FilesystemWatchUnavailablePolicy = {
  matches: isWatchFallbackError,
  report: (error, anchor) => {
    logMainProcessWarn(
      anchor.recursive
        ? 'File-tree watch unavailable'
        : 'Worktree branch watch unavailable',
      { error: String(error) },
    );
    warnWatchUnavailableOnce(
      error,
      anchor.recursive ? 'file-tree' : 'worktree',
    );
  },
};

export function createWorkerFilesystemWatchAdapter(
  options: WorkerFilesystemWatchAdapterOptions = {},
): WorkerFilesystemWatchAdapter {
  const registry = createFilesystemWatchRegistry({
    watch: options.watch ?? nodeWatch,
    lstat: options.lstat ?? lstat,
    unavailable: options.unavailable ?? WORKTREE_WATCH_UNAVAILABLE,
    ...(options.onDiagnostic && { onDiagnostic: options.onDiagnostic }),
  });
  const handler = createWorkerFilesystemWatchHandler({
    registry,
    port: createWorkerFilesystemWatchPort(options.services),
    ...(options.onAttached && { onAttached: options.onAttached }),
    ...(options.onAttachFailed && { onAttachFailed: options.onAttachFailed }),
  });
  return { handlers: { 'worker.filesystem.watch': handler }, registry };
}
