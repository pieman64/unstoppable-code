import { createHash, randomUUID } from 'node:crypto';
import type {
  W5CommitRequest,
  W5ReceiptLookup,
  W5ReservationFailureDiagnostics,
} from '@canopy/desktop-shared/node/w5-commit-log';
import { W5CommitRefusedError } from '@canopy/desktop-shared/node/w5-commit-log/errors';
import {
  getW5ReceiptStore,
  type W5CommitOptions,
} from './w5-commit-log-file-store';
import { isRecord } from './type-guards';

/** Owned by one keyed attempt; no async-context state leaks into child operations. */
export interface W5KeyedAttempt {
  beforeEffects(this: void): void;
  /** Capture only this boundary's synchronous, read-only validation errors. */
  validate(this: void, check: () => void): void;
  /** Tag an error created by a read-only branch/base validator; preserve identity/copy. */
  validationError(this: void, error: Error): Error;
}

function failureDiagnostics(
  operation: string,
  error: unknown,
): W5ReservationFailureDiagnostics {
  const diagnostics: W5ReservationFailureDiagnostics = {
    operation,
    errorName: 'UnknownError',
  };
  try {
    if (
      error instanceof Error &&
      /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(error.name)
    )
      diagnostics.errorName = error.name;
    if (
      isRecord(error) &&
      typeof error.code === 'string' &&
      /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)
    )
      diagnostics.errorCode = error.code;
  } catch {
    // Error accessors are untrusted too. Never substitute the original failure.
  }
  return diagnostics;
}

/** Sorted JSON object keys; array order is semantic. Callers select validated fields. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .filter((key) => value[key] !== undefined)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  }
  if (value === null || ['string', 'boolean', 'number'].includes(typeof value))
    return value;
  throw new Error('W5 parameters must be JSON values');
}

/** No lock spans effects. SQLite reservation uniqueness closes concurrent admission. */
export async function runKeyedW5Operation<T>(
  input: {
    caller: string;
    operation: string;
    idempotencyKey: string;
    parameters: unknown;
    /** State-dependent read-only admission runs only for a new key. */
    admit?: () => Promise<void>;
    /** Boundary-owned typed refusals, only safe before the attempt's first effect. */
    isPreEffectRefusal: (error: unknown) => boolean;
  },
  decode: (outcome: unknown) => T,
  work: (binding: W5CommitOptions, attempt: W5KeyedAttempt) => Promise<T>,
): Promise<T> {
  const receipt: NonNullable<W5CommitRequest['receipt']> = {
    caller: input.caller,
    operation: input.operation,
    idempotencyKey: input.idempotencyKey,
    fingerprint: createHash('sha256')
      .update(JSON.stringify(canonical(input.parameters)))
      .digest('hex'),
  };
  const store = getW5ReceiptStore();
  const admit = (
    lookup: W5ReceiptLookup,
  ): { status: 'none' } | { status: 'replay'; outcome: T } => {
    switch (lookup.status) {
      case 'replay':
        return { status: 'replay', outcome: decode(lookup.outcome) };
      case 'key-reused':
        throw new W5CommitRefusedError(
          'key-reused',
          'This request was already completed with different details.',
        );
      case 'replay-expired':
        throw new W5CommitRefusedError(
          'outcome-expired',
          'This request was already completed; its saved outcome has expired.',
          { commitId: lookup.commitId },
        );
      case 'in-progress':
        throw new W5CommitRefusedError(
          'in-progress',
          'This request is still in progress.',
          { reservationId: lookup.reservationId },
        );
      case 'commit-recovery-required':
        throw new W5CommitRefusedError(
          'recovery-required',
          'This request was saved but did not finish and needs recovery.',
          { commitId: lookup.commitId },
        );
      case 'recovery-required':
        throw new W5CommitRefusedError(
          'recovery-required',
          'An earlier attempt of this request was interrupted and needs recovery.',
          { reservationId: lookup.reservationId },
        );
      case 'none':
        return { status: 'none' };
    }
  };
  const admission = admit(await store.lookupReceipt(receipt));
  if (admission.status === 'replay') return admission.outcome;
  await input.admit?.();
  const reservationId = randomUUID();
  // Reclassify a racing winner after a reserve refusal, without retrying work.
  // Never release uncertain reservations.
  try {
    await store.reserve({ reservationId, operation: input.operation, receipt });
  } catch (error) {
    if (error instanceof W5CommitRefusedError) {
      const latest = admit(await store.lookupReceipt(receipt));
      if (latest.status === 'replay') return latest.outcome;
    }
    throw error;
  }
  let effectsStarted = false;
  const validationErrors = new Set<unknown>();
  const attempt: W5KeyedAttempt = {
    beforeEffects: () => {
      effectsStarted = true;
    },
    validate: (check) => {
      try {
        check();
      } catch (error) {
        validationErrors.add(error);
        throw error;
      }
    },
    validationError: (error) => {
      validationErrors.add(error);
      return error;
    },
  };
  try {
    return await work(
      {
        operation: input.operation,
        receipt,
        reservationId,
        beforeDecision: attempt.beforeEffects,
      },
      attempt,
    );
  } catch (error) {
    try {
      if (
        !effectsStarted &&
        (validationErrors.has(error) || input.isPreEffectRefusal(error))
      ) {
        await store.releaseReservation(reservationId);
      } else {
        await store.markReservationRecoveryRequired(
          reservationId,
          failureDiagnostics(input.operation, error),
        );
      }
    } catch {
      // Keep the original error, including when a decision already consumed the
      // reservation or the worker is unavailable. Launch recovery is the fallback.
    }
    throw error;
  }
}
