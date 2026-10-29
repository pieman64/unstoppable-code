import { ChatPlanReviewApprovalSchema } from '../../chat-plan-review';
import { z } from 'zod';
import { CanopyRequestMetadataSchema } from '../../common';

import {
  CanopyErrorPayloadSchema,
  CanopyJsonValueSchema,
  CanopyRetryDirectiveSchema,
  type CanopyErrorPayload,
  type CanopyOperationCode,
  defineCanopyInstruction,
  defineCanopyInstructionRegistry,
} from '../shared-messaging';

const IdentifierSchema = z.string().min(1).max(512);
const RevisionSchema = z.number().int().nonnegative();

const ChatCommandScopeSchema = z.strictObject({
  workspaceId: IdentifierSchema,
  worktreeId: IdentifierSchema,
});

const ChatCommandBaseSchema = z.strictObject({
  scope: ChatCommandScopeSchema,
  commandId: IdentifierSchema,
  chatId: IdentifierSchema,
  expectedRevision: RevisionSchema.optional(),
  _meta: CanopyRequestMetadataSchema.extend({
    idempotencyKey: IdentifierSchema,
  }),
});

export const CoreChatCommandReceiptSchema = z
  .object({
    commandId: IdentifierSchema,
    revision: RevisionSchema,
    outcome: z.enum([
      'applied',
      'already_applied',
      'conflict',
      'not_found',
      'rejected',
    ]),
    reason: z.string().optional(),
    entityId: IdentifierSchema.optional(),
    messageId: IdentifierSchema.optional(),
  })
  .catchall(CanopyJsonValueSchema);

export const CoreChatMessageSendParamsSchema = ChatCommandBaseSchema.extend({
  planReviewApproval: ChatPlanReviewApprovalSchema.optional(),
  messageId: IdentifierSchema,
  text: z.string(),
  origin: z
    .strictObject({
      kind: z.literal('terminalInitialPrompt'),
      turnTimerMessageId: IdentifierSchema,
    })
    .optional(),
}).refine((params) => !params.origin || !params.planReviewApproval, {
  message: 'Plan approval requires a canonical implementation message.',
});

export const CoreChatQueueEntryCancelParamsSchema =
  ChatCommandBaseSchema.extend({ entryId: IdentifierSchema });

export const CoreChatQueueEntryUpdateParamsSchema =
  ChatCommandBaseSchema.extend({
    entryId: IdentifierSchema,
    mutation: z.discriminatedUnion('kind', [
      z.strictObject({
        kind: z.literal('edit'),
        text: z.string(),
        inputMode: z.enum(['typed', 'voice']).optional(),
      }),
      z.strictObject({ kind: z.literal('steer') }),
    ]),
  });

export const CoreChatQueueEntryForceParamsSchema = ChatCommandBaseSchema.extend(
  { entryId: IdentifierSchema },
);

const KeyedRetrySchema = z.discriminatedUnion('kind', [
  CanopyRetryDirectiveSchema.options[0],
  CanopyRetryDirectiveSchema.options[2],
  CanopyRetryDirectiveSchema.options[3],
]);

function keyedErrorSchema<
  const Codes extends [CanopyOperationCode, ...CanopyOperationCode[]],
>(codes: Codes): z.ZodType<CanopyErrorPayload> {
  return CanopyErrorPayloadSchema.extend({
    code: z.enum(codes).optional(),
    retry: KeyedRetrySchema,
  });
}

export const CORE_CHAT_MESSAGE_INSTRUCTION_DEFINITIONS =
  defineCanopyInstructionRegistry('core', {
    'core.chat.message.send': defineCanopyInstruction({
      plane: 'core',
      domain: 'chat',
      version: 1,
      placement: 'core-only',
      idempotency: 'keyed',
      requiredGrants: ['core.chat.write'],
      params: CoreChatMessageSendParamsSchema,
      result: CoreChatCommandReceiptSchema,
      error: keyedErrorSchema([
        'core.chat.message.invalidState',
        'core.chat.message.revisionConflict',
        'core.chat.message.notFound',
      ]),
    }),
    'core.chat.queue.entry.cancel': defineCanopyInstruction({
      plane: 'core',
      domain: 'chat',
      version: 1,
      placement: 'core-only',
      idempotency: 'keyed',
      requiredGrants: ['core.chat.write'],
      params: CoreChatQueueEntryCancelParamsSchema,
      result: CoreChatCommandReceiptSchema,
      error: keyedErrorSchema([
        'core.chat.entryNotQueued',
        'core.chat.revisionConflict',
      ]),
    }),
    'core.chat.queue.entry.update': defineCanopyInstruction({
      plane: 'core',
      domain: 'chat',
      version: 1,
      placement: 'core-only',
      idempotency: 'keyed',
      requiredGrants: ['core.chat.write'],
      params: CoreChatQueueEntryUpdateParamsSchema,
      result: CoreChatCommandReceiptSchema,
      error: keyedErrorSchema([
        'core.chat.entryNotQueued',
        'core.chat.revisionConflict',
        'core.chat.busy',
      ]),
    }),
    'core.chat.queue.entry.force': defineCanopyInstruction({
      plane: 'core',
      domain: 'chat',
      version: 1,
      placement: 'core-only',
      idempotency: 'keyed',
      requiredGrants: ['core.chat.write'],
      params: CoreChatQueueEntryForceParamsSchema,
      result: CoreChatCommandReceiptSchema,
      error: keyedErrorSchema([
        'core.chat.entryNotQueued',
        'core.chat.revisionConflict',
        'core.chat.busy',
        'core.chat.policyDenied',
      ]),
    }),
  });
