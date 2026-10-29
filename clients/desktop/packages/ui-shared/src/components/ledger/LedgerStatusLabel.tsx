import type { JSX } from 'react';
import type { LedgerStatus } from '@canopy/protocol/canopy-core';
import {
  LEDGER_STATUS_LABELS,
  ledgerStatusTone,
  type LedgerStatusTone,
} from '../../lib/ledger-display';
import { OPERATIONAL_STATUS_COLORS } from '../../lib/operational-status-colors';

/** The run-state inks the rest of the app uses, so each has a theme token. */
const TONE_CLASS_NAMES: Readonly<Record<LedgerStatusTone, string>> = {
  quiet: 'fg-tertiary',
  active: OPERATIONAL_STATUS_COLORS.active.foreground,
  success: OPERATIONAL_STATUS_COLORS.success.foreground,
  failed: OPERATIONAL_STATUS_COLORS.failed.foreground,
  paused: OPERATIONAL_STATUS_COLORS.paused.foreground,
  attention: 'fg-attention',
};

export interface LedgerStatusLabelProps {
  status: LedgerStatus;
  'data-testid'?: string;
}

/**
 * An entry's status as text ("In progress"), inked by its meaning, where it
 * reads as a value: among an entry's details and in a form. Rows show
 * `LedgerStatusPill` instead. The color is never the only signal.
 */
export function LedgerStatusLabel({
  status,
  'data-testid': testId,
}: LedgerStatusLabelProps): JSX.Element {
  return (
    <span
      data-testid={testId}
      data-status={status}
      className={`shrink-0 whitespace-nowrap text-2xs font-medium ${TONE_CLASS_NAMES[ledgerStatusTone(status)]}`}
    >
      {LEDGER_STATUS_LABELS[status]}
    </span>
  );
}
