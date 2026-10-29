import { z } from 'zod';

import {
  CanopyWorkspaceScopeSchema,
  CanopyErrorPayloadSchema,
  CanopyQueryRetryDirectiveSchema,
} from '../shared';

// These limits mirror `@canopy/agent-transcript/lib/visual-ref`, which
// depends on this package; a drift test there keeps them equal.
const VISUAL_PREPARED_MAX_BYTES = 4 * 1024 * 1024;
const VISUAL_TITLE_MAX_LENGTH = 120;
const VISUAL_MIN_HEIGHT = 80;
const VISUAL_MAX_HEIGHT = 2000;
const VISUAL_HEIGHTS_MAX_ENTRIES = 32;
/** Largest raw byte range one read returns. */
export const CORE_CHAT_VISUAL_READ_MAX_LIMIT = 1_048_576;
/** Base64 length of a full-size range. */
const MAX_BASE64_LENGTH = Math.ceil(CORE_CHAT_VISUAL_READ_MAX_LIMIT / 3) * 4;

const ordinal = z.number().int().nonnegative();
const safeId = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[a-z0-9][a-z0-9-]*$/);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const positiveFinite = z.number().positive();

export const CoreChatVisualReferenceSchema = z.strictObject({
  version: z.literal(1),
  visualId: z
    .string()
    .regex(
      /^vis_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    ),
  artifactId: z.string().min(1),
  byteLength: ordinal.max(VISUAL_PREPARED_MAX_BYTES),
  sha256,
  mediaType: z.literal('text/html'),
  title: z.string().min(1).max(VISUAL_TITLE_MAX_LENGTH),
  maxHeight: z.number().int().min(VISUAL_MIN_HEIGHT).max(VISUAL_MAX_HEIGHT),
  heights: z
    .array(z.tuple([positiveFinite, positiveFinite]))
    .max(VISUAL_HEIGHTS_MAX_ENTRIES)
    .optional(),
});
export type CoreChatVisualReference = z.output<
  typeof CoreChatVisualReferenceSchema
>;

export const CoreChatVisualReadParamsSchema = z
  .strictObject({
    scope: CanopyWorkspaceScopeSchema.safeExtend({
      workspaceId: safeId,
      worktreeId: safeId,
      chatId: safeId,
    }),
    archivedContainerId: z.string().min(1).max(512).optional(),
    standaloneHistory: z.literal(true).optional(),
    messageId: z.string().min(1).max(512),
    toolUseId: z.string().min(1).max(512),
    reference: CoreChatVisualReferenceSchema,
    offset: ordinal,
    limit: z.number().int().min(1).max(CORE_CHAT_VISUAL_READ_MAX_LIMIT),
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
        message: 'Offset exceeds the visual byte length.',
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
export type CoreChatVisualReadParams = z.output<
  typeof CoreChatVisualReadParamsSchema
>;

export const CoreChatVisualReadResultSchema = z.object({
  /** Base64 of the raw bytes `[offset, offset + length)`. */
  data: z.string().max(MAX_BASE64_LENGTH),
  offset: ordinal.max(VISUAL_PREPARED_MAX_BYTES),
  length: ordinal.max(CORE_CHAT_VISUAL_READ_MAX_LIMIT),
  byteLength: ordinal.max(VISUAL_PREPARED_MAX_BYTES),
  /** Digest of the whole document, for verifying the reassembled bytes. */
  sha256,
});
export type CoreChatVisualReadResult = z.output<
  typeof CoreChatVisualReadResultSchema
>;

export const CoreChatVisualReadErrorSchema = CanopyErrorPayloadSchema.extend({
  code: z
    .enum([
      'core.chat.visual.read.invalidState',
      'core.chat.visual.read.notFound',
    ])
    .optional(),
  retry: CanopyQueryRetryDirectiveSchema,
});
