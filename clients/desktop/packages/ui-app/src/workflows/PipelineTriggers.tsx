'use client';

import type { JSX, ReactNode } from 'react';
import { REMOTE_CONTROL_LABEL } from '@canopy/protocol';
import { Button } from '@canopy/ui-shared/components';
import { ChevronRightIcon } from '@canopy/ui-shared/icons';
import { REPLAY_MASK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import {
  WORKFLOW_TRIGGER_LABELS,
  type WorkflowTriggerKind,
} from './workflow-library-model';

/** A trigger a pipeline declares itself, in the Library's vocabulary. */
export type PipelineStartKind = Extract<
  WorkflowTriggerKind,
  'manual' | 'plan-approved' | 'task-ready'
>;

export const PIPELINE_START_KINDS: readonly PipelineStartKind[] = [
  'manual',
  'plan-approved',
  'task-ready',
];

const PIPELINE_START_DESCRIPTIONS: Readonly<Record<PipelineStartKind, string>> =
  {
    manual: `Run, App Advisor or ${REMOTE_CONTROL_LABEL}`,
    'plan-approved': 'From an approved plan',
    'task-ready': 'From a new task in pipeline mode',
  };

/** A hook that runs the pipeline. */
export interface PipelineTriggerHookRow {
  readonly key: string;
  /** The hook's event, as `PR Checks Finished`. */
  readonly eventLabel: string;
  /** The project, and the repository in a multi-repo project. */
  readonly where: string;
}

/** An automation that runs the pipeline. */
export interface PipelineTriggerAutomationRow {
  readonly key: string;
  readonly name: string;
  readonly scheduleText: string;
  readonly enabled: boolean;
}

export interface PipelineTriggersProps {
  /** The triggers the pipeline declares. */
  readonly starts: readonly PipelineStartKind[];
  readonly hooks: readonly PipelineTriggerHookRow[];
  readonly automations: readonly PipelineTriggerAutomationRow[];
  readonly onOpenHook: (row: PipelineTriggerHookRow) => void;
  readonly onOpenAutomation: (row: PipelineTriggerAutomationRow) => void;
  /** Opens where the declared triggers are edited; absent when read-only. */
  readonly onEditStarts?: () => void;
}

function Section({
  id,
  title,
  action,
  children,
}: {
  readonly id: string;
  readonly title: string;
  readonly action?: ReactNode;
  readonly children: ReactNode;
}): JSX.Element {
  const headingId = `pipeline-trigger-${id}-heading`;
  return (
    <section className="flex flex-col gap-2" aria-labelledby={headingId}>
      <div className="flex min-h-7 items-center gap-2">
        <h2 id={headingId} className="text-s font-medium fg-primary">
          {title}
        </h2>
        {action ? <div className="ml-auto">{action}</div> : null}
      </div>
      {children}
    </section>
  );
}

function EmptyRow({
  testId,
  children,
}: {
  readonly testId: string;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <p
      className="rounded-lg border px-4 py-3 text-s fg-tertiary"
      data-testid={testId}
    >
      {children}
    </p>
  );
}

function RowButton({
  onClick,
  children,
  ...data
}: {
  readonly onClick: () => void;
  readonly children: ReactNode;
  readonly [dataAttribute: `data-${string}`]: string;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className="focus-ring flex w-full items-center gap-4 px-4 py-3 text-left text-s transition-colors hover:bg-secondary"
      {...data}
    >
      {children}
      <ChevronRightIcon
        width={14}
        height={14}
        aria-hidden="true"
        className="shrink-0 fg-tertiary"
      />
    </button>
  );
}

/**
 * A pipeline's Trigger section (CAN-4072): everything that can start it. The
 * triggers it declares come first; hooks and automations start it through
 * its Manual trigger, so without one they say so instead of reading as
 * simply unused.
 */
export function PipelineTriggers({
  starts,
  hooks,
  automations,
  onOpenHook,
  onOpenAutomation,
  onEditStarts,
}: PipelineTriggersProps): JSX.Element {
  const manual = starts.includes('manual');
  return (
    <div className="flex flex-col gap-6" data-testid="pipeline-triggers">
      <Section
        id="starts"
        title="Starts from"
        action={
          onEditStarts ? (
            <Button
              variant="ghost"
              size="control"
              onClick={onEditStarts}
              data-testid="pipeline-trigger-edit-starts"
            >
              Edit
            </Button>
          ) : undefined
        }
      >
        <ul
          className="divide-y rounded-lg border"
          data-testid="pipeline-trigger-starts"
        >
          {PIPELINE_START_KINDS.map((kind) => {
            const on = starts.includes(kind);
            return (
              <li
                key={kind}
                className="flex items-center gap-4 px-4 py-3 text-s"
                data-testid="pipeline-trigger-start"
                data-trigger={kind}
                data-on={String(on)}
              >
                <span
                  className={`w-32 shrink-0 ${on ? 'fg-primary' : 'fg-tertiary'}`}
                >
                  {WORKFLOW_TRIGGER_LABELS[kind]}
                </span>
                <span className="min-w-0 flex-1 truncate fg-secondary">
                  {PIPELINE_START_DESCRIPTIONS[kind]}
                </span>
                <span
                  className={`w-10 shrink-0 text-xs ${on ? 'fg-secondary' : 'fg-tertiary'}`}
                >
                  {on ? 'On' : 'Off'}
                </span>
                {/* Lines On and Off up with the rows below, which end in a chevron. */}
                <span className="w-3.5 shrink-0" aria-hidden="true" />
              </li>
            );
          })}
        </ul>
      </Section>

      <Section id="hooks" title="Hooks">
        {hooks.length === 0 ? (
          <EmptyRow testId="pipeline-trigger-hooks-empty">
            {manual
              ? 'No hooks run this pipeline.'
              : 'Hooks only run pipelines with a Manual trigger.'}
          </EmptyRow>
        ) : (
          <ul
            className="divide-y rounded-lg border"
            data-testid="pipeline-trigger-hooks"
          >
            {hooks.map((row) => (
              <li key={row.key}>
                <RowButton
                  onClick={(): void => onOpenHook(row)}
                  data-testid="pipeline-trigger-hook"
                  data-hook-key={row.key}
                >
                  <span className="min-w-0 flex-1 truncate fg-primary">
                    {row.eventLabel}
                  </span>
                  <span
                    className={`min-w-0 flex-1 truncate fg-secondary ${REPLAY_MASK_CLASS}`}
                  >
                    {row.where}
                  </span>
                </RowButton>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section id="automations" title="Automations">
        {automations.length === 0 ? (
          <EmptyRow testId="pipeline-trigger-automations-empty">
            {manual
              ? 'No automations run this pipeline.'
              : 'Automations only run pipelines with a Manual trigger.'}
          </EmptyRow>
        ) : (
          <ul
            className="divide-y rounded-lg border"
            data-testid="pipeline-trigger-automations"
          >
            {automations.map((row) => (
              <li key={row.key}>
                <RowButton
                  onClick={(): void => onOpenAutomation(row)}
                  data-testid="pipeline-trigger-automation"
                  data-activity-id={row.key}
                >
                  <span
                    className={`min-w-0 flex-1 truncate fg-primary ${REPLAY_MASK_CLASS}`}
                  >
                    {row.name}
                  </span>
                  <span className="min-w-0 flex-1 truncate fg-secondary">
                    {row.scheduleText}
                  </span>
                  <span className="w-10 shrink-0 text-xs fg-secondary">
                    {row.enabled ? 'On' : 'Off'}
                  </span>
                </RowButton>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}
