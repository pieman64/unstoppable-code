import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type {
  PortalChatFileReference,
  RepoFileIndex,
} from '@canopy/desktop-shared/types';
import { buildFileIndexes } from '../services/files-service';
import { PortalServiceError } from '../services/portal-service-error';
import {
  portalFileReferences,
  type PortalFileReferenceScope,
} from './portal-file-references';
import { selectPortalFileReference } from './portal-file-reference-selection';

function mappedFile(
  repo: RepoFileIndex,
  path: string,
  directory = false,
): boolean {
  const fromRoot = relative(resolve(repo.absolutePath), resolve(path));
  return (
    (directory || fromRoot !== '') &&
    fromRoot !== '..' &&
    !fromRoot.startsWith(`..${sep}`) &&
    !isAbsolute(fromRoot)
  );
}

function cannotMap(): PortalServiceError {
  return new PortalServiceError(
    'invalid_target',
    'This file reference cannot be mapped to the destination catalog. Select the file again.',
  );
}

export async function rebindPortalFileReferences(input: {
  sourceScope: PortalFileReferenceScope;
  destinationScope: PortalFileReferenceScope;
  fileReferences: readonly PortalChatFileReference[];
}): Promise<PortalChatFileReference[]> {
  const { sourceScope, destinationScope, fileReferences } = input;
  if (
    sourceScope.projectId !== destinationScope.projectId ||
    sourceScope.sessionId !== destinationScope.sessionId ||
    sourceScope.canRead?.() !== true ||
    destinationScope.canRead?.() !== true
  ) {
    throw new PortalServiceError(
      'invalid_target',
      'The source and destination are not authorized for this paired session.',
    );
  }
  const sourceFiles = fileReferences.map((reference) =>
    portalFileReferences.resolve(sourceScope, reference),
  );
  const sourceIndex = await buildFileIndexes({
    projectId: sourceScope.projectId,
    worktreeId: sourceScope.worktreeId,
  });
  const destinationIndex = await buildFileIndexes({
    projectId: destinationScope.projectId,
    worktreeId: destinationScope.worktreeId,
  });
  const mappings = [];
  for (const [index, sourceFile] of Array.from(sourceFiles.entries())) {
    const reference = fileReferences[index];
    if (!reference) throw cannotMap();
    portalFileReferences.resolve(sourceScope, reference);
    if (destinationScope.canRead?.() !== true) throw cannotMap();
    const directory = sourceFile.kind === 'directory';
    const sourceRepos = sourceIndex.repos.filter((repo) =>
      directory
        ? repo.repoName === sourceFile.repoName &&
          mappedFile(repo, sourceFile.absolutePath, true)
        : repo.files.some(
            (file) =>
              !file.isIgnored &&
              file.absolutePath === sourceFile.absolutePath &&
              mappedFile(repo, file.absolutePath) &&
              resolve(file.absolutePath) ===
                resolve(join(repo.absolutePath, file.relativePath)),
          ),
    );
    if (sourceRepos.length !== 1) throw cannotMap();
    const sourceRepo = sourceRepos[0];
    if (!sourceRepo) throw cannotMap();
    const sourceEntry = sourceRepo.files.find(
      (file) => file.absolutePath === sourceFile.absolutePath,
    );
    if (!directory && !sourceEntry) throw cannotMap();
    const relativePath = directory
      ? relative(sourceRepo.absolutePath, sourceFile.absolutePath)
          .split(sep)
          .join('/')
      : sourceEntry?.relativePath;
    if (relativePath === undefined) throw cannotMap();
    const destinationRepos = destinationIndex.repos.filter(
      (repo) =>
        repo.repoId === sourceRepo.repoId &&
        repo.repoName === sourceRepo.repoName &&
        repo.rootKind === sourceRepo.rootKind,
    );
    if (destinationRepos.length !== 1) throw cannotMap();
    const destinationRepo = destinationRepos[0];
    if (!destinationRepo) throw cannotMap();
    if (directory) {
      await selectPortalFileReference({
        scope: sourceScope,
        repo: sourceRepo,
        relativePath,
        kind: 'directory',
      });
      const selected = await selectPortalFileReference({
        scope: destinationScope,
        repo: destinationRepo,
        relativePath,
        kind: 'directory',
      });
      mappings.push({
        ...sourceFile,
        absolutePath: selected.absolutePath,
        repoName: selected.repoName,
      });
      continue;
    }
    const destinationFiles = destinationRepo.files.filter(
      (file) =>
        !file.isIgnored &&
        file.relativePath === relativePath &&
        mappedFile(destinationRepo, file.absolutePath) &&
        resolve(file.absolutePath) ===
          resolve(join(destinationRepo.absolutePath, relativePath)),
    );
    if (destinationFiles.length !== 1) throw cannotMap();
    const destinationFile = destinationFiles[0];
    if (!destinationFile) throw cannotMap();
    mappings.push({
      ...sourceFile,
      absolutePath: destinationFile.absolutePath,
      repoName: destinationRepo.repoName,
    });
  }
  for (const reference of fileReferences)
    portalFileReferences.resolve(sourceScope, reference);
  if (destinationScope.canRead?.() !== true) throw cannotMap();
  return mappings.map((file) =>
    portalFileReferences.mint(destinationScope, file),
  );
}
