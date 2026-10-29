import type { ChatEvent } from '@canopy/desktop-shared/types';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import {
  ChatEventOutputDecoder,
  type ChatEventMessage,
} from '@canopy/desktop-shared/lib/chat-event-output';
import { createListenerFanout } from '@canopy/desktop-shared/lib/listener-fanout';

type ChatEventListener = (event: unknown, payload: ChatEventMessage) => void;

type ChatEventIpc = {
  on(channel: string, listener: ChatEventListener): void;
  removeListener(channel: string, listener: ChatEventListener): void;
  invoke(
    channel: typeof IPC_CHANNELS.chatEventOutputReset,
    epoch: string,
  ): Promise<void>;
};

/** 128 random bits as lowercase hex (`getRandomValues` needs no secure context). */
function randomEpoch(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  );
}

interface ChatEventSubscriptionOptions {
  /** A fresh id for a reset request (lowercase, digits and hyphens). */
  newEpoch?: () => string;
}

/**
 * `chat.onChatEvent`: one `chat:event` IPC listener for this page, however
 * many subscribers it has, registered with the first and removed with the
 * last.
 *
 * Main sends growing outputs (a running Codex command's output, a delegate
 * card's transcript and progress text) as appends
 * (`main/ipc/chat-event-output.ts`); the listener rebuilds each event before
 * any subscriber sees it. Each registration starts a new decoder, which first
 * asks main to send outputs in full; an event it cannot rebuild is dropped,
 * never shown with a wrong output.
 */
export function createChatEventSubscription(
  ipc: ChatEventIpc,
  options: ChatEventSubscriptionOptions = {},
): (callback: (event: ChatEvent) => void) => () => void {
  const newEpoch = options.newEpoch ?? randomEpoch;
  return createListenerFanout<ChatEvent>((dispatch) => {
    const decoder = new ChatEventOutputDecoder({
      newEpoch,
      requestReset: (epoch): Promise<void> =>
        ipc.invoke(IPC_CHANNELS.chatEventOutputReset, epoch),
    });
    const handler: ChatEventListener = (_event, payload) => {
      const event = decoder.decode(payload);
      if (event !== undefined) dispatch(event);
    };
    ipc.on(IPC_CHANNELS.chatEvent, handler);
    return (): void => {
      ipc.removeListener(IPC_CHANNELS.chatEvent, handler);
    };
  });
}
