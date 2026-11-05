/**
 * When a newly displayed approval card may take keyboard focus (CAN-4997).
 *
 * A card moves focus to its primary action only when nobody is using focus:
 * focus rests on the document body, or in a composer with no draft text. Any
 * other focused element (a terminal, another editor, a sidebar control, the
 * dock's own navigation) keeps focus, and so does an open modal dialog or menu.
 * Missing evidence is not permission: a null active element or an unmounted
 * composer declines.
 *
 * Callers evaluate this at the moment focus would move, never from a value
 * captured during an earlier render.
 */
export interface ApprovalFocusContext {
  /** `document.activeElement` of the composer's document. */
  readonly activeElement: Element | null;
  /** That document's body. */
  readonly body: HTMLElement | null;
  /** The composer root, or null when no composer is mounted. */
  readonly composerRoot: Element | null;
  /** The composer's draft text, trimmed by the policy. */
  readonly composerDraftText: string;
  /** Whether an IME composition is in progress in the composer. */
  readonly composing: boolean;
  /** Whether a modal dialog or menu blocks acquisition, even from the body. */
  readonly modalOpen: boolean;
}

export function canApprovalTakeFocus(context: ApprovalFocusContext): boolean {
  const { activeElement, body, composerRoot } = context;
  if (activeElement === null || body === null || composerRoot === null) {
    return false;
  }
  // Slate may not have committed composed text yet, so a composition counts
  // as a draft wherever focus is.
  if (context.composing) return false;
  if (context.modalOpen) return false;
  if (activeElement === body) return true;
  if (!composerRoot.contains(activeElement)) return false;
  return context.composerDraftText.trim().length === 0;
}
