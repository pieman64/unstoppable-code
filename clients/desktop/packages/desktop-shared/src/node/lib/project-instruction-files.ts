import { constants } from 'node:fs';
import {
  access,
  copyFile,
  lstat,
  readFile,
  readlink,
  symlink,
  writeFile,
} from 'node:fs/promises';
import {
  isProjectInstructionFileReadable as isReadableWithPorts,
  resolveOptionalProjectInstructionFile as resolveOptionalWithPorts,
  resolveProjectInstructionFile as resolveWithPorts,
  restoreProjectInstructionFiles as restoreWithPorts,
  writeProjectInstructionFile as writeWithPorts,
  type InstructionFilePorts,
} from '@canopy/core-runtime/node/workspace/instruction-files';

import type { ProjectInstructionFile } from '../../types/project-instructions';
export type { ProjectInstructionFile } from '../../types/project-instructions';

/*
 * Host bindings for the core-runtime instruction-file policy (CAN-4106). This
 * module stays the writer of project instruction files for the desktop and
 * CLI; the policy decides what to read and write.
 */
export const nodeInstructionFilePorts: InstructionFilePorts = {
  lstat: (path) => lstat(path),
  readlink: (path) => readlink(path),
  readText: (path) => readFile(path, 'utf8'),
  assertReadable: (path) => access(path, constants.R_OK),
  writeText: (path, content) => writeFile(path, content, 'utf8'),
  copyFileExclusive: (source, destination) =>
    copyFile(source, destination, constants.COPYFILE_EXCL),
  symlink: (target, path) => symlink(target, path),
};

/** Readiness accepts regular files and a single alias to the other root file. */
export function isProjectInstructionFileReadable(
  dir: string,
  name: 'AGENTS.md' | 'CLAUDE.md',
): Promise<boolean> {
  return isReadableWithPorts(dir, name, nodeInstructionFilePorts);
}

/** Preserve project-owned files; only follow the established in-folder alias. */
export function resolveProjectInstructionFile(
  dir: string,
): Promise<ProjectInstructionFile> {
  return resolveWithPorts(dir, nodeInstructionFilePorts);
}

export function resolveOptionalProjectInstructionFile(
  dir: string,
): Promise<ProjectInstructionFile | undefined> {
  return resolveOptionalWithPorts(dir, nodeInstructionFilePorts);
}

export function writeProjectInstructionFile(
  target: Pick<ProjectInstructionFile, 'filePath' | 'mirrorPath'>,
  content: string,
): Promise<void> {
  return writeWithPorts(target, content, nodeInstructionFilePorts);
}

/** Restore missing guidance, retaining the source's regular files or direct alias. */
export function restoreProjectInstructionFiles(
  source: ProjectInstructionFile,
  target: ProjectInstructionFile,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  return restoreWithPorts(source, target, platform, nodeInstructionFilePorts);
}
