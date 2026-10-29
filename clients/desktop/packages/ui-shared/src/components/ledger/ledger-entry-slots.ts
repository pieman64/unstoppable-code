import type { ReactNode } from 'react';
import type { LedgerViewEntry } from '@canopy/protocol/ledger-view';
import type { LedgerSourceAction } from '../../lib/ledger-display';

/*
 * What the feature layer hands the Ledger's entry rows. The rows are
 * display only: every control, note and state below is decided, wired and
 * worded by the host that owns the Ledger's stores.
 */

/**
 * How large a Ledger column reads: `page` on the Feed (larger type, 32px
 * avatars), `panel` beside a chat (smaller type, 24px avatars).
 */
export type LedgerDensity = 'page' | 'panel';

/**
 * What one entry, a row or a reply, offers the person. Everything is
 * optional: a bare entry shows its status as text and offers no actions.
 */
export interface LedgerEntrySlots {
  /**
   * Changes the status in place of its pill, for an entry the person can
   * change (`LedgerStatusControl` with `variant="inline"`).
   */
  readonly statusControl?: ReactNode;
  /**
   * Changes the owner in place, for an entry the person can change
   * (`LedgerOwnerPicker` with `variant="inline"`).
   */
  readonly ownerControl?: ReactNode;
  /**
   * The source action, such as `Open chat`. It shows when `onOpenSource` is
   * given too. An open entry with a read source shows that source instead.
   */
  readonly sourceAction?: LedgerSourceAction | null;
  readonly onOpenSource?: () => void;
  /** Starts a correction of this entry; omitted, no Add correction shows. */
  readonly onAddCorrection?: () => void;
  /** Replaces `Add correction`, such as `Continue correction draft`. */
  readonly addCorrectionLabel?: string;
  /**
   * Why Add correction waits, such as another draft being open. Disables
   * the action and explains it in its tooltip.
   */
  readonly addCorrectionDisabledReason?: string | null;
  /**
   * Why only someone else can change the entry, such as `Recorded on Studio
   * Mac. Change it there.` Given, it replaces the actions, and the entry
   * never shows controls or a correction box.
   */
  readonly readOnlyNote?: ReactNode;
}

/**
 * The one open entry in a list, a row or a reply, with its read and the
 * states around it. Only this entry shows its activity and details.
 */
export interface LedgerOpenEntry {
  readonly entryId: string;
  /** The entry's read; null while it loads or after it failed. */
  readonly view: LedgerViewEntry | null;
  /** The read's loading or problem state, in the open area. */
  readonly readState?: ReactNode;
  /** How the last status or owner change went. */
  readonly notice?: ReactNode;
  /** Why a closed entry can't change. */
  readonly closedExplanation?: ReactNode;
  /** Why the last attempt to open the source or a file failed. */
  readonly openError?: string | null;
  /** Reads the next page of changes; shown while history has more. */
  readonly onLoadMoreHistory?: () => void;
  readonly loadingMoreHistory?: boolean;
}
