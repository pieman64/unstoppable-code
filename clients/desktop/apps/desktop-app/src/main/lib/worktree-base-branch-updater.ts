import {
  WORKSPACE_ROOT_REPO_ID,
  type SidebarItem,
} from '@canopy/desktop-shared/types';
import type { DependentBaseBranchUpdate } from '@canopy/desktop-shared/types/github';
import { fetchOrigin, getRemoteUrl } from './git';
import { parseGitHubRemote } from './github-pr';
import { resolveFreshDefaultBranch } from './git-default-branch';
import { readAllSidebarItems } from './sidebar-items';
import { observeWorktreeGit } from './worktree-git-observations';
import { settleAll } from '@canopy/desktop-shared/node/lib/detached-work';

interface WorkspaceRepoCandidate {
  repoId: string | null;
  repoPath: string;
}

const DEPENDENT_BASE_REF_FETCH_TIMEOUT_MS = 30_000;

export interface UpdateDependentBaseBranchesForMergedWorktreeOptions {
  mergedWorkspaceId: string;
  mergedWorktreeId: string;
  mergedRepoFullName: string;
  mergedBranchName: string;
  mergedIntoBranchName: string;
}

function normalize(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function normalizeGitHubFullName(value: string): string | null {
  const normalized = normalize(value);
  return normalized ? normalized.toLowerCase() : null;
}

function getRepoCandidates(item: SidebarItem): WorkspaceRepoCandidate[] {
  if (item.type === 'single-repo') {
    return [{ repoId: null, repoPath: item.repoPath }];
  }

  if (item.type === 'cowork') {
    return [];
  }

  const candidates: WorkspaceRepoCandidate[] = item.sourceRepoPath
    ? [
        {
          repoId: WORKSPACE_ROOT_REPO_ID,
          repoPath: item.sourceRepoPath,
        },
      ]
    : [];

  for (const repo of item.repos) {
    candidates.push({
      repoId: repo.id,
      repoPath: repo.repoPath,
    });
  }

  return candidates;
}

async function resolveRepoFullName(repoPath: string): Promise<string | null> {
  const remoteUrl = await getRemoteUrl(repoPath).catch(() => null);
  if (!remoteUrl) {
    return null;
  }

  const remote = parseGitHubRemote(remoteUrl);
  if (!remote) {
    return null;
  }

  return normalizeGitHubFullName(`${remote.owner}/${remote.repo}`);
}

export async function updateDependentBaseBranchesForMergedWorktree(
  options: UpdateDependentBaseBranchesForMergedWorktreeOptions,
): Promise<DependentBaseBranchUpdate[]> {
  const mergedRepoFullName = normalizeGitHubFullName(
    options.mergedRepoFullName,
  );
  const mergedBranchName = normalize(options.mergedBranchName);
  const mergedIntoBranchName = normalize(options.mergedIntoBranchName);
  if (!mergedRepoFullName || !mergedBranchName || !mergedIntoBranchName) {
    return [];
  }
  if (mergedBranchName === mergedIntoBranchName) {
    return [];
  }

  const { items } = await readAllSidebarItems();
  const fullNameByRepoPath = new Map<string, Promise<string | null>>();
  const defaultBranchByRepoPath = new Map<string, Promise<string | null>>();
  const updates: DependentBaseBranchUpdate[] = [];
  const updatedRepoPaths = new Set<string>();

  const getFullName = (repoPath: string): Promise<string | null> => {
    const existing = fullNameByRepoPath.get(repoPath);
    if (existing) {
      return existing;
    }
    const next = resolveRepoFullName(repoPath);
    fullNameByRepoPath.set(repoPath, next);
    return next;
  };

  const getDefaultBranch = (repoPath: string): Promise<string | null> => {
    const existing = defaultBranchByRepoPath.get(repoPath);
    if (existing) {
      return existing;
    }
    const next = resolveFreshDefaultBranch(repoPath).catch(() => null);
    defaultBranchByRepoPath.set(repoPath, next);
    return next;
  };

  for (const item of items) {
    const matchingRepoCandidates: WorkspaceRepoCandidate[] = [];
    for (const candidate of getRepoCandidates(item)) {
      const fullName = await getFullName(candidate.repoPath);
      if (
        fullName === mergedRepoFullName &&
        (await getDefaultBranch(candidate.repoPath)) !== mergedBranchName
      ) {
        matchingRepoCandidates.push(candidate);
      }
    }
    if (matchingRepoCandidates.length === 0) {
      continue;
    }

    try {
      // `internal.worktree.git.observe` moves every base of this workspace
      // that tracked the merged branch, in one locked write.
      const { updates: workspaceUpdates } = await observeWorktreeGit({
        kind: 'merged-base-retarget',
        workspaceId: item.id,
        repoIds: matchingRepoCandidates.map((candidate) => candidate.repoId),
        mergedBranchName,
        mergedIntoBranchName,
        ...(item.id === options.mergedWorkspaceId
          ? { mergedWorktreeId: options.mergedWorktreeId }
          : {}),
      });
      updates.push(...workspaceUpdates);
      if (workspaceUpdates.length > 0) {
        for (const candidate of matchingRepoCandidates) {
          if (
            workspaceUpdates.some(
              (update) => (update.repoId ?? null) === candidate.repoId,
            )
          ) {
            updatedRepoPaths.add(candidate.repoPath);
          }
        }
      }
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn(
        '[github-sync] failed to update dependent worktree base branches',
        {
          workspaceId: item.id,
          error,
        },
      );
    }
  }

  // A merge-triggered base retarget is an explicit freshness boundary, not a
  // periodic poll. Bypass the automatic-fetch TTL so the new destination ref
  // is visible before the renderer recomputes each dependent branch. Repo
  // paths are deduplicated because several dependents may share one checkout.
  await settleAll(
    Array.from(updatedRepoPaths).map((repoPath) =>
      fetchOrigin(repoPath, {
        backgroundPriority: true,
        signal: AbortSignal.timeout(DEPENDENT_BASE_REF_FETCH_TIMEOUT_MS),
      }).catch((error: unknown) => {
        // Keep the persisted base update even when the machine is offline; a
        // later automatic refresh can still reconcile the remote ref.
        // eslint-disable-next-line no-console
        console.warn(
          '[github-sync] failed to refresh a dependent worktree base ref',
          { repoPath, error },
        );
      }),
    ),
  );

  return updates;
}
