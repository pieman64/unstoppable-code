import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  lstat,
  mkdir,
  mkdtemp,
  readlink,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import {
  MAX_SHARED_CONTAINER_ARTIFACT_BYTES,
  MAX_SHARED_CONTAINER_REVISION_BYTES,
  type SharedContainerWithheldFileReason,
} from '@canopy/protocol/shared-containers';
import { getResolvedGitExecutableForSpawn } from '../../lib/git-executable';
import { classifySharedContainerSymlinkTarget } from '../../lib/git';
import { isCredentialShapedSharedContainerPath } from './path-withholding';
import { SharedContainerPublishRefusalError } from './errors';
import type { PublishFileSource } from './source-files';

const execFileAsync = promisify(execFile);

export interface SharedContainerSnapshotChunk {
  hash: string;
  sizeBytes: number;
  source?: PublishFileSource;
}

export interface SharedContainerCodeSnapshot {
  baseCommitSha: string;
  chunks: SharedContainerSnapshotChunk[];
  treeFileCount: number;
  treeBytes: bigint;
  /** Publisher-only base blob sizes used for exact snapshot overlay budgeting. */
  treeFileSizes: ReadonlyMap<string, bigint>;
  withheldPaths: string[];
  withheldReasons?: Record<string, SharedContainerWithheldFileReason>;
}

async function git(
  executable: string,
  args: string[],
  cwd: string,
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  const result = await execFileAsync(executable, args, {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return result.stdout.trim();
}

export async function buildSharedContainerCodeSnapshot(input: {
  repoPath: string;
  headSha: string | null;
  includeChunkSources?: boolean;
}): Promise<SharedContainerCodeSnapshot> {
  const executable = await getResolvedGitExecutableForSpawn();
  const temp = await mkdtemp(join(tmpdir(), 'canopy-share-snapshot-'));
  const gitDir = join(temp, 'snapshot.git');
  const indexPath = join(temp, 'index');
  const bundlePath = join(temp, 'snapshot.bundle');
  let retainedForChunkSources = false;
  let cleanupPromise: Promise<void> | undefined;
  const cleanup = (): Promise<void> => {
    cleanupPromise ??= rm(temp, { recursive: true, force: true });
    return cleanupPromise;
  };
  try {
    await git(executable, ['init', '--bare', gitDir], input.repoPath);
    const sourceObjectsRaw = await git(
      executable,
      ['rev-parse', '--git-path', 'objects'],
      input.repoPath,
    );
    const sourceObjects = isAbsolute(sourceObjectsRaw)
      ? sourceObjectsRaw
      : resolve(input.repoPath, sourceObjectsRaw);
    const alternatesDir = join(gitDir, 'objects', 'info');
    await mkdir(alternatesDir, { recursive: true });
    await writeFile(join(alternatesDir, 'alternates'), `${sourceObjects}\n`);
    const env = {
      GIT_DIR: gitDir,
      GIT_WORK_TREE: input.repoPath,
      GIT_INDEX_FILE: indexPath,
    };
    if (input.headSha) {
      await git(executable, ['read-tree', input.headSha], input.repoPath, env);
    } else {
      await git(executable, ['add', '-A'], input.repoPath, env);
    }

    const index = await git(
      executable,
      ['ls-files', '--stage', '-z'],
      input.repoPath,
      env,
    );
    const withheldPaths: string[] = [];
    const withheldReasons: Record<string, SharedContainerWithheldFileReason> =
      {};
    for (const record of index.split('\0').filter(Boolean)) {
      const match = /^(\d{6}) ([0-9a-f]+) \d\t([\s\S]+)$/.exec(record);
      if (!match) throw new Error('Git returned a malformed snapshot index');
      const [, mode, objectId, path] = match;
      if (mode === '160000') {
        throw new SharedContainerPublishRefusalError(
          'submodule',
          `Repository snapshot contains unsupported submodule: ${path}.`,
        );
      }
      let withheld = isCredentialShapedSharedContainerPath(path);
      let withheldReason: SharedContainerWithheldFileReason | undefined =
        withheld ? 'credential-shaped' : undefined;
      if (!withheld && mode === '120000') {
        const target = await git(
          executable,
          ['cat-file', 'blob', objectId],
          input.repoPath,
          env,
        );
        withheld =
          classifySharedContainerSymlinkTarget(path, target) !==
          'in-repository';
        if (withheld) withheldReason = 'symlink-escaping';
      }
      if (!withheld && (!input.headSha || mode !== '120000')) {
        const info = await lstat(
          join(input.repoPath, ...path.split('/')),
        ).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return null;
          throw error;
        });
        if (!info && !input.headSha) {
          throw new Error('Snapshot working tree changed during publication');
        }
        if (!info) continue;
        if (info.isSymbolicLink()) {
          const target = await readlink(
            join(input.repoPath, ...path.split('/')),
          );
          withheld =
            classifySharedContainerSymlinkTarget(path, target) !==
            'in-repository';
          if (withheld) withheldReason = 'symlink-escaping';
        } else {
          withheld = !info.isFile() || info.nlink > 1;
          if (withheld) withheldReason = 'credential-shaped';
        }
      }
      if (!withheld) continue;
      withheldPaths.push(path);
      withheldReasons[path] = withheldReason ?? 'credential-shaped';
      await git(
        executable,
        ['update-index', '--force-remove', '--', path],
        input.repoPath,
        env,
      );
    }

    const tree = await git(executable, ['write-tree'], input.repoPath, env);
    const commitEnv = {
      ...env,
      GIT_AUTHOR_NAME: 'Shared Snapshot',
      GIT_AUTHOR_EMAIL: 'snapshot@localhost',
      GIT_COMMITTER_NAME: 'Shared Snapshot',
      GIT_COMMITTER_EMAIL: 'snapshot@localhost',
      GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
      GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
    };
    const baseCommitSha = await git(
      executable,
      ['commit-tree', tree, '-m', 'Shared snapshot'],
      input.repoPath,
      commitEnv,
    );
    await git(
      executable,
      ['update-ref', 'refs/heads/snapshot', baseCommitSha],
      input.repoPath,
      env,
    );
    await git(
      executable,
      ['bundle', 'create', bundlePath, 'refs/heads/snapshot'],
      input.repoPath,
      env,
    );
    const bundleInfo = await stat(bundlePath);
    if (bundleInfo.size > MAX_SHARED_CONTAINER_REVISION_BYTES) {
      throw new SharedContainerPublishRefusalError(
        'artifact-budget',
        'Push to GitHub to share a project this size.',
      );
    }
    const chunks: SharedContainerSnapshotChunk[] = [];
    for (
      let offset = 0;
      offset < bundleInfo.size;
      offset += MAX_SHARED_CONTAINER_ARTIFACT_BYTES
    ) {
      const start = offset;
      const sizeBytes = Math.min(
        MAX_SHARED_CONTAINER_ARTIFACT_BYTES,
        bundleInfo.size - start,
      );
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(bundlePath, {
        start,
        end: start + sizeBytes - 1,
      })) {
        if (!Buffer.isBuffer(chunk)) {
          throw new Error('Snapshot bundle stream returned non-binary content');
        }
        hash.update(chunk);
      }
      const digest = hash.digest('hex');
      chunks.push({
        hash: digest,
        sizeBytes,
        ...(input.includeChunkSources === false
          ? {}
          : {
              source: {
                sizeBytes,
                hash: `sha256:${digest}`,
                createReadStream: (): ReturnType<typeof createReadStream> =>
                  createReadStream(bundlePath, {
                    start,
                    end: start + sizeBytes - 1,
                  }),
                dispose: cleanup,
              },
            }),
      });
    }
    const treeRows = await git(
      executable,
      ['ls-tree', '-r', '-l', '-z', baseCommitSha],
      input.repoPath,
      env,
    );
    let treeFileCount = 0;
    let treeBytes = BigInt(0);
    const treeFileSizes = new Map<string, bigint>();
    for (const row of treeRows.split('\0').filter(Boolean)) {
      const match = /^\d{6} blob [0-9a-f]+\s+(\d+)\t([\s\S]+)$/.exec(row);
      if (!match) continue;
      const size = BigInt(match[1]);
      treeFileCount += 1;
      treeBytes += size;
      treeFileSizes.set(match[2], size);
    }
    retainedForChunkSources =
      input.includeChunkSources !== false && chunks.length > 0;
    return {
      baseCommitSha,
      chunks,
      treeFileCount,
      treeBytes,
      treeFileSizes,
      withheldPaths,
      withheldReasons,
    };
  } finally {
    if (!retainedForChunkSources) await cleanup();
  }
}
