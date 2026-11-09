// Renderer mirror of the main-owned Codex speed capability catalog
// (`window.api.codexSpeed`).
//
// Main owns discovery, the cache, the single active-consumer set, and the ONE
// expiry timer. This store only mirrors it: it reads on request, follows
// `onChanged` pushes through one refcounted subscription, and never schedules
// timers or polls. Read answers and pushes both go through `applyCatalog`,
// which adopts a catalog only when it is at least as new as the mirrored one
// (generation first, then `fetchedAt`), so out-of-order IPC can never regress
// the mirror to an older account generation or an older fetch.

import { create, type StoreApi, type UseBoundStore } from 'zustand';
import {
  isCodexSpeedCatalog,
  shouldAcceptCodexSpeedCatalog,
} from '@canopy/execution-engine/lib/codex-speed-availability';
import type {
  CodexSpeedApi,
  CodexSpeedCatalog,
  CodexSpeedCatalogRoute,
} from '@canopy/execution-engine/types/codex-speed-capabilities';
import { reportRendererConsoleError } from '../lib/renderer-error-logging';

const READ_FAILURE_MESSAGE =
  "Couldn't check Codex speed availability. Try again.";

export interface CodexSpeedStoreState {
  catalog: CodexSpeedCatalog | null;
  /** Number of readCapabilities calls in flight from this renderer. */
  pendingReads: number;
  /** Sanitized renderer-side failure (IPC rejected), else null. */
  error: string | null;
  /** Adopt `catalog` unless it is older than the mirror (generation, then fetchedAt). */
  applyCatalog: (catalog: CodexSpeedCatalog) => void;
  /**
   * Ask main for the catalog; never rejects. Concurrent normal reads share one
   * request, and an in-flight forced read (explicit refresh) answers them too.
   * Once a surface asks for a route's own list, every later read includes it.
   */
  read: (options?: {
    force?: boolean;
    route?: CodexSpeedCatalogRoute;
  }) => Promise<void>;
  /** Tell main whether one mounted, visible surface is active; never rejects. */
  setConsumerActive: (consumerId: string, active: boolean) => Promise<void>;
}

function getCodexSpeedApi(): CodexSpeedApi | undefined {
  return typeof window !== 'undefined' ? window.api?.codexSpeed : undefined;
}

/** Bumped by the test reset so late answers from earlier work stay inert. */
let epoch = 0;
/** The in-flight normal read, which every concurrent normal read shares. */
let normalRead: Promise<void> | null = null;
/** The in-flight forced read, which concurrent refreshes share. */
let forcedRead: Promise<void> | null = null;
/** Whether reads include the account proxy route's own list. */
let accountProxyRouteRequested = false;
/** Whether each in-flight read was started with the route list. */
let normalReadHasRoute = false;
let forcedReadHasRoute = false;
let subscriptionHolders = 0;
let disposeSubscription: (() => void) | null = null;

export const useCodexSpeedStore: UseBoundStore<StoreApi<CodexSpeedStoreState>> =
  create<CodexSpeedStoreState>((set, get) => {
    const applyCatalog = (catalog: CodexSpeedCatalog): void => {
      if (!isCodexSpeedCatalog(catalog)) {
        reportRendererConsoleError('Ignored an invalid Codex speed catalog');
        return;
      }
      if (!shouldAcceptCodexSpeedCatalog(get().catalog, catalog)) return;
      set({ catalog, error: null });
    };

    const performRead = async (
      api: CodexSpeedApi,
      force: boolean,
      startedEpoch: number,
    ): Promise<void> => {
      try {
        const catalog = await api.readCapabilities(
          force || accountProxyRouteRequested
            ? {
                ...(force ? { force: true } : {}),
                ...(accountProxyRouteRequested
                  ? { route: 'account-proxy' as const }
                  : {}),
              }
            : undefined,
        );
        if (startedEpoch !== epoch) return;
        if (!isCodexSpeedCatalog(catalog)) {
          reportRendererConsoleError(
            'Codex speed capability read returned an invalid catalog',
          );
          set({ error: READ_FAILURE_MESSAGE });
          return;
        }
        applyCatalog(catalog);
        // applyCatalog adopted this answer or kept a newer catalog, so the
        // mirror is current and an earlier read failure no longer applies.
        if (get().error !== null) set({ error: null });
      } catch (error) {
        if (startedEpoch !== epoch) return;
        reportRendererConsoleError('Failed to read Codex speed capabilities', {
          error,
        });
        set({ error: READ_FAILURE_MESSAGE });
      }
    };

    const startRead = (api: CodexSpeedApi, force: boolean): Promise<void> => {
      const startedEpoch = epoch;
      set((state) => ({ pendingReads: state.pendingReads + 1 }));
      // `finally` callbacks always run asynchronously, so `flight` is assigned
      // before its slot is cleared, even when the bridge throws synchronously.
      const flight: Promise<void> = performRead(
        api,
        force,
        startedEpoch,
      ).finally(() => {
        if (normalRead === flight) normalRead = null;
        if (forcedRead === flight) forcedRead = null;
        if (startedEpoch !== epoch) return;
        set((state) => ({ pendingReads: Math.max(0, state.pendingReads - 1) }));
      });
      if (force) {
        forcedRead = flight;
        forcedReadHasRoute = accountProxyRouteRequested;
      } else {
        normalRead = flight;
        normalReadHasRoute = accountProxyRouteRequested;
      }
      return flight;
    };

    return {
      catalog: null,
      pendingReads: 0,
      error: null,
      applyCatalog,
      read: (options): Promise<void> => {
        const force = options?.force === true;
        if (options?.route === 'account-proxy') {
          accountProxyRouteRequested = true;
        }
        // A forced read bypasses main's fresh cache, so it also answers a
        // normal read; a normal read can never stand in for a forced one.
        // A read started without the route list cannot answer one that needs it.
        const usable = (
          flight: Promise<void> | null,
          hasRoute: boolean,
        ): Promise<void> | null =>
          flight && (hasRoute || !accountProxyRouteRequested) ? flight : null;
        const inFlight = force
          ? usable(forcedRead, forcedReadHasRoute)
          : (usable(normalRead, normalReadHasRoute) ??
            usable(forcedRead, forcedReadHasRoute));
        if (inFlight) return inFlight;
        const api = getCodexSpeedApi();
        if (!api || typeof api.readCapabilities !== 'function') {
          return Promise.resolve();
        }
        return startRead(api, force);
      },
      setConsumerActive: async (consumerId, active): Promise<void> => {
        const api = getCodexSpeedApi();
        if (!api || typeof api.setActive !== 'function') return;
        try {
          await api.setActive({ consumerId, active });
        } catch (error) {
          reportRendererConsoleError('Failed to update Codex speed consumer', {
            consumerId,
            active,
            error,
          });
        }
      },
    };
  });

/** Refcounted single window.api.codexSpeed.onChanged subscription; returns a release fn. */
export function retainCodexSpeedSubscription(): () => void {
  const retainedEpoch = epoch;
  subscriptionHolders += 1;
  if (subscriptionHolders === 1) {
    const api = getCodexSpeedApi();
    if (api && typeof api.onChanged === 'function') {
      disposeSubscription = api.onChanged((catalog) => {
        useCodexSpeedStore.getState().applyCatalog(catalog);
      });
    }
  }
  let released = false;
  return (): void => {
    if (released) return;
    released = true;
    if (retainedEpoch !== epoch) return;
    subscriptionHolders -= 1;
    if (subscriptionHolders > 0) return;
    const dispose = disposeSubscription;
    disposeSubscription = null;
    dispose?.();
  };
}

/**
 * True when catalog is null, has expiresAt null, or expiresAt <= now; with a
 * route, also when that route's own list is missing or expired.
 */
export function isCodexSpeedCatalogStale(
  catalog: CodexSpeedCatalog | null,
  now: number,
  route?: CodexSpeedCatalogRoute,
): boolean {
  if (
    catalog === null ||
    catalog.expiresAt === null ||
    catalog.expiresAt <= now
  ) {
    return true;
  }
  if (!route) return false;
  const routeCatalog = catalog.routes?.[route];
  return (
    !routeCatalog ||
    routeCatalog.expiresAt === null ||
    routeCatalog.expiresAt <= now
  );
}

/**
 * Test-only: clear the mirror, in-flight reads, and the subscription. Reads and
 * releases started before the reset become inert.
 */
export function resetCodexSpeedStoreForTests(): void {
  epoch += 1;
  const dispose = disposeSubscription;
  disposeSubscription = null;
  subscriptionHolders = 0;
  normalRead = null;
  forcedRead = null;
  accountProxyRouteRequested = false;
  normalReadHasRoute = false;
  forcedReadHasRoute = false;
  dispose?.();
  useCodexSpeedStore.setState({ catalog: null, pendingReads: 0, error: null });
}
