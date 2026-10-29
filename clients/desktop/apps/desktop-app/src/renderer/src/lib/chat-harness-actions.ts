import type { ModelHarness } from '@canopy/desktop-shared/types';

type Handler = (harness: ModelHarness) => boolean;
const handlers = new Map<
  string,
  { select: Handler; isAvailable: () => boolean }
>();

/** Mounted composers own selection, including billing recovery and locks. */
export function registerChatHarnessAction(
  pickerId: string,
  handler: Handler,
  isAvailable: () => boolean,
): () => void {
  const entry = { select: handler, isAvailable };
  handlers.set(pickerId, entry);
  return () => {
    if (handlers.get(pickerId) === entry) handlers.delete(pickerId);
  };
}

export function isChatHarnessActionAvailable(pickerId: string): boolean {
  return handlers.get(pickerId)?.isAvailable() === true;
}

export function dispatchChatHarnessAction(
  pickerId: string,
  harness: ModelHarness,
): boolean {
  const entry = handlers.get(pickerId);
  return entry?.isAvailable() === true ? entry.select(harness) : false;
}
