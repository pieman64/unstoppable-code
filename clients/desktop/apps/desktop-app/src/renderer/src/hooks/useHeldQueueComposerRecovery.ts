import { useEffect, useRef } from 'react';
import { bindHeldQueueComposerRecovery } from '@/stores/composerRecoveryStore';

type HeldQueueComposerPort = Parameters<
  typeof bindHeldQueueComposerRecovery
>[0];

/** Keep held history until the chat identity or its store changes. */
export function useHeldQueueComposerRecovery(
  key: string | undefined,
  port: HeldQueueComposerPort,
): void {
  const current = useRef(port);
  current.current = port;
  const subscribe = port.subscribe;
  useEffect(() => {
    if (!key) return undefined;
    return bindHeldQueueComposerRecovery({
      subscribe,
      readQueue: () =>
        current.current.subscribe === subscribe
          ? current.current.readQueue()
          : undefined,
      readDraft: () => current.current.readDraft(),
      clearDraft: () => current.current.clearDraft(),
    });
  }, [key, subscribe]);
}
