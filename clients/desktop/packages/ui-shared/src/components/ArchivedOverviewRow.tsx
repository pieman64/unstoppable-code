'use client';

import type { JSX, ReactNode } from 'react';
import { ArchivedStateIcon } from '../icons/ArchivedStateIcon';
import { LoadingSpinner } from './LoadingSpinner';
import { RichHoverTooltip } from './RichHoverTooltip';
import {
  getArchivedContainerStateLabel,
  type ArchivedContainerState,
} from '../lib/archived-state';
import { REPLAY_MASK_CLASS } from '../lib/replay-privacy';

/**
 * Container-query root for an "Archived and deleted" list. Rows inside it
 * keep their ⋯ menu always visible once the list is at least 36rem wide and
 * fall back to hover/focus reveal (always visible on touch) below that.
 */
export const ARCHIVED_LIST_CONTAINER_CLASS_NAME = '@container/archived-list';

// Literal class strings on purpose: Tailwind's scanner only sees classes it
// can read verbatim from source, so these must not be built from a template.
export const ARCHIVED_ROW_ACTIONS_VISIBLE_WIDE =
  '@min-[36rem]/archived-list:pointer-events-auto @min-[36rem]/archived-list:opacity-100';
export const ARCHIVED_ROW_ACTIONS_RESERVE_WIDE =
  '@min-[36rem]/archived-list:pr-8';

export interface ArchivedOverviewRowProps {
  state: ArchivedContainerState;
  title: string;
  /** Native tooltip on the title; defaults to the title itself. */
  titleTooltip?: string;
  /** Rich tooltip content for the state icon (label plus retention rule). */
  stateTooltip: ReactNode;
  stateTooltipTestId?: string;
  stateTestId?: string;
  /** A lifecycle request is in flight: a spinner stands in for the icon. */
  busy?: boolean;
  /** Host-specific indicators rendered between the title and the date. */
  trailing?: ReactNode;
  /**
   * The entry's sealed observed cost, already formatted by a host that has
   * cost (this row imports no cost code). Absent shows nothing.
   */
  observedCostLabel?: string;
  date: string;
  dateTooltip?: string;
  /** When set, the row body is a button that opens the item. */
  onOpen?: () => void;
  openTestId?: string;
  /** The row's action controls, usually `ArchivedRowActionsMenu`. */
  actions: ReactNode;
  testId?: string;
}

export interface OverviewListRowProps {
  /** The row's leading glyph, before the title. */
  leading: ReactNode;
  title: string;
  /** Native tooltip on the title; defaults to the title itself. */
  titleTooltip?: string;
  /** Indicators rendered between the title and the date. */
  trailing?: ReactNode;
  date: string;
  dateTooltip?: string;
  /** When set, the row body is a button that opens the item. */
  onOpen?: () => void;
  openTestId?: string;
  /** The row's action controls, in the absolutely positioned trailing slot. */
  actions: ReactNode;
  /**
   * `reveal` (default) reserves room for a hover-revealed ⋯ menu. `inline`
   * always reserves room for a labeled button, which stays visible.
   */
  actionsReserve?: 'reveal' | 'inline';
  testId?: string;
  /** Mirrored to `data-state` on the row. */
  state?: string;
  busy?: boolean;
}

const OVERVIEW_ROW_BODY_BASE_CLASS_NAME =
  'flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors';

/**
 * Layout shell for one row of an overview list: leading glyph, truncated
 * title, optional indicators, a date, and an absolutely positioned action
 * slot. The body reserves room for that slot on hover, focus, wide
 * containers, and touch layouts (where the trigger is always visible and
 * grows to a 44px target).
 */
export function OverviewListRow({
  leading,
  title,
  titleTooltip,
  trailing,
  date,
  dateTooltip,
  onOpen,
  openTestId,
  actions,
  actionsReserve = 'reveal',
  testId,
  state,
  busy = false,
}: OverviewListRowProps): JSX.Element {
  const bodyClassName =
    actionsReserve === 'reveal'
      ? `${OVERVIEW_ROW_BODY_BASE_CLASS_NAME} group-hover:pr-8 group-focus-within:pr-8 pointer-coarse:pr-12 ${ARCHIVED_ROW_ACTIONS_RESERVE_WIDE}`
      : `${OVERVIEW_ROW_BODY_BASE_CLASS_NAME} pr-24`;
  const body = (
    <>
      {leading}
      <span
        className={`${REPLAY_MASK_CLASS} min-w-0 flex-1 truncate text-xs leading-snug fg-primary/75`}
        title={titleTooltip ?? title}
      >
        {title}
      </span>
      {trailing}
      <span
        className="shrink-0 text-2xs tabular-nums fg-secondary"
        title={dateTooltip}
      >
        {date}
      </span>
    </>
  );
  return (
    <div
      className="group relative flex w-full items-center rounded-md transition-colors hover:bg-fg-primary/[0.04] pointer-coarse:min-h-11"
      data-testid={testId}
      data-state={state}
      aria-busy={busy ? 'true' : undefined}
    >
      {onOpen ? (
        <button
          type="button"
          data-testid={openTestId}
          onClick={onOpen}
          className={`focus-ring ${bodyClassName}`}
        >
          {body}
        </button>
      ) : (
        <div className={bodyClassName}>{body}</div>
      )}
      <span className="absolute inset-y-0 right-1 flex items-center">
        {actions}
      </span>
    </div>
  );
}

/**
 * One retained item in an "Archived and deleted" overview, shared by the
 * desktop and web surfaces: state icon with its retention tooltip, truncated
 * title, optional host indicators, the state date, and the action slot, on
 * the {@link OverviewListRow} shell.
 */
export function ArchivedOverviewRow({
  state,
  title,
  titleTooltip,
  stateTooltip,
  stateTooltipTestId,
  stateTestId,
  busy = false,
  trailing,
  observedCostLabel,
  date,
  dateTooltip,
  onOpen,
  openTestId,
  actions,
  testId,
}: ArchivedOverviewRowProps): JSX.Element {
  const stateLabel = getArchivedContainerStateLabel(state);
  return (
    <OverviewListRow
      leading={
        busy ? (
          <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
            <LoadingSpinner tone="secondary" decorative />
          </span>
        ) : (
          <RichHoverTooltip
            dataTestId={stateTooltipTestId}
            surfaceClassName="min-w-55 max-w-80"
            surfacePadding="card"
            content={stateTooltip}
          >
            <span
              data-testid={stateTestId}
              data-state={state}
              aria-label={stateLabel}
              role="img"
              className="flex shrink-0 items-center"
            >
              <ArchivedStateIcon state={state} />
            </span>
          </RichHoverTooltip>
        )
      }
      title={title}
      titleTooltip={titleTooltip}
      trailing={
        <>
          {observedCostLabel !== undefined ? (
            <span
              data-testid="archived-overview-row-cost"
              className="shrink-0 text-2xs tabular-nums fg-secondary"
            >
              <span className="sr-only">Observed cost </span>
              {observedCostLabel}
            </span>
          ) : null}
          {trailing}
        </>
      }
      date={date}
      dateTooltip={dateTooltip}
      onOpen={onOpen}
      openTestId={openTestId}
      actions={actions}
      testId={testId}
      state={state}
      busy={busy}
    />
  );
}
