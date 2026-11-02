import { z } from 'zod';

import {
  CanopyWorkspaceScopeSchema,
  CanopyErrorPayloadSchema,
  CanopyQueryRetryDirectiveSchema,
} from '../shared';
import { TranscriptTargetSchema } from './transcript';

const ordinal = z.number().int().nonnegative();
const safeId = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[a-z0-9][a-z0-9-]*$/);
const scope = CanopyWorkspaceScopeSchema.safeExtend({
  workspaceId: safeId,
  worktreeId: safeId,
  chatId: safeId,
});
const HOST_PATH = /^(?:\/|[A-Za-z]:[\\/]|\\\\|file:\/\/)/;

/**
 * Serialized bytes of one bounded block page. Every wrapper it crosses (the
 * renderer relay, the Portal reply, its completed event, a batch and the
 * browser poll) caps at {@link TRANSCRIPT_READ_WRAPPER_BYTES}.
 */
export const TRANSCRIPT_BOUNDED_BLOCK_PAGE_BYTES = 768 * 1024;
export const TRANSCRIPT_READ_WRAPPER_BYTES = 1024 * 1024;
/** The most blocks one page names, in either projection. */
export const TRANSCRIPT_BLOCK_PAGE_LIMIT = 512;
/** Characters of a readable field a bounded preview keeps. */
export const TRANSCRIPT_BLOCK_PREVIEW_CHARS = 4_000;

/** Body fields a content read may select; never a digest or path. */
export const TranscriptContentFieldSchema = z.enum([
  'output',
  'input',
  'text',
  'partialText',
  'finalText',
]);
export type TranscriptContentField = z.infer<
  typeof TranscriptContentFieldSchema
>;

/**
 * `stored` (the default) reads only a body stored apart from its row.
 * `logical` reads the stored body when there is one and otherwise the inline
 * field, so a field shortened for display reads in full.
 */
export const TranscriptFieldSourceSchema = z.enum(['stored', 'logical']);
export type TranscriptFieldSource = z.infer<typeof TranscriptFieldSourceSchema>;

/** Archive and target rules shared by both reads of one stored row. */
function checkRowRead(
  params: {
    scope: { worktreeId?: string; chatId?: string };
    archivedContainerId?: string;
    standaloneHistory?: true;
    target?: { chatId: string };
  },
  context: z.RefinementCtx,
): void {
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
}

export const CoreChatContentReadParamsSchema = z
  .strictObject({
    scope,
    archivedContainerId: safeId.optional(),
    standaloneHistory: z.literal(true).optional(),
    /** Absent or `primary`: the chat's transcript; `delegation`: a child stream. */
    target: TranscriptTargetSchema.optional(),
    messageId: z.string().min(1).max(512),
    /** The block's ordinal in the row's logical block list. */
    blockOrdinal: ordinal,
    field: TranscriptContentFieldSchema,
    fieldSource: TranscriptFieldSourceSchema.optional(),
    /** Byte offset in the stored encoding of the field's body. */
    offset: ordinal,
    limit: ordinal.min(4).max(65_536),
  })
  .superRefine(checkRowRead);
export type CoreChatContentReadParams = z.output<
  typeof CoreChatContentReadParamsSchema
>;

/** The same byte-range result `core.chat.toolOutput.read` returns. */
export const CoreChatContentReadResultSchema = z.object({
  text: z.string(),
  nextOffset: ordinal.optional(),
  byteLength: ordinal,
  runTruncated: z.literal(true).optional(),
});
export type CoreChatContentReadResult = z.output<
  typeof CoreChatContentReadResultSchema
>;

export const CoreChatContentReadErrorSchema = CanopyErrorPayloadSchema.extend({
  code: z
    .enum([
      'core.chat.content.read.invalidState',
      'core.chat.content.read.notFound',
    ])
    .optional(),
  retry: CanopyQueryRetryDirectiveSchema,
});

export const CoreChatTranscriptBlocksPageParamsSchema = z
  .strictObject({
    scope,
    archivedContainerId: safeId.optional(),
    standaloneHistory: z.literal(true).optional(),
    /** Absent or `primary`: the chat's transcript; `delegation`: a child stream. */
    target: TranscriptTargetSchema.optional(),
    messageId: z.string().min(1).max(512),
    /** First logical block ordinal of a first page. */
    firstBlockOrdinal: ordinal.optional(),
    /**
     * A later page continues with the opaque cursor the previous page
     * returned; it binds scope, archive, target, message, revision and
     * position, and a cursor from any other read fails.
     */
    cursor: z.string().min(1).max(2048).optional(),
    limit: ordinal.min(1).max(TRANSCRIPT_BLOCK_PAGE_LIMIT),
    /**
     * `bounded-v1` returns typed entries within
     * {@link TRANSCRIPT_BOUNDED_BLOCK_PAGE_BYTES}; absent returns the raw
     * blocks, whose size is not bounded.
     */
    projection: z.literal('bounded-v1').optional(),
  })
  .superRefine(checkRowRead)
  .refine(
    (params) =>
      params.cursor === undefined || params.firstBlockOrdinal === undefined,
    'A cursor already names the first block ordinal.',
  );
export type CoreChatTranscriptBlocksPageParams = z.output<
  typeof CoreChatTranscriptBlocksPageParamsSchema
>;

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

/**
 * One ordinal page of a row's logical block list, whether the row stores
 * its blocks inline or in block pages.
 */
export const CoreChatTranscriptRawBlocksPageResultSchema = z
  .object({
    messageId: z.string(),
    firstBlockOrdinal: ordinal,
    blocks: z.array(z.unknown()),
    /** Total logical blocks in the row. */
    blockCount: ordinal,
    /** Absent once the page reaches the last block. */
    nextBlockOrdinal: ordinal.optional(),
    /** The next page's cursor, present exactly when `nextBlockOrdinal` is. */
    cursor: z.string().min(1).max(2048).optional(),
    transcriptRevision: ordinal,
    runTruncated: z.literal(true).optional(),
  })
  .refine(
    (result) => !containsHostPath(result.blocks),
    'Host-local paths are not portable.',
  );
export type CoreChatTranscriptRawBlocksPageResult = z.output<
  typeof CoreChatTranscriptRawBlocksPageResultSchema
>;

/** Block types a bounded page carries; any other block is a `notice`. */
export const TRANSCRIPT_BOUNDED_BLOCK_TYPES = [
  'text',
  'thinking',
  'tool_use',
  'tool_result',
  'compaction_info',
] as const;

const BoundedBlockSchema = z
  .looseObject({ type: z.enum(TRANSCRIPT_BOUNDED_BLOCK_TYPES) })
  .refine(
    (block) =>
      !Object.keys(block).some((key) => key.endsWith('Ref')) &&
      !containsHostPath(block),
    'A bounded block carries no body reference or host path.',
  );

/**
 * One block of a bounded page. `preview` lists the readable fields it cut or
 * stores apart; each reads in full with `fieldSource: 'logical'`. `notice`
 * stands for a block the page cannot carry.
 */
export const TranscriptBoundedBlockEntrySchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('block'),
    ordinal,
    block: BoundedBlockSchema,
  }),
  z
    .strictObject({
      kind: z.literal('preview'),
      ordinal,
      block: BoundedBlockSchema,
      omittedFields: z.array(TranscriptContentFieldSchema).min(1).max(5),
    })
    .refine(
      (entry) =>
        new Set(entry.omittedFields).size === entry.omittedFields.length &&
        entry.omittedFields.every(
          (field) => typeof entry.block[field] === 'string',
        ),
      'Omitted fields are distinct fields of the previewed block.',
    ),
  z.strictObject({
    kind: z.literal('notice'),
    ordinal,
    reason: z.enum(['unsupported', 'tooLarge']),
    blockType: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z][a-z0-9_]*$/)
      .optional(),
  }),
]);
export type TranscriptBoundedBlockEntry = z.output<
  typeof TranscriptBoundedBlockEntrySchema
>;

/**
 * Entries name consecutive ordinals from `firstBlockOrdinal`; a cursor and the
 * next ordinal continue exactly where they end, and only a page at the row's
 * end may be empty.
 */
function checkBoundedPage(
  page: {
    firstBlockOrdinal: number;
    entries: readonly { ordinal: number }[];
    blockCount: number;
    nextBlockOrdinal?: number;
    cursor?: string;
  },
  context: z.RefinementCtx,
): void {
  const end = page.firstBlockOrdinal + page.entries.length;
  const more = end < page.blockCount;
  if (
    page.entries.some(
      (entry, index) => entry.ordinal !== page.firstBlockOrdinal + index,
    )
  )
    context.addIssue({
      code: 'custom',
      path: ['entries'],
      message: 'Entries must name consecutive ordinals.',
    });
  if (end > page.blockCount)
    context.addIssue({
      code: 'custom',
      path: ['entries'],
      message: 'Entries must end within the row.',
    });
  if (more && page.entries.length === 0)
    context.addIssue({
      code: 'custom',
      path: ['entries'],
      message: 'Only a page at the row end may be empty.',
    });
  if (
    (page.cursor !== undefined) !== more ||
    (page.nextBlockOrdinal !== undefined) !== more ||
    (more && page.nextBlockOrdinal !== end)
  )
    context.addIssue({
      code: 'custom',
      path: ['cursor'],
      message: 'A page continues exactly where its entries end.',
    });
  if (
    new TextEncoder().encode(JSON.stringify(page)).byteLength >
    TRANSCRIPT_BOUNDED_BLOCK_PAGE_BYTES
  )
    context.addIssue({
      code: 'custom',
      message: 'A bounded page must fit its byte budget.',
    });
}

export const CoreChatTranscriptBoundedBlocksPageResultSchema = z
  .strictObject({
    projection: z.literal('bounded-v1'),
    messageId: z.string().min(1).max(512),
    firstBlockOrdinal: ordinal,
    entries: z
      .array(TranscriptBoundedBlockEntrySchema)
      .max(TRANSCRIPT_BLOCK_PAGE_LIMIT),
    blockCount: ordinal,
    nextBlockOrdinal: ordinal.optional(),
    cursor: z.string().min(1).max(2048).optional(),
    transcriptRevision: ordinal,
    runTruncated: z.literal(true).optional(),
  })
  .superRefine(checkBoundedPage);
export type CoreChatTranscriptBoundedBlocksPageResult = z.output<
  typeof CoreChatTranscriptBoundedBlocksPageResultSchema
>;

/** Raw blocks, or bounded entries when the request asked for `bounded-v1`. */
export const CoreChatTranscriptBlocksPageResultSchema = z.union([
  CoreChatTranscriptRawBlocksPageResultSchema,
  CoreChatTranscriptBoundedBlocksPageResultSchema,
]);
export type CoreChatTranscriptBlocksPageResult = z.output<
  typeof CoreChatTranscriptBlocksPageResultSchema
>;

export const CoreChatTranscriptBlocksPageErrorSchema =
  CanopyErrorPayloadSchema.extend({
    code: z
      .enum([
        'core.chat.transcript.blocks.page.invalidState',
        'core.chat.transcript.blocks.page.notFound',
        'core.chat.transcript.blocks.page.staleCursor',
      ])
      .optional(),
    retry: CanopyQueryRetryDirectiveSchema,
  });
