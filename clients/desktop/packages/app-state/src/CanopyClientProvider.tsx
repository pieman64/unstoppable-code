import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  type JSX,
  type ReactNode,
} from 'react';
import type { CanopyCapabilities, CanopyClient } from '@canopy/app-core';
import {
  CLIENT_STORE_ACTIVATE,
  CLIENT_STORE_DISPOSE,
  type ClientStore,
} from './client-store-lifecycle';

interface ClientStoreRegistry {
  get<TState>(
    key: symbol,
    factory: (client: CanopyClient) => ClientStore<TState>,
  ): ClientStore<TState>;
  retain(): () => void;
  dispose(): void;
}

interface ClientStoreLifecycle {
  [CLIENT_STORE_DISPOSE]?: () => void;
}

function hasClientStoreLifecycle(
  value: unknown,
): value is ClientStoreLifecycle {
  return typeof value === 'function';
}

function createClientStoreRegistry(client: CanopyClient): ClientStoreRegistry {
  const stores = new Map<symbol, unknown>();
  let lifecycleGeneration = 0;
  const dispose = (): void => {
    stores.forEach((value) => {
      if (hasClientStoreLifecycle(value)) {
        value[CLIENT_STORE_DISPOSE]?.();
      }
    });
    stores.clear();
  };
  return {
    get<TState>(
      key: symbol,
      factory: (client: CanopyClient) => ClientStore<TState>,
    ): ClientStore<TState> {
      const existing = stores.get(key);
      if (existing !== undefined) {
        // `key` is private to one `createClientStore` closure, so an entry under
        // it can only have been created by this same typed factory.
        return existing as ClientStore<TState>;
      }
      const store = factory(client);
      stores.set(key, store);
      return store;
    },
    retain(): () => void {
      lifecycleGeneration += 1;
      stores.forEach((value) => {
        (value as ClientStore<unknown>)[CLIENT_STORE_ACTIVATE]?.();
      });
      return (): void => {
        const releaseGeneration = ++lifecycleGeneration;
        // React StrictMode intentionally runs effect setup → cleanup → setup
        // on mount. Defer disposal one microtask so the second setup can retain
        // this committed registry before its subscriptions are torn down.
        queueMicrotask(() => {
          if (lifecycleGeneration === releaseGeneration) dispose();
        });
      };
    },
    dispose,
  };
}

interface CanopyClientContextValue {
  readonly client: CanopyClient;
  readonly stores: ClientStoreRegistry;
}

const CanopyClientContext = createContext<CanopyClientContextValue | null>(
  null,
);

export interface CanopyClientProviderProps {
  /**
   * The platform transport adapter — desktop wraps `window.api`/IPC, web wraps
   * the portal REST/long-poll (later WS/SSE) layer. Shared stores and feature
   * components consume it through this provider, never directly.
   */
  readonly client: CanopyClient;
  readonly children: ReactNode;
}

/**
 * Injects a {@link CanopyClient} into the React tree. Desktop mounts this in
 * `main.tsx`; web mounts it inside a `'use client'` boundary.
 */
export function CanopyClientProvider({
  client,
  children,
}: CanopyClientProviderProps): JSX.Element {
  const value = useMemo<CanopyClientContextValue>(
    () => ({ client, stores: createClientStoreRegistry(client) }),
    [client],
  );
  useEffect(() => value.stores.retain(), [value]);
  return (
    <CanopyClientContext.Provider value={value}>
      {children}
    </CanopyClientContext.Provider>
  );
}

/**
 * The active {@link CanopyClient}, or null outside a provider. For a host
 * component that nests its own provider and must also reach the outer one.
 */
export function useOptionalCanopyClient(): CanopyClient | null {
  return useContext(CanopyClientContext)?.client ?? null;
}

/** Read the active {@link CanopyClient}. Throws if used outside the provider. */
export function useCanopyClient(): CanopyClient {
  const ctx = useContext(CanopyClientContext);
  if (!ctx) {
    throw new Error(
      'useCanopyClient must be used within a <CanopyClientProvider>.',
    );
  }
  return ctx.client;
}

/** Resolve one lazily-created store in the current provider lifecycle. */
export function useCanopyClientStore<TState>(
  key: symbol,
  factory: (client: CanopyClient) => ClientStore<TState>,
): ClientStore<TState> {
  const ctx = useContext(CanopyClientContext);
  const store = ctx?.stores.get(key, factory) ?? null;
  useEffect(() => {
    store?.[CLIENT_STORE_ACTIVATE]?.();
  }, [store]);
  if (!ctx || !store) {
    throw new Error(
      'useCanopyClientStore must be used within a <CanopyClientProvider>.',
    );
  }
  return store;
}

/** Read the host's capability flags. Shared components branch on these. */
export function useCapabilities(): CanopyCapabilities {
  return useCanopyClient().capabilities;
}

/** Read capability flags for one workspace or worktree local id. */
export function useWorkspaceCapabilities(localId: string): CanopyCapabilities {
  const client = useCanopyClient();
  return client.capabilitiesFor?.(localId) ?? client.capabilities;
}
