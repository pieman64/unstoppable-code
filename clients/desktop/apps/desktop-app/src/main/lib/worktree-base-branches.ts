import { basename } from 'node:path';
import {
  WORKSPACE_ROOT_REPO_ID,
  type WorktreeData,
} from '@canopy/desktop-shared/types';
import {
  doesLocalBranchExist,
  doesRemoteBranchExist,
  getCurrentBranch,
  getLocalDefaultBranch,
  getRepoRootFromWorktree,
  hasLocalCommit,
} from './git';
import { resolveFreshDefaultBranch } from './git-default-branch';
import { resolveWorktreeCwd } from './resolve-worktree';
import { listWorkspaceWorktreeRepoEntries } from './worktree-repo-entries';
import {
  readWorkspaceConfig,
  readWorkspaceWorktrees,
} from './workspace-persistence';

export interface EffectiveRepoBaseBranch {
  branch: string | null;
  existsLocally: boolean;
  existsInRemote: boolean;
}

interface WorktreeBaseBranchState {
  isMultiRepo: boolean;
  trackedBaseBranch: string | null;
  trackedRepoBaseBranches: Record<string, string>;
  hasWorkspaceRootRepo: boolean;
}

function normalizeBranchName(
  branchName: string | null | undefined,
): string | null {
  const trimmed = branchName?.trim();
  return trimmed ? trimmed : null;
}

function normalizeTrackedRepoBaseBranches(
  trackedRepoBaseBranches: WorktreeData['trackedRepoBaseBranches'],
): Record<string, string> {
  const normalized: Record<string, string> = {};

  for (const [repoId, branchName] of Object.entries(
    trackedRepoBaseBranches ?? {},
  )) {
    const normalizedBranchName = normalizeBranchName(branchName);
    if (normalizedBranchName) {
      normalized[repoId] = normalizedBranchName;
    }
  }

  return normalized;
}

async function readTrackedBaseBranchState(
  projectId: string,
  worktreeId: string,
): Promise<WorktreeBaseBranchState> {
  const [config, worktrees] = await Promise.all([
    readWorkspaceConfig(projectId),
    readWorkspaceWorktrees(projectId),
  ]);
  const worktree = worktrees.find((candidate) => candidate.id === worktreeId);

  return {
    isMultiRepo: config.type === 'multi-repo',
    trackedBaseBranch: normalizeBranchName(worktree?.trackedBaseBranch),
    trackedRepoBaseBranches: normalizeTrackedRepoBaseBranches(
      worktree?.trackedRepoBaseBranches,
    ),
    hasWorkspaceRootRepo: Boolean(config.sourceRepoPath),
  };
}

async function getSingleRepoId(repoPath: string): Promise<string> {
  const repoRoot = await getRepoRootFromWorktree(repoPath).catch(
    () => repoPath,
  );
  return basename(repoRoot);
}

async function resolveConfiguredBaseBranch(
  params: {
    projectId: string;
    worktreeId: string;
    repoId?: string;
    repoPath: string;
    allowRemoteLookup?: boolean;
  },
  state: WorktreeBaseBranchState,
): Promise<string | null> {
  if (!state.isMultiRepo) {
    if (state.trackedBaseBranch) {
      return state.trackedBaseBranch;
    }

    const remoteDefaultBranch = normalizeBranchName(
      await resolveFreshDefaultBranch(params.repoPath, {
        allowRemoteLookup: params.allowRemoteLookup,
      }).catch(() => null),
    );
    if (remoteDefaultBranch) {
      return remoteDefaultBranch;
    }

    const currentBranch = normalizeBranchName(
      await getCurrentBranch(params.repoPath).catch(() => null),
    );
    return getLocalDefaultBranch(
      params.repoPath,
      currentBranch ?? undefined,
    ).catch(() => null);
  }

  let resolvedRepoId = params.repoId;
  if (!resolvedRepoId && state.hasWorkspaceRootRepo) {
    const worktreePath = resolveWorktreeCwd(
      params.projectId,
      params.worktreeId,
    );
    if (worktreePath === params.repoPath) {
      resolvedRepoId = WORKSPACE_ROOT_REPO_ID;
    }
  }

  if (resolvedRepoId) {
    const trackedRepoBaseBranch = state.trackedRepoBaseBranches[resolvedRepoId];
    if (trackedRepoBaseBranch) {
      return trackedRepoBaseBranch;
    }
  }

  const remoteDefaultBranch = normalizeBranchName(
    await resolveFreshDefaultBranch(params.repoPath, {
      allowRemoteLookup: params.allowRemoteLookup,
    }).catch(() => null),
  );
  if (remoteDefaultBranch) {
    return remoteDefaultBranch;
  }

  const currentBranch = normalizeBranchName(
    await getCurrentBranch(params.repoPath).catch(() => null),
  );
  return getLocalDefaultBranch(
    params.repoPath,
    currentBranch ?? undefined,
  ).catch(() => null);
}
/**
 * Resolves the repo's default branch (remote default, falling back to the
 * local default) for branch-grouping in the sidebar. Returns `null` when it
 * cannot be determined. Independent of any user-configured base-branch
 * override so the default branch can be excluded from grouping even when a
 * worktree explicitly tracks it.
 */
export async function resolveRepoDefaultBranch(
  repoPath: string,
  options: { allowRemoteLookup?: boolean } = {},
): Promise<string | null> {
  const remoteDefaultBranch = normalizeBranchName(
    await resolveFreshDefaultBranch(repoPath, options).catch(() => null),
  );
  if (remoteDefaultBranch) {
    return remoteDefaultBranch;
  }

  return normalizeBranchName(
    await getLocalDefaultBranch(repoPath).catch(() => null),
  );
}

export async function resolveEffectiveBaseBranchForRepo(params: {
  projectId: string;
  worktreeId: string;
  repoId?: string;
  repoPath: string;
  allowRemoteLookup?: boolean;
}): Promise<EffectiveRepoBaseBranch> {
  const state = await readTrackedBaseBranchState(
    params.projectId,
    params.worktreeId,
  );
  const branch = await resolveConfiguredBaseBranch(params, state);
  if (!branch) {
    return { branch: null, existsLocally: false, existsInRemote: false };
  }

  const { existsLocally, existsInRemote } = await resolveBaseBranchPresence(
    params.repoPath,
    branch,
  );
  return { branch, existsLocally, existsInRemote };
}

async function resolveBaseBranchPresence(
  repoPath: string,
  branch: string,
): Promise<Pick<EffectiveRepoBaseBranch, 'existsLocally' | 'existsInRemote'>> {
  if (
    /^[a-fA-F0-9]{40}$/.test(branch) &&
    (await hasLocalCommit(repoPath, branch).catch(() => false))
  ) {
    return {
      existsLocally: true,
      existsInRemote: false,
    };
  }

  const [existsLocally, existsInRemote] = await Promise.all([
    doesLocalBranchExist(repoPath, branch).catch(() => false),
    doesRemoteBranchExist(repoPath, branch).catch(() => false),
  ]);
  return { existsLocally, existsInRemote };
}

export async function resolveEffectiveBaseBranchesForWorktree(params: {
  projectId: string;
  worktreeId: string;
  cwd: string;
  allowRemoteLookup?: boolean;
}): Promise<Record<string, EffectiveRepoBaseBranch>> {
  const state = await readTrackedBaseBranchState(
    params.projectId,
    params.worktreeId,
  );

  if (!state.isMultiRepo) {
    const repoId = await getSingleRepoId(params.cwd);
    return {
      [repoId]: await resolveEffectiveBaseBranchForRepo({
        projectId: params.projectId,
        worktreeId: params.worktreeId,
        repoPath: params.cwd,
        allowRemoteLookup: params.allowRemoteLookup,
      }),
    };
  }

  const repoEntries = await listWorkspaceWorktreeRepoEntries(
    params.projectId,
    params.cwd,
  );
  const effectiveEntries = await Promise.all(
    repoEntries.map(async (entry) => {
      const branch = await resolveConfiguredBaseBranch(
        {
          projectId: params.projectId,
          worktreeId: params.worktreeId,
          repoId: entry.repoId,
          repoPath: entry.repoPath,
          allowRemoteLookup: params.allowRemoteLookup,
        },
        state,
      );
      const { existsLocally, existsInRemote } = branch
        ? await resolveBaseBranchPresence(entry.repoPath, branch)
        : { existsLocally: false, existsInRemote: false };
      return {
        repoId: entry.repoId,
        effectiveBaseBranch: {
          branch,
          existsLocally,
          existsInRemote,
        },
      };
    }),
  );

  const effectiveByRepo: Record<string, EffectiveRepoBaseBranch> = {};
  for (const entry of effectiveEntries) {
    effectiveByRepo[entry.repoId] = entry.effectiveBaseBranch;
  }

  return effectiveByRepo;
}
