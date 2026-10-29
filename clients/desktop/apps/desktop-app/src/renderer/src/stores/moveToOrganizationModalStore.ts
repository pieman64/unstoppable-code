import { create } from 'zustand';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { isDefaultCoworkWorkspaceId } from '@canopy/protocol/ui-labels';
import type { OrgProjectMoveErrorCode } from '@canopy/desktop-shared/types';
import { isDesktopSharedSidebarEnabled } from '@/components/sidebar/desktop-shared-sidebar-flag';
import { useFeatureFlagsStore } from './featureFlagsStore';
import { useGitHubStore } from './githubStore';
import { useProjectsStore } from './projectsStore';
import { useWorkspaceContextStore } from './workspaceContextStore';

export interface MoveToOrganizationModalTarget {
  workspaceId: string;
}

export interface MoveToOrganizationModalError {
  code: OrgProjectMoveErrorCode;
  /** The organization the failed move was for. */
  organizationId: string;
}

interface MoveToOrganizationModalStore {
  target: MoveToOrganizationModalTarget | null;
  /** True while a move is in flight; the dialog cannot close meanwhile. */
  busy: boolean;
  error: MoveToOrganizationModalError | null;
}

export const useMoveToOrganizationModalStore =
  create<MoveToOrganizationModalStore>(() => ({
    target: null,
    busy: false,
    error: null,
  }));

/**
 * The one precondition for offering Move to organization on a project: the
 * organization projects flag is on, the viewer is in Personal with at least
 * one organization, and the project is a Personal project other than the
 * default Chats space. The dialog is mounted by the shared sidebar host, so
 * the legacy sidebar escape hatch offers no move. Main re-checks eligibility
 * per organization at move time; this only decides whether the menus offer the
 * action.
 */
export function canMoveToOrganization(workspaceId: string): boolean {
  if (
    !isDesktopSharedSidebarEnabled() ||
    !useFeatureFlagsStore
      .getState()
      .isEnabled(CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key)
  ) {
    return false;
  }
  const { context, organizations } = useWorkspaceContextStore.getState().state;
  if (context.kind !== 'personal' || organizations.length === 0) return false;
  if (isDefaultCoworkWorkspaceId(workspaceId)) return false;
  const project = useProjectsStore
    .getState()
    .projects.find((candidate) => candidate.id === workspaceId);
  return project !== undefined && project.owner === undefined;
}

/** Opens the dialog for a project; false when it cannot move or a move is running. */
export function openMoveToOrganizationModal(workspaceId: string): boolean {
  if (useMoveToOrganizationModalStore.getState().busy) return false;
  if (!canMoveToOrganization(workspaceId)) return false;
  useMoveToOrganizationModalStore.setState({
    target: { workspaceId },
    error: null,
  });
  return true;
}

export function closeMoveToOrganizationModal(): void {
  if (useMoveToOrganizationModalStore.getState().busy) return;
  useMoveToOrganizationModalStore.setState({ target: null, error: null });
}

/**
 * Moves the dialog's project to the picked organization. A refusal keeps the
 * dialog open with the error tied to that organization; success closes it and
 * confirms with a toast. The row leaves Personal through the existing
 * ownership-changed reload, and the context stays Personal.
 */
export async function moveToOrganization(
  organizationId: string,
): Promise<void> {
  const { target, busy } = useMoveToOrganizationModalStore.getState();
  if (busy || target === null) return;
  const { workspaceId } = target;
  const projectName =
    useProjectsStore
      .getState()
      .projects.find((candidate) => candidate.id === workspaceId)?.name ??
    workspaceId;
  useMoveToOrganizationModalStore.setState({ busy: true, error: null });
  let code: OrgProjectMoveErrorCode | null;
  try {
    const result = await window.api.orgProjects.moveWorkspace({
      workspaceId,
      organizationId,
    });
    code = result.ok ? null : result.code;
  } catch {
    code = 'move-failed';
  }
  if (code !== null) {
    useMoveToOrganizationModalStore.setState({
      busy: false,
      error: { code, organizationId },
    });
    return;
  }
  useMoveToOrganizationModalStore.setState({
    target: null,
    busy: false,
    error: null,
  });
  const organizationName =
    useWorkspaceContextStore
      .getState()
      .state.organizations.find(
        (organization) => organization.id === organizationId,
      )?.name ?? 'the organization';
  useGitHubStore
    .getState()
    .addToast(`Moved ${projectName} to ${organizationName}.`, 'success');
}
