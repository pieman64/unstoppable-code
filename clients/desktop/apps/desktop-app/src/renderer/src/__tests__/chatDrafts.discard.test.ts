/**
 * @jest-environment jsdom
 *
 * Discard in an unsaved-changes prompt that counted a chat draft (the
 * Pipeline Assistant's) drops the saved copy and asks the composer showing
 * that tab to empty itself.
 */
import { DISCARD_CHAT_DRAFT_EVENT, discardChatDraft } from '@/lib/chatDrafts';
import { useChatStore } from '@/stores/chatStore';

describe('discardChatDraft', () => {
  it("clears the tab's saved draft and tells its composer to empty", () => {
    const clearTabDraft = jest.fn();
    useChatStore.setState({ clearTabDraft });
    const tabIds: unknown[] = [];
    const listener = (event: Event): void => {
      if (event instanceof CustomEvent) {
        const detail: unknown = event.detail;
        if (typeof detail === 'object' && detail !== null) {
          tabIds.push(Reflect.get(detail, 'tabId'));
        }
      }
    };
    document.addEventListener(DISCARD_CHAT_DRAFT_EVENT, listener);

    discardChatDraft('assistant-tab');
    document.removeEventListener(DISCARD_CHAT_DRAFT_EVENT, listener);

    expect(clearTabDraft).toHaveBeenCalledWith('assistant-tab');
    expect(tabIds).toEqual(['assistant-tab']);
  });
});
