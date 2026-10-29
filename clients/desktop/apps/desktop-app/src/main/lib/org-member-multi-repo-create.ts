import type { OrgMemberCreationOptions } from './org-member-code-create';
import type { OrgProjectConversionOptions } from './org-project-materialization';
import type {
  CreateOrgMemberMultiRepoProjectRequest,
  CreateOrgMemberMultiRepoProjectResult,
  OrgMemberFolderInspection,
  OrgProjectConversionErrorCode,
  OrgProjectConversionResult,
  OrgProjectConvertMultiRepoWorkspaceRequest,
} from '@canopy/desktop-shared/types';
import type { OrgOperationScope } from './org-cowork-binding-deps';

export interface OrgMemberMultiRepoCreatorDeps {
  eligible(organizationId: string, scope?: OrgOperationScope): Promise<boolean>;
  inspect(
    organizationId: string,
    path: string,
  ): Promise<OrgMemberFolderInspection>;
  workspace: {
    /** A new Personal multi-repo project with no repositories yet; its id. */
    create(name: string): Promise<string>;
    /** Add a multi-repo project folder as a Personal project; its id. */
    importFolder(path: string): Promise<string>;
    /**
     * Remove a project this create added. `sourceRepo` also removes the root
     * folder `create` started; an imported folder is the member's own.
     */
    remove(
      workspaceId: string,
      options: { sourceRepo: boolean },
    ): Promise<void>;
  };
  materialization: {
    /**
     * `memberCreated`: the member's own project, which may have no
     * repository yet (CAN-3546).
     */
    adoptMultiRepoWorkspace(
      request: OrgProjectConvertMultiRepoWorkspaceRequest,
      options: OrgProjectConversionOptions,
    ): Promise<OrgProjectConversionResult>;
  };
}

export interface OrgMemberMultiRepoCreator {
  create(
    request: CreateOrgMemberMultiRepoProjectRequest,
    options?: OrgMemberCreationOptions,
  ): Promise<CreateOrgMemberMultiRepoProjectResult>;
}

/** How a local project came to exist for this create, if it did. */
type LocalOrigin = 'existing' | 'created' | 'imported';

/**
 * Refusals the organization gave before it made anything: the local project
 * this create added has nothing to resume, so it is removed again.
 */
const NOTHING_CREATED: readonly OrgProjectConversionErrorCode[] = [
  'disabled',
  'member-project-limit',
  'repository-mismatch',
  'unsupported-workspace',
];

/**
 * A member's multi-repo organization project from Add project (CAN-3546).
 * Create new makes the local multi-repo project with no repositories and
 * binds it in place through the materialization coordinator, which creates
 * the member's private project on the server; the project's settings then
 * add its repositories, each checked against the organization's projects.
 * Existing folder checks every repository of the folder first, then adds
 * (or reuses) the project and binds it the same way.
 */
export function createOrgMemberMultiRepoCreator(
  deps: OrgMemberMultiRepoCreatorDeps,
): OrgMemberMultiRepoCreator {
  async function bind(
    organizationId: string,
    workspaceId: string,
    origin: LocalOrigin,
    privateMemory?: boolean,
    options?: OrgMemberCreationOptions,
  ): Promise<CreateOrgMemberMultiRepoProjectResult> {
    let result: OrgProjectConversionResult;
    try {
      await options?.beforeMutation?.();
      result = await deps.materialization.adoptMultiRepoWorkspace(
        { workspaceId, organizationId },
        // The member's own project: a Create new one (or its resume) has no
        // repository yet.
        {
          memberCreated: true,
          beforeMutation: options?.beforeMutation,
          credentialContext: options?.credentialContext,
          onMemberCreated: options?.onMemberCreated,
          ...(privateMemory !== undefined ? { privateMemory } : {}),
        },
      );
    } catch (error) {
      if (options?.propagateErrors) throw error;
      result = { ok: false, code: 'conversion-failed' };
    }
    if (result.ok)
      return {
        ok: true,
        organizationProjectId: result.owner.projectId,
        localWorkspaceId: result.workspaceId,
      };
    const discard =
      origin !== 'existing' && NOTHING_CREATED.includes(result.code);
    if (discard)
      await deps.workspace
        .remove(workspaceId, { sourceRepo: origin === 'created' })
        .catch((): void => {});
    switch (result.code) {
      case 'member-project-limit':
        return { ok: false, code: 'limit-reached' };
      case 'repository-mismatch':
        return { ok: false, code: 'refused', reason: 'outside-organization' };
      case 'disabled':
        return { ok: false, code: 'unavailable' };
      default:
        return discard
          ? { ok: false, code: 'create-failed' }
          : {
              ok: false,
              code: 'setup-failed',
              localWorkspaceId: workspaceId,
              conversionCode: result.code,
            };
    }
  }

  async function createNew(
    request: CreateOrgMemberMultiRepoProjectRequest,
    options?: OrgMemberCreationOptions,
  ): Promise<CreateOrgMemberMultiRepoProjectResult> {
    const name = request.name.trim();
    if (!name) return { ok: false, code: 'create-failed' };
    const workspaceId = await deps.workspace.create(name);
    return bind(
      request.organizationId,
      workspaceId,
      'created',
      request.privateMemory,
      options,
    );
  }

  async function fromFolder(
    request: CreateOrgMemberMultiRepoProjectRequest,
    folderPath: string,
    options?: OrgMemberCreationOptions,
  ): Promise<CreateOrgMemberMultiRepoProjectResult> {
    // Checked again at create time: the folder may have changed since.
    const inspection = await deps.inspect(request.organizationId, folderPath);
    if (inspection.kind === 'refused')
      return {
        ok: false,
        code: 'refused',
        reason: inspection.reason,
        ...(inspection.repositories
          ? { repositories: inspection.repositories }
          : {}),
      };
    if (inspection.kind !== 'multi-repo')
      return { ok: false, code: 'create-failed' };
    if (inspection.personalWorkspaceId !== undefined)
      return bind(
        request.organizationId,
        inspection.personalWorkspaceId,
        'existing',
        request.privateMemory,
        options,
      );
    const workspaceId = await deps.workspace.importFolder(folderPath);
    return bind(
      request.organizationId,
      workspaceId,
      'imported',
      request.privateMemory,
      options,
    );
  }

  return {
    async create(
      request,
      options,
    ): Promise<CreateOrgMemberMultiRepoProjectResult> {
      try {
        if (!(await deps.eligible(request.organizationId, options?.scope)))
          return { ok: false, code: 'unavailable' };
        // A resume binds the project a failed attempt already made.
        if (request.localWorkspaceId !== undefined)
          return await bind(
            request.organizationId,
            request.localWorkspaceId,
            'existing',
            request.privateMemory,
            options,
          );
        if (request.folderPath !== undefined)
          return await fromFolder(request, request.folderPath, options);
        return await createNew(request, options);
      } catch (error) {
        if (options?.propagateErrors) throw error;
        return { ok: false, code: 'create-failed' };
      }
    },
  };
}
