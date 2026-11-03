/**
 * Slim archived-pipeline row for the archived-container viewer's Pipelines
 * tab. Deliberately NOT `CompletedRunRow` (PipelineRunsSection), which is
 * coupled to the live pipeline store and mutable-run actions
 * (resume/retry/rerun/watchers); archived executions are terminal and
 * read-only. The projected row state for the DAG preview arrives with the
 * container's `listExecutions` response — one IPC round trip for the whole
 * tab, never a fetch per row.
 */
import type { JSX } from 'react';
import type { ExecutionSummary } from '@canopy/desktop-shared/types/pipeline';
import type { PipelineRunRowState } from '@/lib/pipelineRunRowState';
import { DagProgressBar } from '@/components/activity/DagProgressBar';
import { pipelineStatusBadge } from '@/components/activity/utils';
import { Badge } from '@canopy/ui-shared/components';
import { formatDateOrEmpty } from '@/lib/format';
import { capitalizeFirstLetter } from '@canopy/ui-shared/lib';

export interface ArchivedExecutionRowProps {
  summary: ExecutionSummary;
  /** Projected state for the DAG preview; the row stays clickable without it. */
  executionState: PipelineRunRowState | undefined;
  onOpen: (executionId: string) => void;
}

export function ArchivedExecutionRow({
  summary,
  executionState,
  onOpen,
}: ArchivedExecutionRowProps): JSX.Element {
  return (
    <button
      type="button"
      data-testid={`archived-execution-row-${summary.id}`}
      onClick={() => onOpen(summary.id)}
      className="focus-ring flex w-full flex-col gap-2 rounded-lg border bg-fg-primary/[0.02] px-3 py-2.5 text-left transition-colors hover:bg-fg-primary/[0.05]"
    >
      <div className="flex min-w-0 items-center gap-2">
        <Badge {...pipelineStatusBadge(summary.status)} muted>
          {capitalizeFirstLetter(summary.status)}
        </Badge>
        <span className="min-w-0 truncate text-sm fg-primary/85">
          {summary.pipeline_name}
        </span>
        <span className="ml-auto shrink-0 text-2xs fg-secondary">
          {formatDateOrEmpty(summary.started_at)}
        </span>
      </div>
      {executionState !== undefined && (
        <DagProgressBar executionState={executionState} muted />
      )}
    </button>
  );
}
