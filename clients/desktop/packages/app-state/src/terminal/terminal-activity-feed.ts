import { registerTerminalClientLifecycle } from './terminal-client-binding';
import { useTerminalActivityStore } from './terminal-activity-store';

interface FeedSubscription {
  consumers: number;
  unregister: () => void;
}
let subscription: FeedSubscription | undefined;

/** Share the activity feed across consumers; the bound host owns its lifetime. */
export function subscribeTerminalActivityFeed(): () => void {
  if (!subscription) {
    const unregister = registerTerminalClientLifecycle(
      ({ client, isCurrent }): (() => void) => {
        const releases: Array<() => void> = [];
        const release = (): void => {
          const errors: unknown[] = [];
          for (const unsubscribe of releases.splice(0)) {
            try {
              unsubscribe();
            } catch (error: unknown) {
              errors.push(error);
            }
          }
          if (errors.length > 0) throw errors[0];
        };
        try {
          releases.push(
            client.subscribe('terminal.running-changed', (event): void => {
              if (isCurrent())
                useTerminalActivityStore.getState().handleRunningChanged(event);
            }),
          );
          releases.push(
            client.subscribe('terminal.exit', (event): void => {
              if (isCurrent())
                useTerminalActivityStore.getState().handleExit(event);
            }),
          );
          // list re-emits running snapshots, so both listeners must exist first.
          void client.query('terminal.list', {}).catch(() => undefined);
        } catch (error: unknown) {
          try {
            release();
          } catch {
            /* Preserve the acquisition failure. */
          }
          throw error;
        }
        return release;
      },
    );
    subscription = { consumers: 0, unregister };
  }
  const current = subscription;
  current.consumers += 1;
  let active = true;
  return (): void => {
    if (!active) return;
    active = false;
    current.consumers -= 1;
    if (current.consumers === 0) {
      if (subscription === current) subscription = undefined;
      current.unregister();
    }
  };
}
