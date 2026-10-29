import type { JSX } from 'react';
import { HookIcon } from '@canopy/ui-shared/icons';
import { formatTimingTimestamp } from '@canopy/ui-shared/lib';
import { REPLAY_BLOCK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';

export interface PipelineHookTriggerSource {
  readonly kind: 'hook';
  readonly hook_label: string;
  readonly triggered_at: string;
}

/** Any trigger source; the badge narrows to hook itself (original
 * isHookTriggerSource semantics) so callers can pass their full union. */
export interface PipelineTriggerSourceLike {
  readonly kind: string;
}

function isHookTriggerSource(
  source: PipelineTriggerSourceLike | undefined,
): source is PipelineHookTriggerSource {
  return source !== undefined && source.kind === 'hook';
}

export interface QueuedPipelineCardEntry {
  readonly queueId: string;
  readonly pipelineName: string;
  readonly trigger_source?: PipelineTriggerSourceLike;
}

export interface FailedQueuedPipelineCardEntry extends QueuedPipelineCardEntry {
  readonly error: string;
}

export interface PendingExecutionCardEntry {
  readonly localId: string;
  readonly pipelineName: string;
  readonly taskText: string;
}

export interface FailedPendingExecutionCardEntry {
  readonly localId: string;
  readonly pipelineName: string;
  readonly error: string;
}

export interface QueuedHookPipelineCardProps {
  readonly entry: QueuedPipelineCardEntry;
  readonly onCancel: (queueId: string) => void;
}

export interface FailedQueuedHookPipelineCardProps {
  readonly entry: FailedQueuedPipelineCardEntry;
  readonly onDismiss: (queueId: string) => void;
}

export interface PendingExecutionCardProps {
  readonly entry: PendingExecutionCardEntry;
  readonly onCancel: (localId: string) => void;
}

export interface FailedPendingExecutionCardProps {
  readonly entry: FailedPendingExecutionCardEntry;
  readonly onDismiss: (localId: string) => void;
}

function getHookTriggerTooltip(source: PipelineHookTriggerSource): string {
  return `Triggered by hook: ${source.hook_label} at ${formatTimingTimestamp(source.triggered_at)}`;
}

export function HookTriggerBadge({
  triggerSource,
}: {
  readonly triggerSource: PipelineTriggerSourceLike | undefined;
}): JSX.Element | null {
  if (!isHookTriggerSource(triggerSource)) {
    return null;
  }

  const tooltip = getHookTriggerTooltip(triggerSource);
  return (
    <span
      title={tooltip}
      aria-label={tooltip}
      className="inline-flex items-center fg-secondary/70"
    >
      <HookIcon width={12} height={12} />
    </span>
  );
}

export function QueuedHookPipelineCard({
  entry,
  onCancel,
}: QueuedHookPipelineCardProps): JSX.Element {
  return (
    <div className="flex items-center justify-between gap-2 rounded-md border border-dashed bg-fg-primary/[0.04] px-2.5 py-1.5">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-s font-medium fg-primary">
            {entry.pipelineName}
          </span>
          <HookTriggerBadge triggerSource={entry.trigger_source} />
        </div>
        <div className="truncate text-2xs fg-secondary">
          Queued — waiting for active pipeline runs to finish
        </div>
      </div>
      <button
        type="button"
        onClick={() => onCancel(entry.queueId)}
        className="focus-ring shrink-0 rounded-md border px-2 py-1 text-2xs fg-secondary transition hover:bg-fg-primary/[0.06] hover:fg-primary"
        aria-label="Cancel queued pipeline"
      >
        Cancel
      </button>
    </div>
  );
}

export function FailedQueuedHookPipelineCard({
  entry,
  onDismiss,
}: FailedQueuedHookPipelineCardProps): JSX.Element {
  return (
    <div className="flex items-start justify-between gap-2 rounded-md border border-line-destructive/30 bg-destructive/5 px-2.5 py-1.5">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-s font-medium fg-primary">
            {entry.pipelineName}
          </span>
          <HookTriggerBadge triggerSource={entry.trigger_source} />
        </div>
        <div className="truncate text-2xs fg-destructive" title={entry.error}>
          Queue failed: {entry.error}
        </div>
      </div>
      <button
        type="button"
        onClick={() => onDismiss(entry.queueId)}
        className="focus-ring shrink-0 rounded-md border px-2 py-1 text-2xs fg-secondary transition hover:bg-fg-primary/[0.06] hover:fg-primary"
        aria-label="Dismiss failed queued pipeline"
      >
        Dismiss
      </button>
    </div>
  );
}

export function PendingExecutionCard({
  entry,
  onCancel,
}: PendingExecutionCardProps): JSX.Element {
  return (
    <div className="flex items-center justify-between gap-2 rounded-md border border-dashed bg-fg-primary/[0.04] px-2.5 py-1.5">
      <div className="min-w-0 flex-1">
        <div className="truncate text-s font-medium fg-primary">
          {entry.pipelineName}
        </div>
        {/* The tooltip is the task prompt the user wrote. */}
        <div
          className={`${REPLAY_BLOCK_CLASS} truncate text-2xs fg-secondary`}
          title={entry.taskText}
        >
          Queued — waiting for setup
        </div>
      </div>
      <button
        type="button"
        onClick={() => onCancel(entry.localId)}
        className="focus-ring shrink-0 rounded-md border px-2 py-1 text-2xs fg-secondary transition hover:bg-fg-primary/[0.06] hover:fg-primary"
        aria-label="Cancel queued pipeline"
      >
        Cancel
      </button>
    </div>
  );
}

export function FailedPendingExecutionCard({
  entry,
  onDismiss,
}: FailedPendingExecutionCardProps): JSX.Element {
  return (
    <div className="flex items-start justify-between gap-2 rounded-md border border-line-destructive/30 bg-destructive/5 px-2.5 py-1.5">
      <div className="min-w-0 flex-1">
        <div className="truncate text-s font-medium fg-primary">
          {entry.pipelineName}
        </div>
        <div className="truncate text-2xs fg-destructive" title={entry.error}>
          Queue failed: {entry.error}
        </div>
      </div>
      <button
        type="button"
        onClick={() => onDismiss(entry.localId)}
        className="focus-ring shrink-0 rounded-md border px-2 py-1 text-2xs fg-secondary transition hover:bg-fg-primary/[0.06] hover:fg-primary"
        aria-label="Dismiss failed queued pipeline"
      >
        Dismiss
      </button>
    </div>
  );
}
