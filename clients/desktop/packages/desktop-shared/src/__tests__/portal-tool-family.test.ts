import { getPortalChatToolFamily } from '../lib/portal-tool-family';

/**
 * The portal family stamp must mirror the desktop renderer's family
 * dispatch (`NAME_TO_FAMILY` / `getToolFamilyFromName` in
 * `@canopy/ui-shared` tool-display.tsx) element-for-element — the web
 * message renderer prefers the transport-stamped family over local
 * derivation, so any divergence here is directly user-visible in Portal
 * chat. A cross-package parity test lives in
 * `apps/desktop-app/src/renderer/src/components/chat/__tests__/tool-family-parity.test.ts`.
 */
describe('getPortalChatToolFamily', () => {
  it('maps both cua_repl tools to computer-use without claiming other servers', () => {
    expect(getPortalChatToolFamily('mcp__cua_repl__js')).toBe('computer-use');
    expect(getPortalChatToolFamily('mcp__cua_repl__js_reset')).toBe(
      'computer-use',
    );
    expect(getPortalChatToolFamily('mcp__other_server__js')).toBe('unknown');
  });

  it('maps ScheduleWakeup into the monitor family like the desktop renderer', () => {
    expect(getPortalChatToolFamily('ScheduleWakeup')).toBe('monitor');
  });

  it.each(['CronCreate', 'CronDelete', 'CronList'])(
    "maps Claude's %s into the monitor family like the desktop renderer",
    (name) => {
      expect(getPortalChatToolFamily(name)).toBe('monitor');
    },
  );

  it.each([
    'mcp__canopy_app_advisor__WatchCommand',
    'canopy_app_advisor_watch_command',
  ])('maps App Advisor WatchCommand %s into the watcher family', (name) => {
    expect(getPortalChatToolFamily(name)).toBe('watcher');
  });

  it('maps the Skill tool into the skill family', () => {
    expect(getPortalChatToolFamily('Skill')).toBe('skill');
  });

  it('maps ClaudeModelChange into the claude family', () => {
    expect(getPortalChatToolFamily('ClaudeModelChange')).toBe('claude');
  });

  it('maps generic MCP tools to unknown rather than skill', () => {
    expect(getPortalChatToolFamily('mcp__github__create_issue')).toBe(
      'unknown',
    );
    expect(getPortalChatToolFamily('mcp__linear__list_issues')).toBe('unknown');
  });

  it('maps the Windows PowerShell tool into the bash family', () => {
    expect(getPortalChatToolFamily('PowerShell')).toBe(
      getPortalChatToolFamily('Bash'),
    );
    expect(getPortalChatToolFamily('PowerShell')).toBe('bash');
  });

  it('maps ToolSearch into the glob family', () => {
    expect(getPortalChatToolFamily('ToolSearch')).toBe('glob');
  });

  it('maps Workflow and TaskOutput into the agent family', () => {
    expect(getPortalChatToolFamily('Workflow')).toBe('agent');
    expect(getPortalChatToolFamily('TaskOutput')).toBe('agent');
  });

  it('maps ManageDelegate names into the app family with the other delegation tools', () => {
    expect(getPortalChatToolFamily('mcp__canopy__ManageDelegate')).toBe(
      'canopy',
    );
    expect(getPortalChatToolFamily('canopy_manage_delegate')).toBe('canopy');
  });

  it('maps ReadLines into the read family', () => {
    expect(getPortalChatToolFamily('ReadLines')).toBe('read');
  });

  it('keeps ListMcpResourcesTool in the unknown family', () => {
    expect(getPortalChatToolFamily('ListMcpResourcesTool')).toBe('unknown');
  });

  it('maps the six code-graph tools into the graph family', () => {
    expect(getPortalChatToolFamily('GetCodeGraphContext')).toBe('graph');
    expect(getPortalChatToolFamily('mcp__canopy__GetCodeGraphContext')).toBe(
      'graph',
    );
    expect(getPortalChatToolFamily('canopy_get_code_graph_context')).toBe(
      'graph',
    );
    expect(getPortalChatToolFamily('BuildOrUpdateCodeGraph')).toBe('graph');
    expect(getPortalChatToolFamily('canopy_build_or_update_code_graph')).toBe(
      'graph',
    );
    expect(getPortalChatToolFamily('QueryCodeGraph')).toBe('graph');
    expect(getPortalChatToolFamily('canopy_query_code_graph')).toBe('graph');
    expect(getPortalChatToolFamily('SearchCodeGraph')).toBe('graph');
    expect(getPortalChatToolFamily('canopy_search_code_graph')).toBe('graph');
    expect(getPortalChatToolFamily('ExplainCodeSymbol')).toBe('graph');
    expect(getPortalChatToolFamily('canopy_explain_code_symbol')).toBe('graph');
    expect(getPortalChatToolFamily('GetImpactRadius')).toBe('graph');
    expect(getPortalChatToolFamily('canopy_get_impact_radius')).toBe('graph');
  });

  it('maps the three change-impact tools into the graph family', () => {
    expect(getPortalChatToolFamily('DetectChangedSymbols')).toBe('graph');
    expect(getPortalChatToolFamily('mcp__canopy__DetectChangedSymbols')).toBe(
      'graph',
    );
    expect(getPortalChatToolFamily('canopy_detect_changed_symbols')).toBe(
      'graph',
    );
    expect(getPortalChatToolFamily('CompareChangeImpact')).toBe('graph');
    expect(getPortalChatToolFamily('mcp__canopy__CompareChangeImpact')).toBe(
      'graph',
    );
    expect(getPortalChatToolFamily('canopy_compare_change_impact')).toBe(
      'graph',
    );
    expect(getPortalChatToolFamily('GetReviewContext')).toBe('graph');
    expect(getPortalChatToolFamily('mcp__canopy__GetReviewContext')).toBe(
      'graph',
    );
    expect(getPortalChatToolFamily('canopy_get_review_context')).toBe('graph');
  });

  it('maps the deferred-tools SearchDeferredTools / LoadDeferredTools into the canopy family', () => {
    expect(getPortalChatToolFamily('SearchDeferredTools')).toBe('canopy');
    expect(getPortalChatToolFamily('mcp__canopy__SearchDeferredTools')).toBe(
      'canopy',
    );
    expect(getPortalChatToolFamily('canopy_search_deferred_tools')).toBe(
      'canopy',
    );
    expect(getPortalChatToolFamily('LoadDeferredTools')).toBe('canopy');
    expect(getPortalChatToolFamily('mcp__canopy__LoadDeferredTools')).toBe(
      'canopy',
    );
    expect(getPortalChatToolFamily('canopy_load_deferred_tools')).toBe(
      'canopy',
    );
  });

  it('maps the Codex ImmediateTurnRestart control tool into the canopy family', () => {
    expect(getPortalChatToolFamily('canopy_immediate_turn_restart')).toBe(
      'canopy',
    );
    expect(getPortalChatToolFamily('somebrand_immediate_turn_restart')).toBe(
      'unknown',
    );
    expect(
      getPortalChatToolFamily('mcp__attacker__fake_immediate_turn_restart'),
    ).toBe('unknown');
  });

  it('maps save, search, and read memory aliases into the canopy family', () => {
    for (const toolName of [
      'SaveMemory',
      'mcp__canopy__SaveMemory',
      'canopy_save_memory',
      'SearchMemory',
      'mcp__canopy__SearchMemory',
      'canopy_search_memory',
      'mcp__somebrand__SaveMemory',
      'somebrand_search_memory',
      'ReadMemory',
      'mcp__canopy__ReadMemory',
      'canopy_read_memory',
      'mcp__somebrand__ReadMemory',
      'somebrand_read_memory',
    ]) {
      expect(getPortalChatToolFamily(toolName)).toBe('canopy');
    }
  });

  it('maps add, search, and update ledger entry aliases into the canopy family', () => {
    for (const toolName of [
      'AddFeedEntry',
      'mcp__canopy__AddFeedEntry',
      'canopy_add_feed_entry',
      'SearchFeedEntries',
      'mcp__canopy__SearchFeedEntries',
      'canopy_search_feed_entries',
      'mcp__somebrand__AddFeedEntry',
      'somebrand_search_feed_entries',
      'UpdateFeedEntry',
      'mcp__canopy__UpdateFeedEntry',
      'canopy_update_feed_entry',
      'mcp__somebrand__UpdateFeedEntry',
      'somebrand_update_feed_entry',
    ]) {
      expect(getPortalChatToolFamily(toolName)).toBe('canopy');
    }
  });

  it('maps the Cursor titles and App Advisor names of the Ledger tools into the canopy family', () => {
    for (const toolName of [
      // Cursor persists the CLI title of the call on the app's MCP server.
      'canopy: AddFeedEntry',
      'canopy: SearchFeedEntries',
      'canopy: UpdateFeedEntry',
      // App Advisor advertises the Ledger tools under its own names.
      'mcp__canopy_app_advisor__AddFeedEntry',
      'canopy_app_advisor_add_feed_entry',
      'mcp__canopy_app_advisor__SearchFeedEntries',
      'canopy_app_advisor_search_feed_entries',
      'mcp__canopy_app_advisor__UpdateFeedEntry',
      'canopy_app_advisor_update_feed_entry',
      'mcp__somebrand_app_advisor__SearchFeedEntries',
      'somebrand_app_advisor_add_feed_entry',
    ]) {
      expect(getPortalChatToolFamily(toolName)).toBe('canopy');
    }
    // A plugin server's tool with a Ledger tool's name is not the app's.
    expect(getPortalChatToolFamily('linear: AddFeedEntry')).toBe('unknown');
    // App Advisor's own tools keep their family.
    expect(getPortalChatToolFamily('mcp__canopy_app_advisor__ShowFiles')).toBe(
      'app-advisor',
    );
  });

  it('maps the App Advisor and Pipeline Editor deferred-tools siblings to their families', () => {
    expect(
      getPortalChatToolFamily('mcp__canopy_app_advisor__LoadDeferredTools'),
    ).toBe('app-advisor');
    expect(
      getPortalChatToolFamily('canopy_app_advisor_search_deferred_tools'),
    ).toBe('app-advisor');
    expect(
      getPortalChatToolFamily(
        'mcp__canopy_pipeline_editor__SearchDeferredTools',
      ),
    ).toBe('pipeline-editor');
    expect(
      getPortalChatToolFamily('canopy_pipeline_editor_load_deferred_tools'),
    ).toBe('pipeline-editor');
  });

  it('keeps the retired plan comment tools in the plan family for old transcripts', () => {
    for (const name of [
      'mcp__canopy__GetPlanComments',
      'GetPlanComments',
      'canopy_get_plan_comments',
      'mcp__canopy__RespondToComment',
      'canopy_respond_to_comment',
    ]) {
      expect(getPortalChatToolFamily(name)).toBe('plan');
    }
  });

  it('maps ShowFiles names to the owning app tool family', () => {
    expect(getPortalChatToolFamily('mcp__canopy__ShowFiles')).toBe('canopy');
    expect(getPortalChatToolFamily('canopy_show_files')).toBe('canopy');
    expect(getPortalChatToolFamily('mcp__canopy_app_advisor__ShowFiles')).toBe(
      'app-advisor',
    );
    expect(getPortalChatToolFamily('app_advisor_show_files')).toBe(
      'app-advisor',
    );
    expect(getPortalChatToolFamily('canopy_get_file_comments')).toBe('canopy');
    expect(getPortalChatToolFamily('canopy_respond_to_file_comment')).toBe(
      'canopy',
    );
    expect(getPortalChatToolFamily('app_advisor_get_file_comments')).toBe(
      'app-advisor',
    );
  });
});

describe('project/bot payloads keep wrapper buckets', () => {
  it.each([
    'projects.list',
    'projects.list_tasks',
    'projects.list_task_chats',
    'projects.get_last_user_message',
    'projects.get_last_agent_response',
    'projects.read_history',
    'projects.send_message',
    'projects.create_task',
    'projects.create_task_chat',
    'bots.list',
    'bots.list_tasks',
    'bots.list_task_chats',
    'bots.get_last_user_message',
    'bots.get_last_agent_response',
    'bots.read_history',
    'bots.send_message',
    'bots.create_task',
    'bots.create_task_chat',
    'projects.steer_queued_message',
    'projects.schedule_message',
    'worktree-chat.send_message',
    'standalone-chat.read_history',
    'advisor-chat.create_entry',
  ])('keeps action %s in ordinary and Advisor buckets', (type) => {
    const input = JSON.stringify({ action: { type } });
    const parts = [
      {
        toolName: 'canopy_search_actions',
        input: JSON.stringify({ actionType: type }),
        family: 'canopy',
      },
      {
        toolName: 'app_advisor_search_actions',
        input: JSON.stringify({ actionType: type }),
        family: 'app-advisor',
      },
      { toolName: 'canopy_dispatch_action', input, family: 'canopy' },
      { toolName: 'app_advisor_dispatch_action', input, family: 'app-advisor' },
    ];
    // Portal stamps the family from the wrapper, without interpreting input.
    for (const part of parts)
      expect(getPortalChatToolFamily(part.toolName)).toBe(part.family);
  });

  it.each([
    'project_task_chat_completion',
    'project_new_chat_started',
    'bot_task_chat_completion',
    'bot_new_chat_started',
    'worktree_chat_completion',
    'worktree_new_chat_started',
    'standalone_chat_completion',
    'standalone_new_chat_started',
  ])('keeps chat trigger %s in the watcher bucket', (trigger) => {
    const parts = [
      'canopy_search_watchers',
      'canopy_setup_watchers',
      'app_advisor_search_watchers',
      'app_advisor_setup_watchers',
    ].map((toolName) => ({
      toolName,
      input: JSON.stringify({ trigger, watchers: [{ trigger, target: {} }] }),
    }));
    for (const part of parts)
      expect(getPortalChatToolFamily(part.toolName)).toBe('watcher');
  });
});
