import { z } from 'zod';

import {
  CanopyWorkspaceScopeSchema,
  CanopyErrorPayloadSchema,
  CanopyQueryRetryDirectiveSchema,
} from '../shared';
import {
  PersistedToolOutputReferenceSchema,
  TranscriptTargetSchema,
} from './transcript';

const ordinal = z.number().int().nonnegative();
const safeId = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[a-z0-9][a-z0-9-]*$/);

export const CoreChatToolOutputReadParamsSchema = z
  .strictObject({
    scope: CanopyWorkspaceScopeSchema.safeExtend({
      workspaceId: safeId,
      worktreeId: safeId,
      chatId: safeId,
    }),
    archivedContainerId: z.string().min(1).max(512).optional(),
    standaloneHistory: z.literal(true).optional(),
    /** Absent or `primary`: the chat's transcript; `delegation`: a child stream. */
    target: TranscriptTargetSchema.optional(),
    messageId: z.string().min(1).max(512),
    toolUseId: z.string().min(1).max(512),
    reference: PersistedToolOutputReferenceSchema,
    offset: ordinal,
    limit: ordinal.min(4).max(65_536),
  })
  .superRefine((params, context) => {
    if (params.reference.artifactId !== `sha256-v1-${params.reference.sha256}`)
      context.addIssue({
        code: 'custom',
        path: ['reference', 'artifactId'],
        message: 'Artifact ID must match the SHA-256 digest.',
      });
    if (params.offset > params.reference.byteLength)
      context.addIssue({
        code: 'custom',
        path: ['offset'],
        message: 'Offset exceeds the tool-output byte length.',
      });
    if (
      params.target !== undefined &&
      params.target.chatId !== params.scope.chatId
    )
      context.addIssue({
        code: 'custom',
        path: ['target', 'chatId'],
        message: 'The read target must belong to the scope chat.',
      });
    if (params.standaloneHistory && params.archivedContainerId !== undefined)
      context.addIssue({
        code: 'custom',
        path: ['archivedContainerId'],
        message: 'Standalone history cannot use an archived container.',
      });
    if (
      params.archivedContainerId !== undefined &&
      params.archivedContainerId !== params.scope.worktreeId
    )
      context.addIssue({
        code: 'custom',
        path: ['archivedContainerId'],
        message: 'Archived container must match the worktree scope.',
      });
  });
export type CoreChatToolOutputReadParams = z.output<
  typeof CoreChatToolOutputReadParamsSchema
>;

export const CoreChatToolOutputReadResultSchema = z.object({
  text: z.string(),
  nextOffset: ordinal.optional(),
  byteLength: ordinal,
});
export type CoreChatToolOutputReadResult = z.output<
  typeof CoreChatToolOutputReadResultSchema
>;

export const CoreChatToolOutputReadErrorSchema =
  CanopyErrorPayloadSchema.extend({
    code: z
      .enum([
        'core.chat.toolOutput.read.invalidState',
        'core.chat.toolOutput.read.notFound',
      ])
      .optional(),
    retry: CanopyQueryRetryDirectiveSchema,
  });
