// Which committed chat state events may reach React on the next animation
// frame instead of immediately (see `frame-batched-store-view.ts`).
//
// Only streamed content qualifies: message upserts, non-resetting transcript
// descriptor updates, and runtime patches that change nothing but
// `lastActivityAt`. Everything that changes a chat's lifecycle or structure
// (status, errors, queues, tabs, questions, archives, removals, replacements,
// transcript resets) renders immediately, as before, so React effects keyed
// on those transitions still observe every intermediate state.

import type {
  ChatRuntimeState,
  ChatStateChangedEvent,
} from '@canopy/desktop-shared/types';
import { isStreamedChatStateEvent } from '@canopy/desktop-shared/lib/chat-state-cadence';
import type {
  FrameBatchedStoreView,
  FrameScheduler,
} from './frame-batched-store-view';

/**
 * True when every change of a committed event is streamed content. Evaluate
 * it against the runtime state from BEFORE the event is applied. Main's
 * legacy IPC projection merges only such events, with the same definition
 * (`@canopy/desktop-shared/lib/chat-state-cadence`), so a merged event is
 * streamed content here too.
 */
export function isStreamedContentEvent(
  event: ChatStateChangedEvent,
  runtimeByChatId: Readonly<Record<string, ChatRuntimeState>>,
): boolean {
  return isStreamedChatStateEvent(event, (chatId) => runtimeByChatId[chatId]);
}

/**
 * Apply one received committed event to the store now. Streamed content
 * reaches React through `view` on the next frame; anything else, at once.
 */
export function applyChatStateChangedForRender<S>(
  event: ChatStateChangedEvent,
  options: {
    apply: (event: ChatStateChangedEvent) => void;
    runtimeByChatId: Readonly<Record<string, ChatRuntimeState>>;
    view: FrameBatchedStoreView<S>;
    scheduler: FrameScheduler;
  },
): void {
  if (isStreamedContentEvent(event, options.runtimeByChatId)) {
    options.view.deferNotifications(options.scheduler, () =>
      options.apply(event),
    );
    return;
  }
  options.apply(event);
}
