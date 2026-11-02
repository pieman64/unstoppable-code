import type { WorkspaceReferenceRepoStatus } from '@canopy/desktop-shared/types';
import {
  WORKER_GIT_GRANTS,
  type CanopyCallerDescriptor,
} from '@canopy/protocol/canopy-core';
import { CanopyOperationError } from '@canopy/core-runtime';
import { LOCAL_DESKTOP_AUTHORITY_ID } from '../canopy-runtime/desktop-runtime-identity';
import {
  legacyOriginUrl,
  queryGitRemoteAtLocation,
  type GitRemoteLocation,
  type WorkerGitDispatcher,
} from '../canopy-runtime/worker-git-adapter';
import { ensureRepoShadow } from './repo-shadow';

// The poller's trusted main-process caller holds only the Git read it needs.
const REFERENCE_REPO_CALLER: CanopyCallerDescriptor = {
  principalId: 'local-desktop-user',
  clientInstanceId: 'electron-main-reference-repo-poller',
  authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
  interfaceKind: 'desktop',
  grants: [WORKER_GIT_GRANTS.read],
};

// Legacy callers surfaced the host error itself; the in-process binding
// keeps it as the runtime cause.
function hostCause(error: CanopyOperationError): unknown {
  return error.runtimeCause === undefined ? error : error.runtimeCause;
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Shadow sync failed';
}

type RemoteFacts =
  | { kind: 'remote'; remoteUrl: string | null; inRepository: boolean }
  | { kind: 'status'; status: WorkspaceReferenceRepoStatus | null };

/**
 * The source repository's origin through `worker.git.remote.get`, or the
 * status its refusal settles. `location` receives the resolved repository
 * and its origin URL.
 */
async function readRemoteFacts(
  dispatcher: WorkerGitDispatcher,
  workspaceId: string,
  location: GitRemoteLocation,
): Promise<RemoteFacts> {
  try {
    const result = await queryGitRemoteAtLocation(
      dispatcher,
      { scope: { workspaceId }, repository: { kind: 'source' } },
      { caller: REFERENCE_REPO_CALLER },
      location,
    );
    // Git read the remote configuration, so the location is a repository.
    // The shadow sync and the status need the URL a local remote withholds.
    return {
      kind: 'remote',
      remoteUrl: legacyOriginUrl(result, location),
      inRepository: true,
    };
  } catch (error) {
    if (!(error instanceof CanopyOperationError)) throw error;
    const { kind, code } = error.payload;
    // An unknown or malformed workspace id names no source repository.
    if (
      kind === 'invalid_argument' ||
      code === 'worker.git.remote.repositoryUnavailable'
    )
      return { kind: 'status', status: null };
    if (
      code !== 'worker.git.remote.notRepository' ||
      location.repoPath === undefined
    )
      // Git failing inside the repository, like any other failure, surfaces
      // its own error.
      throw hostCause(error);
    // No origin was listed, yet the location is no repository: the shadow
    // sync reports it, as before.
    if (error.runtimeCause === undefined)
      return { kind: 'remote', remoteUrl: null, inRepository: false };
    return {
      kind: 'status',
      status: {
        referenceRepoPath: location.repoPath,
        healthy: false,
        warnings: [
          {
            code: 'shadow-sync-failed',
            message: failureMessage(error.runtimeCause),
          },
        ],
        lastCheckedAt: new Date().toISOString(),
      },
    };
  }
}

/**
 * The workspace source repository's health. Its remote facts come from
 * `worker.git.remote.get`; the repository shadow sync stays in process
 * (CAN-4108, `repo_shadows`, CAN-4738).
 */
export async function inspectReferenceRepo(
  dispatcher: WorkerGitDispatcher,
  workspaceId: string,
): Promise<WorkspaceReferenceRepoStatus | null> {
  const location: GitRemoteLocation = {};
  const facts = await readRemoteFacts(dispatcher, workspaceId, location);
  if (facts.kind === 'status') return facts.status;
  const referenceRepoPath = location.repoPath;
  if (referenceRepoPath === undefined)
    throw new Error('The reference repository was not resolved.');
  const { remoteUrl } = facts;
  if (!remoteUrl && facts.inRepository) {
    return {
      referenceRepoPath,
      healthy: true,
      warnings: [],
      lastCheckedAt: new Date().toISOString(),
    };
  }
  try {
    // Health inspection must observe a live sync (poller ticks and
    // user-triggered refreshes both land here), so it always probes past the
    // recent-failure cache — a just-fixed remote heals immediately instead of
    // after the cache TTL.
    const shadow = await ensureRepoShadow(referenceRepoPath, {
      bypassFailureCache: true,
    });
    return {
      referenceRepoPath,
      shadowPath: shadow.shadowPath,
      healthy: true,
      warnings: [],
      lastCheckedAt: new Date().toISOString(),
      remoteUrl: remoteUrl ?? undefined,
      defaultBranch: shadow.defaultBranch,
    };
  } catch (error) {
    return {
      referenceRepoPath,
      healthy: false,
      warnings: [
        { code: 'shadow-sync-failed', message: failureMessage(error) },
      ],
      lastCheckedAt: new Date().toISOString(),
      remoteUrl: remoteUrl ?? undefined,
    };
  }
}
