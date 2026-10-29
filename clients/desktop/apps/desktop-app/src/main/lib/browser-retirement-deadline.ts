import { AsyncLocalStorage } from 'node:async_hooks';
import { logMainProcessWarn } from './main-process-logging';

/** Longest a worktree removal waits on one browser profile metadata call. */
export const BROWSER_RETIREMENT_DEADLINE_MS = 5_000;

export class BrowserRetirementTimeoutError extends Error {
  readonly code = 'timeout';

  constructor() {
    super('Browser profile metadata did not respond in time.');
    this.name = 'BrowserRetirementTimeoutError';
  }
}

interface BrowserRetirementDeadlineScope {
  /** The expired call this scope's later calls are skipped behind. */
  abandoned: Promise<unknown> | null;
}

const deadlineScope = new AsyncLocalStorage<BrowserRetirementDeadlineScope>();

/** Only the code is logged: errors from Git or storage can contain local paths. */
function lateFailureCode(error: unknown): string {
  return error instanceof Error &&
    'code' in error &&
    typeof error.code === 'string'
    ? error.code
    : 'other';
}

/**
 * Bounds what one removal spends waiting on profile metadata. While a call in
 * the scope has expired and is still unanswered, later calls are skipped
 * instead of each waiting out its own deadline against the same unavailable
 * metadata. Once that call settles, metadata is answering again and later
 * calls get their own deadline.
 */
export function runWithBrowserRetirementDeadlineScope<T>(
  operation: () => Promise<T>,
): Promise<T> {
  return deadlineScope.run({ abandoned: null }, operation);
}

/** Whether an expired profile call of the current removal is still unanswered. */
export function hasBrowserRetirementDeadlineExpired(): boolean {
  return Boolean(deadlineScope.getStore()?.abandoned);
}

/**
 * Profile metadata must never hold a worktree removal. A call that outlasts
 * the deadline rejects with {@link BrowserRetirementTimeoutError} so the
 * caller can defer it the way it defers a thrown error.
 *
 * The call is abandoned, not cancelled: it still completes once the metadata
 * is free, usually right after the removal that stopped waiting releases its
 * own locks. `settleLate` receives that late result when completing late
 * would otherwise leave state nothing else settles.
 */
export async function withBrowserRetirementDeadline<T>(
  call: () => Promise<T>,
  settleLate?: (value: T) => Promise<void>,
): Promise<T> {
  const scope = deadlineScope.getStore();
  if (scope?.abandoned) throw new BrowserRetirementTimeoutError();
  const expired = new BrowserRetirementTimeoutError();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pending = call();
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(expired);
        }, BROWSER_RETIREMENT_DEADLINE_MS);
      }),
    ]);
  } catch (error) {
    if (error === expired) {
      if (scope) {
        scope.abandoned = pending;
        // An answer, even a failure, means metadata is responding again, so
        // later calls of this removal get their own deadline. The chain below
        // logs a late failure.
        const answered = (): void => {
          if (scope.abandoned === pending) scope.abandoned = null;
        };
        void pending.then(answered, answered);
      }
      void pending
        .then((value) => settleLate?.(value))
        // Already deferred; startup reconciliation is the remaining retry.
        // Nothing awaits this call any more, so the log is its only trace.
        .catch((lateError: unknown) => {
          logMainProcessWarn(
            'Browser profile retirement failed after its deadline',
            {
              operation: 'browser_retirement_deadline',
              code: lateFailureCode(lateError),
            },
          );
        });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
