import {
  copyFile,
  link,
  mkdir,
  readFile,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { basename, join } from 'node:path';

/** Member repositories live under `repos/` and are never tracked. */
export const WORKSPACE_SOURCE_REPO_GITIGNORE_ENTRY = 'repos/';

export const WORKSPACE_SOURCE_REPO_INITIAL_COMMIT_MESSAGE =
  'Initialize project source repo';

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export function sanitizeWorkspaceSourceRepoName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) {
    return 'workspace';
  }

  return basename(
    trimmed
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, ''),
  );
}

/** Returns `<baseDir>/<preferredName>`, suffixed `-2`, `-3`, … until free. */
export async function findAvailableWorkspaceSourceRepoPath(
  baseDir: string,
  preferredName: string,
): Promise<string> {
  let candidate = join(baseDir, preferredName);
  let suffix = 2;

  while (await pathExists(candidate)) {
    candidate = join(baseDir, `${preferredName}-${suffix}`);
    suffix += 1;
  }

  return candidate;
}

/**
 * Creates `<baseDir>/<preferredName>`, suffixed `-2`, `-3`, … past any entry
 * that already exists (including a dangling symlink), so a concurrent writer
 * in another process cannot claim the same path.
 */
export async function reserveWorkspaceSourceRepoPath(
  baseDir: string,
  preferredName: string,
): Promise<string> {
  await mkdir(baseDir, { recursive: true });
  for (let suffix = 1; ; suffix += 1) {
    const candidate = join(
      baseDir,
      suffix === 1 ? preferredName : `${preferredName}-${suffix}`,
    );
    try {
      await mkdir(candidate);
      return candidate;
    } catch (error) {
      if (
        typeof error !== 'object' ||
        error === null ||
        Reflect.get(error, 'code') !== 'EEXIST'
      ) {
        throw error;
      }
    }
  }
}

/**
 * Adds `AGENTS.md` beside a new `CLAUDE.md` in an empty source repo: a
 * relative symlink, or a hard link or copy where symlinks are not permitted.
 * The desktop's `ensureAgentsMdSymlink` also prefers the hard link on Windows;
 * both converge on the PlatformServices link method.
 */
export async function linkAgentsMdToClaudeMd(dir: string): Promise<void> {
  const agentsMdPath = join(dir, 'AGENTS.md');
  try {
    await symlink('CLAUDE.md', agentsMdPath);
  } catch (error) {
    const code: unknown =
      typeof error === 'object' && error !== null
        ? Reflect.get(error, 'code')
        : undefined;
    if (code !== 'EPERM' && code !== 'EACCES' && code !== 'ENOTSUP') {
      throw error;
    }
    const claudeMdPath = join(dir, 'CLAUDE.md');
    try {
      await link(claudeMdPath, agentsMdPath);
    } catch {
      await copyFile(claudeMdPath, agentsMdPath);
    }
  }
}

export async function gitignoreContainsReposEntry(
  repoPath: string,
): Promise<boolean> {
  const gitignorePath = join(repoPath, '.gitignore');
  if (!(await pathExists(gitignorePath))) {
    return false;
  }

  const content = await readFile(gitignorePath, 'utf8');
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .includes(WORKSPACE_SOURCE_REPO_GITIGNORE_ENTRY);
}

export async function ensureGitignoreContainsReposEntry(
  repoPath: string,
): Promise<void> {
  const gitignorePath = join(repoPath, '.gitignore');
  const existing = (await pathExists(gitignorePath))
    ? await readFile(gitignorePath, 'utf8')
    : '';

  const lines = existing
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.includes(WORKSPACE_SOURCE_REPO_GITIGNORE_ENTRY)) {
    return;
  }

  const eol = existing.includes('\r\n') ? '\r\n' : '\n';
  const nextContent =
    existing.length === 0
      ? `${WORKSPACE_SOURCE_REPO_GITIGNORE_ENTRY}${eol}`
      : existing.endsWith('\n')
        ? `${existing}${WORKSPACE_SOURCE_REPO_GITIGNORE_ENTRY}${eol}`
        : `${existing}${eol}${WORKSPACE_SOURCE_REPO_GITIGNORE_ENTRY}${eol}`;

  await writeFile(gitignorePath, nextContent, 'utf8');
}
