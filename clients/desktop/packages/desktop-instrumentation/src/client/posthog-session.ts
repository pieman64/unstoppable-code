import type { CaptureResult, PostHog } from 'posthog-js';
import type { PostHogSessionState } from '@canopy/execution-engine/types/observability';
import {
  isPostHogSessionState,
  isValidPostHogSessionId,
} from '../posthog-session';

export interface PostHogSessionBridge {
  get(): Promise<PostHogSessionState>;
  report(proposal: PostHogSessionState): Promise<PostHogSessionState>;
  subscribe(callback: (state: PostHogSessionState) => void): () => void;
}

type SessionSdk = Pick<PostHog, 'onSessionId' | 'capture'> & {
  requestRouter?: Pick<PostHog['requestRouter'], 'endpointFor'>;
  sessionManager?: Pick<
    NonNullable<PostHog['sessionManager']>,
    'setBootstrapSessionId'
  >;
};

export interface PostHogSessionConnection {
  readonly sessionId: string;
  start(): void;
  onAdopted(listener: (sessionId: string) => void): () => void;
  onCaptureAvailable(listener: () => void): () => void;
  allowsCapture(): boolean;
  filter(event: CaptureResult | null): CaptureResult | null;
  dispose(this: void): void;
}

/** Owns the SDK subscription for one renderer. Only main's snapshots may
 * authorize captures; SDK rotations are proposals until main replies. */
export async function connectPostHogSession(
  sdk: SessionSdk,
  bridge: PostHogSessionBridge,
): Promise<PostHogSessionConnection> {
  let state: PostHogSessionState | undefined;
  let started = false;
  let applying = false;
  let pending = false;
  let disposed = false;
  let unavailable = false;
  let adoptedSessionId: string | undefined;
  const queued: CaptureResult[] = [];
  const adoptedListeners = new Set<(sessionId: string) => void>();
  const captureAvailableListeners = new Set<() => void>();
  let unsubscribeSdk: (() => void) | undefined;

  const allowsCapture = (): boolean =>
    !disposed && !unavailable && !pending && !!state;
  const notifyIfCaptureRestored = (wasAvailable: boolean): void => {
    if (wasAvailable || !allowsCapture()) return;
    for (const listener of Array.from(captureAvailableListeners)) {
      try {
        listener();
      } catch {
        // Instrumentation listeners cannot interrupt session recovery.
      }
    }
  };

  const apply = (next: PostHogSessionState): void => {
    if (disposed || !isPostHogSessionState(next)) return;
    if (state && next.revision < state.revision) return;
    state = next;
    if (started) {
      applying = true;
      try {
        if (!sdk.sessionManager?.setBootstrapSessionId(next.sessionId)) {
          throw new Error('PostHog session adoption failed');
        }
      } finally {
        applying = false;
      }
      if (next.sessionId !== adoptedSessionId) {
        adoptedSessionId = next.sessionId;
        for (const listener of Array.from(adoptedListeners)) {
          try {
            listener(next.sessionId);
          } catch {
            // Instrumentation listeners cannot interrupt authoritative
            // adoption or the buffered-event drain ordered after it.
          }
        }
      }
    }
  };
  // Subscribe before fetching so an update racing the initial response wins.
  const unsubscribeHost = bridge.subscribe((next) => {
    const wasAvailable = allowsCapture();
    try {
      apply(next);
      if (unavailable && isPostHogSessionState(next)) {
        unavailable = false;
      }
      notifyIfCaptureRestored(wasAvailable);
    } catch {
      unavailable = true;
    }
  });
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    queued.length = 0;
    adoptedListeners.clear();
    captureAvailableListeners.clear();
    unsubscribeHost();
    unsubscribeSdk?.();
  };
  try {
    const initial = await bridge.get();
    if (!isPostHogSessionState(initial))
      throw new Error('PostHog session is unavailable');
    apply(initial);
  } catch (error) {
    dispose();
    throw error;
  }

  const drain = (): void => {
    if (disposed || pending || !state) return;
    for (const event of queued.splice(0)) {
      if (event.event === '$snapshot') {
        if (event.properties.$session_id !== state.sessionId) continue;
        const endpoint = sdk.requestRouter?.endpointFor('api', '/s/');
        if (!endpoint) continue;
        sdk.capture(
          event.event,
          { ...event.properties },
          {
            timestamp: event.timestamp,
            _url: endpoint,
            _noTruncate: true,
            _batchKey: 'recordings',
            skip_client_rate_limiting: true,
          },
        );
        continue;
      }
      const properties = { ...event.properties };
      delete properties.$session_id;
      delete properties.$window_id;
      sdk.capture(event.event, properties, { timestamp: event.timestamp });
    }
  };

  return {
    get sessionId(): string {
      if (!state) throw new Error('PostHog session is unavailable');
      return state.sessionId;
    },
    start(): void {
      started = true;
      // Catch up to a host update received between bootstrap and SDK init.
      if (!state) throw new Error('PostHog session is unavailable');
      apply(state);
      unsubscribeSdk = sdk.onSessionId((sessionId) => {
        if (disposed || applying || !state || sessionId === state.sessionId)
          return;
        if (!isValidPostHogSessionId(sessionId) || pending) return;
        pending = true;
        const proposal = { sessionId, revision: state.revision };
        void Promise.resolve()
          .then(() => bridge.report(proposal))
          .then((next) => {
            if (disposed) return;
            if (!isPostHogSessionState(next))
              throw new Error('Invalid PostHog session response');
            const wasAvailable = allowsCapture();
            apply(next);
            pending = false;
            unavailable = false;
            drain();
            notifyIfCaptureRestored(wasAvailable);
          })
          .catch(() => {
            // Fail closed on a disconnected host. A later host broadcast can
            // restore authority; never send a renderer-only session.
            queued.length = 0;
            pending = false;
            unavailable = true;
          });
      });
    },
    onAdopted(listener): () => void {
      if (disposed) return (): void => undefined;
      adoptedListeners.add(listener);
      let subscribed = true;
      return (): void => {
        if (!subscribed) return;
        subscribed = false;
        adoptedListeners.delete(listener);
      };
    },
    onCaptureAvailable(listener): () => void {
      if (disposed) return (): void => undefined;
      captureAvailableListeners.add(listener);
      return (): void => {
        captureAvailableListeners.delete(listener);
      };
    },
    allowsCapture(): boolean {
      return allowsCapture();
    },
    filter(event: CaptureResult | null): CaptureResult | null {
      if (!event || disposed || unavailable || !state) return null;
      if (pending) {
        // Bound memory while IPC is unavailable. Only sanitized events enter.
        if (queued.length < 100) queued.push(event);
        return null;
      }
      if (event.event === '$snapshot') {
        return event.properties.$session_id === state.sessionId ? event : null;
      }
      return {
        ...event,
        properties: { ...event.properties, $session_id: state.sessionId },
      };
    },
    dispose,
  };
}
