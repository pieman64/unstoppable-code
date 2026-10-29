import type { DatabaseSync } from 'node:sqlite';
import {
  type ChatSearchCatalogEntry,
  type ChatSearchDocumentKind,
  type ChatSearchMatchRange,
  type ChatSearchQueryRequest,
  type ChatSearchResult,
  type TrackedPlanReviewStatus,
} from '@canopy/desktop-shared/types';
import { requireSqliteRow } from './sqlite-rows';

const DEFAULT_QUERY_LIMIT = 20;
const MAX_QUERY_LIMIT = 100;
const MATCH_START = '\u0001';
const MATCH_END = '\u0002';
const SNIPPET_ELLIPSIS = ' … ';

const CHAT_SEARCH_SOURCES = [
  'live',
  'worktree-archive',
  'cowork-archive',
  'plan',
  'archived-container',
] as const;

const PLAN_REVIEW_STATUSES: readonly TrackedPlanReviewStatus[] = [
  'pending',
  'approved',
  'dismissed',
];

const DOCUMENT_KINDS: readonly ChatSearchDocumentKind[] = [
  'chat',
  'plan',
  'archived-container',
];

function asDocumentKind(
  value: unknown,
  source: ChatSearchCatalogEntry['source'],
): ChatSearchDocumentKind {
  const kind = DOCUMENT_KINDS.find((candidate) => candidate === value);
  return kind ?? (source === 'plan' ? 'plan' : 'chat');
}

function isChatSearchSource(
  value: unknown,
): value is ChatSearchCatalogEntry['source'] {
  return (
    typeof value === 'string' &&
    CHAT_SEARCH_SOURCES.some((source) => source === value)
  );
}

function asPlanReviewStatus(value: unknown): TrackedPlanReviewStatus | null {
  return PLAN_REVIEW_STATUSES.find((status) => status === value) ?? null;
}

function asFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'bigint') return Number(value);
  return null;
}

function asNullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function mapChatSearchCatalogRow(
  row: Record<string, unknown>,
): ChatSearchCatalogEntry {
  const source = row.source;
  if (!isChatSearchSource(source)) {
    throw new Error('Invalid chat search source');
  }
  const docId = row.doc_id;
  const projectId = row.project_id;
  const worktreeId = row.worktree_id;
  const chatId = row.chat_id;
  const title = row.title;
  const updatedAt = asFiniteNumber(row.updated_at);
  const archivedAt = asFiniteNumber(row.archived_at);
  const expiresAt = asFiniteNumber(row.expires_at);
  const messageCount = asFiniteNumber(row.message_count);
  if (
    typeof docId !== 'string' ||
    typeof projectId !== 'string' ||
    typeof worktreeId !== 'string' ||
    typeof chatId !== 'string' ||
    typeof title !== 'string' ||
    updatedAt === null ||
    messageCount === null
  ) {
    throw new Error('Invalid chat search catalog row');
  }
  return {
    docId,
    projectId,
    worktreeId,
    chatId,
    source,
    documentKind: asDocumentKind(row.document_kind, source),
    title,
    description: asNullableString(row.description),
    providerType: asNullableString(row.provider_type),
    updatedAt,
    archivedAt,
    expiresAt,
    messageCount,
    reviewStatus: asPlanReviewStatus(row.review_status),
  };
}

/** Converts arbitrary palette input into an FTS5-safe AND-prefix query. */
export function sanitizeChatSearchQuery(query: string): string | null {
  const tokens = query.match(/[A-Za-z0-9_\u0080-\uFFFF]+/g);
  if (!tokens?.length) return null;
  return tokens.map((token) => `"${token}"*`).join(' ');
}

export function parseChatSearchSnippet(markedSnippet: string): {
  snippet: string;
  matchRanges: ChatSearchMatchRange[];
} {
  let snippet = '';
  let matchStart: number | null = null;
  const matchRanges: ChatSearchMatchRange[] = [];
  for (const character of markedSnippet) {
    if (character === MATCH_START) {
      if (matchStart === null) matchStart = snippet.length;
      continue;
    }
    if (character === MATCH_END) {
      if (matchStart !== null) {
        if (snippet.length > matchStart) {
          matchRanges.push({ start: matchStart, end: snippet.length });
        }
        matchStart = null;
      }
      continue;
    }
    snippet += character;
  }
  if (matchStart !== null && snippet.length > matchStart) {
    matchRanges.push({ start: matchStart, end: snippet.length });
  }
  return { snippet, matchRanges };
}

export function normalizeQueryRequest(request: ChatSearchQueryRequest): {
  ftsQuery: string;
  limit: number;
} | null {
  const ftsQuery = sanitizeChatSearchQuery(request.query);
  if (!ftsQuery) return null;
  const requestedLimit = request.limit;
  const limit =
    typeof requestedLimit === 'number' && Number.isFinite(requestedLimit)
      ? Math.min(MAX_QUERY_LIMIT, Math.max(0, Math.trunc(requestedLimit)))
      : DEFAULT_QUERY_LIMIT;
  return limit === 0 ? null : { ftsQuery, limit };
}

/**
 * A chat's committed text and in-flight text are separate FTS rows under one
 * doc id, so the top `offset + limit` chats always appear within the top
 * 2 × (offset + limit) ranked rows. Ranking rows and taking that window keeps
 * snippet() to the rows SQLite returns; grouping every match first built a
 * snippet per match (277 ms on Electron main for 10,000 matching chats). The
 * window doubles if a doc ever has more rows than that.
 */
function rankedRowWindow(offset: number, limit: number): number {
  return 2 * (offset + limit);
}

export function queryChatSearchDatabase(
  db: DatabaseSync,
  request: ChatSearchQueryRequest,
  now = Date.now(),
  offset = 0,
): ChatSearchResult[] {
  const normalized = normalizeQueryRequest(request);
  if (!normalized) return [];
  const start = Math.max(0, Math.trunc(offset));
  const needed = start + normalized.limit;
  const statement = db.prepare(
    `SELECT d.doc_id, d.project_id, d.worktree_id, d.chat_id, d.source,
            d.document_kind, d.title, d.description, d.provider_type, d.updated_at,
            d.archived_at, d.expires_at, d.message_count, d.review_status,
            snippet(chat_fts, 2, ?, ?, ?, 24) AS marked_snippet
     FROM chat_fts
     JOIN chat_docs d ON d.doc_id = chat_fts.doc_id
     WHERE body MATCH ?
       AND (d.expires_at IS NULL OR d.expires_at > ?)
     ORDER BY bm25(chat_fts)
     LIMIT ?`,
  );
  for (let window = rankedRowWindow(start, normalized.limit); ; window *= 2) {
    const rows: unknown[] = statement.all(
      MATCH_START,
      MATCH_END,
      SNIPPET_ELLIPSIS,
      normalized.ftsQuery,
      now,
      window,
    );
    // Rows arrive best first, so each doc's first row is its best match.
    const seen = new Set<unknown>();
    const docs: Record<string, unknown>[] = [];
    for (const result of rows) {
      const row = requireSqliteRow(result);
      if (seen.has(row.doc_id)) continue;
      seen.add(row.doc_id);
      docs.push(row);
    }
    if (docs.length < needed && rows.length === window) continue;
    return docs.slice(start, needed).map((row) => {
      const catalogEntry = mapChatSearchCatalogRow(row);
      const markedSnippet =
        typeof row.marked_snippet === 'string' ? row.marked_snippet : '';
      return { ...catalogEntry, ...parseChatSearchSnippet(markedSnippet) };
    });
  }
}

/**
 * FTS can rank a hit cheaply, but snippet() materializes and scans the full
 * matching body. Probe the aggregate byte length of the ranked rows a query
 * page projects so normal chats stay on the low-latency in-process path and an
 * oversized body or page of collectively large matches can be projected in a
 * utility process.
 */
export function chatSearchQueryExceedsBodyThreshold(
  db: DatabaseSync,
  request: ChatSearchQueryRequest,
  thresholdBytes: number,
  now = Date.now(),
): boolean {
  const normalized = normalizeQueryRequest(request);
  if (!normalized) return false;
  const rows: unknown[] = db
    .prepare(
      `SELECT length(CAST(chat_fts.body AS BLOB)) AS body_bytes
       FROM chat_fts
       JOIN chat_docs d ON d.doc_id = chat_fts.doc_id
       WHERE body MATCH ?
         AND (d.expires_at IS NULL OR d.expires_at > ?)
       ORDER BY bm25(chat_fts)
       LIMIT ?`,
    )
    .all(normalized.ftsQuery, now, rankedRowWindow(0, normalized.limit));
  let projectedBytes = 0;
  for (const value of rows) {
    const bytes = requireSqliteRow(value).body_bytes;
    if (typeof bytes !== 'number' && typeof bytes !== 'bigint') continue;
    projectedBytes += Number(bytes);
    if (projectedBytes > thresholdBytes) return true;
  }
  return false;
}
