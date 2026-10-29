'use client';

import { useCallback, useSyncExternalStore, type JSX } from 'react';
import {
  PipelineStatusPopover,
  type PipelineStatusPopoverEntry,
  type WorktreePipelineStatus,
} from '@canopy/ui-shared/components';

const NO_ENTRIES: PipelineStatusPopoverEntry[] = [];

export interface SidebarPipelineStatusPopoverProps {
  readonly anchorRect: DOMRect;
  readonly worktreeLocalId: string;
  readonly workspaceLocalId: string;
  readonly status: WorktreePipelineStatus;
  readonly listId?: string;
  readonly getEntries?: (
    worktreeLocalId: string,
    workspaceLocalId: string,
  ) => PipelineStatusPopoverEntry[];
  /**
   * The host's live run source. When present, the open popover subscribes
   * and re-reads `getEntries` on each notification, so an in-flight run's
   * progress (or a new run starting) stays current while the popover is
   * open, mirroring `SidebarTerminalStatusPopover`'s `subscribeRows`. Without
   * it, `getEntries` is read once, when this popover instance mounts (CAN-3053
   * finding 6: a host with no cheap subscription source keeps the prior
   * snapshot-per-open behavior rather than a live one).
   */
  readonly subscribeEntries?: (
    worktreeLocalId: string,
    workspaceLocalId: string,
    onChange: () => void,
  ) => () => void;
  readonly onListMouseEnter?: () => void;
  readonly onListMouseLeave?: () => void;
  readonly onListFocus?: () => void;
  readonly onListBlur?: () => void;
  readonly onListDismiss?: () => void;
  readonly onScrollableListReady?: (list: HTMLDivElement) => void;
}

/**
 * A sidebar row's pipeline popover. A run's job list or status can change
 * while the row's own aggregate badge does not (another run starts while one
 * is already "running"), so a host with a live source keeps the open popover
 * current without needing the row itself to re-render.
 */
export function SidebarPipelineStatusPopover({
  subscribeEntries,
  ...props
}: SidebarPipelineStatusPopoverProps): JSX.Element {
  return subscribeEntries ? (
    <LivePipelineStatusPopover {...props} subscribeEntries={subscribeEntries} />
  ) : (
    <PipelineStatusPopover
      anchorRect={props.anchorRect}
      entries={
        props.getEntries?.(props.worktreeLocalId, props.workspaceLocalId) ??
        NO_ENTRIES
      }
      status={props.status}
      listId={props.listId}
      onListMouseEnter={props.onListMouseEnter}
      onListMouseLeave={props.onListMouseLeave}
      onListFocus={props.onListFocus}
      onListBlur={props.onListBlur}
      onListDismiss={props.onListDismiss}
      onScrollableListReady={props.onScrollableListReady}
    />
  );
}

function LivePipelineStatusPopover({
  anchorRect,
  worktreeLocalId,
  workspaceLocalId,
  status,
  listId,
  getEntries,
  subscribeEntries,
  onListMouseEnter,
  onListMouseLeave,
  onListFocus,
  onListBlur,
  onListDismiss,
  onScrollableListReady,
}: SidebarPipelineStatusPopoverProps & {
  readonly subscribeEntries: NonNullable<
    SidebarPipelineStatusPopoverProps['subscribeEntries']
  >;
}): JSX.Element {
  const subscribe = useCallback(
    (onChange: () => void): (() => void) =>
      subscribeEntries(worktreeLocalId, workspaceLocalId, onChange),
    [subscribeEntries, worktreeLocalId, workspaceLocalId],
  );
  const readEntries = useCallback(
    (): PipelineStatusPopoverEntry[] =>
      getEntries?.(worktreeLocalId, workspaceLocalId) ?? NO_ENTRIES,
    [getEntries, worktreeLocalId, workspaceLocalId],
  );
  const entries = useSyncExternalStore(subscribe, readEntries, readEntries);
  return (
    <PipelineStatusPopover
      anchorRect={anchorRect}
      entries={entries}
      status={status}
      listId={listId}
      onListMouseEnter={onListMouseEnter}
      onListMouseLeave={onListMouseLeave}
      onListFocus={onListFocus}
      onListBlur={onListBlur}
      onListDismiss={onListDismiss}
      onScrollableListReady={onScrollableListReady}
    />
  );
}
