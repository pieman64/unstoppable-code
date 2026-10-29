import type { PostHog } from 'posthog-js/dist/module.full.no-external';
import {
  POSTHOG_MAIN_ROUTE,
  POSTHOG_CURRENT_URL_PROPERTY,
  POSTHOG_PAGELEAVE_EVENT,
  POSTHOG_PAGEVIEW_EVENT,
  POSTHOG_SCREEN_ROUTE_PROPERTY,
  buildPostHogRouteProperties,
  toPostHogRoute,
  type PostHogRoute,
} from '../posthog-routes';
import type { PostHogRouteSource } from '../types';

type ScreenTrackingSdk = Pick<
  PostHog,
  'capture' | 'register_for_session' | 'unregister_for_session'
>;

interface PageLifecycleTarget {
  addEventListener(type: 'pagehide', listener: () => void): void;
  removeEventListener(type: 'pagehide', listener: () => void): void;
}

interface PostHogScreenTrackerOptions {
  sdk: ScreenTrackingSdk;
  source: PostHogRouteSource;
  captureEnabled: boolean;
  allowsCapture: () => boolean;
  onAdopted: (listener: (sessionId: string) => void) => () => void;
  onCaptureAvailable: (listener: () => void) => () => void;
  /** Runs with the route being left, before its leave and the next view. */
  onRouteLeave?: (route: PostHogRoute) => void;
  pageLifecycle?: PageLifecycleTarget;
}

export interface PostHogScreenTracker {
  readonly route: PostHogRoute;
  setCaptureEnabled(enabled: boolean): void;
  dispose(): void;
}

/**
 * Owns one renderer window's manual PostHog screen lifecycle.
 *
 * The four state variables are deliberately explicit: the latest route, the
 * route with an admitted page view, the capture gate, and the closed state.
 * Session super properties help SDK consumers, while `before_send` remains
 * the authoritative outbound route stamp.
 */
export function createPostHogScreenTracker({
  sdk,
  source,
  captureEnabled: initiallyEnabled,
  allowsCapture,
  onAdopted,
  onCaptureAvailable,
  onRouteLeave,
  pageLifecycle,
}: PostHogScreenTrackerOptions): PostHogScreenTracker {
  let latestRoute = toPostHogRoute(source.getSnapshot()) ?? POSTHOG_MAIN_ROUTE;
  let admittedRoute: PostHogRoute | null = null;
  let captureEnabled = false;
  let closed = false;
  let pageExited = false;
  let unsubscribeSource: (() => void) | undefined;

  const safely = (action: () => void): void => {
    try {
      action();
    } catch {
      // Product instrumentation must never perturb renderer state changes.
    }
  };

  const registerRoute = (): void => {
    safely(() =>
      sdk.register_for_session(buildPostHogRouteProperties(latestRoute)),
    );
  };

  const capture = (
    event: typeof POSTHOG_PAGEVIEW_EVENT | typeof POSTHOG_PAGELEAVE_EVENT,
    route: PostHogRoute,
    options?: { transport: 'sendBeacon' },
  ): void => {
    safely(() => {
      if (options) {
        sdk.capture(event, buildPostHogRouteProperties(route), options);
      } else {
        sdk.capture(event, buildPostHogRouteProperties(route));
      }
    });
  };

  const admitLatestRoute = (): void => {
    if (!captureEnabled || closed || pageExited || !allowsCapture()) return;
    registerRoute();
    capture(POSTHOG_PAGEVIEW_EVENT, latestRoute);
    admittedRoute = latestRoute;
  };

  const handleRoute = (candidate: PostHogRoute): void => {
    if (closed || pageExited) return;
    const next = toPostHogRoute(candidate);
    if (next === null || next === latestRoute) return;
    const left = latestRoute;
    if (onRouteLeave) safely(() => onRouteLeave(left));
    const previous = admittedRoute;
    latestRoute = next;
    if (!captureEnabled) return;
    if (previous !== null) {
      capture(POSTHOG_PAGELEAVE_EVENT, previous);
      admittedRoute = null;
    }
    admitLatestRoute();
  };

  const ensureSourceSubscription = (): void => {
    if (unsubscribeSource) return;
    latestRoute = toPostHogRoute(source.getSnapshot()) ?? POSTHOG_MAIN_ROUTE;
    unsubscribeSource = source.subscribe(handleRoute);
  };

  const setCaptureEnabled = (enabled: boolean): void => {
    if (closed || pageExited || enabled === captureEnabled) return;
    captureEnabled = enabled;
    if (!enabled) {
      // The runtime controller has already closed the gate. Clear the admitted
      // interval without trying to force a leave through that closed gate.
      admittedRoute = null;
      unsubscribeSource?.();
      unsubscribeSource = undefined;
      return;
    }
    ensureSourceSubscription();
    admitLatestRoute();
  };

  const unsubscribeAdopted = onAdopted(() => {
    if (!closed) registerRoute();
  });
  const unsubscribeCaptureAvailable = onCaptureAvailable(() => {
    if (admittedRoute === null) admitLatestRoute();
  });

  const handlePageHide = (): void => {
    if (closed || pageExited) return;
    pageExited = true;
    if (captureEnabled && admittedRoute !== null) {
      capture(POSTHOG_PAGELEAVE_EVENT, admittedRoute, {
        transport: 'sendBeacon',
      });
    }
    admittedRoute = null;
  };
  pageLifecycle?.addEventListener('pagehide', handlePageHide);

  setCaptureEnabled(initiallyEnabled);

  return {
    get route(): PostHogRoute {
      return latestRoute;
    },
    setCaptureEnabled,
    dispose(): void {
      if (closed) return;
      closed = true;
      pageLifecycle?.removeEventListener('pagehide', handlePageHide);
      unsubscribeSource?.();
      unsubscribeSource = undefined;
      unsubscribeAdopted();
      unsubscribeCaptureAvailable();
      safely(() => sdk.unregister_for_session(POSTHOG_SCREEN_ROUTE_PROPERTY));
      safely(() => sdk.unregister_for_session(POSTHOG_CURRENT_URL_PROPERTY));
      admittedRoute = null;
    },
  };
}
