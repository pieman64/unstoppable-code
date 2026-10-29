import { getPortalChatToolFamily } from '@canopy/desktop-shared/lib/portal-tool-family';
import { getToolFamilyFromName } from '@canopy/ui-shared/components/chat/tool-display';

/**
 * The portal protocol stamps `toolFamily` on `tool_use` parts via
 * `getPortalChatToolFamily` (main process), while the desktop renderer and
 * the web message-renderer fall back to `getToolFamilyFromName`. The web
 * renderer PREFERS the stamped family, so the two functions must agree on
 * every tool name or Portal chat renders different icons/labels than the
 * desktop transcript for the same call.
 */
describe('portal/desktop tool-family parity', () => {
  const REPRESENTATIVE_TOOL_NAMES = [
    // Core SDK tools
    'Read',
    'ReadLines',
    'Write',
    'Edit',
    'Bash',
    'PowerShell',
    'Grep',
    'Glob',
    'ToolSearch',
    'WebFetch',
    'WebSearch',
    'web_search',
    'TodoWrite',
    'TaskCreate',
    'TaskUpdate',
    'TaskList',
    'TaskGet',
    'TaskStop',
    'TaskOutput',
    'Task',
    'Agent',
    'Workflow',
    'ScheduleWakeup',
    'Monitor',
    'Skill',
    'ClaudeModelChange',
    'ListMcpResourcesTool',
    // Computer Use REPL MCP tools
    'mcp__cua_repl__js',
    'mcp__cua_repl__js_reset',
    // Plan-mode control tools (CAN-3019)
    'EnterPlanMode',
    'ExitPlanMode',
    // Codex item aliases
    'command',
    'file_change',
    'apply_patch',
    // Canopy-injected tools (Claude MCP + Codex dynamic names)
    'mcp__canopy__AskUserQuestion',
    'canopy_ask_user_question',
    'mcp__canopy__GetScriptOutput',
    'canopy_get_script_output',
    'mcp__canopy__SearchActions',
    'canopy_search_actions',
    'mcp__canopy__DispatchAction',
    'canopy_dispatch_action',
    'mcp__canopy__GetGitHubPullRequestStatus',
    'canopy_get_github_pull_request_status',
    'mcp__canopy_app_advisor__GetGitHubPullRequestStatus',
    'canopy_app_advisor_get_github_pull_request_status',
    'mcp__canopy__ManageDelegate',
    'canopy_manage_delegate',
    'mcp__canopy__GetGitPreferences',
    'canopy_get_git_preferences',
    'mcp__canopy__SaveMemory',
    'canopy_save_memory',
    'mcp__canopy__SearchMemory',
    'canopy_search_memory',
    'mcp__canopy__ReadMemory',
    'canopy_read_memory',
    'mcp__canopy__ReadPipelineYaml',
    'canopy_read_pipeline_yaml',
    'mcp__canopy__ShowFiles',
    'canopy_show_files',
    'mcp__canopy__ShowVisual',
    'canopy_show_visual',
    'mcp__canopy__PreviewVisual',
    'canopy_preview_visual',
    'mcp__canopy__GetFileComments',
    'canopy_get_file_comments',
    'mcp__canopy__RespondToFileComment',
    'canopy_respond_to_file_comment',
    'mcp__canopy__SearchWatchers',
    'canopy_search_watchers',
    'mcp__canopy__SetupWatchers',
    'canopy_setup_watchers',
    'mcp__canopy__WatchCommand',
    'canopy_watch_command',
    'mcp__canopy__ScheduleWakeup',
    'canopy_schedule_wakeup',
    'mcp__canopy_app_advisor__ScheduleWakeup',
    'canopy_app_advisor_schedule_wakeup',
    'mcp__canopy_app_advisor__StartForkedAgent',
    'canopy_app_advisor_start_forked_agent',
    // App Advisor
    'mcp__canopy_app_advisor__AskUserQuestion',
    'app_advisor_ask_user_question',
    'mcp__canopy_app_advisor__GetScriptOutput',
    'app_advisor_get_script_output',
    'mcp__canopy_app_advisor__SearchActions',
    'app_advisor_search_actions',
    'mcp__canopy_app_advisor__GetCurrentUiState',
    'app_advisor_get_current_ui_state',
    'mcp__canopy_app_advisor__DispatchAction',
    'app_advisor_dispatch_action',
    'mcp__canopy_app_advisor__ReadPipelineYaml',
    'app_advisor_read_pipeline_yaml',
    'mcp__canopy_app_advisor__ShowFiles',
    'app_advisor_show_files',
    'mcp__canopy_app_advisor__GetFileComments',
    'app_advisor_get_file_comments',
    'mcp__canopy_app_advisor__RespondToFileComment',
    'app_advisor_respond_to_file_comment',
    'mcp__canopy_app_advisor__GetPipelineDebugContext',
    'app_advisor_get_pipeline_debug_context',
    'mcp__canopy_app_advisor__SearchWatchers',
    'app_advisor_search_watchers',
    'mcp__canopy_app_advisor__SetupWatchers',
    'app_advisor_setup_watchers',
    // Plan comment tools
    'mcp__canopy__RespondToComment',
    'canopy_get_plan_comments',
    // Code-graph tools
    'mcp__canopy__GetCodeGraphContext',
    'canopy_get_code_graph_context',
    'mcp__canopy__BuildOrUpdateCodeGraph',
    'canopy_build_or_update_code_graph',
    'mcp__canopy__QueryCodeGraph',
    'canopy_query_code_graph',
    'mcp__canopy__SearchCodeGraph',
    'canopy_search_code_graph',
    'mcp__canopy__ExplainCodeSymbol',
    'canopy_explain_code_symbol',
    'mcp__canopy__GetImpactRadius',
    'canopy_get_impact_radius',
    'mcp__canopy__DetectChangedSymbols',
    'canopy_detect_changed_symbols',
    'mcp__canopy__CompareChangeImpact',
    'canopy_compare_change_impact',
    'mcp__canopy__GetReviewContext',
    'canopy_get_review_context',
    // Ledger tools
    'mcp__canopy__AddFeedEntry',
    'canopy_add_feed_entry',
    'mcp__canopy__SearchFeedEntries',
    'canopy_search_feed_entries',
    'mcp__canopy__UpdateFeedEntry',
    'canopy_update_feed_entry',
    // Ledger tools under the Cursor CLI titles and the App Advisor names
    'canopy: AddFeedEntry',
    'canopy: SearchFeedEntries',
    'canopy: UpdateFeedEntry',
    'mcp__canopy_app_advisor__AddFeedEntry',
    'canopy_app_advisor_add_feed_entry',
    'mcp__canopy_app_advisor__SearchFeedEntries',
    'canopy_app_advisor_search_feed_entries',
    'mcp__canopy_app_advisor__UpdateFeedEntry',
    'canopy_app_advisor_update_feed_entry',
    // A plugin server's tool with a Ledger tool's name is not the app's
    'linear: AddFeedEntry',
    // Generic third-party MCP tools — must NOT be claimed by any family
    'mcp__github__create_issue',
    'mcp__linear__list_issues',
    'mcp__slack__send_message',
    // Unrecognized free-form name
    'SomeUnknownTool',
  ];

  it.each(REPRESENTATIVE_TOOL_NAMES)(
    'stamps the same family the renderer derives for %s',
    (toolName) => {
      expect(getPortalChatToolFamily(toolName)).toBe(
        getToolFamilyFromName(toolName),
      );
    },
  );
});

/**
 * CAN-3019: `ExitPlanMode` resolved to `unknown`, so Canopy's deliberate denial
 * of the tool rendered in the web transcript as a nondescript failed tool call.
 * Both plan-mode names must resolve to `plan` in both maps.
 */
describe('plan-mode tool family', () => {
  it.each(['EnterPlanMode', 'ExitPlanMode'])('maps %s to plan', (name) => {
    expect(getToolFamilyFromName(name)).toBe('plan');
    expect(getPortalChatToolFamily(name)).toBe('plan');
  });
});
