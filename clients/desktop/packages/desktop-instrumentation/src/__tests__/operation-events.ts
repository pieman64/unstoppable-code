import type { DesktopOperationName } from '../operations';

/**
 * The allowlist, spelled out independently of `DESKTOP_OPERATIONS` so a
 * registry edit cannot silently change what reaches PostHog.
 */
export const EXPECTED_OPERATION_EVENTS: ReadonlyArray<
  readonly [DesktopOperationName, string | null]
> = [
  ['canopy.share_dialog', 'sharing:dialog_open'],
  ['canopy.model_recovery', 'billing:model_recovery_view'],
  ['canopy.model_access', 'billing:model_access_update'],
  ['canopy.chat_turn', 'chat:turn_end'],
  ['canopy.portal_chat_visual_read', 'chat:visual_view'],
  ['canopy.agent_task', 'agent:task_end'],
  ['canopy.pipeline_execution', 'pipeline:run_end'],
  ['canopy.pipeline_crud', 'pipeline:definition_update'],
  ['canopy.workspace_crud', 'workspace:project_update'],
  ['canopy.worktree_crud', 'workspace:worktree_update'],
  ['canopy.standalone_chat_project_crud', 'cowork:project_update'],
  ['canopy.standalone_chat_project_feature', 'cowork:project_feature_update'],
  ['canopy.onboarding_profile', 'onboarding:profile_update'],
  ['canopy.activation_campaign', 'activation:campaign_update'],
  ['canopy.home_onboarding_suggestions', 'home:onboarding_suggestion_update'],
  ['canopy.suggested_prompt', 'chat:suggested_prompt_update'],
  ['canopy.provider_account_connect', 'provider:account_connect'],
  ['canopy.skill_suggestion', 'chat:skill_suggestion_update'],
  ['canopy.slow_action', null],
  ['canopy.ipc_action', null],
  ['canopy.managed_process', null],
  ['canopy.code_graph_generation', null],
  ['canopy.code_graph_refresh_metrics', null],
  ['canopy.code_graph_query_metrics', null],
  ['canopy.app_diagnostic', null],
  ['canopy.local_memory_citation_compliance', null],
];
export const PRODUCT_OPERATION_EVENTS: ReadonlyArray<
  readonly [DesktopOperationName, string]
> = EXPECTED_OPERATION_EVENTS.flatMap(([name, event]) =>
  event === null ? [] : [[name, event] as const],
);
