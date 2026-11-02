/** Reports accepted Home sends to the independent contextual tip queue. */

export interface HomeTaskSendEvent {
  kind: 'chat' | 'pipeline';
  /** Absent for Home sends; chat composers report acceptance directly. */
  chatId?: string;
  /** Home dispatch accepted a turn now, rather than saving a schedule. */
  acceptedTurn?: boolean;
  worktreeChat?: boolean;
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

// CAN-5006 observes acceptance separately from Home's broader successful
// dispatch event, which also includes schedules and empty chat creation.
const acceptedWorktreeTurnListeners = new Set<() => void>();

export function subscribeAcceptedWorktreeTurns(
  listener: () => void,
): () => void {
  acceptedWorktreeTurnListeners.add(listener);
  return (): void => {
    acceptedWorktreeTurnListeners.delete(listener);
  };
}

export function notifyAcceptedWorktreeTurn(
  options: { readonly retry?: boolean } = {},
): void {
  if (options.retry) return;
  for (const listener of Array.from(acceptedWorktreeTurnListeners)) listener();
}
