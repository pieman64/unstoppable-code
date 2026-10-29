import type { JSX } from 'react';
import type { SubagentStatus } from '@canopy/agent-transcript';
import {
  CheckIcon,
  FailedIcon,
  RaisedHandIcon,
  ScheduleIcon,
  SnoozeIcon,
  StopIcon,
} from '../../../../icons/AppIcons';
import { OPERATIONAL_STATUS_COLORS } from '../../../../lib/operational-status-colors';
import { ThinkingSpinner } from '../../../ThinkingSpinner';

const STATUS_INK: Readonly<Record<SubagentStatus, string>> = {
  running: OPERATIONAL_STATUS_COLORS.active.foreground,
  starting: OPERATIONAL_STATUS_COLORS.active.foreground,
  queued: OPERATIONAL_STATUS_COLORS.paused.foreground,
  approval: 'fg-warning',
  idle: 'fg-tertiary',
  completed: OPERATIONAL_STATUS_COLORS.success.foreground,
  interrupted: 'fg-tertiary',
  failed: OPERATIONAL_STATUS_COLORS.failed.foreground,
  cancelled: 'fg-tertiary',
  'stopped-by-parent': 'fg-tertiary',
};

/** The text color class for a status, paired with its label. */
export function subagentStatusInk(status: SubagentStatus): string {
  return STATUS_INK[status];
}

export interface SubagentStatusGlyphProps {
  readonly status: SubagentStatus;
  /** Glyph size in pixels. Defaults to 12. */
  readonly size?: number;
}

/**
 * One glyph per status, always paired with the status label where space
 * allows. The spinner is reserved for work that is actually running.
 */
export function SubagentStatusGlyph({
  status,
  size = 12,
}: SubagentStatusGlyphProps): JSX.Element {
  if (status === 'running' || status === 'starting') {
    return (
      <span
        className="inline-flex shrink-0 items-center justify-center"
        data-status={status}
      >
        <ThinkingSpinner sizePx={size} tone="active" />
      </span>
    );
  }
  const glyph =
    status === 'queued' ? (
      <ScheduleIcon size={size} aria-hidden />
    ) : status === 'approval' ? (
      <RaisedHandIcon size={size} aria-hidden />
    ) : status === 'completed' ? (
      <CheckIcon size={size} aria-hidden />
    ) : status === 'failed' ? (
      <FailedIcon size={size} aria-hidden />
    ) : status === 'idle' ? (
      <SnoozeIcon size={size} aria-hidden />
    ) : (
      <StopIcon size={size} aria-hidden />
    );
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center ${STATUS_INK[status]}`}
      data-status={status}
    >
      {glyph}
    </span>
  );
}
