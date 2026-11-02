import type { JSX, ReactNode } from 'react';
import { Button } from './Button';

export interface RunningProcessCardProps {
  dataTestId?: string;
  stopDataTestId?: string;
  /** Inline content rendered next to the spinner — typically a running
   * label like "Running script…". */
  statusContent: ReactNode;
  /** Stop-button caption. */
  stopLabel: ReactNode;
  /** When true the stop button is disabled. */
  stopDisabled?: boolean;
  /** Spinner glyph rendered to the left of the status content. The shared
   * package intentionally does not own a long-loading spinner, so callers
   * supply their preferred indicator. */
  spinner: ReactNode;
  /** Optional left-aligned enlarge / expand button rendered before the
   * spinner. */
  enlargeButton?: ReactNode;
  /** Optional action rendered before the Stop button. */
  actionSlot?: ReactNode;
  /** Optional body rendered below the header row — typically streaming
   * output. */
  body?: ReactNode;
  onStop?: () => void;
}

/**
 * Sky-tinted live-output chrome shared by Hooks, Scripts, and any future
 * "running command" surface. Pure display: caller supplies the spinner, the
 * body, and the stop dispatch.
 */
export function RunningProcessCard({
  dataTestId,
  stopDataTestId,
  statusContent,
  stopLabel,
  stopDisabled = false,
  spinner,
  enlargeButton,
  actionSlot,
  body,
  onStop,
}: RunningProcessCardProps): JSX.Element {
  return (
    <div
      className="rounded-lg border border-fg-info/20 bg-fg-info/[0.06] p-2 text-xs"
      data-testid={dataTestId}
    >
      <div className="mb-1.5 flex items-center justify-between">
        <div className="flex items-center gap-2 fg-info">
          {enlargeButton}
          {spinner}
          <span>{statusContent}</span>
        </div>
        <div className="flex items-center gap-2">
          {actionSlot}
          {onStop && (
            <Button
              variant="ghost-destructive"
              size="compact"
              onClick={onStop}
              disabled={stopDisabled}
              data-testid={stopDataTestId}
            >
              {stopLabel}
            </Button>
          )}
        </div>
      </div>
      {body}
    </div>
  );
}
