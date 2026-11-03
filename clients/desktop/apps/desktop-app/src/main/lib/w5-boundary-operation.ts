import {
  createW5BoundaryOperationRunner,
  createW5ExpectedRevisionCheck,
  type W5BoundaryOperationInput,
} from '@canopy/core-runtime/node/w5/boundary-operation';
import type { W5Resource } from '@canopy/desktop-shared/node/w5-commit-log';
import { IdentifierValidationError } from './validation';
import {
  readW5Revisions,
  withW5Commit,
  type W5CommitOptions,
} from './w5-commit-log-file-store';
import { runKeyedW5Operation, type W5KeyedAttempt } from './w5-keyed-operation';

export {
  w5ExpectedRevision,
  type W5BoundaryOptions,
} from '@canopy/core-runtime/node/w5/boundary-operation';

/**
 * A registered wire call of a keyed lifecycle boundary (W7b-2a): its
 * principal-scoped receipt caller (A13), and its addressing, which runs for a
 * new key only, before the reservation (RR5). In-process callers pass none
 * and keep their `desktop-host:*` receipts.
 */
export interface W5WireCall {
  readonly caller: string;
  readonly admit?: () => Promise<void>;
}

/**
 * The core preflight over desktop main's revision reads, resolved at call
 * time so test injection and spies still intercept.
 */
export function checkW5ExpectedRevision(
  resource: W5Resource,
  expected?: number,
): Promise<void> {
  return createW5ExpectedRevisionCheck((resources) =>
    readW5Revisions(resources),
  )(resource, expected);
}

/**
 * The core boundary runner bound to desktop main's keyed runner and commit,
 * with an invalid identifier as a pre-effect refusal. A hoisted declaration
 * with no module-level runner, so import cycles cannot reach it uninitialized.
 */
export function runW5BoundaryOperation<T>(
  input: W5BoundaryOperationInput,
  decode: (outcome: unknown) => T,
  execute: (
    options: W5CommitOptions,
    attempt: W5KeyedAttempt | undefined,
    complete: (result: T) => Promise<T>,
  ) => Promise<T>,
): Promise<T> {
  return createW5BoundaryOperationRunner({
    runKeyed: (keyed, decodeOutcome, work) =>
      runKeyedW5Operation(keyed, decodeOutcome, work),
    withCommit: (options, work) => withW5Commit(options, work),
    isHostRefusal: (error) => error instanceof IdentifierValidationError,
  })(input, decode, execute);
}
