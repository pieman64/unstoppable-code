'use client';

// ---------------------------------------------------------------------------
// The organization catalog in the Add project dialog (CAN-3386, CAN-3469,
// CAN-3489), rendered by both the desktop Add project dialog and the web
// portal's (CAN-3537). One list with no groups, GitHub-style rows (name,
// description, visibility, last update), search by name, and a sticky search
// header with a fade.
//
// The list owns what a row shows and when Add is offered. The host owns what
// Add does, which projects it already has, setup progress, and its own slots
// (desktop's clone folder): desktop sets the project up on this computer, the
// portal hands it to the paired desktop. A host that can also run a
// single-repository Code project in the cloud passes `cloud` (REG-3091), and
// its rows offer Add to Cloud, or Open once that copy exists. Beside it Add
// reads Add to desktop; a host with nowhere to set a project up right now
// passes `addOffered={false}`, leaving Add to Cloud the row's one action.
// ---------------------------------------------------------------------------

import { useState, type JSX, type ReactNode } from 'react';
import {
  Button,
  EmptyState,
  LoadingPlaceholder,
  Notice,
} from '@canopy/ui-shared';
import {
  deriveOrgProjectPlaceholderState,
  isOrgProjectCatalogSetupSupported,
  ORG_PROJECT_STATE_TEXT,
  type OrgProjectPlaceholderState,
  type OrgProjectSummary,
} from '@canopy/protocol/org-projects';
import { OrgProjectRow } from './OrgProjectRow';

/** GitHub's last update as a sortable time; unknown sorts last. */
function updatedTime(project: OrgProjectSummary): number {
  const time = Date.parse(project.repository?.updatedAt ?? '');
  return Number.isFinite(time) ? time : Number.NEGATIVE_INFINITY;
}

/**
 * Most recently updated first, as GitHub lists repositories. Ties, including
 * rows GitHub has not dated yet (last), keep the catalog's order.
 */
function byLastUpdate(a: OrgProjectSummary, b: OrgProjectSummary): number {
  const later = updatedTime(b);
  const earlier = updatedTime(a);
  if (later === earlier) return 0;
  return later > earlier ? 1 : -1;
}

/**
 * A project the host already has: a workspace is bound to it or a Personal
 * checkout of its repository is linked to it (the host's ids, CAN-3469). A
 * READY instance is also sufficient for Code, but Cowork must be present in
 * the host's own index: its server instance can become READY before the
 * staged workspace is published.
 */
export function isOrgProjectAdded(
  project: OrgProjectSummary,
  addedProjectIds: ReadonlySet<string>,
): boolean {
  return (
    addedProjectIds.has(project.id) ||
    (project.kind === 'CODE' && project.instance?.state === 'READY')
  );
}

/**
 * Case-insensitive match on the project name and the repository name, never
 * the owner (CAN-3469): every project of one organization usually shares the
 * owner, so matching it made a short query match them all.
 */
function matchesSearch(project: OrgProjectSummary, query: string): boolean {
  if (query === '') return true;
  return [project.name, project.repository?.name ?? ''].some((value): boolean =>
    value.toLowerCase().includes(query),
  );
}

/**
 * Whether a project's own state lets Add run, before the host says whether it
 * can add at all. The row's button and a host that runs Add for the member
 * (the portal's organization owner nudge) share this one rule.
 */
export function isOrgProjectAddAllowed(
  project: OrgProjectSummary,
  stale: boolean,
): boolean {
  if (stale) return false;
  const state = deriveOrgProjectPlaceholderState({
    project,
    snapshotError: null,
  });
  return (
    state === 'ready-to-set-up' ||
    state === 'choose-folder' ||
    state === 'needs-github-access'
  );
}

/** The catalog projects a member can add in this organization. */
export function selectOrgProjectCatalogProjects(
  projects: readonly OrgProjectSummary[],
  organizationId: string,
  addedProjectIds: ReadonlySet<string>,
): OrgProjectSummary[] {
  return projects.filter(
    (project): boolean =>
      project.organizationId === organizationId &&
      project.capabilities.use &&
      project.state === 'ACTIVE' &&
      // The organization's default Chats is provisioned automatically, never
      // added from here.
      project.purpose !== 'default-chats' &&
      // A converted multi-repo project (CAN-3532) cannot be set up from the
      // catalog: it is listed only where the host already has it.
      (isOrgProjectCatalogSetupSupported(project) ||
        isOrgProjectAdded(project, addedProjectIds)),
  );
}

/**
 * What the host knows of the organization's GitHub connection (CAN-3984).
 * `unavailable` is a check that did not succeed, or a host that cannot ask:
 * it is not a confirmed connection, but Choose projects handles setup too.
 */
export type OrgProjectCatalogGithubConnection =
  | 'checking'
  | 'connected'
  | 'not-connected'
  | 'unavailable';

/** A single-repository Code project with a repository can run in the cloud. */
export function isOrgProjectCloudAddSupported(
  project: OrgProjectSummary,
): boolean {
  return (
    project.kind === 'CODE' &&
    project.topology !== 'multi-repo' &&
    project.repository !== null &&
    isOrgProjectCatalogSetupSupported(project)
  );
}

/** A host's cloud copies of catalog projects (REG-3091). */
export interface OrgProjectCatalogCloud {
  /** False while the host cannot take an Add to Cloud (one in flight). */
  readonly available: boolean;
  /** Ids of the projects the host already has a cloud copy of. */
  readonly copies: ReadonlySet<string>;
  readonly onAdd: (project: OrgProjectSummary) => void;
  readonly onOpen: (project: OrgProjectSummary) => void;
}

/** Setup actions an owner or admin gets on an empty catalog (CAN-3984). */
export interface OrgProjectCatalogManagement {
  readonly connection: OrgProjectCatalogGithubConnection;
  readonly onConnectGithub: () => void;
  readonly onChooseProjects: () => void;
}

export interface OrgProjectCatalogListProps {
  readonly organizationId: string;
  /** Display name for the empty state; `undefined` reads "your organization". */
  readonly organizationName: string | undefined;
  /** The host's catalog, or `undefined` until its first read lands. */
  readonly projects: readonly OrgProjectSummary[] | undefined;
  /** The list is the cached one: rows stay visible, Add is unavailable. */
  readonly stale: boolean;
  /** The member's access to the catalog changed; no rows are shown. */
  readonly unauthorized: boolean;
  /** The open's GitHub re-read failed or ran long (CAN-3489). */
  readonly githubRefreshFailed?: boolean;
  /** The host's failure for the last Add, or '' when there is none. */
  readonly error?: string;
  /** Projects the host already has; their rows show a disabled Added. */
  readonly addedProjectIds: ReadonlySet<string>;
  /** Host readiness, optionally per project when setup capabilities differ. */
  readonly addAvailable: boolean | ((project: OrgProjectSummary) => boolean);
  /**
   * False hides Add and Added: the host has nowhere to set a project up
   * right now (the portal with no paired desktop but with `cloud`). Rows the
   * cloud cannot take then say Desktop only. Defaults to true.
   */
  readonly addOffered?: boolean;
  /** A setup the host is running for this project, shown in place of Add. */
  readonly setupMessage?: (projectId: string) => string | null;
  /** Host slot on the sticky header under the search (desktop: clone folder). */
  readonly destination?: ReactNode;
  /**
   * Present only for someone who can manage the organization's projects:
   * the empty catalog then offers setup instead of waiting on admins.
   */
  readonly management?: OrgProjectCatalogManagement;
  /** Present only where the host can add projects to the cloud. */
  readonly cloud?: OrgProjectCatalogCloud;
  readonly onAdd: (
    project: OrgProjectSummary,
    state: OrgProjectPlaceholderState,
  ) => void;
}

export function OrgProjectCatalogList({
  organizationId,
  organizationName,
  projects: catalog,
  stale,
  unauthorized,
  githubRefreshFailed = false,
  error = '',
  addedProjectIds,
  addAvailable,
  addOffered = true,
  setupMessage,
  destination,
  management,
  cloud,
  onAdd,
}: OrgProjectCatalogListProps): JSX.Element {
  const [search, setSearch] = useState('');
  const projects = selectOrgProjectCatalogProjects(
    catalog ?? [],
    organizationId,
    addedProjectIds,
  );
  const query = search.trim().toLowerCase();
  const shownProjects = projects
    .filter((project): boolean => matchesSearch(project, query))
    .sort(byLastUpdate);
  // One list with no groups (CAN-3469): whether a project is listed no longer
  // shows anywhere now that the sidebar lists only projects the host has.
  // Projects to add come first; those already added sink to the end. Each
  // part keeps the newest-first order (CAN-3489).
  const rows = [
    ...shownProjects.filter(
      (project): boolean =>
        isOrgProjectAdded(project, addedProjectIds) === false,
    ),
    ...shownProjects.filter((project): boolean =>
      isOrgProjectAdded(project, addedProjectIds),
    ),
  ];
  const organizationLabel = organizationName ?? 'your organization';
  // Beside Add to Cloud, Add names where it sets the project up.
  const addLabel = cloud === undefined ? 'Add' : 'Add to desktop';
  const addedLabel = cloud === undefined ? 'Added' : 'On desktop';
  return (
    <div data-testid="add-workspace-org-catalog" className="space-y-4">
      {error && <Notice>{error}</Notice>}
      {unauthorized ? (
        <EmptyState
          title="Access changed"
          subtitle="Refresh your projects to check your access."
        />
      ) : (
        <>
          {stale && (
            <EmptyState
              title="Offline"
              subtitle="Cached projects are shown. Reconnect to update your list."
            />
          )}
          {githubRefreshFailed && stale === false && (
            <div
              data-testid="add-workspace-org-catalog-github-refresh-failed"
              className="text-xs fg-tertiary"
            >
              Couldn't refresh from GitHub. New repositories may be missing.
            </div>
          )}
          {projects.length > 0 && (
            // Stays pinned while the list scrolls; it covers the scroll
            // container's top padding so rows never show above it, and a
            // short fade below it lets rows slide under it softly.
            <div className="sticky top-0 z-10 -mx-5 -mt-3 space-y-2 bg-card px-5 pt-3 pb-2 after:pointer-events-none after:absolute after:inset-x-0 after:top-full after:h-4 after:bg-linear-to-b after:from-card after:to-transparent">
              <input
                type="search"
                value={search}
                onChange={(event): void => setSearch(event.target.value)}
                aria-label="Search projects"
                placeholder="Search projects"
                data-testid="add-workspace-org-catalog-search"
                className="focus-ring w-full min-w-0 rounded-lg bg-base px-3 py-2 text-s inset-ring-1 inset-ring-line-base"
              />
              {destination}
            </div>
          )}
          {catalog === undefined && stale === false ? (
            <LoadingPlaceholder label="Loading projects" />
          ) : projects.length === 0 && stale === false ? (
            management === undefined || error !== '' ? (
              <EmptyState
                title={`Nothing in ${organizationLabel} yet`}
                subtitle={`Projects your admins add for ${organizationLabel} will show up here.`}
              />
            ) : (
              <OrgProjectCatalogSetup
                management={management}
                organizationLabel={organizationLabel}
              />
            )
          ) : projects.length > 0 && shownProjects.length === 0 ? (
            <div data-testid="add-workspace-org-catalog-no-match">
              <EmptyState
                title="No matching projects"
                subtitle="Change the search to see more."
              />
            </div>
          ) : (
            <section aria-label="Projects" className="space-y-2">
              {rows.map((project): JSX.Element => {
                const state = deriveOrgProjectPlaceholderState({
                  project,
                  snapshotError: stale ? 'offline' : null,
                });
                const added = isOrgProjectAdded(project, addedProjectIds);
                const setup = setupMessage?.(project.id) ?? null;
                const settingUp = setup !== null;
                const canAdd =
                  (typeof addAvailable === 'function'
                    ? addAvailable(project)
                    : addAvailable) && isOrgProjectAddAllowed(project, stale);
                const cloudAction =
                  cloud !== undefined && isOrgProjectCloudAddSupported(project);
                const status = added
                  ? null
                  : settingUp
                    ? setup
                    : state !== 'ready-to-set-up'
                      ? ORG_PROJECT_STATE_TEXT[state]
                      : null;
                return (
                  <OrgProjectRow
                    key={project.id}
                    project={project}
                    testIdPrefix="add-workspace-org-catalog"
                    // Only states that change what Add does show a status; a
                    // project the host has shows a disabled Added button.
                    status={status}
                    actions={
                      // Never an accent action: a list of equally prominent
                      // primaries reads as noise (CAN-3909). Added steps back.
                      <>
                        {cloud !== undefined &&
                          cloudAction &&
                          (cloud.copies.has(project.id) ? (
                            <Button
                              size="sm"
                              variant="secondary"
                              data-testid={`add-workspace-org-catalog-open-cloud-${project.id}`}
                              onClick={(): void => cloud.onOpen(project)}
                            >
                              Open
                            </Button>
                          ) : (
                            <Button
                              size="sm"
                              variant="secondary"
                              disabled={cloud.available === false || stale}
                              data-testid={`add-workspace-org-catalog-add-cloud-${project.id}`}
                              onClick={(): void => cloud.onAdd(project)}
                            >
                              Add to Cloud
                            </Button>
                          ))}
                        {addOffered &&
                          added === false &&
                          settingUp === false && (
                            <Button
                              size="sm"
                              variant="secondary"
                              disabled={canAdd === false}
                              data-testid={`add-workspace-org-catalog-add-${project.id}`}
                              onClick={(): void => onAdd(project, state)}
                            >
                              {addLabel}
                            </Button>
                          )}
                        {addOffered && added && (
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled
                            data-testid={`add-workspace-org-catalog-added-${project.id}`}
                          >
                            {addedLabel}
                          </Button>
                        )}
                        {addOffered === false && cloudAction === false && (
                          <span
                            data-testid={`add-workspace-org-catalog-desktop-only-${project.id}`}
                            className="text-xs fg-secondary"
                          >
                            Desktop only
                          </span>
                        )}
                      </>
                    }
                  />
                );
              })}
            </section>
          )}
        </>
      )}
    </div>
  );
}

/** An owner's or admin's empty catalog: set the organization's projects up. */
function OrgProjectCatalogSetup({
  management,
  organizationLabel,
}: {
  readonly management: OrgProjectCatalogManagement;
  readonly organizationLabel: string;
}): JSX.Element {
  if (management.connection === 'checking')
    return (
      <div data-testid="add-workspace-org-catalog-setup-checking">
        <LoadingPlaceholder label="Checking GitHub connection" />
      </div>
    );
  if (management.connection === 'not-connected')
    return (
      <EmptyState
        testId="add-workspace-org-catalog-setup"
        title="Connect GitHub to add projects"
        subtitle={`Connect ${organizationLabel} to GitHub, then pick the repos your team can add here.`}
        action={
          <Button
            size="sm"
            variant="primary"
            data-testid="add-workspace-org-catalog-connect-github"
            onClick={management.onConnectGithub}
          >
            Connect GitHub
          </Button>
        }
      />
    );
  return (
    <EmptyState
      testId="add-workspace-org-catalog-setup"
      title={`No projects in ${organizationLabel} yet`}
      subtitle="Choose which repos your team can add as projects."
      action={
        <Button
          size="sm"
          variant="primary"
          data-testid="add-workspace-org-catalog-choose-projects"
          onClick={management.onChooseProjects}
        >
          Choose projects
        </Button>
      }
    />
  );
}

/** The catalog option's wording in the Add project dialog. */
export interface OrgProjectCatalogOption {
  readonly label: string;
  readonly summary: string;
  /** The description where the dialog title already names the organization. */
  readonly scopedSummary: string;
}

/**
 * The organization catalog as an option in the Add project dialog (CAN-3453).
 * Each host renders it as the first tile of its own option row (desktop's
 * Existing folder / Create new tiles, the portal's destination tiles) under
 * the building icon, so the wording lives here and the two stay the same.
 */
export function orgProjectCatalogOption(
  organizationName: string,
): OrgProjectCatalogOption {
  return {
    // The title stays short so it never wraps; the description names the
    // organization, which is where the eye lands next.
    label: 'From my org',
    summary: `Add a project from ${organizationName}`,
    // Desktop's title reads "Add project to <organization>" (CAN-3909), so
    // repeating the name in the tile adds nothing.
    scopedSummary: 'Team projects',
  };
}
