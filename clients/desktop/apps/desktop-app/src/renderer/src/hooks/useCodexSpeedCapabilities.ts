// One speed-selection surface's view of the main-owned Codex speed catalog.
//
// Main owns the catalog, the single active-consumer set, and the ONE expiry
// timer. While mounted, enabled, and visible, a surface registers itself as an
// active consumer so main keeps the catalog revalidated and pushes changes
// (expiry refreshes, denial expiry, account resets). The hook itself never
// schedules timers or polls: it reads only when the mirrored catalog is
// missing or expired, on mount, window focus, a return to visibility, or a
// model change. It reports availability and never selects a speed.

import { useEffect, useId, useMemo } from 'react';
import { useShallow } from 'zustand/shallow';
import type { CodexSpeed } from '@canopy/desktop-shared/lib/codex-speed';
import {
  deriveCodexSpeedOptions,
  type CodexSpeedAvailability,
  type CodexSpeedRouteFacts,
  type CodexSpeedRouteProfile,
} from '@canopy/desktop-shared/lib/codex-speed-availability';
import type {
  CodexSpeedCatalog,
  CodexSpeedCatalogRoute,
} from '@canopy/desktop-shared/types/codex-speed-capabilities';
import {
  isCodexSpeedCatalogStale,
  retainCodexSpeedSubscription,
  useCodexSpeedStore,
} from '../stores/codexSpeedStore';

export interface UseCodexSpeedCapabilitiesOptions {
  /** When false the surface is not mounted-active: no setActive(true), no reads. Default true. */
  enabled?: boolean;
  /** Model the surface shows; a change triggers a stale-only read. */
  model?: string | null;
  /** Actual route facts; when provided, per-speed availability is derived. */
  route?: CodexSpeedRouteFacts | null;
  /**
   * The surface's route profile. The account proxy route also needs the
   * proxy's own Codex catalog, which is then read and kept fresh.
   */
  routeProfile?: CodexSpeedRouteProfile | null;
}

export interface CodexSpeedCapabilities {
  catalog: CodexSpeedCatalog | null;
  /** 'loading' until the first catalog arrives, then the catalog status. */
  status: 'loading' | 'ready' | 'unknown';
  /** True while a capability read from this renderer is in flight. */
  refreshing: boolean;
  /** The renderer read failure, else the catalog's own error, else null. */
  error: string | null;
  /** deriveCodexSpeedOptions({catalog, route, now: Date.now()}) or null without route. */
  options: Record<CodexSpeed, CodexSpeedAvailability> | null;
  /** Explicit refresh (force). */
  refresh: () => Promise<void>;
}

const CONSUMER_ID_PREFIX = 'codex-speed-';
const MAX_CONSUMER_ID_LENGTH = 128;
const CONSUMER_ID_DISALLOWED = /[^A-Za-z0-9:_-]/g;

/** A main-safe consumer id (`/^[A-Za-z0-9][A-Za-z0-9:_-]*$/`, ≤128 chars). */
function toConsumerId(reactId: string): string {
  const suffix = reactId.replace(CONSUMER_ID_DISALLOWED, '');
  return `${CONSUMER_ID_PREFIX}${suffix}`.slice(0, MAX_CONSUMER_ID_LENGTH);
}

function isDocumentVisible(): boolean {
  return document.visibilityState === 'visible';
}

/** The route whose own catalog a profile needs, if any. */
export function codexSpeedCatalogRouteFor(
  profile: CodexSpeedRouteProfile | null | undefined,
): CodexSpeedCatalogRoute | undefined {
  return profile === 'account-proxy' ? 'account-proxy' : undefined;
}

/** Read only when the mirrored catalog (or the route's list) is missing or expired. */
function readIfStale(route?: CodexSpeedCatalogRoute): void {
  const store = useCodexSpeedStore.getState();
  if (isCodexSpeedCatalogStale(store.catalog, Date.now(), route)) {
    void store.read(route ? { route } : undefined);
  }
}

/**
 * Keep the route's own catalog read for a surface whose route needs it, for
 * example once a host route projection resolves to the account proxy.
 */
export function useCodexSpeedRouteCatalog(
  enabled: boolean,
  profile: CodexSpeedRouteProfile | null | undefined,
): void {
  const route = codexSpeedCatalogRouteFor(profile);
  useEffect(() => {
    if (!enabled || !route) return undefined;
    if (isDocumentVisible()) readIfStale(route);
    const handleFocus = (): void => {
      if (isDocumentVisible()) readIfStale(route);
    };
    window.addEventListener('focus', handleFocus);
    document.addEventListener('visibilitychange', handleFocus);
    return (): void => {
      window.removeEventListener('focus', handleFocus);
      document.removeEventListener('visibilitychange', handleFocus);
    };
  }, [enabled, route]);
}

/** The route facts by value, so callers may pass a new object every render. */
function routeFactsKey(route: CodexSpeedRouteFacts): string {
  return JSON.stringify([
    route.modelSelection,
    route.runtimeModel,
    route.equivalentModels ?? null,
    route.modelSource,
    route.harness,
    route.routeProfile,
  ]);
}

/** Explicit refresh: always forces main to revalidate (still deduplicated). */
function refreshCodexSpeedCapabilities(): Promise<void> {
  return useCodexSpeedStore.getState().read({ force: true });
}

export function useCodexSpeedCapabilities(
  options: UseCodexSpeedCapabilitiesOptions = {},
): CodexSpeedCapabilities {
  const enabled = options.enabled ?? true;
  const model = options.model ?? null;
  const route = options.route ?? null;
  useCodexSpeedRouteCatalog(
    enabled,
    options.routeProfile ?? route?.routeProfile ?? null,
  );
  const reactId = useId();
  const consumerId = useMemo(() => toConsumerId(reactId), [reactId]);
  const { catalog, refreshing, storeError } = useCodexSpeedStore(
    useShallow((state) => ({
      catalog: state.catalog,
      refreshing: state.pendingReads > 0,
      storeError: state.error,
    })),
  );

  // Follow pushes while enabled, and tell main this surface is active only
  // while it is also visible. `active` is the last state sent to main, so
  // repeated visibility events never send a duplicate.
  useEffect(() => {
    if (!enabled) return undefined;
    const release = retainCodexSpeedSubscription();
    let active = false;
    const setActive = (next: boolean): void => {
      if (active === next) return;
      active = next;
      void useCodexSpeedStore.getState().setConsumerActive(consumerId, next);
    };
    const handleVisibilityChange = (): void => {
      if (isDocumentVisible()) {
        setActive(true);
        readIfStale();
      } else {
        setActive(false);
      }
    };
    const handleFocus = (): void => {
      if (isDocumentVisible()) readIfStale();
    };
    if (isDocumentVisible()) setActive(true);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('focus', handleFocus);
    return (): void => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('focus', handleFocus);
      setActive(false);
      release();
    };
  }, [enabled, consumerId]);

  // Mount, enable, and model changes read only a missing or expired catalog.
  // `model` is a trigger: the catalog covers every model of the sign-in.
  useEffect(() => {
    if (enabled && isDocumentVisible()) readIfStale();
  }, [enabled, model]);

  const routeKey = route === null ? null : routeFactsKey(route);
  const speedOptions = useMemo(
    () =>
      route === null
        ? null
        : deriveCodexSpeedOptions({ catalog, route, now: Date.now() }),
    // Keyed by the route's facts rather than its identity (see routeFactsKey).
    // A new catalog, including main's expiry pushes, re-derives with a new now.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [catalog, routeKey],
  );

  const status = catalog === null ? 'loading' : catalog.status;
  const error = storeError ?? catalog?.error ?? null;

  return useMemo<CodexSpeedCapabilities>(
    () => ({
      catalog,
      status,
      refreshing,
      error,
      options: speedOptions,
      // Module-level, so its identity is stable across renders and mounts.
      refresh: refreshCodexSpeedCapabilities,
    }),
    [catalog, status, refreshing, error, speedOptions],
  );
}
