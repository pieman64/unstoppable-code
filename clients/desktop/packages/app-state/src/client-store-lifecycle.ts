import type { StoreApi, UseBoundStore } from 'zustand';

/** Optional lifecycle hook owned by a provider-scoped store instance. */
export const CLIENT_STORE_ACTIVATE = Symbol('client-store-activate');
export const CLIENT_STORE_DISPOSE = Symbol('client-store-dispose');

export type ClientStore<TState> = UseBoundStore<StoreApi<TState>> & {
  [CLIENT_STORE_ACTIVATE]?: () => void;
  [CLIENT_STORE_DISPOSE]?: () => void;
};
