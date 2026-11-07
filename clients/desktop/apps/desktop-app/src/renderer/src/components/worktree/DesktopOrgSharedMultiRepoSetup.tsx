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

/**
 * What an update of these sources must do: `legacy` updates in place, `shared`
 * needs a new shared project, `pending` is still being read, and `unavailable`
 * could not be read. Only `legacy` authorizes the mutating path.
 */
export type SharedMultiRepoRouting =
  | 'legacy'
  | 'shared'
  | 'pending'
  | 'unavailable';

/** Unknown organization visibility never authorizes the legacy mutating path. */
// eslint-disable-next-line react-refresh/only-export-components -- The hook and view share the same host boundary.
export function useSharedMultiRepoRouting(
  workspaceIds: readonly string[],
): SharedMultiRepoRouting {
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
  const [classified, setClassified] = useState<{
    readonly key: string;
    readonly routing: 'legacy' | 'shared' | 'unavailable';
  } | null>(null);
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
        if (!current) return;
        if (catalogs.some((catalog) => catalog.stale || catalog.error)) {
          setClassified({ key, routing: 'unavailable' });
          return;
        }
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
        setClassified({ key, routing: privateOnly ? 'legacy' : 'shared' });
      })
      .catch(() => {
        if (current) setClassified({ key, routing: 'unavailable' });
      });
    return (): void => {
      current = false;
      // Reset from the cleanup so returning to these owners reads them afresh.
      setClassified(null);
    };
    // The serialized owner identities own this read; unrelated worktree updates do not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, key]);
  if (sources.some((source) => source === undefined)) return 'unavailable';
  if (
    context.kind === 'organization' &&
    sources.some((source) => source && source.owner?.type !== 'organization')
  )
    return 'shared';
  if (owners.length === 0) return 'legacy';
  if (!client?.sharedMultiRepo) return 'unavailable';
  return classified?.key === key ? classified.routing : 'pending';
}
