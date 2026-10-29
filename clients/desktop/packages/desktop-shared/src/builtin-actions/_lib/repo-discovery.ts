import { execFile } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { getRepoRootFromWorktree } from '@canopy/desktop-shared/lib/git';
import { getGitExecutableCommand } from '@canopy/desktop-shared/lib/git-executable';
import {
  WORKSPACE_ROOT_REPO_ID,
  WORKSPACE_ROOT_REPO_NAME,
} from '@canopy/desktop-shared/types';

const execFileAsync = promisify(execFile);
const MAX_BUFFER_BYTES = 1024 * 1024 * 8;

export interface DiscoveredRepo {
  repoId: string;
  repoName: string;
  repoPath: string;
  relativePath: string;
}

async function isGitRepository(repoPath: string): Promise<boolean> {
  try {
    await execFileAsync(
      getGitExecutableCommand(process.env),
      ['rev-parse', '--show-toplevel'],
      {
        cwd: repoPath,
        maxBuffer: MAX_BUFFER_BYTES,
        windowsHide: process.platform === 'win32',
      },
    );
    return true;
  } catch {
    return false;
  }
}

function compareRepos(left: DiscoveredRepo, right: DiscoveredRepo): number {
  return left.relativePath.localeCompare(right.relativePath);
}

async function resolveSingleRepoIdentity(
  rootDir: string,
): Promise<Pick<DiscoveredRepo, 'repoId' | 'repoName'>> {
  const repoRoot = await getRepoRootFromWorktree(rootDir).catch(() => rootDir);
  const repoName = basename(repoRoot);
  return {
    repoId: repoName,
    repoName,
  };
}

export async function discoverWorkspaceRepos(
  rootDir: string = process.cwd(),
): Promise<DiscoveredRepo[]> {
  const childRepos: DiscoveredRepo[] = [];
  const reposDir = join(rootDir, 'repos');
  const repoEntries = await readdir(reposDir, { withFileTypes: true }).catch(
    () => [],
  );

  for (const entry of repoEntries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const repoPath = join(reposDir, entry.name);
    if (!(await isGitRepository(repoPath))) {
      continue;
    }

    childRepos.push({
      repoId: entry.name,
      repoName: entry.name,
      repoPath,
      relativePath: `repos/${entry.name}`,
    });
  }

  const repos: DiscoveredRepo[] = [];
  if (await isGitRepository(rootDir)) {
    const rootRepoIdentity =
      childRepos.length > 0
        ? {
            repoId: WORKSPACE_ROOT_REPO_ID,
            repoName: WORKSPACE_ROOT_REPO_NAME,
          }
        : await resolveSingleRepoIdentity(rootDir);
    repos.push({
      repoId: rootRepoIdentity.repoId,
      repoName: rootRepoIdentity.repoName,
      repoPath: rootDir,
      relativePath: '.',
    });
  }

  repos.push(...childRepos.sort(compareRepos));

  if (repos.length === 0) {
    throw new Error(
      'No git repositories were discovered in the project root or repos/ directory.',
    );
  }

  return repos;
}
