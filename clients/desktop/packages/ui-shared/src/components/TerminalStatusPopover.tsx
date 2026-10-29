import { useLayoutEffect, useRef, useState, type JSX } from 'react';
import { createPortal } from 'react-dom';
import {
  getInitialBadgePopoverPosition,
  getMeasuredBadgePopoverPosition,
} from './ChatPreviewPopover';
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
}: TerminalStatusPopoverProps): JSX.Element {
  const popoverRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number }>(
    getInitialBadgePopoverPosition(anchorRect),
  );

  useLayoutEffect((): void => {
    const el = popoverRef.current;
    if (!el) return;

    setPosition(
      getMeasuredBadgePopoverPosition(
        anchorRect,
        el.offsetHeight,
        el.offsetWidth,
      ),
    );
  }, [anchorRect]);

  const statusLabel = terminalStatusDisplayLabel(status);

  return createPortal(
    <div
      ref={popoverRef}
      className="pointer-events-none fixed z-tooltip min-w-40 max-w-65 rounded-lg bg-popover px-3 py-2 shadow-lg"
      style={{ top: position.top, left: position.left }}
      data-testid="terminal-status-popover"
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
    </div>,
    document.body,
  );
}
