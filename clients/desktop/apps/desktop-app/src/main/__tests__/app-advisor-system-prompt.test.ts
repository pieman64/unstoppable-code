import { APP_ADVISOR_SYSTEM_PROMPT } from '../app-advisor/system-prompt';
import { APP_ADVISOR_TOOL_REGISTRY } from '@canopy/desktop-shared/lib/app-advisor-tools';
import { CANOPY_INJECTED_TOOL_REGISTRY } from '@canopy/desktop-shared/lib/canopy-injected-tools';
import { BRAND } from '@canopy/brand/current';

describe('APP_ADVISOR_SYSTEM_PROMPT', () => {
  it('guides multi-repo mutations through name, local path, and repository ID', () => {
    const line = APP_ADVISOR_SYSTEM_PROMPT.split('\n').find((entry) =>
      entry.startsWith(' - For multi-repo projects,'),
    );
    expect(line).toContain('workspace.create_multi_repo');
    expect(line).toContain('workspace.add_repo');
    expect(line).toContain('absolute local path');
    expect(line).toContain('workspace.remove_repo');
    expect(line).toContain('repository ID from workspace.list');
    expect(line).toContain('organization repository restrictions');
  });
  it('names Customize in skill and automation navigation while retaining action ids', () => {
    expect(APP_ADVISOR_SYSTEM_PROMPT).toContain(
      'skills.open_viewer to show a specific skill or supporting file on its Customize detail page',
    );
    expect(APP_ADVISOR_SYSTEM_PROMPT).toContain(
      'page "automations" with tab "shared" opens Customize → Automations filtered to Shared by me',
    );
  });
  it('steers one-off pull request status to the cached read and waits to watchers', () => {
    const names = APP_ADVISOR_TOOL_REGISTRY;
    const line = APP_ADVISOR_SYSTEM_PROMPT.split('\n').find((entry) =>
      entry.startsWith('- For a one-off pull request status check'),
    );
    expect(line).toContain(
      `GetGitHubPullRequestStatus / ${names.get_github_pull_request_status.codexToolName}`,
    );
    expect(line).toContain('use WatchGitHubItems instead of calling it');
    expect(line).toContain('gh pr checks --watch');
    expect(line).toContain('repeated gh pr view or gh api loops');
    expect(APP_ADVISOR_SYSTEM_PROMPT).toContain(
      names.get_github_pull_request_status.claudeToolName,
    );
  });
  it('uses current page availability and obtains authoritative refusals for explicit requests', () => {
    expect(APP_ADVISOR_SYSTEM_PROMPT).toContain('availablePages');
    expect(APP_ADVISOR_SYSTEM_PROMPT).toContain(
      'Do not proactively describe unavailable pages',
    );
    expect(APP_ADVISOR_SYSTEM_PROMPT).toContain('surface_unavailable');
    expect(APP_ADVISOR_SYSTEM_PROMPT).toContain(
      'only when the refusal reason is experiment',
    );
  });
  it('defaults standalone scheduled work to Automations with both App Advisor tool namespaces', (): void => {
    const lines = APP_ADVISOR_SYSTEM_PROMPT.split('\n');
    const paragraphs = lines.filter((line) =>
      line.startsWith('- When the user asks to create scheduled work'),
    );
    expect(paragraphs).toHaveLength(1);
    const paragraph = paragraphs[0] ?? '';
    const names = APP_ADVISOR_TOOL_REGISTRY;
    const expectedPolicy = [
      'When the user asks to create scheduled work',
      '"create a scheduled task", "every morning at 9", "remind me tomorrow", or "run this weekly"',
      `default to a ${BRAND.displayName} automation through ${names.dispatch_action.claudeToolName} / ${names.dispatch_action.codexToolName} with automation.create`,
      `Use ${names.search_actions.claudeToolName} / ${names.search_actions.codexToolName} with actionType: "automation.create" for the exact payload`,
      'Set input.schedule to { kind: "cron", expression, timezone: "local" } for recurrence or { kind: "one_time", runAt, timezone: "local" } for a single future run; runAt is an ISO timestamp',
      'Choose the action variant for the requested work and destination',
      // CAN-4551 7c: a chat automation may be stored as its own workflow.
      'A chat prompt automation may be stored, and read back by automation.list / automation.get, as a worktree_pipeline with target { kind: "global" } that runs a workflow it owns',
      'edit that workflow with pipeline.update only for what the chat action cannot express',
      'Honor an explicit request for a provider/harness-native scheduler',
      '"use Claude\'s built-in schedule feature" or an explicitly invoked scheduling tool/skill',
      'merely choosing Claude/Codex as the model is not an override',
      'Keep native tools and scheduling skills available',
      'if the requested feature is unavailable, explain that instead of claiming success',
      'Do not ask the user to choose a scheduler for an otherwise clear request',
      'clarify missing work, destination, date/time, or recurrence',
      'do not invent a daily cadence for "at 9am" alone',
      'Only after successful creation, use the returned receipt to confirm the saved name, schedule (including timezone), and that it can be viewed/edited on the Workflows → Library tab',
      'On failure, explain the error without silently switching schedulers',
      're-list/read after an ambiguous create result before retrying',
      'This default does not replace dedicated existing-chat message scheduling',
      'Preserve event-specific watchers for "tell me when the build finishes"',
      `Use ${names.schedule_wakeup.claudeToolName} / ${names.schedule_wakeup.codexToolName} for a bounded same-chat continuation after 60–3600 seconds, such as "wait 10 minutes, then check the build", then end the turn`,
      'A request to create a reminder in 10 minutes still creates a one-time automation; duration alone does not select the mechanism',
      "Only create schedules when requested, not during a discussion, and respect the surface's read-only restrictions",
    ];
    let previousIndex = -1;
    for (const instruction of expectedPolicy) {
      expect(paragraph).toContain(instruction);
      const index = paragraph.indexOf(instruction);
      expect(index).toBeGreaterThan(previousIndex);
      previousIndex = index;
    }
    expect(lines[lines.indexOf(paragraph) - 1]).toContain('- For Workflows,');
    for (const tool of [
      CANOPY_INJECTED_TOOL_REGISTRY.dispatch_action,
      CANOPY_INJECTED_TOOL_REGISTRY.search_actions,
      CANOPY_INJECTED_TOOL_REGISTRY.schedule_wakeup,
    ]) {
      expect(paragraph).not.toContain(tool.claudeToolName);
      expect(paragraph).not.toContain(tool.codexToolName);
    }
  });

  it('preserves dedicated existing-chat scheduling and protected automation actions', (): void => {
    expect(APP_ADVISOR_SYSTEM_PROMPT).toContain(
      'Use projects.schedule_message, not automation.create with worktree_prompt, when the user asks to schedule a message, response, or Continue into the current/existing worktree chat',
    );
    expect(APP_ADVISOR_SYSTEM_PROMPT).toContain(
      'with existingWorktreeId it opens a NEW chat on that already-existing worktree',
    );
    expect(APP_ADVISOR_SYSTEM_PROMPT).toContain(
      'For other existing worktree_session_prompt activities, automation.update may edit name, schedule, enabled, prompt, fileReferences, attachmentPaths, attachmentPromptContexts, and inputMode only when the action patch preserves the same workspaceId, worktreeId, chatId, and purpose',
    );
    expect(APP_ADVISOR_SYSTEM_PROMPT).toContain(
      'blocks creating worktree_session_prompt through generic automation.create and blocks conversion, action changes, retargeting, or purpose changes',
    );
  });

  it('routes Codex speed changes to the exact speed action', (): void => {
    expect(APP_ADVISOR_SYSTEM_PROMPT).toContain(
      "Use worktree-chat.set_speed to choose a Codex chat's Regular (standard), Fast, or Ultra fast speed",
    );
    expect(APP_ADVISOR_SYSTEM_PROMPT).toContain(
      'worktree-chat.set_fast_mode is the legacy switch, and its true/false replaces the current speed, including Ultra fast',
    );
    expect(APP_ADVISOR_SYSTEM_PROMPT).toContain(
      'A speed result is the requested speed, not proof of entitlement or of the tier Codex served',
    );
  });

  it('directs the assistant to act through branded tools by default', () => {
    expect(APP_ADVISOR_SYSTEM_PROMPT).toContain(
      `they are asking you to interact with ${BRAND.displayName} via Orchestrator tools and actions`,
    );
    expect(APP_ADVISOR_SYSTEM_PROMPT).toContain(
      'Do not merely describe manual steps',
    );
  });

  it('documents the action discovery and dispatch workflow', () => {
    expect(APP_ADVISOR_SYSTEM_PROMPT).toContain('SearchActions');
    expect(APP_ADVISOR_SYSTEM_PROMPT).toContain('DispatchAction');
    expect(APP_ADVISOR_SYSTEM_PROMPT).toContain(
      'mcp__canopy_app_advisor__SearchActions',
    );
    expect(APP_ADVISOR_SYSTEM_PROMPT).toContain(
      'mcp__canopy_app_advisor__DispatchAction',
    );
    expect(APP_ADVISOR_SYSTEM_PROMPT).toContain('app_advisor_search_actions');
    expect(APP_ADVISOR_SYSTEM_PROMPT).toContain(
      'Always check SearchActions before concluding',
    );
    expect(APP_ADVISOR_SYSTEM_PROMPT).toContain('projects.read_history');
    expect(APP_ADVISOR_SYSTEM_PROMPT).toContain('tracked-plan.import');
    expect(APP_ADVISOR_SYSTEM_PROMPT).toContain('pipeline.update_shared');
    expect(APP_ADVISOR_SYSTEM_PROMPT).toContain('workspace.list_join_options');
    expect(APP_ADVISOR_SYSTEM_PROMPT).toContain('worktree.add_workspace');
    expect(APP_ADVISOR_SYSTEM_PROMPT).toContain('workspace.promote_temporary');
    expect(APP_ADVISOR_SYSTEM_PROMPT).toContain('skills.open_manager');
    expect(APP_ADVISOR_SYSTEM_PROMPT).toContain('skills.open_viewer');
    expect(APP_ADVISOR_SYSTEM_PROMPT).toContain('skills.update_custom');
    expect(APP_ADVISOR_SYSTEM_PROMPT).toContain('skills.read_shared');
    expect(APP_ADVISOR_SYSTEM_PROMPT).toContain('skills.open_shared_viewer');
    expect(APP_ADVISOR_SYSTEM_PROMPT).toContain(
      'projects.list → projects.list_tasks → projects.list_task_chats',
    );
    expect(APP_ADVISOR_SYSTEM_PROMPT).toContain(
      'standalone-chat.update_settings',
    );
    // The artifact actions were removed with the cowork artifacts feature.
    expect(APP_ADVISOR_SYSTEM_PROMPT).not.toContain(
      'standalone-chat.delete_artifact',
    );
    expect(APP_ADVISOR_SYSTEM_PROMPT).toContain(
      'use projects.schedule_message',
    );
    expect(APP_ADVISOR_SYSTEM_PROMPT).toContain(
      'not automation.create with worktree_prompt',
    );
    expect(APP_ADVISOR_SYSTEM_PROMPT).toContain('automation.create');
    expect(APP_ADVISOR_SYSTEM_PROMPT).toContain('automation.open_editor');
    expect(APP_ADVISOR_SYSTEM_PROMPT).toContain(
      'review existing scheduled messages with automation.list / automation.get',
    );
    expect(APP_ADVISOR_SYSTEM_PROMPT).toContain(
      'automation.update may edit name, schedule, enabled, prompt, fileReferences, attachmentPaths, attachmentPromptContexts, and inputMode',
    );
    expect(APP_ADVISOR_SYSTEM_PROMPT).toContain(
      'common safety policy also blocks creating worktree_session_prompt through generic automation.create',
    );
    expect(APP_ADVISOR_SYSTEM_PROMPT).toContain(
      'cannot add or replace one, and automation.run_now rejects activities that have one configured',
    );
    expect(APP_ADVISOR_SYSTEM_PROMPT).toContain(
      'Preferred workflow: call browser.list, reuse or open a browser, call browser.input_snapshot with role/inputType/fuzzy-name filters',
    );
    expect(APP_ADVISOR_SYSTEM_PROMPT).toContain(
      'Use dialogResponse on a click or key press as an optional optimization',
    );
    expect(APP_ADVISOR_SYSTEM_PROMPT).toContain(
      'Screenshots are returned as viewable image content and are best for visual confirmation',
    );
  });

  it('routes tracked plans through the Plan panel and ordinary worktree chats', () => {
    expect(APP_ADVISOR_SYSTEM_PROMPT).toContain(
      "tracked-plan.open_explore to open a plan's Plan panel in its worktree",
    );
    expect(APP_ADVISOR_SYSTEM_PROMPT).toContain(
      "panel.add_tab with kind 'plan' or 'plan-diagram' and the planId",
    );
    expect(APP_ADVISOR_SYSTEM_PROMPT).toContain(
      "Plans are discussed in the worktree's ordinary chats, so discover the task/chat address, then use projects.read_history or projects.send_message",
    );
    // The takeover's embedded chat and its action family are retired.
    expect(APP_ADVISOR_SYSTEM_PROMPT).not.toContain('plan-explore-chat');
    expect(APP_ADVISOR_SYSTEM_PROMPT).not.toContain('Explore modal');
  });

  it('takes an on-screen chat address from the UI state instead of listing chats', () => {
    expect(APP_ADVISOR_SYSTEM_PROMPT).toContain(
      "activeChat.address is the focused chat's {projectId,taskId,chatId}",
    );
    expect(APP_ADVISOR_SYSTEM_PROMPT).toContain(
      'Use projects.list_task_chats only for chats that are not on screen.',
    );
  });

  it('checks which organization owns a repository before a Personal add (CAN-3592)', (): void => {
    expect(APP_ADVISOR_SYSTEM_PROMPT).toContain(
      'Before workspace.open_add_dialog, or after navigation.open_import_projects, when the member names a repository or folder, call workspace.find_repository_owner',
    );
    expect(APP_ADVISOR_SYSTEM_PROMPT).toContain(
      "On kind 'organization', say that <repositoryName> belongs to <organizationName> and offer workspace.add_org_project with the returned projectId",
    );
    // workspace.add_org_project refuses while Personal or another
    // organization is selected, so the offer must name the switch.
    expect(APP_ADVISOR_SYSTEM_PROMPT).toContain(
      "workspace.add_org_project only works while that organization is selected: if the member accepts, first call workspace_context.switch with { context: { kind: 'organization', organizationId } } from the result",
    );
    expect(APP_ADVISOR_SYSTEM_PROMPT).toContain(
      'The member may still add it to Personal; never move a project yourself',
    );
    // The dialog stays quiet when the owner is the scope being added to.
    expect(APP_ADVISOR_SYSTEM_PROMPT).toContain(
      'If workspaceContext in the UI state already selects that organization, skip the hint and the switch',
    );
    expect(APP_ADVISOR_SYSTEM_PROMPT).toContain(
      "Treat kind 'none' as nothing to say, not as an error",
    );
    // The add reports where the project stands; a listing or an open setup
    // dialog is not an add (CAN-3592 QA).
    expect(APP_ADVISOR_SYSTEM_PROMPT).toContain(
      "Report workspace.add_org_project by its status: 'setting_up' means setup started and its sidebar row shows progress, 'awaiting_setup' means the member must choose a folder and start in the setup dialog, and only 'on_this_computer' means it is already added",
    );
    // QA: GPT switched and added without asking, then opened with "Added".
    expect(APP_ADVISOR_SYSTEM_PROMPT).toContain(
      'Offer it as a question and wait for the answer: never call workspace_context.switch or workspace.add_org_project for this hint before the member chooses the organization',
    );
    expect(APP_ADVISOR_SYSTEM_PROMPT).toContain(
      "Never say the project was added while its status is 'setting_up' or 'awaiting_setup'",
    );
  });

  it('explains that panel.add_tab opens or reveals the Subagents panel', () => {
    expect(APP_ADVISOR_SYSTEM_PROMPT).toContain(
      "panel.add_tab with kind 'subagents' opens or reveals the Subagents panel",
    );
  });

  it('offers an independent same-entry fork without suggesting a branch', () => {
    expect(APP_ADVISOR_SYSTEM_PROMPT).toContain('StartForkedAgent');
    expect(APP_ADVISOR_SYSTEM_PROMPT).toContain('independent');
    expect(APP_ADVISOR_SYSTEM_PROMPT).not.toContain('StartBranchedAgent');
  });

  it('instructs the agent to fetch UI state on demand rather than relying on an injected block', () => {
    // UI state is no longer injected into the conversation; the agent must
    // call GetCurrentUiState to read current state.
    expect(APP_ADVISOR_SYSTEM_PROMPT).toContain(
      'You are NOT given the current UI state automatically',
    );
    expect(APP_ADVISOR_SYSTEM_PROMPT).toContain('fetch a fresh snapshot');
    expect(APP_ADVISOR_SYSTEM_PROMPT).not.toContain('<app_advisor_context>');
  });

  it('documents provider tool names from the branded App Advisor registry', () => {
    expect(APP_ADVISOR_SYSTEM_PROMPT).toContain(
      APP_ADVISOR_TOOL_REGISTRY.get_current_ui_state.codexToolName,
    );
    expect(APP_ADVISOR_SYSTEM_PROMPT).toContain(
      APP_ADVISOR_TOOL_REGISTRY.dispatch_action.codexToolName,
    );
    expect(APP_ADVISOR_SYSTEM_PROMPT).toContain(
      APP_ADVISOR_TOOL_REGISTRY.read_pipeline_yaml.codexToolName,
    );
    expect(APP_ADVISOR_SYSTEM_PROMPT).toContain(
      APP_ADVISOR_TOOL_REGISTRY.show_files.codexToolName,
    );
    expect(APP_ADVISOR_SYSTEM_PROMPT).toContain(
      APP_ADVISOR_TOOL_REGISTRY.get_file_comments.codexToolName,
    );
    expect(APP_ADVISOR_SYSTEM_PROMPT).toContain(
      APP_ADVISOR_TOOL_REGISTRY.respond_to_file_comment.codexToolName,
    );
    expect(APP_ADVISOR_SYSTEM_PROMPT).toContain(
      'use the same explicit workspace target used with ShowFiles',
    );
    expect(APP_ADVISOR_SYSTEM_PROMPT).toContain(
      'omit projectId/worktreeId to manage the browser belonging to this Orchestrator Work Entry',
    );
  });

  it('reserves deferred-tool discovery for unavailable capabilities', () => {
    expect(APP_ADVISOR_SYSTEM_PROMPT).toContain(
      "absent from the agent's current Skills list and callable tool surface",
    );
    expect(APP_ADVISOR_SYSTEM_PROMPT).toContain(
      'never search for or load a skill, plugin, MCP server, or command that is already available',
    );
  });

  it('documents the watcher workflow and destination capture', () => {
    expect(APP_ADVISOR_SYSTEM_PROMPT).toContain('app_advisor_watch_command');
    expect(APP_ADVISOR_SYSTEM_PROMPT).toContain('requires command approval');
    expect(APP_ADVISOR_SYSTEM_PROMPT).toContain(
      'Only create or arm watchers when the user explicitly asks to watch, wait, or be notified',
    );
    expect(APP_ADVISOR_SYSTEM_PROMPT).toContain(
      'Do not add inline watchers merely because an action supports them',
    );
    expect(APP_ADVISOR_SYSTEM_PROMPT).toContain('SearchWatchers');
    expect(APP_ADVISOR_SYSTEM_PROMPT).toContain('SetupWatchers');
    expect(APP_ADVISOR_SYSTEM_PROMPT).toContain(
      'Watchers are not action dispatches',
    );
    expect(APP_ADVISOR_SYSTEM_PROMPT).toContain(
      'Do not pass the destination Orchestrator chat',
    );
    expect(APP_ADVISOR_SYSTEM_PROMPT).toContain(
      'automation.create or automation.run_now',
    );
    expect(APP_ADVISOR_SYSTEM_PROMPT).toContain('active-watchers icon');
  });

  it('introduces itself as Orchestrator with its former name exactly once', () => {
    expect(APP_ADVISOR_SYSTEM_PROMPT).toContain(
      'You are Orchestrator (formerly App Advisor), an assistant embedded inside',
    );
    expect(
      APP_ADVISOR_SYSTEM_PROMPT.split('formerly App Advisor').length - 1,
    ).toBe(1);
    expect(APP_ADVISOR_SYSTEM_PROMPT).not.toMatch(/App Advisor(?! *\))/);
  });
});
