import { DeferredToolOutput } from './DeferredToolOutput';
import { useState, type JSX } from 'react';
import { useWorkflowRun } from '@/hooks/useWorkflowRun';
import { WorkflowRunView } from '../activity/WorkflowRunView';
import { WorkflowIcon } from '../activity/WorkflowIcon';
import { ThinkingSpinner } from '../shared/loading/spinners/ThinkingSpinner';
import { ChevronIcon } from '../activity/RunOutputControls';
import type { ToolResult } from './types';

const TERMINAL_STATUSES = new Set([
  'completed',
  'failed',
  'cancelled',
  'canceled',
  'stopped',
]);

export function WorkflowBlock({
  workflowName,
  summary,
  runId,
  transcriptDir,
  result,
}: {
  workflowName: string;
  summary: string;
  runId?: string;
  transcriptDir?: string;
  result?: ToolResult;
}): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  // The chat card has no Canopy process-status signal, so derive terminality
  // from the run-state itself (passed false here; the hook still stops when the
  // run JSON reports a terminal status).
  const { run, loading } = useWorkflowRun(transcriptDir, runId, false);

  const launched = Boolean(runId);
  const status = run?.status;
  const isRunning =
    launched && (!status || !TERMINAL_STATUSES.has(status.toLowerCase()));
  const doneCount = run?.agents.filter((a) => a.state === 'done').length ?? 0;
  const total = run?.agents.length ?? run?.agentCount ?? 0;

  return (
    <div
      data-testid="workflow-block"
      data-launched={launched ? 'true' : 'false'}
      className="my-1 rounded-lg border bg-fg-primary/[0.02]"
    >
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        className="focus-ring flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        <span className="flex-shrink-0">
          <ChevronIcon open={expanded} />
        </span>
        <span className="flex-shrink-0 fg-special">
          <WorkflowIcon />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="text-xs font-semibold fg-primary/80">
              Workflow
            </span>
            <span className="truncate text-xs fg-secondary">
              {workflowName}
            </span>
            {isRunning && (
              <ThinkingSpinner tone="accent" className="flex-shrink-0" />
            )}
          </span>
          {summary && (
            <span className="mt-0.5 block truncate text-2xs fg-secondary">
              {summary}
            </span>
          )}
        </span>
        {launched && total > 0 && (
          <span className="flex-shrink-0 text-2xs fg-secondary">
            {doneCount}/{total}
          </span>
        )}
      </button>
      {expanded && (
        <div className="border-t px-3 py-2">
          {!launched ? (
            <div className="py-2 text-xs fg-secondary">Launching workflow…</div>
          ) : (
            <WorkflowRunView
              run={run}
              transcriptDir={transcriptDir}
              loading={loading}
            />
          )}
        </div>
      )}
      {result?.fullOutputRef && result.messageId && result.toolUseId && (
        // The run view above owns the visible output; the viewer only adds the
        // full-output control, so it gets an empty preview.
        <div data-testid="chat-deferred-output-host">
          <DeferredToolOutput
            reference={result.fullOutputRef}
            preview=""
            messageId={result.messageId}
            toolUseId={result.toolUseId}
          />
        </div>
      )}
    </div>
  );
}
