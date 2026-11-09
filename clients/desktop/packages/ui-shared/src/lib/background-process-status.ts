import type { BadgeTone } from './badge';
import { OPERATIONAL_STATUS_COLORS } from './operational-status-colors';

/**
 * Neutral mirror of the desktop `BackgroundProcessStatus` union so shared
 * display code never imports `@canopy/desktop-shared`. Desktop's union must
 * stay assignable to this one.
 */
export type BackgroundProcessDisplayStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'stopped';

/** Badge classes for a background-process status chip. */
export function getBackgroundProcessStatusClassName(
  status: BackgroundProcessDisplayStatus,
): string {
  switch (status) {
    case 'completed':
      return `${OPERATIONAL_STATUS_COLORS.success.backgroundBadge} ${OPERATIONAL_STATUS_COLORS.success.foreground}`;
    case 'running':
      return `${OPERATIONAL_STATUS_COLORS.active.backgroundBadge} ${OPERATIONAL_STATUS_COLORS.active.foreground}`;
    case 'failed':
      return `${OPERATIONAL_STATUS_COLORS.failed.backgroundBadge} ${OPERATIONAL_STATUS_COLORS.failed.foreground}`;
    case 'stopped':
      return `${OPERATIONAL_STATUS_COLORS.paused.backgroundBadge} ${OPERATIONAL_STATUS_COLORS.paused.foreground}`;
    default:
      return `${OPERATIONAL_STATUS_COLORS.paused.backgroundSubtle} ${OPERATIONAL_STATUS_COLORS.paused.foregroundMuted}`;
  }
}

/** Badge tone for a background-process status. */
export function backgroundProcessStatusBadgeTone(
  status: BackgroundProcessDisplayStatus,
): BadgeTone {
  switch (status) {
    case 'completed':
      return 'success';
    case 'running':
      return 'info';
    case 'failed':
      return 'danger';
    default:
      return 'neutral';
  }
}

/** Whether a background-process status is terminal ("stopped" group). */
export function isTerminalBackgroundProcessStatus(
  status: BackgroundProcessDisplayStatus,
): boolean {
  return status === 'completed' || status === 'failed' || status === 'stopped';
}
