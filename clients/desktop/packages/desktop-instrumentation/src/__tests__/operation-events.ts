import type { DesktopOperationName } from '../operations';

/**
 * The allowlist, spelled out independently of `DESKTOP_OPERATIONS` so a
 * registry edit cannot silently change what reaches PostHog.
 */
export const EXPECTED_OPERATION_EVENTS: ReadonlyArray<
  readonly [DesktopOperationName, string | null]
> = [
  ['canopy.first_run_import_view', 'onboarding:first_run_import_view'],
  ['canopy.first_run_import', 'onboarding:first_run_import_end'],
  ['canopy.project_import', 'projects:import_end'],
  ['canopy.invite_send', 'sharing:invite_send'],
  ['canopy.invite_accept', 'sharing:invite_accept'],
  ['canopy.organization_create', 'organization:create'],
  ['canopy.remote_pairing_start', 'remote:pairing_start'],
  ['canopy.remote_pairing', 'remote:pairing_end'],

  ['canopy.git_commit', 'git:commit_create'],
  ['canopy.pull_request_open', 'git:pull_request_open'],
  ['canopy.pull_request_merge', 'git:pull_request_merge'],
  ['canopy.share_dialog', 'sharing:dialog_open'],
  ['canopy.model_recovery', 'billing:model_recovery_view'],
  ['canopy.model_access', 'billing:model_access_update'],
  ['canopy.daily_credit_grant', 'billing:daily_credit_grant_update'],
  ['canopy.credits_recovery', 'billing:credits_recovery_view'],
  ['canopy.credits_recovery_action', 'billing:credits_recovery_click'],
  ['canopy.chat_turn', 'chat:turn_end'],
  ['canopy.chat_message_send', 'chat:message_send'],
  ['canopy.portal_chat_visual_read', 'chat:visual_view'],
  ['canopy.agent_task', 'agent:task_end'],
  ['canopy.pipeline_execution', 'pipeline:run_end'],
  ['canopy.pipeline_crud', 'pipeline:definition_update'],
  ['canopy.workspace_crud', 'workspace:project_update'],
  ['canopy.worktree_crud', 'workspace:worktree_update'],
  ['canopy.standalone_chat_project_crud', 'cowork:project_update'],
  ['canopy.standalone_chat_project_feature', 'cowork:project_feature_update'],
  ['canopy.onboarding_profile', 'onboarding:profile_update'],
  ['canopy.home_onboarding_suggestions', 'home:onboarding_suggestion_update'],
  ['canopy.activation_campaign', 'activation:campaign_update'],
  ['canopy.suggested_prompt', 'chat:suggested_prompt_update'],
  ['canopy.provider_account_connect', 'provider:account_connect'],
  ['canopy.provider_account_connect_fail', 'provider:account_connect_fail'],
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
