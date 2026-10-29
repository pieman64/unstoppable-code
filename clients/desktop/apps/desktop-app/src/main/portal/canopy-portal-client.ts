import {
  CanopyCloudClientError,
  openCanopyCloudStream,
  requestCanopyCloudBinary,
  requestCanopyCloudJson,
  requestCanopyCloudNoContent,
} from '../canopy-cloud/client';
import { BRAND } from '@canopy/brand/current';
import { REMOTE_CONTROL_LABEL } from '@canopy/protocol';
import type {
  CreatePortalSessionRequest,
  CreatePortalSessionResponse,
  EndPortalSessionResponse,
  PollPortalCommandsResponse,
  PortalHeartbeatRequest,
  PortalHeartbeatResponse,
  PostPortalEventsRequest,
  PostPortalEventsResponse,
} from '@canopy/desktop-shared/types';

const CANOPY_PORTAL_REQUEST_TIMEOUT_MS = 30_000;
/**
 * Heartbeats get a tighter budget than the shared 30s default (CAN-2651).
 * The server reaps a session whose `lastSeenAt` is older than
 * `PORTAL_RECONNECTING_MAX_AGE_MS` (90s). With the 30s default, the worst-case
 * gap between two successive heartbeat attempts is
 * `HEARTBEAT_INTERVAL_MS + 30s = 45s`, so two slow attempts in a row already
 * reach the reap threshold. A 10s budget caps the worst case at ~25s, which
 * leaves real headroom inside 90s. Only the heartbeat uses this; every other
 * call keeps the 30s default.
 */
export const CANOPY_PORTAL_HEARTBEAT_TIMEOUT_MS = 10_000;
const WELL_KNOWN_PATH = `/.well-known/${BRAND.web.wellKnownNamespace}`;
const API_PREFIX = `/api/v1/${BRAND.web.apiNamespace}`;

export class CanopyPortalClientError extends Error {
  constructor(
    readonly code:
      | 'cloud-not-configured'
      | 'missing-api-key'
      | 'network-error'
      | 'http-error'
      | 'invalid-response'
      | 'unsupported-capability',
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'CanopyPortalClientError';
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function isTimedOutClientError(error: CanopyCloudClientError): boolean {
  return (
    error.code === 'network-error' &&
    error.message.toLowerCase().includes('timed out')
  );
}

async function requestJson<T>(
  pathname: string,
  init: RequestInit = {},
  options: { timeoutMs?: number } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? CANOPY_PORTAL_REQUEST_TIMEOUT_MS;
  const controller = new AbortController();
  const externalSignal = init.signal;
  const abortFromExternalSignal = (): void => {
    controller.abort();
  };
  if (externalSignal?.aborted) {
    controller.abort();
  } else {
    externalSignal?.addEventListener('abort', abortFromExternalSignal, {
      once: true,
    });
  }
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    return await requestCanopyCloudJson<T>(pathname, {
      ...init,
      signal: controller.signal,
      timeoutMs,
    });
  } catch (error) {
    if (error instanceof CanopyCloudClientError) {
      throw new CanopyPortalClientError(
        error.code,
        isTimedOutClientError(error)
          ? externalSignal?.aborted
            ? `${REMOTE_CONTROL_LABEL} request cancelled.`
            : `${REMOTE_CONTROL_LABEL} request timed out.`
          : error.message,
        error.status,
      );
    }

    throw new CanopyPortalClientError(
      'network-error',
      isAbortError(error)
        ? externalSignal?.aborted
          ? `${REMOTE_CONTROL_LABEL} request cancelled.`
          : `${REMOTE_CONTROL_LABEL} request timed out.`
        : error instanceof Error
          ? error.message
          : `Failed to reach ${BRAND.displayName} Cloud.`,
    );
  } finally {
    clearTimeout(timeoutId);
    externalSignal?.removeEventListener('abort', abortFromExternalSignal);
  }
}

export async function assertLiveCanopyPortalSupport(): Promise<void> {
  const payload = await requestJson<{ capabilities?: unknown }>(
    WELL_KNOWN_PATH,
  );
  const capabilities = Array.isArray(payload.capabilities)
    ? payload.capabilities.filter(
        (capability): capability is string => typeof capability === 'string',
      )
    : [];

  if (!capabilities.includes('portal-v1')) {
    throw new CanopyPortalClientError(
      'unsupported-capability',
      `${BRAND.displayName} Cloud does not support ${REMOTE_CONTROL_LABEL.toLowerCase()}.`,
    );
  }
}

export async function createPortalSession(
  request: CreatePortalSessionRequest,
): Promise<CreatePortalSessionResponse> {
  return requestJson<CreatePortalSessionResponse>(
    `${API_PREFIX}/portal/sessions`,
    {
      method: 'POST',
      body: JSON.stringify(request),
    },
  );
}

export async function pollPortalCommands(input: {
  sessionId: string;
  afterSeq: number;
  maxBatch?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<PollPortalCommandsResponse> {
  const params = new URLSearchParams({
    timeoutMs: String(input.timeoutMs ?? 25_000),
  });

  return requestJson<PollPortalCommandsResponse>(
    `${API_PREFIX}/portal/sessions/${input.sessionId}/commands?${params.toString()}`,
    {
      method: 'POST',
      signal: input.signal,
      body: JSON.stringify({
        afterSeq: input.afterSeq,
        ...(input.maxBatch == null ? {} : { maxBatch: input.maxBatch }),
      }),
    },
  );
}

/**
 * Open the portal command SSE stream (TS-02). Reconnects pass the desktop's own
 * persisted command cursor as `?after=` so a mid-frame disconnect re-fetches any
 * DELIVERED-but-unprocessed commands (replay is idempotent via the
 * completed-command dedupe). No request timeout is applied — the caller owns the
 * lifetime via `signal`.
 */
export async function openPortalCommandStream(input: {
  sessionId: string;
  afterSeq: number;
  signal: AbortSignal;
}): Promise<Response> {
  const params = new URLSearchParams({ after: String(input.afterSeq) });
  try {
    return await openCanopyCloudStream(
      `${API_PREFIX}/portal/sessions/${input.sessionId}/commands/stream?${params.toString()}`,
      { signal: input.signal },
    );
  } catch (error) {
    if (error instanceof CanopyCloudClientError) {
      throw new CanopyPortalClientError(
        error.code,
        error.message,
        error.status,
      );
    }
    throw error;
  }
}

export async function sendPortalEvents(input: {
  sessionId: string;
  request: PostPortalEventsRequest;
}): Promise<PostPortalEventsResponse> {
  return requestJson<PostPortalEventsResponse>(
    `${API_PREFIX}/portal/sessions/${input.sessionId}/events`,
    {
      method: 'POST',
      body: JSON.stringify(input.request),
    },
  );
}

export async function sendPortalHeartbeat(input: {
  sessionId: string;
  signal?: AbortSignal;
  capabilities?: PortalHeartbeatRequest['capabilities'];
  clientVersion?: PortalHeartbeatRequest['clientVersion'];
}): Promise<PortalHeartbeatResponse> {
  return requestJson<PortalHeartbeatResponse>(
    `${API_PREFIX}/portal/sessions/${input.sessionId}/heartbeat`,
    {
      method: 'POST',
      signal: input.signal,
      body: JSON.stringify({
        capabilities: input.capabilities,
        clientVersion: input.clientVersion,
      }),
    },
    { timeoutMs: CANOPY_PORTAL_HEARTBEAT_TIMEOUT_MS },
  );
}

export async function endPortalSession(input: {
  sessionId: string;
}): Promise<EndPortalSessionResponse> {
  return requestJson<EndPortalSessionResponse>(
    `${API_PREFIX}/portal/sessions/${input.sessionId}/end`,
    { method: 'POST' },
  );
}

const PORTAL_ATTACHMENT_DOWNLOAD_TIMEOUT_MS = 60_000;

function portalAttachmentPath(sessionId: string, attachmentId: string): string {
  return `/api/v1/portal/sessions/${encodeURIComponent(sessionId)}/attachments/${encodeURIComponent(attachmentId)}`;
}

/**
 * Pull one phone/browser-uploaded chat attachment for this session. The
 * caller verifies size and sha256 against the ref before using the bytes.
 */
export async function downloadPortalChatAttachment(input: {
  sessionId: string;
  attachmentId: string;
  signal?: AbortSignal;
}): Promise<Buffer> {
  return requestCanopyCloudBinary(
    `${portalAttachmentPath(input.sessionId, input.attachmentId)}/content`,
    {
      method: 'GET',
      headers: { Accept: 'application/octet-stream' },
      timeoutMs: PORTAL_ATTACHMENT_DOWNLOAD_TIMEOUT_MS,
      ...(input.signal ? { signal: input.signal } : {}),
    },
  );
}

/** Tell the web service the blob has been copied locally and can be dropped. */
export async function consumePortalChatAttachment(input: {
  sessionId: string;
  attachmentId: string;
}): Promise<void> {
  await requestCanopyCloudNoContent(
    portalAttachmentPath(input.sessionId, input.attachmentId),
    { method: 'DELETE' },
  );
}
