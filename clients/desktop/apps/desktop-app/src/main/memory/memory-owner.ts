/**
 * Owning-org resolution for organization memory (CAN-3457).
 *
 * Org memory follows the owner of the work (CAN-3455 D1, D5): a chat searches
 * only the organization that owns its project, is off in Personal work and App
 * Advisor, and never falls back to another org. A Cowork workspace follows its
 * saved owner (CAN-3477): an org-owned one, such as an org's default Chats
 * workspace, searches that org; a Personal one searches nothing. The sidebar
 * and the tab's captured context are never consulted for Cowork.
 *
 * This module answers "which org, if any, owns this turn's work"; eligibility
 * (the account's advertised list and billing lapse) is checked separately by
 * the caller.
 *
 * Every failure resolves to `null` — search nothing — never to a default org.
 */
import {
  APP_ADVISOR_PROJECT_ID,
  CODE_REVIEW_CHAT_PROJECT_ID,
  PLAN_EXPLORE_CHAT_PROJECT_ID,
} from '@canopy/desktop-shared/types';
import {
  parseWorkspaceContext,
  type WorkspaceContext,
} from '@canopy/protocol/workspace-context';
import { getCodeReviewTarget } from '../lib/code-review-registry';
import { getPlanExploreTarget } from '../lib/plan-explore-registry';
import { logMainProcessWarn } from '../lib/main-process-logging';
import { getWorkspaceContextService } from '../lib/workspace-context-service';
import {
  resolveBackgroundTargetContext,
  resolveBackgroundWorkspaceTarget,
} from '../services/background-execution-context';

export interface OrgMemoryOwnerInput {
  projectId: string;
  worktreeId: string;
  /**
   * The chat tab's persisted serialized execution context, when the caller
   * already holds the tab. Only consulted for a Personal single-repo project.
   */
  executionContext?: string;
  /**
   * Reads the tab's persisted execution context when the caller does not hold
   * the tab. Called at most once, and only for a Personal single-repo project.
   */
  readPersistedExecutionContext?: () => Promise<string | undefined>;
  /**
   * Whether a person started this turn. Only then may a tab with no captured
   * context fall back to the live sidebar context; a background turn with no
   * captured context searches nothing, so it cannot follow whichever org the
   * user happens to select. The caller derives this from the turn's
   * `initiationSource`, so background dispatchers must set a non-user source
   * (hook and automation turns never search memory at all).
   */
  userInitiated: boolean;
}

/** Maps plan-explore and code-review sentinels onto their real target. */
async function resolveRealTarget(
  projectId: string,
  worktreeId: string,
): Promise<{ projectId: string; worktreeId: string } | null> {
  if (projectId === PLAN_EXPLORE_CHAT_PROJECT_ID) {
    return getPlanExploreTarget(worktreeId);
  }
  if (projectId === CODE_REVIEW_CHAT_PROJECT_ID) {
    return getCodeReviewTarget(worktreeId);
  }
  return { projectId, worktreeId };
}

/** App Advisor has no owner, so it never searches org memory. */
function isMemoryDisabledSurface(projectId: string): boolean {
  return projectId === APP_ADVISOR_PROJECT_ID;
}

/**
 * The context a linked Personal project's turn runs in: the tab's captured
 * context when it has one, otherwise — for a user-initiated turn only — the
 * live sidebar context, read once after queued switches settle.
 */
async function resolveTurnContext(
  input: OrgMemoryOwnerInput,
): Promise<WorkspaceContext | null> {
  const executionContext =
    input.executionContext ?? (await input.readPersistedExecutionContext?.());
  if (executionContext !== undefined) {
    return parseWorkspaceContext(executionContext);
  }
  if (!input.userInitiated) return null;
  const service = getWorkspaceContextService();
  await service.initialize();
  // A switch or account transition queued just before this turn must land
  // first, or the snapshot could name the org the user just left.
  await service.whenIdle();
  return service.getState().context;
}

/** The organization a turn may search, plus the persisted facts it rests on. */
export interface OrgMemoryOwner {
  organizationId: string;
  /**
   * Whether the saved `workspace.json` type is Cowork. Callers shape the query
   * from this rather than from the in-memory sidebar registry, so the owner
   * and the query always agree on the same persisted read.
   */
  isCowork: boolean;
}

/**
 * Returns the organization whose memory this turn may search, or `null` to
 * search nothing.
 */
export async function resolveOrgMemoryOrganization(
  input: OrgMemoryOwnerInput,
): Promise<string | null> {
  const owner = await resolveOrgMemoryOwner(input);
  return owner?.organizationId ?? null;
}

/**
 * Like {@link resolveOrgMemoryOrganization}, but also reports whether the
 * persisted workspace is Cowork, so the caller can shape the query without a
 * second, possibly stale, source of truth.
 */
export async function resolveOrgMemoryOwner(
  input: OrgMemoryOwnerInput,
): Promise<OrgMemoryOwner | null> {
  try {
    if (isMemoryDisabledSurface(input.projectId)) return null;
    const target = await resolveRealTarget(input.projectId, input.worktreeId);
    if (!target || isMemoryDisabledSurface(target.projectId)) return null;

    // Persisted owner authority; throws (→ null) on unreadable or malformed
    // config. The legacy Cowork sentinel maps to its Cowork workspace here.
    const workspaceTarget = await resolveBackgroundWorkspaceTarget(
      target.projectId,
      target.worktreeId,
    );
    const { workspaceOwner, linkedPersonalCandidate, workspaceType } =
      workspaceTarget;
    // Private memory, or a setting that cannot be trusted, searches nothing.
    // Taken from the owner's config read so one read decides both.
    if (workspaceTarget.privateMemory || workspaceTarget.memoryMalformed) {
      return null;
    }
    const isCowork = workspaceType === 'cowork';
    if (workspaceOwner.kind === 'organization') {
      return { organizationId: workspaceOwner.organizationId, isCowork };
    }
    // A Personal Cowork workspace searches nothing: its saved owner is the
    // only authority, so neither the sidebar nor the tab's context applies.
    // Stated explicitly rather than left to `linkedPersonalCandidate` (which
    // is single-repo only today) so a change there cannot open Cowork up.
    if (isCowork) return null;
    if (!linkedPersonalCandidate) return null;

    const context = await resolveTurnContext(input);
    if (context?.kind !== 'organization') return null;
    // Same matching rule background execution uses: a Personal single repo
    // runs in org X only when it is linked to X.
    const { matches } = await resolveBackgroundTargetContext(
      { projectId: target.projectId, worktreeId: target.worktreeId },
      context,
      workspaceTarget,
    );
    return matches
      ? { organizationId: context.organizationId, isCowork }
      : null;
  } catch (error) {
    // Fail closed, but keep an unexpected error visible in the main log.
    logMainProcessWarn(
      '[org-memory] owner resolution failed; searching nothing',
      error,
    );
    return null;
  }
}
