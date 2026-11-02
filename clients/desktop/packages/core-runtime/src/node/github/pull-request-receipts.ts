import { CanopyOperationError } from '../../runtime/errors';

/** Settled receipts kept per store; the oldest settled one goes first. */
export const PULL_REQUEST_RECEIPT_LIMIT = 256;

export interface PullRequestReceiptKey {
  readonly principalId: string;
  readonly operation: string;
  readonly idempotencyKey: string;
}

interface Receipt<T> {
  readonly fingerprint: string;
  readonly outcome: Promise<T>;
  settled: boolean;
}

/**
 * Bounded in-memory receipts for the keyed `core.pullRequest.*`
 * instructions (CAN-4109 D9), by caller principal, operation and
 * idempotency key. A receipt holds the write's outcome, so a same-key retry
 * waits for or reuses it instead of writing again; other params under the
 * key fail with `core.pullRequest.idempotencyKeyReused`. A failed write
 * keeps no receipt, so its retry writes. Receipts do not survive a restart;
 * durable receipts are CAN-4733's.
 */
export interface PullRequestReceipts<T> {
  run(
    key: PullRequestReceiptKey,
    fingerprint: string,
    write: () => Promise<T>,
  ): Promise<T>;
}

function idempotencyKeyReused(): CanopyOperationError {
  return new CanopyOperationError({
    kind: 'conflict',
    code: 'core.pullRequest.idempotencyKeyReused',
    message: 'The idempotency key was used with other params.',
    retry: { kind: 'after_refresh', resource: 'idempotency-key' },
  });
}

export function createPullRequestReceipts<T>(
  limit = PULL_REQUEST_RECEIPT_LIMIT,
): PullRequestReceipts<T> {
  const receipts = new Map<string, Receipt<T>>();
  let settledCount = 0;
  const evict = (): void => {
    // Map order is insertion order: the first settled receipts are the oldest.
    for (const [id, receipt] of receipts) {
      if (settledCount <= limit) return;
      if (!receipt.settled) continue;
      receipts.delete(id);
      settledCount -= 1;
    }
  };
  return {
    run(key, fingerprint, write): Promise<T> {
      const id = JSON.stringify([
        key.principalId,
        key.operation,
        key.idempotencyKey,
      ]);
      const existing = receipts.get(id);
      if (existing)
        return existing.fingerprint === fingerprint
          ? existing.outcome
          : Promise.reject(idempotencyKeyReused());
      const outcome = Promise.resolve().then(write);
      const receipt: Receipt<T> = { fingerprint, outcome, settled: false };
      receipts.set(id, receipt);
      outcome.then(
        () => {
          receipt.settled = true;
          settledCount += 1;
          evict();
        },
        () => {
          if (receipts.get(id) === receipt) receipts.delete(id);
        },
      );
      return outcome;
    },
  };
}
