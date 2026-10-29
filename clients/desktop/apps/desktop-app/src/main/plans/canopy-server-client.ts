import { BRAND } from '@canopy/brand/current';
import type {
  SharedPlanCreateRequest,
  SharedPlanDetail,
  SharedPlanUpdateRequest,
} from '@canopy/protocol/plans';
import {
  assertCanopyCloudCapability,
  requestCanopyCloudJson,
} from '../canopy-cloud/client';

const API_PREFIX = `/api/v1/${BRAND.web.apiNamespace}`;
const PLANS_CAPABILITY = 'plans-crud-v1';

export async function createSharedPlan(
  request: SharedPlanCreateRequest,
): Promise<SharedPlanDetail> {
  await assertCanopyCloudCapability(PLANS_CAPABILITY);
  return requestCanopyCloudJson<SharedPlanDetail>(`${API_PREFIX}/plans`, {
    method: 'POST',
    body: JSON.stringify(request),
  });
}

// In-flight coalescing for shared-plan GETs, keyed by `remoteId`. Multiple
// tracked-plan tuples across worktrees can point at the same remote plan; on the
// startup sweep (and per SSE signal) they would otherwise each issue an identical
// GET for one resource. Pure in-flight (deleted on settle, no lingering cache) so
// a request only ever joins one that is genuinely happening right now — zero
// staleness, which SSE-signalled refreshes require.
const inFlightGets = new Map<string, Promise<SharedPlanDetail>>();

export async function getSharedPlan(
  remoteId: string,
): Promise<SharedPlanDetail> {
  const existing = inFlightGets.get(remoteId);
  if (existing) {
    return existing;
  }
  const request = (async (): Promise<SharedPlanDetail> => {
    await assertCanopyCloudCapability(PLANS_CAPABILITY);
    return requestCanopyCloudJson<SharedPlanDetail>(
      `${API_PREFIX}/plans/${encodeURIComponent(remoteId)}`,
    );
  })().finally(() => {
    if (inFlightGets.get(remoteId) === request) {
      inFlightGets.delete(remoteId);
    }
  });
  inFlightGets.set(remoteId, request);
  return request;
}

export async function updateSharedPlan(
  remoteId: string,
  request: SharedPlanUpdateRequest,
): Promise<SharedPlanDetail> {
  await assertCanopyCloudCapability(PLANS_CAPABILITY);
  return requestCanopyCloudJson<SharedPlanDetail>(
    `${API_PREFIX}/plans/${encodeURIComponent(remoteId)}`,
    {
      method: 'PUT',
      body: JSON.stringify(request),
    },
  );
}
