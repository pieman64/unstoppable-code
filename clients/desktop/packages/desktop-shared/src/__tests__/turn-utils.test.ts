import {
  computeTurnSummary,
  computeTurnOutcomes,
  getTurnOutcomeSteps,
  getTurnOutcomeStepDetails,
  getToolCategory,
  groupIntoTurns,
  isUsageInitiationSource,
  normalizeCanopyMcpServerDisplayName,
  parseMcpToolName,
} from '../lib/turn-utils';
import type { TurnBlock, TurnMessage } from '../lib/turn-utils';
import { getPortalChatToolFamily } from '../lib/portal-tool-family';

describe('plan-file write summary accounting', () => {
  it.each([undefined, false, true])(
    'excludes canonical plan writes from project edits regardless of error state %s',
    (isError) => {
      const messages: TurnMessage[] = [
        {
          id: 'plan-turn',
          role: 'assistant',
          timestamp: 1,
          blocks: [
            ...[
              '/Users/test/.claude/plans/draft.md',
              'C:\\Users\\test\\.claude\\plans\\draft.md',
            ].map(
              (file_path, index): TurnBlock => ({
                type: 'tool_use',
                toolUseId: `plan-${index}`,
                toolName: 'Write',
                input: JSON.stringify({ file_path, content: '# Plan' }),
                ...(isError === undefined
                  ? {}
                  : {
                      result: {
                        output: isError ? 'Write failed' : 'Written',
                        isError,
                      },
                    }),
              }),
            ),
            {
              type: 'tool_use',
              toolUseId: 'grep',
              toolName: 'Grep',
              input: '{}',
              result: { output: 'Found', isError: false },
            },
            {
              type: 'tool_use',
              toolUseId: 'exit',
              toolName: 'ExitPlanMode',
              input: '{}',
              result: { output: 'canopy_plan_handoff', isError: true },
            },
          ],
        },
      ];
      expect(computeTurnSummary(messages)).toMatchObject({
        writeEdit: 0,
        grep: 1,
        plan: 0,
      });
      expect(computeTurnOutcomes(messages)).toEqual({
        blocked: 0,
        failed: isError ? 2 : 0,
        interrupted: 0,
      });
      messages[0].blocks.push(
        {
          type: 'tool_use',
          toolUseId: 'project',
          toolName: 'Write',
          input: '{"file_path":"docs/plans/draft.md"}',
        },
        {
          type: 'tool_use',
          toolUseId: 'edit',
          toolName: 'Edit',
          input: '{"file_path":"src/index.ts"}',
        },
      );
      expect(computeTurnSummary(messages).writeEdit).toBe(2);
    },
  );
});

describe('turn outcomes', () => {
  it('classifies interruption metadata before errors while keeping blocked precedence and step totals', () => {
    const interruption = { reason: 'app_restart', at: 14 } as const;
    const blocks: TurnBlock[] = [
      {
        type: 'tool_use',
        toolUseId: 'read',
        toolName: 'Read',
        input: '{}',
        result: { output: 'ok', isError: false },
      },
      ...['edit', 'neutral', 'denied'].map(
        (toolUseId): TurnBlock => ({
          type: 'tool_use',
          toolUseId,
          toolName: 'Edit',
          input: '{}',
          result: {
            output: 'Interrupted',
            isError: toolUseId !== 'neutral',
            interruption,
          },
        }),
      ),
      {
        type: 'tool_use',
        toolUseId: 'error',
        toolName: 'Bash',
        input: '{}',
        result: { output: 'real error', isError: true },
      },
    ];
    const rows: TurnMessage[] = [
      { id: 'steps', role: 'assistant', timestamp: 14, blocks },
    ];
    expect(computeTurnOutcomes(rows, rows, 'user', ['denied'])).toEqual({
      blocked: 1,
      failed: 1,
      interrupted: 2,
    });
    expect(getTurnOutcomeStepDetails(rows, rows, 'user', ['denied'])).toEqual([
      expect.objectContaining({
        toolUseId: 'edit',
        outcome: 'interrupted',
        interruption,
      }),
      expect.objectContaining({
        toolUseId: 'neutral',
        outcome: 'interrupted',
        interruption,
      }),
      expect.objectContaining({ toolUseId: 'denied', outcome: 'blocked' }),
      expect.objectContaining({ toolUseId: 'error', outcome: 'failed' }),
    ]);
    expect(computeTurnSummary(rows)).toMatchObject({
      read: 1,
      writeEdit: 3,
      bash: 1,
    });
    expect(computeTurnOutcomes([rows[0], rows[0]])).toEqual({
      blocked: 0,
      failed: 1,
      interrupted: 3,
    });
  });
  const message = (blocks: TurnBlock[]): TurnMessage => ({
    id: 'steps',
    role: 'assistant',
    timestamp: 1,
    blocks,
  });
  const tool = (
    toolUseId: string,
    isError?: boolean,
    toolName = 'Bash',
  ): TurnBlock => ({
    type: 'tool_use',
    toolUseId,
    toolName,
    input: '{}',
    ...(isError === undefined
      ? {}
      : { result: { output: 'fixture', isError } }),
  });
  const receipt = (
    toolUseId: string,
  ): Extract<TurnBlock, { type: 'approval_safety_denied_info' }> => ({
    type: 'approval_safety_denied_info',
    receiptId: `denied-${toolUseId}`,
    timestamp: 2,
    reason: 'force-push',
    mode: 'ask',
    command: 'fixture only',
    toolUseId,
  });

  it('ignores receipts explicitly owned by another turn while preserving unscoped legacy receipts', () => {
    const steps = [message([tool('reused', true)])];
    expect(
      computeTurnOutcomes(
        steps,
        [message([{ ...receipt('reused'), turnUserMessageId: 'first' }])],
        'next',
      ),
    ).toEqual({ blocked: 0, failed: 1, interrupted: 0 });
    expect(
      computeTurnOutcomes(
        steps,
        [message([{ ...receipt('reused'), turnUserMessageId: 'first' }])],
        'first',
      ),
    ).toEqual({ blocked: 1, failed: 0, interrupted: 0 });
    expect(
      computeTurnOutcomes(steps, [message([receipt('reused')])], 'next'),
    ).toEqual({ blocked: 1, failed: 0, interrupted: 0 });
  });

  it('uses projected denial IDs only for eligible loaded steps when receipts are omitted', () => {
    const steps = [
      message([
        tool('blocked', true),
        tool('failed', true),
        tool('blocked', true),
      ]),
    ];
    const deniedIds = ['blocked', 'blocked', 'unloaded'];
    expect(computeTurnOutcomes(steps, [], 'owner', deniedIds)).toEqual({
      blocked: 1,
      failed: 1,
      interrupted: 0,
    });
    expect(getTurnOutcomeSteps(steps, [], 'owner', deniedIds)).toEqual([
      { toolUseId: 'blocked', outcome: 'blocked' },
      { toolUseId: 'failed', outcome: 'failed' },
    ]);
    expect(computeTurnOutcomes([], [], 'owner', deniedIds)).toEqual({
      blocked: 0,
      failed: 0,
      interrupted: 0,
    });
  });

  it('deduplicates steps and receipts, preferring blocked over an error', () => {
    const steps = [
      message([
        tool('blocked', true),
        tool('failed', true),
        tool('blocked', true),
      ]),
    ];
    expect(
      computeTurnOutcomes(steps, [
        message([receipt('blocked'), receipt('blocked'), receipt('unmatched')]),
      ]),
    ).toEqual({ blocked: 1, failed: 1, interrupted: 0 });
    expect(getTurnOutcomeSteps(steps, [message([receipt('blocked')])])).toEqual(
      [
        { toolUseId: 'blocked', outcome: 'blocked' },
        { toolUseId: 'failed', outcome: 'failed' },
      ],
    );
  });

  it('counts a receipt before its result and ignores pending and successful steps', () => {
    expect(
      computeTurnOutcomes([
        message([
          receipt('pending-denial'),
          tool('pending-denial'),
          tool('pending'),
          tool('success', false),
        ]),
      ]),
    ).toEqual({ blocked: 1, failed: 0, interrupted: 0 });
    expect(computeTurnOutcomes([])).toEqual({
      blocked: 0,
      failed: 0,
      interrupted: 0,
    });
  });

  it('does not infer a safety refusal from output text', () => {
    const failed: TurnBlock = {
      type: 'tool_use',
      toolUseId: 'error',
      toolName: 'Bash',
      input: '{}',
      result: { output: 'Safety denied force-push', isError: true },
    };
    expect(computeTurnOutcomes([message([failed])])).toEqual({
      blocked: 0,
      failed: 1,
      interrupted: 0,
    });
  });

  it('excludes plan-mode steps, unmatched receipts and helper receipts', () => {
    const helperReceipt: TurnBlock = {
      ...receipt('top'),
      subagentId: 'helper',
    };
    const unlinkedReceipt: TurnBlock = {
      ...receipt('unused'),
      toolUseId: undefined,
    };
    expect(
      computeTurnOutcomes([
        message([
          tool('enter', true, 'EnterPlanMode'),
          tool('exit', true, 'ExitPlanMode'),
          receipt('enter'),
          receipt('exit'),
          receipt('unmatched'),
          tool('top'),
          helperReceipt,
          unlinkedReceipt,
        ]),
      ]),
    ).toEqual({ blocked: 0, failed: 0, interrupted: 0 });
  });

  it('counts workflow and authoritative agent results without descending into helper steps', () => {
    const agent: Extract<TurnBlock, { type: 'agent' }> = {
      type: 'agent',
      toolUseId: 'agent',
      subagentType: 'general',
      description: 'Work',
      prompt: 'Work',
      runInBackground: true,
      result: { output: 'dispatch failed', isError: true },
      taskOutputResult: { output: 'completed', isError: false },
      subBlocks: [tool('nested', true), receipt('nested')],
    };
    const workflow: TurnBlock = {
      type: 'workflow',
      toolUseId: 'workflow',
      workflowName: 'Work',
      summary: 'Work',
      result: { output: 'failed', isError: true },
    };
    expect(computeTurnOutcomes([message([agent, workflow])])).toEqual({
      blocked: 0,
      failed: 1,
      interrupted: 0,
    });
    expect(
      computeTurnOutcomes([
        message([
          {
            ...agent,
            taskOutputResult: { output: 'failed', isError: true },
            result: { output: 'started', isError: false },
          },
        ]),
      ]),
    ).toEqual({ blocked: 0, failed: 1, interrupted: 0 });
    expect(
      computeTurnOutcomes([
        message([{ ...agent, taskOutputResult: undefined }]),
      ]),
    ).toEqual({ blocked: 0, failed: 1, interrupted: 0 });
  });

  it('uses the last authoritative result for repeated representations', () => {
    expect(
      computeTurnOutcomes([
        message([tool('same', true), tool('same', false), tool('same')]),
      ]),
    ).toEqual({ blocked: 0, failed: 0, interrupted: 0 });
  });

  it('leaves Codex and delegated-agent outcomes outside the supported projection', () => {
    const codex: TurnBlock = {
      type: 'codex_agent',
      agentBlockId: 'codex',
      callId: 'codex-call',
      status: 'failed',
      senderThreadId: 'parent',
      receiverThreadIds: [],
      prompt: 'Work',
      description: 'Work',
      displayName: 'Agent',
      agentsStates: {},
      subBlocks: [tool('nested-codex', true)],
    };
    const delegated: TurnBlock = {
      type: 'delegated_agent_call',
      agentBlockId: 'delegate',
      delegationId: 'delegate',
      status: 'failed',
      runGeneration: 1,
      sequence: 1,
      parentHarnessId: 'parent',
      parentTurnId: 'turn',
      parentToolCallId: 'call',
      createdAt: 1,
      selectedModelId: 'fixture',
      runtimeModelId: 'fixture',
      targetHarnessId: 'target',
      description: 'Work',
      prompt: 'Work',
      executionMode: 'foreground',
      outputTruncated: false,
      subBlocks: [tool('nested-delegate', true)],
    };
    expect(computeTurnOutcomes([message([codex, delegated])])).toEqual({
      blocked: 0,
      failed: 0,
      interrupted: 0,
    });
  });

  describe('getTurnOutcomeStepDetails', () => {
    const agent = (
      toolUseId: string,
      result?: { output: string; isError: boolean },
      taskOutputResult?: { output: string; isError: boolean },
    ): TurnBlock => ({
      type: 'agent',
      toolUseId,
      subagentType: 'Explore',
      description: 'Find the config',
      prompt: 'Look around',
      runInBackground: false,
      subBlocks: [],
      ...(result ? { result } : {}),
      ...(taskOutputResult ? { taskOutputResult } : {}),
    });

    it('joins tool, agent and workflow steps to their calls in outcome order', () => {
      const bash: TurnBlock = {
        type: 'tool_use',
        toolUseId: 'bash',
        toolName: 'Bash',
        input: '{"command":"ls *.json","description":"List MCP files"}',
        result: {
          output: 'Exit code 1\nzsh: no matches found: *.json',
          isError: true,
        },
      };
      const workflow: TurnBlock = {
        type: 'workflow',
        toolUseId: 'flow',
        workflowName: 'review',
        summary: 'Review',
        result: { output: 'Workflow broke', isError: true },
      };
      const steps = [
        message([
          tool('ok', false),
          bash,
          agent(
            'agent',
            { output: 'launched', isError: false },
            { output: 'Agent gave up', isError: true },
          ),
          workflow,
          tool('denied', true, 'Edit'),
          tool('plan', true, 'ExitPlanMode'),
        ]),
      ];

      const details = getTurnOutcomeStepDetails(steps, [
        message([receipt('denied')]),
      ]);

      expect(details).toEqual([
        {
          toolUseId: 'bash',
          outcome: 'failed',
          toolName: 'Bash',
          input: '{"command":"ls *.json","description":"List MCP files"}',
          output: 'Exit code 1\nzsh: no matches found: *.json',
        },
        {
          toolUseId: 'agent',
          outcome: 'failed',
          toolName: 'Agent',
          input: JSON.stringify({
            description: 'Find the config',
            subagent_type: 'Explore',
            prompt: 'Look around',
          }),
          output: 'Agent gave up',
        },
        {
          toolUseId: 'flow',
          outcome: 'failed',
          toolName: 'Workflow',
          input: '{"name":"review"}',
          output: 'Workflow broke',
        },
        {
          toolUseId: 'denied',
          outcome: 'blocked',
          toolName: 'Edit',
          input: '{}',
          output: 'fixture',
        },
      ]);
      expect(
        details.map(({ toolUseId, outcome }) => ({ toolUseId, outcome })),
      ).toEqual(getTurnOutcomeSteps(steps, [message([receipt('denied')])]));
    });

    it('keeps a known result when a repeated representation has none', () => {
      const steps = [message([tool('repeat', true), tool('repeat')])];
      expect(getTurnOutcomeStepDetails(steps)).toEqual([
        {
          toolUseId: 'repeat',
          outcome: 'failed',
          toolName: 'Bash',
          input: '{}',
          output: 'fixture',
        },
      ]);
    });

    it('lists a blocked step with no result yet without an output', () => {
      const steps = [message([receipt('pending'), tool('pending')])];
      expect(getTurnOutcomeStepDetails(steps)).toEqual([
        {
          toolUseId: 'pending',
          outcome: 'blocked',
          toolName: 'Bash',
          input: '{}',
        },
      ]);
    });

    it('returns no details for a clean turn', () => {
      expect(getTurnOutcomeStepDetails([message([tool('ok', false)])])).toEqual(
        [],
      );
      expect(getTurnOutcomeStepDetails([])).toEqual([]);
    });
  });
});

describe('async answer grouping', () => {
  it('does not fabricate a completed timer when a steered answer arrives', () => {
    const messages: TurnMessage[] = [
      {
        id: 'prompt',
        role: 'user',
        timestamp: 1,
        blocks: [{ type: 'text', text: 'Work' }],
      },
      {
        id: 'progress',
        role: 'assistant',
        timestamp: 2,
        blocks: [{ type: 'text', text: 'Working' }],
      },
      {
        id: 'answer',
        role: 'user',
        timestamp: 3,
        blocks: [
          {
            type: 'text',
            text: 'Q: Scope?\nA: Full',
            ...{
              asyncQuestionAnswer: {
                requestId: 'request',
                startsTurn: false,
                answers: [{ question: 'Scope?', selectedOptions: ['Full'] }],
              },
            },
          },
        ],
      },
      {
        id: 'final',
        role: 'assistant',
        timestamp: 4,
        blocks: [{ type: 'text', text: 'Done' }],
      },
      {
        id: 'timer',
        role: 'system',
        timestamp: 1,
        blocks: [{ type: 'turn_timer', startedAt: 1, completedAt: 5 }],
      },
    ];
    const groups = groupIntoTurns(messages);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      kind: 'turn-group',
      userMessage: { id: 'prompt' },
      assistantMessages: [
        { id: 'progress' },
        { id: 'answer' },
        { id: 'final' },
      ],
      timerMessage: { id: 'timer' },
    });
  });
});

describe('turn-utils tool category mapping', () => {
  describe('usage initiation source guard', () => {
    it('accepts known usage initiation sources only', () => {
      expect(isUsageInitiationSource('user')).toBe(true);
      expect(isUsageInitiationSource('automation')).toBe(true);
      expect(isUsageInitiationSource('not-a-real-source')).toBe(false);
      expect(isUsageInitiationSource(undefined)).toBe(false);
    });
  });

  describe('Canopy-injected ask-user aliases → askUser', () => {
    it.each([
      'AskUserQuestion',
      'mcp__canopy__AskUserQuestion',
      'canopy_ask_user_question',
      'mcp__somebrand__AskUserQuestion',
      'somebrand_ask_user_question',
    ])('maps %s to askUser', (toolName) => {
      expect(getToolCategory(toolName)).toBe('askUser');
    });
  });

  describe('Codex built-in ask-user → askUser', () => {
    it('maps request_user_input to askUser (shared bucket)', () => {
      expect(getToolCategory('request_user_input')).toBe('askUser');
    });
  });

  describe('Claude model-change marker → claude', () => {
    it('maps ClaudeModelChange to the Claude category and tool family', () => {
      expect(getToolCategory('ClaudeModelChange')).toBe('claude');
      expect(getPortalChatToolFamily('ClaudeModelChange')).toBe('claude');
    });
  });

  describe('Claude cron tools → scheduleWakeup', () => {
    it.each(['CronCreate', 'CronDelete', 'CronList'])(
      "counts Claude's %s with the scheduling tools",
      (name) => {
        expect(getToolCategory(name)).toBe('scheduleWakeup');
      },
    );
  });

  describe('Agent-to-agent message → agent', () => {
    it('folds SendMessage into the agent category and family', () => {
      expect(getToolCategory('SendMessage')).toBe('agent');
      expect(getPortalChatToolFamily('SendMessage')).toBe('agent');
    });
  });

  describe('Claude agent output → agent', () => {
    it('folds TaskOutput into the agent category and family', () => {
      expect(getToolCategory('TaskOutput')).toBe('agent');
      expect(getPortalChatToolFamily('TaskOutput')).toBe('agent');
    });
  });

  describe('Canopy-injected script-output aliases → scriptOutput', () => {
    it.each([
      'GetScriptOutput',
      'mcp__canopy__GetScriptOutput',
      'canopy_get_script_output',
      'mcp__somebrand__GetScriptOutput',
      'somebrand_get_script_output',
    ])('maps %s to scriptOutput', (toolName) => {
      expect(getToolCategory(toolName)).toBe('scriptOutput');
    });
  });

  describe('Canopy-injected worktree action aliases → canopy', () => {
    it.each([
      'SearchActions',
      'mcp__canopy__SearchActions',
      'canopy_search_actions',
      'ReadPipelineYaml',
      'mcp__canopy__ReadPipelineYaml',
      'canopy_read_pipeline_yaml',
      'DispatchAction',
      'mcp__canopy__DispatchAction',
      'canopy_dispatch_action',
      'SetAutoArchive',
      'mcp__canopy__SetAutoArchive',
      'canopy_set_auto_archive',
      'SetBaseBranch',
      'mcp__canopy__SetBaseBranch',
      'canopy_set_base_branch',
      'ArchiveChat',
      'mcp__canopy__ArchiveChat',
      'canopy_archive_chat',
      'GetGitPreferences',
      'mcp__canopy__GetGitPreferences',
      'canopy_get_git_preferences',
      'GetGitHubPullRequestStatus',
      'mcp__canopy__GetGitHubPullRequestStatus',
      'canopy_get_github_pull_request_status',
      'SaveMemory',
      'mcp__canopy__SaveMemory',
      'canopy_save_memory',
      'SearchMemory',
      'mcp__canopy__SearchMemory',
      'canopy_search_memory',
      'ReadMemory',
      'mcp__canopy__ReadMemory',
      'canopy_read_memory',
      'mcp__somebrand__SearchActions',
      'somebrand_search_actions',
      'mcp__somebrand__ReadPipelineYaml',
      'somebrand_read_pipeline_yaml',
      'mcp__somebrand__DispatchAction',
      'somebrand_dispatch_action',
      'mcp__somebrand__SetAutoArchive',
      'somebrand_set_auto_archive',
      'mcp__somebrand__SetBaseBranch',
      'somebrand_set_base_branch',
      'mcp__somebrand__ArchiveChat',
      'somebrand_archive_chat',
      'mcp__somebrand__GetGitPreferences',
      'somebrand_get_git_preferences',
      'mcp__somebrand__GetGitHubPullRequestStatus',
      'somebrand_get_github_pull_request_status',
      'mcp__somebrand__SaveMemory',
      'somebrand_save_memory',
      'mcp__somebrand__SearchMemory',
      'somebrand_search_memory',
      'mcp__somebrand__ReadMemory',
      'somebrand_read_memory',
      'SearchDeferredTools',
      'mcp__canopy__SearchDeferredTools',
      'canopy_search_deferred_tools',
      'LoadDeferredTools',
      'mcp__canopy__LoadDeferredTools',
      'canopy_load_deferred_tools',
      'mcp__somebrand__SearchDeferredTools',
      'somebrand_search_deferred_tools',
      'mcp__somebrand__LoadDeferredTools',
      'somebrand_load_deferred_tools',
      'AddFeedEntry',
      'mcp__canopy__AddFeedEntry',
      'canopy_add_feed_entry',
      'SearchFeedEntries',
      'mcp__canopy__SearchFeedEntries',
      'canopy_search_feed_entries',
      'UpdateFeedEntry',
      'mcp__canopy__UpdateFeedEntry',
      'canopy_update_feed_entry',
      'mcp__somebrand__AddFeedEntry',
      'somebrand_add_feed_entry',
      'mcp__somebrand__SearchFeedEntries',
      'somebrand_search_feed_entries',
      'mcp__somebrand__UpdateFeedEntry',
      'somebrand_update_feed_entry',
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
      'mcp__somebrand_app_advisor__AddFeedEntry',
      'somebrand_app_advisor_update_feed_entry',
    ])('maps %s to canopy', (toolName) => {
      expect(getToolCategory(toolName)).toBe('canopy');
    });

    it('maps the Codex ImmediateTurnRestart control tool to canopy', () => {
      expect(getToolCategory('canopy_immediate_turn_restart')).toBe('canopy');
      expect(getToolCategory('somebrand_immediate_turn_restart')).toBe('other');
      expect(
        getToolCategory('mcp__attacker__fake_immediate_turn_restart'),
      ).toBe('mcp');
    });
  });

  describe('Canopy-injected code-graph tool aliases → graph', () => {
    it.each([
      'GetCodeGraphContext',
      'mcp__canopy__GetCodeGraphContext',
      'canopy_get_code_graph_context',
      'BuildOrUpdateCodeGraph',
      'mcp__canopy__BuildOrUpdateCodeGraph',
      'canopy_build_or_update_code_graph',
      'QueryCodeGraph',
      'mcp__canopy__QueryCodeGraph',
      'canopy_query_code_graph',
      'SearchCodeGraph',
      'mcp__canopy__SearchCodeGraph',
      'canopy_search_code_graph',
      'ExplainCodeSymbol',
      'mcp__canopy__ExplainCodeSymbol',
      'canopy_explain_code_symbol',
      'GetImpactRadius',
      'mcp__canopy__GetImpactRadius',
      'canopy_get_impact_radius',
      'DetectChangedSymbols',
      'mcp__canopy__DetectChangedSymbols',
      'canopy_detect_changed_symbols',
      'CompareChangeImpact',
      'mcp__canopy__CompareChangeImpact',
      'canopy_compare_change_impact',
      'GetReviewContext',
      'mcp__canopy__GetReviewContext',
      'canopy_get_review_context',
      'mcp__somebrand__GetCodeGraphContext',
      'somebrand_get_code_graph_context',
      'mcp__somebrand__BuildOrUpdateCodeGraph',
      'somebrand_build_or_update_code_graph',
      'mcp__somebrand__QueryCodeGraph',
      'somebrand_query_code_graph',
      'mcp__somebrand__SearchCodeGraph',
      'somebrand_search_code_graph',
      'mcp__somebrand__ExplainCodeSymbol',
      'somebrand_explain_code_symbol',
      'mcp__somebrand__GetImpactRadius',
      'somebrand_get_impact_radius',
      'mcp__somebrand__DetectChangedSymbols',
      'somebrand_detect_changed_symbols',
      'mcp__somebrand__CompareChangeImpact',
      'somebrand_compare_change_impact',
      'mcp__somebrand__GetReviewContext',
      'somebrand_get_review_context',
    ])('maps %s to graph', (toolName) => {
      expect(getToolCategory(toolName)).toBe('graph');
      expect(getPortalChatToolFamily(toolName)).toBe('graph');
    });
  });

  describe('watcher tool aliases → watcher', () => {
    it.each([
      'SearchWatchers',
      'mcp__canopy__SearchWatchers',
      'canopy_search_watchers',
      'SetupWatchers',
      'mcp__canopy__SetupWatchers',
      'canopy_setup_watchers',
      'mcp__canopy_app_advisor__SearchWatchers',
      'app_advisor_search_watchers',
      'mcp__canopy_app_advisor__SetupWatchers',
      'app_advisor_setup_watchers',
      'mcp__canopy_app_advisor__WatchCommand',
      'canopy_app_advisor_watch_command',
      'mcp__somebrand__SearchWatchers',
      'somebrand_search_watchers',
      'mcp__somebrand__SetupWatchers',
      'somebrand_setup_watchers',
      'mcp__somebrand_app_advisor__SearchWatchers',
      'somebrand_app_advisor_search_watchers',
      'mcp__somebrand_app_advisor__SetupWatchers',
      'somebrand_app_advisor_setup_watchers',
    ])('maps %s to watcher', (toolName) => {
      expect(getToolCategory(toolName)).toBe('watcher');
    });
  });

  describe('App Advisor action aliases → appAdvisor', () => {
    it.each([
      'mcp__canopy_app_advisor__SetAutoArchive',
      'canopy_app_advisor_set_auto_archive',
      'mcp__somebrand_app_advisor__SetAutoArchive',
      'somebrand_app_advisor_set_auto_archive',
    ])('counts auto-archive %s with App Advisor tools', (name) => {
      expect(getToolCategory(name)).toBe('appAdvisor');
    });

    it.each([
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
      'mcp__canopy_app_advisor__GetPipelineDebugContext',
      'app_advisor_get_pipeline_debug_context',
      'mcp__canopy_app_advisor__SearchDeferredTools',
      'app_advisor_search_deferred_tools',
      'mcp__canopy_app_advisor__LoadDeferredTools',
      'app_advisor_load_deferred_tools',
      'mcp__somebrand_app_advisor__SearchActions',
      'somebrand_app_advisor_dispatch_action',
      'mcp__somebrand_app_advisor__ReadPipelineYaml',
      'somebrand_app_advisor_get_pipeline_debug_context',
      'mcp__somebrand_app_advisor__SearchDeferredTools',
      'somebrand_app_advisor_load_deferred_tools',
    ])('maps %s to appAdvisor', (toolName) => {
      expect(getToolCategory(toolName)).toBe('appAdvisor');
    });
  });

  describe('pipeline-editor tools → pipelineEditor', () => {
    it.each([
      'mcp__canopy_pipeline_editor__ListPipelines',
      'canopy_pipeline_editor_pipeline_list',
      'mcp__canopy_pipeline_editor__OpenPipeline',
      'canopy_pipeline_editor_pipeline_open',
      'mcp__canopy_pipeline_editor__GetCurrentPipeline',
      'canopy_pipeline_editor_pipeline_get_current',
      'mcp__canopy_pipeline_editor__SetPipelineYaml',
      'canopy_pipeline_editor_pipeline_set_yaml',
      'mcp__canopy_pipeline_editor__SavePipeline',
      'mcp__canopy_pipeline_editor__NavigateToPipelineList',
      'mcp__canopy_pipeline_editor__SearchDeferredTools',
      'canopy_pipeline_editor_search_deferred_tools',
      'mcp__canopy_pipeline_editor__LoadDeferredTools',
      'canopy_pipeline_editor_load_deferred_tools',
      'mcp__somebrand_pipeline_editor__CreatePipeline',
      'somebrand_pipeline_editor_navigation_to_list',
      'mcp__somebrand_pipeline_editor__SearchDeferredTools',
      'somebrand_pipeline_editor_load_deferred_tools',
    ])('maps %s to pipelineEditor', (toolName) => {
      expect(getToolCategory(toolName)).toBe('pipelineEditor');
    });

    it.each([
      'mcp__canopy_pipeline_editor__AskUserQuestion',
      'canopy_pipeline_editor_ask_user_question',
    ])('keeps %s in the shared askUser bucket', (toolName) => {
      expect(getToolCategory(toolName)).toBe('askUser');
    });
  });

  describe('plan-comment tools → plan', () => {
    it.each([
      'RespondToComment',
      'mcp__canopy__RespondToComment',
      'canopy_respond_to_comment',
      'mcp__somebrand__RespondToComment',
      'somebrand_respond_to_comment',
      'GetPlanComments',
      'mcp__canopy__GetPlanComments',
      'canopy_get_plan_comments',
      'mcp__somebrand__GetPlanComments',
      'somebrand_get_plan_comments',
    ])('maps %s to plan', (toolName) => {
      expect(getToolCategory(toolName)).toBe('plan');
    });

    it.each([
      'RespondToComment',
      'canopy_respond_to_comment',
      'GetPlanComments',
      'canopy_get_plan_comments',
    ])('maps %s to the plan tool family', (toolName) => {
      expect(getPortalChatToolFamily(toolName)).toBe('plan');
    });

    it('buckets a plan-comment tool_use into plan in computeTurnSummary', () => {
      const messages: TurnMessage[] = [
        {
          id: 'assistant-1',
          role: 'assistant',
          timestamp: 10,
          blocks: [
            {
              type: 'tool_use',
              toolUseId: 'tool-1',
              toolName: 'mcp__canopy__RespondToComment',
              input: '{"threadId":"t-1","body":"ok"}',
            },
            {
              type: 'tool_use',
              toolUseId: 'tool-2',
              toolName: 'canopy_get_plan_comments',
              input: '{}',
            },
          ],
        },
      ];

      const counts = computeTurnSummary(messages);
      expect(counts.plan).toBe(2);
      expect(counts.writeEdit).toBe(0);
      expect(counts.other).toBe(0);
    });
  });

  describe('review-comment tools (code review) → plan', () => {
    it.each([
      'RespondToComment',
      'mcp__canopy__RespondToComment',
      'canopy_respond_to_comment',
      'mcp__somebrand__RespondToComment',
      'somebrand_respond_to_comment',
      'GetReviewComments',
      'mcp__canopy__GetReviewComments',
      'canopy_get_review_comments',
      'mcp__somebrand__GetReviewComments',
      'somebrand_get_review_comments',
    ])('maps %s to plan', (toolName) => {
      expect(getToolCategory(toolName)).toBe('plan');
    });

    it.each([
      'RespondToComment',
      'canopy_respond_to_comment',
      'GetReviewComments',
      'canopy_get_review_comments',
    ])('maps %s to the plan tool family', (toolName) => {
      expect(getPortalChatToolFamily(toolName)).toBe('plan');
    });

    it('buckets a review-comment tool_use into plan in computeTurnSummary', () => {
      const messages: TurnMessage[] = [
        {
          id: 'assistant-1',
          role: 'assistant',
          timestamp: 10,
          blocks: [
            {
              type: 'tool_use',
              toolUseId: 'tool-1',
              toolName: 'mcp__canopy__RespondToComment',
              input: '{"threadId":"t-1","body":"ok"}',
            },
            {
              type: 'tool_use',
              toolUseId: 'tool-2',
              toolName: 'canopy_get_review_comments',
              input: '{}',
            },
          ],
        },
      ];

      const counts = computeTurnSummary(messages);
      expect(counts.plan).toBe(2);
      expect(counts.writeEdit).toBe(0);
      expect(counts.other).toBe(0);
    });
  });

  describe('Canopy-injected worktree action tool family', () => {
    it.each([
      'SearchActions',
      'mcp__canopy__SearchActions',
      'canopy_search_actions',
      'ReadPipelineYaml',
      'mcp__canopy__ReadPipelineYaml',
      'canopy_read_pipeline_yaml',
      'DispatchAction',
      'mcp__canopy__DispatchAction',
      'canopy_dispatch_action',
      'SetAutoArchive',
      'mcp__canopy__SetAutoArchive',
      'canopy_set_auto_archive',
      'SetBaseBranch',
      'mcp__canopy__SetBaseBranch',
      'canopy_set_base_branch',
      'ArchiveChat',
      'mcp__canopy__ArchiveChat',
      'canopy_archive_chat',
      'GetGitPreferences',
      'mcp__canopy__GetGitPreferences',
      'canopy_get_git_preferences',
      'GetGitHubPullRequestStatus',
      'mcp__canopy__GetGitHubPullRequestStatus',
      'canopy_get_github_pull_request_status',
      'SaveMemory',
      'mcp__canopy__SaveMemory',
      'canopy_save_memory',
      'SearchMemory',
      'mcp__canopy__SearchMemory',
      'canopy_search_memory',
      'ReadMemory',
      'mcp__canopy__ReadMemory',
      'canopy_read_memory',
      'mcp__somebrand__SearchActions',
      'somebrand_search_actions',
      'mcp__somebrand__ReadPipelineYaml',
      'somebrand_read_pipeline_yaml',
      'mcp__somebrand__DispatchAction',
      'somebrand_dispatch_action',
      'mcp__somebrand__SetAutoArchive',
      'somebrand_set_auto_archive',
      'mcp__somebrand__SetBaseBranch',
      'somebrand_set_base_branch',
      'mcp__somebrand__ArchiveChat',
      'somebrand_archive_chat',
      'mcp__somebrand__GetGitPreferences',
      'somebrand_get_git_preferences',
      'mcp__somebrand__GetGitHubPullRequestStatus',
      'somebrand_get_github_pull_request_status',
      'mcp__somebrand__SaveMemory',
      'somebrand_save_memory',
      'mcp__somebrand__SearchMemory',
      'somebrand_search_memory',
      'mcp__somebrand__ReadMemory',
      'somebrand_read_memory',
      'ShowFiles',
      'mcp__canopy__ShowFiles',
      'canopy_show_files',
      'GetFileComments',
      'mcp__canopy__GetFileComments',
      'canopy_get_file_comments',
      'RespondToFileComment',
      'mcp__canopy__RespondToFileComment',
      'canopy_respond_to_file_comment',
      'AddFeedEntry',
      'mcp__canopy__AddFeedEntry',
      'canopy_add_feed_entry',
      'SearchFeedEntries',
      'mcp__canopy__SearchFeedEntries',
      'canopy_search_feed_entries',
      'UpdateFeedEntry',
      'mcp__canopy__UpdateFeedEntry',
      'canopy_update_feed_entry',
    ])('maps %s to the canopy tool family', (toolName) => {
      expect(getPortalChatToolFamily(toolName)).toBe('canopy');
    });

    it('rolls file presentation and comment tools into one Canopy turn-summary chip', () => {
      const messages: TurnMessage[] = [
        {
          id: 'assistant-1',
          role: 'assistant',
          timestamp: Date.parse('2026-07-27T00:00:00.000Z'),
          blocks: [
            {
              type: 'tool_use',
              toolUseId: 'show-files',
              toolName: 'canopy_show_files',
              input: '{}',
            },
            {
              type: 'tool_use',
              toolUseId: 'get-comments',
              toolName: 'mcp__canopy__GetFileComments',
              input: '{}',
            },
            {
              type: 'tool_use',
              toolUseId: 'respond',
              toolName: 'RespondToFileComment',
              input: '{}',
            },
          ],
        },
      ];

      const counts = computeTurnSummary(messages);
      expect(counts.canopy).toBe(3);
      expect(counts.other).toBe(0);
      expect(counts.mcp).toBe(0);
    });

    it('rolls save, search, and read memory into the Canopy turn-summary count', () => {
      const messages: TurnMessage[] = [
        {
          id: 'assistant-memory',
          role: 'assistant',
          timestamp: Date.parse('2026-08-05T00:00:00.000Z'),
          blocks: [
            {
              type: 'tool_use',
              toolUseId: 'save-memory',
              toolName: 'mcp__canopy__SaveMemory',
              input: '{}',
            },
            {
              type: 'tool_use',
              toolUseId: 'search-memory',
              toolName: 'canopy_search_memory',
              input: '{}',
            },
            {
              type: 'tool_use',
              toolUseId: 'read-memory',
              toolName: 'mcp__canopy__ReadMemory',
              input: '{}',
            },
          ],
        },
      ];

      const counts = computeTurnSummary(messages);
      expect(counts.canopy).toBe(3);
      expect(counts.other).toBe(0);
      expect(counts.mcp).toBe(0);
    });

    it('rolls Cursor and App Advisor Ledger calls into the Canopy turn-summary count', () => {
      const ledgerToolNames = [
        'canopy: AddFeedEntry',
        'canopy: SearchFeedEntries',
        'canopy: UpdateFeedEntry',
        'mcp__canopy_app_advisor__AddFeedEntry',
        'canopy_app_advisor_search_feed_entries',
        'mcp__canopy_app_advisor__UpdateFeedEntry',
      ];
      const messages: TurnMessage[] = [
        {
          id: 'assistant-ledger',
          role: 'assistant',
          timestamp: Date.parse('2026-09-29T00:00:00.000Z'),
          blocks: ledgerToolNames.map(
            (toolName, index): TurnBlock => ({
              type: 'tool_use',
              toolUseId: `ledger-${index}`,
              toolName,
              input: '{}',
            }),
          ),
        },
      ];

      const counts = computeTurnSummary(messages);
      expect(counts.canopy).toBe(ledgerToolNames.length);
      expect(counts.appAdvisor).toBe(0);
      expect(counts.other).toBe(0);
      expect(counts.mcp).toBe(0);
    });

    it.each([
      'mcp__canopy__GetDelegateOutput',
      'canopy_get_delegate_output',
      'mcp__canopy__ListDelegates',
      'canopy_list_delegates',
      'ListDelegates',
      'mcp__canopy__InspectDelegate',
      'canopy_inspect_delegate',
      'InspectDelegate',
      'mcp__canopy__StopDelegate',
      'canopy_stop_delegate',
      'StopDelegate',
      'mcp__canopy__MessageDelegate',
      'canopy_message_delegate',
      'mcp__canopy__ManageDelegateWorktree',
      'canopy_manage_delegate_worktree',
      'canopy_manage_delegate',
      'mcp__canopy__RequestSteering',
      'canopy_request_steering',
    ])(
      'groups the %s delegation tool with the Canopy app tools',
      (toolName) => {
        expect(getToolCategory(toolName)).toBe('canopy');
        expect(getPortalChatToolFamily(toolName)).toBe('canopy');
        const counts = computeTurnSummary([
          {
            id: 'assistant-delegation-tool',
            role: 'assistant',
            timestamp: Date.parse('2026-09-29T00:00:00.000Z'),
            blocks: [
              {
                type: 'tool_use',
                toolUseId: 'delegation-tool',
                toolName,
                input: '{}',
              },
            ],
          },
        ]);
        expect(counts.canopy).toBe(1);
        expect(counts.other).toBe(0);
        expect(counts.mcp).toBe(0);
        expect(counts.agent).toBe(0);
      },
    );

    it.each(['mcp__canopy__DelegateTask', 'canopy_spawn_delegate'])(
      'counts the %s spawn as agent work',
      (toolName) => {
        expect(getToolCategory(toolName)).toBe('agent');
        expect(getPortalChatToolFamily(toolName)).toBe('agent');
      },
    );

    it.each([
      'WatchDelegates',
      'mcp__canopy__WatchDelegates',
      'canopy_watch_delegates',
      'mcp__canopy__WaitDelegates',
      'canopy_wait_delegates',
    ])('groups the %s delegate watch with the Canopy app tools', (toolName) => {
      expect(getToolCategory(toolName)).toBe('canopy');
      expect(getPortalChatToolFamily(toolName)).toBe('canopy');
      const counts = computeTurnSummary([
        {
          id: 'assistant-watch-delegates',
          role: 'assistant',
          timestamp: Date.parse('2026-09-26T00:00:00.000Z'),
          blocks: [
            {
              type: 'tool_use',
              toolUseId: 'watch-delegates',
              toolName,
              input: '{}',
            },
          ],
        },
      ]);
      expect(counts.canopy).toBe(1);
      expect(counts.other).toBe(0);
      expect(counts.mcp).toBe(0);
    });

    it.each([
      'SearchWatchers',
      'mcp__canopy__SearchWatchers',
      'canopy_search_watchers',
      'SetupWatchers',
      'mcp__canopy__SetupWatchers',
      'canopy_setup_watchers',
      'mcp__canopy_app_advisor__SearchWatchers',
      'app_advisor_search_watchers',
      'mcp__canopy_app_advisor__SetupWatchers',
      'app_advisor_setup_watchers',
      'mcp__canopy_app_advisor__WatchCommand',
      'canopy_app_advisor_watch_command',
      'mcp__somebrand__SearchWatchers',
      'somebrand_search_watchers',
      'mcp__somebrand__SetupWatchers',
      'somebrand_setup_watchers',
      'mcp__somebrand_app_advisor__SearchWatchers',
      'somebrand_app_advisor_search_watchers',
      'mcp__somebrand_app_advisor__SetupWatchers',
      'somebrand_app_advisor_setup_watchers',
    ])('maps %s to the watcher tool family', (toolName) => {
      expect(getPortalChatToolFamily(toolName)).toBe('watcher');
    });

    it('keeps App Advisor action tools in the app-advisor family', () => {
      expect(
        getPortalChatToolFamily('mcp__canopy_app_advisor__SearchActions'),
      ).toBe('app-advisor');
      expect(getPortalChatToolFamily('app_advisor_search_actions')).toBe(
        'app-advisor',
      );
      expect(
        getPortalChatToolFamily('mcp__canopy_app_advisor__GetCurrentUiState'),
      ).toBe('app-advisor');
      expect(getPortalChatToolFamily('app_advisor_get_current_ui_state')).toBe(
        'app-advisor',
      );
      expect(
        getPortalChatToolFamily('mcp__canopy_app_advisor__DispatchAction'),
      ).toBe('app-advisor');
      expect(getPortalChatToolFamily('app_advisor_dispatch_action')).toBe(
        'app-advisor',
      );
      expect(
        getPortalChatToolFamily('mcp__canopy_app_advisor__ReadPipelineYaml'),
      ).toBe('app-advisor');
      expect(getPortalChatToolFamily('app_advisor_read_pipeline_yaml')).toBe(
        'app-advisor',
      );
      expect(
        getPortalChatToolFamily(
          'mcp__canopy_app_advisor__GetPipelineDebugContext',
        ),
      ).toBe('app-advisor');
      expect(
        getPortalChatToolFamily('app_advisor_get_pipeline_debug_context'),
      ).toBe('app-advisor');
      expect(
        getPortalChatToolFamily('mcp__somebrand_app_advisor__SearchActions'),
      ).toBe('app-advisor');
      expect(
        getPortalChatToolFamily('somebrand_app_advisor_dispatch_action'),
      ).toBe('app-advisor');
    });
  });

  describe('all built-in Canopy alias categories', () => {
    it('aggregates into the expected categories', () => {
      const aliasCategories = {
        AskUserQuestion: 'askUser',
        mcp__canopy__AskUserQuestion: 'askUser',
        canopy_ask_user_question: 'askUser',
        request_user_input: 'askUser',
        GetScriptOutput: 'scriptOutput',
        mcp__canopy__GetScriptOutput: 'scriptOutput',
        canopy_get_script_output: 'scriptOutput',
        ReadPipelineYaml: 'canopy',
        mcp__canopy__ReadPipelineYaml: 'canopy',
        canopy_read_pipeline_yaml: 'canopy',
        GetGitPreferences: 'canopy',
        mcp__canopy__GetGitPreferences: 'canopy',
        canopy_get_git_preferences: 'canopy',
        SaveMemory: 'canopy',
        mcp__canopy__SaveMemory: 'canopy',
        canopy_save_memory: 'canopy',
        SearchMemory: 'canopy',
        mcp__canopy__SearchMemory: 'canopy',
        canopy_search_memory: 'canopy',
        ReadMemory: 'canopy',
        mcp__canopy__ReadMemory: 'canopy',
        canopy_read_memory: 'canopy',
      } as const;
      for (const [name, expected] of Object.entries(aliasCategories)) {
        expect(getToolCategory(name)).toBe(expected);
      }
    });
  });

  describe('other categories still work', () => {
    it('maps Bash to bash', () => {
      expect(getToolCategory('Bash')).toBe('bash');
    });

    it('maps the Windows PowerShell tool to bash', () => {
      expect(getToolCategory('PowerShell')).toBe('bash');
    });

    it('maps Read to read', () => {
      expect(getToolCategory('Read')).toBe('read');
    });

    it('maps unrecognised names to other', () => {
      expect(getToolCategory('UnknownTool')).toBe('other');
    });

    it('maps generic mcp__server__Tool (non-Canopy) to mcp', () => {
      expect(getToolCategory('mcp__somethingelse__Tool')).toBe('mcp');
    });

    it('keeps CUA REPL calls in the general MCP audit category', () => {
      expect(getToolCategory('mcp__cua_repl__js')).toBe('mcp');
      expect(getToolCategory('mcp__cua_repl__js_reset')).toBe('mcp');
      expect(getToolCategory('mcp__other_server__js')).toBe('mcp');
    });

    it('groups both CUA REPL calls as Computer Use in turn summaries', () => {
      const counts = computeTurnSummary([
        {
          id: 'assistant-computer-use',
          role: 'assistant',
          timestamp: 1,
          blocks: [
            {
              type: 'tool_use',
              toolUseId: 'js',
              toolName: 'mcp__cua_repl__js',
              input: '{}',
            },
            {
              type: 'tool_use',
              toolUseId: 'reset',
              toolName: 'mcp__cua_repl__js_reset',
              input: '{}',
            },
          ],
        },
      ]);

      expect(counts.computerUse).toBe(2);
      expect(counts.mcp).toBe(0);
    });
  });

  describe('parseMcpToolName remains MCP-only and skips canopy namespace', () => {
    it('returns null for canopy-namespaced MCP names', () => {
      expect(parseMcpToolName('mcp__canopy__AskUserQuestion')).toBeNull();
      expect(parseMcpToolName('mcp__canopy__GetScriptOutput')).toBeNull();
      expect(parseMcpToolName('mcp__canopy__ReadPipelineYaml')).toBeNull();
      expect(parseMcpToolName('mcp__canopy__SearchActions')).toBeNull();
      expect(parseMcpToolName('mcp__canopy__DispatchAction')).toBeNull();
      expect(parseMcpToolName('mcp__canopy__SearchWatchers')).toBeNull();
      expect(parseMcpToolName('mcp__canopy__SetupWatchers')).toBeNull();
    });

    it('parses regular MCP tool names', () => {
      expect(parseMcpToolName('mcp__someserver__tool')).toEqual({
        server: 'someserver',
        tool: 'tool',
      });
    });

    it('returns null for non-mcp prefixes', () => {
      expect(parseMcpToolName('Bash')).toBeNull();
      expect(parseMcpToolName('canopy_ask_user_question')).toBeNull();
    });

    it('strips the appdyn- prefix and trailing digest', () => {
      expect(
        parseMcpToolName('mcp__appdyn-myserver--0123456789abcdef__mytool'),
      ).toEqual({ server: 'myserver', tool: 'mytool' });
    });

    it('strips the appproxy- prefix and trailing digest', () => {
      expect(
        parseMcpToolName(
          'mcp__appproxy-github--fedcba9876543210__create_issue',
        ),
      ).toEqual({
        server: 'github',
        tool: 'create_issue',
      });
    });

    it('strips the appplugin- prefix and trailing digest', () => {
      expect(
        parseMcpToolName(
          'mcp__appplugin-linear--a1b2c3d4e5f60718__list_issues',
        ),
      ).toEqual({
        server: 'linear',
        tool: 'list_issues',
      });
    });

    it('renders proxied MCPs identically to non-proxied standalone MCPs', () => {
      const proxied = parseMcpToolName(
        'mcp__appproxy-github--fedcba9876543210__create_issue',
      );
      const standalone = parseMcpToolName('mcp__github__create_issue');
      expect(proxied).toEqual(standalone);
    });

    it('renders plugin MCPs identically to non-prefixed MCPs', () => {
      const plugin = parseMcpToolName(
        'mcp__appplugin-linear--a1b2c3d4e5f60718__list_issues',
      );
      const standalone = parseMcpToolName('mcp__linear__list_issues');
      expect(plugin).toEqual(standalone);
    });
  });

  describe('normalizeCanopyMcpServerDisplayName', () => {
    it('strips appdyn- prefix and digest', () => {
      expect(
        normalizeCanopyMcpServerDisplayName('appdyn-foo--0123456789abcdef'),
      ).toBe('foo');
    });

    it('strips appproxy- prefix and digest', () => {
      expect(
        normalizeCanopyMcpServerDisplayName('appproxy-foo--fedcba9876543210'),
      ).toBe('foo');
    });

    it('strips appplugin- prefix and digest', () => {
      expect(
        normalizeCanopyMcpServerDisplayName('appplugin-foo--a1b2c3d4e5f60718'),
      ).toBe('foo');
    });

    it('continues to strip historical full identity suffixes', () => {
      expect(
        normalizeCanopyMcpServerDisplayName(
          'appproxy-production-hub-mcp--8130e671-b9ad-408e-b2f2-3e7563a6a8a9-bc90c68e-1c34-426b-858d-7cda9af0fc85',
        ),
      ).toBe('production-hub-mcp');
    });

    it('returns the raw friendly name when no `--` separator is present', () => {
      expect(normalizeCanopyMcpServerDisplayName('appplugin-foo')).toBe('foo');
    });

    it('leaves non-Canopy server names unchanged', () => {
      expect(normalizeCanopyMcpServerDisplayName('plain-server')).toBe(
        'plain-server',
      );
    });
  });
});

describe('turn-utils turn grouping', () => {
  it('repairs a timer-less completed terminal turn when the next user turn starts', () => {
    const grouped = groupIntoTurns([
      {
        id: 'user-1',
        role: 'user',
        timestamp: 10,
        blocks: [{ type: 'text', text: 'what am i looking at now?' }],
      },
      {
        id: 'assistant-1',
        role: 'assistant',
        timestamp: 20,
        blocks: [
          {
            type: 'tool_use',
            toolUseId: 'tool-1',
            toolName: 'mcp__canopy_app_advisor__GetCurrentUiState',
            input: '{}',
          },
        ],
      },
      {
        id: 'assistant-2',
        role: 'assistant',
        timestamp: 30,
        blocks: [{ type: 'text', text: 'Here is the screen.' }],
      },
      {
        id: 'user-2',
        role: 'user',
        timestamp: 40,
        blocks: [{ type: 'text', text: 'next request' }],
      },
    ]);

    expect(grouped).toHaveLength(2);
    const first = grouped[0];
    expect(first?.kind).toBe('turn-group');
    if (first?.kind !== 'turn-group') {
      throw new Error('Expected a turn group');
    }
    expect(first.isComplete).toBe(true);
    expect(first.timerMessage.id).toBe('user-1-implicit-turn-timer');
    expect(first.timerMessage.blocks[0]).toEqual({
      type: 'turn_timer',
      completedAt: 30,
    });
    expect(grouped[1]).toMatchObject({
      kind: 'standalone',
      message: { id: 'user-2' },
    });
  });

  it('leaves a trailing timer-less turn incomplete', () => {
    const grouped = groupIntoTurns([
      {
        id: 'user-1',
        role: 'user',
        timestamp: 10,
        blocks: [{ type: 'text', text: 'still running?' }],
      },
      {
        id: 'assistant-1',
        role: 'assistant',
        timestamp: 20,
        blocks: [{ type: 'thinking', text: 'Working' }],
      },
    ]);

    expect(grouped).toEqual([
      {
        kind: 'standalone',
        message: {
          id: 'user-1',
          role: 'user',
          timestamp: 10,
          blocks: [{ type: 'text', text: 'still running?' }],
        },
      },
      {
        kind: 'standalone',
        message: {
          id: 'assistant-1',
          role: 'assistant',
          timestamp: 20,
          blocks: [{ type: 'thinking', text: 'Working' }],
        },
      },
    ]);
  });

  it('treats legacy Claude terminal result metadata as a completed turn boundary', () => {
    const grouped = groupIntoTurns([
      {
        id: 'user-1',
        role: 'user',
        timestamp: 10,
        blocks: [{ type: 'text', text: 'watch this run' }],
      },
      {
        id: 'assistant-1',
        role: 'assistant',
        timestamp: 20,
        blocks: [
          {
            type: 'tool_use',
            toolUseId: 'tool-1',
            toolName: 'mcp__canopy_app_advisor__DispatchAction',
            input: '{"action":{"type":"pipeline.run"}}',
          },
        ],
      },
      {
        id: 'legacy-result',
        role: 'system',
        timestamp: 30,
        blocks: [
          {
            type: 'text',
            text: 'Claude Code result metadata\nStatus: success\nUsage: input_tokens: 10',
          },
        ],
      },
    ]);

    expect(grouped).toHaveLength(1);
    const first = grouped[0];
    expect(first?.kind).toBe('turn-group');
    if (first?.kind !== 'turn-group') {
      throw new Error('Expected a turn group');
    }
    expect(first.isComplete).toBe(true);
    expect(first.timerMessage.blocks[0]).toEqual({
      type: 'turn_timer',
      completedAt: 30,
    });
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
    const counts = computeTurnSummary([
      {
        id: 'assistant-actions',
        role: 'assistant',
        timestamp: 1,
        blocks: [
          {
            type: 'tool_use',
            toolUseId: 'ordinary-search',
            toolName: 'canopy_search_actions',
            input: JSON.stringify({ actionType: type }),
          },
          {
            type: 'tool_use',
            toolUseId: 'advisor-search',
            toolName: 'app_advisor_search_actions',
            input: JSON.stringify({ actionType: type }),
          },
          {
            type: 'tool_use',
            toolUseId: 'ordinary',
            toolName: 'canopy_dispatch_action',
            input: JSON.stringify({ action: { type } }),
          },
          {
            type: 'tool_use',
            toolUseId: 'advisor',
            toolName: 'app_advisor_dispatch_action',
            input: JSON.stringify({ action: { type } }),
          },
        ],
      },
    ]);
    expect(counts.canopy).toBe(2);
    expect(counts.appAdvisor).toBe(2);
    expect(counts.watcher).toBe(0);
    expect(counts.other).toBe(0);
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
    const counts = computeTurnSummary([
      {
        id: 'assistant-watchers',
        role: 'assistant',
        timestamp: 1,
        blocks: [
          'canopy_search_watchers',
          'canopy_setup_watchers',
          'app_advisor_search_watchers',
          'app_advisor_setup_watchers',
        ].map((toolName) => ({
          type: 'tool_use',
          toolUseId: toolName,
          toolName,
          input: JSON.stringify({
            trigger,
            watchers: [{ trigger, target: {} }],
          }),
        })),
      },
    ]);
    expect(counts.watcher).toBe(4);
    expect(counts.canopy).toBe(0);
    expect(counts.appAdvisor).toBe(0);
    expect(counts.other).toBe(0);
  });
});

it('groups capability recommendations with app tools', () => {
  expect(getToolCategory('canopy_show_capabilities')).toBe('canopy');
});
