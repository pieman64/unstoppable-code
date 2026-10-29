import type { SharedContainerRealtimeSignal } from '@canopy/protocol/realtime';
import { getCanopyCloudCredentials } from '../lib/canopy-cloud-account-store';
import { parseSseEvents } from '../plans/plan-realtime-subscription';

const BASE_RETRY_MS = 5_000;
const MAX_RETRY_MS = 5 * 60_000;
const BASE_NOT_FOUND_RETRY_MS = 60_000;
const MAX_NOT_FOUND_RETRY_MS = 15 * 60_000;

interface RealtimeCredentials {
  baseUrl: string;
  apiKey: string;
}

export interface SharedContainerRealtimeResponse {
  status: number;
  ok: boolean;
  body: ReadableStream<Uint8Array> | null;
}

export type SharedContainerRealtimeFetch = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal },
) => Promise<SharedContainerRealtimeResponse>;

export interface CreateSharedContainerRealtimeSubscriptionOptions {
  containerId: string;
  /** Ownership hint; absent for a personal container shared directly. */
  organizationId?: string;
  onSignal: (signal: SharedContainerRealtimeSignal) => void;
  onAccessDenied?: () => void;
  getCredentials?: () => Promise<RealtimeCredentials>;
  fetchImpl?: SharedContainerRealtimeFetch;
  delayImpl?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export interface SharedContainerRealtimeSubscription {
  stop(): void;
}

export interface CreateSharedContainerInboxSubscriptionOptions {
  onSignal: () => void;
  onAccessDenied?: () => void;
  getCredentials?: () => Promise<RealtimeCredentials>;
  fetchImpl?: SharedContainerRealtimeFetch;
  delayImpl?: (ms: number, signal: AbortSignal) => Promise<void>;
}

function defaultDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const finish = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
  });
}

function parseSignal(data: string): SharedContainerRealtimeSignal | null {
  try {
    const parsed: unknown = JSON.parse(data);
    if (!parsed || typeof parsed !== 'object') return null;
    const record = parsed as Record<string, unknown>;
    const candidate =
      record.payload && typeof record.payload === 'object'
        ? (record.payload as Record<string, unknown>)
        : record;
    return typeof candidate.containerId === 'string' &&
      typeof candidate.revision === 'number' &&
      Number.isInteger(candidate.revision) &&
      candidate.revision >= 0
      ? {
          containerId: candidate.containerId,
          revision: candidate.revision,
        }
      : null;
  } catch {
    return null;
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function isTerminalCredentialError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'CanopyCloudConfigError' ||
      error.message.includes('API key is not configured'))
  );
}

export function createSharedContainerRealtimeSubscription(
  options: CreateSharedContainerRealtimeSubscriptionOptions,
): SharedContainerRealtimeSubscription {
  const controller = new AbortController();
  const fetchImpl: SharedContainerRealtimeFetch =
    options.fetchImpl ?? ((url, init): Promise<Response> => fetch(url, init));
  const getCredentials = options.getCredentials ?? getCanopyCloudCredentials;
  const delayImpl = options.delayImpl ?? defaultDelay;
  let stopped = false;
  let lastEventId: string | null = null;

  const consume = async (body: ReadableStream<Uint8Array>): Promise<void> => {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        const parsed = parseSseEvents(buffer);
        buffer = parsed.remainder;
        for (const event of parsed.events) {
          if (event.id !== null) lastEventId = event.id;
          if (event.event !== 'sharedcontainer.detail') continue;
          const signal = parseSignal(event.data);
          if (signal && signal.containerId === options.containerId) {
            options.onSignal(signal);
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  };

  const run = async (): Promise<void> => {
    let attempt = 0;
    let notFoundAttempt = 0;
    while (!stopped) {
      let retryKind: 'normal' | 'not-found' = 'normal';
      try {
        const { baseUrl, apiKey } = await getCredentials();
        const query = new URLSearchParams();
        if (options.organizationId !== undefined) {
          query.set('organizationId', options.organizationId);
        }
        const serializedQuery = query.toString();
        const headers: Record<string, string> = {
          Accept: 'text/event-stream',
          Authorization: `Bearer ${apiKey}`,
        };
        if (lastEventId !== null) headers['Last-Event-ID'] = lastEventId;
        const response = await fetchImpl(
          `${baseUrl}/api/v1/shared-containers/${encodeURIComponent(options.containerId)}/stream${serializedQuery ? `?${serializedQuery}` : ''}`,
          { headers, signal: controller.signal },
        );
        if (response.status === 401 || response.status === 403) {
          options.onAccessDenied?.();
          return;
        }
        if (response.status === 404) {
          retryKind = 'not-found';
        } else if (!response.ok || !response.body) {
          retryKind = 'normal';
        } else {
          attempt = 0;
          notFoundAttempt = 0;
          await consume(response.body);
        }
      } catch (error) {
        if (
          stopped ||
          controller.signal.aborted ||
          isAbortError(error) ||
          isTerminalCredentialError(error)
        ) {
          return;
        }
      }
      if (stopped) return;
      const waitMs =
        retryKind === 'not-found'
          ? Math.min(
              BASE_NOT_FOUND_RETRY_MS * 2 ** notFoundAttempt++,
              MAX_NOT_FOUND_RETRY_MS,
            )
          : Math.min(BASE_RETRY_MS * 2 ** attempt++, MAX_RETRY_MS);
      await delayImpl(waitMs, controller.signal);
    }
  };

  void run();
  return {
    stop(): void {
      stopped = true;
      controller.abort();
    },
  };
}

/**
 * Account-wide accelerator for shared-container inbox changes. Unlike the
 * per-open-container subscription above, this deliberately accepts every
 * `sharedcontainer.detail` frame in the user's owner bucket. The payload is
 * opaque: its only contract is that the renderer should pull current state.
 */
export function createSharedContainerInboxSubscription(
  options: CreateSharedContainerInboxSubscriptionOptions,
): SharedContainerRealtimeSubscription {
  const controller = new AbortController();
  const fetchImpl: SharedContainerRealtimeFetch =
    options.fetchImpl ?? ((url, init): Promise<Response> => fetch(url, init));
  const getCredentials = options.getCredentials ?? getCanopyCloudCredentials;
  const delayImpl = options.delayImpl ?? defaultDelay;
  let stopped = false;
  let lastEventId: string | null = null;

  const consume = async (body: ReadableStream<Uint8Array>): Promise<void> => {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        const parsed = parseSseEvents(buffer);
        buffer = parsed.remainder;
        for (const event of parsed.events) {
          if (event.id !== null) lastEventId = event.id;
          if (event.event === 'sharedcontainer.detail') {
            options.onSignal();
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  };

  const run = async (): Promise<void> => {
    let attempt = 0;
    let notFoundAttempt = 0;
    while (!stopped) {
      let retryKind: 'normal' | 'not-found' = 'normal';
      try {
        const { baseUrl, apiKey } = await getCredentials();
        const headers: Record<string, string> = {
          Accept: 'text/event-stream',
          Authorization: `Bearer ${apiKey}`,
        };
        if (lastEventId !== null) headers['Last-Event-ID'] = lastEventId;
        const response = await fetchImpl(
          `${baseUrl}/api/v1/shared-containers/shared-with-me/stream`,
          { headers, signal: controller.signal },
        );
        if (response.status === 401 || response.status === 403) {
          options.onAccessDenied?.();
          return;
        }
        if (response.status === 404) {
          retryKind = 'not-found';
        } else if (!response.ok || !response.body) {
          retryKind = 'normal';
        } else {
          attempt = 0;
          notFoundAttempt = 0;
          await consume(response.body);
        }
      } catch (error) {
        if (
          stopped ||
          controller.signal.aborted ||
          isAbortError(error) ||
          isTerminalCredentialError(error)
        ) {
          return;
        }
      }
      if (stopped) return;
      const waitMs =
        retryKind === 'not-found'
          ? Math.min(
              BASE_NOT_FOUND_RETRY_MS * 2 ** notFoundAttempt++,
              MAX_NOT_FOUND_RETRY_MS,
            )
          : Math.min(BASE_RETRY_MS * 2 ** attempt++, MAX_RETRY_MS);
      await delayImpl(waitMs, controller.signal);
    }
  };

  void run();
  return {
    stop(): void {
      stopped = true;
      controller.abort();
    },
  };
}
