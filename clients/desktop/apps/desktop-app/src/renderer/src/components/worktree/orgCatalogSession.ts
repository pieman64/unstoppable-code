import { useEffect, useState } from 'react';
import {
  useOrgProjectsStore,
  type OrgProjectsStoreState,
} from '@canopy/app-state';
import { isOrgProjectCatalogKnownEmpty } from '@canopy/ui-app/org-project-catalog';
import {
  serializeWorkspaceContext,
  type WorkspaceContext,
} from '@canopy/protocol/workspace-context';

// The Add project dialog's read of an organization's catalog (CAN-3984),
// shared by the dialog's tile policy and the catalog list it shows.

type OrganizationContext = Extract<WorkspaceContext, { kind: 'organization' }>;
type CatalogSnapshot = OrgProjectsStoreState['snapshots'][string] | undefined;

/** What the dialog can trust of an organization's catalog read. */
export interface OrgCatalogReadState {
  /** The list is the cached one: offline, or the last read failed. */
  readonly stale: boolean;
  /** The member's access changed, or the server cannot serve the catalog. */
  readonly unauthorized: boolean;
  /** The open's GitHub re-read failed or ran long (CAN-3489). */
  readonly githubRefreshFailed: boolean;
  /** The server confirmed the organization has no GitHub connection. */
  readonly githubNotConnected: boolean;
}

/**
 * One reading of a catalog snapshot and its load error, shared by the list
 * and the dialog's tile policy (CAN-3984) so the two never disagree.
 */
export function deriveOrgCatalogReadState(
  snapshot: CatalogSnapshot,
  loadError: string | undefined,
): OrgCatalogReadState {
  const catalogError = snapshot && 'error' in snapshot ? snapshot.error : null;
  const repositoriesRefresh =
    snapshot !== undefined && 'repositoriesRefresh' in snapshot
      ? snapshot.repositoriesRefresh
      : undefined;
  return {
    stale:
      loadError !== undefined ||
      catalogError !== null ||
      (snapshot !== undefined &&
        'stale' in snapshot &&
        snapshot.stale === true),
    unauthorized:
      catalogError === 'access-changed' || catalogError === 'unavailable',
    githubRefreshFailed: repositoriesRefresh === 'failed',
    githubNotConnected: repositoriesRefresh === 'not-connected',
  };
}

/** The organization catalog the open dialog reads, and how far it got. */
export interface OrgCatalogSession {
  readonly snapshot: CatalogSnapshot;
  readonly loadError: string | undefined;
  /**
   * This open's reads, cached then re-read from GitHub, have both settled.
   * Until then nothing is known about emptiness or the GitHub connection.
   */
  readonly settled: boolean;
  /** A current, authorized read found nothing a member could add. */
  readonly knownEmpty: boolean;
}

/**
 * Reads the organization's catalog for one open of the dialog, whether or not
 * its panel is shown: what is cached at once, then a re-read of the
 * organization's repositories from GitHub so one created a minute ago can be
 * added (CAN-3489). A reopen, another organization, or another account starts
 * over, and a read from an earlier one never settles the new one.
 */
export function useOrgCatalogSession(
  context: OrganizationContext | null,
): OrgCatalogSession {
  // The store's own key, so the read always finds what the store applied.
  const key = context === null ? null : serializeWorkspaceContext(context);
  const accountEpoch = useOrgProjectsStore(
    (store): number => store.accountEpoch,
  );
  const load = useOrgProjectsStore(
    (store): OrgProjectsStoreState['load'] => store.load,
  );
  const storedSnapshot = useOrgProjectsStore(
    (store): CatalogSnapshot =>
      key === null ? undefined : store.snapshots[key],
  );
  const snapshot = storedSnapshot?.context === key ? storedSnapshot : undefined;
  const loadError = useOrgProjectsStore((store): string | undefined =>
    key === null ? undefined : store.errors[key],
  );
  const session = key === null ? null : `${accountEpoch}:${key}`;
  const [completion, setCompletion] = useState<{
    readonly session: string;
    readonly failed: boolean;
  } | null>(null);
  useEffect((): (() => void) | undefined => {
    if (context === null || session === null) return undefined;
    let active = true;
    const read = async (): Promise<void> => {
      // An initial failure still permits the repository refresh retry.
      await load(context).catch((): void => undefined);
      if (!active) return;
      let failed = false;
      try {
        await load(context, { refresh: true, repositories: true });
      } catch {
        failed = true;
      }
      if (active) setCompletion({ session, failed });
    };
    void read();
    return (): void => {
      active = false;
    };
  }, [context, session, load]);
  const settled = session !== null && completion?.session === session;
  const read = deriveOrgCatalogReadState(snapshot, loadError);
  return {
    snapshot,
    loadError,
    settled,
    knownEmpty:
      settled &&
      context !== null &&
      isOrgProjectCatalogKnownEmpty({
        organizationId: context.organizationId,
        projects: snapshot?.projects,
        // A failed repository re-read can omit newly available projects,
        // even when the canonical catalog request itself succeeded.
        stale: read.stale || read.githubRefreshFailed,
        unauthorized: read.unauthorized,
        loadFailed: loadError !== undefined || completion?.failed === true,
      }),
  };
}
