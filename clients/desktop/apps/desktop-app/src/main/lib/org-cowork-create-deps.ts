import { realpath } from 'node:fs/promises';
import { createMemberOrgProject } from '../canopy-cloud/client';
import { resolveCuratedBlueprintSeed } from './curated-blueprint-seed';
import {
  discardStagedOrgCoworkWorkspace,
  publishOrgCoworkWorkspace,
  stageOrgCoworkWorkspace,
} from './cowork-workspace-crud';
import { recordStandaloneProjectCrudTelemetry } from './desktop-telemetry';
import { isGitRepo } from './git';
import {
  getOrgCoworkBinding,
  isOrgCoworkOperationEligible,
} from './org-cowork-binding-deps';
import {
  createOrgCoworkCreator,
  type OrgCoworkCreator,
} from './org-cowork-create';
import { getOrgProjectCatalogService } from '../services/org-project-catalog-service';
import { readAllSidebarItems } from './sidebar-items';
import { assertFolderIsImportable } from './workspace-service';

let creator: OrgCoworkCreator | undefined;

export function getOrgCoworkCreator(): OrgCoworkCreator {
  creator ??= createOrgCoworkCreator({
    eligible: isOrgCoworkOperationEligible,
    cloud: { create: createMemberOrgProject },
    catalog: {
      refresh: (organizationId) =>
        getOrgProjectCatalogService().refresh(
          { kind: 'organization', organizationId },
          { force: true },
        ),
    },
    binding: getOrgCoworkBinding(),
    folder: {
      preflight: async (candidatePath, excludeWorkspaceId) => {
        const path = await realpath(candidatePath);
        const items = (await readAllSidebarItems()).items.filter(
          (item) => item.id !== excludeWorkspaceId,
        );
        await assertFolderIsImportable(path, items);
        return { path, attachedGitRepository: await isGitRepo(path) };
      },
    },
    blueprint: {
      resolve: async (source) => {
        const seed = await resolveCuratedBlueprintSeed(source);
        return {
          externalId: seed.blueprint.externalId,
          document: seed.blueprint.document,
          defaultPluginSelections: seed.selections,
        };
      },
    },
    local: {
      stage: stageOrgCoworkWorkspace,
      publish: publishOrgCoworkWorkspace,
      discard: discardStagedOrgCoworkWorkspace,
    },
    telemetry: ({ projectId }) => {
      recordStandaloneProjectCrudTelemetry({
        action: 'create',
        projectId,
      });
    },
  });
  return creator;
}

export function resetOrgCoworkCreatorForTests(): void {
  creator = undefined;
}
