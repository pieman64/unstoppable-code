import { z } from 'zod';

const operationSchema = z.enum([
  'workspace-delete',
  'worktree-archive',
  'worktree-delete',
]);
export const journalSchema = z.object({
  version: z.literal(1),
  operationId: z.string().uuid(),
  operation: operationSchema,
  /** Set on a child of {@link runStepFreeChildLifecycles}, which may resume it. */
  parentOperation: operationSchema.optional(),
  workspaceId: z.string(),
  worktreeId: z.string().optional(),
  createdAt: z.string().optional(),
  directoryIdentity: z.string().nullable(),
  state: z.enum(['active', 'recovery-required', 'completed']),
  steps: z.array(
    z.object({
      phase: z.string(),
      state: z.enum(['pending', 'done', 'failed']),
      /** Taken by {@link resumableDestructiveStep} while it was step-free. */
      resumable: z.literal(true).optional(),
    }),
  ),
  outcome: z.unknown().optional(),
  cleanupRequired: z.boolean().optional(),
  ownedPaths: z
    .array(z.object({ path: z.string(), identity: z.string().nullable() }))
    .default([]),
});
export type DestructiveRecoveryRecord = z.infer<typeof journalSchema>;
