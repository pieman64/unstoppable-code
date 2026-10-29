import { rm } from 'node:fs/promises';
import { getOrgProjectMaterialization } from './org-project-materialization';
import { getOrgMemberFolderInspector } from './org-member-folder-inspection';
import { isOrgMemberCodeOperationEligible } from './org-cowork-binding-deps';
import { readAllSidebarItems } from './sidebar-items';
import { createWorkspace } from './workspace-creation';
import { deleteWorkspaceById } from './workspace-deletion';
import {
  createOrgMemberMultiRepoCreator,
  type OrgMemberMultiRepoCreator,
} from './org-member-multi-repo-create';

let creator: OrgMemberMultiRepoCreator | undefined;

export function getOrgMemberMultiRepoCreator(): OrgMemberMultiRepoCreator {
  creator ??= createOrgMemberMultiRepoCreator({
    eligible: (organizationId, scope) =>
      isOrgMemberCodeOperationEligible(organizationId, { scope }),
    inspect: (organizationId, path) =>
      getOrgMemberFolderInspector().inspect(organizationId, path),
    workspace: {
      async create(name): Promise<string> {
        const { workspace } = await createWorkspace({
          source: 'org-member-multi-repo-create',
          variant: { kind: 'new-multi-repo', name },
        });
        return workspace.id;
      },
      async importFolder(path): Promise<string> {
        const { workspace } = await createWorkspace({
          source: 'org-member-multi-repo-create',
          variant: { kind: 'local-folder', folderPath: path },
        });
        return workspace.id;
      },
      async remove(workspaceId, options): Promise<void> {
        const item = (await readAllSidebarItems()).items.find(
          (candidate) => candidate.id === workspaceId,
        );
        await deleteWorkspaceById(workspaceId, 'org-member-multi-repo-create');
        if (
          options.sourceRepo &&
          item?.type === 'multi-repo' &&
          item.sourceRepoPath !== undefined
        )
          await rm(item.sourceRepoPath, { recursive: true, force: true });
      },
    },
    materialization: {
      adoptMultiRepoWorkspace: (request, options) =>
        getOrgProjectMaterialization().convertMultiRepoWorkspace(
          request,
          options,
        ),
    },
  });
  return creator;
}
