import type {
  AgentFailureClassification,
  TransientAgentRetryOptions,
} from '../types/agent-failures';
import {
  mergeHelperUsage,
  readHelperUsage,
  writeHelperUsage,
  type HelperUsage,
} from '../lib/helper-usage';
import { CHAT_TRANSIENT_RETRY_DELAYS_MS } from './backoff';
import { classifyAgentFailure } from './classifier';

export type {
  TransientAgentRetryNotice,
  TransientAgentRetryOptions,
} from '../types/agent-failures';

export class TransientAgentRetryExhaustedError extends Error {
  readonly classification: AgentFailureClassification;
  readonly originalError: unknown;
  readonly usage: HelperUsage;

  constructor(
    cause: unknown,
    classification: AgentFailureClassification,
    usage: HelperUsage,
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'TransientAgentRetryExhaustedError';
    this.classification = classification;
    this.originalError = cause;
    this.usage = usage;
  }
}

export function isTransientAgentRetryExhaustedError(
  error: unknown,
): error is TransientAgentRetryExhaustedError {
  return error instanceof TransientAgentRetryExhaustedError;
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error('Background agent retry was aborted.');
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw abortReason(signal);
  }
}

async function waitForRetry(
  delayMs: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  throwIfAborted(signal);
  await new Promise<void>((resolve, reject) => {
    function cleanup(): void {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', handleAbort);
    }
    const handleAbort = (): void => {
      cleanup();
      reject(signal ? abortReason(signal) : new Error('Retry aborted.'));
    };
    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, delayMs);
    signal?.addEventListener('abort', handleAbort, { once: true });
  });
  throwIfAborted(signal);
}

/**
 * Run background agent work with the same transient-failure classifier and
 * retry cadence used by interactive chats.
 */
export async function runWithTransientAgentRetry<T>(
  options: TransientAgentRetryOptions<T>,
): Promise<T> {
  const delays = options.delaysMs ?? CHAT_TRANSIENT_RETRY_DELAYS_MS;
  let cumulativeUsage: HelperUsage = {};
  let transientAttempt = 0;

  for (let attempt = 0; ; attempt += 1) {
    throwIfAborted(options.signal);
    const events: unknown[] = [];
    try {
      const result = await options.runAttempt(
        (event) => events.push(event),
        attempt + 1,
      );
      const attemptUsage = readHelperUsage(result);
      if (attemptUsage) {
        cumulativeUsage = mergeHelperUsage(cumulativeUsage, attemptUsage);
      }
      if (Object.values(cumulativeUsage).some((value) => value !== undefined)) {
        writeHelperUsage(result, cumulativeUsage);
      }
      return result;
    } catch (error) {
      throwIfAborted(options.signal);
      const attemptUsage = readHelperUsage(error);
      if (attemptUsage) {
        cumulativeUsage = mergeHelperUsage(cumulativeUsage, attemptUsage);
      }
      const classification = classifyAgentFailure({
        provider: options.provider,
        model: options.model,
        accountScope: options.accountScope ?? 'native',
        events,
        error,
      });
      if (
        classification?.kind === 'provider_usage_limit' &&
        options.waitForQuotaRecovery
      ) {
        try {
          await options.waitForQuotaRecovery(classification, options.signal);
          throwIfAborted(options.signal);
        } catch (waitError) {
          const finalError =
            waitError instanceof Error
              ? waitError
              : new Error(String(waitError));
          throw Object.assign(finalError, { usage: cumulativeUsage });
        }
        await options.onRetry?.({
          attempt: attempt + 1,
          nextAttempt: attempt + 2,
          delayMs: 0,
          classification,
        });
        continue;
      }
      if (classification?.kind !== 'provider_temporarily_unavailable') {
        if (
          Object.values(cumulativeUsage).some((value) => value !== undefined)
        ) {
          const finalError =
            error instanceof Error ? error : new Error(String(error));
          throw Object.assign(finalError, { usage: cumulativeUsage });
        }
        throw error;
      }
      const delayMs = delays[transientAttempt];
      transientAttempt += 1;
      if (delayMs === undefined) {
        throw new TransientAgentRetryExhaustedError(
          error,
          classification,
          cumulativeUsage,
        );
      }
      await options.onRetry?.({
        attempt: attempt + 1,
        nextAttempt: attempt + 2,
        delayMs,
        classification,
      });
      await waitForRetry(delayMs, options.signal);
    }
  }
}
