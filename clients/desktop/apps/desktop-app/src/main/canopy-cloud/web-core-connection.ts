import type {
  CanopyErrorPayload,
  CanopyRetryDirective,
} from '@canopy/protocol/canopy-core';
import { SettingsOperationError } from '@canopy/protocol/settings';
import { CanopyTransportError } from '@canopy/core-transport';
import { connectCanopyHttp } from '@canopy/core-transport/http';
import type { CanopyFramedConnection } from '@canopy/core-transport/types';
import type {
  RelayBindingConnection,
  RelayBindingProvider,
} from '../canopy-runtime/renderer-relay/definitions';
import { logMainProcessWarn } from '../lib/main-process-logging';
import type { SettingsBridgeSession } from './settings-session';

/**
 * Electron main's connection to the web core (CAN-4185 D1, D3).
 *
 * Every request, the `/events` SSE included, goes out from the hosted
 * settings bridge: the same-account Better Auth cookie session main minted
 * from the desktop credential. The web core runs its ordinary browser session
 * checks on it. The desktop credential itself never reaches the web core, and
 * nothing the renderer sends becomes a header or a credential.
 */

export const WEB_CORE_CONNECTIONS_PATH = '/api/cloud/core/connections';

/** The bridge surface this module uses; `SettingsBridgeSession` satisfies it. */
export type WebCoreBridgeSession = Pick<
  SettingsBridgeSession,
  'fetch' | 'retainStream' | 'onStateChange' | 'state'
>;

export interface WebCoreBindingOptions {
  /** `canopyDesktopCloudChats`, evaluated in main. */
  readonly isEnabled: () => boolean;
  /** The bridge session of the current account. */
  readonly acquireSession: () => Promise<WebCoreBridgeSession>;
}

const NEVER: CanopyRetryDirective = { kind: 'never' };

const DISABLED: CanopyErrorPayload = {
  kind: 'capability_unavailable',
  message: 'Cloud chats are not available.',
  retry: NEVER,
};

const SESSION_ENDED: CanopyErrorPayload = {
  kind: 'unauthenticated',
  message: 'The cloud session ended.',
  retry: NEVER,
};

const CLOSED: CanopyErrorPayload = {
  kind: 'cancelled',
  message: 'The connection was closed.',
  retry: NEVER,
};

/** What a bridge failure means for a cloud chats caller. */
export function webCoreBridgeFailure(
  error: unknown,
): 'offline' | 'unauthenticated' | 'failed' {
  if (error instanceof SettingsOperationError) {
    if (error.code === 'offline') return 'offline';
    if (error.code === 'expired' || error.code === 'unauthenticated')
      return 'unauthenticated';
  }
  return 'failed';
}

/** A bridge failure as the relay answers it; nothing else of it crosses. */
export function webCoreBridgeError(error: unknown): CanopyErrorPayload {
  switch (webCoreBridgeFailure(error)) {
    case 'offline':
      return {
        kind: 'unavailable',
        message: 'The cloud is unreachable.',
        retry: { kind: 'same_request' },
      };
    case 'unauthenticated':
      return SESSION_ENDED;
    case 'failed':
      return {
        kind: 'unavailable',
        message: 'The cloud session is unavailable.',
        retry: NEVER,
      };
  }
}

function plainHeaders(
  headers: HeadersInit | undefined,
): Record<string, string> {
  return Object.fromEntries(new Headers(headers).entries());
}

function requestBody(
  body: BodyInit | null | undefined,
): string | Uint8Array | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string' || body instanceof Uint8Array) return body;
  throw new TypeError('Unsupported web core request body.');
}

/** The response with a body that calls `release` once it ends, fails or is cancelled. */
function releasingResponse(
  response: Response,
  release: () => void,
  signal: AbortSignal | undefined,
): Response {
  const source = response.body;
  if (source === null) {
    release();
    return response;
  }
  const done = (): void => {
    signal?.removeEventListener('abort', done);
    release();
  };
  signal?.addEventListener('abort', done, { once: true });
  if (signal?.aborted) done();
  const reader = source.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller): Promise<void> {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          done();
          controller.close();
        } else controller.enqueue(chunk.value);
      } catch (error) {
        done();
        controller.error(error);
      }
    },
    cancel(reason): Promise<void> {
      done();
      return reader.cancel(reason);
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/** Parked subscriptions on one connection that log a warning, once. */
export const PARKED_SUBSCRIPTION_WARNING_AT = 16;

/**
 * The connection with a local stream release. The web core has no
 * per-subscription cancel (K1) and serves no unsubscribe, so a stream the
 * renderer closes is parked: the relay stops delivering and acknowledging it,
 * and the core holds at most its `maxInFlight` undelivered pushes until the
 * connection ends. Other streams keep running.
 */
function withParkedStreams(
  connection: CanopyFramedConnection,
): RelayBindingConnection {
  const parked = new Set<string>();
  return {
    connectionId: connection.connectionId,
    signal: connection.signal,
    send: (message) => connection.send(message),
    receive: (options) => connection.receive(options),
    openChannel: (request) => connection.openChannel(request),
    onChannel: (listener, options) => connection.onChannel(listener, options),
    close: (error) => connection.close(error),
    releaseStream: (subscriptionId, reason) => {
      if (reason === 'ended' || parked.has(subscriptionId)) return;
      parked.add(subscriptionId);
      if (parked.size === PARKED_SUBSCRIPTION_WARNING_AT)
        logMainProcessWarn(
          '[web-core] A web core connection holds 16 parked stream subscriptions.',
        );
    },
  };
}

function isEventsRequest(method: string, path: string): boolean {
  return method === 'GET' && path.split('?')[0]?.endsWith('/events') === true;
}

/**
 * One web core connection per relay session. The bridge session is acquired
 * per open, so after an account change (which disposes the bridge and ends
 * this connection) the next open mints for the new account.
 */
export function createWebCoreBindingProvider(
  options: WebCoreBindingOptions,
): RelayBindingProvider {
  return ({ signal }) => connectWebCore(options, signal);
}

/**
 * Opens one authenticated web core connection: the relay's sessions and
 * main's own requests, such as attachment uploads (CAN-5988), share it.
 */
export async function connectWebCore(
  options: WebCoreBindingOptions,
  signal: AbortSignal,
): Promise<RelayBindingConnection> {
  if (!options.isEnabled()) throw new CanopyTransportError(DISABLED);
  let session: WebCoreBridgeSession;
  try {
    session = await options.acquireSession();
  } catch (error) {
    throw new CanopyTransportError(webCoreBridgeError(error));
  }
  if (signal.aborted) throw new CanopyTransportError(CLOSED);

  // The transport reports a failed fetch only as unreachable; keep a typed
  // bridge reason so a setup failure answers with it. A raw network error
  // keeps the transport's retryable classification.
  let bridgeFailure: unknown = null;
  const fetch = async (
    path: string,
    init: RequestInit = {},
  ): Promise<Response> => {
    const method = (init.method ?? 'GET').toUpperCase();
    const requestSignal = init.signal ?? undefined;
    const release = isEventsRequest(method, path)
      ? session.retainStream()
      : null;
    try {
      const response = await session.fetch(path, {
        method,
        headers: plainHeaders(init.headers),
        body: requestBody(init.body),
        ...(requestSignal === undefined ? {} : { signal: requestSignal }),
        authOrigin: true,
      });
      return release === null
        ? response
        : releasingResponse(response, release, requestSignal);
    } catch (error) {
      release?.();
      if (error instanceof SettingsOperationError) bridgeFailure = error;
      throw error;
    }
  };

  const connection = await connectCanopyHttp({
    endpoint: WEB_CORE_CONNECTIONS_PATH,
    fetch,
    signal,
  }).catch((error: unknown) => {
    if (bridgeFailure !== null && !signal.aborted)
      throw new CanopyTransportError(webCoreBridgeError(bridgeFailure));
    throw error;
  });

  // The bridge ending (sign-out, account switch, key rotation or
  // revocation, idle, quit) or its web session expiring ends the connection.
  const stop = session.onStateChange((state) => {
    if (state === 'disposed' || state === 'expired')
      connection.close(SESSION_ENDED);
  });
  connection.signal.addEventListener('abort', stop, { once: true });
  if (session.state === 'disposed' || session.state === 'expired')
    connection.close(SESSION_ENDED);
  return withParkedStreams(connection);
}
