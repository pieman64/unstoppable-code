import { z } from 'zod';

import { CanopyQueryRequestMetadataSchema } from '../../common';
import { CanopyErrorPayloadSchema } from '../../errors';
import {
  CanopyJsonValueSchema,
  defineCanopyInstruction,
  defineCanopyInstructionRegistry,
} from '../shared-messaging';
import {
  CoreChatTurnCancelErrorSchema,
  CoreChatTurnCancelResultSchema,
} from './commands-messaging';

const IdentifierSchema = z.string().min(1).max(512);

export const CoreChatQuestionRespondParamsSchema = z.strictObject({
  chatId: IdentifierSchema,
  questionId: IdentifierSchema,
  answers: z.object({}).catchall(CanopyJsonValueSchema).optional(),
  dismissed: z.boolean().optional(),
  _meta: CanopyQueryRequestMetadataSchema.optional(),
});

// Served by the web core for cloud chats (CAN-4162) and by the desktop core for desktop chats (CAN-4128).
export const CORE_CHAT_QUESTION_INSTRUCTION_DEFINITIONS =
  defineCanopyInstructionRegistry('core', {
    'core.chat.question.respond': defineCanopyInstruction({
      plane: 'core',
      domain: 'chat',
      version: 1,
      placement: 'core-only',
      idempotency: 'inherent',
      requiredGrants: ['core.chat.write'],
      params: CoreChatQuestionRespondParamsSchema,
      result: CoreChatTurnCancelResultSchema,
      error: CanopyErrorPayloadSchema.extend({
        code: z
          .enum([
            'core.chat.question.invalidState',
            'core.chat.question.revisionConflict',
            'core.chat.question.notFound',
          ])
          .optional(),
        retry: CoreChatTurnCancelErrorSchema.shape.retry,
      }),
    }),
  });
