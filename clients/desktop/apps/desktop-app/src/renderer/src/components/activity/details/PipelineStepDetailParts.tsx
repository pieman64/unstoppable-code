import { useEffect, useState, type JSX, type ReactNode } from 'react';
import {
  formatTimingTimestamp,
  type PipelineTimingKind,
  type PipelineTimingSource,
  type PipelineTimingStatus,
} from '@/lib/pipelineTiming';
import type {
  NormalizedStep,
  StepResult,
} from '@canopy/desktop-shared/types/pipeline';
import { PipelineTimer } from '../PipelineTimer';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { Disclosure, SegmentedControl } from '@canopy/ui-shared/components';

/**
 * Shared step-detail building blocks for the pipeline execution details modal.
 *
 * These were previously defined inline in the execution detail modal. They live
 * here so the new `details/` job-view components and the modal can both import
 * them without creating an import cycle back through the modal.
 */

function stringifyValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    value === null
  ) {
    return String(value);
  }
  return JSON.stringify(value);
}

export function KeyValueTable({
  values,
}: {
  values: Record<string, unknown> | undefined;
}): JSX.Element | null {
  const entries = Object.entries(values ?? {});
  if (entries.length === 0) {
    return null;
  }

  // A container, so a narrow table (a panel beside a chat, a rail) stacks
  // each value under its key instead of squeezing the value column until it
  // breaks per character. From 20rem the key and value share a row, with the
  // value column always wider than a short value.
  return (
    <div
      className="@container overflow-hidden rounded-lg border bg-base"
      data-testid="pipeline-key-value-table"
    >
      {entries.map(([key, value], index) => {
        const text = stringifyValue(value);
        return (
          <div
            key={key}
            className={`grid min-w-0 grid-cols-1 gap-x-3 gap-y-0.5 px-3 py-2 text-s @xs:grid-cols-[minmax(120px,180px)_minmax(0,1fr)] ${
              index < entries.length - 1 ? 'border-b ' : ''
            }`}
            data-testid="pipeline-key-value-row"
          >
            <div
              className="truncate font-mono text-2xs fg-secondary"
              title={key}
            >
              {key}
            </div>
            <div className="min-w-0 break-words font-mono text-2xs fg-primary/80">
              {text}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function DetailSection({
  title,
  content,
  collapsible = false,
  defaultOpen = true,
  headerAction,
}: {
  title: ReactNode;
  content: JSX.Element | null;
  collapsible?: boolean;
  defaultOpen?: boolean;
  headerAction?: ReactNode;
}): JSX.Element | null {
  const [open, setOpen] = useState(defaultOpen);
  if (!content) {
    return null;
  }

  if (!collapsible) {
    return (
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2 text-xs font-medium fg-secondary">
          <span className="min-w-0">{title}</span>
          {headerAction ? (
            <span className="flex shrink-0 items-center">{headerAction}</span>
          ) : null}
        </div>
        {content}
      </div>
    );
  }

  return (
    // The header action sits at the end of the toggle's row; the body opens
    // full width under both.
    <div className="relative">
      <Disclosure open={open} onOpenChange={setOpen} label={title}>
        {content}
      </Disclosure>
      {headerAction ? (
        <span className="absolute right-0 top-0 flex items-center text-xs font-medium fg-secondary">
          {headerAction}
        </span>
      ) : null}
    </div>
  );
}

type ShellCommandViewMode = 'resolved' | 'template';

export function ShellCommandContent({
  step,
  stepResult,
}: {
  step: NormalizedStep;
  stepResult: StepResult | undefined;
}): JSX.Element | null {
  const templateRun = step.run;
  const resolvedRun = stepResult?.resolved_run;
  const hasResolvedRun = resolvedRun !== undefined && resolvedRun.length > 0;
  const hasDistinctResolvedRun = hasResolvedRun && resolvedRun !== templateRun;
  const [viewMode, setViewMode] = useState<ShellCommandViewMode>('resolved');

  useEffect((): void => {
    setViewMode(hasDistinctResolvedRun ? 'resolved' : 'template');
  }, [hasDistinctResolvedRun, resolvedRun, templateRun]);

  if (!templateRun) {
    return null;
  }

  const effectiveViewMode = hasDistinctResolvedRun ? viewMode : 'template';
  const command =
    effectiveViewMode === 'resolved' && hasDistinctResolvedRun
      ? resolvedRun
      : templateRun;

  return (
    <div className="overflow-hidden rounded-lg border bg-base">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2">
        <div className="text-2xs font-medium fg-secondary">Shell</div>
        <div className="flex items-center gap-2">
          {hasDistinctResolvedRun && (
            <SegmentedControl
              label="Shell command source"
              shape="capsule"
              width="content"
              value={effectiveViewMode}
              onChange={setViewMode}
              options={[
                { value: 'resolved', label: 'Interpolated' },
                { value: 'template', label: 'Template' },
              ]}
            />
          )}
          <div className="font-mono text-2xs fg-secondary">{step.shell}</div>
        </div>
      </div>
      {/* Commands can carry interpolated credentials. */}
      <pre
        className={`${POSTHOG_REPLAY_BLOCK_CLASS} max-h-80 overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-2xs leading-5 fg-primary/80`}
      >
        {command}
      </pre>
    </div>
  );
}

/**
 * One timing fact. Labels and values stay on one line (a timestamp never
 * breaks mid-token); a text value in a column narrower than itself
 * truncates with the full text as a tooltip.
 */
function TimingField({
  label,
  value,
  compact = false,
}: {
  label: string;
  value: string | JSX.Element;
  compact?: boolean;
}): JSX.Element {
  const text = typeof value === 'string' ? value : undefined;
  return (
    <div className="min-w-0" data-testid="pipeline-timing-field">
      <div
        className={`truncate fg-secondary ${compact ? 'text-3xs' : 'text-xs'}`}
      >
        {label}
      </div>
      <div
        className={`mt-1 fg-primary/80 ${compact ? 'text-2xs' : 'text-s'} ${
          text === undefined ? 'whitespace-nowrap' : 'truncate'
        }`}
        title={text}
        data-testid="pipeline-timing-field-value"
      >
        {value}
      </div>
    </div>
  );
}

export function TimingSummaryGrid({
  identity,
  kind,
  status,
  startedAt,
  completedAt,
  source = 'current',
  compact = false,
}: {
  identity: string;
  kind: PipelineTimingKind;
  status: PipelineTimingStatus;
  startedAt?: string;
  completedAt?: string;
  source?: PipelineTimingSource;
  compact?: boolean;
}): JSX.Element {
  // Columns follow the width of the grid's container, not the window's: one
  // column, then two, then all three once each column fits a full timestamp
  // on one line (about 7rem compact, 9rem regular). The container is its own
  // element so the grid can query it; `flex-1` and `min-w-0` let it fill, and
  // never overflow, a row it shares with a label.
  return (
    <div className="@container min-w-0 flex-1">
      <div
        className={`grid grid-cols-1 gap-3 ${
          compact
            ? '@3xs:grid-cols-2 @sm:grid-cols-3'
            : '@xs:grid-cols-2 @lg:grid-cols-3'
        }`}
        data-testid="pipeline-timing-grid"
      >
        <TimingField
          label="Started"
          value={formatTimingTimestamp(startedAt)}
          compact={compact}
        />
        <TimingField
          label="Completed"
          value={formatTimingTimestamp(completedAt)}
          compact={compact}
        />
        <TimingField
          label="Duration"
          value={
            <PipelineTimer
              identity={`${identity}:duration`}
              kind={kind}
              status={status}
              startedAt={startedAt}
              completedAt={completedAt}
              source={source}
            />
          }
          compact={compact}
        />
      </div>
    </div>
  );
}

export function TimingSummaryCard({
  title,
  identity,
  kind,
  status,
  startedAt,
  completedAt,
  source = 'current',
}: {
  title: string;
  identity: string;
  kind: PipelineTimingKind;
  status: PipelineTimingStatus;
  startedAt?: string;
  completedAt?: string;
  source?: PipelineTimingSource;
}): JSX.Element {
  return (
    <div className="rounded-lg border bg-fg-primary/[0.03] p-3">
      <div className="mb-2 text-2xs font-medium fg-secondary">{title}</div>
      <TimingSummaryGrid
        identity={identity}
        kind={kind}
        status={status}
        startedAt={startedAt}
        completedAt={completedAt}
        source={source}
      />
    </div>
  );
}
