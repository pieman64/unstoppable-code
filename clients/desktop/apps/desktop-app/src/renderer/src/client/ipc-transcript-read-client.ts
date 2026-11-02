import type {
  DelegationPage,
  TranscriptReadClient,
  TranscriptReadResult,
} from '@canopy/app-core';
import {
  CoreChatContentReadResultSchema,
  CoreChatTranscriptBoundedBlocksPageResultSchema,
  parseCoreChatChildPage,
} from '@canopy/protocol/canopy-core';
import { transcriptReadFailure } from '@canopy/protocol/portal';
import type { CanopyCoreRelayReply } from '../../../shared/canopy-core-relay';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readPage(value: unknown): TranscriptReadResult<DelegationPage> {
  const page = parseCoreChatChildPage(value);
  return page ? { ok: true, value: page } : { ok: false, kind: 'failed' };
}

function failure<T>(error: unknown): TranscriptReadResult<T> {
  if (
    isRecord(error) &&
    (error.kind === 'cancelled' || error.name === 'AbortError')
  )
    return { ok: false, kind: 'cancelled' };
  return { ok: false, kind: transcriptReadFailure(error) };
}

/**
 * Abort fences only: the relay cannot cancel one request. In particular this
 * promise stays pending until the relay settles, so the store retains its permit.
 */
async function invoke<T>(
  method: string,
  params: Record<string, unknown>,
  signal: AbortSignal,
  validate: (value: unknown) => TranscriptReadResult<T>,
): Promise<TranscriptReadResult<T>> {
  if (signal.aborted) return { ok: false, kind: 'cancelled' };
  try {
    if (typeof window === 'undefined' || !window.canopyCore) {
      return { ok: false, kind: 'unavailable' };
    }
    const reply: CanopyCoreRelayReply = await window.canopyCore.invoke({
      kind: 'request',
      method,
      params,
    });
    if (signal.aborted) return { ok: false, kind: 'cancelled' };
    return reply.ok ? validate(reply.value) : failure(reply.error);
  } catch (error) {
    return signal.aborted ? { ok: false, kind: 'cancelled' } : failure(error);
  }
}

export const ipcTranscriptReadClient: TranscriptReadClient = {
  delegationPage: (request, signal) =>
    invoke('core.chat.transcript.page', { ...request }, signal, readPage),
  content: (request, signal) =>
    invoke('core.chat.content.read', { ...request }, signal, (value) => {
      const parsed = CoreChatContentReadResultSchema.safeParse(value);
      return parsed.success
        ? { ok: true, value: parsed.data }
        : { ok: false, kind: 'failed' };
    }),
  blocks: (request, signal) =>
    invoke(
      'core.chat.transcript.blocks.page',
      { ...request, projection: 'bounded-v1' },
      signal,
      (value) => {
        const parsed =
          CoreChatTranscriptBoundedBlocksPageResultSchema.safeParse(value);
        if (!parsed.success) return { ok: false, kind: 'failed' };
        const page = parsed.data;
        return {
          ok: true,
          value: {
            messageId: page.messageId,
            firstBlockOrdinal: page.firstBlockOrdinal,
            entries: page.entries,
            blockCount: page.blockCount,
            transcriptRevision: page.transcriptRevision,
            ...(page.cursor !== undefined ? { cursor: page.cursor } : {}),
            ...(page.nextBlockOrdinal !== undefined
              ? { nextBlockOrdinal: page.nextBlockOrdinal }
              : {}),
            ...(page.runTruncated ? { runTruncated: page.runTruncated } : {}),
          },
        };
      },
    ),
};
