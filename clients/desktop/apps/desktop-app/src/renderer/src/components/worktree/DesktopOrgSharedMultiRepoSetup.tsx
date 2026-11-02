import { useEffect, useState, type JSX } from 'react';
import { useOptionalCanopyClient } from '@canopy/app-state';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';
import {
  OrgSharedMultiRepoSetup,
  type OrgSharedMultiRepoSetupProps,
} from '@canopy/ui-app/org-project-catalog';
import { useProjectsStore } from '@/stores/projectsStore';
import { switchContextForWorkspace } from '@/lib/contextScope';

/** Native projection/navigation stays in the desktop host. Never creates work. */
export function DesktopOrgSharedMultiRepoSetup({
  onOpenDestination,
  ...props
}: Omit<OrgSharedMultiRepoSetupProps, 'onReady'> & {
  readonly onOpenDestination?: (workspaceId: string) => void;
}): JSX.Element {
  return (
    <OrgSharedMultiRepoSetup
      {...props}
      onReady={async (status) => {
        await useProjectsStore.getState().loadProjects();
        const destination = useProjectsStore
          .getState()
          .projects.find(
            (project) =>
              project.owner?.type === 'organization' &&
              project.owner.projectId === status.projectId &&
              project.owner.organizationId === status.organizationId,
          );
        if (
          !destination ||
          !onOpenDestination ||
          !(await switchContextForWorkspace(destination.id))
        )
          throw new Error('Open the ready project from Projects.');
        onOpenDestination(destination.id);
      }}
    />
  );
}

/** Unknown organization visibility never authorizes the legacy mutating path. */
// eslint-disable-next-line react-refresh/only-export-components -- The hook and view share the same host boundary.
export function useSharedMultiRepoRequired(
  workspaceIds: readonly string[],
): boolean {
  const client = useOptionalCanopyClient();
  const projects = useProjectsStore((state) => state.projects);
  const context = useWorkspaceContextStore((state) => state.state.context);
  const sources = workspaceIds.map((id) =>
    projects.find((project) => project.id === id),
  );
  const owners = sources.flatMap((source) =>
    source?.owner?.type === 'organization' ? [source.owner] : [],
  );
  const key = JSON.stringify(
    owners.map((owner) => [owner.organizationId, owner.projectId]),
  );
  const [privateSelection, setPrivateSelection] = useState<string | null>(null);
  useEffect(() => {
    if (owners.length === 0 || !client?.sharedMultiRepo) return;
    let current = true;
    const port = client.sharedMultiRepo;
    void Promise.all(
      Array.from(
        new Set<string>(owners.map((owner) => owner.organizationId)),
      ).map((id) => port.catalog(id)),
    )
      .then((catalogs) => {
        if (
          !current ||
          catalogs.some((catalog) => catalog.stale || catalog.error)
        )
          return;
        const privateOnly = owners.every((owner) =>
          catalogs.some((catalog) =>
            catalog.projects.some(
              (project) =>
                project.id === owner.projectId &&
                project.organizationId === owner.organizationId &&
                project.state === 'ACTIVE' &&
                project.capabilities.use &&
                project.memberOwned &&
                project.visibility === 'private',
            ),
          ),
        );
        setPrivateSelection(privateOnly ? key : null);
      })
      .catch(() => {
        /* Retain the safe shared path when access cannot be checked. */
      });
    return (): void => {
      current = false;
    };
    // The serialized owner identities own this read; unrelated worktree updates do not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, key]);
  if (
    context.kind === 'organization' &&
    sources.some((source) => source && source.owner?.type !== 'organization')
  )
    return true;
  return owners.length > 0 && privateSelection !== key;
}
