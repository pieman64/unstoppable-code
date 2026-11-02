/**
 * How long a deep-linked turn or a landed-on call keeps its highlight ring
 * (ECW-8684, CAN-5056).
 */
export const CHAT_TURN_FOCUS_HIGHLIGHT_MS = 2400;

/**
 * Rings one transcript row with the scroller's `[data-chat-call-focus]`
 * highlight for {@link CHAT_TURN_FOCUS_HIGHLIGHT_MS}. Set directly on the
 * element, so the ring never re-renders the transcript mid-scroll. The
 * returned cancel clears the timer and the ring at once.
 */
export function ringChatCallFocus(element: HTMLElement): () => void {
  element.dataset.chatCallFocus = 'true';
  const timer = window.setTimeout((): void => {
    delete element.dataset.chatCallFocus;
  }, CHAT_TURN_FOCUS_HIGHLIGHT_MS);
  return (): void => {
    window.clearTimeout(timer);
    delete element.dataset.chatCallFocus;
  };
}
