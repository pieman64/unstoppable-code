import type {
  CuratedAutomationListQuery,
  CuratedAutomationListResponse,
} from '@canopy/protocol/automation-catalog';

export interface ListCuratedAutomationsRequest extends CuratedAutomationListQuery {
  forceRefresh?: boolean;
}

export interface ListCuratedAutomationsResult extends CuratedAutomationListResponse {
  stale: boolean;
}
