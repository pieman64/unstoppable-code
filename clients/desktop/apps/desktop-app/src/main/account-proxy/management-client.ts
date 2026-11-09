import { classifyError } from '@canopy/protocol/app-errors/classification';
import {
  classifyFetchFailure,
  retryAtFromDelay,
} from '@canopy/desktop-shared/node/lib/app-error-classification';
// Minimal client for CLIProxyAPI's v8 management API. Every response carries
// `X-CPA-VERSION`, which is how a non-proxy server and an outdated proxy are
// told apart from a wrong key.
//
// The proxy blocks an address for 30 minutes after five wrong keys, and the
// block also rejects the right key. Callers must therefore never retry a key
// the server rejected; the service stops refreshing until the user enters a
// new one.

import {
  isSupportedAccountProxyVersion,
  parseAccountProxyVersion,
} from '@canopy/desktop-shared/lib/account-proxy';
import type { AccountProxyErrorCode } from '@canopy/desktop-shared/types/account-proxy';
import {
  revealLocalAccountProxyKey,
  type LocalAccountProxyKey,
} from './local-launch-keys';

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export class AccountProxyManagementError extends Error {
  readonly code: AccountProxyErrorCode;

  constructor(code: AccountProxyErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'AccountProxyManagementError';
    this.code = code;
  }
}

export interface AccountProxyManagementResponse {
  readonly version: string;
  readonly body: unknown;
}

/**
 * A server's management key, or the handle of the proxy on this device's
 * current launch key.
 */
export type AccountProxyManagementKey = string | LocalAccountProxyKey;

export interface AccountProxyManagementRequest {
  readonly baseUrl: string;
  readonly managementKey: AccountProxyManagementKey;
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Path under `/v8/management`, with its query string. */
  readonly path: string;
  readonly body?: unknown;
  readonly signal?: AbortSignal;
}

/**
 * Reads at most {@link MAX_RESPONSE_BYTES}, counting bytes as they arrive, so
 * a server that streams an endless body cannot fill the main process's
 * memory. The read is cancelled as soon as it goes over.
 */
async function readBody(response: Response): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new AccountProxyManagementError('unexpected');
  }
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new AccountProxyManagementError('unexpected');
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

function parseJson(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export async function requestAccountProxyManagement(
  request: AccountProxyManagementRequest,
): Promise<AccountProxyManagementResponse> {
  // A cancelled caller sends nothing, so a key it no longer trusts is not
  // offered to the server again.
  request.signal?.throwIfAborted();
  const managementKey =
    typeof request.managementKey === 'string'
      ? request.managementKey
      : revealLocalAccountProxyKey(request.managementKey);
  // The launch this key belonged to has ended. A later proxy process would
  // count it as a wrong key toward its block, so nothing is sent.
  if (managementKey === null) {
    throw new AccountProxyManagementError('unreachable');
  }
  const signal = request.signal
    ? AbortSignal.any([request.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
    : AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`${request.baseUrl}/v8/management${request.path}`, {
      method: request.method,
      headers: {
        authorization: `Bearer ${managementKey}`,
        accept: 'application/json',
        ...(request.body !== undefined
          ? { 'content-type': 'application/json' }
          : {}),
      },
      ...(request.body !== undefined
        ? { body: JSON.stringify(request.body) }
        : {}),
      redirect: 'error',
      signal,
    });
  } catch (error) {
    if (request.signal?.aborted) throw error;
    throw classifyFetchFailure(
      error,
      new AccountProxyManagementError('unreachable'),
    );
  }
  // Headers first: a server that is not a proxy, or one too old to speak
  // this API, never gets its body read.
  const version = parseAccountProxyVersion(
    response.headers.get('x-cpa-version'),
  );
  if (!version || !isSupportedAccountProxyVersion(version.major)) {
    await response.body?.cancel().catch(() => undefined);
    throw version
      ? new AccountProxyManagementError('too-old', version.raw)
      : new AccountProxyManagementError('not-proxy');
  }
  // A rejection is classified from its status before the body is read, so a
  // body that fails to arrive can never make it look retryable.
  if (response.status === 401) {
    await response.body?.cancel().catch(() => undefined);
    throw classifyError(
      new AccountProxyManagementError('unauthorized'),
      'external.sign_in_required',
    );
  }
  if (
    response.status === 429 ||
    (response.status >= 500 && response.status <= 599)
  ) {
    await response.body?.cancel().catch(() => undefined);
    const error = new AccountProxyManagementError('unexpected');
    if (response.status === 429) {
      const seconds = Number(response.headers.get('retry-after'));
      throw classifyError(error, 'external.rate_limited', {
        retryAt: retryAtFromDelay(
          response.headers.has('retry-after') ? seconds * 1000 : undefined,
        ),
      });
    }
    throw classifyError(error, 'external.service_unavailable');
  }
  let text: string;
  try {
    text = await readBody(response);
  } catch (error) {
    if (response.status === 403) {
      throw new AccountProxyManagementError('unauthorized');
    }
    if (error instanceof AccountProxyManagementError) throw error;
    if (request.signal?.aborted) throw error;
    throw classifyFetchFailure(
      error,
      new AccountProxyManagementError('unreachable'),
    );
  }
  if (response.status === 403) {
    if (/banned|too many failed/i.test(text)) {
      throw new AccountProxyManagementError('blocked');
    }
    if (/remote management disabled/i.test(text)) {
      throw new AccountProxyManagementError('remote-management-disabled');
    }
    throw new AccountProxyManagementError('unauthorized');
  }
  if (response.status === 404) {
    throw new AccountProxyManagementError('management-disabled');
  }
  if (!response.ok) {
    throw new AccountProxyManagementError('unexpected');
  }
  return { version: version.raw, body: parseJson(text) };
}
