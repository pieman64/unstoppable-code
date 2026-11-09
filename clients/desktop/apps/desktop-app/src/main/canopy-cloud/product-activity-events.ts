import { app } from 'electron';
import {
  CLIENT_SURFACE_HEADER,
  CLIENT_SURFACE_VERSION_HEADER,
  parseClientVersionHeader,
  type ClientSurface,
} from '@canopy/protocol/client-surface';
import {
  MAX_PRODUCT_ACTIVITY_ORGANIZATION_ID_LENGTH,
  PRODUCT_ACTIVITY_TURNS_PATH,
  type ProductActivityTurnRequest,
} from '@canopy/protocol/product-activity';
import {
  CanopyCloudClientError,
  requestCanopyCloudJson,
  resolveCanopyCloudCredentialContext,
  type CanopyCloudCredentialContext,
} from './client';

/**
 * Desktop chat-turn activity signal (CAN-3561): one best-effort POST per
 * observed chat-turn start, so desktop activity is counted whatever the
 * activity-sharing scopes are set to. The payload is a hashed turn key and,
 * when resolvable, the owning organization's ID. Never a prompt, model,
 * project, worktree, chat, path, code, or file name.
 *
 * Nothing here is durable: a signal that fails both attempts is dropped, and
 * the turn is then counted only if ambient telemetry ingest later uploads it.
 */

const DESKTOP_CLIENT_SURFACE: ClientSurface = 'desktop';
const REQUEST_TIMEOUT_MS = 10_000;
const RETRY_DELAY_MS = 30_000;
const RETRY_JITTER_MS = 5_000;

const retryTimers = new Set<NodeJS.Timeout>();
/**
 * Bumped whenever retries are cleared, so a request that was already in flight
 * at disposal cannot schedule a retry afterwards.
 */
let retryGeneration = 0;

export interface DesktopChatTurnActivityInput {
  turnKey: string;
  organizationExternalId: string | undefined;
}

function surfaceHeaders(): Record<string, string> {
  const version = parseClientVersionHeader(app.getVersion());
  return {
    [CLIENT_SURFACE_HEADER]: DESKTOP_CLIENT_SURFACE,
    ...(version === null ? {} : { [CLIENT_SURFACE_VERSION_HEADER]: version }),
  };
}

/**
 * Network failures, timeouts, and 5xx responses are worth one more attempt.
 * Missing credentials, an unconfigured cloud, and every 4xx are terminal: that
 * covers an older server's 404 and the rate limiter's 429.
 */
function isRetryable(error: unknown): boolean {
  if (!(error instanceof CanopyCloudClientError)) return false;
  if (error.code === 'network-error') return true;
  return (
    error.code === 'http-error' &&
    error.status !== undefined &&
    error.status >= 500
  );
}

async function send(
  body: string,
  credentialContext: CanopyCloudCredentialContext,
  retryOnFailure: boolean,
  generation: number,
): Promise<void> {
  try {
    await requestCanopyCloudJson(PRODUCT_ACTIVITY_TURNS_PATH, {
      method: 'POST',
      body,
      headers: surfaceHeaders(),
      timeoutMs: REQUEST_TIMEOUT_MS,
      credentialContext,
    });
  } catch (error) {
    if (!retryOnFailure || !isRetryable(error)) return;
    if (generation !== retryGeneration) return;
    scheduleRetry(body, credentialContext, generation);
  }
}

function scheduleRetry(
  body: string,
  credentialContext: CanopyCloudCredentialContext,
  generation: number,
): void {
  const delayMs = RETRY_DELAY_MS + Math.floor(Math.random() * RETRY_JITTER_MS);
  const timer = setTimeout(() => {
    retryTimers.delete(timer);
    void send(body, credentialContext, false, generation);
  }, delayMs);
  // A pending retry must never hold the app open at quit.
  timer.unref();
  retryTimers.add(timer);
}

/**
 * The server answers 400 for an empty, whitespace-only, or overlength
 * organization ID, which would drop the whole count. Ownership never blocks
 * the signal, so an ID outside the contract is left out instead.
 */
function sendableOrganizationId(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (value.trim().length === 0) return undefined;
  if (value.length > MAX_PRODUCT_ACTIVITY_ORGANIZATION_ID_LENGTH) {
    return undefined;
  }
  return value;
}

/** Never rejects: the signal is best-effort and must not affect a chat turn. */
export async function reportDesktopChatTurnActivity(
  input: DesktopChatTurnActivityInput,
): Promise<void> {
  const generation = retryGeneration;
  try {
    const organizationExternalId = sendableOrganizationId(
      input.organizationExternalId,
    );
    const request: ProductActivityTurnRequest =
      organizationExternalId === undefined
        ? { turnKey: input.turnKey }
        : { turnKey: input.turnKey, organizationExternalId };
    const credentialContext = await resolveCanopyCloudCredentialContext();
    // Cleared while the credentials resolved (Active use count turned off,
    // or the reporter was disposed): nothing is sent.
    if (generation !== retryGeneration) return;
    await send(JSON.stringify(request), credentialContext, true, generation);
  } catch {
    // Dropped: ambient telemetry ingest remains the fallback count.
  }
}

/**
 * Cancels every scheduled retry and any report still resolving credentials.
 * Called when the reporter is disposed or Active use count turns off.
 */
export function clearProductActivityRetryTimers(): void {
  retryGeneration += 1;
  retryTimers.forEach((timer) => clearTimeout(timer));
  retryTimers.clear();
}
