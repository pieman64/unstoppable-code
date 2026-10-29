import type { JSX, ReactNode } from 'react';
import { LoadingSpinner } from './LoadingSpinner';
import { OPERATIONAL_STATUS_COLORS } from '../lib/operational-status-colors';
import { REPLAY_BLOCK_CLASS } from '../lib/replay-privacy';

export type ProgressStepStatus = 'completed' | 'active' | 'pending' | 'error';

export interface ProgressChecklistStep {
  /** Stable React key for the row. */
  key: string;
  label: string;
  status: ProgressStepStatus;
  /** Hover text for the label: a detail the reader rarely needs inline. */
  title?: string;
  /**
   * The label names a person (an email address), so session replay blocks
   * it. Detail content owns its own replay classes.
   */
  privateLabel?: boolean;
  /** Content rendered under the label, indented to line up with it. */
  detail?: ReactNode;
  /** A nested checklist owned by this step, rendered under its detail. */
  substeps?: ProgressChecklistStep[];
  /** `data-testid` for the step's list item. */
  testId?: string;
  /** Extra `data-*` attributes for the step's list item, for automation. */
  dataAttributes?: Readonly<Record<`data-${string}`, string>>;
}

export type ProgressChecklistBadgeTone = 'progress' | 'success' | 'error';

export interface ProgressChecklistBadge {
  label: string;
  tone: ProgressChecklistBadgeTone;
}

export interface ProgressChecklistProps {
  steps: ProgressChecklistStep[];
  /** Optional error text rendered below the rows in a scrollable container. */
  error?: string;
  /** Optional status pill rendered above the rows. */
  badge?: ProgressChecklistBadge;
  /** Extra classes applied to the root container. */
  className?: string;
  /**
   * `'compact'` (default) suits cards and tooltips; `'comfortable'` uses body
   * text and roomier rows for a checklist that is a dialog's main content.
   */
  size?: 'compact' | 'comfortable';
}

function StepIcon({ status }: { status: ProgressStepStatus }): JSX.Element {
  if (status === 'error') {
    return (
      <span className={OPERATIONAL_STATUS_COLORS.failed.foreground}>{'✗'}</span>
    );
  }
  if (status === 'completed') {
    // The check replaces the spinner as a new element, so this entrance runs
    // exactly when a step finishes rather than on every re-render.
    return (
      <span
        className={`inline-block animate-scale-in motion-reduce:animate-none ${OPERATIONAL_STATUS_COLORS.success.foreground}`}
      >
        {'✓'}
      </span>
    );
  }
  if (status === 'active') {
    return <LoadingSpinner tone="active" />;
  }
  // pending — static hollow dot, not a spinner
  return (
    <span className="inline-flex h-2.5 w-2.5 items-center justify-center">
      <span className="h-1.5 w-1.5 rounded-full border border-fg-secondary/40" />
    </span>
  );
}

function stepLabelClass(status: ProgressStepStatus): string {
  if (status === 'error') return OPERATIONAL_STATUS_COLORS.failed.foreground;
  if (status === 'active') return 'fg-primary/80';
  if (status === 'pending') return 'fg-secondary/50';
  return 'fg-secondary';
}

function badgeClass(tone: ProgressChecklistBadgeTone): string {
  if (tone === 'error') {
    return `${OPERATIONAL_STATUS_COLORS.failed.borderSubtle} ${OPERATIONAL_STATUS_COLORS.failed.backgroundSubtle} ${OPERATIONAL_STATUS_COLORS.failed.foreground}`;
  }
  if (tone === 'success') {
    return `${OPERATIONAL_STATUS_COLORS.success.borderSubtle} ${OPERATIONAL_STATUS_COLORS.success.backgroundSubtle} ${OPERATIONAL_STATUS_COLORS.success.foreground}`;
  }
  return `${OPERATIONAL_STATUS_COLORS.active.borderMuted} ${OPERATIONAL_STATUS_COLORS.active.backgroundSubtle} ${OPERATIONAL_STATUS_COLORS.active.foreground}`;
}

function ChecklistSteps({
  steps,
  size,
}: {
  steps: ProgressChecklistStep[];
  size: 'compact' | 'comfortable';
}): JSX.Element {
  const comfortable = size === 'comfortable';
  return (
    <div role="list" className={comfortable ? 'space-y-2.5' : 'space-y-1'}>
      {steps.map((step) => (
        <div
          key={step.key}
          role="listitem"
          {...step.dataAttributes}
          data-testid={step.testId}
          data-step-status={step.status}
        >
          {/* Comfortable rows can wrap, so the icon sits on the first line. */}
          <div
            className={`flex gap-2 ${comfortable ? 'items-start text-s' : 'items-center text-xs'}`}
          >
            <span
              className={
                comfortable
                  ? 'flex h-5 flex-shrink-0 items-center'
                  : '-mt-1 flex-shrink-0'
              }
            >
              <StepIcon status={step.status} />
            </span>
            <span
              className={`${stepLabelClass(step.status)}${step.privateLabel ? ` ${REPLAY_BLOCK_CLASS}` : ''}`}
              title={step.title}
            >
              {step.label}
            </span>
          </div>
          {(step.detail || (step.substeps && step.substeps.length > 0)) && (
            // Indented past the icon column so nested content lines up with
            // the label it belongs to.
            <div className="mt-1 space-y-1 pl-4">
              {step.detail}
              {step.substeps && step.substeps.length > 0 && (
                <ChecklistSteps steps={step.substeps} size={size} />
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * Pure, display-only progress checklist. Each step renders an icon
 * (checkmark / spinner / hollow dot / cross) plus a status-colored label, and
 * may carry detail content and its own nested checklist of substeps.
 * Shared by the Pull Request activity-panel card, the status-bar git action
 * progress tooltip, and the project share dialog so they cannot visually
 * drift.
 */
export function ProgressChecklist({
  steps,
  error,
  badge,
  className,
  size = 'compact',
}: ProgressChecklistProps): JSX.Element {
  return (
    <div className={className}>
      {badge && (
        <div className="mb-2 flex items-center gap-2">
          <span
            className={`inline-flex rounded-full border px-2 py-0.5 text-3xs font-medium ${badgeClass(
              badge.tone,
            )}`}
          >
            {badge.label}
          </span>
        </div>
      )}
      <ChecklistSteps steps={steps} size={size} />
      {/* The error is raw command or provider output (paths, remotes), and
          this checklist also renders in tooltips portaled to the body, out
          of every surface block, so it carries its own replay block. */}
      {error && (
        <div className={`${REPLAY_BLOCK_CLASS} mt-1 max-h-32 overflow-auto`}>
          <p
            className={`whitespace-pre-wrap break-words text-2xs ${OPERATIONAL_STATUS_COLORS.failed.foregroundMuted}`}
          >
            {error}
          </p>
        </div>
      )}
    </div>
  );
}
