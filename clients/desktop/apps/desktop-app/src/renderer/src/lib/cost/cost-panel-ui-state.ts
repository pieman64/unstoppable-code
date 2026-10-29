import type { AppAdvisorJson } from '@canopy/desktop-shared/types';
import type {
  CostScopeView,
  SessionBreakdownView,
} from '@canopy/protocol/cost-view';

/*
 * What an open cost panel tells App Advisor: its scope, which view it is,
 * the read status and counts. Chat names, figures and model names stay out;
 * the assistant reads cost through the panel, not through UI state.
 */

/** Current-UI-state key prefix for one open cost panel. */
export const COST_PANEL_UI_STATE_PREFIX = 'cost.panel.';

type CostReadStatus = 'idle' | 'loading' | 'ready' | 'problem';

export function costPanelUiStateKey(
  projectId: string,
  worktreeId: string,
): string {
  return `${COST_PANEL_UI_STATE_PREFIX}cost/${projectId}/${worktreeId}`;
}

export function sessionBreakdownUiStateKey(
  projectId: string,
  worktreeId: string,
  chatId: string,
): string {
  return `${COST_PANEL_UI_STATE_PREFIX}session-breakdown/${projectId}/${worktreeId}/${chatId}`;
}

export function costPanelUiState(
  projectId: string,
  worktreeId: string,
  status: CostReadStatus,
  value: CostScopeView | null,
): AppAdvisorJson {
  return {
    kind: 'cost',
    projectId,
    worktreeId,
    status,
    ...(value === null
      ? {}
      : {
          building: value.building,
          chatCount: value.chats.length,
          pipelineRunCount: value.pipelineRuns.length,
        }),
  };
}

export function sessionBreakdownUiState(
  projectId: string,
  worktreeId: string,
  chatId: string,
  status: CostReadStatus,
  value: SessionBreakdownView | null,
): AppAdvisorJson {
  return {
    kind: 'session-breakdown',
    projectId,
    worktreeId,
    chatId,
    status,
    ...(value === null ? {} : { archived: value.chat.state === 'archived' }),
  };
}
