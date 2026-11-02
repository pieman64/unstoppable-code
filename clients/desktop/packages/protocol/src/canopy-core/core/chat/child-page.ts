import { CoreChatTranscriptPageResultSchema } from './transcript';

/** One stored child row, with the fields shared readers present narrowed. */
export interface CoreChatChildPageRow {
  readonly id: string;
  readonly role: 'user' | 'assistant' | 'system';
  readonly timestamp: number;
  readonly truncated?: true;
  readonly blocksPaged?: { readonly blockCount: number };
  /** The row as read; each host validates it against its own message model. */
  readonly row: unknown;
}

export interface CoreChatChildPage {
  readonly rows: readonly CoreChatChildPageRow[];
  readonly cursor?: string;
  readonly transcriptRevision: number;
  readonly runTruncated?: true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface ReadRow extends Record<string, unknown> {
  id: string;
  role: 'user' | 'assistant' | 'system';
  timestamp: number;
  truncated?: true;
  blocksOmitted?: { blockCount: number };
  blocksRef?: { blockCount: number };
}

function isBlockCount(value: unknown): value is { blockCount: number } {
  return (
    isRecord(value) &&
    typeof value.blockCount === 'number' &&
    Number.isSafeInteger(value.blockCount) &&
    value.blockCount >= 0
  );
}

/** The protocol's catchall fields must be narrowed before presentation. */
function isReadRow(value: unknown): value is ReadRow {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    (value.role === 'user' ||
      value.role === 'assistant' ||
      value.role === 'system') &&
    typeof value.timestamp === 'number' &&
    Number.isFinite(value.timestamp) &&
    (value.truncated === undefined || value.truncated === true) &&
    (value.blocksOmitted === undefined || isBlockCount(value.blocksOmitted)) &&
    (value.blocksRef === undefined || isBlockCount(value.blocksRef))
  );
}

/**
 * Narrows a `core.chat.transcript.page` child stream result for the shared
 * reader; undefined when the result or any row is malformed.
 */
export function parseCoreChatChildPage(
  value: unknown,
): CoreChatChildPage | undefined {
  const parsed = CoreChatTranscriptPageResultSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const rows: CoreChatChildPageRow[] = [];
  for (const rawMessage of parsed.data.messages) {
    const message: unknown = rawMessage;
    if (!isReadRow(message)) return undefined;
    const blockCount = message.blocksOmitted ?? message.blocksRef;
    rows.push({
      id: message.id,
      role: message.role,
      timestamp: message.timestamp,
      ...(message.truncated ? { truncated: true } : {}),
      ...(blockCount
        ? { blocksPaged: { blockCount: blockCount.blockCount } }
        : {}),
      row: message,
    });
  }
  return {
    rows,
    transcriptRevision: parsed.data.transcriptRevision,
    ...(parsed.data.cursor ? { cursor: parsed.data.cursor } : {}),
    ...(parsed.data.runTruncated ? { runTruncated: true } : {}),
  };
}
