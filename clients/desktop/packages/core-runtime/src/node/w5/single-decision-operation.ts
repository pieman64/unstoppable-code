import {
  W5FileWriteRefusedError,
  W5RevisionConflictError,
} from './commit-log-file-store';
import { setW5CommitOutcome, type W5CommitOptions } from './commit-scope';
import type { W5KeyedOperationRunner } from './keyed-operation';
import type { W5StorageAdmission } from './storage-binding';
import type { W5StorageTarget } from './storage-target';

export interface W5SingleDecisionInput<Source extends string> {
  operation: string;
  /** A closed caller source; the host names a keyed receipt's caller from it. */
  source: Source;
  idempotencyKey: string | undefined;
  /** The admitted change, read only for a keyed attempt. */
  parameters: () => unknown;
  /** Admitted at operation entry, before any receipt lookup or reservation. */
  storage?: readonly W5StorageTarget[];
}

export type W5SingleDecisionOperation<Source extends string> = <A, T>(
  input: W5SingleDecisionInput<Source>,
  admit: () => Promise<A>,
  decode: (outcome: unknown) => T,
  execute: (
    admitted: A,
    options: W5CommitOptions,
    save: (result: T) => T,
  ) => Promise<T>,
) => Promise<T>;

export interface W5SingleDecisionBindings<Source extends string> {
  runKeyed: W5KeyedOperationRunner;
  /** The host's storage admission, entered before any receipt lookup. */
  admitStorage: W5StorageAdmission;
  /** The trusted keyed receipt caller for a source; not the writer principal. */
  caller: (source: Source) => string;
  /** Host-owned typed refusals, checked after the boundary's and the store's. */
  isHostRefusal: (error: unknown) => boolean;
}

/**
 * A runner for one-decision ("1D") boundaries (CAN-4370, CAN-4391). Without a
 * key it runs `admit`, then `execute`. With one, a saved outcome replays
 * without either; otherwise `admit` runs before the reservation, so its
 * read-only failures consume no key, and `execute` stages the files under one
 * `withW5Commit` scope carrying the receipt and reservation, then calls
 * `save` with its result, so the files, revisions, receipt and outcome are
 * one decision. That decision is the only effect, so it is not signalled
 * through `beforeDecision`: a refusal before or at it (the boundary's own, a
 * stale file or revision, a host refusal) releases the key, and any other
 * failure leaves it recovery-required.
 */
export function createW5SingleDecisionOperation<Source extends string>(
  bindings: W5SingleDecisionBindings<Source>,
  isBoundaryRefusal: (error: unknown) => boolean,
): W5SingleDecisionOperation<Source> {
  const isPreDecisionRefusal = (error: unknown): boolean =>
    isBoundaryRefusal(error) ||
    error instanceof W5RevisionConflictError ||
    error instanceof W5FileWriteRefusedError ||
    bindings.isHostRefusal(error);

  return function runW5SingleDecisionOperation<A, T>(
    input: W5SingleDecisionInput<Source>,
    admit: () => Promise<A>,
    decode: (outcome: unknown) => T,
    execute: (
      admitted: A,
      options: W5CommitOptions,
      save: (result: T) => T,
    ) => Promise<T>,
  ): Promise<T> {
    const { operation, idempotencyKey } = input;
    const run = async (): Promise<T> => {
      if (idempotencyKey === undefined)
        return execute(await admit(), { operation }, (result) => result);
      let admission: { admitted: A } | undefined;
      return bindings.runKeyed(
        {
          caller: bindings.caller(input.source),
          operation,
          idempotencyKey,
          parameters: input.parameters(),
          admit: async (): Promise<void> => {
            admission = { admitted: await admit() };
          },
          isPreEffectRefusal: isPreDecisionRefusal,
        },
        decode,
        ({ receipt, reservationId }) => {
          if (!admission)
            throw new Error('A keyed single-decision change was not admitted');
          return execute(
            admission.admitted,
            { operation, receipt, reservationId },
            (result) => {
              const outcome = decode(result);
              setW5CommitOutcome(outcome);
              return outcome;
            },
          );
        },
      );
    };
    return input.storage ? bindings.admitStorage(input.storage, run) : run();
  };
}
