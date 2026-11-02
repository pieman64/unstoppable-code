import {
  isTerminalDeferredToolsReloadLifecycle,
  type DeferredToolsReloadEvent,
} from '@canopy/desktop-shared/types';
import type { ChatQueueService } from './chat-queue-service';

/**
 * A deferred-tools reload interrupts its turn, then dispatches a hidden
 * continuation that the renderer names at finish. Admission is held from the
 * interruption until an outcome, so the predecessor's end cannot admit
 * another send first; the continuation is admitted through the hold.
 */
export function holdDispatchForDeferredReload(
  queue: Pick<
    ChatQueueService,
    'holdDirectDispatch' | 'releaseDirectDispatchHold'
  >,
  event: DeferredToolsReloadEvent,
): void {
  if (
    event.lifecycle.kind === 'state' &&
    event.lifecycle.state === 'interrupting'
  )
    queue.holdDirectDispatch(event.scope, event.requestId);
  else if (isTerminalDeferredToolsReloadLifecycle(event.lifecycle))
    queue.releaseDirectDispatchHold(event.scope, event.requestId);
}
