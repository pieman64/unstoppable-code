import {
  AI_CREDITS_HANDOFF_COPY,
  type AiCreditsCheckFeedbackKind,
} from '@canopy/ui-shared';

/**
 * What a chat banner says while a credits purchase is open in the browser
 * (CAN-5162): the step the user is on as a short title, and what happens next
 * as the message. `feedback` is the last Check again verdict, or `null` while
 * simply waiting. Every purchase path shares this copy (CAN-5160).
 */
export function aiCreditsHandoffCopy(
  feedback: AiCreditsCheckFeedbackKind | null,
): { readonly title: string; readonly message: string } {
  switch (feedback) {
    case 'uncovered':
      return AI_CREDITS_HANDOFF_COPY.uncovered;
    case 'check-failed':
      return AI_CREDITS_HANDOFF_COPY.checkFailed;
    default:
      return AI_CREDITS_HANDOFF_COPY.waiting;
  }
}
