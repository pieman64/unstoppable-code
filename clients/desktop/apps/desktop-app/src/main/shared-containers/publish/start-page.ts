import { WORKSPACE_ROOT_REPO_ID } from '@canopy/desktop-shared/types';
import type { ProjectStartPage } from '@canopy/protocol/start-page';
import type { SharedContainerStartPage } from '@canopy/protocol/shared-containers';
import type { PublishedLayoutRoot } from './layout';

/**
 * Pick the repository a file start page is relative to. Single-repo and cowork
 * values omit `repoId`; a multi-repo value without one (for example from the
 * workspace-root `canopy.json`) means the workspace root. This matches the
 * renderer's first-open resolution so what opens locally is what publishes.
 */
export function findStartPageRepository<T extends { repoId: string }>(
  startPage: Extract<ProjectStartPage, { kind: 'file' }>,
  repositories: readonly T[],
): T | undefined {
  if (startPage.repoId) {
    return repositories.find(
      (candidate) => candidate.repoId === startPage.repoId,
    );
  }
  if (repositories.length === 1) return repositories[0];
  return repositories.find(
    (candidate) => candidate.repoId === WORKSPACE_ROOT_REPO_ID,
  );
}

export function mapProjectStartPageForPublication(
  startPage: ProjectStartPage,
  roots: readonly PublishedLayoutRoot[],
): SharedContainerStartPage | null {
  if (startPage.kind === 'url') return startPage;
  const root = findStartPageRepository(startPage, roots);
  if (!root?.publishedPaths.has(startPage.path)) return null;
  return {
    kind: 'file',
    repoId: root.repoId,
    relativePath: startPage.path,
  };
}
