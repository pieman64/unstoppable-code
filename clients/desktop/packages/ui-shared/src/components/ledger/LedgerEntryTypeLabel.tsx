'use client';

import type { JSX } from 'react';
import type { LedgerEntryType } from '@canopy/protocol/canopy-core';
import {
  EyeIcon,
  PlayCircleIcon,
  SplitPrIcon,
  SummaryIcon,
  TaskIcon,
  type AppIcon,
} from '../../icons/AppIcons';
import { LEDGER_ENTRY_TYPE_LABELS } from '../../lib/ledger-display';
import { ICON_SIZE_PX } from '../../icons/icon-size';
import { DISPLAY_AVATAR_GLYPH_SIZE, DisplayAvatar } from '../DisplayAvatar';
import {
  LEDGER_DISPLAY_AVATAR_SIZE,
  type LedgerActorAvatarSize,
} from './LedgerActorAvatar';

/**
 * One app glyph per entry type, always shown with the type's name:
 * a checklist for a task, play for an action, a path that forks for a
 * decision (the arrow-split glyph, not the split-project one), an eye for an
 * observation, and the summary glyph for a Summary.
 */
const LEDGER_ENTRY_TYPE_ICONS: Readonly<Record<LedgerEntryType, AppIcon>> = {
  TASK: TaskIcon,
  ACTION: PlayCircleIcon,
  DECISION: SplitPrIcon,
  OBSERVATION: EyeIcon,
  SUMMARY: SummaryIcon,
};

export interface LedgerEntryTypeIconProps {
  readonly type: LedgerEntryType;
  readonly size?: number;
}

/** A type's glyph. Decorative: its name is always beside it. */
export function LedgerEntryTypeIcon({
  type,
  size = 12,
}: LedgerEntryTypeIconProps): JSX.Element {
  const Icon = LEDGER_ENTRY_TYPE_ICONS[type];
  return (
    <Icon
      size={size}
      aria-hidden="true"
      data-testid="ledger-entry-type-icon"
      data-type={type}
      className="shrink-0"
    />
  );
}

export interface LedgerEntryTypeLabelProps {
  readonly type: LedgerEntryType;
  /**
   * False names the type without its glyph, where the glyph already shows:
   * on a row, whose avatar is the type. Defaults to true.
   */
  readonly icon?: boolean;
}

/** An entry's type: its glyph, then its name, in the surrounding text style. */
export function LedgerEntryTypeLabel({
  type,
  icon = true,
}: LedgerEntryTypeLabelProps): JSX.Element {
  return (
    <span
      data-testid="ledger-entry-type"
      data-type={type}
      className="inline-flex min-w-0 items-center gap-1"
    >
      {icon && <LedgerEntryTypeIcon type={type} />}
      <span className="truncate">{LEDGER_ENTRY_TYPE_LABELS[type]}</span>
    </span>
  );
}

export interface LedgerEntryTypeAvatarProps {
  readonly type: LedgerEntryType;
  readonly size: LedgerActorAvatarSize;
}

/**
 * A main entry's avatar: its type's glyph in the shared avatar shell, so a
 * column of rows reads by what kind of entry each is. Decorative: the row
 * names the type beside it.
 */
export function LedgerEntryTypeAvatar({
  type,
  size,
}: LedgerEntryTypeAvatarProps): JSX.Element {
  const avatarSize = LEDGER_DISPLAY_AVATAR_SIZE[size];
  return (
    <DisplayAvatar
      name={LEDGER_ENTRY_TYPE_LABELS[type]}
      size={avatarSize}
      testId="ledger-entry-type-avatar"
      data-type={type}
      glyph={
        <LedgerEntryTypeIcon
          type={type}
          size={ICON_SIZE_PX[DISPLAY_AVATAR_GLYPH_SIZE[avatarSize]]}
        />
      }
    />
  );
}
