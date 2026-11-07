import type { OrgProjectSummary } from '@canopy/protocol/org-projects';
import type { AdhocMultiRepoMode } from '@canopy/desktop-shared/types';
import { getOrgProjectCatalogService } from '../services/org-project-catalog-service';
import { readAllSidebarItemsSnapshot } from './sidebar-items';
import { readWorkspaceOwnership } from './workspace-persistence';
import { getWorkspaceContextService } from './workspace-context-service';
import { getRemoteUrlStrict } from './git';
import {
  holdsOrganizationRepository,
  matchOrganizationRepository,
} from './org-project-relationships';

export function legacyOrganizationCombineAllowed(
  project: OrgProjectSummary | null,
): boolean {
  return (
    project !== null &&
    project.state === 'ACTIVE' &&
    project.capabilities.use &&
    project.memberOwned &&
    project.visibility === 'private'
  );
}

/**
 * Updates must refuse shared sources before conversion, worktree or tab effects.
 * Temporary composition leaves the source project definition unchanged; its
 * destination creation and organization auto-conversion still have effects.
 */
export async function assertLegacyCombineAllowed(
  workspaceIds: readonly string[],
  mode: AdhocMultiRepoMode,
): Promise<void> {
  const snapshot = await readAllSidebarItemsSnapshot();
  if (snapshot.authority !== 'ok' && snapshot.authority !== 'absent')
    throw new Error('Project ownership could not be checked');
  const context = getWorkspaceContextService().getState().context;
  for (const id of workspaceIds) {
    const item = snapshot.file.items.find((entry) => entry.id === id);
    // Missing sources retain the legacy missing-project refusal, with no effects.
    if (!item) continue;
    const ownership = await readWorkspaceOwnership(id);
    if (ownership.authority !== 'ok')
      throw new Error('Project ownership could not be checked');
    if (mode === 'temporary') continue;
    const owner = ownership.owner;
    if (owner) {
      const catalog = await getOrgProjectCatalogService().refresh(
        { kind: 'organization', organizationId: owner.organizationId },
        { force: true },
      );
      const project =
        catalog.stale || catalog.error
          ? null
          : (catalog.projects.find((row) => row.id === owner.projectId) ??
            null);
      if (!legacyOrganizationCombineAllowed(project))
        throw new Error(
          'Create a new shared multi-repo project to combine organization projects',
        );
    } else if (context.kind === 'organization' && item.type !== 'cowork') {
      const catalog = await getOrgProjectCatalogService().refresh(context, {
        force: true,
      });
      if (catalog.stale || catalog.error)
        throw new Error('Organization ownership could not be checked');
      const paths =
        item.type === 'single-repo'
          ? [item.repoPath]
          : item.repos.map((repo) => repo.repoPath);
      for (const path of paths) {
        const remote = await getRemoteUrlStrict(path);
        if (!remote) continue;
        const result = matchOrganizationRepository(
          [
            {
              organizationId: context.organizationId,
              projects: catalog.projects,
            },
          ],
          remote,
          holdsOrganizationRepository,
        );
        if (result.unknown || result.matches.length > 0)
          throw new Error(
            'Create a new shared multi-repo project to combine organization projects',
          );
      }
    }
  }
}
