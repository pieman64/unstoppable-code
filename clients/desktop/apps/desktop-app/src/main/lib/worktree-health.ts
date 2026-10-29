import { execFile } from 'node:child_process';
import { lstat, readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import {
  WORKSPACE_ROOT_REPO_ID,
  WORKSPACE_ROOT_REPO_NAME,
  type WorktreeData,
  type WorktreeHealthCheckResponse,
  type WorktreeHealthIssue,
  type WorktreeHealthIssueCode,
  type WorktreeHealthRepoIssue,
} from '@canopy/desktop-shared/types';
import { getResolvedGitExecutableForSpawn } from './git-executable';
import { resolveWorktreeCwd } from './resolve-worktree';
import {
  readWorkspaceWorktrees,
  readWorkspaceConfig,
} from './workspace-persistence';
import { recordWorktreeHealth } from './worktree-repair';
import {
  listWorkspaceWorktreeRepoEntries,
  type WorktreeRepoEntry,
} from './worktree-repo-entries';

const GIT_HEALTH_TIMEOUT_MS = 5000;

interface RepoHealthSuccess {
  ok: true;
}

interface RepoHealthFailure {
  ok: false;
  code: WorktreeHealthIssueCode;
  message: string;
  gitError?: string;
  shouldConfirmWithGit?: boolean;
}

type RepoHealthResult = RepoHealthSuccess | RepoHealthFailure;

function issueMessage(code: WorktreeHealthIssueCode): string {
  switch (code) {
    case 'missing-worktree-path':
      return 'Worktree directory does not exist.';
    case 'missing-git-metadata':
      return 'Git metadata is missing for this worktree.';
    case 'invalid-git-worktree':
      return 'Git metadata for this worktree is incomplete or points to a missing location.';
    case 'missing-repository':
      return 'One or more repositories in this project are missing.';
    case 'git-error':
      return 'Git could not validate this worktree.';
  }
}

async function inspectGitMetadata(repoPath: string): Promise<RepoHealthResult> {
  const dirStat = await stat(repoPath).catch(() => null);
  if (!dirStat?.isDirectory()) {
    return {
      ok: false,
      code: 'missing-worktree-path',
      message: issueMessage('missing-worktree-path'),
    };
  }

  const dotGitPath = join(repoPath, '.git');
  const dotGitStat = await lstat(dotGitPath).catch(() => null);

  if (!dotGitStat) {
    return {
      ok: false,
      code: 'missing-git-metadata',
      message: issueMessage('missing-git-metadata'),
    };
  }

  if (dotGitStat.isDirectory()) {
    return {
      ok: false,
      code: 'invalid-git-worktree',
      message: issueMessage('invalid-git-worktree'),
      shouldConfirmWithGit: true,
    };
  }

  if (dotGitStat.isFile()) {
    const raw = await readFile(dotGitPath, 'utf8').catch(() => '');
    const match = /^gitdir:\s*(.+)\s*$/m.exec(raw);
    const gitDirValue = match?.[1];
    if (!gitDirValue) {
      return {
        ok: false,
        code: 'invalid-git-worktree',
        message: issueMessage('invalid-git-worktree'),
      };
    }

    const gitDir = isAbsolute(gitDirValue)
      ? gitDirValue
      : resolve(repoPath, gitDirValue);

    const gitDirStat = await stat(gitDir).catch(() => null);
    if (!gitDirStat) {
      return {
        ok: false,
        code: 'invalid-git-worktree',
        message: issueMessage('invalid-git-worktree'),
        gitError: `Missing gitdir target: ${gitDir}`,
      };
    }
    if (!gitDirStat.isDirectory()) {
      return {
        ok: false,
        code: 'invalid-git-worktree',
        message: issueMessage('invalid-git-worktree'),
        gitError: `Invalid gitdir target: ${gitDir}`,
        shouldConfirmWithGit: true,
      };
    }

    return {
      ok: false,
      code: 'invalid-git-worktree',
      message: issueMessage('invalid-git-worktree'),
      shouldConfirmWithGit: true,
    };
  }

  return {
    ok: false,
    code: 'invalid-git-worktree',
    message: issueMessage('invalid-git-worktree'),
    shouldConfirmWithGit: true,
  };
}

async function runGitBounded(args: string[], cwd: string): Promise<string> {
  const executable = await getResolvedGitExecutableForSpawn();
  return await new Promise<string>((resolvePromise, reject) => {
    const child = execFile(
      executable,
      args,
      { cwd, timeout: GIT_HEALTH_TIMEOUT_MS, windowsHide: true },
      (error, stdout: string | Buffer, stderr: string | Buffer) => {
        if (error) {
          const stderrText =
            typeof stderr === 'string' ? stderr : stderr.toString('utf8');
          const message =
            error instanceof Error ? error.message : 'Git health check failed';
          reject(
            new Error(
              stderrText.trim() ? `${message}\n${stderrText.trim()}` : message,
            ),
          );
          return;
        }
        resolvePromise(
          typeof stdout === 'string' ? stdout : stdout.toString('utf8'),
        );
      },
    );
    void child;
  });
}

async function confirmWithGit(repoPath: string): Promise<RepoHealthResult> {
  try {
    const stdout = await runGitBounded(
      ['rev-parse', '--is-inside-work-tree'],
      repoPath,
    );
    return stdout.trim() === 'true'
      ? { ok: true }
      : {
          ok: false,
          code: 'invalid-git-worktree',
          message: issueMessage('invalid-git-worktree'),
        };
  } catch (error) {
    return {
      ok: false,
      code: 'git-error',
      message: issueMessage('git-error'),
      gitError: error instanceof Error ? error.message : String(error),
    };
  }
}

async function validateRepoPath(repoPath: string): Promise<RepoHealthResult> {
  const result = await inspectGitMetadata(repoPath);
  if (result.ok || !result.shouldConfirmWithGit) {
    return result;
  }
  return confirmWithGit(repoPath);
}

function toRepoIssue(
  entry: WorktreeRepoEntry,
  result: RepoHealthFailure,
): WorktreeHealthRepoIssue {
  return {
    repoId: entry.repoId,
    repoName: entry.repoName,
    repoPath: entry.repoPath,
    code: result.code,
    message: result.message,
    gitError: result.gitError,
  };
}

function createIssue(params: {
  code: WorktreeHealthIssueCode;
  worktreePath: string;
  gitError?: string;
  repoIssues?: WorktreeHealthRepoIssue[];
}): WorktreeHealthIssue {
  return {
    status: 'broken',
    code: params.code,
    message: issueMessage(params.code),
    checkedAt: new Date().toISOString(),
    worktreePath: params.worktreePath,
    gitError: params.gitError,
    repoIssues: params.repoIssues,
  };
}

function createMissingRepoIssue(params: {
  repoId: string;
  repoName: string;
  repoPath: string;
}): WorktreeHealthRepoIssue {
  return {
    repoId: params.repoId,
    repoName: params.repoName,
    repoPath: params.repoPath,
    code: 'missing-repository',
    message: 'Repository directory is missing from this worktree.',
  };
}

function aggregateRepoIssues(
  worktreePath: string,
  repoIssues: WorktreeHealthRepoIssue[],
): WorktreeHealthIssue | null {
  if (repoIssues.length === 0) {
    return null;
  }

  const firstIssue = repoIssues[0];
  const code = repoIssues.some((issue) => issue.code === 'missing-repository')
    ? 'missing-repository'
    : (firstIssue?.code ?? 'git-error');
  const onlyIssue = repoIssues.length === 1 ? firstIssue : undefined;

  return createIssue({
    code,
    worktreePath,
    gitError: onlyIssue?.gitError,
    repoIssues,
  });
}

async function createBestEffortWorktree(
  projectId: string,
  worktreeId: string,
  healthIssue: WorktreeHealthIssue | null,
): Promise<WorktreeData> {
  const worktrees = await readWorkspaceWorktrees(projectId).catch(() => []);
  const existing = worktrees.find((worktree) => worktree.id === worktreeId);
  const base: WorktreeData = existing ?? {
    id: worktreeId,
    branchName: worktreeId,
    createdAt: new Date().toISOString(),
  };

  if (healthIssue) {
    return { ...base, healthIssue };
  }

  const next: WorktreeData = { ...base };
  delete next.healthIssue;
  delete next.splitRecoveryRequired;
  return next;
}

export async function validateWorktreeHealth(
  projectId: string,
  worktreeId: string,
): Promise<WorktreeHealthIssue | null> {
  const worktreePath = resolveWorktreeCwd(projectId, worktreeId);
  const config = await readWorkspaceConfig(projectId);

  if (config.type === 'single-repo') {
    const result = await validateRepoPath(worktreePath);
    if (result.ok) {
      return null;
    }
    return createIssue({
      code: result.code,
      worktreePath,
      gitError: result.gitError,
    });
  }

  const worktreeRootStat = await stat(worktreePath).catch(() => null);
  if (!worktreeRootStat?.isDirectory()) {
    return createIssue({
      code: 'missing-worktree-path',
      worktreePath,
    });
  }

  const repoIssues: WorktreeHealthRepoIssue[] = [];
  const entries = await listWorkspaceWorktreeRepoEntries(
    projectId,
    worktreePath,
  );
  const presentRepoIds = new Set(entries.map((entry) => entry.repoId));
  const persistedWorktree = (
    await readWorkspaceWorktrees(projectId).catch(() => [])
  ).find((worktree) => worktree.id === worktreeId);
  const includedRepoIds = persistedWorktree?.includedRepoIds;
  const expectedRepoIds =
    includedRepoIds === undefined ? null : new Set(includedRepoIds);

  for (const configured of config.repos) {
    if (expectedRepoIds && !expectedRepoIds.has(configured.id)) {
      continue;
    }
    if (!presentRepoIds.has(configured.id)) {
      repoIssues.push(
        createMissingRepoIssue({
          repoId: configured.id,
          repoName: configured.name || configured.id,
          repoPath: join(worktreePath, 'repos', configured.id),
        }),
      );
    }
  }

  for (const entry of entries) {
    if (entry.repoId === WORKSPACE_ROOT_REPO_ID) {
      continue;
    }
    if (expectedRepoIds && !expectedRepoIds.has(entry.repoId)) {
      // Explicitly scoped worktrees may carry user-owned payload directories
      // beneath repos/. Only configured, included checkout ids are Git repos.
      continue;
    }
    const result = await validateRepoPath(entry.repoPath);
    if (!result.ok) {
      repoIssues.push(toRepoIssue(entry, result));
    }
  }

  if (config.sourceRepoPath) {
    const result = await validateRepoPath(worktreePath);
    if (!result.ok) {
      repoIssues.push(
        toRepoIssue(
          {
            repoId: WORKSPACE_ROOT_REPO_ID,
            repoName: WORKSPACE_ROOT_REPO_NAME,
            repoPath: worktreePath,
          },
          result,
        ),
      );
    }
  }

  return aggregateRepoIssues(worktreePath, repoIssues);
}

export async function retryWorktreeHealthCheck(
  projectId: string,
  worktreeId: string,
): Promise<WorktreeHealthCheckResponse> {
  const issue = await validateWorktreeHealth(projectId, worktreeId);
  const recorded = await recordWorktreeHealth({
    source: 'health-check',
    workspaceId: projectId,
    worktreeId,
    issue,
  });
  const worktree =
    recorded.worktree ??
    (await createBestEffortWorktree(projectId, worktreeId, issue));
  return issue
    ? { healthy: false, worktree, issue }
    : { healthy: true, worktree };
}
