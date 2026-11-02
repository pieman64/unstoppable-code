import { z } from 'zod';

/** Portable safety policy metadata shared by execution and transcript consumers. */
export const safetyDenyReasonSchema = z.enum([
  'force-push',
  'destructive-delete',
  'disk-write',
  'unverifiable-command',
]);
export type SafetyDenyReason = z.infer<typeof safetyDenyReasonSchema>;

export const SAFETY_DENIED_COMMAND_MAX_CHARS = 4000;

export const approvalSafetyDeniedInfoSchema = z.strictObject({
  type: z.literal('approval_safety_denied_info'),
  /** Also the containing persisted message ID; needed by block-only projections. */
  receiptId: z.string().min(1).max(512),
  timestamp: z.number().finite(),
  reason: safetyDenyReasonSchema,
  command: z.string().max(SAFETY_DENIED_COMMAND_MAX_CHARS),
  mode: z.enum(['ask', 'auto']),
  turnUserMessageId: z.string().min(1).max(512).optional(),
  toolUseId: z.string().min(1).max(512).optional(),
  subagentId: z.string().min(1).max(512).optional(),
});
export type ApprovalSafetyDeniedInfo = z.infer<
  typeof approvalSafetyDeniedInfoSchema
>;
