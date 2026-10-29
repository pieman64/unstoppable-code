import type { CanopyClient } from '@canopy/app-core';
import { useCanopyClientStore } from './CanopyClientProvider';
import type { ClientStore } from './client-store-lifecycle';
export {
  CLIENT_STORE_ACTIVATE,
  CLIENT_STORE_DISPOSE,
  type ClientStore,
} from './client-store-lifecycle';

/**
 * The store-factory pattern for `@canopy/app-state`.
 *
 * Shared stores normally cannot be module-level singletons that reach for a transport,
 * because the transport (`CanopyClient`) is injected per host. Instead each
 * store is defined as a factory `(client) => create(...)` and wrapped with
 * `createClientStore`, which returns a selector hook.
 *
 * The underlying Zustand store is created lazily, once per provider/client
 * lifecycle. A client swap transparently gets a fresh store, and the provider
 * disposes the old store before releasing its transport subscriptions.
 *
 * Approved exception: `@canopy/app-state/terminal` owns module-level terminal
 * stores for shared desktop/web pane identity. Hosts call bindTerminalClient
 * and retain its disposer; disposal/rebinding releases transport feeds, cancels
 * pending work and resets both stores. Web hosts bind only on the client, never
 * during server rendering. The terminal slice is not exported from this barrel.
 *
 * Concrete stores (chat, file-viewer, activity, overview) are added by later
 * feature-slice tickets; this scaffold establishes the pattern only.
 *
 * @example
 *   const useChatStore = createClientStore((client) => createChatStore(client));
 *   const messages = useChatStore((s) => s.messages);
 */
export function createClientStore<TState>(
  factory: (client: CanopyClient) => ClientStore<TState>,
): <TSelected>(selector: (state: TState) => TSelected) => TSelected {
  const storeKey = Symbol('client-store');

  return function useClientStore<TSelected>(
    selector: (state: TState) => TSelected,
  ): TSelected {
    const store = useCanopyClientStore(storeKey, factory);
    return store(selector);
  };
}
