import { z } from 'zod';
import { IdentifierValidationError } from './validation';
import type { W5Resource } from '@canopy/desktop-shared/node/w5-commit-log';
import {
  w5ResourceKey,
  readW5Revisions,
  withW5Commit,
  W5RevisionConflictError,
  type W5CommitOptions,
} from './w5-commit-log-file-store';
import { runKeyedW5Operation, type W5KeyedAttempt } from './w5-keyed-operation';

/** Portable row fields returned by keyed metadata commands; never persist host journals. */
export const w5WorktreeOutcomeSchema = z.object({
  id: z.string(),
  branchName: z.string(),
  createdAt: z.string(),
  label: z.string().optional(),
  hidden: z.boolean().optional(),
  pinned: z.boolean().optional(),
  branchGroupingOverride: z.enum(['group', 'ungroup']).optional(),
  branchGroupingParentWorktreeId: z.string().optional(),
  trackedBaseBranch: z.string().nullable().optional(),
  trackedRepoBaseBranches: z.record(z.string(), z.string()).optional(),
  includedRepoIds: z.array(z.string()).optional(),
  setupPhase: z.enum(['git-pending', 'git-ready']).optional(),
});

export interface W5BoundaryOptions {
  expectedRevision?: number;
  idempotencyKey?: string;
}

export function w5ExpectedRevision(
  resource: W5Resource,
  revision?: number,
): W5CommitOptions['expectedRevisions'] {
  return revision === undefined ? undefined : [{ resource, revision }];
}

/** Read-only preflight before uncertain effects; the canonical decision checks again. */
export async function checkW5ExpectedRevision(
  resource: W5Resource,
  expected?: number,
): Promise<void> {
  if (expected === undefined) return;
  const [current] = await readW5Revisions([resource]);
  if (!current) throw new Error('W5 revision unavailable');
  if (current.revision !== expected)
    throw new W5RevisionConflictError(
      w5ResourceKey(resource),
      expected,
      current.revision,
    );
}

/** Keep the reservation through publication hooks and the boundary's final result. */
export async function runW5BoundaryOperation<T>(
  input: W5BoundaryOptions & {
    operation: string;
    caller: string;
    parameters: unknown;
    isPreEffectRefusal: (error: unknown) => boolean;
    /** Foreground lifecycles recheck before returning, including receipt-only decisions. */
    recheckAtOutcome?: boolean;
  },
  decode: (outcome: unknown) => T,
  execute: (
    options: W5CommitOptions,
    attempt: W5KeyedAttempt | undefined,
    complete: (result: T) => Promise<T>,
  ) => Promise<T>,
): Promise<T> {
  if (input.idempotencyKey === undefined && !input.recheckAtOutcome)
    return execute({ operation: input.operation }, undefined, (result) =>
      Promise.resolve(result),
    );
  if (input.idempotencyKey === undefined) {
    const options: W5CommitOptions = { operation: input.operation };
    let completed = false;
    const complete = async (result: T): Promise<T> => {
      if (input.recheckAtOutcome && options.expectedRevisions?.length)
        await withW5Commit(options, async () => {});
      completed = true;
      return result;
    };
    const result = await execute(options, undefined, complete);
    return completed ? result : complete(result);
  }
  return runKeyedW5Operation(
    {
      ...input,
      idempotencyKey: input.idempotencyKey,
      isPreEffectRefusal: (error) =>
        error instanceof IdentifierValidationError ||
        input.isPreEffectRefusal(error),
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
        await withW5Commit(
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
}
