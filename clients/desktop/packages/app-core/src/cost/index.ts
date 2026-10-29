import type {
  CostChatRequest,
  CostChatView,
  CostPipelineRunRequest,
  CostRefreshReceipt,
  CostRefreshRequest,
  CostScopeRef,
  CostScopeRequest,
  CostScopeView,
  CostUpdatedEvent,
  CostViewResult,
  PipelineRunCostView,
} from '@canopy/protocol/cost-view';
import type { Unsubscribe } from '../events/domain-events';

/**
 * The seam the shared cost views depend on. Desktop implements it over IPC to
 * `core.cost.*`; the stores and components never see a transport. Every call
 * resolves, never rejects: failures arrive as {@link CostViewResult} errors so
 * a view can never mistake one for an entry with no cost.
 */
export interface CostClient {
  /** The entry's totals, chats and pipeline runs. */
  getScope(request: CostScopeRequest): Promise<CostViewResult<CostScopeView>>;
  /**
   * One chat: its full breakdown, only its row (`detail: 'summary'`), or one
   * subagent's or delegation's row (`subagentId`).
   */
  getChat(request: CostChatRequest): Promise<CostViewResult<CostChatView>>;
  getPipelineRun(
    request: CostPipelineRunRequest,
  ): Promise<CostViewResult<PipelineRunCostView>>;
  /** Asks the host to catch the scope up. A retained scope answers an error. */
  refresh(
    request: CostRefreshRequest,
  ): Promise<CostViewResult<CostRefreshReceipt>>;
  /**
   * Marks a scope as on screen, so the host refreshes it shortly after work
   * in it finishes. Call the result when the view leaves the screen.
   */
  watchScope(scope: CostScopeRef): Unsubscribe;
  /** Stored figures changed. Carries scope refs and a revision only. */
  subscribeUpdates(handler: (event: CostUpdatedEvent) => void): Unsubscribe;
}

/** The subagent or delegation a breakdown row opens. */
export interface CostSubagentTarget {
  readonly chatId: string;
  readonly subagentId: string;
  readonly kind: 'claude_task' | 'codex_agent' | 'delegation';
}

/**
 * Host navigation for the cost views. Opening never starts, resumes or
 * restores anything as a side effect. A host omits what it cannot open, and
 * the views render those rows without an action.
 */
export interface CostNavigator {
  /** Opens or focuses the chat's Session breakdown. */
  readonly openSessionBreakdown?: (scope: CostScopeRef, chatId: string) => void;
  /** Opens the run's pipeline details at its cost. */
  readonly openPipelineRun?: (scope: CostScopeRef, executionId: string) => void;
  /** Opens the subagent or delegate in the subagent chat panel. */
  readonly openSubagent?: (
    scope: CostScopeRef,
    target: CostSubagentTarget,
  ) => void;
  /** Reveals the chat, restoring it first when it is archived. */
  readonly openChat?: (scope: CostScopeRef, chatId: string) => void;
  /** Opens the entry's Cost panel. */
  readonly openCostPanel?: (scope: CostScopeRef) => void;
  /** Opens a pipeline job from a step row. */
  readonly openPipelineJob?: (
    scope: CostScopeRef,
    executionId: string,
    jobId: string,
  ) => void;
}
