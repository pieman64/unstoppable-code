import { z } from 'zod';
import {
  TranscriptTargetSchema,
  type TranscriptTarget,
} from '@canopy/protocol/canopy-core';

export const CHAT_TRANSCRIPT_READ_CURSOR_MAX_LENGTH = 2048;

export type ChatTranscriptReadCursorKind = 'stream' | 'blocks';

/** The host identity which must remain fixed while a paged read continues. */
export interface ChatTranscriptReadCursorContext {
  projectId: string;
  worktreeId: string;
  chatId: string;
  target?: TranscriptTarget;
  archivedContainerId?: string;
  standaloneHistory?: boolean;
}

export interface ChatTranscriptReadCursorValues {
  kind: ChatTranscriptReadCursorKind;
  revision: number;
  position: number;
  messageId: string;
  totalMessages?: number;
}

const safeIdentity = z.string().min(1).max(256);
const transcriptReadCursorBase = z.strictObject({
  version: z.literal(1),
  projectId: safeIdentity,
  worktreeId: safeIdentity,
  chatId: safeIdentity,
  archive: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('live') }),
    z.strictObject({ kind: z.literal('container'), id: safeIdentity }),
    z.strictObject({ kind: z.literal('standalone') }),
  ]),
  target: TranscriptTargetSchema,
  revision: z.number().int().nonnegative().safe(),
  position: z.number().int().nonnegative().safe(),
  messageId: z.string().min(1).max(512),
});
const transcriptReadCursorSchema = z.discriminatedUnion('kind', [
  transcriptReadCursorBase.extend({
    kind: z.literal('stream'),
    totalMessages: z.number().int().nonnegative().safe(),
  }),
  transcriptReadCursorBase.extend({ kind: z.literal('blocks') }),
]);

export type ChatTranscriptReadCursor = z.infer<
  typeof transcriptReadCursorSchema
>;

function staleCursor(kind: ChatTranscriptReadCursorKind): never {
  throw new Error(
    kind === 'stream'
      ? 'Stale transcript stream cursor'
      : 'Stale transcript blocks cursor',
  );
}

function cursorArchiveScope(
  context: ChatTranscriptReadCursorContext,
  kind: ChatTranscriptReadCursorKind,
): ChatTranscriptReadCursor['archive'] {
  if (context.standaloneHistory === true) {
    if (context.archivedContainerId !== undefined) return staleCursor(kind);
    return { kind: 'standalone' };
  }
  if (context.archivedContainerId !== undefined)
    return { kind: 'container', id: context.archivedContainerId };
  return { kind: 'live' };
}

function cursorTarget(
  context: ChatTranscriptReadCursorContext,
  kind: ChatTranscriptReadCursorKind,
): TranscriptTarget {
  const parsed = TranscriptTargetSchema.safeParse(
    context.target ?? { kind: 'primary', chatId: context.chatId },
  );
  if (!parsed.success) return staleCursor(kind);
  return parsed.data;
}

function sameArchiveScope(
  left: ChatTranscriptReadCursor['archive'],
  right: ChatTranscriptReadCursor['archive'],
): boolean {
  return (
    left.kind === right.kind &&
    (left.kind !== 'container' ||
      (right.kind === 'container' && left.id === right.id))
  );
}

function sameTranscriptTarget(
  left: TranscriptTarget,
  right: TranscriptTarget,
): boolean {
  if (left.kind !== right.kind || left.chatId !== right.chatId) return false;
  return (
    left.kind === 'primary' ||
    (right.kind === 'delegation' &&
      left.delegationId === right.delegationId &&
      left.runGeneration === right.runGeneration)
  );
}

/** Encode a bounded, versioned cursor with its complete storage identity. */
export function encodeChatTranscriptReadCursor(
  context: ChatTranscriptReadCursorContext,
  values: ChatTranscriptReadCursorValues,
): string {
  const parsed = transcriptReadCursorSchema.safeParse({
    version: 1,
    kind: values.kind,
    projectId: context.projectId,
    worktreeId: context.worktreeId,
    chatId: context.chatId,
    archive: cursorArchiveScope(context, values.kind),
    target: cursorTarget(context, values.kind),
    revision: values.revision,
    position: values.position,
    messageId: values.messageId,
    ...(values.kind === 'stream' && values.totalMessages !== undefined
      ? { totalMessages: values.totalMessages }
      : {}),
  });
  if (!parsed.success) return staleCursor(values.kind);
  const encoded = Buffer.from(JSON.stringify(parsed.data), 'utf8').toString(
    'base64url',
  );
  if (encoded.length > CHAT_TRANSCRIPT_READ_CURSOR_MAX_LENGTH)
    return staleCursor(values.kind);
  return encoded;
}

/** Decode and bind a cursor to its use site. Every malformed or stale cursor
 * fails with the contract's operation-specific error. */
export function decodeChatTranscriptReadCursor(
  token: string,
  kind: ChatTranscriptReadCursorKind,
  context: ChatTranscriptReadCursorContext,
  messageId?: string,
): ChatTranscriptReadCursor {
  if (
    token.length === 0 ||
    token.length > CHAT_TRANSCRIPT_READ_CURSOR_MAX_LENGTH ||
    !/^[A-Za-z0-9_-]+$/.test(token)
  )
    return staleCursor(kind);

  const bytes = Buffer.from(token, 'base64url');
  if (
    bytes.toString('base64url') !== token ||
    bytes.length > CHAT_TRANSCRIPT_READ_CURSOR_MAX_LENGTH
  )
    return staleCursor(kind);

  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    return staleCursor(kind);
  }
  const parsed = transcriptReadCursorSchema.safeParse(value);
  if (!parsed.success) return staleCursor(kind);

  const cursor = parsed.data;
  let target: TranscriptTarget;
  let archive: ChatTranscriptReadCursor['archive'];
  try {
    target = cursorTarget(context, kind);
    archive = cursorArchiveScope(context, kind);
  } catch {
    return staleCursor(kind);
  }
  if (
    cursor.kind !== kind ||
    cursor.projectId !== context.projectId ||
    cursor.worktreeId !== context.worktreeId ||
    cursor.chatId !== context.chatId ||
    !sameArchiveScope(cursor.archive, archive) ||
    !sameTranscriptTarget(cursor.target, target) ||
    (messageId !== undefined && cursor.messageId !== messageId)
  )
    return staleCursor(kind);
  return cursor;
}
