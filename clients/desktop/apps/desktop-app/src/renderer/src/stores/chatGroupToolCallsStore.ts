import { createChatPreferenceToggleStore } from './chatPreferenceToggleStore';

/**
 * Renderer mirror of `PreferencesData.chatGroupToolCallsEnabled`: fold
 * back-to-back tool calls into one row ("Ran 3 commands"). Off by default, so
 * every tool call shows as its own row; independent of the live step window.
 */
const groupToolCalls = createChatPreferenceToggleStore(
  'chatGroupToolCallsEnabled',
);

export const useChatGroupToolCallsStore = groupToolCalls.useStore;
export const ensureChatGroupToolCallsSubscription =
  groupToolCalls.ensureSubscription;
/** Whether tool calls fold into one row. Reads false until loaded. */
export const useChatGroupToolCallsEnabled = groupToolCalls.useEnabled;
/** Test-only: forget the subscription and return the store to its defaults. */
export const resetChatGroupToolCallsStoreForTest = groupToolCalls.resetForTest;
