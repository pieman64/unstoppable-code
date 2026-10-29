'use client';

// ---------------------------------------------------------------------------
// When the Add project dialog offers its "From my org" tile (CAN-3984), shared
// by the desktop Add project dialog and the web portal's. A member whose
// organization has nothing to add yet goes straight to an option that can
// add something; owners and admins keep the tile, whose empty state offers
// to set the organization's projects up.
//
// Hosts supply what only they know: whether their catalog read is current,
// the selected organization's role, and whether another option can add a
// project. Selection mechanics stay in each dialog.
// ---------------------------------------------------------------------------

import { useState } from 'react';
import type { OrgProjectSummary } from '@canopy/protocol/org-projects';
import type { WorkspaceContextOrganizationRole } from '@canopy/protocol/workspace-context';
import { selectOrgProjectCatalogProjects } from './OrgProjectCatalogList';

export interface OrgProjectCatalogKnownEmptyInput {
  /** The organization the host's catalog read must belong to. */
  readonly organizationId: string;
  /** The host's catalog, or `undefined` until its first read lands. */
  readonly projects: readonly OrgProjectSummary[] | undefined;
  /** The list is the cached one (offline, or the read is out of date). */
  readonly stale: boolean;
  /** The member's access to the catalog changed or is unavailable. */
  readonly unauthorized: boolean;
  /** The host's last read of the catalog failed. */
  readonly loadFailed: boolean;
}

/**
 * Whether a current, authorized read says the organization has nothing a
 * member could add. Unloaded, stale, failed, or unauthorized data never
 * establishes emptiness. Projects this device already added still count: the
 * catalog is not empty merely because everything in it is here already.
 * Hosts check the read belongs to the selected organization and account
 * before passing its projects.
 */
export function isOrgProjectCatalogKnownEmpty({
  organizationId,
  projects,
  stale,
  unauthorized,
  loadFailed,
}: OrgProjectCatalogKnownEmptyInput): boolean {
  if (projects === undefined || stale || unauthorized || loadFailed)
    return false;
  return (
    selectOrgProjectCatalogProjects(projects, organizationId, new Set())
      .length === 0
  );
}

export interface OrgProjectCatalogTileInput {
  readonly knownEmpty: boolean;
  /** The selected organization's role; `undefined` while unresolved. */
  readonly role: WorkspaceContextOrganizationRole | undefined;
  /** Another option in the dialog can add a project right now. */
  readonly otherOptionsAvailable: boolean;
}

/**
 * Withhold the tile only from a known member, only for a known-empty
 * catalog, and only when another option can add something. Owners, admins,
 * and an unresolved role keep it, as does a member with nowhere else to go.
 */
export function shouldWithholdOrgProjectCatalog({
  knownEmpty,
  role,
  otherOptionsAvailable,
}: OrgProjectCatalogTileInput): boolean {
  return role === 'MEMBER' && knownEmpty && otherOptionsAvailable;
}

export interface OrgProjectCatalogWithholdingInput extends OrgProjectCatalogTileInput {
  /**
   * One open of the dialog for one organization and account, or `null`
   * while closed. A new key starts over.
   */
  readonly sessionKey: string | null;
}

/**
 * The tile policy, latched for one dialog session: once a member's empty
 * catalog is withheld, a background refresh that adds projects does not
 * bring the tile back under the member's form. Closing, a new organization
 * or account, a role that is no longer a known member, or the last other
 * option going away all clear it.
 */
export function useOrgProjectCatalogWithheld({
  sessionKey,
  knownEmpty,
  role,
  otherOptionsAvailable,
}: OrgProjectCatalogWithholdingInput): boolean {
  const [latchedSession, setLatchedSession] = useState<string | null>(null);
  const eligible =
    sessionKey !== null && role === 'MEMBER' && otherOptionsAvailable;
  const latch =
    eligible &&
    (shouldWithholdOrgProjectCatalog({
      knownEmpty,
      role,
      otherOptionsAvailable,
    }) ||
      latchedSession === sessionKey)
      ? sessionKey
      : null;
  // Adjusting state while rendering, React's pattern for state derived from
  // changing inputs: the next render already sees the latch.
  if (latch !== latchedSession) setLatchedSession(latch);
  return latch !== null;
}
