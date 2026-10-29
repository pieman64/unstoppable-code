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
