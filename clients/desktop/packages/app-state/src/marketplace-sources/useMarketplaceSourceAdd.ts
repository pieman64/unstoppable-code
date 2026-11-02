'use client';

import { useEffect, useRef, useState } from 'react';
import type {
  MarketplaceSourcesClient,
  MarketplaceSourceAddSession,
  MarketplaceSourceAddSnapshot,
  MarketplaceSourceAddCompletion,
} from '@canopy/app-core/client';

export interface MarketplaceSourceAddBinding {
  readonly session: MarketplaceSourceAddSession;
  readonly snapshot: MarketplaceSourceAddSnapshot;
  readonly completionWarning?: string;
}

/** A fresh session per effect lifetime, including StrictMode's replay. */
export function useMarketplaceSourceAdd(
  client: MarketplaceSourcesClient,
  onComplete: (
    result: MarketplaceSourceAddCompletion,
    isCurrent: () => boolean,
  ) => void | Promise<void>,
): MarketplaceSourceAddBinding | null {
  const [binding, setBinding] = useState<
    | (MarketplaceSourceAddBinding & {
        readonly client: MarketplaceSourcesClient;
      })
    | null
  >(null);
  const clientRef = useRef(client);
  clientRef.current = client;
  const completeRef = useRef(onComplete);
  completeRef.current = onComplete;
  useEffect(() => {
    const session = client.createAddSession?.();
    if (!session) return;
    let live = true;
    let completed = false;
    const isCurrent = (): boolean =>
      live &&
      clientRef.current === client &&
      session.getSnapshot().phase !== 'closed';
    const changed = (): void => {
      if (!live || clientRef.current !== client) return;
      const snapshot = session.getSnapshot();
      setBinding({ client, session, snapshot });
      if (snapshot.phase === 'complete' && !completed) {
        completed = true;
        // Expected transport failures are session state; hosts handle refresh
        // warnings after completion without turning a confirmed write into failure.
        void Promise.resolve().then(async (): Promise<void> => {
          if (!isCurrent()) return;
          try {
            await completeRef.current(snapshot.result, isCurrent);
          } catch {
            if (live)
              setBinding({
                client,
                session,
                snapshot,
                completionWarning:
                  'Marketplace added, but the list could not refresh. Close this dialog and refresh Marketplaces.',
              });
          }
        });
      }
    };
    const unsubscribe = session.subscribe(changed);
    changed();
    return (): void => {
      live = false;
      unsubscribe();
      session.dispose();
    };
  }, [client]);
  return binding?.client === client ? binding : null;
}
