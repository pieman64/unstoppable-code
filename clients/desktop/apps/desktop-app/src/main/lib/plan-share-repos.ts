import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { SINGLE_REPO_USAGE_REPO_ID } from '@canopy/desktop-shared/types';
import type { SharedPlanRepositoryRef } from '@canopy/protocol/plans';
import { getCurrentBranch, getRemoteDefaultBranch } from './git';
import { getResolvedGitExecutableForSpawn } from './git-executable';
import { getRemoteUrl } from './git';
import { readAllSidebarItems } from './sidebar-items';
import { resolveWorktreeCwd } from './resolve-worktree';
import { listWorkspaceWorktreeRepoEntries } from './worktree-repo-entries';

const execFileAsync = promisify(execFile);

interface RepoSnapshotEntry {
  repoId: string;
  repoName: string;
  repoPath: string;
}

export function sanitizeRemoteUrl(remoteUrl: string | null): string | null {
  const trimmed = remoteUrl?.trim();
  if (!trimmed) {
    return null;
  }

  if (/^(?:\/|~\/|[a-zA-Z]:|\\\\)/.test(trimmed)) {
    return null;
  }

  try {
    const url = new URL(trimmed);
    if (url.protocol === 'file:') {
      return null;
    }
    if (!url.hostname) {
      return null;
    }
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    if (isScpStyleRemote(trimmed)) {
      return sanitizeScpStyleRemote(trimmed);
    }
    return null;
  }
}

function isScpStyleRemote(value: string): boolean {
  return !value.includes('://') && /^[^:@/\s]+@[^:/\s]+:[^?#\s]+$/.test(value);
}

function sanitizeScpStyleRemote(value: string): string | null {
  const [user] = value.split('@', 1);
  return user === 'git' ? value : null;
}

async function getHeadCommitSha(repoPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      await getResolvedGitExecutableForSpawn(),
      ['rev-parse', 'HEAD'],
      {
        cwd: repoPath,
        maxBuffer: 1024 * 1024,
        windowsHide: process.platform === 'win32',
      },
    );
    const value = stdout.trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

async function nullable<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

async function snapshotEntry(
  entry: RepoSnapshotEntry,
): Promise<SharedPlanRepositoryRef> {
  const [remoteUrl, branch, defaultBranch, commitSha] = await Promise.all([
    nullable(() => getRemoteUrl(entry.repoPath)),
    nullable(() => getCurrentBranch(entry.repoPath)),
    nullable(() => getRemoteDefaultBranch(entry.repoPath)),
    getHeadCommitSha(entry.repoPath),
  ]);

  return {
    repoId: entry.repoId,
    repoName: entry.repoName,
    remoteUrl: sanitizeRemoteUrl(remoteUrl),
    branch,
    commitSha,
    defaultBranch,
  };
}

async function resolveRepoEntries(
  projectId: string,
  worktreeId: string,
): Promise<RepoSnapshotEntry[]> {
  const cwd = resolveWorktreeCwd(projectId, worktreeId);
  const { items } = await readAllSidebarItems();
  const workspace = items.find((item) => item.id === projectId);

  if (workspace?.type === 'multi-repo') {
    return listWorkspaceWorktreeRepoEntries(projectId, cwd);
  }

  return [
    {
      repoId: SINGLE_REPO_USAGE_REPO_ID,
      repoName: workspace?.name ?? projectId,
      repoPath: cwd,
    },
  ];
}

export async function buildSharedPlanRepositoryRefs(
  projectId: string,
  worktreeId: string,
): Promise<SharedPlanRepositoryRef[]> {
  const entries = await resolveRepoEntries(projectId, worktreeId);
  return Promise.all(entries.map(snapshotEntry));
}
