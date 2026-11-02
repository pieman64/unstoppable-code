/**
 * The chat composer's default placeholder, used only when a host passes none.
 * It names the affordances this composer actually has.
 *
 * The wide strings name every affordance, which is right on a row that can
 * show them. At 390px the long form is wider than the input, so it truncates —
 * and a truncated placeholder teaches nothing while looking broken. The phone
 * forms lead with the ask and keep only the affordance a visitor cannot
 * discover any other way. The caller decides what "phone" means; the helper
 * never reads the viewport.
 *
 * The bare "Send a message" fallback has no phone form on purpose: it already
 * fits, and giving it one would mean two strings for a case with nothing to
 * distinguish.
 */
export function defaultChatPlaceholder(
  slashEnabled: boolean,
  fileMentionsEnabled: boolean,
  isPhone: boolean = false,
): string {
  if (isPhone) {
    if (slashEnabled) return 'Ask anything, / for skills';
    if (fileMentionsEnabled) return 'Ask anything';
    return 'Send a message';
  }
  if (slashEnabled && fileMentionsEnabled) {
    return '@ to mention, / skills and commands';
  }
  if (fileMentionsEnabled) return 'Send a message, @ to mention';
  if (slashEnabled) return 'Send a message, / skills and commands';
  return 'Send a message';
}
