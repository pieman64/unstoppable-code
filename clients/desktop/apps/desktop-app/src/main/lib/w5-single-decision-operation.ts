import type { StorageAdmissionTarget } from '@canopy/desktop-shared/node/lib/storage-admission';
import { IdentifierValidationError } from './validation';
import {
  W5FileWriteRefusedError,
  W5RevisionConflictError,
} from './w5-commit-log-file-store';
import { setW5CommitOutcome, type W5CommitOptions } from './w5-commit-scope';
import { runKeyedW5Operation } from './w5-keyed-operation';
import { withStorageAdmission } from './w5-storage';

export interface W5SingleDecisionInput<Source extends string> {
  operation: string;
  /** A closed caller source; a keyed receipt names it `desktop-host:<source>`. */
  source: Source;
  idempotencyKey: string | undefined;
  /** The admitted change, read only for a keyed attempt. */
  parameters: () => unknown;
  /** Admitted at operation entry, before any receipt lookup or reservation. */
  storage?: readonly StorageAdmissionTarget[];
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

/**
 * A runner for one-decision ("1D") boundaries (CAN-4370, CAN-4391). Without a
 * key it runs `admit`, then `execute`. With one, a saved outcome replays
 * without either; otherwise `admit` runs before the reservation, so its
 * read-only failures consume no key, and `execute` stages the files under one
 * `withW5Commit` scope carrying the receipt and reservation, then calls
 * `save` with its result, so the files, revisions, receipt and outcome are
 * one decision. That decision is the only effect, so it is not signalled
 * through `beforeDecision`: a refusal before or at it (the boundary's own, a
 * stale file or revision, an invalid identifier) releases the key, and any
 * other failure leaves it recovery-required.
 */
export function createW5SingleDecisionOperation<Source extends string>(
  isBoundaryRefusal: (error: unknown) => boolean,
): W5SingleDecisionOperation<Source> {
  const isPreDecisionRefusal = (error: unknown): boolean =>
    isBoundaryRefusal(error) ||
    error instanceof W5RevisionConflictError ||
    error instanceof W5FileWriteRefusedError ||
    error instanceof IdentifierValidationError;

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
      return runKeyedW5Operation(
        {
          caller: `desktop-host:${input.source}`,
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
    return input.storage ? withStorageAdmission(input.storage, run) : run();
  };
}
