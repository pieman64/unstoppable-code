import {
  copyFile,
  link,
  lstat,
  readFile,
  readlink,
  rm,
  symlink,
} from 'node:fs/promises';
import { join } from 'node:path';
import {
  ensureRelativeAlias,
  ensureRelativeSymlink as ensureRelativeSymlinkWithPort,
  hasExpectedRelativeAlias,
  type InstructionAliasPort,
} from '@canopy/core-runtime/node/workspace/instruction-files';

export {
  isProjectInstructionFileReadable,
  resolveOptionalProjectInstructionFile,
  resolveProjectInstructionFile,
  restoreProjectInstructionFiles,
  writeProjectInstructionFile,
  type ProjectInstructionFile,
} from '@canopy/desktop-shared/node/lib/project-instruction-files';

// This module stays the writer of desktop AGENTS.md aliases; the alias policy
// lives in core-runtime (CAN-4106).
const aliasPort: InstructionAliasPort = {
  lstat: (path) => lstat(path),
  readlink: (path) => readlink(path),
  readText: (path) => readFile(path, 'utf8'),
  remove: (path) => rm(path, { recursive: true, force: true }),
  symlink: (target, path) => symlink(target, path),
  hardLink: (existingPath, path) => link(existingPath, path),
  copyFile: (source, destination) => copyFile(source, destination),
};

export function ensureRelativeSymlink(
  linkPath: string,
  targetPath: string,
): Promise<void> {
  return ensureRelativeSymlinkWithPort(linkPath, targetPath, aliasPort);
}

export function ensureRelativeSymlinkOrCopy(
  linkPath: string,
  targetPath: string,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  return ensureRelativeAlias(
    linkPath,
    targetPath,
    { platform, posixPermissionFallback: true },
    aliasPort,
  );
}

export function hasExpectedRelativeSymlinkOrCopy(
  linkPath: string,
  targetPath: string,
): Promise<boolean> {
  return hasExpectedRelativeAlias(linkPath, targetPath, aliasPort);
}

/** Windows hard links or copies; POSIX symlinks with no permission fallback. */
export function ensureAgentsMdSymlink(
  dir: string,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  return ensureRelativeAlias(
    join(dir, 'AGENTS.md'),
    'CLAUDE.md',
    { platform, posixPermissionFallback: false },
    aliasPort,
  );
}

/** As {@link ensureAgentsMdSymlink}, but POSIX falls back after EPERM/EACCES. */
export function ensureAgentsMdSymlinkOrCopy(
  dir: string,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  return ensureRelativeSymlinkOrCopy(
    join(dir, 'AGENTS.md'),
    'CLAUDE.md',
    platform,
  );
}

export function hasExpectedAgentsMdSymlinkOrCopy(
  dir: string,
): Promise<boolean> {
  return hasExpectedRelativeSymlinkOrCopy(join(dir, 'AGENTS.md'), 'CLAUDE.md');
}
