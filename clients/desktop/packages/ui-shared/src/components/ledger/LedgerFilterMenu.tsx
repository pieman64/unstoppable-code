'use client';

import { useRef, useState, type JSX, type ReactNode } from 'react';
import type {
  LedgerEntryType,
  LedgerStatus,
} from '@canopy/protocol/canopy-core';
import type {
  LedgerFeedFilters,
  LedgerFeedPeriod,
  LedgerViewFilters,
} from '@canopy/protocol/ledger-view';
import { FilterIcon } from '../../icons/AppIcons';
import {
  LEDGER_ENTRY_TYPE_LABELS,
  LEDGER_STATUS_LABELS,
} from '../../lib/ledger-display';
import { SIDEBAR_INDICATOR_BLUE } from '../../lib/operational-status-colors';
import {
  FloatingPickerMenu,
  PickerMenuOption,
  PickerMenuOptionCheck,
  PickerMenuOptionContent,
  PickerMenuOptionLabel,
  PickerMenuOptionLeading,
  PickerMenuSection,
  PickerMenuSectionLabel,
} from '../PickerMenu';
import { RailIconButton } from '../RailIconButton';
import { LedgerEntryTypeIcon } from './LedgerEntryTypeLabel';

const TYPE_OPTIONS: readonly LedgerEntryType[] = [
  'TASK',
  'ACTION',
  'DECISION',
  'OBSERVATION',
  'SUMMARY',
];

/** Open statuses first: they are the ones someone acts on. */
const STATUS_OPTIONS: readonly LedgerStatus[] = [
  'TODO',
  'IN_PROGRESS',
  'BLOCKED',
  'NEEDS_REVIEW',
  'COMPLETED',
  'FAILED',
  'INFO',
];

export function isLedgerViewFiltered(filters: LedgerViewFilters): boolean {
  return (
    filters.types.length > 0 ||
    filters.statuses.length > 0 ||
    filters.owner !== 'anyone'
  );
}

function toggled<Value>(values: readonly Value[], value: Value): Value[] {
  return values.includes(value)
    ? values.filter((candidate) => candidate !== value)
    : [...values, value];
}

export interface LedgerFilterMenuProps<Filters extends LedgerViewFilters> {
  filters: Filters;
  onChange: (filters: Filters) => void;
  /** Whether a filter is on; the panel's filters decide by default. */
  active?: boolean;
  /** Sections after Owner, for a view with more filters. */
  children?: ReactNode;
}

/**
 * The Ledger's filter control: entry types, statuses and owner, as checkbox
 * rows that stay open while the person picks. A dot on the trigger shows a
 * filter is on.
 */
export function LedgerFilterMenu<Filters extends LedgerViewFilters>({
  filters,
  onChange,
  active = isLedgerViewFiltered(filters),
  children,
}: LedgerFilterMenuProps<Filters>): JSX.Element {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  // Opening focuses the first option, not the first checked one ("Anyone"
  // under Owner), so the menu starts at the top and reads in order.
  const firstOptionRef = useRef<HTMLButtonElement>(null);
  return (
    <div className="relative shrink-0">
      <RailIconButton
        ref={triggerRef}
        icon={FilterIcon}
        iconSize={16}
        onClick={(event) => {
          event.stopPropagation();
          setOpen((previous) => !previous);
        }}
        aria-label="Filter entries"
        aria-expanded={open}
        aria-haspopup="true"
        title="Filter entries"
        data-testid="ledger-filter-trigger"
        data-active={active ? 'true' : 'false'}
        hoverSurface
      />
      {active && (
        <span
          aria-hidden="true"
          data-testid="ledger-filter-active-dot"
          className={`pointer-events-none absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full ${SIDEBAR_INDICATOR_BLUE.background}`}
        />
      )}
      <FloatingPickerMenu
        open={open}
        onOpenChange={setOpen}
        anchorRef={triggerRef}
        placement="bottom-left"
        heightLimit={360}
        interaction="menu"
        closeOnSelect={false}
        initialFocusRef={firstOptionRef}
        data-testid="ledger-filter-menu"
      >
        <PickerMenuSectionLabel>Type</PickerMenuSectionLabel>
        {TYPE_OPTIONS.map((type, index) => {
          const checked = filters.types.includes(type);
          return (
            <PickerMenuOption
              key={type}
              ref={index === 0 ? firstOptionRef : undefined}
              role="menuitemcheckbox"
              aria-checked={checked}
              selected={checked}
              data-testid={`ledger-filter-type-${type.toLowerCase()}`}
              onClick={() =>
                onChange({ ...filters, types: toggled(filters.types, type) })
              }
            >
              <PickerMenuOptionCheck selected={checked} reserveSpace />
              <PickerMenuOptionLeading tone="secondary">
                <LedgerEntryTypeIcon type={type} />
              </PickerMenuOptionLeading>
              <PickerMenuOptionContent>
                <PickerMenuOptionLabel>
                  {LEDGER_ENTRY_TYPE_LABELS[type]}
                </PickerMenuOptionLabel>
              </PickerMenuOptionContent>
            </PickerMenuOption>
          );
        })}
        <PickerMenuSection>
          <PickerMenuSectionLabel>Status</PickerMenuSectionLabel>
          {STATUS_OPTIONS.map((status) => {
            const checked = filters.statuses.includes(status);
            return (
              <PickerMenuOption
                key={status}
                role="menuitemcheckbox"
                aria-checked={checked}
                selected={checked}
                data-testid={`ledger-filter-status-${status.toLowerCase()}`}
                onClick={() =>
                  onChange({
                    ...filters,
                    statuses: toggled(filters.statuses, status),
                  })
                }
              >
                <PickerMenuOptionCheck selected={checked} reserveSpace />
                <PickerMenuOptionContent>
                  <PickerMenuOptionLabel>
                    {LEDGER_STATUS_LABELS[status]}
                  </PickerMenuOptionLabel>
                </PickerMenuOptionContent>
              </PickerMenuOption>
            );
          })}
        </PickerMenuSection>
        <PickerMenuSection>
          <PickerMenuSectionLabel>Owner</PickerMenuSectionLabel>
          {(['anyone', 'you'] as const).map((owner) => {
            const checked = filters.owner === owner;
            return (
              <PickerMenuOption
                key={owner}
                role="menuitemradio"
                aria-checked={checked}
                selected={checked}
                data-testid={`ledger-filter-owner-${owner}`}
                onClick={() => onChange({ ...filters, owner })}
              >
                <PickerMenuOptionCheck selected={checked} reserveSpace />
                <PickerMenuOptionContent>
                  <PickerMenuOptionLabel>
                    {owner === 'anyone' ? 'Anyone' : 'You'}
                  </PickerMenuOptionLabel>
                </PickerMenuOptionContent>
              </PickerMenuOption>
            );
          })}
        </PickerMenuSection>
        {children}
      </FloatingPickerMenu>
    </div>
  );
}

const PERIOD_OPTIONS: ReadonlyArray<{
  readonly period: LedgerFeedPeriod;
  readonly label: string;
}> = [
  { period: 'any', label: 'Any time' },
  { period: 'day', label: 'Past day' },
  { period: 'week', label: 'Past week' },
  { period: 'month', label: 'Past month' },
];

export function isLedgerFeedFiltered(filters: LedgerFeedFilters): boolean {
  return (
    isLedgerViewFiltered(filters) ||
    filters.author !== 'anyone' ||
    filters.period !== 'any' ||
    filters.includeArchived
  );
}

export interface LedgerFeedFilterMenuProps {
  filters: LedgerFeedFilters;
  onChange: (filters: LedgerFeedFilters) => void;
}

/**
 * The Feed's filter control: the Ledger's, plus who added an entry, when it
 * last changed, and whether archived work shows.
 */
export function LedgerFeedFilterMenu({
  filters,
  onChange,
}: LedgerFeedFilterMenuProps): JSX.Element {
  return (
    <LedgerFilterMenu
      filters={filters}
      onChange={onChange}
      active={isLedgerFeedFiltered(filters)}
    >
      <PickerMenuSection>
        <PickerMenuSectionLabel>Added by</PickerMenuSectionLabel>
        {(['anyone', 'you'] as const).map((author) => {
          const checked = filters.author === author;
          return (
            <PickerMenuOption
              key={author}
              role="menuitemradio"
              aria-checked={checked}
              selected={checked}
              data-testid={`ledger-filter-author-${author}`}
              onClick={() => onChange({ ...filters, author })}
            >
              <PickerMenuOptionCheck selected={checked} reserveSpace />
              <PickerMenuOptionContent>
                <PickerMenuOptionLabel>
                  {author === 'anyone' ? 'Anyone' : 'You'}
                </PickerMenuOptionLabel>
              </PickerMenuOptionContent>
            </PickerMenuOption>
          );
        })}
      </PickerMenuSection>
      <PickerMenuSection>
        <PickerMenuSectionLabel>Last changed</PickerMenuSectionLabel>
        {PERIOD_OPTIONS.map(({ period, label }) => {
          const checked = filters.period === period;
          return (
            <PickerMenuOption
              key={period}
              role="menuitemradio"
              aria-checked={checked}
              selected={checked}
              data-testid={`ledger-filter-period-${period}`}
              onClick={() => onChange({ ...filters, period })}
            >
              <PickerMenuOptionCheck selected={checked} reserveSpace />
              <PickerMenuOptionContent>
                <PickerMenuOptionLabel>{label}</PickerMenuOptionLabel>
              </PickerMenuOptionContent>
            </PickerMenuOption>
          );
        })}
      </PickerMenuSection>
      <PickerMenuSection>
        <PickerMenuOption
          role="menuitemcheckbox"
          aria-checked={filters.includeArchived}
          selected={filters.includeArchived}
          data-testid="ledger-filter-include-archived"
          onClick={() =>
            onChange({ ...filters, includeArchived: !filters.includeArchived })
          }
        >
          <PickerMenuOptionCheck
            selected={filters.includeArchived}
            reserveSpace
          />
          <PickerMenuOptionContent>
            <PickerMenuOptionLabel>Show archived work</PickerMenuOptionLabel>
          </PickerMenuOptionContent>
        </PickerMenuOption>
      </PickerMenuSection>
    </LedgerFilterMenu>
  );
}
