import type { OrgProjectSummary } from '@canopy/protocol/org-projects';
import type {
  CreateOrgMemberCodeProjectRequest,
  CreateOrgMemberCodeProjectResult,
  DesktopOrgProjectCatalogSnapshot,
  OrgMemberFolderInspection,
  OrgProjectConversionResult,
} from '@canopy/desktop-shared/types';
import type {
  CanopyCloudCredentialContext,
  CreateMemberOrgProjectResult,
} from '../canopy-cloud/client';
import type { OrgMemberFolderInspectionOptions } from './org-member-folder-inspection';
import type { OrgOperationScope } from './org-cowork-binding-deps';
import type { OrgProjectConversionOptions } from './org-project-materialization';

export interface OrgMemberCodeCreatorDeps {
  eligible(organizationId: string, scope?: OrgOperationScope): Promise<boolean>;
  inspect(
    organizationId: string,
    path: string,
    options?: OrgMemberFolderInspectionOptions,
  ): Promise<OrgMemberFolderInspection>;
  cloud: {
    create(
      request: {
        organizationId: string;
        kind: 'CODE';
        name: string;
        privateMemory?: boolean;
        creationKey?: string;
        repository: { host: 'github.com'; owner: string; name: string } | null;
      },
      credentialContext?: CanopyCloudCredentialContext,
    ): Promise<CreateMemberOrgProjectResult>;
  };
  catalog: {
    refresh(organizationId: string): Promise<DesktopOrgProjectCatalogSnapshot>;
  };
  materialization: {
    adoptCheckout(
      input: {
        projectId: string;
        organizationId: string;
        path: string;
        preferredName: string;
      },
      options?: { createdRepo?: boolean },
    ): Promise<{ localWorkspaceId: string }>;
    convertWorkspace(
      request: {
        workspaceId: string;
        organizationId: string;
        projectId: string;
      },
      options?: OrgProjectConversionOptions,
    ): Promise<OrgProjectConversionResult>;
  };
  repo: {
    init(name: string): Promise<string>;
    remove(path: string): Promise<void>;
  };
}

export interface OrgMemberCreationOptions {
  /** Membership scope allows an explicit move to any member organization. */
  scope?: OrgOperationScope;
  /** Durable orchestration distinguishes an unknown write from a refusal. */
  propagateErrors?: boolean;
  beforeMutation?: () => Promise<void>;
  onMemberCreated?: (projectId: string) => Promise<void>;
  credentialContext?: CanopyCloudCredentialContext;
}
export interface OrgMemberCodeCreator {
  create(
    request: CreateOrgMemberCodeProjectRequest,
    options?: OrgMemberCreationOptions,
  ): Promise<CreateOrgMemberCodeProjectResult>;
}

interface SetupOutcome {
  result: CreateOrgMemberCodeProjectResult;
  completionSent: boolean;
}

function sameRepository(
  project: OrgProjectSummary,
  repository: { host: 'github.com'; owner: string; name: string },
): boolean {
  return (
    project.repository?.host.toLowerCase() === repository.host &&
    project.repository.owner.toLowerCase() === repository.owner.toLowerCase() &&
    project.repository.name.toLowerCase() === repository.name.toLowerCase()
  );
}

function completionWasSent(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'completionSent' in error &&
    error.completionSent === true
  );
}

export function createOrgMemberCodeCreator(
  deps: OrgMemberCodeCreatorDeps,
): OrgMemberCodeCreator {
  async function setUp(
    request: CreateOrgMemberCodeProjectRequest,
    project: OrgProjectSummary,
    inspection: Extract<OrgMemberFolderInspection, { kind: 'code' }>,
    path: string,
    createdRepo: boolean,
    options?: OrgMemberCreationOptions,
  ): Promise<SetupOutcome> {
    await options?.beforeMutation?.();
    await options?.onMemberCreated?.(project.id);
    if (inspection.personalWorkspaceId) {
      const converted = await deps.materialization.convertWorkspace(
        {
          workspaceId: inspection.personalWorkspaceId,
          organizationId: request.organizationId,
          projectId: project.id,
        },
        {
          ...(project.memberOwned && project.visibility === 'private'
            ? { memberCreated: true }
            : {}),
          ...(options?.beforeMutation
            ? { beforeMutation: options.beforeMutation }
            : {}),
          ...(options?.credentialContext
            ? { credentialContext: options.credentialContext }
            : {}),
        },
      );
      return {
        completionSent: false,
        result: converted.ok
          ? {
              ok: true,
              organizationProjectId: project.id,
              localWorkspaceId: converted.workspaceId,
            }
          : {
              ok: false,
              code: 'setup-failed',
              organizationProjectId: project.id,
              conversionCode: converted.code,
            },
      };
    }
    try {
      const adopted = await deps.materialization.adoptCheckout(
        {
          projectId: project.id,
          organizationId: request.organizationId,
          path,
          preferredName: project.name,
        },
        { createdRepo },
      );
      return {
        completionSent: false,
        result: {
          ok: true,
          organizationProjectId: project.id,
          localWorkspaceId: adopted.localWorkspaceId,
        },
      };
    } catch (error) {
      return {
        completionSent: completionWasSent(error),
        result: {
          ok: false,
          code: 'setup-failed',
          organizationProjectId: project.id,
        },
      };
    }
  }

  async function findProject(
    organizationId: string,
    projectId: string,
  ): Promise<OrgProjectSummary | undefined> {
    return (await deps.catalog.refresh(organizationId)).projects.find(
      (project) => project.id === projectId,
    );
  }

  return {
    async create(
      request: CreateOrgMemberCodeProjectRequest,
      options?: OrgMemberCreationOptions,
    ): Promise<CreateOrgMemberCodeProjectResult> {
      if (!(await deps.eligible(request.organizationId, options?.scope)))
        return { ok: false, code: 'unavailable' };
      const name = request.name.trim();
      if (!name) return { ok: false, code: 'create-failed' };
      let createdPath: string | undefined;
      let retainCreatedPath = false;
      let path = request.folderPath;
      try {
        if (!path) {
          createdPath = await deps.repo.init(name);
          path = createdPath;
        }
        const inspectionOptions: OrgMemberFolderInspectionOptions | undefined =
          createdPath === undefined ? undefined : { allowInsideDataDir: true };
        let inspection = await deps.inspect(
          request.organizationId,
          path,
          inspectionOptions,
        );
        if (inspection.kind !== 'code')
          return {
            ok: false,
            code: 'refused',
            reason:
              inspection.kind === 'refused' ? inspection.reason : 'unreadable',
          };
        let project = request.organizationProjectId
          ? await findProject(
              request.organizationId,
              request.organizationProjectId,
            )
          : inspection.target === 'new'
            ? undefined
            : await findProject(
                request.organizationId,
                inspection.target.projectId,
              );
        if (request.organizationProjectId && !project)
          return {
            ok: false,
            code: 'setup-failed',
            organizationProjectId: request.organizationProjectId,
          };
        if (!project) {
          await options?.beforeMutation?.();
          const createRequest: Parameters<
            OrgMemberCodeCreatorDeps['cloud']['create']
          >[0] = {
            ...(request.creationKey
              ? { creationKey: request.creationKey }
              : {}),
            organizationId: request.organizationId,
            kind: 'CODE',
            name,
            ...(request.privateMemory !== undefined
              ? { privateMemory: request.privateMemory }
              : {}),
            repository: inspection.repository,
          };
          const created = options?.credentialContext
            ? await deps.cloud.create(createRequest, options.credentialContext)
            : await deps.cloud.create(createRequest);
          if (created.ok) await options?.onMemberCreated?.(created.project.id);
          if (!created.ok) {
            if (created.code === 'limit-reached')
              return { ok: false, code: 'limit-reached' };
            if (created.code === 'repository-project-exists') {
              inspection = await deps.inspect(
                request.organizationId,
                path,
                inspectionOptions,
              );
              if (inspection.kind !== 'code' || inspection.target === 'new')
                return { ok: false, code: 'refused', reason: 'no-access' };
              project = await findProject(
                request.organizationId,
                inspection.target.projectId,
              );
            } else {
              const repository = inspection.repository;
              if (!repository) return { ok: false, code: 'create-failed' };
              const snapshot = await deps.catalog.refresh(
                request.organizationId,
              );
              project = snapshot.projects.find(
                (candidate) =>
                  candidate.memberOwned &&
                  candidate.visibility === 'private' &&
                  candidate.capabilities.administer &&
                  sameRepository(candidate, repository),
              );
            }
          } else {
            project = created.project;
          }
        }
        if (!project) return { ok: false, code: 'create-failed' };
        if (request.privateMemory === true && project.privateMemory !== true) {
          return {
            ok: false,
            code: 'setup-failed',
            organizationProjectId: project.id,
          };
        }
        const outcome = await setUp(
          request,
          project,
          inspection,
          path,
          createdPath !== undefined,
          options,
        );
        retainCreatedPath = outcome.result.ok || outcome.completionSent;
        return outcome.result;
      } catch (error) {
        retainCreatedPath = completionWasSent(error);
        if (options?.propagateErrors) throw error;
        return request.organizationProjectId
          ? {
              ok: false,
              code: 'setup-failed',
              organizationProjectId: request.organizationProjectId,
            }
          : { ok: false, code: 'create-failed' };
      } finally {
        if (createdPath && !retainCreatedPath)
          await deps.repo.remove(createdPath).catch((): void => {});
      }
    },
  };
}
