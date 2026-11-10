import type { JSX } from 'react';
import type { LedgerEntryType } from '@canopy/protocol/canopy-core';
import {
  EyeIcon,
  PlayCircleIcon,
  SplitPrIcon,
  SummaryIcon,
  TargetIcon,
  TaskIcon,
  type AppIcon,
} from './AppIcons';
import { DEFAULT_ICON_SIZE, type IconSize } from './icon-size';

/**
 * One app glyph per entry type, always shown with the type's name:
 * a checklist for a task, play for an action, a path that forks for a
 * decision (the arrow-split glyph, not the split-project one), an eye for an
 * observation, the summary glyph for a Summary, and a target for an
 * Operation.
 */
const LEDGER_ENTRY_TYPE_ICONS: Readonly<Record<LedgerEntryType, AppIcon>> = {
  TASK: TaskIcon,
  ACTION: PlayCircleIcon,
  DECISION: SplitPrIcon,
  OBSERVATION: EyeIcon,
  SUMMARY: SummaryIcon,
  OPERATION: TargetIcon,
};

export interface LedgerEntryTypeIconProps {
  readonly type: LedgerEntryType;
  /** A step of the icon scale. Defaults to `sm`, the catalog's 14px. */
  readonly size?: IconSize;
}

/** A type's glyph. Decorative: its name is always beside it. */
export function LedgerEntryTypeIcon({
  type,
  size = DEFAULT_ICON_SIZE,
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
