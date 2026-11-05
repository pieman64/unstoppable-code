'use client';

import type { JSX } from 'react';
import {
  LedgerPanelActivity,
  type LedgerPanelActivityProps,
} from './LedgerPanelActivity';

export type LedgerPanelProps = LedgerPanelActivityProps;

/** One work scope's Feed panel. */
export function LedgerPanel(props: LedgerPanelProps): JSX.Element {
  return <LedgerPanelActivity {...props} />;
}
