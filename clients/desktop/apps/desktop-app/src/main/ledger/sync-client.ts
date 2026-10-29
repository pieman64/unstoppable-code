import type { LedgerSyncRepairReason } from '@canopy/desktop-shared/node/ledger';
import {
  LedgerScopeRegisterRequestSchema,
  LedgerScopeRegisterResponseSchema,
  LedgerSyncPushRequestSchema,
  LedgerSyncPushResponseSchema,
  type LedgerScopeRegisterRequest,
  type LedgerScopeRegisterResponse,
  type LedgerSyncPushRequest,
  type LedgerSyncPushResponse,
} from '@canopy/protocol/ledger-sync';
import type { z } from 'zod';
import {
  CanopyCloudClientError,
  requestCanopyCloudJson,
  type CanopyCloudAuthenticatedRequestInit,
} from '../canopy-cloud/client';

/*
 * The mirror's write API as Ledger sync calls it, through the authenticated
 * cloud client. Every outcome is a value: a failure says what sync should do
 * next, never what an entry said.
 */

/** Why a call did not succeed, as what to do about it. */
export type LedgerSyncFailure =
  /** Try again later: the network, the server, or ingest switched off. */
  | { readonly kind: 'retry'; readonly retryAfterMs?: number }
  /** Nothing can be sent until the account or its access changes. */
  | { readonly kind: 'paused' }
  /** An organization prohibits sharing summaries. */
  | { readonly kind: 'prohibited' }
  /** The project asked for cannot share this scope with an organization. */
  | { readonly kind: 'audience_forbidden' }
  /** The request named an account other than the one signed in. */
  | { readonly kind: 'stale_binding' }
  /** The mirror does not hold the scope for this account: register first. */
  | { readonly kind: 'not_registered' }
  /** The scope cannot sync until it is repaired. */
  | { readonly kind: 'repair'; readonly reason: LedgerSyncRepairReason };

export type LedgerSyncResult<Value> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly failure: LedgerSyncFailure };

/** Each call can be cancelled with `signal`; a cancelled call is retried. */
export interface LedgerMirrorClient {
  register(
    request: LedgerScopeRegisterRequest,
    signal?: AbortSignal,
  ): Promise<LedgerSyncResult<LedgerScopeRegisterResponse>>;
  push(
    request: LedgerSyncPushRequest,
    signal?: AbortSignal,
  ): Promise<LedgerSyncResult<LedgerSyncPushResponse>>;
}

const RETRY: LedgerSyncFailure = { kind: 'retry' };
const PAUSED: LedgerSyncFailure = { kind: 'paused' };

function repair(reason: LedgerSyncRepairReason): LedgerSyncFailure {
  return { kind: 'repair', reason };
}

/** What each of the mirror's refusals asks of sync. */
const FAILURE_BY_SERVER_CODE: {
  readonly [code: string]: LedgerSyncFailure | undefined;
} = {
  ledger_scope_prohibited: { kind: 'prohibited' },
  ledger_audience_forbidden: { kind: 'audience_forbidden' },
  ledger_stale_binding: { kind: 'stale_binding' },
  ledger_scope_not_registered: { kind: 'not_registered' },
  ledger_stale_writer: repair('stale_writer'),
  ledger_sequence_gap: repair('sequence_gap'),
  ledger_divergent_event: repair('divergent_event'),
  ledger_illegal_event: repair('illegal_event'),
  ledger_invalid_request: repair('invalid_request'),
};

function retryAfter(error: CanopyCloudClientError): LedgerSyncFailure {
  return error.retryAfterMs === undefined
    ? RETRY
    : { kind: 'retry', retryAfterMs: error.retryAfterMs };
}

function httpFailure(error: CanopyCloudClientError): LedgerSyncFailure {
  const status = error.status ?? 0;
  if (error.serverCode === 'ledger_ingest_disabled') return retryAfter(error);
  const known =
    error.serverCode === undefined
      ? undefined
      : FAILURE_BY_SERVER_CODE[error.serverCode];
  if (known !== undefined) return known;
  if (status === 401 || status === 403) return PAUSED;
  // A server that predates the mirror answers 404: the outbox waits for it.
  if (status === 404 || status === 408 || status === 425 || status === 429) {
    return retryAfter(error);
  }
  if (status >= 500) return retryAfter(error);
  // Any other refusal would be refused again: the scope needs repair.
  return repair('invalid_request');
}

/** What a failed call asks of sync. Anything unexpected is tried again. */
export function ledgerSyncFailureFor(error: unknown): LedgerSyncFailure {
  if (!(error instanceof CanopyCloudClientError)) return RETRY;
  switch (error.code) {
    case 'cloud-not-configured':
    case 'missing-api-key':
    case 'unsupported-capability':
      return PAUSED;
    case 'network-error':
    case 'invalid-response':
      return RETRY;
    case 'http-error':
      return httpFailure(error);
  }
}

type CloudJsonRequest = (
  pathname: string,
  init: CanopyCloudAuthenticatedRequestInit,
) => Promise<unknown>;

/** Every request and answer names the scope it is about. */
interface LedgerScoped {
  readonly ledgerId: string;
}

interface LedgerPost<
  Request extends LedgerScoped,
  Response extends LedgerScoped,
> {
  readonly pathname: string;
  readonly timeoutMs: number;
  readonly requestSchema: z.ZodType<Request>;
  readonly responseSchema: z.ZodType<Response>;
}

async function post<
  Request extends LedgerScoped,
  Response extends LedgerScoped,
>(
  request: CloudJsonRequest,
  route: LedgerPost<Request, Response>,
  body: Request,
  signal: AbortSignal | undefined,
): Promise<LedgerSyncResult<Response>> {
  const { pathname, timeoutMs, requestSchema, responseSchema } = route;
  // A request the contract would refuse is never sent, and never retried.
  const outgoing = requestSchema.safeParse(body);
  if (!outgoing.success) {
    return { ok: false, failure: repair('invalid_request') };
  }
  let answer: unknown;
  try {
    answer = await request(pathname, {
      method: 'POST',
      body: JSON.stringify(outgoing.data),
      timeoutMs,
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (error) {
    return { ok: false, failure: ledgerSyncFailureFor(error) };
  }
  const parsed = responseSchema.safeParse(answer);
  // An answer that is not the contract's, or is about another scope, says
  // nothing about what was applied to this one.
  return parsed.success && parsed.data.ledgerId === outgoing.data.ledgerId
    ? { ok: true, value: parsed.data }
    : { ok: false, failure: RETRY };
}

const REGISTER_ROUTE: LedgerPost<
  LedgerScopeRegisterRequest,
  LedgerScopeRegisterResponse
> = {
  pathname: '/api/v1/ledger/scopes/register',
  timeoutMs: 15_000,
  requestSchema: LedgerScopeRegisterRequestSchema,
  responseSchema: LedgerScopeRegisterResponseSchema,
};

const PUSH_ROUTE: LedgerPost<LedgerSyncPushRequest, LedgerSyncPushResponse> = {
  pathname: '/api/v1/ledger/sync/push',
  // Longer than the mirror's own budget for applying one batch.
  timeoutMs: 30_000,
  requestSchema: LedgerSyncPushRequestSchema,
  responseSchema: LedgerSyncPushResponseSchema,
};

/** The mirror client over the signed-in account's cloud credentials. */
export function createLedgerMirrorClient(
  request: CloudJsonRequest = requestCanopyCloudJson,
): LedgerMirrorClient {
  return {
    register: (body, signal) => post(request, REGISTER_ROUTE, body, signal),
    push: (body, signal) => post(request, PUSH_ROUTE, body, signal),
  };
}
