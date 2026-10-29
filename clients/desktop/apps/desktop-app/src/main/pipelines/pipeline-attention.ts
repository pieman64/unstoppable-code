import type {
  ExecutionEvent,
  PipelineStatusReason,
} from '@canopy/desktop-shared/types/pipeline';
import { getAttentionTracker } from '../services/attention-tracker';

/**
 * Pipeline checkpoints do not belong to a chat turn. Use a stable synthetic
 * chat key so the existing `(worktree, chat)` attention transport can still
 * collapse one live state per execution. Mobile cannot resolve this key as a
 * chat and therefore falls back to the feed, which is the correct pipeline
 * landing surface until the push contract grows a pipeline deep link.
 */
export function pipelineAttentionChatId(executionId: string): string {
  return `pipeline:${executionId}`;
}

function checkpointDetail(
  event: ExecutionEvent,
  reason: PipelineStatusReason,
): string {
  const checkpoint = event.state.pending_pauses?.find(
    (candidate) =>
      candidate.job_id === reason.source.job_id &&
      candidate.step_id === reason.source.step_id,
  );
  return (
    checkpoint?.request?.title ??
    checkpoint?.request?.message ??
    reason.diagnostic_message ??
    `${reason.source.job_id} / ${reason.source.step_id}`
  );
}

function usageLimitDetail(reason: PipelineStatusReason): string | undefined {
  if (!reason.resets_at) return undefined;
  const reset = new Date(reason.resets_at);
  if (!Number.isFinite(reset.getTime())) return undefined;
  return `resets ${reset.toLocaleString([], {
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
  })}`;
}

/** Project actionable pipeline status reasons into the shared attention path. */
export function syncPipelineAttention(event: ExecutionEvent): void {
  const projectId = event.state.project_id;
  const worktreeId = event.state.worktree_id;
  if (!projectId || !worktreeId) return;

  // Category priority is load-bearing: input checkpoints get first claim on
  // the shared rate ceiling, then authentication, then usage limits. Retryable
  // provider outages are automation concerns and never ask the human to act.
  const statusReasons = event.state.status_reasons ?? [];
  const input = statusReasons.find(
    (candidate) =>
      candidate.kind === 'input_required' || candidate.kind === 'action_paused',
  );
  const authentication = statusReasons.find(
    (candidate) => candidate.kind === 'provider_authentication_required',
  );
  const usageLimit = statusReasons.find(
    (candidate) => candidate.kind === 'provider_usage_limit',
  );
  const chatId = pipelineAttentionChatId(event.state.id);
  // One pipeline execution has one projected state. Reusing one source keeps
  // transitions last-write-wins even when a reason later cycles back.
  const sourceId = 'pipeline-status';
  const tracker = getAttentionTracker();

  if (input) {
    tracker.mark({
      projectId,
      worktreeId,
      chatId,
      sourceId,
      state: 'needs_input',
      reason: 'pipeline_input',
      detail: checkpointDetail(event, input),
    });
    return;
  }
  if (authentication) {
    tracker.mark({
      projectId,
      worktreeId,
      chatId,
      sourceId,
      state: 'blocked',
      reason: 'auth_required',
    });
    return;
  }
  if (usageLimit) {
    const detail = usageLimitDetail(usageLimit);
    tracker.mark({
      projectId,
      worktreeId,
      chatId,
      sourceId,
      state: 'blocked',
      reason: 'usage_limit',
      ...(detail ? { detail } : {}),
    });
    return;
  }

  tracker.clear(projectId, worktreeId, chatId);
}
