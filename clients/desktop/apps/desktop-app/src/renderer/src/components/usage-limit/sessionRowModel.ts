import { getModelCatalogProviderLabel } from '@canopy/ui-shared';
import type {
  AccountChangeResumeReason,
  UsageLimitedSessionItem,
} from '@canopy/desktop-shared/types';
import type { SessionResumeReadiness } from '@/lib/usage-limit/resume-availability';
import { formatUsageLimitTimeLabel } from '@/lib/usage-limit-time-label';
import {
  chatResumeEffectLabel,
  formatStoppedAt,
  lastStepLabel,
  stepLabelSaysStopped,
} from '@/lib/usage-limit/interrupted-work-copy';

const REASON_LABELS: Record<AccountChangeResumeReason, string> = {
  usage_limit: 'Usage limit',
  authentication: 'Authentication issue',
  provider_sign_in: 'Sign-in needed',
  app_shutdown: 'Application stopped',
};
const REASON_UNAVAILABLE = 'Interruption reason unavailable';

export { interruptedSessionKey } from '@/lib/interruptedSessions';

/** A DOM-id-safe, collision-free encoding of a full session key. */
export function interruptedSessionDomId(prefix: string, key: string): string {
  return `${prefix}-${key.replace(
    /[^A-Za-z0-9-]/g,
    (char) => `_${char.charCodeAt(0).toString(16)}_`,
  )}`;
}

export function interruptedSessionCheckboxTestId(
  session: UsageLimitedSessionItem,
): string {
  return session.kind === 'chat'
    ? `usage-limit-resume-chat-${session.chatId}`
    : `usage-limit-resume-pipeline-${session.executionId}`;
}

export function interruptedSessionTitle(
  session: UsageLimitedSessionItem,
): string {
  return session.kind === 'chat' ? session.chatTitle : session.pipelineName;
}

/** Distinct reasons; only legacy chats without one imply a usage limit. */
export function interruptedSessionReasonLabels(
  session: UsageLimitedSessionItem,
): string[] {
  const reasons =
    session.kind === 'chat'
      ? session.resumeReason
        ? [session.resumeReason]
        : []
      : (session.resumeReasons ?? []);
  const labels = Array.from(
    new Set(
      reasons.map((r) =>
        Object.prototype.hasOwnProperty.call(REASON_LABELS, r)
          ? REASON_LABELS[r]
          : REASON_UNAVAILABLE,
      ),
    ),
  );
  return labels.length > 0
    ? labels
    : [
        session.kind === 'chat'
          ? REASON_LABELS.usage_limit
          : REASON_UNAVAILABLE,
      ];
}

/**
 * `Claude · Usage limit · Ready now`, or for a waiting session
 * `Codex · Application stopped · Weekly limit · Resets Mon 6:13 PM`. The
 * blocking window replaces only the generic usage-limit reason. Without a
 * readiness (ungated origins) only provider and reasons are shown.
 */
export function interruptedSessionMetadata(
  session: UsageLimitedSessionItem,
  readiness: SessionResumeReadiness | undefined,
): string {
  const provider = session.provider
    ? getModelCatalogProviderLabel(session.provider)
    : 'Provider unavailable';
  let reasons = interruptedSessionReasonLabels(session);
  if (readiness?.state === 'waiting') {
    const usageLimit = reasons.indexOf(REASON_LABELS.usage_limit);
    reasons =
      usageLimit === -1
        ? [...reasons, readiness.windowLabel]
        : reasons.map((label, index) =>
            index === usageLimit ? readiness.windowLabel : label,
          );
    reasons = Array.from(new Set(reasons));
  }
  const parts = [provider, ...reasons];
  if (readiness?.state === 'ready') parts.push('Ready now');
  if (readiness?.state === 'waiting') {
    const resetLabel = formatUsageLimitTimeLabel(readiness.displayResetMs);
    parts.push(resetLabel ? `Resets ${resetLabel}` : 'Waiting for reset');
    if (readiness.hasAdditionalUnknownReset)
      parts.push('Waiting for another reset');
  }
  return parts.join(' · ');
}

export interface ChatRowContext {
  now: Date;
  /** The worktree's uncommitted state; `undefined` while unknown. */
  uncommittedChanges?: boolean;
  /** Spell out every chat's resume message, not only a resend. */
  showEveryResumeEffect: boolean;
}

/**
 * A chat's last step, recorded stop time, uncommitted state, and resume
 * message, or the workflow's paused-step and model detail. Unknown parts are
 * omitted; a clean or unknown worktree never claims either.
 */
export function interruptedSessionSecondaryMetadata(
  session: UsageLimitedSessionItem,
  chatContext?: ChatRowContext,
): string {
  if (session.kind === 'chat') {
    const step = lastStepLabel(session.lastStep);
    const parts = chatContext
      ? [
          step,
          // `Stopped during …` already says it stopped; the time follows bare.
          formatStoppedAt(session.detectedAt, chatContext.now, {
            withVerb: !stepLabelSaysStopped(step),
          }),
          chatContext.uncommittedChanges === true
            ? 'Uncommitted changes'
            : null,
          chatResumeEffectLabel(session, chatContext.showEveryResumeEffect),
        ].filter((part): part is string => part !== null)
      : [];
    return parts.length > 0 ? parts.join(' · ') : 'Chat';
  }
  const parts = [
    'Workflow',
    `${session.pausedStepCount} paused step${session.pausedStepCount === 1 ? '' : 's'}`,
  ];
  if (session.modelLabels.length) parts.push(session.modelLabels.join(', '));
  if (session.otherBlockingReasonCount) {
    parts.push(
      `Also blocked by ${session.otherBlockingReasonCount} other issue${session.otherBlockingReasonCount === 1 ? '' : 's'}`,
    );
  }
  return parts.join(' · ');
}
