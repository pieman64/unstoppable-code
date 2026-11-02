import {
  APP_ADVISOR_PROJECT_ID,
  CODE_REVIEW_CHAT_PROJECT_ID,
  PIPELINE_EDITOR_PROJECT_ID,
  PLAN_EXPLORE_CHAT_PROJECT_ID,
  type AgentAuditEntry,
  type AgentAuditHistoryRequest,
} from '@canopy/desktop-shared/types';
import { findCodeReviewTarget } from '@/stores/chat/code-review-registry';
import { findPlanExploreTarget } from '@/stores/chat/plan-explore-registry';

/** Workspace whose navigation context owns an audit entry, when it has one. */
export function auditEntryWorkspaceId(
  entry: Pick<
    AgentAuditEntry,
    'contextWorkspaceId' | 'projectId' | 'worktreeId' | 'linkTarget'
  >,
): string | undefined {
  const target = entry.linkTarget;
  if (entry.contextWorkspaceId) return entry.contextWorkspaceId;
  if (target?.kind === 'standalone-chat') return target.worktreeId;
  if (entry.projectId === PLAN_EXPLORE_CHAT_PROJECT_ID) {
    return (
      findPlanExploreTarget(entry.worktreeId ?? '')?.projectId ??
      entry.projectId
    );
  }
  if (entry.projectId === CODE_REVIEW_CHAT_PROJECT_ID) {
    return (
      findCodeReviewTarget(entry.worktreeId ?? '')?.projectId ?? entry.projectId
    );
  }
  if (
    entry.projectId === PIPELINE_EDITOR_PROJECT_ID ||
    entry.projectId === APP_ADVISOR_PROJECT_ID
  ) {
    return undefined;
  }
  if (target?.projectId) return target.projectId;
  if (entry.projectId) return entry.projectId;
  return undefined;
}

/** The providers the Audit trail's Provider filter offers, in order. */
export const AUDIT_TRAIL_PROVIDERS = ['claude', 'codex', 'ollama'] as const;

export type AuditTrailProvider = (typeof AUDIT_TRAIL_PROVIDERS)[number];

/** The filter's pick for a request's provider: none for `all`. */
export function auditTrailProviderSelection(
  provider: AgentAuditHistoryRequest['provider'],
): AuditTrailProvider[] {
  return AUDIT_TRAIL_PROVIDERS.filter((value) => value === provider);
}
