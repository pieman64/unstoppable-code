// Explicit commit-log modules only: the commit-log index loads node:sqlite,
// which only the worker opens.
import type { W5CommitRequest, W5Resource } from './commit-log/commit-log';
import {
  W5RevisionConflictError,
  w5ResourceKey,
} from './commit-log-file-store';
import type { W5CommitOptions } from './commit-scope';
import type {
  W5AttemptHold,
  W5KeyedAttempt,
  W5KeyedOperationRunner,
} from './keyed-operation';

export interface W5BoundaryOptions {
  expectedRevision?: number;
  idempotencyKey?: string;
}

export interface W5BoundaryOperationInput extends W5BoundaryOptions {
  operation: string;
  /** Trusted host-composed caller identity, distinct from the writer principal. */
  caller: string;
  parameters: unknown;
  /**
   * A keyed wire call's addressing (RR5): runs for a new key only, after the
   * receipt lookup and before the reservation, so its refusal reserves nothing.
   */
  admit?: () => Promise<void>;
  isPreEffectRefusal: (error: unknown) => boolean;
  /** Foreground lifecycles recheck before returning, including receipt-only decisions. */
  recheckAtOutcome?: boolean;
  /** Holds what the boundary writes: a keyed attempt from its reservation, otherwise all of it. */
  hold?: W5AttemptHold;
}

export type W5BoundaryOperationRunner = <T>(
  input: W5BoundaryOperationInput,
  decode: (outcome: unknown) => T,
  execute: (
    options: W5CommitOptions,
    attempt: W5KeyedAttempt | undefined,
    complete: (result: T) => Promise<T>,
  ) => Promise<T>,
) => Promise<T>;

export interface W5BoundaryOperationBindings {
  runKeyed: W5KeyedOperationRunner;
  /** The host's commit; the runner only stages receipt-only decisions through it. */
  withCommit: (
    options: W5CommitOptions,
    work: () => Promise<void>,
  ) => Promise<void>;
  /** Host-owned typed refusals, safe before the attempt's first effect. */
  isHostRefusal: (error: unknown) => boolean;
}

export type W5RevisionReader = (
  resources: readonly W5Resource[],
) => Promise<NonNullable<W5CommitRequest['expectedRevisions']>>;

export type W5ExpectedRevisionCheck = (
  resource: W5Resource,
  expected?: number,
) => Promise<void>;

export function w5ExpectedRevision(
  resource: W5Resource,
  revision?: number,
): W5CommitOptions['expectedRevisions'] {
  return revision === undefined ? undefined : [{ resource, revision }];
}

/** Read-only preflight before uncertain effects; the canonical decision checks again. */
export function createW5ExpectedRevisionCheck(
  readRevisions: W5RevisionReader,
): W5ExpectedRevisionCheck {
  return async function checkW5ExpectedRevision(
    resource: W5Resource,
    expected?: number,
  ): Promise<void> {
    if (expected === undefined) return;
    const [current] = await readRevisions([resource]);
    if (!current) throw new Error('W5 revision unavailable');
    if (current.revision !== expected)
      throw new W5RevisionConflictError(
        w5ResourceKey(resource),
        expected,
        current.revision,
      );
  };
}

/** Keep the reservation through publication hooks and the boundary's final result. */
export function createW5BoundaryOperationRunner(
  bindings: W5BoundaryOperationBindings,
): W5BoundaryOperationRunner {
  async function runUnkeyed<T>(
    input: W5BoundaryOperationInput,
    execute: (
      options: W5CommitOptions,
      attempt: W5KeyedAttempt | undefined,
      complete: (result: T) => Promise<T>,
    ) => Promise<T>,
  ): Promise<T> {
    if (!input.recheckAtOutcome)
      return execute({ operation: input.operation }, undefined, (result) =>
        Promise.resolve(result),
      );
    const options: W5CommitOptions = { operation: input.operation };
    let completed = false;
    const complete = async (result: T): Promise<T> => {
      if (options.expectedRevisions?.length)
        await bindings.withCommit(options, async () => {});
      completed = true;
      return result;
    };
    const result = await execute(options, undefined, complete);
    return completed ? result : complete(result);
  }

  return async function runW5BoundaryOperation<T>(
    input: W5BoundaryOperationInput,
    decode: (outcome: unknown) => T,
    execute: (
      options: W5CommitOptions,
      attempt: W5KeyedAttempt | undefined,
      complete: (result: T) => Promise<T>,
    ) => Promise<T>,
  ): Promise<T> {
    if (input.idempotencyKey === undefined) {
      const unkeyed = (): Promise<T> => runUnkeyed(input, execute);
      return input.hold ? input.hold(unkeyed) : unkeyed();
    }
    return bindings.runKeyed(
      {
        ...input,
        idempotencyKey: input.idempotencyKey,
        isPreEffectRefusal: (error) =>
          bindings.isHostRefusal(error) || input.isPreEffectRefusal(error),
      },
      decode,
      async (binding, attempt) => {
        // Canonical writes do not consume the reservation before post-commit effects.
        const options: W5CommitOptions = {
          operation: binding.operation,
          beforeDecision: binding.beforeDecision,
        };
        let completed = false;
        const complete = async (result: T): Promise<T> => {
          const outcome = decode(result);
          await bindings.withCommit(
            {
              ...binding,
              expectedRevisions: input.recheckAtOutcome
                ? options.expectedRevisions
                : undefined,
              outcome,
            },
            async () => {},
          );
          completed = true;
          return outcome;
        };
        const result = await execute(options, attempt, complete);
        return completed ? result : complete(result);
      },
    );
  };
}
