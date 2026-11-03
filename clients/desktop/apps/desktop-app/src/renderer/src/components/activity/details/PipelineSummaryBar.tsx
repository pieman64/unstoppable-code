import { useState, type JSX } from 'react';
import type { ExecutionState } from '@canopy/desktop-shared/types/pipeline';
import { formatTimingTimestamp } from '@/lib/pipelineTiming';
import { buildEventInputs } from '@/lib/pipelineDetailsView';
import { ChevronIcon, HookIcon } from '@canopy/ui-shared/icons';
import { PipelineTimer } from '../PipelineTimer';
import { Badge, Fact, FactList } from '@canopy/ui-shared/components';
import { pipelineStatusBadge } from '../utils';
import { KeyValueTable } from './PipelineStepDetailParts';
import { Button } from '@canopy/ui-shared/components';

/**
 * One run fact. Its value stays on one line, so a timestamp never breaks
 * mid-token: the grid gives it a column wide enough, and a text value in a
 * column narrower than itself truncates with the full text as a tooltip.
 * Element values (a status pill, a live timer, the advisor ETA and its
 * refresh control) are short and are never clipped, so a focus ring inside
 * them stays visible.
 */
function SummaryField({
  label,
  children,
}: {
  label: string;
  children: JSX.Element | string;
}): JSX.Element {
  const text = typeof children === 'string' ? children : undefined;
  return (
    <div
      className="min-w-0"
      data-testid={`pipeline-summary-field-${label.toLowerCase()}`}
    >
      <div className="truncate text-3xs font-medium fg-secondary">{label}</div>
      <div
        className={`mt-0.5 text-s fg-primary/80 ${
          text === undefined ? 'whitespace-nowrap' : 'truncate'
        }`}
        title={text}
        data-testid="pipeline-summary-field-value"
      >
        {children}
      </div>
    </div>
  );
}

/**
 * Condensed, always-visible run metadata header for the pipeline Summary view.
 * Surfaces status/timing inline and tucks lower-signal metadata (working
 * directory, hook attribution, description, event inputs) behind a "More
 * details" toggle.
 */
export function PipelineSummaryBar({
  state,
  completedSlot,
}: {
  state: ExecutionState;
  /**
   * Optional content for the "Completed" field — used to surface the advisor
   * ETA while the run is still in progress. Falls back to the completed
   * timestamp (or em dash) when not provided.
   */
  completedSlot?: JSX.Element;
}): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const eventInputs = buildEventInputs(state);
  const eventInputEntries = Object.entries(eventInputs);
  const hookTrigger =
    state.trigger_source?.kind === 'hook' ? state.trigger_source : undefined;
  const planUpdated =
    state.plan_hash_before !== undefined &&
    state.plan_hash_after !== undefined &&
    state.plan_hash_before !== state.plan_hash_after;

  return (
    <div
      // A container, so the facts reflow with the width the bar is given (a
      // narrow panel, a rail, a zoomed window), not the window's width.
      className="@container rounded-xl border bg-fg-primary/[0.02] p-4"
      data-testid="pipeline-summary-bar"
    >
      <div
        // One column, two from 20rem, four from 42rem: each column stays wide
        // enough for a full timestamp on one line.
        className="grid grid-cols-1 gap-x-4 gap-y-3 @xs:grid-cols-2 @2xl:grid-cols-4"
        data-testid="pipeline-summary-fields"
      >
        <SummaryField label="Status">
          <span className="flex flex-wrap items-center gap-1.5">
            <Badge {...pipelineStatusBadge(state.status)}>{state.status}</Badge>
            {planUpdated && <Badge tone="info">Plan updated</Badge>}
          </span>
        </SummaryField>
        <SummaryField label="Duration">
          <PipelineTimer
            identity={`summary:${state.id}`}
            kind="execution"
            status={state.status}
            startedAt={state.started_at}
            completedAt={state.completed_at}
            pausedAt={state.paused_at}
            pausedMs={state.paused_ms}
          />
        </SummaryField>
        <SummaryField label="Started">
          {formatTimingTimestamp(state.started_at)}
        </SummaryField>
        <SummaryField label="Completed">
          {completedSlot ??
            (state.completed_at
              ? formatTimingTimestamp(state.completed_at)
              : '—')}
        </SummaryField>
      </div>

      <Button
        variant="ghost"
        size="compact"
        className="mt-3"
        onClick={(): void => setExpanded((prev) => !prev)}
        aria-expanded={expanded}
        data-testid="pipeline-summary-more"
      >
        <ChevronIcon open={expanded} />
        More details
      </Button>

      {expanded && (
        <div className="mt-3 border-t pt-3">
          <FactList
            layout="stacked"
            size="s"
            rowGap="3"
            labelTone="secondary"
            dataTestId="pipeline-summary-details"
          >
            <Fact label="Trigger">{state.event_name ?? 'unknown'}</Fact>
            <Fact label="Working directory" mono>
              {state.cwd}
            </Fact>
            {hookTrigger && (
              <Fact label="Triggered by hook" fit="inline">
                <HookIcon width={13} height={13} className="fg-secondary/80" />
                <span>
                  {hookTrigger.hook_label} ·{' '}
                  {formatTimingTimestamp(hookTrigger.triggered_at)}
                </span>
              </Fact>
            )}
            {state.pipeline_snapshot.description && (
              <Fact label="Description">
                {state.pipeline_snapshot.description}
              </Fact>
            )}
            <Fact label="Workflow ID" mono>
              {state.pipeline_id}
            </Fact>
            <Fact label="Execution ID" mono>
              {state.id}
            </Fact>
            {eventInputEntries.length > 0 && (
              <Fact label="Event inputs">
                <KeyValueTable values={eventInputs} />
              </Fact>
            )}
          </FactList>
        </div>
      )}
    </div>
  );
}
