import {
  CoreChatTranscriptBoundedBlocksPageResultSchema,
  TranscriptBoundedBlockEntrySchema,
  TRANSCRIPT_BOUNDED_BLOCK_PAGE_BYTES,
  TRANSCRIPT_BOUNDED_BLOCK_TYPES,
  TRANSCRIPT_BLOCK_PREVIEW_CHARS,
  type CoreChatTranscriptBoundedBlocksPageResult,
  type TranscriptBoundedBlockEntry,
  type TranscriptContentField,
} from '@canopy/protocol/canopy-core';
import type {
  ChatTranscriptBlocksRequest,
  ChatTranscriptBlocksPage,
} from '@canopy/desktop-shared/types';

const READABLE_FIELDS: readonly TranscriptContentField[] = [
  'output',
  'input',
  'text',
  'partialText',
  'finalText',
];
const HOST_FIELDS = new Set([
  'absolutePath',
  'attachmentPath',
  'attachmentPaths',
  'attachmentPromptContexts',
  'transcriptPath',
]);

function portable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(portable);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !key.endsWith('Ref') && !HOST_FIELDS.has(key))
      .map(([key, child]) => [key, portable(child)]),
  );
}

function notice(
  ordinal: number,
  reason: 'unsupported' | 'tooLarge',
  blockType: unknown,
): TranscriptBoundedBlockEntry {
  return {
    kind: 'notice',
    ordinal,
    reason,
    ...(typeof blockType === 'string' &&
    /^[a-z][a-z0-9_]{0,63}$/.test(blockType)
      ? { blockType }
      : {}),
  };
}

function entryFor(
  block: unknown,
  ordinal: number,
): TranscriptBoundedBlockEntry {
  if (
    typeof block !== 'object' ||
    block === null ||
    !('type' in block) ||
    !TRANSCRIPT_BOUNDED_BLOCK_TYPES.some((type) => type === block.type)
  ) {
    return notice(
      ordinal,
      'unsupported',
      typeof block === 'object' && block !== null && 'type' in block
        ? block.type
        : undefined,
    );
  }
  const projected = portable(block);
  if (typeof projected !== 'object' || projected === null)
    return notice(ordinal, 'tooLarge', block.type);
  const fields: Record<string, unknown> = Object.fromEntries(
    Object.entries(projected),
  );
  const original: Record<string, unknown> = Object.fromEntries(
    Object.entries(block),
  );
  const omittedFields: TranscriptContentField[] = [];
  for (const field of READABLE_FIELDS) {
    const text = fields[field];
    const stored =
      original[`${field}Ref`] !== undefined ||
      (field === 'output' && original.fullOutputRef !== undefined);
    if (
      stored ||
      (typeof text === 'string' && text.length > TRANSCRIPT_BLOCK_PREVIEW_CHARS)
    ) {
      fields[field] =
        typeof text === 'string'
          ? text.slice(0, TRANSCRIPT_BLOCK_PREVIEW_CHARS)
          : '';
      omittedFields.push(field);
    }
  }
  const parsed = TranscriptBoundedBlockEntrySchema.safeParse(
    omittedFields.length
      ? { kind: 'preview', ordinal, block: fields, omittedFields }
      : { kind: 'block', ordinal, block: fields },
  );
  return parsed.success ? parsed.data : notice(ordinal, 'tooLarge', block.type);
}

/** Match child-page-budget's small acquisition step without a whole-row read per block. */
const BLOCK_READ_BATCH = 16;

function verifyBatch(
  page: ChatTranscriptBlocksPage,
  pinned: CoreChatTranscriptBoundedBlocksPageResult,
  first: number,
  count: number,
): void {
  const end = page.firstBlockOrdinal + page.blocks.length;
  if (
    page.messageId !== pinned.messageId ||
    page.transcriptRevision !== pinned.transcriptRevision ||
    page.blockCount !== pinned.blockCount ||
    page.firstBlockOrdinal !== first ||
    page.blocks.length !== Math.min(count, pinned.blockCount - first) ||
    (end < page.blockCount
      ? page.cursor === undefined || page.nextBlockOrdinal !== end
      : page.cursor !== undefined || page.nextBlockOrdinal !== undefined)
  )
    throw new Error('Stale transcript blocks cursor');
}

/**
 * Fit entries from batches of at most 16. A partial batch needs just one
 * shortened read to obtain its existing backend continuation. Individual entry
 * serialization plus one reserved envelope keeps byte accounting linear.
 */
export async function fitBoundedBlockPage(
  request: ChatTranscriptBlocksRequest,
  read: (
    request: ChatTranscriptBlocksRequest,
    signal?: AbortSignal,
  ) => Promise<ChatTranscriptBlocksPage>,
  signal?: AbortSignal,
): Promise<CoreChatTranscriptBoundedBlocksPageResult> {
  let next = request;
  let result: CoreChatTranscriptBoundedBlocksPageResult | undefined;
  let bytes = 0;
  while ((result?.entries.length ?? 0) < request.limit) {
    signal?.throwIfAborted();
    const batchRequest = {
      ...next,
      limit: Math.min(
        BLOCK_READ_BATCH,
        request.limit - (result?.entries.length ?? 0),
      ),
    };
    const page = await read(batchRequest, signal);
    if (!result) {
      result = {
        projection: 'bounded-v1',
        messageId: page.messageId,
        firstBlockOrdinal: page.firstBlockOrdinal,
        entries: [],
        blockCount: page.blockCount,
        transcriptRevision: page.transcriptRevision,
        ...(page.runTruncated ? { runTruncated: true } : {}),
      };
      // Backend cursors are base64url, so 2,048 unescaped ASCII characters
      // reserve their largest serialized size. Reserve the widest safe ordinal
      // and loss flag even on terminal pages; neither grows as entries arrive.
      bytes = Buffer.byteLength(
        JSON.stringify({
          ...result,
          runTruncated: true,
          cursor: 'x'.repeat(2048),
          nextBlockOrdinal: Number.MAX_SAFE_INTEGER,
        }),
        'utf8',
      );
    }
    const first = result.firstBlockOrdinal + result.entries.length;
    verifyBatch(page, result, first, batchRequest.limit);
    let accepted = 0;
    for (const block of page.blocks) {
      let entry = entryFor(block, first + accepted);
      let entryBytes = Buffer.byteLength(JSON.stringify(entry), 'utf8');
      const comma = result.entries.length === 0 ? 0 : 1;
      if (bytes + entryBytes + comma > TRANSCRIPT_BOUNDED_BLOCK_PAGE_BYTES) {
        if (result.entries.length > 0) break;
        entry = notice(
          first,
          'tooLarge',
          entry.kind === 'notice' ? entry.blockType : entry.block.type,
        );
        entryBytes = Buffer.byteLength(JSON.stringify(entry), 'utf8');
      }
      result.entries.push(entry);
      bytes += entryBytes + comma;
      accepted += 1;
    }
    if (accepted === 0) break; // Reuse the previous batch's exact continuation.
    let continuation = page;
    if (accepted < page.blocks.length) {
      signal?.throwIfAborted();
      continuation = await read({ ...batchRequest, limit: accepted }, signal);
      verifyBatch(continuation, result, first, accepted);
    }
    result.cursor = continuation.cursor;
    result.nextBlockOrdinal = continuation.nextBlockOrdinal;
    if (accepted < page.blocks.length || result.cursor === undefined) break;
    next = { ...request, firstBlockOrdinal: undefined, cursor: result.cursor };
  }
  if (!result) throw new Error('Invalid transcript block range');
  // The only full-page serialization/refinement in the fitting path.
  return CoreChatTranscriptBoundedBlocksPageResultSchema.parse(result);
}
