import { rm } from 'node:fs/promises';
import { createMemberOrgProject } from '../canopy-cloud/client';
import { getOrgProjectCatalogService } from '../services/org-project-catalog-service';
import { getOrgProjectMaterialization } from './org-project-materialization';
import { getOrgMemberFolderInspector } from './org-member-folder-inspection';
import { isOrgMemberCodeOperationEligible } from './org-cowork-binding-deps';
import { initNewLocalRepoFolder } from './workspace-service';
import {
  createOrgMemberCodeCreator,
  type OrgMemberCodeCreator,
} from './org-member-code-create';

let creator: OrgMemberCodeCreator | undefined;

export function getOrgMemberCodeCreator(): OrgMemberCodeCreator {
  creator ??= createOrgMemberCodeCreator({
    eligible: (organizationId, scope) =>
      isOrgMemberCodeOperationEligible(organizationId, { scope }),
    inspect: (organizationId, path, options) =>
      getOrgMemberFolderInspector().inspect(organizationId, path, options),
    cloud: { create: createMemberOrgProject },
    catalog: {
      refresh: (organizationId) =>
        getOrgProjectCatalogService().refresh(
          { kind: 'organization', organizationId },
          { force: true },
        ),
    },
    materialization: getOrgProjectMaterialization(),
    repo: {
      init: initNewLocalRepoFolder,
      remove: (path) => rm(path, { recursive: true, force: true }),
    },
  });
  return creator;
}

export function resetOrgMemberCodeCreatorForTests(): void {
  creator = undefined;
}
