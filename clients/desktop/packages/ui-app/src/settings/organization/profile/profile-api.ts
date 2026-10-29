import type { AccountOrganizationSettingsClient } from '@canopy/app-core/settings';
import type {
  ApprovedPlanSummary,
  SharedPlanSummary,
} from '@canopy/protocol/plans';
import type { PipelineApiItem } from '@canopy/protocol/pipelines';
import type { SharedRunSummary } from '@canopy/protocol/runs';
import type { DigestArchiveItem } from '@canopy/protocol/settings/account-digests';
import type { OrganizationMemberListPage } from '@canopy/protocol/settings/operations-organization';
import { toTeamApiError } from '../team-api';

/**
 * Settings-client helpers for the member-profile list routes
 * (`organization.members.{plans,approvedPlans,runs,pipelines,digests}`).
 * Each list route wraps its payload as `{ data: [...], nextCursor }` and
 * resolves to a 404 for non-members, surfaced here as a `TeamApiError` so
 * callers can render the same `ErrorBanner` treatment used elsewhere on the
 * team surface. The per-element shape is trusted from the typed server
 * contract; the table validates the envelope.
 */

/** One page of a cursor-paged member-profile list. */
export interface PagedResult<T> {
  items: T[];
  nextCursor: string | null;
}

/** A member-profile list loader, as `useMemberPagedResource` calls it. */
export type MemberPagedLoader<T> = (
  client: AccountOrganizationSettingsClient,
  orgId: string,
  userId: string,
  cursor?: string,
) => Promise<PagedResult<T>>;

/** The input for one member-list page, omitting an empty cursor. */
function memberPageInput(
  orgId: string,
  userId: string,
  cursor: string | undefined,
): { organizationId: string; userId: string; cursor?: string } {
  return {
    organizationId: orgId,
    userId,
    ...(cursor === undefined || cursor === '' ? {} : { cursor }),
  };
}

async function readMemberPage<T>(
  read: () => Promise<OrganizationMemberListPage<T>>,
): Promise<PagedResult<T>> {
  let page: OrganizationMemberListPage<T>;
  try {
    page = await read();
  } catch (error: unknown) {
    throw toTeamApiError(error);
  }
  return { items: page.data, nextCursor: page.nextCursor };
}

/** Fetch a page of TEAM/ORGANIZATION-shared plans authored by a member in this org. */
export async function fetchMemberSharedPlans(
  client: AccountOrganizationSettingsClient,
  orgId: string,
  userId: string,
  cursor?: string,
): Promise<PagedResult<SharedPlanSummary>> {
  return readMemberPage(() =>
    client.read(
      'organization.members.plans',
      memberPageInput(orgId, userId, cursor),
    ),
  );
}

/**
 * Fetch a page of approved (telemetry) plans a member has started implementing
 * in this org. These are point-in-time snapshots — distinct from the shared
 * plans above — and link to the read-only `/plans/implemented/{id}` viewer.
 */
export async function fetchMemberApprovedPlans(
  client: AccountOrganizationSettingsClient,
  orgId: string,
  userId: string,
  cursor?: string,
): Promise<PagedResult<ApprovedPlanSummary>> {
  return readMemberPage(() =>
    client.read(
      'organization.members.approvedPlans',
      memberPageInput(orgId, userId, cursor),
    ),
  );
}

/** Fetch a page of ORGANIZATION-shared runs (sessions) authored by a member in this org. */
export async function fetchMemberSharedRuns(
  client: AccountOrganizationSettingsClient,
  orgId: string,
  userId: string,
  cursor?: string,
): Promise<PagedResult<SharedRunSummary>> {
  return readMemberPage(() =>
    client.read(
      'organization.members.runs',
      memberPageInput(orgId, userId, cursor),
    ),
  );
}

/** Fetch a page of TEAM/ORGANIZATION-shared pipelines authored by a member in this org. */
export async function fetchMemberSharedPipelines(
  client: AccountOrganizationSettingsClient,
  orgId: string,
  userId: string,
  cursor?: string,
): Promise<PagedResult<PipelineApiItem>> {
  return readMemberPage(() =>
    client.read(
      'organization.members.pipelines',
      memberPageInput(orgId, userId, cursor),
    ),
  );
}

/**
 * Fetch the work digests a viewer may see on this member's org profile.
 *
 * Deliberately not a paged read: the digest route answers `{ items }` rather
 * than the `{ data, nextCursor }` envelope the paged member lists use, because
 * the archive is already server-capped and has no cursor. The server decides
 * what "may see" means — the subject's own complete archive, or only the rows
 * they featured for this org — so this helper never filters.
 */
export async function fetchMemberProfileDigests(
  client: AccountOrganizationSettingsClient,
  orgId: string,
  userId: string,
): Promise<DigestArchiveItem[]> {
  try {
    const body = await client.read('organization.members.digests', {
      organizationId: orgId,
      userId,
    });
    return body.items;
  } catch (error: unknown) {
    throw toTeamApiError(error);
  }
}
