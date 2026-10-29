import type { PortalPullRequestState } from '@canopy/desktop-shared/types';
import { worktreeScopedParentLocalId } from '@canopy/protocol/portal';
import {
  createPortalEvent,
  enqueuePortalEvent,
  isCanopyPortalActive,
} from '../portal/portal-event-bus';

/**
 * Cached last-projected `pr_status` payload per worktree.
 *
 * Portal `pr_status` upserts replace the cached entity wholesale, so a
 * progress-only delta would clobber every PR field. Emitters merge their
 * overrides onto the remembered payload instead.
 */
const lastPortalPrStateByKey = new Map<string, PortalPullRequestState>();

const fullProjectionAt = new Map<string, number>();

function progressKey(
  workspaceLocalId: string,
  worktreeLocalId: string,
): string {
  return `${workspaceLocalId}/${worktreeLocalId}`;
}

/** Remember the latest fully projected PR payload for the worktree. */
export function rememberPortalPrState(state: PortalPullRequestState): void {
  fullProjectionAt.set(
    progressKey(state.workspaceLocalId, state.worktreeLocalId),
    Date.now(),
  );
  lastPortalPrStateByKey.set(
    progressKey(state.workspaceLocalId, state.worktreeLocalId),
    state,
  );
}

/** Drop the cached payload for a worktree (deletion / cleanup paths). */
export function forgetPortalPrState(
  workspaceLocalId: string,
  worktreeLocalId: string,
): void {
  fullProjectionAt.delete(progressKey(workspaceLocalId, worktreeLocalId));
  lastPortalPrStateByKey.delete(progressKey(workspaceLocalId, worktreeLocalId));
}

/** Reuse a complete recent projection; progress-only deltas are not a cache fill. */
export function getCachedPortalPrState(
  workspaceLocalId: string,
  worktreeLocalId: string,
): PortalPullRequestState | undefined {
  const key = progressKey(workspaceLocalId, worktreeLocalId);
  const projectedAt = fullProjectionAt.get(key);
  return projectedAt !== undefined && Date.now() - projectedAt < 30_000
    ? lastPortalPrStateByKey.get(key)
    : undefined;
}

/**
 * Push a live `pr_status` delta carrying `overrides` merged onto the last
 * remembered payload. No-op without an active portal session.
 */
export function emitPrStatusDelta(
  workspaceLocalId: string,
  worktreeLocalId: string,
  overrides: Partial<PortalPullRequestState>,
): void {
  if (!isCanopyPortalActive()) return;
  const lastKnown = lastPortalPrStateByKey.get(
    progressKey(workspaceLocalId, worktreeLocalId),
  );
  const payload: PortalPullRequestState = {
    ...(lastKnown ?? {
      workspaceLocalId,
      worktreeLocalId,
      number: null,
    }),
    ...overrides,
  };
  lastPortalPrStateByKey.set(
    progressKey(workspaceLocalId, worktreeLocalId),
    payload,
  );
  enqueuePortalEvent(
    createPortalEvent('portal.state.delta', {
      scope: 'pr',
      target: { workspaceLocalId, worktreeLocalId },
      entities: [
        {
          entityType: 'pr_status',
          localId: worktreeLocalId,
          parentLocalId: worktreeScopedParentLocalId(
            workspaceLocalId,
            worktreeLocalId,
          ),
          payload,
        },
      ],
      generatedAt: new Date().toISOString(),
    }),
  );
}
