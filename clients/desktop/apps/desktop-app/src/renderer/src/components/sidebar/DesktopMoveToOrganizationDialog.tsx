import { useEffect, useMemo, type JSX } from 'react';
import { useShallow } from 'zustand/shallow';
import { MoveProjectToOrganizationDialog } from '@canopy/ui-app';
import { useCanopyOrgProjectsEnabled } from '@/hooks/useCanopyOrgProjectsEnabled';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import {
  canMoveToOrganization,
  closeMoveToOrganizationModal,
  moveToOrganization,
  useMoveToOrganizationModalStore,
} from '@/stores/moveToOrganizationModalStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';

/**
 * Desktop host for the shared Move to organization dialog. Mounted once by the
 * sidebar host; the three menu entry points open it through the store. Its own
 * subscriptions keep the sidebar from re-rendering on dialog state.
 */
export function DesktopMoveToOrganizationDialog(): JSX.Element | null {
  const { target, busy, error } = useMoveToOrganizationModalStore(
    useShallow((state) => ({
      target: state.target,
      busy: state.busy,
      error: state.error,
    })),
  );
  const workspaceId = target?.workspaceId;
  const project = useProjectsStore((state) =>
    workspaceId === undefined
      ? undefined
      : state.projects.find((candidate) => candidate.id === workspaceId),
  );
  const workspaceContext = useWorkspaceContextStore((state) => state.state);
  const orgProjectsEnabled = useCanopyOrgProjectsEnabled();
  const organizations = useMemo(
    () => workspaceContext.organizations.map(({ id, name }) => ({ id, name })),
    [workspaceContext.organizations],
  );

  // The picker reads live state: when the project leaves Personal, the
  // context changes, or the last organization goes, an idle dialog closes.
  useEffect(() => {
    if (workspaceId === undefined || busy) return;
    if (!canMoveToOrganization(workspaceId)) closeMoveToOrganizationModal();
  }, [workspaceId, busy, project, workspaceContext, orgProjectsEnabled]);

  const open =
    target !== null && project !== undefined && organizations.length > 0;
  // Opened from a sidebar menu or App Advisor, with no navigable route: this
  // modal has no NavigationPage or navigation.go_to_page target.
  useCurrentUiStateReporter(
    'moveToOrganization.modal',
    open && workspaceId !== undefined
      ? {
          open: true,
          workspaceId,
          busy,
          ...(error === null ? {} : { errorCode: error.code }),
        }
      : null,
  );

  if (target === null || project === undefined || organizations.length === 0) {
    return null;
  }
  return (
    <MoveProjectToOrganizationDialog
      // A new target starts from a fresh pick.
      key={target.workspaceId}
      projectName={project.name}
      organizations={organizations}
      busy={busy}
      error={error}
      onMove={(organizationId): void => {
        void moveToOrganization(organizationId);
      }}
      onCancel={closeMoveToOrganizationModal}
    />
  );
}
