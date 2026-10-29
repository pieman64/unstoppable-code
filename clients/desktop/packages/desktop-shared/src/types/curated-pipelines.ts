import type {
  CuratedPipelineListQuery,
  CuratedPipelineListResponse,
} from '@canopy/protocol/pipeline-catalog';

export interface ListCuratedPipelinesRequest extends CuratedPipelineListQuery {
  forceRefresh?: boolean;
}
export interface ListCuratedPipelinesResult extends CuratedPipelineListResponse {
  stale: boolean;
}
export interface ImportCuratedPipelineRequest {
  key: string;
  expectedContentHash: string;
}
