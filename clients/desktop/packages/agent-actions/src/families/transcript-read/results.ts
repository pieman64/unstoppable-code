import {
  CoreChatContentReadResultSchema,
  CoreChatTranscriptBoundedBlocksPageResultSchema,
  CoreChatTranscriptPageResultSchema,
  TRANSCRIPT_READ_WRAPPER_BYTES,
  hasHostAbsolutePath,
  type CoreChatContentReadResult,
  type CoreChatTranscriptBoundedBlocksPageResult,
  type CoreChatTranscriptPageResult,
} from '@canopy/protocol/canopy-core';
import { z } from 'zod';
import { agentActionError } from '../../action-support';
import type { AgentActionResponse, AgentJson } from '../../response';
import type { AgentActionCall } from '../../surface/family';
import type { TranscriptReadActionType } from './actions';

export const TRANSCRIPT_READ_REPLY_BYTES = TRANSCRIPT_READ_WRAPPER_BYTES;
type ReadResult =
  | CoreChatTranscriptPageResult
  | CoreChatContentReadResult
  | CoreChatTranscriptBoundedBlocksPageResult;
const structuralPathFields: ReadonlySet<string> = new Set([
  'absolutePath',
  'attachmentPath',
  'attachmentPaths',
  'attachmentPromptContexts',
  'transcriptPath',
]);
/** Result keys holding persisted rows, block entries or a stored body. */
const persistedKeys: Readonly<
  Record<TranscriptReadActionType, ReadonlySet<string>>
> = {
  'chat.transcript.page': new Set(['messages', 'latestHumanMessage']),
  'chat.content.read': new Set(['text']),
  'chat.transcript.blocks.page': new Set(['entries']),
};

/**
 * Persisted rows carry user and model text in many fields (prompts, display
 * inputs, agent paths), so their strings pass verbatim and only the
 * protocol's structural path metadata is rejected there. Strings outside
 * the persisted keys stay subject to the strict host-path check.
 */
function leaksPath(value: AgentJson, persisted: boolean): boolean {
  if (Array.isArray(value))
    return value.some((item) => leaksPath(item, persisted));
  if (value === null || typeof value !== 'object')
    return !persisted && hasHostAbsolutePath(value);
  if (value.type === 'image' && hasHostAbsolutePath(value.path)) return true;
  return Object.entries(value).some(
    ([key, field]) =>
      structuralPathFields.has(key) || leaksPath(field, persisted),
  );
}

/**
 * Preserve sanctioned persisted strings, including unpaired code units. Check
 * original JSON, not a stripping DTO parse, so unexpected structural metadata
 * cannot disappear before the portability guard. Never clip rows or cursors.
 */
export function transcriptReadResult(
  call: AgentActionCall<unknown>,
  type: TranscriptReadActionType,
  result: ReadResult,
): AgentActionResponse {
  // Optional protocol keys may hold undefined (a final page's cursor); drop
  // them as the reply's JSON would. The round trip keeps unpaired code units.
  let encoded: unknown;
  try {
    encoded = JSON.parse(JSON.stringify(result));
  } catch {
    encoded = undefined;
  }
  const json = z.json().safeParse(encoded);
  const schema =
    type === 'chat.transcript.page'
      ? CoreChatTranscriptPageResultSchema
      : type === 'chat.content.read'
        ? CoreChatContentReadResultSchema
        : CoreChatTranscriptBoundedBlocksPageResultSchema;
  const root = json.success ? json.data : null;
  if (
    root === null ||
    typeof root !== 'object' ||
    Array.isArray(root) ||
    !schema.safeParse(result).success ||
    Object.entries(root).some(
      ([key, field]) =>
        structuralPathFields.has(key) ||
        leaksPath(field, persistedKeys[type].has(key)),
    )
  ) {
    return agentActionError(
      call,
      'execution_failed',
      'The transcript read returned nonportable metadata or an invalid result.',
    );
  }
  const response: AgentActionResponse = {
    requestId: call.toolUseId ?? '',
    ok: true,
    result: root,
  };
  // The shared engine pretty-prints the reply. Also bound the JSON text-tool
  // envelope (including double escaping), not only compact protocol JSON.
  const serialized = JSON.stringify(response, null, 2);
  const wrapper = JSON.stringify({
    content: [{ type: 'text', text: serialized }],
    isError: false,
  });
  const encoder = new TextEncoder();
  if (
    encoder.encode(serialized).byteLength > TRANSCRIPT_READ_REPLY_BYTES ||
    encoder.encode(wrapper).byteLength > TRANSCRIPT_READ_REPLY_BYTES
  ) {
    return agentActionError(
      call,
      'quota_exceeded',
      'The transcript reply exceeds 1 MiB. Read known message blocks or smaller content ranges instead; page selection has no adjustable limit.',
    );
  }
  return response;
}
