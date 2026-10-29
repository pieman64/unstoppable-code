import { useChatSidebarStore } from '@/stores/chatSidebarStore';
import type { ChatBadgeKeys } from './chatBadgeKeys';

/**
 * Every sidebar row's attention key sets, from the chat store plus the chats
 * whose managed delegates are still live. Shared by both sidebar hosts so they
 * cannot drift. Derived by the sidebar store (`deriveChatBadgeKeys`), which
 * publishes only when a key set changes.
 */
export function useChatBadgeKeys(): ChatBadgeKeys {
  return useChatSidebarStore((state) => state.badgeKeys);
}
