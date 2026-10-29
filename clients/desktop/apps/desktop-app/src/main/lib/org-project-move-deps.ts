import {
  isOrgCoworkOperationEligible,
  isOrgMemberCodeOperationEligible,
} from './org-cowork-binding-deps';
import { getOrgMemberCodeCreator } from './org-member-code-create-deps';
import { getOrgMemberMultiRepoCreator } from './org-member-multi-repo-create-deps';
import { getOrgProjectMaterialization } from './org-project-materialization';
import { readAllSidebarItems } from './sidebar-items';
import {
  createOrgProjectMover,
  type OrgProjectMover,
} from './org-project-move';

let mover: OrgProjectMover | undefined;

export function getOrgProjectMover(): OrgProjectMover {
  mover ??= createOrgProjectMover({
    readItems: async () => (await readAllSidebarItems()).items,
    eligible: (organizationId, kind) =>
      kind === 'cowork'
        ? isOrgCoworkOperationEligible(organizationId, { scope: 'membership' })
        : isOrgMemberCodeOperationEligible(organizationId, {
            scope: 'membership',
          }),
    code: {
      create: (request, options) =>
        getOrgMemberCodeCreator().create(request, options),
    },
    multiRepo: {
      create: (request, options) =>
        getOrgMemberMultiRepoCreator().create(request, options),
    },
    materialization: {
      convertCoworkWorkspace: (request) =>
        getOrgProjectMaterialization().convertCoworkWorkspace(request),
    },
  });
  return mover;
}

export function resetOrgProjectMoverForTests(): void {
  mover = undefined;
}
