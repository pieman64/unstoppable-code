'use client';

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type JSX,
  type ReactNode,
} from 'react';
import { useStore } from 'zustand';
import type {
  AccountOrganizationSettingsClient,
  SettingsSelectionStorage,
} from '@canopy/app-core/settings';
import type {
  SettingsBootstrap,
  SettingsRoute,
} from '@canopy/protocol/settings';
import { CLIENT_STORE_DISPOSE } from '../client-store-lifecycle';
import {
  createSettingsStore,
  type SettingsStore,
  type SettingsStoreState,
} from './create-settings-store';

const SettingsStoreContext = createContext<SettingsStore | null>(null);

const storeRetainCounts = new WeakMap<SettingsStore, number>();

/**
 * Retain a store for one mounted provider. Disposal is deferred a microtask so
 * StrictMode's setup → cleanup → setup keeps the committed store alive; a
 * store whose last provider released it is disposed.
 */
function retainSettingsStore(store: SettingsStore): () => void {
  storeRetainCounts.set(store, (storeRetainCounts.get(store) ?? 0) + 1);
  return (): void => {
    storeRetainCounts.set(store, (storeRetainCounts.get(store) ?? 1) - 1);
    queueMicrotask(() => {
      if ((storeRetainCounts.get(store) ?? 0) > 0) return;
      storeRetainCounts.delete(store);
      store[CLIENT_STORE_DISPOSE]?.();
    });
  };
}

export interface SettingsStoreProviderProps {
  readonly client: AccountOrganizationSettingsClient;
  /** The signed-in account; a change creates a fresh store. */
  readonly accountId: string | null;
  readonly storage?: SettingsSelectionStorage;
  /**
   * Bootstraps the account loaded before, keyed by requested organization id
   * (`''` for none). Read only when a store is created.
   */
  readonly initialBootstraps?: Readonly<Record<string, SettingsBootstrap>>;
  /** The route Settings opens on. Read only when a store is created. */
  readonly initialRoute?: SettingsRoute | null;
  readonly children: ReactNode;
}

/**
 * Owns one {@link SettingsStore} per client and account generation. A new
 * client or account replaces the store and disposes the old one, so late
 * responses for the previous identity are dropped.
 */
export function SettingsStoreProvider({
  client,
  accountId,
  storage,
  initialBootstraps,
  initialRoute,
  children,
}: SettingsStoreProviderProps): JSX.Element {
  const store = useMemo(
    () =>
      createSettingsStore(client, {
        accountId,
        storage,
        initialBootstraps,
        initialRoute,
      }),
    // The initial values seed a new store; changing them alone must not
    // replace the store (and drop its data).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [client, accountId, storage],
  );
  useEffect(() => retainSettingsStore(store), [store]);
  return (
    <SettingsStoreContext.Provider value={store}>
      {children}
    </SettingsStoreContext.Provider>
  );
}

/** The current settings store, or `null` outside a provider. */
export function useOptionalSettingsStoreApi(): SettingsStore | null {
  return useContext(SettingsStoreContext);
}

const NO_STORE_SUBSCRIBE = (): (() => void) => () => undefined;

/**
 * Select from the current settings store, or `undefined` outside a provider.
 * For shared UI that uses the store as an optional cache: hosts without one
 * (web) behave as if nothing were cached. The selector must return a stable
 * value for unchanged state.
 */
export function useOptionalSettingsStore<T>(
  selector: (state: SettingsStoreState) => T,
): T | undefined {
  const store = useContext(SettingsStoreContext);
  const read = (): T | undefined =>
    store === null ? undefined : selector(store.getState());
  return useSyncExternalStore(
    store === null ? NO_STORE_SUBSCRIBE : store.subscribe,
    read,
    read,
  );
}

/** The current settings store. Throws outside a provider. */
export function useSettingsStoreApi(): SettingsStore {
  const store = useContext(SettingsStoreContext);
  if (store === null)
    throw new Error(
      'useSettingsStore must be used within a <SettingsStoreProvider>.',
    );
  return store;
}

/** Select from the current settings store. */
export function useSettingsStore<T>(
  selector: (state: SettingsStoreState) => T,
): T {
  return useStore(useSettingsStoreApi(), selector);
}
