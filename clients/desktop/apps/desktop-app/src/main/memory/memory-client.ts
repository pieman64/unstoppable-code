import { BRAND } from '@canopy/brand/current';
import {
  MEMORY_SEARCH_CAPABILITY,
  type MemoryDeliveredRequest,
  type MemoryDeliveredResponse,
  type MemoryDeliveryOutcome,
  type MemoryDropReason,
  type MemoryFeedbackRequest,
  type MemoryFeedbackResponse,
  type MemoryFeedbackQueryResponse,
  type MemorySearchDiagnostics,
  type MemorySearchFact,
  type MemorySearchRequest,
  type MemorySearchResponse,
} from '@canopy/protocol/memory';
import type {
  OrgMemoryFeedbackRequest,
  OrgMemoryFeedbackResponse,
  OrgMemoryFeedbackQuery,
  OrgMemoryFeedbackQueryResponse,
} from '@canopy/desktop-shared/types';
import { normalizeOrganizationExternalId } from '@canopy/desktop-shared/lib/org-memory';
import { requestCanopyCloudJson } from '../canopy-cloud/client';
import { getCanopyCloudCredentials } from '../lib/canopy-cloud-account-store';
import { isOrganizationTeamsLapsed } from '../lib/org-billing-state';

// Kept local by spec so desktop does not import the Node-oriented memory engine.
// Sized against the observed server-side read path (embed round trip, four
// retrieval lanes, rerank round trip), whose p50 sits near 1.5s before route
// auth, the search-log write, and network time are counted. The previous 1.5s
// budget therefore expired mid-flight on effectively every request once query
// enrichment landed, silently discarding retrievals the server had already
// completed. The turn only waits out whatever is left of this budget after
// session setup, so the headroom costs nothing on turns that set up slowly.
export const CLIENT_FETCH_TIMEOUT_MS = 4_000;

// Feedback reads/writes are interactive but not turn-blocking, so they get
// their own budget: retuning the search budget above must not silently retune
// feedback. Identical to CLIENT_FETCH_TIMEOUT_MS today by design.
export const FEEDBACK_FETCH_TIMEOUT_MS = 4_000;

export interface OrgMemoryFetchResult {
  /** The organization that was searched (CAN-3457). */
  organizationExternalId: string;
  searchId?: string;
  renderedBlock: string;
  facts: MemorySearchFact[];
}

export interface OrgMemoryFetchAttempt {
  result: OrgMemoryFetchResult | null;
  factCount: number;
  diagnostics?: MemorySearchDiagnostics;
  responseReceived: boolean;
  /**
   * Present (and true) only when the attempt was short-circuited by the open
   * search circuit breaker without performing any network work.
   */
  breakerOpen?: boolean;
}

function debugFailure(error: unknown): void {
  if (!process.env.DEBUG?.includes('org-memory')) return;
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[org-memory] fetch skipped: ${message}\n`);
}

// Circuit breaker over the SEARCH fetch only. A degraded server that never
// answers inside the budget would otherwise tax every turn with a full fetch
// timeout; after MEMORY_BREAKER_THRESHOLD consecutive attempts that actually
// performed a network fetch and ended `responseReceived: false`, the breaker
// opens for MEMORY_BREAKER_COOLDOWN_MS and search attempts short-circuit
// immediately. After the cooldown, exactly one half-open probe is allowed
// through (concurrent calls keep short-circuiting): probe success closes the
// breaker, probe failure re-opens it for another cooldown. Attempts that
// return before any network call (missing credentials/capability) neither
// count toward nor reset the failure streak, and the ack/feedback calls never
// consult the breaker.
export const MEMORY_BREAKER_THRESHOLD = 3;
export const MEMORY_BREAKER_COOLDOWN_MS = 5 * 60_000;

let breakerConsecutiveFailures = 0;
let breakerOpenedAt: number | null = null;
let breakerProbeInFlight = false;

export function resetOrgMemoryBreakerForTest(): void {
  breakerConsecutiveFailures = 0;
  breakerOpenedAt = null;
  breakerProbeInFlight = false;
}

function noteBreakerNetworkSuccess(): void {
  breakerConsecutiveFailures = 0;
  breakerOpenedAt = null;
}

function noteBreakerNetworkFailure(probing: boolean): void {
  if (probing) {
    breakerOpenedAt = Date.now();
    return;
  }
  breakerConsecutiveFailures += 1;
  if (breakerConsecutiveFailures >= MEMORY_BREAKER_THRESHOLD) {
    breakerConsecutiveFailures = 0;
    breakerOpenedAt = Date.now();
  }
}

/**
 * Shared request gate. The caller passes the org explicitly — the org that
 * owns the work for a search, or the org a search was made in for its ack and
 * feedback (CAN-3457) — and no call here ever picks an org on its own.
 *
 * Per-org billing gate (CAN-2311): keyed by the passed org, so a lapsed org is
 * refused while a member's healthy orgs keep memory. Last in the chain so the
 * extra snapshot read is skipped whenever an earlier condition already gated
 * the call.
 */
async function isOrgMemoryRequestAllowed(
  organizationExternalId: string,
): Promise<boolean> {
  const credentials = await getCanopyCloudCredentials();
  return (
    credentials.apiKey.length > 0 &&
    credentials.capabilities.includes(MEMORY_SEARCH_CAPABILITY) &&
    normalizeOrganizationExternalId(organizationExternalId) ===
      organizationExternalId &&
    // Defense in depth for acks and feedback, whose org comes from a stored
    // turn: never send to an org the account can no longer search.
    credentials.memorySearchOrganizationExternalIds.includes(
      organizationExternalId,
    ) &&
    !(await isOrganizationTeamsLapsed(organizationExternalId))
  );
}

const BREAKER_SHORT_CIRCUIT: OrgMemoryFetchAttempt = {
  result: null,
  factCount: 0,
  responseReceived: false,
  breakerOpen: true,
};

export async function fetchOrgMemoryAttempt(
  organizationExternalId: string,
  queryText: string,
  debug: boolean,
  lexicalQuery?: string,
): Promise<OrgMemoryFetchAttempt> {
  let probing = false;
  if (breakerOpenedAt !== null) {
    const coolingDown =
      Date.now() - breakerOpenedAt < MEMORY_BREAKER_COOLDOWN_MS;
    if (coolingDown || breakerProbeInFlight) {
      // Short-circuits do not extend or re-trip the breaker.
      return { ...BREAKER_SHORT_CIRCUIT };
    }
    probing = true;
    breakerProbeInFlight = true;
  }
  let networkAttempted = false;
  try {
    if (!(await isOrgMemoryRequestAllowed(organizationExternalId))) {
      return { result: null, factCount: 0, responseReceived: false };
    }

    const trimmedLexicalQuery = lexicalQuery?.trim() ?? '';
    const request: MemorySearchRequest = {
      organizationExternalId,
      query: queryText,
      ...(trimmedLexicalQuery.length > 0
        ? { lexicalQuery: trimmedLexicalQuery }
        : {}),
      ...(debug ? { debug: true } : {}),
    };
    networkAttempted = true;
    const response = await requestCanopyCloudJson<MemorySearchResponse>(
      `/api/v1/${BRAND.web.apiNamespace}/memory/search`,
      {
        method: 'POST',
        body: JSON.stringify(request),
        timeoutMs: CLIENT_FETCH_TIMEOUT_MS,
      },
    );
    noteBreakerNetworkSuccess();
    const renderedBlock = response.renderedBlock;
    const facts = Array.isArray(response.facts) ? response.facts : [];
    return {
      result:
        renderedBlock && renderedBlock.trim().length > 0
          ? {
              organizationExternalId,
              ...(typeof response.searchId === 'string'
                ? { searchId: response.searchId }
                : {}),
              renderedBlock,
              facts,
            }
          : null,
      factCount: facts.length,
      ...(response.diagnostics ? { diagnostics: response.diagnostics } : {}),
      responseReceived: true,
    };
  } catch (error) {
    debugFailure(error);
    if (networkAttempted) {
      noteBreakerNetworkFailure(probing);
    }
    return { result: null, factCount: 0, responseReceived: false };
  } finally {
    if (probing) {
      breakerProbeInFlight = false;
    }
  }
}

// One in-memory retry for a delivery ack whose POST failed. The server write
// is an idempotent guarded update, so a duplicate ack is harmless; process
// death losing the one pending retry is accepted noise (a durable queue was
// considered and rejected for scope).
export const ACK_RETRY_BASE_DELAY_MS = 30_000;
export const ACK_RETRY_JITTER_MS = 5_000;

export interface OrgMemoryDeliveryAckDetails {
  outcome?: MemoryDeliveryOutcome;
  dropReason?: MemoryDropReason;
  /** Dispatch-start → ack decision, clamped server-side to 0..60_000. */
  clientElapsedMs?: number;
  /** Telemetry-clamped (≤128 chars) local chat id. */
  clientChatId?: string;
}

/**
 * Acknowledge the delivery outcome for the block returned by a search: either
 * it was composed into the submitted turn (`delivered`, the default for
 * legacy callers) or it verifiably was not (`dropped` + reason).
 * Fire-and-forget by contract: failures are swallowed (the debug stderr
 * channel aside) after scheduling at most one in-memory retry ~30s later, and
 * the search circuit breaker is neither consulted nor advanced.
 */
export async function ackOrgMemoryDelivered(
  organizationExternalId: string,
  searchId: string,
  details?: OrgMemoryDeliveryAckDetails,
): Promise<void> {
  await sendOrgMemoryDeliveredAck(
    organizationExternalId,
    searchId,
    details,
    true,
  );
}

async function sendOrgMemoryDeliveredAck(
  organizationExternalId: string,
  searchId: string,
  details: OrgMemoryDeliveryAckDetails | undefined,
  allowRetry: boolean,
): Promise<void> {
  let networkAttempted = false;
  try {
    if (!(await isOrgMemoryRequestAllowed(organizationExternalId))) {
      return;
    }
    const body: MemoryDeliveredRequest = {
      organizationExternalId,
      searchId,
      ...(details?.outcome !== undefined ? { outcome: details.outcome } : {}),
      ...(details?.dropReason !== undefined
        ? { dropReason: details.dropReason }
        : {}),
      ...(details?.clientElapsedMs !== undefined
        ? { clientElapsedMs: details.clientElapsedMs }
        : {}),
      ...(details?.clientChatId !== undefined
        ? { clientChatId: details.clientChatId }
        : {}),
    };
    networkAttempted = true;
    await requestCanopyCloudJson<MemoryDeliveredResponse>(
      `/api/v1/${BRAND.web.apiNamespace}/memory/delivered`,
      {
        method: 'POST',
        body: JSON.stringify(body),
        timeoutMs: FEEDBACK_FETCH_TIMEOUT_MS,
      },
    );
  } catch (error) {
    debugFailure(error);
    // Only a failed POST earns the single retry; credential/capability gates
    // returned before any network work and will not change in 30 seconds.
    if (allowRetry && networkAttempted) {
      const delay =
        ACK_RETRY_BASE_DELAY_MS +
        Math.floor(Math.random() * ACK_RETRY_JITTER_MS);
      const timeout = setTimeout(() => {
        // The retry acks the same search in the same org.
        void sendOrgMemoryDeliveredAck(
          organizationExternalId,
          searchId,
          details,
          false,
        );
      }, delay);
      if (typeof timeout === 'object' && 'unref' in timeout) timeout.unref();
    }
  }
}

export async function submitOrgMemoryFeedback(
  request: OrgMemoryFeedbackRequest,
): Promise<OrgMemoryFeedbackResponse> {
  try {
    const { organizationExternalId } = request;
    if (!(await isOrgMemoryRequestAllowed(organizationExternalId))) {
      return { recorded: false };
    }
    const body: MemoryFeedbackRequest = {
      organizationExternalId,
      searchId: request.searchId,
      factId: request.factId,
      ...(request.rating === undefined ? {} : { rating: request.rating }),
      ...(request.comment === undefined ? {} : { comment: request.comment }),
    };
    const response = await requestCanopyCloudJson<MemoryFeedbackResponse>(
      `/api/v1/${BRAND.web.apiNamespace}/memory/feedback`,
      {
        method: 'POST',
        body: JSON.stringify(body),
        timeoutMs: FEEDBACK_FETCH_TIMEOUT_MS,
      },
    );
    return {
      recorded: response.recorded === true,
      ...(response.feedback ? { feedback: response.feedback } : {}),
    };
  } catch (error) {
    debugFailure(error);
    return { recorded: false };
  }
}

export async function getOrgMemoryFeedback(
  request: OrgMemoryFeedbackQuery,
): Promise<OrgMemoryFeedbackQueryResponse> {
  try {
    const { organizationExternalId } = request;
    if (!(await isOrgMemoryRequestAllowed(organizationExternalId))) {
      return { feedback: null, canSubmit: false };
    }
    const query = new URLSearchParams({
      organizationExternalId,
      searchId: request.searchId,
      factId: request.factId,
    });
    const response = await requestCanopyCloudJson<MemoryFeedbackQueryResponse>(
      `/api/v1/${BRAND.web.apiNamespace}/memory/feedback?${query.toString()}`,
      {
        method: 'GET',
        timeoutMs: FEEDBACK_FETCH_TIMEOUT_MS,
      },
    );
    return {
      feedback: response.feedback ?? null,
      canSubmit: response.canSubmit === true,
    };
  } catch (error) {
    debugFailure(error);
    return { feedback: null, canSubmit: false };
  }
}

export async function fetchOrgMemory(
  organizationExternalId: string,
  queryText: string,
): Promise<{ renderedBlock: string } | null> {
  const result = (
    await fetchOrgMemoryAttempt(organizationExternalId, queryText, false)
  ).result;
  return result ? { renderedBlock: result.renderedBlock } : null;
}
