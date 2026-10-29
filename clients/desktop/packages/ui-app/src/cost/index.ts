/**
 * `@canopy/ui-app/cost`: the shared observed-cost views. Hosts pass a
 * `CostClient`, a `CostNavigator` and the scope; the views gate themselves
 * on the host's `costInsights` capability and never branch on the host.
 */
export {
  COST_UNAVAILABLE_COPY,
  CostUnavailableState,
  CostInsightsGate,
  useCostInsightsEnabled,
  type CostInsightsGateProps,
} from './CostInsightsGate';
export {
  CostViewFrame,
  costProblemMessage,
  costRefreshFailureReason,
  type CostViewFrameProps,
} from './CostViewFrame';
export { CostScopeView, type CostScopeViewProps } from './CostScopeView';
export {
  CostActivityPreview,
  type CostActivityPreviewProps,
} from './CostActivityPreview';
export {
  CostScopeRefreshAction,
  CostScopeTotalLabel,
} from './CostScopeHeaderParts';
export {
  costScopeHasContent,
  costScopeScaleMax,
  isSameCostRowTarget,
  sortCostChats,
  sortCostRuns,
  type CostScopeRowTarget,
  type CostScopeSort,
} from './cost-scope-model';
export {
  SessionBreakdownView,
  type SessionBreakdownTab,
  type SessionBreakdownViewProps,
} from './SessionBreakdownView';
export {
  PipelineRunCostView,
  type PipelineRunCostViewProps,
} from './PipelineRunCostView';
export {
  PipelineRunCostPreviewCard,
  type PipelineRunCostPreviewCardProps,
} from './PipelineRunCostPreviewCard';
export {
  RetainedCostView,
  defaultRetainedCostRow,
  type RetainedCostViewProps,
} from './RetainedCostView';
export {
  SubagentCostSection,
  type SubagentCostSectionProps,
} from './SubagentCostSection';
export {
  useCostChatSummaryStore,
  useCostScopeStore,
  useCostSubagentStore,
  useCostViewStore,
  usePipelineRunCostStore,
  useSessionBreakdownStore,
} from './use-cost-view-store';
