/**
 * Growing outputs on the legacy `chat:event` push, sent as appends: a running
 * Codex command's output, and a delegate card's transcript and progress text.
 *
 * Interface projection policy only: main's provider events, the chat state
 * they commit, `chat:state-changed` and every main-side consumer are
 * unchanged. At the send, each receiving page's {@link ChatEventOutputEncoder}
 * replaces such an output with an append to the value it sent that page
 * before, and the page's preload rebuilds the event
 * (`preload/api/chat-event-api.ts`) before any subscriber sees it. A page
 * whose preload starts (a new page or a reload) asks for full values over
 * `chat:event-output-reset` first. Nothing here changes what runs or what
 * is approved; it changes only the bytes that carry produced output.
 */
import type { IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS, type ChatEvent } from '@canopy/desktop-shared/types';
import { ChatEventOutputEncoder } from '@canopy/desktop-shared/lib/chat-event-output';
import { CODEX_COMMAND_OUTPUT_TRUNCATION_NOTICE } from '../codex/command-output-clamp';
import { setRendererMessageEncoder } from '../lib/web-contents-send';
import { validateId } from '../lib/validation';
import { registerIpcHandler } from './register';

function isChatEvent(value: unknown): value is ChatEvent {
  return (
    typeof value === 'object' &&
    value !== null &&
    'projectId' in value &&
    typeof value.projectId === 'string' &&
    'worktreeId' in value &&
    typeof value.worktreeId === 'string' &&
    'chatId' in value &&
    typeof value.chatId === 'string' &&
    'data' in value
  );
}

/** Encoders per receiving page (its `WebContents`), one revision counter. */
export class ChatEventOutputDelivery {
  private readonly encoders = new WeakMap<object, ChatEventOutputEncoder>();
  private rev = 0;

  encode(target: object, message: unknown): unknown {
    if (!isChatEvent(message)) return message;
    return this.encoderFor(target).encode(message);
  }

  discard(target: object, message: unknown): void {
    if (!isChatEvent(message)) return;
    this.encoders.get(target)?.discard(message);
  }

  /** The page in `target` started over; `epoch` names its request. */
  reset(target: object, epoch: string): void {
    this.encoderFor(target).reset(epoch);
  }

  private encoderFor(target: object): ChatEventOutputEncoder {
    let encoder = this.encoders.get(target);
    if (!encoder) {
      encoder = new ChatEventOutputEncoder({
        nextRev: (): number => ++this.rev,
        heads: [CODEX_COMMAND_OUTPUT_TRUNCATION_NOTICE],
      });
      this.encoders.set(target, encoder);
    }
    return encoder;
  }
}

/**
 * The request came from the page's live main frame. A null `senderFrame` is a
 * frame that navigated or was destroyed, not proof of the main frame, so it
 * is rejected like a subframe (as `desktop-ipc-caller.ts` does).
 */
function isMainFrameSender(event: IpcMainInvokeEvent): boolean {
  return (
    event.senderFrame !== null && event.senderFrame === event.sender.mainFrame
  );
}

/** Encodes `chat:event` sends and accepts each page's reset request. */
export function registerChatEventOutputHandlers(): () => void {
  const delivery = new ChatEventOutputDelivery();
  const removeEncoder = setRendererMessageEncoder(IPC_CHANNELS.chatEvent, {
    encode: (target, message) => delivery.encode(target, message),
    discard: (target, message): void => {
      delivery.discard(target, message);
    },
  });
  registerIpcHandler<[unknown], void>(
    IPC_CHANNELS.chatEventOutputReset,
    (event, epoch) => {
      // `webContents.send` reaches only the main frame's page.
      if (!isMainFrameSender(event)) return;
      validateId(epoch, 'chat event output epoch');
      delivery.reset(event.sender, epoch);
    },
  );
  return removeEncoder;
}
