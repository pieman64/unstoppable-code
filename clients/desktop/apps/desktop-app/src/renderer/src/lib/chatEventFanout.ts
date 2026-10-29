import type { ChatApi, ChatEvent } from '@canopy/desktop-shared/types';
import { createListenerFanout } from '@canopy/desktop-shared/lib/listener-fanout';

type ChatEventSubscribe = (listener: (event: ChatEvent) => void) => () => void;

// Keyed by bridge object: one per page in production, one per mock in tests.
const fanouts = new WeakMap<ChatApi, ChatEventSubscribe>();

/**
 * Subscribe to `chat:event` with page-side fan-out: every subscriber in this
 * page shares one `window.api.chat.onChatEvent` subscription, so each event
 * crosses the context bridge (a structured clone) once, not once per
 * subscriber. Delivery order is subscription order, as with separate
 * subscriptions.
 */
export function subscribeToChatEvents(
  listener: (event: ChatEvent) => void,
): () => void {
  const chat: ChatApi = window.api.chat;
  let subscribe = fanouts.get(chat);
  if (!subscribe) {
    subscribe = createListenerFanout<ChatEvent>((dispatch) =>
      chat.onChatEvent(dispatch),
    );
    fanouts.set(chat, subscribe);
  }
  return subscribe(listener);
}
