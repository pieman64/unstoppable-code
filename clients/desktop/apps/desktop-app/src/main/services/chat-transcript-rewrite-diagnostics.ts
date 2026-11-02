import { createHash } from 'node:crypto';
import { logMainProcessWarn } from '../lib/main-process-logging';

/**
 * Why the transcript planner rewrote an existing chat's committed history.
 * Intentional replacements (import, reset, migration, fork) never report.
 */
export type ChatTranscriptRewriteReason =
  | 'patch'
  | 'removal'
  | 'mixed_active'
  | 'prompt_relocation'
  | 'replacement';

/**
 * Content-free record of one full committed transcript rewrite. Shaped as
 * flat optional `AppDiagnosticRecord` fields so it can be forwarded verbatim
 * once the `chat_transcript_full_rewrite` kind is registered there. It never
 * carries message ids, text, paths, or scope identifiers; the chat key is an
 * opaque digest that only correlates repeated rewrites of one chat.
 */
export interface ChatTranscriptFullRewriteDiagnostic {
  version: 1;
  timestamp: string;
  kind: 'chat_transcript_full_rewrite';
  reason: ChatTranscriptRewriteReason;
  chatTranscriptRewriteChatKey: string;
  chatTranscriptRewriteCommittedRows: number;
  chatTranscriptRewriteCommittedBytes: number;
  /** JSONL bytes serialized by this replacement; cloned prefix excluded. */
  chatTranscriptRewriteBytesWritten?: number;
  /** Serialized replacement through publication/index work; excludes queue wait. */
  chatTranscriptRewriteDurationMs?: number;
  chatTranscriptRewritePatchedRows: number;
  chatTranscriptRewriteRemovedRows: number;
  /** Distinct block types of the patched rows, sorted, at most 8. */
  chatTranscriptRewritePatchedBlockTypes: string[];
  /** Whether the replacement also keeps an active tail (a live turn). */
  chatTranscriptRewriteActiveTail: boolean;
  /** Rewrites of this chat suppressed by the rate limit since the last record. */
  chatTranscriptRewriteSuppressedCount: number;
}

export interface ChatTranscriptFullRewrite {
  chatId: string;
  reason: ChatTranscriptRewriteReason;
  committedRows: number;
  committedBytes: number;
  measurement?: { bytesWritten: number; durationMs: number };
  patchedRows: number;
  removedRows: number;
  patchedBlockTypes: Iterable<string>;
  activeTail: boolean;
}

export type ChatTranscriptRewriteDiagnosticSink = (
  diagnostic: ChatTranscriptFullRewriteDiagnostic,
) => void;

/** At most one record per chat per minute; storms show up as counts. */
export const CHAT_TRANSCRIPT_REWRITE_DIAGNOSTIC_INTERVAL_MS = 60_000;
const MAX_TRACKED_CHATS = 256;
const MAX_BLOCK_TYPES = 8;

const logRecord: ChatTranscriptRewriteDiagnosticSink = (diagnostic) =>
  logMainProcessWarn(
    '[chat-storage] full committed transcript rewrite',
    diagnostic,
  );

/** Every record (after rate limiting) reaches the main log. */
let log: ChatTranscriptRewriteDiagnosticSink = logRecord;
/** Installed by the production chat state host: app diagnostics. */
let forward: ChatTranscriptRewriteDiagnosticSink | undefined;
let now: () => number = Date.now;
const lastRecordedAt = new Map<string, number>();
const suppressed = new Map<string, number>();

function opaqueChatKey(chatId: string): string {
  return createHash('sha256')
    .update('chat-transcript-rewrite\0')
    .update(chatId)
    .digest('hex')
    .slice(0, 16);
}

function boundedBlockTypes(types: Iterable<string>): string[] {
  return Array.from(new Set(types)).sort().slice(0, MAX_BLOCK_TYPES);
}

/**
 * Report a full committed rewrite. Rate-limited per chat; the record carries
 * the number of rewrites suppressed since the previous one. Never throws.
 */
export function reportChatTranscriptFullRewrite(
  rewrite: ChatTranscriptFullRewrite,
): void {
  try {
    const key = opaqueChatKey(rewrite.chatId);
    const at = now();
    const previous = lastRecordedAt.get(key);
    if (
      previous !== undefined &&
      at - previous < CHAT_TRANSCRIPT_REWRITE_DIAGNOSTIC_INTERVAL_MS
    ) {
      suppressed.set(key, (suppressed.get(key) ?? 0) + 1);
      return;
    }
    lastRecordedAt.delete(key);
    lastRecordedAt.set(key, at);
    if (lastRecordedAt.size > MAX_TRACKED_CHATS) {
      const oldest = lastRecordedAt.keys().next().value;
      if (oldest !== undefined) {
        lastRecordedAt.delete(oldest);
        suppressed.delete(oldest);
      }
    }
    const suppressedCount = suppressed.get(key) ?? 0;
    suppressed.delete(key);
    const record: ChatTranscriptFullRewriteDiagnostic = {
      version: 1,
      timestamp: new Date(at).toISOString(),
      kind: 'chat_transcript_full_rewrite',
      reason: rewrite.reason,
      chatTranscriptRewriteChatKey: key,
      chatTranscriptRewriteCommittedRows: rewrite.committedRows,
      chatTranscriptRewriteCommittedBytes: rewrite.committedBytes,
      ...(rewrite.measurement === undefined
        ? {}
        : {
            chatTranscriptRewriteBytesWritten: rewrite.measurement.bytesWritten,
            chatTranscriptRewriteDurationMs: rewrite.measurement.durationMs,
          }),
      chatTranscriptRewritePatchedRows: rewrite.patchedRows,
      chatTranscriptRewriteRemovedRows: rewrite.removedRows,
      chatTranscriptRewritePatchedBlockTypes: boundedBlockTypes(
        rewrite.patchedBlockTypes,
      ),
      chatTranscriptRewriteActiveTail: rewrite.activeTail,
      chatTranscriptRewriteSuppressedCount: suppressedCount,
    };
    log(record);
    forward?.(record);
  } catch {
    // Diagnostics never affect a canonical commit.
  }
}

/**
 * Route records to app diagnostics in addition to the main log. The storage
 * layer does not import observability itself: backends are also built by
 * read-only tools and tests that must not start its disk writer.
 */
export function installChatTranscriptRewriteDiagnosticSink(
  sink: ChatTranscriptRewriteDiagnosticSink,
): void {
  forward = sink;
}

/** Test seam: capture records (no log line) and control the clock. */
export function setChatTranscriptRewriteDiagnosticsForTests(
  options: {
    sink?: ChatTranscriptRewriteDiagnosticSink;
    now?: () => number;
  } = {},
): void {
  log = options.sink ?? logRecord;
  forward = undefined;
  now = options.now ?? Date.now;
  lastRecordedAt.clear();
  suppressed.clear();
}
