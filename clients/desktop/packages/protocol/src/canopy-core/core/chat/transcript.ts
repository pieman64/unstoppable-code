import { z } from 'zod';

import {
  CanopyWorkspaceScopeSchema,
  CanopyErrorPayloadSchema,
  CanopyQueryRetryDirectiveSchema,
} from '../shared';

const ordinal = z.number().int().nonnegative();
const safeId = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[a-z0-9][a-z0-9-]*$/);
const anchorId = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const scope = CanopyWorkspaceScopeSchema.safeExtend({
  workspaceId: safeId,
  worktreeId: safeId,
  chatId: safeId,
});
const HOST_PATH = /^(?:\/|[A-Za-z]:[\\/]|\\\\|file:\/\/)/;

export const CoreChatTranscriptMessageSchema = z
  .object({
    id: z.string(),
    role: z.enum(['user', 'assistant', 'system']),
    blocks: z.array(z.unknown()),
    timestamp: z.number(),
  })
  .catchall(z.unknown());

function containsHostPath(value: unknown): boolean {
  if (typeof value === 'string') return false;
  if (Array.isArray(value)) return value.some(containsHostPath);
  if (typeof value === 'object' && value !== null) {
    if (
      'type' in value &&
      value.type === 'image' &&
      'path' in value &&
      typeof value.path === 'string' &&
      HOST_PATH.test(value.path)
    )
      return true;
    if (
      'type' in value &&
      value.type === 'compaction_info' &&
      'transcriptPath' in value &&
      typeof value.transcriptPath === 'string' &&
      HOST_PATH.test(value.transcriptPath)
    )
      return true;
    return Object.entries(value).some(
      ([key, child]) =>
        [
          'absolutePath',
          'attachmentPath',
          'attachmentPaths',
          'attachmentPromptContexts',
        ].includes(key) || containsHostPath(child),
    );
  }
  return false;
}

export const CoreChatTranscriptPageParamsSchema = z
  .strictObject({
    scope,
    archivedContainerId: safeId.optional(),
    standaloneHistory: z.literal(true).optional(),
    before: ordinal.optional(),
    view: z.literal('turns').optional(),
    turnId: anchorId.optional(),
    transcriptRevision: ordinal.optional(),
  })
  .refine(
    (params) => params.turnId === undefined || params.view === 'turns',
    'Turn paging requires the turn view.',
  )
  .refine(
    (params) =>
      params.archivedContainerId === undefined ||
      params.archivedContainerId === params.scope.worktreeId,
    'Archived container must match the transcript scope.',
  )
  .refine(
    (params) =>
      !params.standaloneHistory || params.archivedContainerId === undefined,
    'Invalid standalone archive scope.',
  );
export type CoreChatTranscriptPageParams = z.output<
  typeof CoreChatTranscriptPageParamsSchema
>;

export const CoreChatTranscriptPageResultSchema = z
  .object({
    messages: z.array(CoreChatTranscriptMessageSchema),
    view: z.literal('turns').optional(),
    turnId: z.string().optional(),
    messageOrdinals: z.record(z.string(), ordinal).optional(),
    turns: z.array(z.unknown()).optional(),
    before: ordinal.optional(),
    totalMessages: ordinal,
    transcriptRevision: ordinal,
    latestHumanMessage: CoreChatTranscriptMessageSchema.optional(),
  })
  .refine(
    (result) =>
      !result.messages.some((message) => message.hidden === true) &&
      result.latestHumanMessage?.hidden !== true &&
      !containsHostPath(result),
    'Host-local paths are not portable.',
  );
export type CoreChatTranscriptPageResult = z.output<
  typeof CoreChatTranscriptPageResultSchema
>;

export const CoreChatTranscriptSearchParamsSchema = z.strictObject({
  scope,
  query: z.string().min(2).max(256),
});
export type CoreChatTranscriptSearchParams = z.output<
  typeof CoreChatTranscriptSearchParamsSchema
>;

export const CoreChatTranscriptSearchResultSchema = z.object({
  matches: z.array(
    z.object({
      renderMessageId: z.string().optional(),
      messageId: z.string(),
      turnId: z.string(),
      count: ordinal,
    }),
  ),
  totalCount: ordinal,
});
export type CoreChatTranscriptSearchResult = z.output<
  typeof CoreChatTranscriptSearchResultSchema
>;

export const CoreChatTranscriptPageErrorSchema =
  CanopyErrorPayloadSchema.extend({
    code: z
      .enum([
        'core.chat.transcript.page.invalidState',
        'core.chat.transcript.page.notFound',
      ])
      .optional(),
    retry: CanopyQueryRetryDirectiveSchema,
  });
export const CoreChatTranscriptSearchErrorSchema =
  CanopyErrorPayloadSchema.extend({
    code: z
      .enum([
        'core.chat.transcript.search.invalidState',
        'core.chat.transcript.search.notFound',
      ])
      .optional(),
    retry: CanopyQueryRetryDirectiveSchema,
  });
