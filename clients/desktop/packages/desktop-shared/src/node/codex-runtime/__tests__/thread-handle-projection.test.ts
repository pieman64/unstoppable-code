import {
  codexTranscriptEventsHaveAgentActivity,
  isForeignThreadTokenUsageEvent,
  projectCodexRuntimeEvent,
} from '../thread-handle';

describe('projectCodexRuntimeEvent', () => {
  it('preserves async metadata without appending its fallback text twice', () => {
    const questions = [{ title: 'Which scope?', options: ['Focused', 'Full'] }];
    const text = 'Which scope?\n- Focused\n- Full';
    expect(
      projectCodexRuntimeEvent({
        method: 'item/completed',
        params: {
          item: {
            id: 'question',
            type: 'agentMessage',
            text,
            delivery: 'async',
            questions,
          },
        },
      }),
    ).toMatchObject({ item: { text, delivery: 'async', questions } });
  });

  it('keeps question-only async messages readable through the completed-text gate', () => {
    expect(
      projectCodexRuntimeEvent({
        method: 'item/completed',
        params: {
          item: {
            id: 'question',
            type: 'agentMessage',
            text: '',
            delivery: 'async',
            questions: [
              { title: 'Which scope?', options: ['Focused', 'Full'] },
            ],
          },
        },
      }),
    ).toMatchObject({
      item: { type: 'agent_message', text: 'Which scope?\n- Focused\n- Full' },
    });
  });
  it.each([
    [
      {
        type: 'functionCallOutput',
        name: 'tests',
        namespace: 'tools',
        output: 'Passed',
      },
      {
        type: 'function_call_output',
        name: 'tests',
        namespace: 'tools',
        output: 'Passed',
      },
    ],
    [
      {
        type: 'webSearch',
        query: '',
        action: { type: 'open_page', url: 'https://example.com' },
      },
      { action: { type: 'open_page', url: 'https://example.com' } },
    ],
    [
      { type: 'enteredReviewMode', review: 'current changes' },
      { type: 'entered_review_mode', review: 'current changes' },
    ],
    [
      {
        type: 'subAgentActivity',
        kind: 'completed',
        agentThreadId: 'child',
        agentPath: '/root/tests',
      },
      {
        type: 'sub_agent_activity',
        kind: 'completed',
        agent_thread_id: 'child',
        agent_path: '/root/tests',
      },
    ],
  ])('preserves supported display fields for %j', (item, expected) => {
    expect(
      projectCodexRuntimeEvent({
        method: 'item/completed',
        params: { item: { id: 'display-item', ...item } },
      }),
    ).toMatchObject({ item: expected });
  });

  it('preserves text alongside audio and future dynamic content types', () => {
    expect(
      projectCodexRuntimeEvent({
        method: 'item/completed',
        params: {
          item: {
            id: 'mixed',
            type: 'dynamicToolCall',
            tool: 'test',
            contentItems: [
              { type: 'inputText', text: 'Keep this evidence' },
              { type: 'inputAudio', audioUrl: 'data:audio/wav;base64,AAAA' },
              { type: 'futureContent' },
            ],
          },
        },
      }),
    ).toMatchObject({
      item: {
        content_items: [
          { type: 'inputText', text: 'Keep this evidence' },
          { type: 'inputAudio', audioUrl: 'data:audio/wav;base64,AAAA' },
          { type: 'inputText', text: '[unsupported output omitted]' },
        ],
      },
    });
  });
  it('projects completed items into the shared Codex transcript shape', () => {
    expect(
      projectCodexRuntimeEvent({
        method: 'item/completed',
        params: {
          threadId: 'thread-1',
          item: {
            id: 'item-1',
            type: 'agentMessage',
            text: 'done',
          },
        },
      }),
    ).toEqual({
      type: 'item.completed',
      threadId: 'thread-1',
      item: {
        id: 'item-1',
        type: 'agent_message',
        text: 'done',
        phase: '',
      },
    });
  });

  it('normalizes command output fields used by pipeline transcript consumers', () => {
    expect(
      projectCodexRuntimeEvent({
        method: 'item/completed',
        params: {
          threadId: 'thread-1',
          item: {
            id: 'command-1',
            type: 'commandExecution',
            command: 'npm test',
            aggregatedOutput: 'all tests passed',
            status: 'completed',
            exitCode: 0,
          },
        },
      }),
    ).toMatchObject({
      type: 'item.completed',
      item: {
        id: 'command-1',
        type: 'command_execution',
        command: 'npm test',
        aggregated_output: 'all tests passed',
        status: 'completed',
        exit_code: 0,
      },
    });
  });

  it('preserves file-move destinations for approval evaluation', () => {
    expect(
      projectCodexRuntimeEvent({
        method: 'item/completed',
        params: {
          item: {
            id: 'file-1',
            type: 'fileChange',
            status: 'inProgress',
            changes: [
              {
                path: '/workspace/source.ts',
                diff: '',
                kind: {
                  type: 'update',
                  move_path: '/workspace/protected/destination.ts',
                },
              },
            ],
          },
        },
      }),
    ).toMatchObject({
      item: {
        type: 'file_change',
        changes: [
          {
            path: '/workspace/source.ts',
            kind: 'update',
            movePath: '/workspace/protected/destination.ts',
          },
        ],
      },
    });
  });

  it('projects native context compaction items into the shared transcript shape', () => {
    expect(
      projectCodexRuntimeEvent({
        method: 'item/completed',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          item: {
            id: 'compact-1',
            type: 'contextCompaction',
          },
        },
      }),
    ).toEqual({
      type: 'item.completed',
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: {
        id: 'compact-1',
        type: 'context_compaction',
      },
    });
  });

  it('projects generated and viewed images without persisting base64 payloads', () => {
    expect(
      projectCodexRuntimeEvent({
        method: 'item/completed',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          item: {
            id: 'image-1',
            type: 'imageGeneration',
            status: 'completed',
            revisedPrompt: 'A luminous tree above a midnight ocean',
            result: 'large-base64-payload',
            failure: null,
            savedPath: '/Users/example/.codex/generated_images/image-1.png',
          },
        },
      }),
    ).toEqual({
      type: 'item.completed',
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: {
        id: 'image-1',
        type: 'image_generation',
        status: 'completed',
        revised_prompt: 'A luminous tree above a midnight ocean',
        saved_path: '/Users/example/.codex/generated_images/image-1.png',
      },
    });

    expect(
      projectCodexRuntimeEvent({
        method: 'item/completed',
        params: {
          item: {
            id: 'image-view-1',
            type: 'imageView',
            path: '/Users/example/art.png',
          },
        },
      }),
    ).toMatchObject({
      item: {
        id: 'image-view-1',
        type: 'image_view',
        path: '/Users/example/art.png',
      },
    });
  });

  it('normalizes reasoning and dynamic-tool payload fields', () => {
    expect(
      projectCodexRuntimeEvent({
        method: 'item/completed',
        params: {
          item: {
            id: 'reasoning-1',
            type: 'reasoning',
            content: ['first', 'second'],
          },
        },
      }),
    ).toMatchObject({
      item: {
        id: 'reasoning-1',
        type: 'reasoning',
        text: 'first\nsecond',
      },
    });

    expect(
      projectCodexRuntimeEvent({
        method: 'item/completed',
        params: {
          item: {
            id: 'tool-1',
            type: 'dynamicToolCall',
            namespace: 'canopy',
            tool: 'inspect',
            arguments: { target: 'file.ts' },
            status: 'completed',
            contentItems: [{ type: 'inputText', text: 'done' }],
            success: true,
          },
        },
      }),
    ).toMatchObject({
      item: {
        id: 'tool-1',
        type: 'dynamic_tool_call',
        namespace: 'canopy',
        tool: 'inspect',
        arguments: { target: 'file.ts' },
        status: 'completed',
        content_items: [{ type: 'inputText', text: 'done' }],
        success: true,
      },
    });
  });

  it('projects token usage notifications into the canonical snake_case shape', () => {
    expect(
      projectCodexRuntimeEvent({
        method: 'thread/tokenUsage/updated',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          tokenUsage: {
            total: {
              totalTokens: 200,
              inputTokens: 120,
              cachedInputTokens: 30,
              outputTokens: 80,
              reasoningOutputTokens: 10,
            },
            last: {
              totalTokens: 120,
              inputTokens: 80,
              cachedInputTokens: 16,
              outputTokens: 40,
              reasoningOutputTokens: 8,
            },
            modelContextWindow: 200000,
          },
        },
      }),
    ).toMatchObject({
      type: 'thread.token_usage.updated',
      usage: {
        context_tokens: 120,
        context_window: 200000,
        input_tokens: 80,
        cached_input_tokens: 16,
        output_tokens: 40,
        reasoning_output_tokens: 8,
        cumulative_input_tokens: 120,
        cumulative_cached_input_tokens: 30,
        cumulative_output_tokens: 80,
        cumulative_reasoning_output_tokens: 10,
      },
    });
  });

  it('omits the raw tokenUsage payload from projected usage events', () => {
    const projected = projectCodexRuntimeEvent({
      method: 'thread/tokenUsage/updated',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        tokenUsage: {
          last: { totalTokens: 120, inputTokens: 80 },
          modelContextWindow: 200000,
        },
      },
    });

    // Consumers read `usage`; carrying the raw camelCase payload too would
    // duplicate the numbers on every streamed transcript line.
    expect(projected).not.toHaveProperty('tokenUsage');
    expect(projected).toEqual({
      type: 'thread.token_usage.updated',
      threadId: 'thread-1',
      turnId: 'turn-1',
      usage: {
        context_tokens: 120,
        context_window: 200000,
        input_tokens: 80,
      },
    });
  });

  it('projects token usage notifications without a per-turn breakdown as-is', () => {
    expect(
      projectCodexRuntimeEvent({
        method: 'thread/tokenUsage/updated',
        params: {
          threadId: 'thread-1',
          tokenUsage: { modelContextWindow: 200000 },
        },
      }),
    ).toMatchObject({
      type: 'thread.token_usage.updated',
      usage: { context_window: 200000 },
    });
  });

  it('projects failed terminal turns for failure classification', () => {
    expect(
      projectCodexRuntimeEvent({
        method: 'turn/completed',
        params: {
          threadId: 'thread-1',
          turn: {
            id: 'turn-1',
            status: 'failed',
            error: {
              message: 'unauthorized',
              codexErrorInfo: { unauthorized: null },
            },
          },
        },
      }),
    ).toMatchObject({
      type: 'turn.failed',
      error: {
        message: 'unauthorized',
      },
    });
  });

  it('flags token usage notifications from other threads as foreign', () => {
    const subagentUsage = {
      method: 'thread/tokenUsage/updated',
      params: { threadId: 'subagent-thread', tokenUsage: {} },
    };
    expect(isForeignThreadTokenUsageEvent(subagentUsage, 'root-thread')).toBe(
      true,
    );
    expect(
      isForeignThreadTokenUsageEvent(
        {
          method: 'thread/tokenUsage/updated',
          params: { threadId: 'root-thread', tokenUsage: {} },
        },
        'root-thread',
      ),
    ).toBe(false);
    // A usage notification with no thread attribution cannot be proven to be
    // the root thread's, so it is treated as foreign — matching the guard the
    // handle itself applies before recording root usage.
    expect(
      isForeignThreadTokenUsageEvent(
        { method: 'thread/tokenUsage/updated', params: {} },
        'root-thread',
      ),
    ).toBe(true);
    // Non-usage notifications from subagent threads still flow through: the
    // pipeline transcript intentionally shows subagent activity.
    expect(
      isForeignThreadTokenUsageEvent(
        {
          method: 'item/completed',
          params: { threadId: 'subagent-thread', item: {} },
        },
        'root-thread',
      ),
    ).toBe(false);
  });

  it('counts semantic output and tool items but ignores lifecycle events', () => {
    expect(
      codexTranscriptEventsHaveAgentActivity([
        { type: 'thread.started', thread_id: 'thread-1' },
        { type: 'turn.started', turn_id: 'turn-1' },
        { type: 'turn.failed', error: { message: 'usage exhausted' } },
      ]),
    ).toBe(false);

    expect(
      codexTranscriptEventsHaveAgentActivity([
        {
          type: 'item.completed',
          item: { type: 'agent_message', text: 'Working on it.' },
        },
      ]),
    ).toBe(true);

    expect(
      codexTranscriptEventsHaveAgentActivity([
        {
          type: 'item.started',
          item: { type: 'commandExecution', command: 'npm test' },
        },
      ]),
    ).toBe(true);
  });

  it('does not count empty assistant output or user-originated items', () => {
    expect(
      codexTranscriptEventsHaveAgentActivity([
        {
          type: 'item.completed',
          item: { type: 'agent_message', text: '   ' },
        },
        {
          type: 'item.completed',
          item: { type: 'user_message', text: 'do the work' },
        },
      ]),
    ).toBe(false);
  });
});
