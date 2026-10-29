import type {
  ResolveProjectStartPageRequest,
  ResolvedProjectStartPage,
} from '@canopy/desktop-shared/types';
import type { ProjectStartPage } from '@canopy/protocol/start-page';
import { readCanopyJson } from './canopy-json';
import { getWorktreeDir, getWorkspaceWorktreeRootRepoDir } from './paths';
import { resolveProjectReferenceRepoPath } from './project-reference-repo';
import { isStartPageFeatureEnabled } from './start-page-feature-flag';
import { readWorkspaceConfig } from './workspace-persistence';
import { resolveWorkspaceReferenceRepoPath } from './workspace-reference-repo';

async function readManifestStartPage(
  repoPath: string,
): Promise<ProjectStartPage | undefined> {
  return (await readCanopyJson(repoPath).catch(() => null))?.startPage;
}

export async function resolveProjectStartPage({
  projectId,
  worktreeId,
}: ResolveProjectStartPageRequest): Promise<ResolvedProjectStartPage | null> {
  if (!isStartPageFeatureEnabled()) return null;

  const config = await readWorkspaceConfig(projectId);
  if (config.type === 'cowork') {
    return config.cowork?.startPage
      ? { startPage: config.cowork.startPage, source: 'cowork' }
      : null;
  }

  if (config.startPage !== undefined) {
    return config.startPage === null
      ? null
      : { startPage: config.startPage, source: 'local' };
  }

  if (worktreeId) {
    const worktreeRoot =
      config.type === 'single-repo'
        ? getWorktreeDir(projectId, worktreeId)
        : getWorkspaceWorktreeRootRepoDir(projectId, worktreeId);
    const worktreeStartPage = await readManifestStartPage(worktreeRoot);
    if (worktreeStartPage) {
      return { startPage: worktreeStartPage, source: 'source' };
    }
  }

  let referenceRoot: string | undefined;
  if (config.type === 'single-repo' && config.repoPath) {
    referenceRoot = await resolveProjectReferenceRepoPath(config.repoPath);
  } else if (config.type === 'multi-repo' && config.sourceRepoPath) {
    referenceRoot = await resolveWorkspaceReferenceRepoPath(
      config.sourceRepoPath,
    );
  }
  if (!referenceRoot) return null;
  const sourceStartPage = await readManifestStartPage(referenceRoot);
  return sourceStartPage
    ? { startPage: sourceStartPage, source: 'source' }
    : null;
}
