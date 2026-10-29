import type { FeedItem } from '@canopy/protocol/feed';
import {
  SettingsOperationError,
  settingsCreditPoolEnvelopeSchema,
  settingsCreditPoolStreamPath,
  settingsDtoSchema,
  settingsErrorCodeForStatus,
  settingsFeedEnvelopeSchema,
  settingsOperation,
  settingsOperationRequest,
  settingsOrganizationFeedStreamPath,
  settingsSignedUploadSchema,
  validateSettingsOperationResult,
  type AnySettingsOperation,
  type SettingsErrorCode,
  type SettingsEvent,
  type SettingsOperationName,
  type SettingsOperationRequest,
  type SettingsSignedUpload,
  type SettingsSubscriptionScope,
  type SettingsSubscriptionState,
} from '@canopy/protocol/settings';
import type { SettingsBridgeSession } from './settings-session';

/**
 * Main-process execution of `SETTINGS_OPERATIONS` entries over the isolated
 * settings session. Callers validate the operation name and input against
 * the table first; this module builds the request from the table entry only,
 * so no URL, method, header, identity, or upload target comes from the
 * renderer. Response bodies are never logged.
 */

/** Mirrors `CANOPY_CLOUD_REQUEST_TIMEOUT_MS` in `client.ts`. */
const REQUEST_TIMEOUT_MS = 15_000;
/**
 * The bounded cloud read retry policy from `client.ts`
 * (`withBoundedCloudReadRetry`): two retries after 400 ms and 1.5 s, on a
 * transport failure or 502/503/504, honoring `Retry-After` up to 5 s. That
 * helper is private to the Bearer-key transport, so the policy is mirrored
 * here for session requests. Writes are never retried.
 */
const READ_RETRY_DELAYS_MS: readonly number[] = [400, 1_500];
const MAX_RETRY_AFTER_MS = 5_000;
const RETRYABLE_READ_STATUSES: ReadonlySet<number> = new Set([502, 503, 504]);
const UPLOAD_TIMEOUT_MS = 60_000;
const MAX_ERROR_MESSAGE_LENGTH = 300;
/** Headers a signed upload target may not make main send to storage. */
const FORBIDDEN_UPLOAD_HEADERS: ReadonlySet<string> = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'origin',
  'host',
]);

/** Feed reconnect backoff, mirroring `resilient-event-stream.ts` on web. */
const FEED_RETRY_BASE_MS = 1_000;
const FEED_RETRY_MAX_MS = 60_000;
const FEED_RETRY_AFTER_MAX_MS = 10 * 60_000;
/**
 * Most feed events held for delivery at once. Beyond it the oldest are
 * dropped and the subscriber is told to refetch (`reconnected`).
 */
export const SETTINGS_FEED_MAX_PENDING_EVENTS = 200;
/** Largest single SSE frame (characters) before the connection is reset. */
export const SETTINGS_FEED_MAX_FRAME_CHARS = 1024 * 1024;
const SEEN_EVENT_IDS_CAP = 1_000;

const feedItemSchema = settingsDtoSchema<FeedItem>(
  settingsFeedEnvelopeSchema.shape.payload,
);

export interface ExecuteSettingsOperationOptions {
  signal?: AbortSignal;
  uploadBytes?: Uint8Array;
  uploadContentType?: string;
}

function settingsError(
  code: SettingsErrorCode,
  extra: { message?: string; status?: number; serverCode?: string } = {},
): SettingsOperationError {
  return new SettingsOperationError({ code, ...extra });
}

function timeoutSignal(
  parent: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; release: () => void } {
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  if (parent?.aborted === true) controller.abort();
  else parent?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, timeoutMs);
  return {
    signal: controller.signal,
    release: (): void => {
      clearTimeout(timer);
      parent?.removeEventListener('abort', abort);
    },
  };
}

function wait(delayMs: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(settingsError('failed', { message: 'Request cancelled' }));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(settingsError('failed', { message: 'Request cancelled' }));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function parseRetryAfterMs(value: string | null): number | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1_000;
  const at = Date.parse(trimmed);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

function discardBody(response: Response): void {
  void response.body?.cancel().catch(() => undefined);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= max
    ? value
    : undefined;
}

/** A server's user-facing message and machine code from a JSON error body. */
async function readErrorDetail(
  response: Response,
): Promise<{ message?: string; serverCode?: string }> {
  let text: string;
  try {
    text = await response.text();
  } catch {
    return {};
  }
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return {};
  }
  if (!isRecord(payload)) return {};
  const nested = isRecord(payload.error) ? payload.error : undefined;
  const message =
    boundedString(payload.error, MAX_ERROR_MESSAGE_LENGTH) ??
    boundedString(nested?.message, MAX_ERROR_MESSAGE_LENGTH) ??
    boundedString(payload.message, MAX_ERROR_MESSAGE_LENGTH);
  const rawCode = nested?.code ?? payload.code;
  const serverCode =
    typeof rawCode === 'string' && /^[\w.:-]{1,128}$/.test(rawCode)
      ? rawCode
      : undefined;
  return {
    ...(message === undefined ? {} : { message }),
    ...(serverCode === undefined ? {} : { serverCode }),
  };
}

type AttemptResult =
  | { ok: true; json: unknown }
  | {
      ok: false;
      error: SettingsOperationError;
      retryable: boolean;
      retryAfterMs?: number;
    };

interface SendPolicy {
  /** A mutation: never retried; an unknown outcome is `uncertain`. */
  write: boolean;
  /** Retry transient failures with the bounded read policy. */
  retry: boolean;
  /** Better Auth endpoint: send `Origin`. */
  auth: boolean;
  /** A 404 means the server predates hosted settings. */
  missingMeansUnsupported: boolean;
  /** A 401 rejects a typed credential; the session stays ready. */
  rejectedCredentialOn401: boolean;
  signal?: AbortSignal;
}

async function attemptOnce(
  session: SettingsBridgeSession,
  request: SettingsOperationRequest,
  policy: SendPolicy,
): Promise<AttemptResult> {
  const timeout = timeoutSignal(policy.signal, REQUEST_TIMEOUT_MS);
  const hasBody = request.body !== undefined;
  let response: Response;
  try {
    response = await session.fetch(request.path, {
      method: request.method,
      headers: {
        Accept: 'application/json',
        ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(hasBody ? { body: JSON.stringify(request.body) } : {}),
      signal: timeout.signal,
      ...(policy.auth ? { authOrigin: true } : {}),
      ...(policy.rejectedCredentialOn401
        ? { rejectedCredentialOn401: true }
        : {}),
    });
  } catch (error) {
    timeout.release();
    if (error instanceof SettingsOperationError)
      return { ok: false, error, retryable: false };
    const cancelled = policy.signal?.aborted === true;
    if (policy.write)
      return { ok: false, error: settingsError('uncertain'), retryable: false };
    return cancelled
      ? {
          ok: false,
          error: settingsError('failed', { message: 'Request cancelled' }),
          retryable: false,
        }
      : { ok: false, error: settingsError('offline'), retryable: true };
  }
  try {
    const status = response.status;
    if (status >= 300 && status < 400) {
      discardBody(response);
      const location = response.headers.get('location') ?? '';
      const toLogin = /^(?:https?:\/\/[^/]+)?\/login(?:[/?#]|$)/.test(location);
      return {
        ok: false,
        error: settingsError(toLogin ? 'expired' : 'invalid_response', {
          status,
        }),
        retryable: false,
      };
    }
    if (!response.ok) {
      const detail = await readErrorDetail(response);
      if (policy.missingMeansUnsupported && status === 404)
        return {
          ok: false,
          error: settingsError('unsupported_server', { status }),
          retryable: false,
        };
      const retryAfterMs = parseRetryAfterMs(
        response.headers.get('retry-after'),
      );
      return {
        ok: false,
        error: settingsError(
          settingsErrorCodeForStatus(status, {
            write: policy.write,
            sessionReady: true,
            rejectedCredentialOn401: policy.rejectedCredentialOn401,
          }),
          { ...detail, status },
        ),
        retryable: !policy.write && RETRYABLE_READ_STATUSES.has(status),
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      };
    }
    let text: string;
    try {
      text = await response.text();
    } catch {
      if (policy.write)
        return {
          ok: false,
          error: settingsError('uncertain', { status }),
          retryable: false,
        };
      return { ok: false, error: settingsError('offline'), retryable: true };
    }
    if (text.trim() === '') return { ok: true, json: null };
    try {
      const json: unknown = JSON.parse(text);
      return { ok: true, json };
    } catch {
      return {
        ok: false,
        error: settingsError('invalid_response', { status }),
        retryable: false,
      };
    }
  } finally {
    timeout.release();
  }
}

async function sendJson(
  session: SettingsBridgeSession,
  request: SettingsOperationRequest,
  policy: SendPolicy,
): Promise<unknown> {
  for (let retryIndex = 0; ; retryIndex += 1) {
    const result = await attemptOnce(session, request, policy);
    if (result.ok) return result.json;
    const fallbackDelay = READ_RETRY_DELAYS_MS[retryIndex];
    if (
      !policy.retry ||
      policy.write ||
      !result.retryable ||
      fallbackDelay === undefined ||
      policy.signal?.aborted === true
    )
      throw result.error;
    await wait(
      Math.min(result.retryAfterMs ?? fallbackDelay, MAX_RETRY_AFTER_MS),
      policy.signal,
    );
  }
}

function validatedResult(name: SettingsOperationName, json: unknown): unknown {
  const validated = validateSettingsOperationResult(name, json);
  if (!validated.ok) throw settingsError('invalid_response');
  return validated.result;
}

/**
 * Execute one table entry with already-validated input. Returns the
 * schema-validated result or throws {@link SettingsOperationError}.
 */
export async function executeSettingsOperation(
  session: SettingsBridgeSession,
  name: SettingsOperationName,
  validatedInput: unknown,
  options: ExecuteSettingsOperationOptions = {},
): Promise<unknown> {
  const operation = settingsOperation(name);
  if (operation.transport === 'upload')
    return executeUpload(session, name, operation, validatedInput, options);
  const write = operation.kind === 'write';
  const json = await sendJson(
    session,
    settingsOperationRequest(name, validatedInput),
    {
      write,
      retry: !write,
      auth: operation.transport === 'auth',
      missingMeansUnsupported: name === 'settings.bootstrap',
      rejectedCredentialOn401: operation.rejectedCredentialOn401 === true,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    },
  );
  return validatedResult(name, json);
}

/** Signed upload targets must be https storage, never the backend origin. */
function storageTarget(uploadUrl: string, backendOrigin: string): URL {
  let url: URL;
  try {
    url = new URL(uploadUrl);
  } catch {
    throw settingsError('invalid_response');
  }
  if (
    url.protocol !== 'https:' ||
    url.origin === backendOrigin ||
    url.username !== '' ||
    url.password !== ''
  )
    throw settingsError('invalid_response');
  return url;
}

async function putToStorage(
  target: URL,
  signed: SettingsSignedUpload,
  bytes: Uint8Array,
  contentType: string,
  signal: AbortSignal | undefined,
): Promise<void> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(signed.headers ?? {})) {
    const lower = name.toLowerCase();
    if (FORBIDDEN_UPLOAD_HEADERS.has(lower)) continue;
    if (lower === 'content-type' && value.toLowerCase() !== contentType)
      throw settingsError('failed', { serverCode: 'unsupported_type' });
    headers[name] = value;
  }
  if (
    !Object.keys(headers).some((name) => name.toLowerCase() === 'content-type')
  )
    headers['Content-Type'] = contentType;
  const timeout = timeoutSignal(signal, UPLOAD_TIMEOUT_MS);
  try {
    // Plain Node fetch: no cookie jar and no account credentials. The bytes
    // go only to the signed storage target.
    const response = await fetch(target, {
      method: 'PUT',
      headers,
      body: new Uint8Array(bytes),
      credentials: 'omit',
      redirect: 'error',
      signal: timeout.signal,
    });
    discardBody(response);
    if (!response.ok)
      throw settingsError('failed', {
        status: response.status,
        serverCode: 'upload_failed',
      });
  } catch (error) {
    if (error instanceof SettingsOperationError) throw error;
    throw settingsError('failed', { serverCode: 'upload_failed' });
  } finally {
    timeout.release();
  }
}

async function executeUpload(
  session: SettingsBridgeSession,
  name: SettingsOperationName,
  operation: AnySettingsOperation,
  validatedInput: unknown,
  options: ExecuteSettingsOperationOptions,
): Promise<unknown> {
  const upload = operation.upload;
  if (upload === undefined)
    throw settingsError('failed', { message: 'Upload is not configured' });
  const bytes = options.uploadBytes;
  const contentType = options.uploadContentType?.toLowerCase();
  if (bytes === undefined || bytes.byteLength === 0)
    throw settingsError('failed', { serverCode: 'missing_file' });
  if (bytes.byteLength > upload.maxBytes)
    throw settingsError('failed', { serverCode: 'file_too_large' });
  if (contentType === undefined || !upload.contentTypes.includes(contentType))
    throw settingsError('failed', { serverCode: 'unsupported_type' });
  const signal = options.signal;
  const signedJson = await sendJson(session, upload.sign(validatedInput), {
    // Signing changes nothing the user sees, so its failures are not
    // `uncertain`; it is still not retried.
    write: false,
    retry: false,
    auth: false,
    missingMeansUnsupported: false,
    rejectedCredentialOn401: false,
    ...(signal === undefined ? {} : { signal }),
  });
  const signed = settingsSignedUploadSchema.safeParse(signedJson);
  if (!signed.success) throw settingsError('invalid_response');
  const target = storageTarget(signed.data.uploadUrl, session.origin);
  await putToStorage(target, signed.data, bytes, contentType, signal);
  const committed = await sendJson(
    session,
    upload.commit(validatedInput, signed.data),
    {
      write: true,
      retry: false,
      auth: false,
      missingMeansUnsupported: false,
      rejectedCredentialOn401: false,
      ...(signal === undefined ? {} : { signal }),
    },
  );
  return validatedResult(name, committed);
}

export interface SettingsFeedStream {
  close(): void;
}

export interface SettingsFeedStreamOptions {
  /** Jitter source in [0, 1] for the reconnect backoff. */
  random?: () => number;
}

type ReadOutcome = 'ended' | 'oversize';

/** Index and length of the first complete line break, or null. */
function lineBreak(buffer: string): { index: number; length: number } | null {
  for (let index = 0; index < buffer.length; index += 1) {
    const char = buffer[index];
    if (char === '\n') return { index, length: 1 };
    if (char === '\r') {
      // A trailing CR may be the first half of CRLF; wait for more input.
      if (index === buffer.length - 1) return null;
      return { index, length: buffer[index + 1] === '\n' ? 2 : 1 };
    }
  }
  return null;
}

/**
 * Subscribe to an organization's feed, or a wallet's `credit.pool` signals,
 * over SSE in the isolated session. Frames are validated, deduplicated by
 * `sequence` and `eventId`, and delivered in order; a credit signal carries
 * no balance, only a reason to read the wallet again. `state` reports
 * connecting/open/reconnecting/disabled; `reconnected` follows every open
 * after an interruption so the subscriber refetches. 401 stops with
 * `expired`, 403 with `forbidden`, 404 without an error (no access or
 * streams off, as on web).
 */
export function openSettingsFeedStream(
  session: SettingsBridgeSession,
  scope: SettingsSubscriptionScope,
  handlers: { onEvent(event: SettingsEvent): void },
  options: SettingsFeedStreamOptions = {},
): SettingsFeedStream {
  const organizationId = scope.organizationId;
  const feed = scope.kind === 'organization-feed';
  const path =
    scope.kind === 'organization-feed'
      ? settingsOrganizationFeedStreamPath(scope.organizationId, scope.teamId)
      : settingsCreditPoolStreamPath(scope.organizationId);
  const frameEvent = feed ? 'feed.item' : 'credit.pool';
  const owner = organizationId === undefined ? {} : { organizationId };
  const random = options.random ?? Math.random;
  const seenEventIds = new Set<string>();
  let lastSequence =
    scope.kind === 'organization-feed' ? scope.lastSequence : undefined;
  let state: SettingsSubscriptionState | null = null;
  let closed = false;
  let failures = 0;
  let attempts = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let connection: AbortController | null = null;
  let release: (() => void) | null = session.retainStream();

  const emit = (event: SettingsEvent): void => {
    if (closed) return;
    try {
      handlers.onEvent(event);
    } catch {
      // A subscriber failure must not end the stream.
    }
  };

  const setState = (
    next: SettingsSubscriptionState,
    error?: 'expired' | 'forbidden' | 'unsupported_server',
  ): void => {
    if (closed || (state === next && error === undefined)) return;
    state = next;
    emit({
      type: 'state',
      ...owner,
      state: next,
      ...(error === undefined ? {} : { error }),
    });
  };

  const shutdown = (): void => {
    closed = true;
    if (retryTimer !== undefined) clearTimeout(retryTimer);
    retryTimer = undefined;
    connection?.abort();
    connection = null;
    release?.();
    release = null;
  };

  const stop = (error?: 'expired' | 'forbidden'): void => {
    setState('disabled', error);
    shutdown();
  };

  const scheduleReconnect = (retryAfterMs = 0): void => {
    if (closed) return;
    setState('reconnecting');
    const step = Math.min(
      FEED_RETRY_MAX_MS,
      FEED_RETRY_BASE_MS * 2 ** failures,
    );
    failures += 1;
    const delay = Math.max(
      step * (0.5 + 0.5 * random()),
      Math.min(retryAfterMs, FEED_RETRY_AFTER_MAX_MS),
    );
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      void connect();
    }, delay);
  };

  /** The frame as a settings event with its envelope cursor, or null. */
  const parseFrame = (
    json: unknown,
  ): { sequence: number; eventId: string; event: SettingsEvent } | null => {
    if (scope.kind === 'credit-pool') {
      const envelope = settingsCreditPoolEnvelopeSchema.safeParse(json);
      if (!envelope.success) return null;
      const { sequence, eventId } = envelope.data;
      return { sequence, eventId, event: { type: 'credit.pool', ...owner } };
    }
    const envelope = settingsFeedEnvelopeSchema.safeParse(json);
    if (!envelope.success) return null;
    const item = feedItemSchema.safeParse(envelope.data.payload);
    if (!item.success) return null;
    const { sequence, eventId } = envelope.data;
    return {
      sequence,
      eventId,
      event: {
        type: 'feed.item',
        organizationId: scope.organizationId,
        sequence,
        eventId,
        item: item.data,
      },
    };
  };

  const accept = (data: string, pending: SettingsEvent[]): boolean => {
    let json: unknown;
    try {
      json = JSON.parse(data);
    } catch {
      return false;
    }
    const frame = parseFrame(json);
    if (frame === null) return false;
    const { sequence, eventId } = frame;
    if (lastSequence !== undefined && sequence <= lastSequence) return false;
    if (seenEventIds.has(eventId)) return false;
    seenEventIds.add(eventId);
    if (seenEventIds.size > SEEN_EVENT_IDS_CAP) {
      const oldest = seenEventIds.values().next();
      if (oldest.done !== true) seenEventIds.delete(oldest.value);
    }
    lastSequence = sequence;
    let dropped = false;
    if (pending.length >= SETTINGS_FEED_MAX_PENDING_EVENTS) {
      pending.shift();
      dropped = true;
    }
    pending.push(frame.event);
    return dropped;
  };

  const readFrames = async (
    body: ReadableStream<Uint8Array>,
  ): Promise<ReadOutcome> => {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let eventName = '';
    let dataLines: string[] = [];
    let frameChars = 0;
    const pending: SettingsEvent[] = [];
    let overflowed = false;

    const handleLine = (line: string): void => {
      if (line === '') {
        if (eventName === frameEvent && dataLines.length > 0)
          overflowed = accept(dataLines.join('\n'), pending) || overflowed;
        eventName = '';
        dataLines = [];
        frameChars = 0;
        return;
      }
      if (line.startsWith(':')) return;
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'event') eventName = value;
      else if (field === 'data') {
        dataLines.push(value);
        frameChars += value.length;
      }
    };

    const drain = (): void => {
      while (pending.length > 0 && !closed) {
        const event = pending.shift();
        if (event !== undefined) emit(event);
      }
      if (overflowed) {
        overflowed = false;
        emit({ type: 'reconnected', ...owner });
      }
    };

    try {
      for (;;) {
        const chunk = await reader.read();
        if (closed) return 'ended';
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        for (
          let found = lineBreak(buffer);
          found !== null;
          found = lineBreak(buffer)
        ) {
          handleLine(buffer.slice(0, found.index));
          buffer = buffer.slice(found.index + found.length);
        }
        drain();
        if (buffer.length + frameChars > SETTINGS_FEED_MAX_FRAME_CHARS)
          return 'oversize';
      }
    } catch {
      return 'ended';
    } finally {
      void reader.cancel().catch(() => undefined);
    }
    return 'ended';
  };

  async function connect(): Promise<void> {
    if (closed) return;
    attempts += 1;
    const controller = new AbortController();
    connection = controller;
    let response: Response;
    try {
      response = await session.fetch(path, {
        method: 'GET',
        headers: {
          Accept: 'text/event-stream',
          'Cache-Control': 'no-cache',
          ...(lastSequence === undefined
            ? {}
            : { 'Last-Event-ID': String(lastSequence) }),
        },
        signal: controller.signal,
      });
    } catch (error) {
      if (closed || connection !== controller) return;
      if (
        error instanceof SettingsOperationError &&
        (error.code === 'expired' || error.code === 'unauthenticated')
      ) {
        stop('expired');
        return;
      }
      scheduleReconnect();
      return;
    }
    if (closed || connection !== controller) {
      discardBody(response);
      return;
    }
    if (response.status === 401 || response.status === 403) {
      discardBody(response);
      stop(response.status === 401 ? 'expired' : 'forbidden');
      return;
    }
    if (response.status === 404) {
      discardBody(response);
      stop();
      return;
    }
    const body = response.body;
    if (!response.ok || body === null) {
      discardBody(response);
      scheduleReconnect(parseRetryAfterMs(response.headers.get('retry-after')));
      return;
    }
    failures = 0;
    setState('open');
    if (attempts > 1) emit({ type: 'reconnected', ...owner });
    await readFrames(body);
    controller.abort();
    if (closed || connection !== controller) return;
    scheduleReconnect();
  }

  setState('connecting');
  void connect();
  return {
    close(): void {
      if (closed) return;
      shutdown();
    },
  };
}
