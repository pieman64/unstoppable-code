'use client';

import { useCallback, useSyncExternalStore, type JSX } from 'react';
import {
  TerminalStatusPopover,
  type TerminalPopoverRow,
  type WorktreeTerminalStatus,
} from '@canopy/ui-shared/components';

const NO_ROWS: TerminalPopoverRow[] = [];

export interface SidebarTerminalStatusPopoverProps {
  readonly anchorRect: DOMRect;
  readonly worktreeLocalId: string;
  readonly status: WorktreeTerminalStatus;
  /** Lets the badge that opened it name it in `aria-describedby`. */
  readonly id?: string;
  readonly getRows?: (worktreeLocalId: string) => TerminalPopoverRow[];
  /**
   * The host's live row source. When present, the open popover subscribes and
   * re-reads `getRows` on each notification, so `getRows` must return the
   * same array until the rows change.
   */
  readonly subscribeRows?: (
    worktreeLocalId: string,
    onChange: () => void,
  ) => () => void;
}

/**
 * A sidebar row's terminal popover. Its rows can change while the row's
 * aggregate status does not (another command starts, a terminal is renamed),
 * so a host with a live source keeps the open popover current without
 * re-rendering the sidebar.
 */
export function SidebarTerminalStatusPopover({
  subscribeRows,
  ...props
}: SidebarTerminalStatusPopoverProps): JSX.Element {
  return subscribeRows ? (
    <LiveTerminalStatusPopover {...props} subscribeRows={subscribeRows} />
  ) : (
    <TerminalStatusPopover
      anchorRect={props.anchorRect}
      rows={props.getRows?.(props.worktreeLocalId) ?? NO_ROWS}
      status={props.status}
      id={props.id}
    />
  );
}

function LiveTerminalStatusPopover({
  anchorRect,
  worktreeLocalId,
  status,
  getRows,
  subscribeRows,
  id,
}: SidebarTerminalStatusPopoverProps & {
  readonly subscribeRows: NonNullable<
    SidebarTerminalStatusPopoverProps['subscribeRows']
  >;
}): JSX.Element {
  const subscribe = useCallback(
    (onChange: () => void): (() => void) =>
      subscribeRows(worktreeLocalId, onChange),
    [subscribeRows, worktreeLocalId],
  );
  const readRows = useCallback(
    (): TerminalPopoverRow[] => getRows?.(worktreeLocalId) ?? NO_ROWS,
    [getRows, worktreeLocalId],
  );
  const rows = useSyncExternalStore(subscribe, readRows, readRows);
  return (
    <TerminalStatusPopover
      anchorRect={anchorRect}
      rows={rows}
      status={status}
      id={id}
    />
  );
}
