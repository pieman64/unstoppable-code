import type { JSX } from 'react';
import { CAPSULE_TOUCH_FLOOR_CLASS } from '@canopy/ui-shared';
import {
  CloseMediumIcon,
  ScheduleIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import { RichHoverTooltip } from '@/components/shared/RichHoverTooltip';
import {
  formatScheduledSendCompactLabel,
  formatScheduledSendFullLabel,
  formatScheduledSendLabel,
} from '@/lib/scheduledSendLabel';

export interface ScheduledSendChipProps {
  /** When the draft is due (ISO). */
  readonly runAt: string;
  /** Why the last attempt to schedule it failed, if it did. */
  readonly error: string | null;
  /** The chat's harness can schedule; otherwise the chip only clears. */
  readonly editable: boolean;
  /**
   * A narrow box: the time alone today or tomorrow, else the day, and a
   * failure as the glyph alone. The tooltip keeps the full moment.
   */
  readonly compact?: boolean;
  readonly onEdit: () => void;
  readonly onClear: () => void;
  /** For tests and galleries; defaults to the current time. */
  readonly now?: Date;
}

/**
 * The scheduled send beside +, in the Plan chip's shape: the time it goes
 * out (click to change it) and a clear. A failed attempt turns the chip red
 * and names the problem, with the reason in its tooltip, so the box never
 * grows a line for it.
 */
export function ScheduledSendChip({
  runAt,
  error,
  editable,
  compact = false,
  onEdit,
  onClear,
  now,
}: ScheduledSendChipProps): JSX.Element {
  const date = new Date(runAt);
  const tone =
    error === null
      ? 'bg-info-subtle fg-info'
      : 'bg-destructive-subtle fg-destructive';
  const tooltip =
    error ??
    (editable
      ? `Sends ${formatScheduledSendFullLabel(date)}. Click to change.`
      : 'Clear this schedule to send with Cursor');
  return (
    <span
      data-testid="chat-input-scheduled-send-chip"
      data-scheduled-send-state={error === null ? 'scheduled' : 'failed'}
      className={`flex h-8 shrink-0 items-center rounded-full text-xs ${tone}`}
    >
      <RichHoverTooltip
        surfaceClassName="w-max max-w-72"
        surfacePadding="relaxed"
        content={<span className="text-xs fg-primary">{tooltip}</span>}
      >
        <button
          type="button"
          onClick={onEdit}
          disabled={!editable}
          data-testid="chat-input-scheduled-send-pill"
          aria-label={
            error === null
              ? `Scheduled send, ${formatScheduledSendFullLabel(date)}`
              : `Scheduled send failed: ${error}`
          }
          className={`focus-ring flex h-8 items-center gap-1.5 rounded-full pl-2.5 pr-1 whitespace-nowrap disabled:cursor-default ${CAPSULE_TOUCH_FLOOR_CLASS}`}
        >
          <ScheduleIcon width={16} height={16} className="shrink-0" />
          {error !== null
            ? compact
              ? null
              : "Couldn't schedule"
            : compact
              ? formatScheduledSendCompactLabel(date, now)
              : formatScheduledSendLabel(date, now)}
        </button>
      </RichHoverTooltip>
      <button
        type="button"
        onClick={onClear}
        aria-label="Clear scheduled send"
        data-testid="chat-input-scheduled-send-clear"
        className="focus-ring flex h-8 items-center rounded-full pl-1 pr-2.5"
      >
        <CloseMediumIcon width={12} height={12} aria-hidden />
      </button>
    </span>
  );
}
