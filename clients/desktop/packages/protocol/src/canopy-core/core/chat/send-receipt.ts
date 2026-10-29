import { z } from 'zod';
import {
  CanopyWorkspaceScopeSchema,
  CanopyErrorPayloadSchema,
  CanopyQueryRetryDirectiveSchema,
} from '../shared';

const id = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[a-z0-9][a-z0-9-]*$/);

export const CoreChatSendReceiptParamsSchema = z.strictObject({
  scope: CanopyWorkspaceScopeSchema.safeExtend({
    workspaceId: id,
    worktreeId: id,
    chatId: id,
  }),
  commandId: id,
  identity: z
    .strictObject({
      userMessageId: id,
      fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .optional(),
});

export const CoreChatSendReceiptResultSchema = z.discriminatedUnion('outcome', [
  z.strictObject({ outcome: z.literal('missing') }),
  z.strictObject({ outcome: z.literal('conflict') }),
  z.strictObject({
    outcome: z.literal('matched'),
    receipt: z.strictObject({
      commandId: id,
      revision: z.number().int().nonnegative(),
      outcome: z.enum([
        'applied',
        'already_applied',
        'conflict',
        'not_found',
        'rejected',
      ]),
      entityId: id.optional(),
      messageId: id.optional(),
    }),
  }),
]);

export const CoreChatSendReceiptErrorSchema =
  CanopyErrorPayloadSchema.safeExtend({
    code: z.enum(['core.chat.send.receipt.invalidState']).optional(),
    retry: CanopyQueryRetryDirectiveSchema,
  });
export type CoreChatSendReceiptParams = z.output<
  typeof CoreChatSendReceiptParamsSchema
>;
export type CoreChatSendReceiptResult = z.output<
  typeof CoreChatSendReceiptResultSchema
>;
