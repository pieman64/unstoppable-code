/**
 * Focuses the chat composer textarea after a new chat is created. Rendering
 * the new tab happens asynchronously, so the focus call is deferred to the
 * next animation frame. Shared by every "start a new chat" affordance on the
 * Cowork page (conversation header, empty states) so they all keep the same
 * focus-after-create behavior.
 */
export function focusChatTextarea(): void {
  requestAnimationFrame(() => {
    const el = document.querySelector<HTMLTextAreaElement>(
      '[data-chat-textarea]',
    );
    el?.focus();
  });
}
