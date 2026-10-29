import type {
  CodeGraphQueryRequest,
  CodeGraphSearchRequest,
  CodeGraphExplainRequest,
  CodeGraphImpactRequest,
  DetectChangedSymbolsRequest,
  CompareChangeImpactRequest,
  GetReviewContextRequest,
} from './code-graph-tools';

/** Explicit worktree scope; Advisor entries themselves do not own code graphs. */
export type AppAdvisorCodeGraphAction = {
  projectId: string;
  worktreeId: string;
} & (
  | { type: 'code-graph.get_context' }
  | { type: 'code-graph.build' }
  | ({ type: 'code-graph.query' } & CodeGraphQueryRequest)
  | ({ type: 'code-graph.search' } & CodeGraphSearchRequest)
  | ({ type: 'code-graph.explain' } & CodeGraphExplainRequest)
  | ({ type: 'code-graph.impact' } & CodeGraphImpactRequest)
  | ({ type: 'code-graph.detect_changes' } & DetectChangedSymbolsRequest)
  | ({ type: 'code-graph.compare_changes' } & CompareChangeImpactRequest)
  | ({ type: 'code-graph.review' } & GetReviewContextRequest)
);
