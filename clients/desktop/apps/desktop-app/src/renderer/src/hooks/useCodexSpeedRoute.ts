import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { CodexSpeedRouteFacts } from '@canopy/execution-engine/lib/codex-speed-availability';
import {
  isCodexSpeedReadRouteRequest,
  isCodexSpeedRouteFacts,
} from '@canopy/desktop-shared/lib/codex-speed-route';
import type { ReadCodexSpeedRouteRequest } from '@canopy/execution-engine/types/codex-speed-capabilities';
import { useCodexSpeedStore } from '../stores/codexSpeedStore';
import { useEnvironmentsStore } from '../stores/environmentsStore';
import {
  getRendererModelFactsVersion,
  subscribeRendererModelFacts,
} from '../stores/modelPolicyRuntime';

export interface UseCodexSpeedRouteOptions {
  request: ReadCodexSpeedRouteRequest | null;
  enabled?: boolean;
  /** Changes to local billing, captured harness or other routing inputs. */
  revalidationKey?: string;
}

export interface CodexSpeedRouteResult {
  route: CodexSpeedRouteFacts | null;
  status: 'loading' | 'ready' | 'unknown';
  refreshing: boolean;
  refresh: () => Promise<void>;
}

interface RouteState {
  key: object | null;
  route: CodexSpeedRouteFacts | null;
  status: CodexSpeedRouteResult['status'];
  refreshing: boolean;
}

/**
 * Read the host's route for this surface. The catalog owns refresh scheduling;
 * this hook rechecks on its invalidations, focus and explicit route changes.
 * Old answers never qualify a new context, and no private error crosses into UI.
 */
export function useCodexSpeedRoute({
  request,
  enabled = true,
  revalidationKey = '',
}: UseCodexSpeedRouteOptions): CodexSpeedRouteResult {
  const requestKey = request === null ? null : JSON.stringify(request);
  const stableRequest = useMemo((): ReadCodexSpeedRouteRequest | null => {
    if (requestKey === null) return null;
    const parsed: unknown = JSON.parse(requestKey);
    return isCodexSpeedReadRouteRequest(parsed) ? parsed : null;
  }, [requestKey]);
  const catalogKey = useCodexSpeedStore((state) =>
    JSON.stringify([
      state.catalog?.generation,
      state.catalog?.fetchedAt,
      state.catalog?.status,
    ]),
  );
  const environmentData = useEnvironmentsStore((value) => value.data);
  const modelFactsVersion = useSyncExternalStore(
    subscribeRendererModelFacts,
    getRendererModelFactsVersion,
    getRendererModelFactsVersion,
  );
  // Only compare identities. Environment values never enter the portable
  // request, a serialized key or the returned route projection.
  const key = useMemo(
    () => ({
      requestKey,
      catalogKey,
      revalidationKey,
      environmentData,
      modelFactsVersion,
    }),
    [
      requestKey,
      catalogKey,
      revalidationKey,
      environmentData,
      modelFactsVersion,
    ],
  );
  const [state, setState] = useState<RouteState>({
    key: null,
    route: null,
    status: 'unknown',
    refreshing: false,
  });
  const refreshRef = useRef<(() => Promise<void>) | null>(null);
  const refresh = useCallback(
    (): Promise<void> => refreshRef.current?.() ?? Promise.resolve(),
    [],
  );

  useEffect(() => {
    if (!enabled || stableRequest === null) return undefined;
    let alive = true;
    let flight: Promise<void> | null = null;
    const read = (): Promise<void> => {
      if (flight) return flight;
      const api = window.api?.codexSpeed;
      if (typeof api?.readRoute !== 'function') {
        setState({ key, route: null, status: 'unknown', refreshing: false });
        return Promise.resolve();
      }
      setState({ key, route: null, status: 'loading', refreshing: true });
      const perform = async (): Promise<void> => {
        try {
          const route: unknown = await api.readRoute(stableRequest);
          if (!alive) return;
          if (!isCodexSpeedRouteFacts(route)) {
            setState({
              key,
              route: null,
              status: 'unknown',
              refreshing: false,
            });
            return;
          }
          setState({
            key,
            route,
            status: route.routeProfile === 'unknown' ? 'unknown' : 'ready',
            refreshing: false,
          });
        } catch {
          if (alive)
            setState({
              key,
              route: null,
              status: 'unknown',
              refreshing: false,
            });
        }
      };
      flight = perform().finally(() => {
        flight = null;
      });
      return flight;
    };
    refreshRef.current = read;
    const readWhenVisible = (): void => {
      if (document.visibilityState === 'visible') void read();
    };
    document.addEventListener('visibilitychange', readWhenVisible);
    window.addEventListener('focus', readWhenVisible);
    readWhenVisible();
    return (): void => {
      alive = false;
      refreshRef.current = null;
      document.removeEventListener('visibilitychange', readWhenVisible);
      window.removeEventListener('focus', readWhenVisible);
    };
  }, [enabled, stableRequest, key]);

  const active = enabled && stableRequest !== null;
  const current = active && state.key === key ? state : null;
  return {
    route: current?.route ?? null,
    status: current?.status ?? (active ? 'loading' : 'unknown'),
    refreshing: current?.refreshing ?? false,
    refresh,
  };
}
