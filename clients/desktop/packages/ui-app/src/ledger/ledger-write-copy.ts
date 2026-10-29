import type {
  LedgerViewChangeNotice,
  LedgerViewWriteProblem,
} from '@canopy/app-state';

/*
 * What a failed write means to the person. Wire reasons never reach the
 * screen; anything unexpected reads as a save that can be tried again.
 */

/** The store's own check before saving, shown as it is. */
const MISSING_FIELDS_MESSAGE = 'Add content.';

/** Why a row cannot be corrected before its title has finished resolving. */
export const ADD_CORRECTION_TITLE_PENDING_REASON =
  'Its title is still being written.';

export const OWNER_UNAVAILABLE_MESSAGE =
  "That owner can't be assigned anymore. Choose another.";

export function ledgerSaveProblemText(problem: LedgerViewWriteProblem): string {
  switch (problem.reason) {
    case 'OWNER_UNAVAILABLE':
      return OWNER_UNAVAILABLE_MESSAGE;
    case 'INVALID_INPUT':
      return problem.message === MISSING_FIELDS_MESSAGE
        ? MISSING_FIELDS_MESSAGE
        : 'Check the entry and try again.';
    case 'IDEMPOTENCY_KEY_REUSED':
      return 'This entry was already saved. Cancel this draft to start another.';
    case 'disabled':
      return "The Feed isn't available.";
    case 'no_scope':
      return "This work doesn't have a Feed.";
    case 'SCOPE_RETIRED':
      return "This work's Feed was removed.";
    case 'FORBIDDEN':
      return "You can't add entries here.";
    default:
      return "Couldn't save the entry. Try again.";
  }
}

export interface LedgerChangeNoticeCopy {
  readonly intent: 'attention' | 'neutral' | 'destructive';
  readonly message: string;
  /** "Try again" sends the same change again. */
  readonly retry: boolean;
}

export function ledgerChangeNoticeCopy(
  notice: LedgerViewChangeNotice,
): LedgerChangeNoticeCopy {
  switch (notice) {
    case 'conflict':
      return {
        intent: 'attention',
        message: 'This entry changed. Review the latest version.',
        retry: false,
      };
    case 'owner_unavailable':
      return {
        intent: 'attention',
        message: OWNER_UNAVAILABLE_MESSAGE,
        retry: false,
      };
    case 'closed':
      return {
        intent: 'neutral',
        message: "This entry was closed. It can't change now.",
        retry: false,
      };
    case 'failed':
      return {
        intent: 'destructive',
        message: "Couldn't save the change.",
        retry: true,
      };
  }
}
