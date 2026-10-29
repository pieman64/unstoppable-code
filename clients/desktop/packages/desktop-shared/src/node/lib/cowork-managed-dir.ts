import path from 'node:path';
import { BRAND } from '@canopy/brand/current';

export type CoworkManagedSubdir = 'notes' | 'prompts' | 'attachments';

/**
 * The in-folder managed dir for a cowork workspace (`.canopy/` under the
 * Canopy brand, `.unstoppable-code/` under that brand). Writes always target
 * the active brand's primary name; reads must go through the candidate
 * helpers so folders created under one brand open under the other - the same
 * contract as `getProjectActionsDirCandidates` for `.{brand}/actions`.
 */
export function getCoworkManagedDir(folderPath: string): string {
  return getCoworkManagedDirCandidates(folderPath)[0];
}

export function getCoworkManagedDirCandidates(folderPath: string): string[] {
  return BRAND.storage.projectConfigDirNames.map((dirName) =>
    path.join(folderPath, dirName),
  );
}

export function getCoworkManagedSubdir(
  folderPath: string,
  subdir: CoworkManagedSubdir,
): string {
  return getCoworkManagedSubdirCandidates(folderPath, subdir)[0];
}

export function getCoworkManagedSubdirCandidates(
  folderPath: string,
  subdir: CoworkManagedSubdir,
): string[] {
  return getCoworkManagedDirCandidates(folderPath).map((dir) =>
    path.join(dir, subdir),
  );
}

export function getCoworkArtifactsIndexFilePath(folderPath: string): string {
  return getCoworkArtifactsIndexFileCandidates(folderPath)[0];
}

export function getCoworkArtifactsIndexFileCandidates(
  folderPath: string,
): string[] {
  return getCoworkManagedDirCandidates(folderPath).map((dir) =>
    path.join(dir, 'artifacts-index.json'),
  );
}
