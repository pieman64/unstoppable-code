import type { JSX } from 'react';
import { BADGE_HOVER_CARD_SURFACE } from './ChatPreviewPopover';
import { RichHoverCard } from './RichHoverTooltip';
import type { WorktreeTerminalStatus } from './WorktreeRow';

function terminalStatusDisplayLabel(status: WorktreeTerminalStatus): string {
  switch (status) {
    case 'running':
      return 'Running';
    case 'unseen-failure':
      return 'Failed';
    case 'unseen':
      return 'Completed';
  }
}

export interface TerminalPopoverRow {
  terminalId: string;
  label: string;
  /** Status text rendered on the right of the row. */
  statusText: string;
  /** Tailwind text-* class applied to `statusText`. */
  statusClass: string;
  /** Tailwind bg-* class applied to the leading dot. */
  dotClass: string;
}

export interface TerminalStatusPopoverProps {
  anchorRect: DOMRect;
  rows: TerminalPopoverRow[];
  status: WorktreeTerminalStatus;
}

export function TerminalStatusPopover({
  anchorRect,
  rows,
  status,
}: TerminalStatusPopoverProps): JSX.Element | null {
  const statusLabel = terminalStatusDisplayLabel(status);

  return (
    <RichHoverCard
      anchorRect={anchorRect}
      dataTestId="terminal-status-popover"
      {...BADGE_HOVER_CARD_SURFACE}
      surfaceClassName="min-w-40 max-w-65"
    >
      <div className="mb-1 text-3xs font-semibold fg-secondary">
        Terminals {statusLabel}
      </div>
      {rows.length === 0 ? (
        <div className="text-xs fg-secondary">No terminal details</div>
      ) : (
        <div className="space-y-1.5">
          {rows.map((row) => (
            <div
              key={row.terminalId}
              data-testid="terminal-status-popover-row"
              data-terminal-id={row.terminalId}
            >
              <div className="flex items-center gap-1.5 text-xs">
                <span
                  className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${row.dotClass}`}
                />
                <span className="truncate fg-primary">{row.label}</span>
                <span className={`ml-auto shrink-0 ${row.statusClass}`}>
                  {row.statusText}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </RichHoverCard>
  );
}
