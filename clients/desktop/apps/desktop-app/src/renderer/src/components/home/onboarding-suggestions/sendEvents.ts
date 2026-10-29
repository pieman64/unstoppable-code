/**
 * Module-level notification seam between the send paths and the onboarding
 * suggestions module. `HomeSurface` reports every successful Home send (chat
 * dispatch or `task_ready` pipeline-run dispatch) and `ChatInput` every
 * accepted send from a chat tab's composer, where the centered checklist
 * arms its prompts (CAN-3031, CAN-3032); an armed suggestion entry completes
 * on the next report. A module-level emitter — rather than prop drilling
 * through the composer — keeps the send orchestration free of onboarding
 * concerns.
 */

export interface HomeTaskSendEvent {
  kind: 'chat' | 'pipeline';
  /** Snapshot from the Home composer for chat sends. */
  planMode?: boolean;
  /**
   * The chat tab whose composer sent, for sends reported by `ChatInput`;
   * absent for Home sends. An armed suggestion completes only when this
   * matches the surface it was armed for.
   */
  chatId?: string;
}

type HomeTaskSendListener = (event: HomeTaskSendEvent) => void;

const listeners = new Set<HomeTaskSendListener>();

export function subscribeHomeTaskSends(
  listener: HomeTaskSendListener,
): () => void {
  listeners.add(listener);
  return (): void => {
    listeners.delete(listener);
  };
}

export function notifyHomeTaskSent(event: HomeTaskSendEvent): void {
  for (const listener of Array.from(listeners)) {
    listener(event);
  }
}
