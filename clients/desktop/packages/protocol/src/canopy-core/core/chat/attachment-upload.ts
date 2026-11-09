import { z } from 'zod';
import {
  CLOUD_ATTACHMENT_MAX_BYTES,
  CLOUD_ATTACHMENT_MEDIA_TYPES,
} from '../../../cloud-attachments';
import { CanopyRequestMetadataSchema } from '../../common';
import {
  defineCanopyInstruction,
  defineCanopyInstructionRegistry,
} from '../../definitions';
import {
  CanopyErrorPayloadSchema,
  CanopyKeyedRetryDirectiveSchema,
} from '../../errors';

/*
 * Cloud chat attachment upload (CAN-5988). The web core serves it; like the
 * task and live registries it stays out of the composed chat registry, so the
 * desktop dispatcher needs no handler and answers `capability_unavailable`.
 */

const id = z.string().min(1).max(512);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const size = z.number().int().nonnegative().max(CLOUD_ATTACHMENT_MAX_BYTES);
const mediaType = z.enum(CLOUD_ATTACHMENT_MEDIA_TYPES);

/** Base64 length of the largest attachment. */
export const CORE_CHAT_ATTACHMENT_UPLOAD_MAX_BASE64 =
  Math.ceil(CLOUD_ATTACHMENT_MAX_BYTES / 3) * 4;

export const CoreChatAttachmentSchema = z.strictObject({
  attachmentId: id,
  filename: z.string().min(1).max(1024),
  mediaType,
  size,
  contentSha256: sha256,
  storageKind: z.literal('blob'),
  source: z.string().max(256),
});
export type CoreChatAttachment = z.output<typeof CoreChatAttachmentSchema>;

export const CoreChatAttachmentUploadParamsSchema = z.strictObject({
  scope: z.strictObject({ workspaceId: id, worktreeId: id }),
  chatId: id,
  filename: z.string().min(1).max(1024),
  mediaType,
  /** The decoded byte length; the server refuses a mismatch. */
  size,
  /** Lowercase hex sha256 of the bytes; the server refuses a mismatch. */
  contentSha256: sha256,
  /** Base64 of the whole file. */
  data: z.string().max(CORE_CHAT_ATTACHMENT_UPLOAD_MAX_BASE64),
  _meta: CanopyRequestMetadataSchema.extend({ idempotencyKey: id }),
});
export type CoreChatAttachmentUploadParams = z.output<
  typeof CoreChatAttachmentUploadParamsSchema
>;

export const CoreChatAttachmentUploadResultSchema = z.strictObject({
  attachment: CoreChatAttachmentSchema,
});
export type CoreChatAttachmentUploadResult = z.output<
  typeof CoreChatAttachmentUploadResultSchema
>;

export const CoreChatAttachmentUploadErrorSchema =
  CanopyErrorPayloadSchema.extend({
    code: z
      .enum([
        'core.chat.attachment.tooLarge',
        'core.chat.attachment.unsupportedType',
        'core.chat.attachment.digestMismatch',
        'core.chat.attachment.busy',
      ])
      .optional(),
    retry: CanopyKeyedRetryDirectiveSchema,
  });

export const CORE_CHAT_ATTACHMENT_DEFINITIONS = defineCanopyInstructionRegistry(
  'core',
  {
    'core.chat.attachment.upload': defineCanopyInstruction({
      plane: 'core',
      domain: 'chat',
      version: 1,
      placement: 'core-only',
      idempotency: 'keyed',
      requiredGrants: ['core.chat.write'],
      params: CoreChatAttachmentUploadParamsSchema,
      result: CoreChatAttachmentUploadResultSchema,
      error: CoreChatAttachmentUploadErrorSchema,
    }),
  },
);
