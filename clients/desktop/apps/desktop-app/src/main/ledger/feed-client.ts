import { LedgerUuidSchema } from '@canopy/protocol/canopy-core';
import {
  LEDGER_MIRROR_CAPABILITIES_HEADER,
  LEDGER_MIRROR_OPERATIONS_CAPABILITY,
  LedgerMirrorEntryResponseV2Schema,
  LEDGER_MIRROR_GLOBAL_READ_VERSION,
  LEDGER_MIRROR_VERSION_HEADER,
  LedgerMirrorSearchRequestV2Schema,
  LedgerMirrorSearchResponseV2Schema,
  type LedgerMirrorEntryResponseV2,
  type LedgerMirrorSearchRequestV2,
  type LedgerMirrorSearchResponseV2,
} from '@canopy/protocol/ledger-sync';
import {
  CanopyCloudClientError,
  requestCanopyCloudJson,
  resolveCanopyCloudCredentialContext,
  type CanopyCloudAuthenticatedRequestInit,
  type CanopyCloudCredentialContext,
} from '../canopy-cloud/client';

/*
 * The mirror's read API as the Feed calls it (phase 14, LD03), through the
 * authenticated cloud client: searches of the account's own scopes on every
 * device and of its teammates', and one entry with its history. Every outcome
 * is a value; nothing an entry says reaches a failure.
 *
 * Each read is for one account, and sends exactly that account's
 * credentials: an answer is always the account's own, whatever signs in
 * while it is on its way (LD02).
 */

/**
 * Every read negotiates version 2, so rows of global (workflow) scopes come
 * back with their owner. A mirror without global scopes ignores the header
 * and answers version 1, which this reader still accepts.
 */
const MIRROR_READ_HEADERS: Readonly<Record<string, string>> = {
  [LEDGER_MIRROR_VERSION_HEADER]: String(LEDGER_MIRROR_GLOBAL_READ_VERSION),
  // Operations and parents, from a mirror that has them; one that predates
  // them ignores the header.
  [LEDGER_MIRROR_CAPABILITIES_HEADER]: LEDGER_MIRROR_OPERATIONS_CAPABILITY,
};

/** Why a read did not succeed, as what the Feed does about it. */
export type LedgerMirrorReadFailure =
  /** The cloud could not be reached, or failed: show this device's work. */
  | 'unavailable'
  /** The search's cursor expired or its snapshot changed: search again. */
  | 'expired'
  /** The entry is not in the mirror, or the account may not read it. */
  | 'not_found'
  /** The read's account is no longer the one signed in: nothing was sent. */
  | 'account_changed';

export type LedgerMirrorReadResult<Value> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly failure: LedgerMirrorReadFailure };

/** Each call reads as `accountId`, and can be cancelled with `signal`. */
export interface LedgerMirrorReader {
  search(
    request: LedgerMirrorSearchRequestV2,
    accountId: string,
    signal?: AbortSignal,
  ): Promise<LedgerMirrorReadResult<LedgerMirrorSearchResponseV2>>;
  getEntry(
    entryId: string,
    options: { readonly beforeRevision?: number },
    accountId: string,
    signal?: AbortSignal,
  ): Promise<LedgerMirrorReadResult<LedgerMirrorEntryResponseV2>>;
}

/** A search is a page the person waits for. */
const SEARCH_TIMEOUT_MS = 15_000;
const ENTRY_TIMEOUT_MS = 15_000;

type CloudJsonRequest = (
  pathname: string,
  init: CanopyCloudAuthenticatedRequestInit,
) => Promise<unknown>;

/** The signed-in account's credentials, or null when there are none. */
type CredentialSource = () => Promise<CanopyCloudCredentialContext | null>;

async function signedInCredentials(): Promise<CanopyCloudCredentialContext | null> {
  try {
    return await resolveCanopyCloudCredentialContext();
  } catch {
    return null;
  }
}

/** The credentials of `accountId`, only while it is the one signed in. */
async function credentialsOf(
  source: CredentialSource,
  accountId: string,
): Promise<CanopyCloudCredentialContext | null> {
  const credentials = await source();
  return credentials?.account?.id.trim() === accountId ? credentials : null;
}

/** What a failed read means for the Feed. */
export function ledgerMirrorReadFailureFor(
  error: unknown,
): LedgerMirrorReadFailure {
  if (!(error instanceof CanopyCloudClientError)) return 'unavailable';
  if (error.code !== 'http-error') return 'unavailable';
  if (error.serverCode === 'ledger_cursor_expired') return 'expired';
  const status = error.status ?? 0;
  return status === 404 || status === 403 ? 'not_found' : 'unavailable';
}

async function read<Value>(
  request: CloudJsonRequest,
  pathname: string,
  init: CanopyCloudAuthenticatedRequestInit,
  parse: (answer: unknown) => Value | null,
): Promise<LedgerMirrorReadResult<Value>> {
  let answer: unknown;
  try {
    answer = await request(pathname, init);
  } catch (error) {
    return { ok: false, failure: ledgerMirrorReadFailureFor(error) };
  }
  const value = parse(answer);
  // An answer that is not the contract's says nothing the Feed can show.
  return value === null
    ? { ok: false, failure: 'unavailable' }
    : { ok: true, value };
}

/** The mirror reader over the signed-in account's cloud credentials. */
export function createLedgerMirrorReader(
  request: CloudJsonRequest = requestCanopyCloudJson,
  credentials: CredentialSource = signedInCredentials,
): LedgerMirrorReader {
  return {
    search: async (
      body,
      accountId,
      signal,
    ): Promise<LedgerMirrorReadResult<LedgerMirrorSearchResponseV2>> => {
      // A search the contract would refuse is never sent. The reader sends the
      // operations capability, so the mirror reads the V2 request.
      const outgoing = LedgerMirrorSearchRequestV2Schema.safeParse(body);
      if (!outgoing.success) return { ok: false, failure: 'unavailable' };
      const credentialContext = await credentialsOf(credentials, accountId);
      if (credentialContext === null) {
        return { ok: false, failure: 'account_changed' };
      }
      return read(
        request,
        '/api/v1/ledger/search',
        {
          method: 'POST',
          headers: MIRROR_READ_HEADERS,
          body: JSON.stringify(outgoing.data),
          timeoutMs: SEARCH_TIMEOUT_MS,
          credentialContext,
          ...(signal === undefined ? {} : { signal }),
        },
        (answer) => {
          const parsed = LedgerMirrorSearchResponseV2Schema.safeParse(answer);
          return parsed.success ? parsed.data : null;
        },
      );
    },
    getEntry: async (
      entryId,
      options,
      accountId,
      signal,
    ): Promise<LedgerMirrorReadResult<LedgerMirrorEntryResponseV2>> => {
      if (!LedgerUuidSchema.safeParse(entryId).success) {
        return { ok: false, failure: 'not_found' };
      }
      const credentialContext = await credentialsOf(credentials, accountId);
      if (credentialContext === null) {
        return { ok: false, failure: 'account_changed' };
      }
      const query =
        options.beforeRevision === undefined
          ? ''
          : `?beforeRevision=${String(options.beforeRevision)}`;
      return read(
        request,
        `/api/v1/ledger/entries/${encodeURIComponent(entryId)}${query}`,
        {
          method: 'GET',
          headers: MIRROR_READ_HEADERS,
          timeoutMs: ENTRY_TIMEOUT_MS,
          credentialContext,
          ...(signal === undefined ? {} : { signal }),
        },
        (answer) => {
          const parsed = LedgerMirrorEntryResponseV2Schema.safeParse(answer);
          // An answer about another entry says nothing about this one.
          return parsed.success && parsed.data.entry.entryId === entryId
            ? parsed.data
            : null;
        },
      );
    },
  };
}
