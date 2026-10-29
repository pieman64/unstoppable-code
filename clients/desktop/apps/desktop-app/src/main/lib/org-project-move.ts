import { isDefaultCoworkWorkspaceId } from '@canopy/protocol/ui-labels';
import type { OrgProjectMoveErrorCode } from '@canopy/protocol/org-projects';
import type {
  CreateOrgMemberCodeProjectRequest,
  CreateOrgMemberCodeProjectResult,
  CreateOrgMemberMultiRepoProjectRequest,
  CreateOrgMemberMultiRepoProjectResult,
  OrgMemberFolderRefusalReason,
  OrgProjectConversionErrorCode,
  OrgProjectConversionResult,
  OrgProjectConvertCoworkWorkspaceRequest,
  OrgProjectMoveRequest,
  OrgProjectMoveResult,
  SidebarItem,
} from '@canopy/desktop-shared/types';

export interface OrgProjectMoverDeps {
  readItems(): Promise<SidebarItem[]>;
  /**
   * Membership-scoped eligibility: `code` is the member Code project check,
   * `cowork` the Cowork one. Throws when the account cannot be read.
   */
  eligible(organizationId: string, kind: 'code' | 'cowork'): Promise<boolean>;
  code: {
    create(
      request: CreateOrgMemberCodeProjectRequest,
      options: { scope: 'membership' },
    ): Promise<CreateOrgMemberCodeProjectResult>;
  };
  multiRepo: {
    create(
      request: CreateOrgMemberMultiRepoProjectRequest,
      options: { scope: 'membership' },
    ): Promise<CreateOrgMemberMultiRepoProjectResult>;
  };
  materialization: {
    convertCoworkWorkspace(
      request: OrgProjectConvertCoworkWorkspaceRequest,
    ): Promise<OrgProjectConversionResult>;
  };
}

export interface OrgProjectMover {
  move(request: OrgProjectMoveRequest): Promise<OrgProjectMoveResult>;
}

type MoveFailure = Extract<OrgProjectMoveResult, { ok: false }>;

function failure(
  code: OrgProjectMoveErrorCode,
  organizationProjectId?: string,
): MoveFailure {
  return organizationProjectId === undefined
    ? { ok: false, code }
    : { ok: false, code, organizationProjectId };
}

/** The move's answer for a refused or failed in-place conversion. */
export function moveCodeForConversion(
  code: OrgProjectConversionErrorCode,
): OrgProjectMoveErrorCode {
  switch (code) {
    case 'disabled':
      return 'unavailable';
    case 'member-project-limit':
      return 'limit-reached';
    case 'repository-mismatch':
      return 'repository-outside-organization';
    case 'unsupported-workspace':
    case 'workspace-not-found':
    case 'workspace-unreadable':
    case 'not-personal':
    case 'project-unavailable':
    case 'project-already-bound':
    case 'repository-unavailable':
    case 'busy':
    case 'offline':
      return code;
    case 'conversion-failed':
    case 'previously-converted':
      return 'move-failed';
    default:
      return 'move-failed';
  }
}

function moveCodeForRefusal(
  reason: OrgMemberFolderRefusalReason,
): OrgProjectMoveErrorCode {
  if (
    reason === 'outside-organization' ||
    reason === 'no-access' ||
    reason === 'ambiguous'
  )
    return 'repository-outside-organization';
  // A folder, remote, or catalog read that failed may succeed on a retry.
  return reason === 'unreadable' ? 'move-failed' : 'unsupported-workspace';
}

function createFailure(
  result: Extract<
    CreateOrgMemberCodeProjectResult | CreateOrgMemberMultiRepoProjectResult,
    { ok: false }
  >,
): MoveFailure {
  const organizationProjectId =
    'organizationProjectId' in result
      ? result.organizationProjectId
      : undefined;
  switch (result.code) {
    case 'unavailable':
      return failure('unavailable', organizationProjectId);
    case 'limit-reached':
      return failure('limit-reached', organizationProjectId);
    case 'refused':
      return failure(moveCodeForRefusal(result.reason));
    case 'setup-failed':
      return failure(
        result.conversionCode === undefined
          ? 'move-failed'
          : moveCodeForConversion(result.conversionCode),
        organizationProjectId,
      );
    case 'create-failed':
      return failure('move-failed', organizationProjectId);
    default:
      return failure('move-failed', organizationProjectId);
  }
}

/**
 * Move a Personal project, with every worktree in it, to one of the member's
 * organizations, chosen explicitly in the sidebar. The organization is
 * checked against the member's organizations, not the selected context, and
 * the context is never switched. Single-repo and multi-repo projects go
 * through the member create flows, which find or create the organization's
 * definition and convert in place; Cowork projects convert in place to a new
 * private Cowork project. A second move of the same project while one runs
 * is `busy` before anything is created on the server.
 */
export function createOrgProjectMover(
  deps: OrgProjectMoverDeps,
): OrgProjectMover {
  const moving = new Set<string>();
  return {
    async move(request): Promise<OrgProjectMoveResult> {
      const { workspaceId, organizationId } = request;
      if (moving.has(workspaceId)) return failure('busy');
      moving.add(workspaceId);
      try {
        const item = (await deps.readItems()).find(
          (candidate) => candidate.id === workspaceId,
        );
        if (!item) return failure('workspace-not-found');
        if (item.owner !== undefined) return failure('not-personal');
        if (isDefaultCoworkWorkspaceId(item.id))
          return failure('unsupported-workspace');
        if (
          item.type !== 'single-repo' &&
          item.type !== 'multi-repo' &&
          item.type !== 'cowork'
        )
          return failure('unsupported-workspace');
        if (
          !(await deps.eligible(
            organizationId,
            item.type === 'cowork' ? 'cowork' : 'code',
          ))
        )
          return failure('unavailable');
        if (item.type === 'cowork') {
          const converted = await deps.materialization.convertCoworkWorkspace({
            workspaceId: item.id,
            organizationId,
          });
          return converted.ok
            ? {
                ok: true,
                workspaceId: converted.workspaceId,
                organizationId,
                projectId: converted.owner.projectId,
              }
            : failure(
                moveCodeForConversion(converted.code),
                converted.organizationProjectId,
              );
        }
        const created =
          item.type === 'single-repo'
            ? await deps.code.create(
                {
                  organizationId,
                  name: item.name,
                  folderPath: item.repoPath,
                },
                { scope: 'membership' },
              )
            : await deps.multiRepo.create(
                { organizationId, name: item.name, localWorkspaceId: item.id },
                { scope: 'membership' },
              );
        return created.ok
          ? {
              ok: true,
              workspaceId: created.localWorkspaceId,
              organizationId,
              projectId: created.organizationProjectId,
            }
          : createFailure(created);
      } catch {
        return failure('move-failed');
      } finally {
        moving.delete(workspaceId);
      }
    },
  };
}
