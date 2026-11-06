import type { JSX } from 'react';
import { useShallow } from 'zustand/shallow';
import { LinkCloudProjectDialog } from '@canopy/ui-app';
import {
  closeLinkCloudProjectModal,
  linkCloudProject,
  useLinkCloudProjectModalStore,
} from '@/stores/linkCloudProjectModalStore';
import { useProjectsStore } from '@/stores/projectsStore';

/**
 * Desktop host for the shared Link to cloud project dialog (CAN-5190).
 * Mounted once by the sidebar host; the project menu opens it through the
 * store.
 */
export function DesktopLinkCloudProjectDialog(): JSX.Element | null {
  const { workspaceId, state, busy, error } = useLinkCloudProjectModalStore(
    useShallow((store) => ({
      workspaceId: store.workspaceId,
      state: store.state,
      busy: store.busy,
      error: store.error,
    })),
  );
  const project = useProjectsStore((store) =>
    workspaceId === null
      ? undefined
      : store.projects.find((candidate) => candidate.id === workspaceId),
  );
  const open = workspaceId !== null && project !== undefined;
  if (!open) return null;
  return (
    <LinkCloudProjectDialog
      key={workspaceId}
      projectName={project.name}
      state={state}
      busy={busy}
      error={error}
      onLink={(target): void => {
        void linkCloudProject(target);
      }}
      onCancel={closeLinkCloudProjectModal}
    />
  );
}
