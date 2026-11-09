import type { BrowserRectangle } from '@canopy/execution-engine/types/browser';
import { isCDPRecord } from './cdp-decode';
import type { PageModelDeps } from './model-types';

export const REQUEST_TIMEOUT_MS = 10_000;
export const REQUEST_RETRY_TIMEOUT_MS = 2_000;

export function abortError(): Error {
  const error = new Error('Page model extraction aborted.');
  error.name = 'AbortError';
  return error;
}

export function ensureNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError();
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

export function elapsed(start: number, end: number): number {
  return Math.max(0, end - start);
}

export function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
    };
    const resolveOnce = (value: T): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const rejectOnce = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error instanceof Error ? error : new Error('CDP request failed.'));
    };
    const timeout = setTimeout(
      () => {
        rejectOnce(new Error('CDP request timed out.'));
      },
      Math.max(0, timeoutMs),
    );
    const onAbort = (): void => rejectOnce(abortError());
    if (signal?.aborted) {
      rejectOnce(abortError());
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    operation.then(resolveOnce, rejectOnce);
  });
}

/**
 * Sends one CDP request bounded by its own timeout and an optional absolute
 * deadline on `deps.now()`'s clock. CDP error payloads become rejections.
 */
export async function sendOnce(
  deps: Pick<PageModelDeps, 'send' | 'now' | 'signal'>,
  method: string,
  params: Record<string, unknown>,
  sessionId: string,
  timeoutMs: number = REQUEST_TIMEOUT_MS,
  deadline?: number,
): Promise<unknown> {
  ensureNotAborted(deps.signal);
  const remaining = deadline === undefined ? timeoutMs : deadline - deps.now();
  if (remaining <= 0) throw new Error('CDP request timed out.');
  const response = await withTimeout(
    deps.send(method, params, sessionId),
    Math.min(timeoutMs, remaining),
    deps.signal,
  );
  if (isCDPRecord(response) && response.error !== undefined) {
    throw new Error('CDP returned an error response.');
  }
  return response;
}

export function rectangle(
  x: number,
  y: number,
  width: number,
  height: number,
): BrowserRectangle {
  return { x, y, width, height };
}

export function intersectRectangles(
  first: BrowserRectangle,
  second: BrowserRectangle,
): BrowserRectangle {
  const x = Math.max(first.x, second.x);
  const y = Math.max(first.y, second.y);
  const right = Math.min(first.x + first.width, second.x + second.width);
  const bottom = Math.min(first.y + first.height, second.y + second.height);
  return rectangle(x, y, Math.max(0, right - x), Math.max(0, bottom - y));
}

/** Origin and pathname only: credentials, query and fragment are excluded. */
export function safeCoverageURL(rawURL: string): string {
  if (rawURL.length === 0) return '';
  try {
    const url = new URL(rawURL);
    if (url.protocol === 'about:') return `${url.protocol}${url.pathname}`;
    if (
      url.protocol !== 'http:' &&
      url.protocol !== 'https:' &&
      url.protocol !== 'ws:' &&
      url.protocol !== 'wss:'
    ) {
      return '';
    }
    return `${url.origin}${url.pathname}`;
  } catch {
    return '';
  }
}
