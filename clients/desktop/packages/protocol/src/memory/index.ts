export interface MemorySearchRequest {
  organizationExternalId: string;
  query: string;
  /**
   * The raw human-typed message for the current turn, without the client-side
   * context enrichment applied to `query` (repo/worktree labels, recent
   * messages, task summary). Lexical retrieval lanes (trigram/FTS/entity
   * matching) score against this short string when present; embedding and
   * rerank lanes keep using the enriched `query`. Trimmed, max 2000 chars —
   * the same cap as `query`.
   */
  lexicalQuery?: string;
  limit?: number;
  debug?: boolean;
}

export interface MemorySearchFact {
  /**
   * Stable server-side fact id. Optional on the wire for compatibility with
   * facts persisted before ids were exposed; feedback requires it.
   */
  factId?: string;
  factText: string;
  validAt: string | null;
  sourceTurnIds: string[];
}

export interface MemorySearchDiagnostics {
  laneCounts: { vector: number; fts: number; trigram: number; graph?: number };
  rerankUsed: boolean;
  topRerankScore: number | null;
  topCosineScore: number | null;
  gatePassed: boolean;
  latencyMs: number;
}

export interface MemorySearchResponse {
  /**
   * Stable id for this retrieval occurrence. Present when the search audit row
   * was persisted; feedback uses it to distinguish the same fact injected in
   * different messages.
   */
  searchId?: string;
  facts: MemorySearchFact[];
  renderedBlock: string | null;
  diagnostics?: MemorySearchDiagnostics;
}

export const MEMORY_SEARCH_CAPABILITY = 'memorySearch';

export const MEMORY_FEEDBACK_RATINGS = ['like', 'dislike'] as const;
export type MemoryFeedbackRating = (typeof MEMORY_FEEDBACK_RATINGS)[number];

/**
 * User feedback on one injected memory fact occurrence. A user may submit at
 * most once for a `(searchId, factId)` pair. At least one of
 * `rating`/`comment` must be present.
 */
export interface MemoryFeedbackRequest {
  organizationExternalId: string;
  searchId: string;
  factId: string;
  rating?: MemoryFeedbackRating;
  comment?: string;
}

export interface MemoryFactFeedback {
  rating?: MemoryFeedbackRating;
  comment?: string;
  createdAt: string;
}

export interface MemoryFeedbackResponse {
  recorded: boolean;
  /**
   * The stored feedback. On a duplicate submission this is the original row,
   * allowing clients to converge on the durable submitted state.
   */
  feedback?: MemoryFactFeedback;
}

export interface MemoryFeedbackQueryResponse {
  feedback: MemoryFactFeedback | null;
  /** Whether this occurrence still has enough provenance to accept feedback. */
  canSubmit: boolean;
}

export const MEMORY_DELIVERY_OUTCOMES = ['delivered', 'dropped'] as const;
export type MemoryDeliveryOutcome = (typeof MEMORY_DELIVERY_OUTCOMES)[number];

/**
 * Why a gate-passed search's block never entered the composed turn.
 * `breaker_open` is deliberately not a drop reason: with the client's search
 * circuit breaker open no search ran, so there is no `searchId` to ack and
 * nothing was wasted server-side.
 */
export const MEMORY_DROP_REASONS = [
  'race_timeout',
  'turn_aborted',
  'send_failed',
] as const;
export type MemoryDropReason = (typeof MEMORY_DROP_REASONS)[number];

/** Server-side clamp bound for {@link MemoryDeliveredRequest.clientElapsedMs}. */
export const MEMORY_DELIVERY_CLIENT_ELAPSED_MAX_MS = 60_000;
/** Server-side clamp bound for {@link MemoryDeliveredRequest.clientChatId}. */
export const MEMORY_DELIVERY_CLIENT_CHAT_ID_MAX_CHARS = 128;

/**
 * Client acknowledgement that the block returned by a search was actually
 * composed into the submitted turn. A search response alone does not prove
 * delivery — the client may drop the block on the floor when the turn budget
 * expires mid-flight — so injection metrics key off this ack, not the search.
 *
 * The attribution fields are all optional: an ack without `outcome` is a
 * legacy client and is treated as `{ outcome: 'delivered' }`.
 */
export interface MemoryDeliveredRequest {
  organizationExternalId: string;
  searchId: string;
  outcome?: MemoryDeliveryOutcome;
  /** Present only when `outcome` is `'dropped'`. */
  dropReason?: MemoryDropReason;
  /** Dispatch-start → ack decision, clamped server-side to 0..60_000. */
  clientElapsedMs?: number;
  /** Same clamp discipline as telemetry ids (≤128 chars). */
  clientChatId?: string;
}

export interface MemoryDeliveredResponse {
  recorded: boolean;
}

export const MEMORY_FEEDBACK_COMMENT_MAX_CHARS = 2000;
