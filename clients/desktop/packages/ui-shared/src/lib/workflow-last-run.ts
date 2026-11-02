import type { StatusGlyphState } from './status-glyph';

/**
 * A workflow's last run, shared by the Workflows Library and the Customize
 * Workflows rows (CAN-4845) so both read it the same way.
 */
export type WorkflowLastRunState =
  | 'success'
  | 'failure'
  | 'running'
  | 'skipped'
  | 'canceled';

export interface WorkflowLastRun {
  readonly state: WorkflowLastRunState;
  /** Epoch milliseconds. */
  readonly at?: number;
  /** Human-readable failure detail when the host already has it. */
  readonly errorMessage?: string;
}

export const WORKFLOW_LAST_RUN_LABELS: Readonly<
  Record<WorkflowLastRunState, string>
> = {
  success: 'Succeeded',
  failure: 'Failed',
  running: 'Running',
  skipped: 'Skipped',
  canceled: 'Canceled',
};

/** The last run's mark: the shared status glyph for its state. */
export const WORKFLOW_LAST_RUN_GLYPHS: Readonly<
  Record<WorkflowLastRunState, StatusGlyphState>
> = {
  success: 'done',
  failure: 'failed',
  running: 'running',
  skipped: 'cancelled',
  canceled: 'cancelled',
};

export const WORKFLOW_NOT_RUN_YET = 'Not run yet';
