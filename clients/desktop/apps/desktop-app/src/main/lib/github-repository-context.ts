import { getRemoteUrl, getRemoteUrlStrict, isGitRepo } from './git';
import { getWorktreeDir } from './paths';
import { readWorkspaceConfigDetailed } from './workspace-persistence';
import { WorkspaceConfigUnreadableError } from './workspace-manifest-repository';
import { isCoworkWorkspace } from './workspace-registry';
import { listWorkspaceWorktreeRepoEntries } from './worktree-repo-entries';

function repositoryFromRemote(remoteUrl: string): string | null {
  const scp = remoteUrl.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/i);
  if (scp) return `${scp[1].toLowerCase()}/${scp[2].toLowerCase()}`;
  let url: URL;
  try {
    url = new URL(remoteUrl);
  } catch {
    return null;
  }
  if (url.hostname.toLowerCase() !== 'github.com') return null;
  const segments = url.pathname
    .replace(/^\//, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
    .split('/');
  if (segments.length !== 2 || segments.some((segment) => !segment))
    return null;
  return `${segments[0].toLowerCase()}/${segments[1].toLowerCase()}`;
}

async function repositoryForPath(repoPath: string): Promise<string | null> {
  const remote = await getRemoteUrl(repoPath).catch(() => null);
  return remote ? repositoryFromRemote(remote) : null;
}

/**
 * Resolve only trusted GitHub.com remotes from the active worktree context.
 * A cowork folder is not a worktree: only its own checkout is inferred, and
 * otherwise callers must name the repository.
 */
export async function resolveGitHubRepositoryCandidates(options: {
  projectId: string;
  worktreeId: string;
  cwd?: string;
}): Promise<string[]> {
  if (options.cwd && (await isGitRepo(options.cwd).catch(() => false))) {
    const active = await repositoryForPath(options.cwd);
    return active ? [active] : [];
  }
  if (isCoworkWorkspace(options.projectId)) return [];
  const worktreePath = getWorktreeDir(options.projectId, options.worktreeId);
  const entries = await listWorkspaceWorktreeRepoEntries(
    options.projectId,
    worktreePath,
  ).catch(() => []);
  const paths =
    entries.length > 0
      ? entries.map((entry) => entry.repoPath)
      : [worktreePath];
  const repositories = await Promise.all(paths.map(repositoryForPath));
  return Array.from(
    new Set(repositories.filter((entry): entry is string => entry !== null)),
  ).sort();
}

/**
 * The one GitHub repository a bare `#N` in this worktree's transcript may
 * name, or `null`. Strict where {@link resolveGitHubRepositoryCandidates} is
 * best-effort: only a single-repository workspace qualifies, so a partial
 * scan of a multi-repository worktree can never look unambiguous, and a read
 * failure throws instead of shrinking the answer.
 */
export async function resolveUnambiguousGitHubRepository(options: {
  projectId: string;
  worktreeId: string;
}): Promise<string | null> {
  if (isCoworkWorkspace(options.projectId)) return null;
  const read = await readWorkspaceConfigDetailed(options.projectId);
  if (read.authority === 'absent') return null;
  if (read.authority !== 'ok')
    throw new WorkspaceConfigUnreadableError(read.unserved, 'read');
  if (read.config.type !== 'single-repo') return null;
  const remote = await getRemoteUrlStrict(
    getWorktreeDir(options.projectId, options.worktreeId),
  );
  return remote ? repositoryFromRemote(remote) : null;
}
