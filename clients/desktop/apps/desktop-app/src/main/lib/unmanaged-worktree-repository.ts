import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { getGitCommonDir, listRegisteredWorktreePaths } from './git';
import { isPathInside } from './path-safety';
import { isErrnoException } from './type-guards';

export type UnmanagedWorktreeRepository =
  | { kind: 'directory' }
  | { kind: 'standalone-clone' }
  | { kind: 'linked-worktree'; referenceRepoPath: string };

export interface UnmanagedWorktreeRepositoryEntry {
  repoId: string;
  path: string;
  repository: UnmanagedWorktreeRepository;
}

export async function listUnmanagedWorktreeRepositories(
  rootPath: string,
  managedRepoIds: readonly string[],
): Promise<UnmanagedWorktreeRepositoryEntry[]> {
  const rootInfo = await lstat(rootPath).catch((error: unknown) => {
    if (isErrnoException(error) && error.code === 'ENOENT') return null;
    throw error;
  });
  if (!rootInfo) return [];
  if (!rootInfo.isDirectory()) {
    throw new Error(
      `Worktree root must be a directory, not a symbolic link: ${rootPath}`,
    );
  }
  const reposPath = join(rootPath, 'repos');
  const reposInfo = await lstat(reposPath).catch((error: unknown) => {
    if (isErrnoException(error) && error.code === 'ENOENT') return null;
    throw error;
  });
  if (!reposInfo) return [];
  const [canonicalRoot, canonicalRepos] = await Promise.all([
    realpath(rootPath),
    realpath(reposPath),
  ]);
  if (!isPathInside(canonicalRoot, canonicalRepos)) {
    throw new Error(
      `Repository directory points outside the worktree: ${reposPath}`,
    );
  }
  if (reposInfo.isSymbolicLink()) {
    throw new Error(
      `Cannot remove repositories through a symbolic link: ${reposPath}`,
    );
  }
  const entries = await readdir(reposPath, { withFileTypes: true }).catch(
    (error: unknown) => {
      if (isErrnoException(error) && error.code === 'ENOENT') return [];
      throw error;
    },
  );
  const result: UnmanagedWorktreeRepositoryEntry[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || managedRepoIds.includes(entry.name)) continue;
    const path = join(reposPath, entry.name);
    if (!isPathInside(canonicalRepos, await realpath(path))) {
      throw new Error(
        `Repository directory points outside the worktree: ${path}`,
      );
    }
    result.push({
      repoId: entry.name,
      path,
      repository: await classifyUnmanagedWorktreeRepository(path),
    });
  }
  return result;
}

export async function assertGitMetadataSelfContained(
  gitMetadataPath: string,
  retainedMetadataPath?: string,
): Promise<void> {
  await inspectGitMetadata(gitMetadataPath, true, false, retainedMetadataPath);
}

async function inspectGitMetadata(
  metadataPath: string,
  knownMetadataRoot: boolean,
  withinModules: boolean,
  retainedMetadataPath?: string,
): Promise<void> {
  const info = await lstat(metadataPath).catch((error: unknown) => {
    if (isErrnoException(error) && error.code === 'ENOENT') return null;
    throw error;
  });
  if (!info) return;
  if (info.isSymbolicLink()) {
    throw new Error(
      `Cannot remove repository with linked Git metadata: ${metadataPath}`,
    );
  }
  if (info.isFile() && !knownMetadataRoot) return;
  if (!info.isDirectory()) {
    throw new Error(`Unsupported Git metadata: ${metadataPath}`);
  }
  const entries = await readdir(metadataPath, { withFileTypes: true }).catch(
    (error: unknown) => {
      if (isErrnoException(error) && error.code === 'ENOENT') return [];
      throw error;
    },
  );
  const retainedEntries =
    withinModules && retainedMetadataPath
      ? await readdir(retainedMetadataPath, { withFileTypes: true }).catch(
          (error: unknown) => {
            if (isErrnoException(error) && error.code === 'ENOENT') return [];
            throw error;
          },
        )
      : [];
  const metadataRoot =
    knownMetadataRoot ||
    (withinModules &&
      [entries, retainedEntries].some(
        (candidates) =>
          candidates.some((entry) => entry.name === 'HEAD' && entry.isFile()) &&
          candidates.some(
            (entry) => entry.name === 'objects' && entry.isDirectory(),
          ),
      ));
  for (const entry of entries) {
    if (entry.isFile()) continue;
    await inspectGitMetadata(
      join(metadataPath, entry.name),
      false,
      metadataRoot ? entry.name === 'modules' : withinModules,
      retainedMetadataPath ? join(retainedMetadataPath, entry.name) : undefined,
    );
  }
  if (!metadataRoot) return;
  if (entries.some((entry) => entry.name === 'commondir')) {
    throw new Error(
      `Cannot remove repository with external Git metadata: ${metadataPath}`,
    );
  }
  if (entries.some((entry) => entry.name === 'worktrees')) {
    const worktrees = await readdir(join(metadataPath, 'worktrees')).catch(
      (error: unknown) => {
        if (isErrnoException(error) && error.code === 'ENOENT') return [];
        throw error;
      },
    );
    if (worktrees.length > 0) {
      throw new Error(
        `Cannot remove repository while it owns linked worktrees: ${metadataPath}`,
      );
    }
  }
  for (const name of ['alternates', 'http-alternates']) {
    const alternates = await readFile(
      join(metadataPath, 'objects', 'info', name),
      'utf8',
    ).catch((error: unknown) => {
      if (isErrnoException(error) && error.code === 'ENOENT') return '';
      throw error;
    });
    if (alternates.trim()) {
      throw new Error(
        `Cannot remove repository that depends on external Git objects: ${metadataPath}`,
      );
    }
  }
}

export async function classifyUnmanagedWorktreeRepository(
  worktreePath: string,
): Promise<UnmanagedWorktreeRepository> {
  const rootInfo = await lstat(worktreePath);
  if (!rootInfo.isDirectory()) return { kind: 'directory' };
  let gitPath = join(worktreePath, '.git');
  let gitInfo = await lstat(gitPath).catch((error: unknown) => {
    if (isErrnoException(error) && error.code === 'ENOENT') return null;
    throw error;
  });
  if (!gitInfo) {
    const metadataEntries = await readdir(worktreePath);
    if (
      !metadataEntries.includes('HEAD') ||
      !metadataEntries.includes('objects')
    ) {
      return { kind: 'directory' };
    }
    if (
      (await getGitCommonDir(worktreePath)) !== (await realpath(worktreePath))
    ) {
      return { kind: 'directory' };
    }
    gitPath = worktreePath;
    gitInfo = rootInfo;
  }
  if (gitInfo.isSymbolicLink()) {
    throw new Error(
      `Cannot remove repository with linked Git metadata: ${worktreePath}`,
    );
  }
  const commonDir = await getGitCommonDir(worktreePath);
  if (gitInfo.isFile()) {
    const gitFile = await readFile(gitPath, 'utf8');
    const gitDirPath = /^gitdir: (.+)\s*$/.exec(gitFile)?.[1];
    if (!gitDirPath) throw new Error(`Invalid Git metadata file: ${gitPath}`);
    const gitDir = await realpath(resolve(worktreePath, gitDirPath.trim()));
    if (gitDir === commonDir) {
      throw new Error(
        `Cannot remove repository with external Git metadata: ${worktreePath}`,
      );
    }
    return {
      kind: 'linked-worktree',
      referenceRepoPath:
        basename(commonDir) === '.git' ? dirname(commonDir) : commonDir,
    };
  }
  if (!gitInfo.isDirectory() || (await realpath(gitPath)) !== commonDir) {
    throw new Error(`Unsupported Git metadata: ${gitPath}`);
  }
  const objectsPath = join(commonDir, 'objects');
  const objectsInfo = await lstat(objectsPath);
  const alternates = await readFile(
    join(objectsPath, 'info', 'alternates'),
    'utf8',
  ).catch((error: unknown) => {
    if (isErrnoException(error) && error.code === 'ENOENT') return '';
    throw error;
  });
  if (objectsInfo.isSymbolicLink() || alternates.trim()) {
    throw new Error(
      `Cannot remove repository that depends on external Git objects: ${worktreePath}`,
    );
  }
  await assertGitMetadataSelfContained(gitPath);
  const registeredPaths = await listRegisteredWorktreePaths(worktreePath);
  const canonicalPath = await realpath(worktreePath);
  for (const registeredPath of Array.from(registeredPaths)) {
    const canonicalRegisteredPath = await realpath(registeredPath).catch(() =>
      resolve(registeredPath),
    );
    if (canonicalRegisteredPath !== canonicalPath) {
      throw new Error(
        `Cannot remove repository while it owns linked worktrees: ${worktreePath}`,
      );
    }
  }
  return { kind: 'standalone-clone' };
}
