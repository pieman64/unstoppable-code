import { ORG_PROJECT_LIMITS } from '@canopy/protocol/org-projects';
import { orgCoworkProjectWorkspaceId } from '@canopy/protocol/ui-labels';
import type {
  CreateOrgCoworkProjectRequest,
  CreateOrgCoworkProjectResult,
  DesktopOrgProjectCatalogSnapshot,
} from '@canopy/desktop-shared/types';
import type { CreateMemberOrgProjectResult } from '../canopy-cloud/client';
import type {
  OrgCoworkBinding,
  OrgCoworkBindingResult,
} from './org-cowork-binding';
import type {
  OrgCoworkBlueprintSeed,
  StageOrgCoworkWorkspaceInput,
} from './cowork-workspace-crud';

export interface OrgCoworkCreatorDeps {
  eligible(organizationId: string): Promise<boolean>;
  cloud: {
    create(request: {
      organizationId: string;
      kind: 'COWORK';
      name: string;
      privateMemory?: boolean;
    }): Promise<CreateMemberOrgProjectResult>;
  };
  catalog: {
    refresh(organizationId: string): Promise<DesktopOrgProjectCatalogSnapshot>;
  };
  binding: OrgCoworkBinding;
  folder: {
    preflight(
      path: string,
      excludeWorkspaceId?: string,
    ): Promise<{
      path: string;
      attachedGitRepository: boolean;
    }>;
  };
  blueprint: {
    resolve(source: {
      externalId: string;
      contentHash: string;
    }): Promise<OrgCoworkBlueprintSeed>;
  };
  local: {
    stage(input: StageOrgCoworkWorkspaceInput): Promise<void>;
    publish(input: {
      id: string;
      name: string;
      owner: OrgCoworkBindingResult['owner'];
      precheck?: () => Promise<void>;
    }): Promise<unknown>;
    discard(id: string, projectId: string): Promise<void>;
  };
  telemetry(input: { projectId: string; localWorkspaceId: string }): void;
}

export interface OrgCoworkCreator {
  create(
    request: CreateOrgCoworkProjectRequest,
  ): Promise<CreateOrgCoworkProjectResult>;
  setUp(input: {
    organizationId: string;
    projectId: string;
    name: string;
  }): Promise<OrgCoworkBindingResult>;
}

function validateName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > ORG_PROJECT_LIMITS.nameLength) {
    throw new Error(
      `Project name must be between 1 and ${ORG_PROJECT_LIMITS.nameLength} characters`,
    );
  }
  return trimmed;
}

export function createOrgCoworkCreator(
  deps: OrgCoworkCreatorDeps,
): OrgCoworkCreator {
  async function bind(input: {
    organizationId: string;
    projectId: string;
    name: string;
    folderPath?: string;
    blueprint?: OrgCoworkBlueprintSeed;
  }): Promise<{
    binding: OrgCoworkBindingResult;
    attachedGitRepository: boolean;
  }> {
    const localWorkspaceId = orgCoworkProjectWorkspaceId(input.projectId);
    const folder = input.folderPath
      ? await deps.folder.preflight(input.folderPath, localWorkspaceId)
      : undefined;
    let completionStarted = false;
    try {
      const binding = await deps.binding.bindOrgCoworkWorkspace({
        organizationId: input.organizationId,
        projectId: input.projectId,
        localWorkspaceId,
        rotateClaimKeyOnConflict: true,
        createLocal: async (owner) => {
          const currentFolder = input.folderPath
            ? await deps.folder.preflight(input.folderPath, localWorkspaceId)
            : undefined;
          await deps.local.stage({
            id: localWorkspaceId,
            owner,
            ...(currentFolder ? { externalPath: currentFolder.path } : {}),
            ...(input.blueprint ? { blueprint: input.blueprint } : {}),
          });
        },
        publishLocal: async (owner) => {
          completionStarted = true;
          const folderPath = input.folderPath;
          await deps.local.publish({
            id: localWorkspaceId,
            name: input.name,
            owner,
            ...(folderPath
              ? {
                  precheck: async (): Promise<void> => {
                    await deps.folder.preflight(folderPath, localWorkspaceId);
                  },
                }
              : {}),
          });
        },
      });
      deps.telemetry({ projectId: input.projectId, localWorkspaceId });
      await deps.catalog.refresh(input.organizationId);
      return {
        binding,
        attachedGitRepository: folder?.attachedGitRepository ?? false,
      };
    } catch (error) {
      if (!completionStarted) {
        await deps.local
          .discard(localWorkspaceId, input.projectId)
          .catch((): void => {});
      }
      throw error;
    }
  }

  async function setUp(input: {
    organizationId: string;
    projectId: string;
    name: string;
  }): Promise<OrgCoworkBindingResult> {
    if (!(await deps.eligible(input.organizationId))) {
      throw new Error('Organization projects are not available');
    }
    const snapshot = await deps.catalog.refresh(input.organizationId);
    const project = snapshot.projects.find((row) => row.id === input.projectId);
    if (
      !project ||
      project.organizationId !== input.organizationId ||
      project.kind !== 'COWORK' ||
      project.purpose !== 'project' ||
      project.location !== 'LOCAL' ||
      !project.capabilities.use
    ) {
      throw new Error('Organization Cowork project is unavailable');
    }
    return (
      await bind({
        organizationId: input.organizationId,
        projectId: input.projectId,
        name: validateName(input.name),
      })
    ).binding;
  }

  return {
    async create(request): Promise<CreateOrgCoworkProjectResult> {
      if (!(await deps.eligible(request.organizationId))) {
        return {
          ok: false,
          code: 'unavailable',
          attachedGitRepository: false,
        };
      }
      const name = validateName(request.name);
      let projectId = request.organizationProjectId;
      let authoritativePrivateMemory: boolean | undefined;
      if (projectId) {
        const snapshot = await deps.catalog.refresh(request.organizationId);
        const project = snapshot.projects.find((row) => row.id === projectId);
        if (
          !project ||
          project.organizationId !== request.organizationId ||
          project.kind !== 'COWORK' ||
          project.purpose !== 'project' ||
          project.location !== 'LOCAL' ||
          !project.capabilities.use
        ) {
          return {
            ok: false,
            code: 'setup-failed',
            organizationProjectId: projectId,
            attachedGitRepository: false,
          };
        }
        authoritativePrivateMemory = project.privateMemory;
      }
      let folder: { path: string; attachedGitRepository: boolean } | undefined;
      let blueprint: OrgCoworkBlueprintSeed | undefined;
      try {
        folder = request.folderPath
          ? await deps.folder.preflight(
              request.folderPath,
              projectId ? orgCoworkProjectWorkspaceId(projectId) : undefined,
            )
          : undefined;
        blueprint = request.blueprint
          ? await deps.blueprint.resolve(request.blueprint)
          : undefined;
      } catch {
        if (projectId) {
          return {
            ok: false,
            code: 'setup-failed',
            organizationProjectId: projectId,
            attachedGitRepository: folder?.attachedGitRepository ?? false,
          };
        }
        return {
          ok: false,
          code: 'create-failed',
          attachedGitRepository: folder?.attachedGitRepository ?? false,
        };
      }
      if (!projectId) {
        let created: CreateMemberOrgProjectResult;
        try {
          created = await deps.cloud.create({
            organizationId: request.organizationId,
            kind: 'COWORK',
            name,
            ...(request.privateMemory !== undefined
              ? { privateMemory: request.privateMemory }
              : {}),
          });
        } catch {
          return {
            ok: false,
            code: 'create-failed',
            attachedGitRepository: folder?.attachedGitRepository ?? false,
          };
        }
        if (!created.ok) {
          return {
            ok: false,
            code: 'limit-reached',
            attachedGitRepository: folder?.attachedGitRepository ?? false,
          };
        }
        projectId = created.project.id;
        authoritativePrivateMemory = created.project.privateMemory;
      }
      if (
        request.privateMemory === true &&
        authoritativePrivateMemory !== true
      ) {
        return {
          ok: false,
          code: 'setup-failed',
          organizationProjectId: projectId,
          attachedGitRepository: folder?.attachedGitRepository ?? false,
        };
      }
      try {
        const result = await bind({
          organizationId: request.organizationId,
          projectId,
          name,
          ...(folder ? { folderPath: folder.path } : {}),
          ...(blueprint ? { blueprint } : {}),
        });
        return {
          ok: true,
          organizationProjectId: projectId,
          localWorkspaceId: orgCoworkProjectWorkspaceId(projectId),
          attachedGitRepository: result.attachedGitRepository,
        };
      } catch {
        return {
          ok: false,
          code: 'setup-failed',
          organizationProjectId: projectId,
          attachedGitRepository: folder?.attachedGitRepository ?? false,
        };
      }
    },
    setUp,
  };
}
