// ---------------------------------------------------------------------------
// Desktop owner real-time plan subscription (CAN-394 live slice).
//
// The desktop has no other inbound SSE/long-poll consumer (Portal is
// outbound-only; the MCP server is an SSE *producer*). This is a small, purely
// additive SSE client: on each `plan.detail` signal it calls the existing
// `refreshSharedPlanFromServer` pull, so the owner's desktop reflects inbound
// web comments/status changes without waiting for the 1s-debounced pull loop,
// which stays as the fallback.
//
// Resilience contract:
//   - reconnect with exponential backoff, resuming with `Last-Event-ID`;
//   - a 404 (gate off / capability absent) is terminal-quiet — stop trying and
//     rely on the debounced pull;
//   - a 401/403 (rejected/expired credentials) is terminal-quiet — retrying with
//     the same bad key would just loop forever, so fall back to the pull;
//   - credential-resolution failures (cloud not configured) are terminal-quiet;
//   - keepalive comments and unknown events are tolerated.
// ---------------------------------------------------------------------------

import { BRAND } from '@canopy/brand/current';
import type { PlanRealtimeSignal } from '@canopy/protocol/realtime';
import { getCanopyCloudCredentials } from '../lib/canopy-cloud-account-store';

// Reuse the backoff shape from `shared-plan-sync.ts`.
const BASE_RETRY_MS = 5000;
const MAX_RETRY_MS = 5 * 60 * 1000;

interface PlanRealtimeCredentials {
  baseUrl: string;
  apiKey: string;
}

/** Minimal response shape the subscription reads (satisfied by `Response`). */
export interface PlanRealtimeResponse {
  status: number;
  ok: boolean;
  body: ReadableStream<Uint8Array> | null;
}

/**
 * Narrow fetch contract the subscription depends on. The global `fetch` is
 * assignable to it, and tests can supply a lightweight stub without casting.
 */
export type PlanRealtimeFetch = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal },
) => Promise<PlanRealtimeResponse>;

export interface CreatePlanRealtimeSubscriptionOptions {
  /** Remote (external uuid) id of the shared plan to stream. */
  remoteId: string;
  /** Called with the parsed signal payload on each `plan.detail` event. */
  onSignal: (signal: PlanRealtimeSignal) => void;
  /** Injectable for tests; defaults to resolving cloud credentials. */
  getCredentials?: () => Promise<PlanRealtimeCredentials>;
  /** Injectable for tests; defaults to global `fetch`. */
  fetchImpl?: PlanRealtimeFetch;
  /** Injectable for tests; defaults to `setTimeout`-based delay. */
  delayImpl?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export interface PlanRealtimeSubscription {
  /** Stop the subscription and abort any in-flight request. */
  stop: () => void;
}

export interface ParsedSseEvent {
  event: string | null;
  data: string;
  id: string | null;
}

/**
 * Parse all complete SSE frames from `buffer`, returning the parsed events plus
 * any trailing partial frame to carry into the next read. Frames are separated
 * by a blank line (`\n\n`); `data:` lines are joined with `\n`; comment lines
 * (leading `:`) are ignored.
 */
export function parseSseEvents(buffer: string): {
  events: ParsedSseEvent[];
  remainder: string;
} {
  const normalized = buffer.replace(/\r\n/g, '\n');
  const frames = normalized.split('\n\n');
  // The final segment is an incomplete frame unless the buffer ended on `\n\n`
  // (in which case it is an empty string and yields no event).
  const remainder = frames.pop() ?? '';
  const events: ParsedSseEvent[] = [];

  for (const frame of frames) {
    if (frame.length === 0) {
      continue;
    }
    let event: string | null = null;
    let id: string | null = null;
    const dataLines: string[] = [];
    for (const rawLine of frame.split('\n')) {
      if (rawLine.length === 0 || rawLine.startsWith(':')) {
        continue;
      }
      const colon = rawLine.indexOf(':');
      const field = colon === -1 ? rawLine : rawLine.slice(0, colon);
      let value = colon === -1 ? '' : rawLine.slice(colon + 1);
      if (value.startsWith(' ')) {
        value = value.slice(1);
      }
      if (field === 'event') {
        event = value;
      } else if (field === 'data') {
        dataLines.push(value);
      } else if (field === 'id') {
        id = value;
      }
    }
    if (dataLines.length > 0 || event !== null) {
      events.push({ event, id, data: dataLines.join('\n') });
    }
  }

  return { events, remainder };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parsePlanSignal(data: string): PlanRealtimeSignal | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) {
    return null;
  }
  // The frame carries the full envelope; the signal is on `payload`.
  const candidate = isRecord(parsed.payload) ? parsed.payload : parsed;
  const planId = candidate.planId;
  const revision = candidate.revision;
  if (typeof planId !== 'string' || typeof revision !== 'number') {
    return null;
  }
  return { planId, revision };
}

function defaultDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/**
 * Open a resilient `plan.detail` SSE subscription for one shared plan. Returns a
 * handle whose `stop()` aborts the connection. Errors are handled internally and
 * never thrown to the caller; the subscription degrades to the debounced pull.
 */
export function createPlanRealtimeSubscription(
  options: CreatePlanRealtimeSubscriptionOptions,
): PlanRealtimeSubscription {
  const {
    remoteId,
    onSignal,
    getCredentials = getCanopyCloudCredentials,
    delayImpl = defaultDelay,
  } = options;
  const fetchImpl: PlanRealtimeFetch =
    options.fetchImpl ?? ((url, init): Promise<Response> => fetch(url, init));

  const controller = new AbortController();
  let stopped = false;
  let lastEventId: string | null = null;

  const run = async (): Promise<void> => {
    let attempt = 0;
    while (!stopped) {
      try {
        const { baseUrl, apiKey } = await getCredentials();
        const url = `${baseUrl}/api/v1/${BRAND.web.apiNamespace}/plans/${remoteId}/stream`;
        const headers: Record<string, string> = {
          Accept: 'text/event-stream',
          Authorization: `Bearer ${apiKey}`,
        };
        if (lastEventId !== null) {
          headers['Last-Event-ID'] = lastEventId;
        }

        const response = await fetchImpl(url, {
          headers,
          signal: controller.signal,
        });

        if (
          response.status === 404 ||
          response.status === 401 ||
          response.status === 403
        ) {
          // Gate off / capability absent (404) or rejected/expired credentials
          // (401/403): terminal-quiet, rely on the debounced pull. Retrying a
          // bad key would otherwise loop forever on backoff with noisy traffic.
          return;
        }
        if (!response.ok || !response.body) {
          throw new Error(`Plan stream responded ${response.status}`);
        }

        // Successful connect resets the backoff.
        attempt = 0;
        await consumeStream(response.body);
        // Stream ended without an error → fall through to reconnect.
      } catch (error) {
        if (stopped || isAbortError(error) || controller.signal.aborted) {
          return;
        }
        // Credential resolution failed (cloud not configured / no key): there is
        // nothing to retry against, so stop quietly and rely on the pull.
        if (isTerminalCredentialError(error)) {
          return;
        }
      }

      if (stopped) {
        return;
      }
      const backoff = Math.min(BASE_RETRY_MS * 2 ** attempt, MAX_RETRY_MS);
      attempt += 1;
      await delayImpl(backoff, controller.signal);
    }
  };

  const consumeStream = async (
    body: ReadableStream<Uint8Array>,
  ): Promise<void> => {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) {
          return;
        }
        buffer += decoder.decode(value, { stream: true });
        const { events, remainder } = parseSseEvents(buffer);
        buffer = remainder;
        for (const sseEvent of events) {
          if (sseEvent.id !== null) {
            lastEventId = sseEvent.id;
          }
          if (sseEvent.event !== 'plan.detail') {
            continue;
          }
          const signal = parsePlanSignal(sseEvent.data);
          if (signal) {
            onSignal(signal);
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  };

  void run();

  return {
    stop: (): void => {
      stopped = true;
      controller.abort();
    },
  };
}

function isTerminalCredentialError(error: unknown): boolean {
  // `getCanopyCloudCredentials` throws `CanopyCloudConfigError` when the base
  // URL or API key is missing. Detect by name to avoid importing the config
  // module's class into this leaf module's dependency graph.
  return error instanceof Error && error.name === 'CanopyCloudConfigError';
}
