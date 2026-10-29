import {
  copyFile,
  link,
  lstat,
  readFile,
  readlink,
  rm,
  symlink,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { isErrnoException } from './type-guards';

export {
  isProjectInstructionFileReadable,
  resolveOptionalProjectInstructionFile,
  resolveProjectInstructionFile,
  restoreProjectInstructionFiles,
  writeProjectInstructionFile,
  type ProjectInstructionFile,
} from '@canopy/desktop-shared/node/lib/project-instruction-files';

export async function ensureRelativeSymlink(
  linkPath: string,
  targetPath: string,
): Promise<void> {
  try {
    const existing = await lstat(linkPath);
    if (existing.isSymbolicLink()) {
      const existingTarget = await readlink(linkPath);
      if (symlinkTargetsMatch(linkPath, existingTarget, targetPath)) {
        return;
      }
    }

    await rm(linkPath, { recursive: true, force: true });
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') {
      // Nothing to replace.
    } else {
      throw error;
    }
  }

  try {
    await symlink(targetPath, linkPath);
  } catch (error) {
    if (!isErrnoException(error) || error.code !== 'EEXIST') {
      throw error;
    }

    const existing = await lstat(linkPath);
    if (!existing.isSymbolicLink()) {
      throw error;
    }

    const existingTarget = await readlink(linkPath);
    if (!symlinkTargetsMatch(linkPath, existingTarget, targetPath)) {
      throw error;
    }
  }
}

export async function ensureRelativeSymlinkOrCopy(
  linkPath: string,
  targetPath: string,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  if (platform === 'win32') {
    await replaceWithHardlinkOrCopy(linkPath, targetPath);
    return;
  }

  try {
    await ensureRelativeSymlink(linkPath, targetPath);
  } catch (error) {
    if (
      !isErrnoException(error) ||
      (error.code !== 'EPERM' && error.code !== 'EACCES')
    ) {
      throw error;
    }

    await replaceWithHardlinkOrCopy(linkPath, targetPath);
  }
}

async function replaceWithHardlinkOrCopy(
  linkPath: string,
  targetPath: string,
): Promise<void> {
  const resolvedTargetPath = resolve(dirname(linkPath), targetPath);
  await rm(linkPath, { recursive: true, force: true });
  try {
    await link(resolvedTargetPath, linkPath);
  } catch {
    await copyFile(resolvedTargetPath, linkPath);
  }
}

export async function hasExpectedRelativeSymlinkOrCopy(
  linkPath: string,
  targetPath: string,
): Promise<boolean> {
  try {
    const existing = await lstat(linkPath);
    if (existing.isSymbolicLink()) {
      const existingTarget = await readlink(linkPath);
      return symlinkTargetsMatch(linkPath, existingTarget, targetPath);
    }

    const resolvedTargetPath = resolve(dirname(linkPath), targetPath);
    const [linkContent, targetContent] = await Promise.all([
      readFile(linkPath, 'utf8'),
      readFile(resolvedTargetPath, 'utf8'),
    ]);
    return linkContent === targetContent;
  } catch {
    return false;
  }
}

function symlinkTargetsMatch(
  linkPath: string,
  existingTarget: string,
  expectedTarget: string,
): boolean {
  if (existingTarget === expectedTarget) {
    return true;
  }

  const linkDir = dirname(linkPath);
  return resolve(linkDir, existingTarget) === resolve(linkDir, expectedTarget);
}

export async function ensureAgentsMdSymlink(
  dir: string,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  const agentsMdPath = join(dir, 'AGENTS.md');
  if (platform === 'win32') {
    await ensureRelativeSymlinkOrCopy(agentsMdPath, 'CLAUDE.md', platform);
    return;
  }
  await ensureRelativeSymlink(agentsMdPath, 'CLAUDE.md');
}

export async function ensureAgentsMdSymlinkOrCopy(
  dir: string,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  await ensureRelativeSymlinkOrCopy(
    join(dir, 'AGENTS.md'),
    'CLAUDE.md',
    platform,
  );
}

export async function hasExpectedAgentsMdSymlinkOrCopy(
  dir: string,
): Promise<boolean> {
  return hasExpectedRelativeSymlinkOrCopy(join(dir, 'AGENTS.md'), 'CLAUDE.md');
}
