import { z } from 'zod';

const PlanReviewIdSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[a-z0-9][a-z0-9-]*$/);

/** Identity of the exact app-owned proposal the user chose to implement. */
export const ChatPlanReviewApprovalSchema = z.strictObject({
  requestId: PlanReviewIdSchema,
  planId: PlanReviewIdSchema,
  revisionNumber: z.number().int().positive(),
});

export type ChatPlanReviewApproval = z.infer<
  typeof ChatPlanReviewApprovalSchema
>;

/** Writable attempt identity. Outcomes are written only by the chat authority. */
export const TrackedPlanImplementationInputSchema = z.strictObject({
  planId: PlanReviewIdSchema,
  revisionNumber: z.number().int().positive(),
  userMessageId: z
    .string()
    .min(1)
    .max(512)
    .regex(/^[^\s/\\\0]+$/),
  startedAt: z.iso.datetime({ offset: true }),
});

/** Persisted links have either no terminal facts or a complete terminal pair. */
export const TrackedPlanImplementationSchema = z.union([
  TrackedPlanImplementationInputSchema,
  TrackedPlanImplementationInputSchema.extend({
    outcome: z.enum(['completed', 'failed', 'cancelled']),
    endedAt: z.iso.datetime({ offset: true }),
  }),
]);
export type TrackedPlanImplementationInput = z.infer<
  typeof TrackedPlanImplementationInputSchema
>;
export type TrackedPlanImplementation = TrackedPlanImplementationInput &
  (
    | { outcome?: never; endedAt?: never }
    | { outcome: 'completed' | 'failed' | 'cancelled'; endedAt: string }
  );
