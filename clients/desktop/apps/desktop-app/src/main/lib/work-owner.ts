import {
  APP_ADVISOR_PROJECT_ID,
  CODE_REVIEW_CHAT_PROJECT_ID,
  PLAN_EXPLORE_CHAT_PROJECT_ID,
} from '@canopy/desktop-shared/types';
import type { WorkspaceContext } from '@canopy/protocol/workspace-context';
import {
  resolveBackgroundTargetContext,
  resolveBackgroundWorkspaceTarget,
} from '../services/background-execution-context';
import { getCodeReviewTarget } from './code-review-registry';
import { logMainProcessWarn } from './main-process-logging';
import { getPlanExploreTarget } from './plan-explore-registry';

export type WorkOwnerOrganization =
  | { kind: 'organization'; organizationId: string }
  | { kind: 'none' }
  | { kind: 'unknown' };

export interface WorkOwnerTarget {
  projectId: string;
  worktreeId: string;
}

async function resolveRealTarget(
  target: WorkOwnerTarget,
): Promise<WorkOwnerTarget | null> {
  if (target.projectId === PLAN_EXPLORE_CHAT_PROJECT_ID) {
    return getPlanExploreTarget(target.worktreeId);
  }
  if (target.projectId === CODE_REVIEW_CHAT_PROJECT_ID) {
    return getCodeReviewTarget(target.worktreeId);
  }
  return target;
}

/**
 * The selected-context provider {@link resolveWorkOwnerOrganization} consults
 * for linked Personal work. A null selection yields no context, so a Personal
 * workspace resolves as Personal whatever is selected (CAN-3515).
 */
export function workOwnerContextForSelection(
  selectedOrganization: string | null,
): () => Promise<WorkspaceContext | null> {
  return () =>
    Promise.resolve(
      selectedOrganization
        ? { kind: 'organization', organizationId: selectedOrganization }
        : null,
    );
}

/**
 * The provider ambient callers use: telemetry sync and the product activity
 * reporter attribute work to its saved owner only, never the selected context.
 */
export const ambientWorkOwnerContext = workOwnerContextForSelection(null);

/**
 * Resolve the organization that governs work. `none` means deliberately
 * ungoverned; `unknown` means authority could not be established and callers
 * must fail closed.
 *
 * A Cowork workspace (including the legacy standalone sentinel) follows its
 * saved owner only: an org-owned one, such as an org's default Chats
 * workspace, is governed by that org, and a Personal one is ungoverned. The
 * selected context is never consulted for Cowork. App Advisor has no owner.
 */
export async function resolveWorkOwnerOrganization(
  target: WorkOwnerTarget,
  getContext: () => Promise<WorkspaceContext | null>,
): Promise<WorkOwnerOrganization> {
  try {
    if (target.projectId === APP_ADVISOR_PROJECT_ID) return { kind: 'none' };
    const resolvedTarget = await resolveRealTarget(target);
    if (!resolvedTarget) return { kind: 'unknown' };
    if (resolvedTarget.projectId === APP_ADVISOR_PROJECT_ID) {
      return { kind: 'none' };
    }

    const workspaceTarget = await resolveBackgroundWorkspaceTarget(
      resolvedTarget.projectId,
      resolvedTarget.worktreeId,
    );
    if (workspaceTarget.workspaceOwner.kind === 'organization') {
      return {
        kind: 'organization',
        organizationId: workspaceTarget.workspaceOwner.organizationId,
      };
    }
    // Stated explicitly rather than left to `linkedPersonalCandidate` (which
    // is single-repo only today) so a change there cannot open Personal
    // Cowork up to the selected context.
    if (workspaceTarget.workspaceType === 'cowork') return { kind: 'none' };
    if (!workspaceTarget.linkedPersonalCandidate) return { kind: 'none' };

    const context = await getContext();
    if (context?.kind !== 'organization') return { kind: 'none' };
    const { matches } = await resolveBackgroundTargetContext(
      resolvedTarget,
      context,
      workspaceTarget,
    );
    return matches
      ? { kind: 'organization', organizationId: context.organizationId }
      : { kind: 'none' };
  } catch (error) {
    logMainProcessWarn(
      '[work-owner] owner resolution failed; treating authority as unknown',
      error,
    );
    return { kind: 'unknown' };
  }
}
