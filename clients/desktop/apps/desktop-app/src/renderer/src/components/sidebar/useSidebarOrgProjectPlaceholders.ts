import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';
import { openOrgProjectDeepLink } from '@/lib/openOrgProjectDeepLink';
import { startOrgProjectSetupWithGitHubOffer } from '@/lib/orgProjectConnectOffer';
import type { OrgProjectRelationship } from '@canopy/desktop-shared/types';
import type { OrgProjectRelationshipActions } from '../worktree/OrgProjectRelationshipNotice';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import { useProjectsStore } from '@/stores/projectsStore';
import {
  createElement,
  useCallback,
  useEffect,
  useMemo,
  useState,
  useRef,
  type ReactNode,
} from 'react';
import { OrgProjectSetupDialog } from '../worktree/OrgProjectSetupDialog';
import { useShallow } from 'zustand/react/shallow';
import {
  selectPlaceholderRows,
  useOrgProjectsStoreApi,
  useOrgProjectsStore,
  type OrgProjectsStoreState,
} from '@canopy/app-state';
import {
  deriveOrgProjectPlaceholderState,
  isOrgProjectCatalogSetupSupported,
  type OrgProjectPlaceholderState,
  type OrgProjectSummary,
  type OrgProjectSetupProgress,
} from '@canopy/protocol/org-projects';
import { serializeWorkspaceContext } from '@canopy/protocol/workspace-context';
import type {
  OrgProjectCatalogError,
  SidebarItem,
  WorkspaceContext,
} from '@canopy/desktop-shared/types';

const EMPTY_PROJECTS: OrgProjectSummary[] = [];
const EMPTY_WORKSPACE_IDS: readonly string[] = [];

// Setup eligibility must match the materialization service, including listing.
function isProjectEligibleForSetup(
  project: OrgProjectSummary,
  organizationId: string | undefined,
): boolean {
  return (
    project.organizationId === organizationId &&
    project.listed &&
    project.state === 'ACTIVE' &&
    project.capabilities.use &&
    // A converted multi-repo project (CAN-3532) cannot be set up from the
    // catalog, so its consent never opens.
    isOrgProjectCatalogSetupSupported(project)
  );
}

/**
 * A sidebar row for an organization project that is not on this computer yet.
 *
 * Since CAN-3386 the sidebar lists only projects on this computer: a catalog
 * project the member has not set up is added from the Add project dialog, not
 * offered here. The one row left is a setup the member started — running,
 * failed, or bound but unfinished — so its progress, Cancel, Retry, or reason
 * stays visible until it resolves into the real workspace row.
 */
export interface SidebarOrgProjectPlaceholder {
  relationship?: OrgProjectRelationshipActions;
  project: OrgProjectSummary;
  state: OrgProjectPlaceholderState;
  progress?: OrgProjectSetupProgress;
  /**
   * The project already has a local workspace whose setup did not finish. The
   * row reports that and offers nothing: setup is refused for a project that is
   * already a workspace, so a Set up or Retry here could only fail. Finishing
   * one of these is CAN-3130.
   */
  unfinished?: boolean;
}

/** Desktop snapshots retain their error metadata through the neutral client store. */
function snapshotError(snapshot: unknown): OrgProjectCatalogError | null {
  if (
    typeof snapshot !== 'object' ||
    snapshot === null ||
    !('error' in snapshot)
  )
    return null;
  const error = snapshot.error;
  return error === 'unavailable' ||
    error === 'offline' ||
    error === 'access-changed'
    ? error
    : null;
}

/**
 * Shortest gap between two focus-driven relationship refreshes. A refresh
 * spawns `git remote get-url` per Personal workspace in main; window focus is
 * not a deliberate user action, so it must not be a per-event trigger. Only
 * repeat focuses are throttled — the first one after mount always refreshes,
 * because that is the one carrying whatever the user just did elsewhere.
 */
const RELATIONSHIP_FOCUS_REFRESH_MIN_MS = 5_000;

/**
 * Backoff after main answers `unknown` or the links IPC rejects. The current
 * links stay on screen meanwhile; once the schedule is spent, retrying waits
 * for the next focus or relationship-key change. Main records each unknown
 * answer in session-events as an `org_project_links_unknown` diagnostic.
 */
export const RELATIONSHIP_RETRY_DELAYS_MS: readonly number[] = [
  1_000, 2_000, 5_000, 15_000,
];

export function useSidebarOrgProjectPlaceholders(
  projects: SidebarItem[],
  context: WorkspaceContext | undefined,
): {
  setupDialog: ReactNode;
  placeholderRows: SidebarOrgProjectPlaceholder[];
  linkedPersonalWorkspaceIds: readonly string[];
  /** Catalog projects a Personal checkout links to: on this computer (CAN-3469). */
  linkedProjectIds: readonly string[];
  /**
   * The organization whose links are answered for this account, or `null`
   * while they are unknown (CAN-3469). Hidden links (a blocked catalog, no
   * membership) are an answer: nothing is linked.
   */
  linksResolvedOrganizationId: string | null;
  startPlaceholderSetup: (
    projectId: string,
    restoreFocusTarget?: HTMLElement | null,
  ) => Promise<void>;
  cancelPlaceholderSetup: (projectId: string) => Promise<void>;
} {
  const orgStore = useOrgProjectsStoreApi();
  const [relationshipState, setRelationshipState] = useState<{
    organizationId: string | undefined;
    accountEpoch: number;
    links: OrgProjectRelationship[];
  } | null>(null);
  const [setupProjectId, setSetupProjectId] = useState<string | null>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const closeSetup = useCallback((): void => setSetupProjectId(null), []);
  // Select only what the sidebar needs: whole-store subscriptions would
  // re-render every row on unrelated catalog traffic (setup progress, other
  // contexts).
  const load = useOrgProjectsStore((store) => store.load);
  // Setup can bind a workspace before failing. Reload for every terminal
  // state so unfinished reflects disk bindings, not just successful setups.
  // Progress drives the row's spinner and percentage, so it must be observed —
  // but shallowly, and it is empty unless a setup is actually running. `git`
  // only reports a percentage when it changes, so a clone is bounded at ~100
  // updates.
  const setupProgress = useOrgProjectsStore(
    useShallow((store) => store.setupProgress),
  );
  const startSetup = useOrgProjectsStore((store) => store.startSetup);
  const setupRequest = useOrgProjectsStore(
    (store): OrgProjectsStoreState['setupRequest'] => store.setupRequest,
  );
  const clearSetupRequest = useOrgProjectsStore(
    (store): OrgProjectsStoreState['clearSetupRequest'] =>
      store.clearSetupRequest,
  );
  const cancelSetup = useOrgProjectsStore((store) => store.cancelSetup);
  const terminalRevision = useOrgProjectsStore((store) =>
    Object.values(store.setupProgress)
      .filter(
        (progress) =>
          progress.state === 'ready' ||
          progress.state === 'failed' ||
          progress.state === 'cancelled',
      )
      .map((progress) => `${progress.projectId}:${progress.updatedAt}`)
      .join(','),
  );
  useEffect((): void => {
    if (terminalRevision)
      void useProjectsStore
        .getState()
        .loadProjects({ silent: true })
        .catch((): void => {});
  }, [terminalRevision]);
  const organizationId =
    context?.kind === 'organization' ? context.organizationId : undefined;
  const relationshipMember = useWorkspaceContextStore((store): boolean =>
    store.state.organizations.some(
      (organization): boolean => organization.id === organizationId,
    ),
  );
  const contextKey =
    context?.kind === 'organization'
      ? serializeWorkspaceContext(context)
      : undefined;
  const snapshot = useOrgProjectsStore((store) =>
    contextKey === undefined ? undefined : store.snapshots[contextKey],
  );
  const catalogError = snapshotError(snapshot);
  const catalogBlocked =
    catalogError === 'access-changed' || catalogError === 'unavailable';
  // Resolve consent from the live catalog; invalidated selections close.
  const setupProject = snapshot?.projects.find(
    (project) =>
      project.id === setupProjectId &&
      isProjectEligibleForSetup(project, organizationId),
  );
  useEffect((): void => {
    if (setupProjectId === null) return;
    const setupState = setupProgress[setupProjectId]?.state;
    if (
      setupProject === undefined ||
      setupState === 'claiming' ||
      setupState === 'materializing'
    )
      setSetupProjectId(null);
  }, [setupProjectId, setupProject, setupProgress]);
  const listedPlaceholders = useOrgProjectsStore(
    useShallow((store) =>
      context?.kind === 'organization'
        ? selectPlaceholderRows(store, context)
        : EMPTY_PROJECTS,
    ),
  );
  // `accountEpoch` is a dependency, not decoration: an account change clears
  // the store's snapshots, and a new account can land on the same organization
  // id, so without it this effect never re-runs and the rows stay gone.
  const accountEpoch = useOrgProjectsStore((store) => store.accountEpoch);
  useEffect((): void => {
    setSetupProjectId(null);
  }, [organizationId, accountEpoch]);
  useEffect((): void => {
    if (organizationId !== undefined)
      void load({ kind: 'organization', organizationId });
  }, [organizationId, accountEpoch, load]);
  // Matching spawns `git remote get-url` per Personal workspace in main, so the
  // effect must key on what can change a match, not on object identity: the
  // catalog poll replaces the snapshot every 30s with an identical project set
  // and a new `fetchedAt`, and every workspace load replaces `projects`.
  const relationshipKey = useMemo(
    (): string =>
      [
        // Every input the match reads, not just the ids: a rename, a
        // verification flip, an archive or a revoked capability all change the
        // answer while the ids stay exactly the same.
        (snapshot?.projects ?? [])
          .map((project): string =>
            [
              project.id,
              project.state,
              project.listed ? 'listed' : 'unlisted',
              project.instance === null
                ? 'no-instance'
                : `${project.instance.id}/${project.instance.state}`,
              project.capabilities.use ? 'use' : 'no-use',
              project.repository === null
                ? 'no-repository'
                : [
                    project.repository.provider,
                    project.repository.host,
                    project.repository.owner,
                    project.repository.name,
                    project.repository.providerRepoId ?? '',
                    project.repository.verification,
                  ].join('/'),
            ].join('~'),
          )
          .sort()
          .join(','),
        projects
          .flatMap((item): string[] =>
            item.type === 'single-repo' && item.owner?.type === undefined
              ? [`${item.id}~${item.repoPath}`]
              : [],
          )
          .sort()
          .join(','),
      ].join('|'),
    [snapshot, projects],
  );
  // Links belong to one organization and account: a switch starts over.
  useEffect((): void => {
    setRelationshipState(null);
  }, [organizationId, accountEpoch]);
  useEffect(() => {
    let active = true;
    if (
      catalogBlocked ||
      !relationshipMember ||
      typeof organizationId !== 'string' ||
      !window.api?.orgProjects?.linksList
    ) {
      // Links are legitimately hidden here, not merely unanswered.
      setRelationshipState(null);
      return;
    }
    // A same-organization refresh keeps the last resolved links on screen
    // until a newer resolved answer replaces them. An unknown answer or a
    // rejection must not read as "not linked": that turned linked Personal
    // workspaces back into Set up rows until the next context switch.
    let refreshGeneration = 0;
    let retryAttempt = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const cancelRetry = (): void => {
      if (retryTimer === undefined) return;
      clearTimeout(retryTimer);
      retryTimer = undefined;
    };
    const scheduleRetry = (): void => {
      if (!active || retryTimer !== undefined) return;
      const delay = RELATIONSHIP_RETRY_DELAYS_MS[retryAttempt];
      if (delay === undefined) return;
      retryAttempt += 1;
      retryTimer = setTimeout((): void => {
        retryTimer = undefined;
        refresh();
      }, delay);
    };
    const refresh = (): void => {
      cancelRetry();
      const generation = ++refreshGeneration;
      const current = (): boolean => active && generation === refreshGeneration;
      void window.api.orgProjects
        .linksList()
        .then((result): void => {
          if (!current()) return;
          if (result.status === 'resolved') {
            retryAttempt = 0;
            setRelationshipState({
              organizationId,
              accountEpoch,
              links: result.links,
            });
            return;
          }
          scheduleRetry();
        })
        .catch((): void => {
          if (current()) scheduleRetry();
        });
    };
    refresh();
    // Focus refresh mitigates a remote changed outside the app until main
    // invalidates the match itself (CAN-3281). Throttled because the match
    // spawns `git remote get-url` per Personal workspace in main, and a window
    // focus is cheap to produce: alt-tabbing would otherwise fan that git work
    // out once per switch.
    let lastFocusRefreshAt = 0;
    const onFocus = (): void => {
      const now = Date.now();
      if (now - lastFocusRefreshAt < RELATIONSHIP_FOCUS_REFRESH_MIN_MS) return;
      lastFocusRefreshAt = now;
      // A focus is a fresh reason to ask, so a spent backoff starts over.
      retryAttempt = 0;
      refresh();
    };
    window.addEventListener('focus', onFocus);
    return (): void => {
      active = false;
      cancelRetry();
      window.removeEventListener('focus', onFocus);
    };
  }, [
    relationshipMember,
    organizationId,
    accountEpoch,
    relationshipKey,
    catalogBlocked,
  ]);
  // Never carry matches across organizations/accounts, or retain a removed checkout.
  const relationships = useMemo((): OrgProjectRelationship[] => {
    if (
      catalogBlocked ||
      !relationshipMember ||
      !relationshipState ||
      relationshipState.organizationId !== organizationId ||
      relationshipState.accountEpoch !== accountEpoch
    )
      return [];
    const catalogIds = new Set(
      (snapshot?.projects ?? [])
        .filter((project) => project.organizationId === organizationId)
        .map((project) => project.id),
    );
    const personalIds = new Set(
      projects
        .filter((project) => project.owner === undefined)
        .map((project) => project.id),
    );
    return relationshipState.links.filter(
      (link) =>
        catalogIds.has(link.projectId) &&
        personalIds.has(link.personalWorkspaceId),
    );
  }, [
    catalogBlocked,
    relationshipMember,
    relationshipState,
    organizationId,
    accountEpoch,
    snapshot,
    projects,
  ]);
  // One checkout stands for a repository: several Personal clones of it used
  // to list the project once each (CAN-3388). Walk checkouts in their stored
  // project order, not the display sort, and admit one only while it still
  // brings a project nothing else shows. A "last updated" sort or pinning
  // would move the representative whenever activity reorders the sidebar;
  // stored order keeps it stable across refreshes. The rest stay Personal.
  // Keyed by content: every workspace load replaces `projects`, and the list
  // feeds the sidebar's scoping memos.
  const linkedPersonalWorkspaceKey = useMemo((): string => {
    const listedIds = new Set(listedPlaceholders.map((project) => project.id));
    const projectsByCheckout = new Map<string, string[]>();
    for (const link of relationships) {
      if (!listedIds.has(link.projectId)) continue;
      const linked = projectsByCheckout.get(link.personalWorkspaceId) ?? [];
      linked.push(link.projectId);
      projectsByCheckout.set(link.personalWorkspaceId, linked);
    }
    const shown = new Set<string>();
    const admitted: string[] = [];
    for (const item of projects) {
      const linked = projectsByCheckout.get(item.id);
      if (linked === undefined) continue;
      if (linked.every((projectId): boolean => shown.has(projectId))) continue;
      for (const projectId of linked) shown.add(projectId);
      admitted.push(item.id);
    }
    return admitted.join('\n');
  }, [relationships, listedPlaceholders, projects]);
  const linkedPersonalWorkspaceIds = useMemo(
    (): readonly string[] =>
      linkedPersonalWorkspaceKey === ''
        ? EMPTY_WORKSPACE_IDS
        : linkedPersonalWorkspaceKey.split('\n'),
    [linkedPersonalWorkspaceKey],
  );
  // Every linked project is on this computer, including one whose checkout was
  // skipped above because another checkout already stands for it, and one not
  // listed (the links are already limited to this organization's catalog)
  // (CAN-3469). Keyed by content for the same reason.
  const linkedProjectKey = useMemo(
    (): string =>
      Array.from(new Set(relationships.map((link): string => link.projectId)))
        .sort()
        .join('\n'),
    [relationships],
  );
  const linksResolvedOrganizationId =
    organizationId === undefined
      ? null
      : catalogBlocked ||
          !relationshipMember ||
          !window.api?.orgProjects?.linksList ||
          (relationshipState !== null &&
            relationshipState.organizationId === organizationId &&
            relationshipState.accountEpoch === accountEpoch)
        ? organizationId
        : null;
  const linkedProjectIds = useMemo(
    (): readonly string[] =>
      linkedProjectKey === ''
        ? EMPTY_WORKSPACE_IDS
        : linkedProjectKey.split('\n'),
    [linkedProjectKey],
  );
  const relationshipActions = useCallback(
    (projectId: string): OrgProjectRelationshipActions | undefined => {
      const relationship = relationships.find(
        (link): boolean => link.projectId === projectId,
      );
      if (relationship === undefined) return undefined;
      return {
        dismiss: async (): Promise<void> => {
          await window.api.orgProjects.linksDecide({
            ...relationship,
            decision: 'dismiss',
          });
          if (orgStore.getState().accountEpoch === accountEpoch)
            setRelationshipState((previous) =>
              previous === null
                ? null
                : {
                    ...previous,
                    links: previous.links.filter(
                      (link): boolean =>
                        (link.projectId === projectId &&
                          link.personalWorkspaceId ===
                            relationship.personalWorkspaceId) === false,
                    ),
                  },
            );
        },
        view: async (): Promise<void> => {
          const event = await window.api.orgProjects.linksDecide({
            ...relationship,
            decision: 'view',
          });
          if (event && orgStore.getState().accountEpoch === accountEpoch) {
            setSetupProjectId(null);
            await openOrgProjectDeepLink(event, orgStore);
          }
        },
      };
    },
    [relationships, accountEpoch, orgStore],
  );
  const placeholderRows = useMemo((): SidebarOrgProjectPlaceholder[] => {
    if (context?.kind !== 'organization') return [];
    const error = snapshotError(snapshot);
    if (error === 'unavailable') return [];
    const bound = new Set(
      projects.flatMap((item) =>
        item.owner?.type === 'organization' ? [item.owner.projectId] : [],
      ),
    );
    // Only setups the member started earn a row (CAN-3386): an idle catalog
    // project, listed or not, is added from the Add project dialog instead.
    // Dismissal withdraws an offer, but must not hide a setup still needing
    // attention.
    return (snapshot?.projects ?? [])
      .filter((project) => {
        if (
          project.organizationId !== context.organizationId ||
          project.state !== 'ACTIVE' ||
          project.instance?.state === 'READY'
        )
          return false;
        const progress = setupProgress[project.id];
        const actionableSetup =
          progress?.state === 'claiming' ||
          progress?.state === 'materializing' ||
          progress?.state === 'failed';
        // Binding happens before server confirmation. Keep unfinished setup
        // visible even when a separate Personal checkout matches the project.
        const unfinished = bound.has(project.id) && project.instance !== null;
        return actionableSetup || unfinished;
      })
      .map((project) => ({
        project,
        relationship: relationshipActions(project.id),
        progress: setupProgress[project.id],
        state: deriveOrgProjectPlaceholderState({
          snapshotError: error,
          project,
        }),
        ...(bound.has(project.id) ? { unfinished: true } : {}),
      }));
  }, [snapshot, context, projects, setupProgress, relationshipActions]);
  // App Advisor sees the same rows the member does: ids, names, placeholder
  // state and a percentage, never paths or repository contents (CAN-2956).
  const reportedRows = useMemo(
    () =>
      context?.kind === 'organization'
        ? {
            rows: placeholderRows.map(
              ({ project, state, progress, unfinished }) => ({
                projectId: project.id,
                name: project.name,
                state,
                // The Advisor sees the same distinction the row shows: a bound
                // project whose setup never finished is not ready to set up, and
                // its actions are deliberately unavailable.
                ...(unfinished === true ? { unfinished: true } : {}),
                ...(progress === undefined
                  ? {}
                  : {
                      setupState: progress.state,
                      ...(progress.percent === null ||
                      progress.percent === undefined
                        ? {}
                        : { setupPercent: progress.percent }),
                    }),
              }),
            ),
          }
        : null,
    [context?.kind, placeholderRows],
  );
  useCurrentUiStateReporter('sidebar.orgProjects', reportedRows);
  const startPlaceholderSetup = useCallback(
    (
      projectId: string,
      restoreFocusTarget?: HTMLElement | null,
    ): Promise<void> => {
      // Catalog consent remains available even when a Personal match hides the row.
      const project = snapshot?.projects.find(
        (item): boolean =>
          item.id === projectId &&
          isProjectEligibleForSetup(item, organizationId),
      );
      const bound = projects.some(
        (item) =>
          item.owner?.type === 'organization' &&
          item.owner.projectId === projectId,
      );
      if (project && !bound) {
        // Consent closes on Start, before setup can invalidate the catalog row.
        // Setup opened from the Add project dialog has no row to return to
        // yet, so focus goes back to the + that opened that dialog.
        restoreFocusRef.current =
          restoreFocusTarget ??
          document.querySelector<HTMLButtonElement>(
            '[data-testid="sidebar-section-code-add"]',
          ) ??
          document.querySelector<HTMLButtonElement>(
            '[data-testid="sidebar-context-row"]',
          ) ??
          document.querySelector<HTMLButtonElement>(
            '[data-testid="sidebar-account-row"]',
          );
        setSetupProjectId(projectId);
        return Promise.resolve();
      }
      // A bound project's only action is the Retry of a lapsed claim
      // (CAN-3129). Nothing is cloned, so there is no consent or destination
      // to ask for: main reclaims the claim and finishes the setup.
      if (project && bound) return startSetup(projectId);
      return Promise.resolve();
    },
    [snapshot, organizationId, projects, startSetup],
  );
  useEffect((): void => {
    if (setupRequest === null) return;
    if (setupRequest.organizationId === organizationId) {
      // The Add dialog closes as it hands over, taking its own Set up button
      // with it, so focus has to be restored to the sidebar row instead of the
      // opener the modal captured.
      const row = document.querySelector(
        `[data-testid="sidebar-org-project-placeholder-${setupRequest.projectId}"]`,
      );
      void startPlaceholderSetup(
        setupRequest.projectId,
        row instanceof HTMLElement ? row : null,
      );
    }
    clearSetupRequest();
  }, [setupRequest, organizationId, startPlaceholderSetup, clearSetupRequest]);
  return {
    setupDialog:
      setupProject &&
      context?.kind === 'organization' &&
      context.organizationId === setupProject.organizationId
        ? createElement(OrgProjectSetupDialog, {
            key: setupProject.id,
            project: setupProject,
            relationship: relationshipActions(setupProject.id),
            state: deriveOrgProjectPlaceholderState({
              snapshotError: snapshotError(snapshot),
              project: setupProject,
            }),
            restoreFocusRef,
            unfinished: projects.some(
              (item) =>
                item.owner?.type === 'organization' &&
                item.owner.projectId === setupProject.id,
            ),
            onStart: (projectId, destinationRoot): Promise<void> => {
              // Start removes the trigger. Claim focus for the stable row before
              // closing; DialogModal preserves focus placed outside the dialog.
              restoreFocusRef.current?.focus();
              return startOrgProjectSetupWithGitHubOffer(
                orgStore,
                projectId,
                destinationRoot,
              );
            },
            // A project with no GitHub repository clones nothing (CAN-3534):
            // the member's own folder is bound in place. Desktop-only, so it
            // goes to main directly instead of through the shared store's
            // setup command, with the same account guard that command applies.
            onStartFromFolder: async (projectId, path): Promise<void> => {
              restoreFocusRef.current?.focus();
              const epoch = orgStore.getState().accountEpoch;
              const progress = await window.api.orgProjects.setupFromFolder({
                projectId,
                path,
              });
              if (orgStore.getState().accountEpoch === epoch)
                orgStore.getState().applySetupProgress(progress);
            },
            onClose: closeSetup,
          })
        : null,
    placeholderRows,
    linkedPersonalWorkspaceIds,
    linkedProjectIds,
    linksResolvedOrganizationId,
    startPlaceholderSetup,
    cancelPlaceholderSetup: cancelSetup,
  };
}
