/**
 * Browser-safe organization memory explorer contracts, moved from
 * `apps/web/src/lib/memory-explorer/types.ts` (which re-exports them).
 */

import { z } from 'zod';
import { settingsDtoSchema } from './operation-definition';

export type ExplorerEvidenceType = 'OBSERVED' | 'ASSERTED' | 'INFERRED';
export type ExplorerEntityType = 'SERVICE' | 'CODE' | 'TOOL';
export type ExplorerFactLiveness = 'live' | 'superseded';

export interface ExplorerEntity {
  id: string;
  canonicalName: string;
  entityType: ExplorerEntityType;
}

export interface ExplorerFact {
  id: string;
  factText: string;
  evidenceType: ExplorerEvidenceType;
  evidenceQuote: string | null;
  validAt: string | null;
  invalidAt: string | null;
  createdAt: string;
  expiredAt: string | null;
  invalidatedById: string | null;
  liveness: ExplorerFactLiveness;
  entities: ExplorerEntity[];
}

export interface ExplorerRankedFact extends ExplorerFact {
  score: number;
  rrfScore: number;
  vectorCosine: number | null;
  rerankScore: number | null;
}

export interface ExplorerFactSource {
  id: string;
  transcriptTurnId: string | null;
  referenceTime: string;
  actor: {
    id: string;
    name: string | null;
    email: string;
  } | null;
}

export interface ExplorerSupersessionFact {
  id: string;
  factText: string;
  createdAt: string;
  liveness: ExplorerFactLiveness;
}

export interface ExplorerFactDetail extends ExplorerFact {
  sources: ExplorerFactSource[];
  supersessionChain: ExplorerSupersessionFact[];
}

export interface ExplorerTranscriptMessage {
  scope: 'worktree';
  localChatId: string;
  localMessageId: string;
  role: string;
  status: string;
  content: string;
  occurredAt: string;
  parts?: unknown;
}

export interface ExplorerSourceTranscript {
  restricted: boolean;
  evidenceQuote: string | null;
  source: ExplorerFactSource;
  messages: ExplorerTranscriptMessage[];
}

export type ExplorerIngestJobStatus =
  | 'PENDING'
  | 'RUNNING'
  | 'DONE'
  | 'FAILED'
  | 'DEAD';

export interface ExplorerIngestJob {
  id: string;
  status: ExplorerIngestJobStatus;
  attempts: number;
  notBefore: string;
  lockedBy: string | null;
  lockedAt: string | null;
  lastHeartbeatAt: string | null;
  heartbeatStale: boolean;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ExplorerRetrievalPreviewDiagnostics {
  laneCounts: { vector: number; fts: number; trigram: number; graph: number };
  rerankUsed: boolean;
  topRerankScore: number | null;
  topCosineScore: number | null;
  latencyMs: number;
  topScores: { rerank: number[]; cosine: number[]; rrf: number[] };
}

// A post-rerank candidate the pipeline considered but did not inject; only
// entity links are hydrated so the graph view can spotlight near-misses.
export interface ExplorerRetrievalCandidate {
  factId: string;
  score: number;
  entityIds: string[];
}

// "What would the agent see" for a query: the exact turn-time search pipeline
// (gate + injection cap + rendered block), not the corpus-search ranking.
export interface ExplorerRetrievalPreview {
  gatePassed: boolean;
  // Ranked candidates considered by the gate; lets the UI distinguish
  // "gate blocked N candidates" from "nothing retrieved at all".
  candidateCount: number;
  facts: ExplorerFact[];
  candidates: ExplorerRetrievalCandidate[];
  renderedBlock: string | null;
  truncated: boolean;
  diagnostics: ExplorerRetrievalPreviewDiagnostics;
}

export interface ExplorerSearchLogFact {
  id: string;
  factText: string;
}

export interface ExplorerSearchLogEntry {
  id: string;
  query: string | null;
  queryDecryptFailed: boolean;
  topScores: unknown;
  injectedFacts: ExplorerSearchLogFact[];
  gatePassed: boolean;
  truncated: boolean;
  latencyMs: number;
  createdAt: string;
  user: {
    id: string;
    name: string | null;
    email: string;
  };
}

export interface ExplorerGraphNode {
  id: string;
  canonicalName: string;
  entityType: ExplorerEntityType;
  // Distinct facts linking this entity WITHIN the applied graph filters (and
  // the link-scan cap), not the entity's global fact count.
  factCount: number;
  factIds: string[];
}

export interface ExplorerGraphEdge {
  source: string;
  target: string;
  weight: number;
  factIds: string[];
}

export interface ExplorerEntityGraph {
  nodes: ExplorerGraphNode[];
  edges: ExplorerGraphEdge[];
  truncated: boolean;
}

/* -------------------------------------------------------------------------- */
/* Additions for hosted settings                                               */
/* -------------------------------------------------------------------------- */

/**
 * The organization's memory pipeline configuration shown on the Ops view.
 * Structurally equal to `MemoryConfigSnapshot` in `@canopy/memory-engine`,
 * which protocol cannot depend on.
 */
export interface ExplorerMemoryConfigSnapshot {
  embedderId: string;
  rerankerId: string;
  tauRerank: number | null;
  tauCosine: number | null;
  rerankSkipCosineMargin?: number | null;
  tauCosineOutage?: number | null;
  efSearch: number;
  triageModel: string;
  distillModel: string;
  judgeModel: string;
}

/** One page of `GET .../memory-explorer/facts`. Search results carry ranks. */
export interface ExplorerFactPage {
  facts: Array<ExplorerFact | ExplorerRankedFact>;
  nextCursor: string | null;
}

/** `GET .../memory-explorer/facts/batch?ids=` body. */
export interface ExplorerFactDetailBatch {
  facts: ExplorerFactDetail[];
}

/** One page of `GET .../memory-explorer/jobs`. */
export interface ExplorerIngestJobPage {
  jobs: ExplorerIngestJob[];
  counts: Record<ExplorerIngestJobStatus, number>;
  nextCursor: string | null;
}

/** One page of `GET .../memory-explorer/search-log`. */
export interface ExplorerSearchLogPage {
  entries: ExplorerSearchLogEntry[];
  nextCursor: string | null;
}

export const EXPLORER_EVIDENCE_TYPES = [
  'OBSERVED',
  'ASSERTED',
  'INFERRED',
] as const;

export const EXPLORER_INGEST_JOB_STATUSES = [
  'PENDING',
  'RUNNING',
  'DONE',
  'FAILED',
  'DEAD',
] as const;

/** Liveness filter values the facts and graph routes accept. */
export const EXPLORER_LIVENESS_FILTERS = ['live', 'superseded', 'all'] as const;

/* Structural checks mirroring `components/memory-explorer/api.ts`. */

const entityTypeSchema = z.enum(['SERVICE', 'CODE', 'TOOL']);

const explorerEntityShape = z.looseObject({
  id: z.string(),
  canonicalName: z.string(),
  entityType: entityTypeSchema,
});

export const explorerFactShape = z.looseObject({
  id: z.string(),
  factText: z.string(),
  evidenceType: z.enum(EXPLORER_EVIDENCE_TYPES),
  evidenceQuote: z.string().nullable(),
  validAt: z.string().nullable(),
  invalidAt: z.string().nullable(),
  createdAt: z.string(),
  expiredAt: z.string().nullable(),
  invalidatedById: z.string().nullable(),
  liveness: z.enum(['live', 'superseded']),
  entities: z.array(explorerEntityShape),
});

const explorerFactSourceShape = z.looseObject({
  id: z.string(),
  transcriptTurnId: z.string().nullable(),
  referenceTime: z.string(),
  actor: z
    .looseObject({
      id: z.string(),
      name: z.string().nullable(),
      email: z.string(),
    })
    .nullable(),
});

export const explorerFactDetailShape = explorerFactShape.extend({
  sources: z.array(explorerFactSourceShape),
  supersessionChain: z.array(z.unknown()),
});

export const explorerFactPageShape = z.looseObject({
  facts: z.array(explorerFactShape),
  nextCursor: z.string().nullable(),
});

export const explorerFactPageSchema = settingsDtoSchema<ExplorerFactPage>(
  explorerFactPageShape,
);

export const explorerFactDetailSchema = settingsDtoSchema<ExplorerFactDetail>(
  explorerFactDetailShape,
);

export const explorerFactDetailBatchSchema =
  settingsDtoSchema<ExplorerFactDetailBatch>(
    z.looseObject({ facts: z.array(explorerFactDetailShape) }),
  );

export const explorerSourceTranscriptShape = z.looseObject({
  restricted: z.boolean(),
  evidenceQuote: z.string().nullable(),
  source: explorerFactSourceShape,
  messages: z.array(
    z.looseObject({
      localChatId: z.string(),
      localMessageId: z.string(),
      role: z.string(),
      content: z.string(),
      occurredAt: z.string(),
    }),
  ),
});

export const explorerSourceTranscriptSchema =
  settingsDtoSchema<ExplorerSourceTranscript>(explorerSourceTranscriptShape);

const factIdsSchema = z.array(z.string());

export const explorerEntityGraphShape = z.looseObject({
  nodes: z.array(
    z.looseObject({
      id: z.string(),
      canonicalName: z.string(),
      entityType: entityTypeSchema,
      factCount: z.number(),
      factIds: factIdsSchema,
    }),
  ),
  edges: z.array(
    z.looseObject({
      source: z.string(),
      target: z.string(),
      weight: z.number(),
      factIds: factIdsSchema,
    }),
  ),
  truncated: z.boolean(),
});

export const explorerEntityGraphSchema = settingsDtoSchema<ExplorerEntityGraph>(
  explorerEntityGraphShape,
);

const explorerIngestJobShape = z.looseObject({
  id: z.string(),
  status: z.enum(EXPLORER_INGEST_JOB_STATUSES),
  attempts: z.number(),
  heartbeatStale: z.boolean(),
  lastError: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const explorerIngestJobPageShape = z.looseObject({
  jobs: z.array(explorerIngestJobShape),
  counts: z.record(z.string(), z.number()),
  nextCursor: z.string().nullable(),
});

export const explorerIngestJobPageSchema =
  settingsDtoSchema<ExplorerIngestJobPage>(explorerIngestJobPageShape);

const explorerSearchLogEntryShape = z.looseObject({
  id: z.string(),
  query: z.string().nullable(),
  queryDecryptFailed: z.boolean(),
  injectedFacts: z.array(
    z.looseObject({ id: z.string(), factText: z.string() }),
  ),
  gatePassed: z.boolean(),
  truncated: z.boolean(),
  latencyMs: z.number(),
  createdAt: z.string(),
  user: z.looseObject({
    id: z.string(),
    name: z.string().nullable(),
    email: z.string(),
  }),
});

export const explorerSearchLogPageShape = z.looseObject({
  entries: z.array(explorerSearchLogEntryShape),
  nextCursor: z.string().nullable(),
});

export const explorerSearchLogPageSchema =
  settingsDtoSchema<ExplorerSearchLogPage>(explorerSearchLogPageShape);

export const explorerMemoryConfigSnapshotShape = z.looseObject({
  embedderId: z.string(),
  rerankerId: z.string(),
  tauRerank: z.number().nullable(),
  tauCosine: z.number().nullable(),
  efSearch: z.number(),
  triageModel: z.string(),
  distillModel: z.string(),
  judgeModel: z.string(),
});

export const explorerMemoryConfigSnapshotSchema =
  settingsDtoSchema<ExplorerMemoryConfigSnapshot>(
    explorerMemoryConfigSnapshotShape,
  );

const numberArray = z.array(z.number());

export const explorerRetrievalPreviewShape = z.looseObject({
  gatePassed: z.boolean(),
  candidateCount: z.number(),
  facts: z.array(explorerFactShape),
  candidates: z.array(
    z.looseObject({
      factId: z.string(),
      score: z.number(),
      entityIds: z.array(z.string()),
    }),
  ),
  renderedBlock: z.string().nullable(),
  truncated: z.boolean(),
  diagnostics: z.looseObject({
    laneCounts: z.looseObject({
      vector: z.number(),
      fts: z.number(),
      trigram: z.number(),
      graph: z.number(),
    }),
    rerankUsed: z.boolean(),
    topRerankScore: z.number().nullable(),
    topCosineScore: z.number().nullable(),
    latencyMs: z.number(),
    topScores: z.looseObject({
      rerank: numberArray,
      cosine: numberArray,
      rrf: numberArray,
    }),
  }),
});

export const explorerRetrievalPreviewSchema =
  settingsDtoSchema<ExplorerRetrievalPreview>(explorerRetrievalPreviewShape);
