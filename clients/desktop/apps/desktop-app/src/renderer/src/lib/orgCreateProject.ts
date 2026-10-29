import type {
  AppAdvisorUiStateSnapshot,
  OrgMemberFolderInspection,
  OrgMemberFolderRefusalReason,
} from '@canopy/desktop-shared/types';
import { orgOutsideRepositoriesText } from '@canopy/desktop-shared/lib/org-multi-repo-copy';

/**
 * Where a chosen folder's check stands in an organization's Existing folder
 * option (CAN-3534). The folder decides what is added, so nothing is created
 * until the check has answered.
 */
export type OrgCreateFolderCheck =
  | { readonly status: 'checking' }
  | {
      readonly status: 'checked';
      readonly inspection: OrgMemberFolderInspection;
    };

/** `multi-repo` gathers organization repositories into one project (CAN-3546). */
export type OrgCreateProjectKind = 'code' | 'cowork' | 'multi-repo';

type AddWorkspaceSnapshot = NonNullable<
  AppAdvisorUiStateSnapshot['addWorkspace']
>;

interface OrgFolderDraft {
  /** The organization can take the member's Code projects. */
  readonly codeEligible: boolean;
  readonly folderPath: string | null;
  readonly folderCheck: OrgCreateFolderCheck | null;
}

/**
 * What a chosen folder becomes, or `null` while it is unchecked or was
 * refused. Without Code eligibility every folder is Cowork, as before
 * CAN-3534, and is never checked.
 */
export function resolveOrgFolderProjectKind({
  codeEligible,
  folderCheck,
}: Omit<OrgFolderDraft, 'folderPath'>): OrgCreateProjectKind | null {
  if (!codeEligible) return 'cowork';
  if (folderCheck?.status !== 'checked') return null;
  return folderCheck.inspection.kind === 'refused'
    ? null
    : folderCheck.inspection.kind;
}

/**
 * A routine outcome is added as soon as the folder is picked, as in Personal.
 * One that moves a Personal project, or links the folder to a project the
 * organization already has, waits for the member to confirm it.
 */
export function orgFolderNeedsConfirmation(
  inspection: OrgMemberFolderInspection,
): boolean {
  if (inspection.kind === 'multi-repo')
    return inspection.personalWorkspaceId !== undefined;
  return (
    inspection.kind === 'code' &&
    (inspection.personalWorkspaceId !== undefined ||
      inspection.target !== 'new')
  );
}

/** The chosen folder's kind for App Advisor: a category, never the path. */
export function resolveOrgCreateFolderKind({
  codeEligible,
  folderPath,
  folderCheck,
}: OrgFolderDraft): NonNullable<AddWorkspaceSnapshot['folderKind']> {
  if (folderPath === null) return 'none';
  if (!codeEligible) return 'folder';
  if (folderCheck?.status !== 'checked') return 'checking';
  switch (folderCheck.inspection.kind) {
    case 'cowork':
      return 'folder';
    case 'code':
    case 'multi-repo':
      return 'git-repository';
    case 'refused':
      return 'refused';
  }
}

/**
 * Why a folder cannot be used, with what to do instead. More than one
 * matching organization project reads like no access: the member cannot pick
 * between projects, so an admin has to sort it out either way.
 */
export function orgCreateFolderRefusalText(
  reason: OrgMemberFolderRefusalReason,
  organizationName: string,
  repositories?: readonly string[],
): string {
  switch (reason) {
    case 'outside-organization':
      return orgOutsideRepositoriesText(repositories ?? [], organizationName);
    case 'inside-repo':
      return "This folder is inside a git repository. Choose the repository's top folder.";
    case 'linked-worktree':
      return "This folder is a git worktree. Choose the repository's main folder.";
    case 'multi-repo':
      return 'This folder is a multi-repo project. Choose a folder with one repository.';
    case 'already-org-project':
      return 'This folder is already an organization project. Choose another folder.';
    case 'overlaps-project':
      return 'This folder overlaps a project you already have. Choose another folder.';
    case 'no-access':
    case 'ambiguous':
      return `${organizationName} already has a project for this repository. Ask an admin for access.`;
    case 'unreadable':
      return "Couldn't check this folder. Choose it again.";
  }
}
