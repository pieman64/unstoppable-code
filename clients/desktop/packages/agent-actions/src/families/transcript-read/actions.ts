import {
  CoreChatContentReadParamsSchema,
  CoreChatTranscriptBlocksPageParamsSchema,
  CoreChatTranscriptPageParamsSchema,
  TranscriptDelegationTargetSchema,
  TranscriptTargetSchema,
} from '@canopy/protocol/canopy-core';
import { z } from 'zod';

export const TRANSCRIPT_READ_ACTION_TYPES = [
  'chat.transcript.page',
  'chat.content.read',
  'chat.transcript.blocks.page',
] as const;
export type TranscriptReadActionType =
  (typeof TRANSCRIPT_READ_ACTION_TYPES)[number];

export const transcriptReadDelegationTargetSchema =
  TranscriptDelegationTargetSchema.safeExtend({
    runGeneration: TranscriptDelegationTargetSchema.shape.runGeneration.min(1),
  });
export const transcriptReadTargetSchema = z.discriminatedUnion('kind', [
  TranscriptTargetSchema.options[0],
  transcriptReadDelegationTargetSchema,
]);
export type AgentTranscriptReadTarget = z.output<
  typeof transcriptReadTargetSchema
>;

export const transcriptPageActionSchema = z.strictObject({
  type: z.literal('chat.transcript.page'),
  target: transcriptReadDelegationTargetSchema,
  cursor: CoreChatTranscriptPageParamsSchema.shape.cursor,
});
export const transcriptContentActionSchema = z.strictObject({
  type: z.literal('chat.content.read'),
  target: transcriptReadTargetSchema,
  messageId: CoreChatContentReadParamsSchema.shape.messageId,
  blockOrdinal: CoreChatContentReadParamsSchema.shape.blockOrdinal,
  field: CoreChatContentReadParamsSchema.shape.field,
  offset: CoreChatContentReadParamsSchema.shape.offset,
  fieldSource:
    CoreChatContentReadParamsSchema.shape.fieldSource.default('logical'),
  limit: CoreChatContentReadParamsSchema.shape.limit.default(16_384),
});
export const transcriptBlocksActionSchema = z
  .strictObject({
    type: z.literal('chat.transcript.blocks.page'),
    target: transcriptReadTargetSchema,
    messageId: CoreChatTranscriptBlocksPageParamsSchema.shape.messageId,
    firstBlockOrdinal:
      CoreChatTranscriptBlocksPageParamsSchema.shape.firstBlockOrdinal,
    cursor: CoreChatTranscriptBlocksPageParamsSchema.shape.cursor,
    limit: CoreChatTranscriptBlocksPageParamsSchema.shape.limit.default(16),
  })
  .refine(
    (input) =>
      input.firstBlockOrdinal === undefined || input.cursor === undefined,
    'A cursor already names the first block ordinal. Omit firstBlockOrdinal when continuing.',
  );
export const transcriptReadActionSchema = z.discriminatedUnion('type', [
  transcriptPageActionSchema,
  transcriptContentActionSchema,
  transcriptBlocksActionSchema,
]);
export type TranscriptReadAction = z.output<typeof transcriptReadActionSchema>;
export type TranscriptReadActionOf<T extends TranscriptReadActionType> =
  Extract<TranscriptReadAction, { type: T }>;
