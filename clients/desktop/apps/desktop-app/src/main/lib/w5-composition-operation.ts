import {
  getWorkspaceConfigPath,
  getWorkspaceWorktreesFilePath,
  getWorkspaceIndexFilePath,
} from './paths';
import type { W5KeyedAttempt } from './w5-keyed-operation';
import { z } from 'zod';
import type { W5CommitOptions } from './w5-commit-scope';
import { currentW5CommitScope } from './w5-commit-scope';
import {
  withW5RepositoryLocks,
  type W5RepositoryLock,
} from './w5-repository-locks';
import {
  checkW5ExpectedRevision,
  w5WorktreeOutcomeSchema,
} from './w5-boundary-operation';
import { withW5Commit, w5ResourceKey } from './w5-commit-log-file-store';

/** Until composition options have a resource, callers carry the rows they read. */
export interface W5CompositionOptions {
  expectedRevisions?: W5CommitOptions['expectedRevisions'];
  idempotencyKey?: string;
}

export async function checkW5CompositionRevisions(
  options: W5CommitOptions,
): Promise<void> {
  for (const { resource, revision } of options.expectedRevisions ?? []) {
    await checkW5ExpectedRevision(resource, revision);
  }
}

/** A record-only transition. Never place provisioning or migration inside work. */
export async function commitW5BoundaryStep<T>(
  options: W5CommitOptions | undefined,
  locks: readonly W5RepositoryLock[],
  work: () => Promise<T>,
): Promise<T> {
  if (!options) return work();
  const advanced = new Set<string>();
  const result = await withW5RepositoryLocks(locks, () =>
    withW5Commit({ ...options, locks }, async () => {
      const value = await work();
      currentW5CommitScope()?.advance.forEach((_resource, key) =>
        advanced.add(key),
      );
      return value;
    }),
  );
  // Advance only images this attempt staged, never revisions read after effects.
  options.expectedRevisions = options.expectedRevisions?.map((entry) => ({
    ...entry,
    revision:
      entry.revision + (advanced.has(w5ResourceKey(entry.resource)) ? 1 : 0),
  }));
  return result;
}

export const w5CompositionWorkspaceSchema = z.object({
  id: z.string(),
  type: z.literal('multi-repo'),
  name: z.string(),
  color: z.string(),
  order: z.number(),
  collapsed: z.boolean().optional(),
  temporary: z.boolean().optional(),
  repos: z.array(z.object({ id: z.string(), name: z.string() })),
  worktrees: z.array(w5WorktreeOutcomeSchema),
});
export type W5PromoteOutcome = z.infer<typeof w5CompositionWorkspaceSchema>;
const migrationSchema = z.object({
  repoMappings: z.array(
    z.object({
      sourceRepoId: z.string().optional(),
      destinationRepoId: z.string(),
      repoName: z.string(),
    }),
  ),
  selectedRepoIdRewrites: z.record(z.string(), z.string()),
  sourceRootRepoIdRewrite: z.string().optional(),
  removedTemporaryWorkspaceId: z.string().optional(),
});
export const w5CombineOutcomeSchema = migrationSchema.extend({
  sourceWorkspaceId: z.string(),
  sourceWorktreeId: z.string(),
  destinationWorkspaceId: z.string(),
  destinationWorktreeId: z.string(),
  destinationWorkspace: w5CompositionWorkspaceSchema,
  destinationWorktree: w5WorktreeOutcomeSchema,
  createdTemporaryWorkspace: z.boolean(),
  reusedWorkspace: z.boolean(),
  removedSourceWorktree: z.boolean(),
});
export const w5ExistingCombineOutcomeSchema = w5CombineOutcomeSchema.extend({
  joinedWorktree: migrationSchema.extend({
    workspaceId: z.string(),
    worktreeId: z.string(),
  }),
});
export type W5CombineOutcome = z.infer<typeof w5CombineOutcomeSchema>;
export type W5ExistingCombineOutcome = z.infer<
  typeof w5ExistingCombineOutcomeSchema
>;

/** Read-only failures are known refusals only until the attempt marks an effect. */
export async function admitW5Composition<T>(
  attempt: W5KeyedAttempt | undefined,
  work: () => Promise<T>,
): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw error instanceof Error && attempt
      ? attempt.validationError(error)
      : error;
  }
}

export function decodeW5CompositionOutcome<T>(
  schema: z.ZodType<T>,
  outcome: unknown,
): T {
  return schema.parse(JSON.parse(JSON.stringify(schema.parse(outcome))));
}

/** Keep lock declarations beside the record-only scope, away from effect paths. */
export function w5CompositionLocks(input: {
  index?: boolean;
  manifests?: readonly string[];
  lists?: readonly string[];
}): W5RepositoryLock[] {
  return [
    ...(input.index
      ? [{ kind: 'index' as const, path: getWorkspaceIndexFilePath() }]
      : []),
    ...(input.manifests ?? []).map(
      (id): W5RepositoryLock => ({
        kind: 'manifest',
        path: getWorkspaceConfigPath(id),
      }),
    ),
    ...(input.lists ?? []).map(
      (id): W5RepositoryLock => ({
        kind: 'list',
        path: getWorkspaceWorktreesFilePath(id),
      }),
    ),
  ];
}
