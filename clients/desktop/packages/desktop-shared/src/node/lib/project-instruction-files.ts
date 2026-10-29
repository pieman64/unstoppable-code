import { constants, type Stats } from 'node:fs';
import {
  access,
  copyFile,
  lstat,
  readFile,
  readlink,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

import type { ProjectInstructionFile } from '../../types/project-instructions';
export type { ProjectInstructionFile } from '../../types/project-instructions';

class UnsupportedInstructionLayoutError extends Error {}

async function isDirectInstructionAlias(
  filePath: string,
  counterpart: string,
): Promise<boolean> {
  const linkTarget = await readlink(filePath);
  return (
    !linkTarget.split(/[\\/]/).includes('..') &&
    resolve(dirname(filePath), linkTarget) === resolve(counterpart)
  );
}

/** Readiness accepts regular files and a single alias to the other root file. */
export async function isProjectInstructionFileReadable(
  dir: string,
  name: 'AGENTS.md' | 'CLAUDE.md',
): Promise<boolean> {
  try {
    let filePath = join(dir, name);
    let entry = await lstat(filePath);
    if (entry.isSymbolicLink()) {
      const counterpart = join(
        dir,
        name === 'AGENTS.md' ? 'CLAUDE.md' : 'AGENTS.md',
      );
      if (!(await isDirectInstructionAlias(filePath, counterpart)))
        return false;
      filePath = counterpart;
      entry = await lstat(filePath);
    }
    if (!entry.isFile() || entry.isSymbolicLink()) return false;
    await access(filePath, constants.R_OK);
    return true;
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error.code === 'ENOENT' || error.code === 'ENOTDIR')
    )
      return false;
    throw error;
  }
}

async function instructionFileStat(
  filePath: string,
): Promise<Stats | undefined> {
  try {
    return await lstat(filePath);
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ENOENT'
    )
      return undefined;
    throw error;
  }
}

/** Preserve project-owned files; only follow the established in-folder alias. */
export async function resolveProjectInstructionFile(
  dir: string,
): Promise<ProjectInstructionFile> {
  const agentsPath = join(dir, 'AGENTS.md');
  const claudePath = join(dir, 'CLAUDE.md');
  const [agents, claude] = await Promise.all([
    instructionFileStat(agentsPath),
    instructionFileStat(claudePath),
  ]);
  if (agents?.isSymbolicLink()) {
    if (
      (!claude || (claude.isFile() && !claude.isSymbolicLink())) &&
      (await isDirectInstructionAlias(agentsPath, claudePath))
    ) {
      return {
        filePath: claudePath,
        exists: Boolean(claude),
        aliasPath: agentsPath,
      };
    }
    throw new UnsupportedInstructionLayoutError(
      'Cannot edit AGENTS.md through this symbolic link. Use a regular file or a link to CLAUDE.md in the same folder.',
    );
  }
  if (agents) {
    if (!agents.isFile())
      throw new UnsupportedInstructionLayoutError(
        'AGENTS.md must be a regular file.',
      );
    // Older Windows projects use equal regular copies. Preserve that pairing,
    // but never overwrite a separate Claude-specific instruction file.
    const mirrored =
      claude?.isFile() &&
      !claude.isSymbolicLink() &&
      (await readFile(agentsPath, 'utf8')) ===
        (await readFile(claudePath, 'utf8'));
    return {
      filePath: agentsPath,
      exists: true,
      ...(mirrored ? { mirrorPath: claudePath } : {}),
    };
  }
  if (claude) {
    if (claude.isSymbolicLink()) {
      if (await isDirectInstructionAlias(claudePath, agentsPath)) {
        return { filePath: agentsPath, exists: false, aliasPath: claudePath };
      }
      throw new UnsupportedInstructionLayoutError(
        'Cannot edit CLAUDE.md through this symbolic link. Use a regular instruction file.',
      );
    }
    if (!claude.isFile())
      throw new UnsupportedInstructionLayoutError(
        'CLAUDE.md must be a regular file.',
      );
    return { filePath: claudePath, exists: true };
  }
  return { filePath: agentsPath, exists: false };
}

export async function resolveOptionalProjectInstructionFile(
  dir: string,
): Promise<ProjectInstructionFile | undefined> {
  try {
    return await resolveProjectInstructionFile(dir);
  } catch (error) {
    if (error instanceof UnsupportedInstructionLayoutError) return undefined;
    throw error;
  }
}

export async function writeProjectInstructionFile(
  target: Pick<ProjectInstructionFile, 'filePath' | 'mirrorPath'>,
  content: string,
): Promise<void> {
  await writeFile(target.filePath, content, 'utf8');
  if (target.mirrorPath) await writeFile(target.mirrorPath, content, 'utf8');
}

/** Restore missing guidance, retaining the source's regular files or direct alias. */
export async function restoreProjectInstructionFiles(
  source: ProjectInstructionFile,
  target: ProjectInstructionFile,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  if (!source.exists || target.exists) return;
  const targetDir = dirname(target.filePath);
  const primaryName = basename(source.filePath);
  const destination = target.aliasPath
    ? target.filePath
    : join(targetDir, primaryName);
  await copyFile(source.filePath, destination, constants.COPYFILE_EXCL);
  // A known broken destination alias defines its own layout. Fill its target
  // without replacing that alias or creating a cycle from the source layout.
  if (target.aliasPath) return;

  const counterpartName =
    primaryName === 'AGENTS.md' ? 'CLAUDE.md' : 'AGENTS.md';
  const counterpart = join(dirname(source.filePath), counterpartName);
  const entry = await instructionFileStat(counterpart);
  if (!entry) return;
  const counterpartDestination = join(targetDir, counterpartName);
  if (entry.isFile() && !entry.isSymbolicLink()) {
    // This includes equal compatibility copies and independent Claude guidance.
    await copyFile(
      counterpart,
      counterpartDestination,
      constants.COPYFILE_EXCL,
    );
  } else if (
    entry.isSymbolicLink() &&
    (await isDirectInstructionAlias(counterpart, source.filePath))
  ) {
    if (platform !== 'win32') {
      try {
        await symlink(primaryName, counterpartDestination);
        return;
      } catch (error) {
        if (
          typeof error !== 'object' ||
          error === null ||
          !('code' in error) ||
          (error.code !== 'EPERM' && error.code !== 'EACCES')
        )
          throw error;
      }
    }
    await copyFile(
      destination,
      counterpartDestination,
      constants.COPYFILE_EXCL,
    );
  }
}
