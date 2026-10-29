import { constants } from 'node:fs';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readdir,
  readlink,
  rm,
  symlink,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  classifySharedContainerSymlinkTarget,
  decodeUtf8SymlinkTarget,
} from '../../lib/git';
import {
  resolveMaterializedPath,
  validateMaterializedRelativePath,
} from '../materialize/path-safety';

export interface SharedContainerCopyTreeLimits {
  maxBytes?: bigint;
  maxFiles?: number;
}

/**
 * Recursive copy used to escape a sealed replica. Callers can impose byte and
 * file bounds for publisher-controlled projections. Repository promotion
 * deliberately has no shared-artifact quota because the accepted checkout and
 * its Git object database came from the recipient's own access. The source is
 * never chmodded. Destination files become ordinary user-writable files.
 *
 * Symbolic links are classified, not banned. A committed symlink is ordinary
 * repository content: publish ships it as a `120000` entry and materialize
 * recreates it on disk, so a copy that refused every link could not promote
 * any repository containing one. An in-repository target is recreated as a
 * link (never dereferenced, so the copy cannot silently inflate or read
 * through it); anything escaping or oversized is skipped, matching
 * `materializeGitCommitRaw`, which re-materializes the base tree from the
 * object database straight after promotion. Hard links stay refused outright,
 * because they would alias the sealed replica's own inodes rather than point
 * at a path inside the copy.
 */
export async function copySharedContainerTree(
  sourceRoot: string,
  destinationRoot: string,
  limits: SharedContainerCopyTreeLimits = {},
): Promise<void> {
  let totalBytes = BigInt(0);
  let fileCount = 0;

  const copyDirectory = async (
    sourceDirectory: string,
    relativeDirectory: string,
  ): Promise<void> => {
    const destinationDirectory = relativeDirectory
      ? resolveMaterializedPath(destinationRoot, relativeDirectory)
      : destinationRoot;
    if (relativeDirectory) {
      await mkdir(destinationDirectory, { mode: 0o700 });
    }
    const entries = await readdir(sourceDirectory, { withFileTypes: true });
    for (const entry of entries) {
      const relative = validateMaterializedRelativePath(
        relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name,
      );
      const source = join(sourceDirectory, entry.name);
      const info = await lstat(source);
      if (info.isSymbolicLink()) {
        const target = decodeUtf8SymlinkTarget(
          await readlink(source, { encoding: 'buffer' }),
          `Shared-container fork rejects non-UTF-8 symlink target: ${relative}`,
        );
        if (
          classifySharedContainerSymlinkTarget(relative, target) !==
          'in-repository'
        ) {
          continue;
        }
        const destination = resolveMaterializedPath(destinationRoot, relative);
        await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
        await symlink(target, destination);
        continue;
      }
      if (info.isDirectory()) {
        await copyDirectory(source, relative);
        continue;
      }
      if (!info.isFile()) {
        throw new Error(
          `Shared-container fork rejects special file: ${relative}`,
        );
      }
      if (info.nlink !== 1) {
        throw new Error(`Shared-container fork rejects hard link: ${relative}`);
      }
      fileCount += 1;
      totalBytes += BigInt(info.size);
      if (
        (limits.maxFiles !== undefined && fileCount > limits.maxFiles) ||
        (limits.maxBytes !== undefined && totalBytes > limits.maxBytes)
      ) {
        throw new Error('Shared-container fork exceeds its copy budget');
      }
      const destination = resolveMaterializedPath(destinationRoot, relative);
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      await copyFile(source, destination, constants.COPYFILE_EXCL);
      await chmod(destination, (info.mode & 0o111) !== 0 ? 0o700 : 0o600);
    }
  };

  const sourceInfo = await lstat(sourceRoot);
  if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()) {
    throw new Error('Shared-container fork source must be a real directory');
  }

  await mkdir(destinationRoot, { mode: 0o700 });
  try {
    await copyDirectory(sourceRoot, '');
    await chmod(destinationRoot, 0o700);
  } catch (error) {
    await rm(destinationRoot, { recursive: true, force: true });
    throw error;
  }
}
