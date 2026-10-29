import {
  applyCodexTranscriptEvent,
  createEmptyTranscriptReducerState,
  parseAgentTranscriptLines,
} from '@canopy/agent-transcript';
import type { PersistedChatMessage } from '@canopy/desktop-shared/types';
import { PORTAL_CHAT_TEXT_MAX_CHARS } from '@canopy/desktop-shared/portal/persisted-chat-projection';
import type { PortalChatMessage } from '@canopy/protocol/portal';
import {
  createCursorAssistantPatchProjector,
  createPortalTurnTimer,
  isTerminalRuntimeChatEvent,
  persistedMessageToPortalMessage,
  projectPersistedChatTranscript,
  runtimeChatEventToPortalMessage,
} from '../chat-transcript-projector';

function expectRecord(
  value: unknown,
): asserts value is Record<string, unknown> {
  expect(value).not.toBeNull();
  expect(typeof value).toBe('object');
  expect(Array.isArray(value)).toBe(false);
}

describe('runtimeChatEventToPortalMessage', () => {
  it('carries trusted fallback context live without duplicating the raw prose or terminal row', () => {
    const raw = 'API Error: 400 messages.4.content: Invalid input';
    const code = 'claude_ai_credits_fallback_rejected';
    const projected = runtimeChatEventToPortalMessage({
      scope: 'app_advisor',
      chatId: 'chat',
      data: {
        type: 'assistant',
        error: 'unknown',
        canopy_display_error_code: code,
        message: { id: 'sdk-message', content: [{ type: 'text', text: raw }] },
      },
    });
    expect(projected?.text).toBe('');
    expect(projected?.parts).toEqual([
      { kind: 'text', data: { text: raw, errorCode: code } },
    ]);
    expect(
      runtimeChatEventToPortalMessage({
        scope: 'app_advisor',
        chatId: 'chat',
        data: {
          type: 'result',
          is_error: true,
          result: raw,
          canopy_display_error_code: code,
        },
      }),
    ).toBeNull();
  });

  it('projects complete child snapshots identically live and after JSONL reload', () => {
    const event = {
      type: 'canopy_delegation',
      delegation: {
        delegationId: 'child',
        runGeneration: 1,
        sequence: 4,
        parentHarnessId: 'codex',
        parentTurnId: 'user',
        parentToolCallId: 'spawn',
        createdAt: 100,
        task: {
          description: 'Review',
          prompt: 'Read source',
          executionMode: 'background',
        },
        snapshot: {
          delegationId: 'child',
          status: 'completed',
          outputTruncated: false,
          routeSnapshot: {
            selectedModelId: 'historical-reviewer',
            runtimeModelId: 'old-model',
            harnessId: 'claude',
          },
        },
        transcript: [
          {
            id: 'thinking',
            type: 'thinking',
            text: 'Inspecting source',
            sequence: 1,
            occurredAt: 101,
          },
          {
            id: 'read',
            type: 'tool',
            toolName: 'Read',
            input: '{"path":"file.ts"}',
            output: 'source',
            sequence: 2,
            occurredAt: 102,
          },
          {
            id: 'answer',
            type: 'text',
            text: 'Original cause survives',
            sequence: 3,
            occurredAt: 103,
          },
        ],
      },
    };
    const live = runtimeChatEventToPortalMessage({
      scope: 'worktree',
      chatId: 'chat',
      data: event,
    });
    const parsed = parseAgentTranscriptLines([JSON.stringify(event)], 'codex');
    expect(live).toEqual(
      projectPersistedChatTranscript({
        scope: 'worktree',
        chatId: 'chat',
        messages: parsed.messages,
      })[0],
    );
    expect(live?.parts?.[0]).toMatchObject({
      kind: 'agent',
      data: {
        subBlocks: [
          {
            kind: 'thinking',
            data: { text: 'Inspecting source', occurredAt: 101 },
          },
          { kind: 'tool_use', toolFamily: 'read' },
          {
            kind: 'text',
            data: { text: 'Original cause survives', occurredAt: 103 },
          },
        ],
      },
    });
  });

  it.each(['claude', 'codex'] as const)(
    'projects an account proxy switch identically live and after JSONL reload (%s)',
    (provider) => {
      const event = {
        type: 'canopy_account_proxy_switch',
        sourceEventId: 'account-proxy-switch:1792073631515:1',
        timestamp: 1_792_073_631_515,
        account: 'sam@example.com',
        previousAccount: 'ops@example.com',
        previousAtLimit: true,
        provider,
      };
      const live = runtimeChatEventToPortalMessage({
        scope: 'worktree',
        chatId: 'chat',
        data: event,
      });
      const parsed = parseAgentTranscriptLines(
        [JSON.stringify(event)],
        provider,
      );
      // The same row, so a reload neither duplicates nor reorders it.
      expect(live).toEqual(
        projectPersistedChatTranscript({
          scope: 'worktree',
          chatId: 'chat',
          messages: parsed.messages,
        })[0],
      );
      expect(live).toMatchObject({
        messageId: 'account-proxy-switch:1792073631515:1',
        role: 'system',
        parts: [
          {
            kind: 'account_switch',
            data: {
              account: 'sam@example.com',
              previousAccount: 'ops@example.com',
              previousAtLimit: true,
            },
          },
        ],
      });
    },
  );

  it('drops an account proxy switch with no account', () => {
    expect(
      runtimeChatEventToPortalMessage({
        scope: 'worktree',
        chatId: 'chat',
        data: { type: 'canopy_account_proxy_switch', account: '  ' },
      }),
    ).toBeNull();
  });

  it('suppresses Claude usage-limit assistant frames instead of a literal rate_limit bubble (CAN-2601)', () => {
    const message = runtimeChatEventToPortalMessage({
      scope: 'app_advisor',
      chatId: 'chat-1',
      data: {
        type: 'assistant',
        error: 'rate_limit',
        message: { content: [] },
      },
    });
    expect(message).toBeNull();
  });

  it('suppresses the Claude 429 result frame instead of a failed provider-prose bubble (CAN-2601)', () => {
    const message = runtimeChatEventToPortalMessage({
      scope: 'worktree',
      chatId: 'chat-1',
      data: {
        type: 'result',
        is_error: true,
        api_error_status: 429,
        result: "You've hit your session limit \u00b7 resets 7:20pm",
      },
    });
    expect(message).toBeNull();
  });

  it('still projects non-quota failed result frames', () => {
    const message = runtimeChatEventToPortalMessage({
      scope: 'worktree',
      chatId: 'chat-1',
      data: {
        type: 'result',
        is_error: true,
        api_error_status: 500,
        result: 'provider exploded',
      },
    });
    expect(message).toMatchObject({
      status: 'failed',
      text: 'provider exploded',
    });
  });

  it('preserves long assistant responses for Remote Control (CAN-3146)', () => {
    const text = 'x'.repeat(PORTAL_CHAT_TEXT_MAX_CHARS);
    const message = runtimeChatEventToPortalMessage({
      scope: 'worktree',
      chatId: 'chat-1',
      data: {
        type: 'assistant',
        message: { content: [{ type: 'text', text }] },
      },
    });

    expect(message?.text).toBe(text);
  });

  it('suppresses the plan-mode ExitPlanMode abort instead of a failed frame (CAN-3019)', () => {
    // Canopy answers `ExitPlanMode` with `behavior: 'deny', interrupt: true`
    // (claude-session.ts) so the plan routes into its own review UI. The SDK
    // reports that graceful abort as `is_error: true` with
    // `terminal_reason: 'aborted_tools'`. Classifying it as a failure told a
    // Remote Control user "Agent run failed" on every successful plan.
    const message = runtimeChatEventToPortalMessage({
      scope: 'worktree',
      chatId: 'chat-1',
      data: {
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        terminal_reason: 'aborted_tools',
        stop_reason: 'tool_use',
        uuid: '66b7b4ce-772d-4b9e-943f-206aad655e05',
      },
    });
    expect(message).toBeNull();
  });

  it('suppresses a user Stop mid-stream instead of a failed frame (CAN-3019)', () => {
    const message = runtimeChatEventToPortalMessage({
      scope: 'worktree',
      chatId: 'chat-1',
      data: {
        type: 'result',
        is_error: true,
        terminal_reason: 'aborted_streaming',
      },
    });
    expect(message).toBeNull();
  });

  it('does not let a non-result frame borrow an abort terminal_reason (CAN-3019)', () => {
    // Abort reasons only ever ride `result` events. Guarding on the type keeps
    // a future provider frame that happens to carry the string from
    // laundering a real failure into silence.
    const message = runtimeChatEventToPortalMessage({
      scope: 'worktree',
      chatId: 'chat-1',
      data: {
        type: 'error',
        is_error: true,
        terminal_reason: 'aborted_tools',
        error: 'provider exploded',
      },
    });
    expect(message).toMatchObject({ status: 'failed' });
  });

  it('suppresses the reactive Codex turn.failed usage-limit frame while a plain turn.failed still projects (CAN-2601)', () => {
    const quotaFailure = runtimeChatEventToPortalMessage({
      scope: 'standalone',
      chatId: 'chat-1',
      data: {
        type: 'codex',
        event: {
          type: 'turn.failed',
          error: {
            message: 'usage limit exceeded',
            codexErrorInfo: 'usageLimitExceeded',
          },
        },
      },
    });
    expect(quotaFailure).toBeNull();
    // The frame is still the turn's terminal event for lifecycle bookkeeping.
    expect(
      isTerminalRuntimeChatEvent({
        type: 'codex',
        event: { type: 'turn.failed' },
      }),
    ).toBe(true);

    // Pre-existing contract this suppression rides on: NO codex turn.failed
    // projects a message row (only item.completed does) — the failure reaches
    // the portal through the terminal turn-timer frame, so quota suppression
    // cannot regress plain-failure rendering.
    const plainFailure = runtimeChatEventToPortalMessage({
      scope: 'standalone',
      chatId: 'chat-1',
      data: {
        type: 'codex',
        event: {
          type: 'turn.failed',
          error: { message: 'provider exploded' },
        },
      },
    });
    expect(plainFailure).toBeNull();
  });

  it('suppresses the synthetic Codex usage-limit result while a non-limit codex_error result still projects (CAN-4564)', () => {
    const upsell =
      "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more.";
    const usageLimitResult = {
      type: 'result',
      is_error: true,
      subtype: 'codex_error',
      codexErrorInfo: 'usageLimitExceeded',
      result: upsell,
      errors: [upsell],
    };
    expect(
      runtimeChatEventToPortalMessage({
        scope: 'standalone',
        chatId: 'chat-1',
        data: usageLimitResult,
      }),
    ).toBeNull();
    // Still the turn's terminal event for Portal lifecycle bookkeeping.
    expect(isTerminalRuntimeChatEvent(usageLimitResult)).toBe(true);

    const otherFailure = runtimeChatEventToPortalMessage({
      scope: 'standalone',
      chatId: 'chat-1',
      data: {
        type: 'result',
        is_error: true,
        subtype: 'codex_error',
        codexErrorInfo: 'other',
        result: 'Internal server error',
        errors: ['Internal server error'],
      },
    });
    expect(otherFailure).toMatchObject({ status: 'failed' });
  });

  it('suppresses Codex rate_limit.reached frames (CAN-2601)', () => {
    const message = runtimeChatEventToPortalMessage({
      scope: 'standalone',
      chatId: 'chat-1',
      data: {
        type: 'codex',
        event: {
          type: 'rate_limit.reached',
          rateLimits: { primary: { resetsAt: 1_700_000_000_000 } },
        },
      },
    });
    expect(message).toBeNull();
  });

  it("prefers an errored frame's real text over its bare error code (CAN-2601)", () => {
    const message = runtimeChatEventToPortalMessage({
      scope: 'worktree',
      chatId: 'chat-1',
      data: {
        type: 'error',
        error: 'billing_error',
        message: { content: [{ type: 'text', text: 'Detailed explanation.' }] },
      },
    });
    expect(message).toMatchObject({
      status: 'failed',
      text: 'Detailed explanation.',
    });
  });

  it('falls back to the bare error code when an errored frame has no text', () => {
    const message = runtimeChatEventToPortalMessage({
      scope: 'worktree',
      chatId: 'chat-1',
      data: {
        type: 'error',
        error: 'billing_error',
      },
    });
    expect(message).toMatchObject({
      status: 'failed',
      text: 'billing_error',
    });
  });

  it('projects Codex agent-message completions instead of a blank wrapper row', () => {
    const message = runtimeChatEventToPortalMessage({
      scope: 'standalone',
      chatId: 'chat-1',
      data: {
        type: 'codex',
        event: {
          type: 'item.completed',
          item: {
            id: 'item-agent',
            type: 'agent_message',
            text: 'Final answer from Codex.',
          },
        },
      },
    });

    expect(message).toMatchObject({
      messageId: 'codex-item-agent',
      role: 'assistant',
      status: 'complete',
      text: 'Final answer from Codex.',
    });
  });

  it('projects Codex reasoning completions as thinking parts', () => {
    const message = runtimeChatEventToPortalMessage({
      scope: 'standalone',
      chatId: 'chat-1',
      data: {
        type: 'codex',
        event: {
          type: 'item.completed',
          item: {
            id: 'item-reasoning',
            type: 'reasoning',
            text: 'Reasoning summary',
          },
        },
      },
    });

    expect(message).toMatchObject({
      messageId: 'codex-item-reasoning',
      role: 'assistant',
      status: 'complete',
      text: '',
      parts: [{ kind: 'thinking', data: { text: 'Reasoning summary' } }],
    });
  });

  it('projects completed Codex command executions as paired tool parts', () => {
    const event = {
      type: 'item.completed',
      item: {
        id: 'item-command',
        type: 'command_execution',
        command: 'echo portal-live-ok',
        aggregated_output: 'portal-live-ok\n',
        status: 'completed',
        exit_code: 0,
      },
    };
    const message = runtimeChatEventToPortalMessage({
      scope: 'standalone',
      chatId: 'chat-1',
      data: { type: 'codex', event },
    });

    expect(message).toMatchObject({
      messageId: 'codex-item-command',
      role: 'assistant',
      status: 'complete',
      text: '',
      parts: [
        {
          kind: 'tool_use',
          toolFamily: 'bash',
          data: {
            toolUseId: 'codex-item-command',
            toolName: 'command',
            input: 'echo portal-live-ok',
          },
        },
        {
          kind: 'tool_result',
          data: {
            toolUseId: 'codex-item-command',
            output: 'portal-live-ok\n',
            isError: false,
          },
        },
      ],
    });
    // Durable history names the same call, so reads of either show one call.
    const history = projectPersistedChatTranscript({
      scope: 'standalone',
      chatId: 'chat-1',
      messages: applyCodexTranscriptEvent(
        createEmptyTranscriptReducerState(),
        event,
        { now: 1000, createMessageId: () => 'generated' },
      ).messages,
    });
    expect(history[0]?.messageId).toBe(message?.messageId);
    expect(history[0]?.parts?.[0]?.data).toMatchObject({
      toolUseId: 'codex-item-command',
    });
  });

  describe('Codex remote tool lifecycle (CAN-3069)', () => {
    const cases = [
      {
        type: 'dynamic_tool_call',
        tool: 'canopy_query_code_graph',
        toolName: 'canopy_query_code_graph',
        family: 'graph',
        content_items: [{ type: 'inputText', text: 'Found caller' }],
        success: true,
      },
      {
        type: 'mcp_tool_call',
        server: 'fixture',
        tool: 'query',
        toolName: 'mcp__fixture__query',
        family: 'unknown',
        result: { content: [{ type: 'text', text: 'Found caller' }] },
      },
    ];
    it.each(cases)(
      'projects $type in place and matches durable history',
      (fixture) => {
        const project = (
          event: Record<string, unknown>,
        ): PortalChatMessage | null =>
          runtimeChatEventToPortalMessage({
            scope: 'worktree',
            chatId: 'chat-1',
            data: { type: 'codex', event },
          });
        const item = {
          ...fixture,
          id: 'tool-1',
          arguments: { query: 'caller' },
          status: 'in_progress',
        };
        const start = project({ type: 'item.started', item });
        expect(start).toMatchObject({
          messageId: 'codex-tool-1',
          role: 'system',
          status: 'streaming',
          text: '',
          parts: [
            {
              kind: 'tool_use',
              toolFamily: fixture.family,
              data: {
                toolUseId: 'codex-tool-1',
                toolName: fixture.toolName,
                input: JSON.stringify(item.arguments),
              },
            },
          ],
        });
        expect(project({ type: 'item.updated', item })?.messageId).toBe(
          start?.messageId,
        );
        for (const status of ['completed', 'failed']) {
          const terminalUpdate = project({
            type: 'item.updated',
            item: { ...item, status },
          });
          expect(terminalUpdate).toMatchObject({
            messageId: start?.messageId,
            status: 'complete',
            parts: [start?.parts?.[0], { kind: 'tool_result' }],
          });
        }
        const event = {
          type: 'item.completed',
          item: { ...item, status: 'completed' },
        };
        const completed = project(event);
        expect(completed).toMatchObject({
          messageId: start?.messageId,
          status: 'complete',
          parts: [
            start?.parts?.[0],
            {
              kind: 'tool_result',
              data: {
                toolUseId: 'codex-tool-1',
                output: 'Found caller',
                isError: false,
              },
            },
          ],
        });
        const state = applyCodexTranscriptEvent(
          createEmptyTranscriptReducerState(),
          event,
          { now: 1000, createMessageId: () => 'generated' },
        );
        const history = projectPersistedChatTranscript({
          scope: 'worktree',
          chatId: 'chat-1',
          messages: state.messages,
        });
        expect(history).toHaveLength(1);
        expect(completed).toMatchObject({
          messageId: history[0].messageId,
          role: history[0].role,
        });
        expect(history[0].parts?.[0]).toMatchObject(start?.parts?.[0] ?? {});
        expect(history[0].parts?.[0].data).toMatchObject({
          result: { output: 'Found caller', isError: false },
        });
      },
    );
    it.each(['dynamic_tool_call', 'mcp_tool_call'])(
      'bounds %s inputs and flattened output on the portal wire',
      (type) => {
        const message = runtimeChatEventToPortalMessage({
          scope: 'worktree',
          chatId: 'chat-1',
          data: {
            type: 'codex',
            event: {
              type: 'item.completed',
              item: {
                type,
                id: 'large',
                tool: 'query',
                arguments: { query: 'q'.repeat(5000) },
                content_items: [{ type: 'inputText', text: 'x'.repeat(5000) }],
                result: { content: [{ type: 'text', text: 'x'.repeat(5000) }] },
              },
            },
          },
        });
        const inputData = message?.parts?.[0].data;
        const outputData = message?.parts?.[1].data;
        expectRecord(inputData);
        expectRecord(outputData);
        expect(typeof inputData.input).toBe('string');
        expect(typeof outputData.output).toBe('string');
        if (
          typeof inputData.input !== 'string' ||
          typeof outputData.output !== 'string'
        ) {
          throw new Error('Expected projected tool input and output strings');
        }
        expect(inputData.input).toContain('[truncated');
        expect(outputData.output).toContain('[truncated');
        expect(inputData.input.length).toBeLessThanOrEqual(4000);
        expect(outputData.output.length).toBeLessThanOrEqual(4000);
      },
    );

    it.each([
      {
        type: 'dynamic_tool_call',
        success: false,
        content_items: [{ type: 'inputText', text: 'Lookup failed' }],
      },
      {
        type: 'dynamic_tool_call',
        status: 'failed',
        content_items: [{ type: 'inputText', text: 'Lookup failed' }],
      },
      {
        type: 'mcp_tool_call',
        result: {
          isError: true,
          content: [{ type: 'text', text: 'Lookup failed' }],
        },
      },
      { type: 'mcp_tool_call', error: { message: 'Lookup failed' } },
    ])('preserves $type errors', (item) => {
      const message = runtimeChatEventToPortalMessage({
        scope: 'standalone',
        chatId: 'chat-1',
        data: {
          type: 'codex',
          event: {
            type: 'item.completed',
            item: { id: 'failed', tool: 'query', ...item },
          },
        },
      });
      expect(message?.parts?.[1]).toMatchObject({
        kind: 'tool_result',
        data: { isError: true, output: 'Lookup failed' },
      });
    });
  });

  it('bounds Codex reasoning thinking parts to the per-part text cap', () => {
    const message = runtimeChatEventToPortalMessage({
      scope: 'standalone',
      chatId: 'chat-1',
      data: {
        type: 'codex',
        event: {
          type: 'item.completed',
          item: {
            id: 'item-reasoning-long',
            type: 'reasoning',
            text: 'r'.repeat(50_000),
          },
        },
      },
    });

    expect(message).not.toBeNull();
    const parts = message?.parts ?? [];
    expect(parts).toHaveLength(1);
    const data = parts[0]?.data;
    const text =
      data !== null &&
      typeof data === 'object' &&
      'text' in data &&
      typeof data.text === 'string'
        ? data.text
        : '';
    // Every other text path in the projector caps parts at 4 KB
    // (PORTAL_CHAT_PART_TEXT_MAX_CHARS); reasoning must not ship the raw
    // 50 KB summary over the portal wire.
    expect(text.length).toBeGreaterThan(0);
    expect(text.length).toBeLessThanOrEqual(4_000);
    expect(text).toContain('[truncated');
  });

  it('keys an assistant content event by its provider id and drops the duplicate result echo (D1)', () => {
    // Per-message identity: the assistant content event is keyed by its own
    // provider message id and is `complete` on arrival (a finalized block).
    const assistant = runtimeChatEventToPortalMessage({
      scope: 'standalone',
      chatId: 'chat-1',
      fallbackMessageId: 'user-1:assistant',
      data: {
        type: 'assistant',
        message_id: 'provider-message-1',
        message: { content: [{ type: 'text', text: 'Hi there.' }] },
      },
    });
    // The terminal `result` event echoes the same text the assistant event
    // already delivered — it must NOT mint a second (duplicate) bubble.
    const result = runtimeChatEventToPortalMessage({
      scope: 'standalone',
      chatId: 'chat-1',
      fallbackMessageId: 'user-1:assistant',
      data: {
        type: 'result',
        result: 'Hi there.',
      },
    });

    expect(assistant).toMatchObject({
      messageId: 'provider-message-1',
      status: 'complete',
      text: 'Hi there.',
    });
    expect(result).toBeNull();
  });

  it('projects Claude tool use and tool result as distinct, stably-keyed messages', () => {
    const toolUse = runtimeChatEventToPortalMessage({
      scope: 'standalone',
      chatId: 'chat-1',
      fallbackMessageId: 'user-1:assistant',
      data: {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tool-1',
              name: 'Read',
              input: { file_path: 'README.md' },
            },
          ],
        },
      },
    });
    const toolResult = runtimeChatEventToPortalMessage({
      scope: 'standalone',
      chatId: 'chat-1',
      fallbackMessageId: 'user-1:assistant',
      data: {
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-1',
              content: 'file contents',
            },
          ],
        },
      },
    });

    // The tool_use event carries no provider id, so it falls back to the
    // per-turn id; it is a finalized block, so `complete`.
    expect(toolUse).toMatchObject({
      messageId: 'user-1:assistant',
      role: 'assistant',
      status: 'complete',
      parts: [
        {
          kind: 'tool_use',
          toolFamily: 'read',
          data: { toolUseId: 'tool-1', toolName: 'Read' },
        },
      ],
    });
    // The tool_result is keyed by its tool_use_id so it pairs idempotently
    // with the call and never collapses onto the assistant text.
    expect(toolResult).toMatchObject({
      messageId: 'tool:tool-1',
      role: 'assistant',
      status: 'complete',
      // The result text must ride ONLY in the tool_result part. A non-empty
      // `text` here made the browser render the raw result a second time as
      // a plain response bubble (round-5 regression).
      text: '',
      parts: [
        {
          kind: 'tool_result',
          data: { toolUseId: 'tool-1', output: 'file contents' },
        },
      ],
    });
  });

  it.each([
    ['mcp__canopy__SaveMemory', 'save-memory'],
    ['canopy_search_memory', 'search-memory'],
    ['mcp__canopy__ReadMemory', 'read-memory'],
  ])('projects %s tool calls in the canopy family', (toolName, toolId) => {
    const message = runtimeChatEventToPortalMessage({
      scope: 'standalone',
      chatId: 'chat-1',
      data: {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: toolId,
              name: toolName,
              input: {},
            },
          ],
        },
      },
    });

    expect(message).toMatchObject({
      parts: [
        {
          kind: 'tool_use',
          toolFamily: 'canopy',
          data: { toolUseId: toolId, toolName },
        },
      ],
    });
  });

  it('projects completed turn timers and drops in-flight ones', () => {
    const message: PersistedChatMessage = {
      id: 'msg-timer',
      role: 'assistant',
      timestamp: 1,
      blocks: [
        { type: 'text', text: 'Done.' },
        { type: 'turn_timer', startedAt: 1_000, completedAt: 11_000 },
        { type: 'turn_timer', startedAt: 20_000, completedAt: null },
      ],
    };
    const projected = persistedMessageToPortalMessage({
      scope: 'worktree',
      chatId: 'chat-1',
      message,
    });
    const timers = (projected.parts ?? []).filter(
      (part) => part.kind === 'turn_timer',
    );
    // The completed timer ships (desktop renders "Completed in M:SS"); the
    // in-flight one is dropped — it would render a perpetually-stale tick.
    expect(timers).toHaveLength(1);
    expect(timers[0]).toMatchObject({
      kind: 'turn_timer',
      data: { startedAt: 1_000, completedAt: 11_000 },
    });
  });

  it('stamps a deterministic toolFamily on persisted tool_use blocks', () => {
    const message: PersistedChatMessage = {
      id: 'msg-1',
      role: 'assistant',
      timestamp: 1,
      blocks: [
        { type: 'text', text: 'Calling tools' },
        { type: 'tool_use', toolUseId: 'tu-1', toolName: 'Bash', input: '{}' },
        { type: 'tool_use', toolUseId: 'tu-2', toolName: 'Read', input: '{}' },
        {
          type: 'tool_use',
          toolUseId: 'tu-3',
          toolName: 'mcp__canopy__AskUserQuestion',
          input: '{}',
        },
        {
          type: 'tool_use',
          toolUseId: 'tu-4',
          toolName: 'mcp__canopy__SearchWatchers',
          input: '{}',
        },
        {
          type: 'tool_use',
          toolUseId: 'tu-5',
          toolName: 'mcp__canopy_app_advisor__WatchGitHubItems',
          input: '{}',
        },
        {
          type: 'tool_use',
          toolUseId: 'tu-6',
          toolName: 'ClaudeModelChange',
          input: '{}',
        },
        {
          type: 'tool_use',
          toolUseId: 'tu-7',
          toolName: 'mcp__linear__list_issues',
          input: '{}',
        },
        {
          type: 'tool_use',
          toolUseId: 'tu-8',
          toolName: 'NotInTheMap',
          input: '{}',
        },
      ],
    };

    const projected = persistedMessageToPortalMessage({
      scope: 'worktree',
      chatId: 'chat-1',
      message,
    });

    const parts = projected.parts ?? [];
    expect(parts).toHaveLength(8);
    expect(parts[0]).toMatchObject({ kind: 'tool_use', toolFamily: 'bash' });
    expect(parts[1]).toMatchObject({ kind: 'tool_use', toolFamily: 'read' });
    expect(parts[2]).toMatchObject({
      kind: 'tool_use',
      toolFamily: 'ask-user',
    });
    expect(parts[3]).toMatchObject({ kind: 'tool_use', toolFamily: 'watcher' });
    expect(parts[4]).toMatchObject({ kind: 'tool_use', toolFamily: 'watcher' });
    expect(parts[5]).toMatchObject({ kind: 'tool_use', toolFamily: 'claude' });
    // Generic third-party MCP tools stay 'unknown' to mirror the desktop
    // renderer's family dispatch (`getToolFamilyFromName`); they are not
    // Skill invocations.
    expect(parts[6]).toMatchObject({
      kind: 'tool_use',
      toolFamily: 'unknown',
    });
    expect(parts[7]).toMatchObject({
      kind: 'tool_use',
      toolFamily: 'unknown',
    });
  });

  it('mints a deterministic last-resort id when the event has no provider id and no fallback', () => {
    // Re-projecting the same id-less event must land on the SAME messageId so
    // the browser's upsert-by-id collapses copies instead of duplicating rows
    // (the old mint appended Date.now(), so every emission was a new row).
    const data = {
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'no ids anywhere' }] },
    };
    const first = runtimeChatEventToPortalMessage({
      scope: 'standalone',
      chatId: 'chat-1',
      data,
    });
    const second = runtimeChatEventToPortalMessage({
      scope: 'standalone',
      chatId: 'chat-1',
      data,
    });

    expect(first?.messageId).toBe('chat-1:assistant');
    expect(second?.messageId).toBe('chat-1:assistant');
  });

  it('drops unrecognized Codex wrapper events so they do not create stale streaming rows', () => {
    expect(
      runtimeChatEventToPortalMessage({
        scope: 'standalone',
        chatId: 'chat-1',
        data: {
          type: 'codex',
          event: {
            type: 'turn.started',
            turn_id: 'turn-1',
          },
        },
      }),
    ).toBeNull();
  });

  it.each([
    {
      type: 'canopy_user_prompt',
      original_text: 'Ship it',
      canopy_turn_user_message_id: 'user-1',
    },
    { type: 'canopy_ai_credits_routing', provider: 'claude', active: true },
    { type: 'canopy_archive_chat_requested' },
    { type: 'canopy_set_auto_archive_requested', enabled: true },
    { type: 'canopy_usage_limit_reached', provider: 'claude' },
    { type: 'claude_terminal_transcript_sync', messages: [] },
    { type: 'phase', phase: 'claude.prepare_invocation' },
    { type: 'system', subtype: 'init' },
    { type: 'thread.started', thread_id: 'thread-1' },
    { type: 'turn_diff', file_changes: [] },
    { type: 'turn.started', turn_id: 'turn-1' },
  ])('drops multiplexed non-message runtime event $type', (data) => {
    expect(
      runtimeChatEventToPortalMessage({
        scope: 'worktree',
        workspaceLocalId: 'project-1',
        worktreeLocalId: 'worktree-1',
        chatId: 'chat-1',
        fallbackMessageId: 'user-1:assistant',
        data,
      }),
    ).toBeNull();
  });
});

describe('Cursor assistant patches over Remote Control', () => {
  // The shape `CursorEventProjection` emits per ACP update: incremental
  // patches against one assistant message, never a self-contained message.
  const patch = (
    revision: number,
    patches: Record<string, unknown>[],
    extra: Record<string, unknown> = {},
  ): Record<string, unknown> => ({
    type: 'canopy_assistant_patch',
    provider: 'cursor',
    messageId: 'cursor-message-1',
    timestamp: 1_700_000_000_000,
    revision,
    patches,
    ...extra,
  });
  const scope = {
    scope: 'worktree' as const,
    workspaceLocalId: 'ws',
    worktreeLocalId: 'wt',
    chatId: 'chat-1',
  };

  it('never projects a raw patch or usage frame as a blank assistant row', () => {
    // Before the fix both fell through the generic path and reached the
    // browser as `role: assistant, text: ''` rows under the fallback id.
    expect(
      runtimeChatEventToPortalMessage({
        ...scope,
        fallbackMessageId: 'user-1:assistant',
        data: patch(1, [
          { index: 0, block: { type: 'text', text: 'Cursor ' } },
        ]),
      }),
    ).toBeNull();
    expect(
      runtimeChatEventToPortalMessage({
        ...scope,
        fallbackMessageId: 'user-1:assistant',
        data: { type: 'canopy_cursor_usage', provider: 'cursor', usage: null },
      }),
    ).toBeNull();
  });

  it('folds successive patches into one assistant message keyed by the patch id', () => {
    const projector = createCursorAssistantPatchProjector(scope);
    const first = projector.apply(
      patch(1, [{ index: 0, block: { type: 'text', text: 'Cursor ' } }]),
    );
    expect(first).toMatchObject({
      messageId: 'cursor-message-1',
      chatId: 'chat-1',
      role: 'assistant',
      status: 'complete',
      text: 'Cursor ',
      createdAtMs: 1_700_000_000_000,
    });
    const second = projector.apply(
      patch(2, [{ index: 0, appendText: 'chat works.' }]),
    );
    expect(second).toMatchObject({
      messageId: 'cursor-message-1',
      text: 'Cursor chat works.',
    });
    // Each revision is a distinct wire update of the same message: the
    // renderer client keys its event ids on `updatedAtMs`.
    expect(second?.updatedAtMs).toBeGreaterThan(first?.updatedAtMs ?? 0);
    // Anything that is not a Cursor patch is someone else's event.
    expect(
      projector.apply({ type: 'result', is_error: false, result: '' }),
    ).toBeNull();
    expect(
      projector.apply({ type: 'assistant', message: { content: [] } }),
    ).toBeNull();
  });

  it('projects tool patches as stably keyed tool parts with their family', () => {
    const projector = createCursorAssistantPatchProjector(scope);
    const message = projector.apply(
      patch(1, [
        {
          index: 0,
          block: {
            type: 'tool_use',
            toolUseId: 'tool-1',
            toolName: 'Read',
            input: '{"file_path":"package.json"}',
          },
        },
        {
          index: 1,
          block: {
            type: 'tool_result',
            toolUseId: 'tool-1',
            toolName: 'Read',
            output: '{"name":"demo"}',
            isError: false,
          },
        },
      ]),
    );
    // A same-message tool_result folds inline into its tool_use part, exactly
    // as the persisted transcript projection does for every provider.
    expect(message?.parts?.map((part) => part.kind)).toEqual(['tool_use']);
    expect(message?.parts?.[0]).toMatchObject({
      kind: 'tool_use',
      toolFamily: 'read',
      data: {
        toolUseId: 'tool-1',
        toolName: 'Read',
        result: { output: '{"name":"demo"}', isError: false },
      },
    });
  });

  it('drops a malformed patch instead of minting a blank row', () => {
    const projector = createCursorAssistantPatchProjector(scope);
    // An append against a block that was never created cannot be applied.
    expect(
      projector.apply(patch(1, [{ index: 0, appendText: 'orphan' }])),
    ).toBeNull();
  });

  it('projects host notices as system rows', () => {
    const projector = createCursorAssistantPatchProjector(scope);
    expect(
      projector.apply(
        patch(
          1,
          [
            {
              index: 0,
              block: {
                type: 'text',
                text: 'Earlier context was not restored.',
              },
            },
          ],
          { messageId: 'cursor-notice-1', role: 'system' },
        ),
      ),
    ).toMatchObject({
      messageId: 'cursor-notice-1',
      role: 'system',
      text: 'Earlier context was not restored.',
    });
  });
});

describe('projectPersistedChatTranscript', () => {
  const userMessage = (
    id: string,
    timestamp: number,
  ): PersistedChatMessage => ({
    id,
    role: 'user',
    timestamp,
    blocks: [{ type: 'text', text: 'prompt' }],
  });
  const timerMessage = (
    id: string,
    timestamp: number,
    completedAt: number | null,
  ): PersistedChatMessage => ({
    id,
    role: 'system',
    timestamp,
    blocks: [{ type: 'turn_timer', startedAt: timestamp, completedAt }],
  });

  it('excludes hidden deliveries from published transcript projection', () => {
    const projected = projectPersistedChatTranscript({
      scope: 'worktree',
      chatId: 'chat-1',
      messages: [
        userMessage('visible-user', 1_000),
        {
          id: 'hidden-delivery',
          role: 'user',
          hidden: true,
          timestamp: 1_001,
          blocks: [{ type: 'text', text: 'private orchestration payload' }],
        },
      ],
    });

    expect(projected.map((message) => message.messageId)).toEqual([
      'visible-user',
    ]);
    expect(JSON.stringify(projected)).not.toContain('private orchestration');
  });

  it('merges renderer-suffixed persisted rows onto the base wire id (CAN-2608)', () => {
    // One SDK assistant message split by the renderer into `msg_x` (text) and
    // `msg_x:2` (tool_use). The wire projector upserts both live events onto
    // ONE row, so the seed must converge too or the browser renders the
    // message twice.
    const projected = projectPersistedChatTranscript({
      scope: 'app_advisor',
      chatId: 'chat-1',
      messages: [
        userMessage('user-1', 1_000),
        {
          id: 'msg_x',
          role: 'assistant',
          timestamp: 1_001,
          blocks: [{ type: 'text', text: 'Before the question.' }],
        },
        {
          id: 'msg_x:2',
          role: 'assistant',
          timestamp: 1_002,
          blocks: [
            {
              type: 'tool_use',
              id: 'tool-1',
              name: 'mcp__unstoppable-code_ui__AskUserQuestion',
              input: { questions: [{ question: 'Which?', options: [] }] },
            },
          ],
        },
      ],
    });

    expect(projected.map((message) => message.messageId)).toEqual([
      'user-1',
      'msg_x',
    ]);
    const merged = projected[1];
    expect(merged.text).toBe('Before the question.');
    expect(merged.parts?.map((part) => part.kind)).toEqual(['tool_use']);
    // `:turn-timer` suffixes (non-numeric) must never merge.
    const withTimer = projectPersistedChatTranscript({
      scope: 'app_advisor',
      chatId: 'chat-1',
      messages: [
        userMessage('user-1', 1_000),
        timerMessage('t-1', 1_001, 2_000),
      ],
    });
    expect(withTimer.map((message) => message.messageId)).toEqual([
      'user-1',
      'user-1:turn-timer',
    ]);
  });

  it.each(['failed', 'cancelled'] as const)(
    'preserves a recorded %s outcome on completed snapshot timers',
    (outcome) => {
      const outcomes = {
        turnEnds: { 'user-1': { outcome, endedAt: 2000 } },
        unacceptedTurnEnds: { 'user-2': outcome },
      };
      const projected = projectPersistedChatTranscript({
        scope: 'worktree',
        chatId: 'chat-1',
        messages: [
          userMessage('user-1', 1000),
          timerMessage('timer-1', 1000, 2000),
          userMessage('user-2', 3000),
          timerMessage('timer-2', 3000, 4000),
          userMessage('user-3', 5000),
          timerMessage('timer-3', 5000, 6000),
        ],
        ...outcomes,
      });
      const timers = projected.filter((message) =>
        message.parts?.some((part) => part.kind === 'turn_timer'),
      );
      expect(timers.map((message) => message.status)).toEqual([
        'complete',
        'complete',
        'complete',
      ]);
      expect(
        timers
          .flatMap((message) => message.parts ?? [])
          .map((part) => part.data),
      ).toEqual([
        expect.objectContaining({ endReason: outcome }),
        expect.objectContaining({ endReason: outcome }),
        expect.not.objectContaining({ endReason: outcome }),
      ]);
    },
  );

  it('re-keys each turn’s persisted timer row onto the wire timer id', () => {
    // The renderer persists the timer under its own minted id (`msg-…`); the
    // live wire emits the same logical timer as `${userMessageId}:turn-timer`
    // (createPortalTurnTimer). The transcript projection must converge on the
    // wire id so a history re-push supersedes the browser's cached live row
    // instead of duplicating it.
    const projected = projectPersistedChatTranscript({
      scope: 'worktree',
      workspaceLocalId: 'ws-1',
      worktreeLocalId: 'wt-1',
      chatId: 'chat-1',
      messages: [
        userMessage('user-1', 1_000),
        timerMessage('msg-7-123', 1_001, 9_000),
        {
          id: 'msg-8-124',
          role: 'assistant',
          timestamp: 1_002,
          blocks: [{ type: 'text', text: 'answer' }],
        },
        userMessage('user-2', 10_000),
        timerMessage('msg-9-125', 10_001, 19_000),
      ],
    });

    expect(projected.map((message) => message.messageId)).toEqual([
      'user-1',
      'user-1:turn-timer',
      'msg-8-124',
      'user-2',
      'user-2:turn-timer',
    ]);
    // The converged row still carries the completed timer part.
    expect(projected[1].parts).toHaveLength(1);
    expect(projected[1].parts?.[0]).toMatchObject({
      kind: 'turn_timer',
      data: { startedAt: 1_001, completedAt: 9_000 },
    });
  });

  it('converges only the first completed timer per turn; later continuation timers keep their ids', () => {
    const projected = projectPersistedChatTranscript({
      scope: 'worktree',
      chatId: 'chat-1',
      messages: [
        userMessage('user-1', 1_000),
        timerMessage('msg-1-1', 1_001, 5_000),
        timerMessage('msg-2-2', 6_000, 9_000),
      ],
    });

    expect(projected.map((message) => message.messageId)).toEqual([
      'user-1',
      'user-1:turn-timer',
      'msg-2-2',
    ]);
  });

  it('leaves timers alone when no preceding user message exists, and skips open timers', () => {
    const projected = projectPersistedChatTranscript({
      scope: 'standalone',
      chatId: 'chat-1',
      messages: [
        // No turn owner yet: keep the persisted id.
        timerMessage('msg-0-0', 500, 900),
        userMessage('user-1', 1_000),
        // Open (in-flight) timer: not a completed carrier, keep the persisted
        // id — the first COMPLETED timer of the turn still converges.
        timerMessage('msg-1-1', 1_001, null),
        timerMessage('msg-2-2', 2_000, 8_000),
      ],
    });

    expect(projected.map((message) => message.messageId)).toEqual([
      'msg-0-0',
      'user-1',
      'msg-1-1',
      'user-1:turn-timer',
    ]);
  });
});

describe('createPortalTurnTimer', () => {
  it('starts as a streaming system row with an open timer part', () => {
    const timer = createPortalTurnTimer({
      chatId: 'chat-1',
      userMessageId: 'user-1',
    });
    expect(timer.startMessage).toMatchObject({
      messageId: 'user-1:turn-timer',
      chatId: 'chat-1',
      role: 'system',
      status: 'streaming',
      text: '',
      parts: [{ kind: 'turn_timer', data: { completedAt: null } }],
    });
  });

  it('completes once on the terminal event and is idempotent afterwards', () => {
    const timer = createPortalTurnTimer({
      chatId: 'chat-1',
      userMessageId: 'user-1',
    });
    expect(timer.completeForEvent({ type: 'assistant', message: {} })).toBe(
      null,
    );
    const completed = timer.completeForEvent({ type: 'result', result: 'ok' });
    expect(completed).toMatchObject({
      messageId: 'user-1:turn-timer',
      role: 'system',
      status: 'complete',
    });
    const completedParts = completed?.parts ?? [];
    expect(completedParts).toHaveLength(1);
    expect(completedParts[0]).toMatchObject({ kind: 'turn_timer' });
    const partData = completedParts[0]?.data;
    expect(
      partData !== null &&
        typeof partData === 'object' &&
        'completedAt' in partData &&
        typeof partData.completedAt === 'number',
    ).toBe(true);
    // finalize() after completion is a no-op; non-terminal events stay inert.
    expect(timer.finalize()).toBeNull();
    expect(timer.completeForEvent({ type: 'assistant', message: {} })).toBe(
      null,
    );
  });

  describe('endReason on the completed timer', () => {
    const endReasonOf = (message: PortalChatMessage | null): unknown => {
      const data: unknown = message?.parts?.[0]?.data;
      if (typeof data !== 'object' || data === null) return undefined;
      const record: Record<string, unknown> = { ...data };
      return record.endReason;
    };
    const complete = (event: unknown): PortalChatMessage | null =>
      createPortalTurnTimer({
        chatId: 'chat-1',
        userMessageId: 'user-1',
      }).completeForEvent(event);

    // Each shape below is what a provider really emits when the user stops a
    // turn (claude-session, codex app-server client + codex-session,
    // cursor-session).
    it.each([
      [
        'Claude aborted streaming',
        {
          type: 'result',
          is_error: true,
          terminal_reason: 'aborted_streaming',
        },
      ],
      [
        'Claude aborted tools',
        { type: 'result', is_error: true, terminal_reason: 'aborted_tools' },
      ],
      [
        'Claude Session aborted',
        { type: 'result', is_error: false, result: 'Session aborted' },
      ],
      [
        'Codex interrupted turn.completed wrapper',
        {
          type: 'codex',
          event: { type: 'turn.completed', status: 'interrupted' },
        },
      ],
      [
        'Codex Turn cancelled result',
        { type: 'result', is_error: false, result: 'Turn cancelled' },
      ],
      [
        'Cursor cancelled subtype',
        {
          type: 'result',
          is_error: false,
          result: 'Turn cancelled',
          subtype: 'cancelled',
        },
      ],
      [
        'Cursor cancelled subtype flagged as an error',
        { type: 'result', is_error: true, subtype: 'cancelled' },
      ],
    ])('marks a user stop as cancelled: %s', (_name, event) => {
      const completed = complete(event);
      expect(completed).toMatchObject({ status: 'complete' });
      expect(endReasonOf(completed)).toBe('cancelled');
    });

    it.each([
      ['an error result', { type: 'result', is_error: true, result: 'boom' }],
      ['an error event', { type: 'error', error: 'boom' }],
      [
        'a failed Codex turn',
        { type: 'codex', event: { type: 'turn.failed', error: {} } },
      ],
    ])('marks %s as failed', (_name, event) => {
      const completed = complete(event);
      expect(completed).toMatchObject({ status: 'complete' });
      expect(endReasonOf(completed)).toBe('failed');
    });

    it.each([
      ['a normal result', { type: 'result', result: 'ok', is_error: false }],
      [
        'a completed Codex turn',
        {
          type: 'codex',
          event: { type: 'turn.completed', status: 'completed' },
        },
      ],
      [
        'a Codex turn.completed without a status',
        { type: 'codex', event: { type: 'turn.completed' } },
      ],
      ['a Turn completed result', { type: 'result', result: 'Turn completed' }],
    ])('omits endReason for %s', (_name, event) => {
      const completed = complete(event);
      expect(completed).toMatchObject({ status: 'complete' });
      expect(endReasonOf(completed)).toBeUndefined();
    });

    it('omits endReason for finalize()', () => {
      const timer = createPortalTurnTimer({
        chatId: 'chat-1',
        userMessageId: 'user-1',
      });
      expect(endReasonOf(timer.finalize())).toBeUndefined();
    });
  });

  it('re-completes with a later completedAt when a loop continuation ends the same turn again', () => {
    // A loop wakeup continues the turn without a new user row, so the same
    // timer gets a second terminal event. The desktop extends its timer; the
    // portal must receive the extended completion instead of keeping the
    // first, shorter duration.
    const timer = createPortalTurnTimer({
      chatId: 'chat-1',
      userMessageId: 'user-1',
    });
    const nowSpy = jest.spyOn(Date, 'now');
    nowSpy.mockReturnValue(10_000);
    const first = timer.completeForEvent({ type: 'result', result: 'ok' });
    nowSpy.mockReturnValue(20_000);
    const second = timer.completeForEvent({ type: 'result', result: 'ok' });
    nowSpy.mockRestore();
    const completedAtOf = (message: PortalChatMessage | null): unknown => {
      const part = message?.parts?.[0];
      const data: unknown = part?.data;
      if (typeof data !== 'object' || data === null) return undefined;
      const record: Record<string, unknown> = { ...data };
      return record.completedAt;
    };
    expect(completedAtOf(first)).toBe(10_000);
    expect(second).toMatchObject({
      messageId: 'user-1:turn-timer',
      status: 'complete',
    });
    expect(completedAtOf(second)).toBe(20_000);
    expect(timer.finalize()).toBeNull();
  });

  it('finalize() force-closes a timer whose turn died without a terminal event', () => {
    const timer = createPortalTurnTimer({
      chatId: 'chat-1',
      userMessageId: 'user-1',
    });
    const completed = timer.finalize();
    expect(completed).toMatchObject({ status: 'complete' });
    expect(timer.finalize()).toBeNull();
  });

  it('pauses and resumes around an ask-user tool lifecycle', () => {
    const now = jest
      .spyOn(Date, 'now')
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(2_000)
      .mockReturnValueOnce(5_000);
    try {
      const timer = createPortalTurnTimer({
        chatId: 'chat-1',
        userMessageId: 'user-1',
      });
      const paused = timer.updateForMessage({
        messageId: 'tool-use-1',
        chatId: 'chat-1',
        role: 'assistant',
        status: 'complete',
        text: '',
        parts: [
          {
            kind: 'tool_use',
            data: {
              toolUseId: 'ask-1',
              toolName: 'canopy_ask_user_question',
            },
          },
        ],
        createdAtMs: 2_000,
      });
      expect(paused?.parts?.[0]?.data).toMatchObject({
        startedAt: 1_000,
        pausedAt: 2_000,
        resumedAt: null,
        completedAt: null,
      });

      const resumed = timer.updateForMessage({
        messageId: 'tool-result-1',
        chatId: 'chat-1',
        role: 'assistant',
        status: 'complete',
        text: '',
        parts: [
          {
            kind: 'tool_result',
            data: { toolUseId: 'unrelated-1', output: 'Done' },
          },
          {
            kind: 'tool_result',
            data: { toolUseId: 'ask-1', output: 'Continue' },
          },
        ],
        createdAtMs: 5_000,
      });
      expect(resumed?.parts?.[0]?.data).toMatchObject({
        pausedAt: 2_000,
        resumedAt: 5_000,
        accumulatedPausedDurationMs: 3_000,
        completedAt: null,
      });
    } finally {
      now.mockRestore();
    }
  });

  it('does not leave Codex questions paused when raw events and projected messages both arrive', () => {
    const timer = createPortalTurnTimer({
      chatId: 'chat-1',
      userMessageId: 'user-1',
    });
    for (const type of ['item.started', 'item.completed']) {
      const data = {
        type: 'codex',
        event: {
          type,
          item: {
            type: 'dynamic_tool_call',
            id: 'ask',
            tool: 'request_user_input',
            success: true,
          },
        },
      };
      timer.updateForEvent(data);
      const message = runtimeChatEventToPortalMessage({
        scope: 'worktree',
        chatId: 'chat-1',
        data,
      });
      expect(message).not.toBeNull();
      if (message) timer.updateForMessage(message);
    }
    const final = timer.finalize();
    const timerData = final?.parts?.[0]?.data;
    expectRecord(timerData);
    expect(typeof timerData.resumedAt).toBe('number');
  });

  it('pauses and resumes around Codex built-in request_user_input events', () => {
    const now = jest
      .spyOn(Date, 'now')
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(2_000)
      .mockReturnValueOnce(5_000);
    try {
      const timer = createPortalTurnTimer({
        chatId: 'chat-1',
        userMessageId: 'user-1',
      });
      const item = {
        type: 'dynamic_tool_call',
        id: 'request-1',
        tool: 'request_user_input',
      };

      expect(
        timer.updateForEvent({
          type: 'codex',
          event: { type: 'item.started', item },
        })?.parts?.[0]?.data,
      ).toMatchObject({ pausedAt: 2_000, resumedAt: null });
      expect(
        timer.updateForEvent({
          type: 'codex',
          event: { type: 'item.completed', item },
        })?.parts?.[0]?.data,
      ).toMatchObject({
        pausedAt: 2_000,
        resumedAt: 5_000,
        accumulatedPausedDurationMs: 3_000,
      });
    } finally {
      now.mockRestore();
    }
  });
});

describe('isTerminalRuntimeChatEvent', () => {
  it('recognizes Claude and Codex terminal shapes including cancellation', () => {
    expect(isTerminalRuntimeChatEvent({ type: 'result' })).toBe(true);
    expect(
      isTerminalRuntimeChatEvent({
        type: 'result',
        canopy_session_continues: true,
      }),
    ).toBe(false);
    expect(isTerminalRuntimeChatEvent({ type: 'error' })).toBe(true);
    expect(isTerminalRuntimeChatEvent({ type: 'cancelled' })).toBe(true);
    expect(
      isTerminalRuntimeChatEvent({
        type: 'codex',
        event: { type: 'turn.completed' },
      }),
    ).toBe(true);
    expect(
      isTerminalRuntimeChatEvent({
        type: 'codex',
        event: { type: 'turn.cancelled' },
      }),
    ).toBe(true);
    expect(
      isTerminalRuntimeChatEvent({
        type: 'codex',
        event: { type: 'item.completed' },
      }),
    ).toBe(false);
    expect(isTerminalRuntimeChatEvent({ type: 'assistant' })).toBe(false);
  });
});
