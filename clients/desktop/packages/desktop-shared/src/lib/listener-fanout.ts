/**
 * One source listener shared by any number of subscribers.
 *
 * `attach` registers the single source listener (an `ipcRenderer.on`, or a
 * preload bridge subscription) when the first subscriber arrives and returns
 * its removal, which runs when the last subscriber leaves. A dispatch reaches
 * the subscribers present when it starts, in subscription order, like an
 * `EventEmitter`. A subscriber that throws does not stop the others; its
 * error is rethrown from a microtask so it is still reported.
 *
 * Browser-safe: used by the preload (one IPC listener per channel) and by the
 * renderer page (one bridge subscription per channel, so a payload crosses
 * the context bridge once instead of once per subscriber).
 */
export function createListenerFanout<T>(
  attach: (dispatch: (value: T) => void) => () => void,
): (listener: (value: T) => void) => () => void {
  // Wrapped so one function subscribed twice is two subscriptions.
  const subscribers = new Set<{ listener: (value: T) => void }>();
  let detach: (() => void) | null = null;
  const dispatch = (value: T): void => {
    for (const subscriber of Array.from(subscribers)) {
      try {
        subscriber.listener(value);
      } catch (error) {
        queueMicrotask(() => {
          throw error;
        });
      }
    }
  };
  return (listener) => {
    const subscriber = { listener };
    subscribers.add(subscriber);
    if (!detach) detach = attach(dispatch);
    return (): void => {
      if (!subscribers.delete(subscriber)) return;
      if (subscribers.size > 0 || !detach) return;
      const remove = detach;
      detach = null;
      remove();
    };
  };
}
