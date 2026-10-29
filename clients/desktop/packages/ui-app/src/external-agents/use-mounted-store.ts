'use client';

import { useEffect, useState } from 'react';
import type { ExternalAgentsClient } from '@canopy/app-core';

interface DisposableStore {
  readonly getState: () => {
    readonly load: () => Promise<void>;
    readonly dispose: () => void;
  };
}

interface MountedStore<TStore> {
  readonly client: ExternalAgentsClient;
  readonly key: string;
  readonly store: TStore;
}

/**
 * A store owned by one mount: created and loaded when the effect runs and
 * disposed in its cleanup. A disposed store drops every later result, so it
 * must not outlive the effect that disposed it. React runs effects twice in
 * development, and a store kept in state from the first render would stay
 * disposed and never finish loading. Returns `null` until the effect for the
 * current client and key has run.
 */
export function useMountedStore<TStore extends DisposableStore>(
  client: ExternalAgentsClient,
  key: string,
  create: (client: ExternalAgentsClient, key: string) => TStore,
): TStore | null {
  const [mounted, setMounted] = useState<MountedStore<TStore> | null>(null);

  useEffect(() => {
    const store = create(client, key);
    setMounted({ client, key, store });
    void store.getState().load();
    return (): void => store.getState().dispose();
    // `create` is a module-level factory; the client and key are the inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, key]);

  return mounted !== null && mounted.client === client && mounted.key === key
    ? mounted.store
    : null;
}
