/**
 * When an automatic "What's new" dialog may open (CAN-5006). A delayed feed
 * must never pop the dialog over a user who is already working: before the
 * first interaction it may open at once; after one it waits for an idle
 * milestone (a return to Home or an accepted send) and a quiet moment. Hard
 * blockers always win, whatever the history.
 */

/** Quiet time after the last interaction before a deferred dialog may open. */
export const IDLE_QUIET_MS = 1_000;

export type PresentationBlocker =
  /** Startup gates, rollout, a queued decision, or an open dialog. */
  | 'not-queued'
  /** A modal, an Escape-owning overlay, Settings, or a sibling notice. */
  | 'overlay'
  /** The window is hidden or another application has focus. */
  | 'background'
  /** A Continue/resume navigation is still in flight. */
  | 'resume-pending'
  /** Focus is inside a composer, including an auto-focused empty one. */
  | 'composer-focus'
  /** A composer holds text, file references, or attachments. */
  | 'composer-draft'
  /** An IME composition is in progress. */
  | 'composing';

export interface PresentationGateInput {
  readonly blockers: readonly PresentationBlocker[];
  readonly deferred: boolean;
  readonly milestoneArmed: boolean;
  /** Monotonic time of the last interaction, or `null` when none was seen. */
  readonly lastInteractionAt: number | null;
  /** Monotonic time now, in the same clock as `lastInteractionAt`. */
  readonly now: number;
}

export type PresentationGateDecision =
  | { readonly action: 'present' }
  /** Deferred with no milestone yet: nothing to schedule until one arrives. */
  | { readonly action: 'defer' }
  /**
   * Blocked or not yet quiet. `delayMs` is set when only the quiet window
   * remains, so the caller can recheck exactly when it ends.
   */
  | { readonly action: 'wait'; readonly delayMs?: number };

export function decidePresentation(
  input: PresentationGateInput,
): PresentationGateDecision {
  if (input.deferred && !input.milestoneArmed) return { action: 'defer' };
  if (input.blockers.length > 0) return { action: 'wait' };
  if (!input.deferred) return { action: 'present' };
  const quietFor =
    input.lastInteractionAt === null
      ? Number.POSITIVE_INFINITY
      : input.now - input.lastInteractionAt;
  if (quietFor >= IDLE_QUIET_MS) return { action: 'present' };
  return { action: 'wait', delayMs: IDLE_QUIET_MS - quietFor };
}
