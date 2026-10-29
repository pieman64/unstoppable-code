import type { AuthDependencyFailure } from '@canopy/protocol/auth-recovery';
import { CANOPY_AUTH_FAILURE_EVENT_TYPE } from '@canopy/desktop-shared/types';
import { attachAuthFailureToBlocks, applyTabEvent } from '../event-transforms';
import type { ChatMessage, ChatTab } from '../types';
import type { PersistedChatBlock } from '@canopy/agent-transcript';

const failure: AuthDependencyFailure = {
  dependencyClass: 'mcp',
  dependencyId: 'srv-1:cfg-1',
  displayName: 'Prod MCP server',
  failureClass: 'expired',
  recovery: { kind: 'mcp_oauth', serverId: 'srv-1', configId: 'cfg-1' },
};

function makeTab(overrides?: Partial<ChatTab>): ChatTab {
  return {
    id: 'chat-1',
    title: 'Chat',
    messages: [],
    status: 'idle',
    error: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    queuedMessages: [],
    planMode: false,
    proposalMode: 'optional',
    thinkingLevel: 'high',
    ...overrides,
  };
}

describe('applyTabEvent Claude fork recovery metadata', () => {
  it('marks a rejected point-in-time resume as fresh model context', () => {
    const tab = makeTab({
      sdkSessionId: 'source-session',
      claudeForkSessionOnNextSend: true,
      forkedFrom: {
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'source-chat',
        atMessageId: 'anchor',
      },
    });

    const updated = applyTabEvent(tab, {
      type: 'system',
      subtype: 'init',
      session_id: 'fresh-session',
      canopy_fork_model_context: 'fresh',
    });

    expect(updated.forkedFrom?.modelContext).toBe('fresh');
    expect(updated.claudeForkSessionOnNextSend).toBeUndefined();
  });
});

describe('applyTabEvent routing status', () => {
  it("records whether the account proxy serves the chat's session", () => {
    const proxied = applyTabEvent(makeTab(), {
      type: 'canopy_ai_credits_routing',
      active: false,
      accountProxyRouted: true,
      provider: 'claude',
    });
    expect(proxied.accountProxyRouted).toBe(true);
    expect(proxied.aiCreditsRouted).toBe(false);

    const native = applyTabEvent(proxied, {
      type: 'canopy_ai_credits_routing',
      active: false,
      provider: 'claude',
    });
    expect(native.accountProxyRouted).toBe(false);
  });
});

describe('attachAuthFailureToBlocks', () => {
  it('attaches to the tool_result matching the tool use id', () => {
    const blocks: PersistedChatBlock[] = [
      {
        type: 'tool_result',
        toolUseId: 'tu-1',
        toolName: 'mcp__prod__query',
        output: 'HTTP 401',
        isError: true,
      },
    ];
    const out = attachAuthFailureToBlocks(blocks, {
      toolUseId: 'tu-1',
      failure,
    });
    expect(out[0].type === 'tool_result' && out[0].authFailure).toEqual(
      failure,
    );
  });

  it('leaves non-matching blocks untouched', () => {
    const blocks: PersistedChatBlock[] = [
      {
        type: 'tool_result',
        toolUseId: 'other',
        toolName: 'mcp__prod__query',
        output: 'ok',
        isError: false,
      },
    ];
    const out = attachAuthFailureToBlocks(blocks, {
      toolUseId: 'tu-1',
      failure,
    });
    expect(out[0].type === 'tool_result' && out[0].authFailure).toBeUndefined();
  });

  it('writes both the array and the singular field for a multi-blocker turn', () => {
    // Both, always (CAN-1814 PR 2). The array is what the checklist renders;
    // the scalar is what a reader predating it renders, and dropping the
    // scalar would silently remove the card for such a reader.
    const second: AuthDependencyFailure = {
      ...failure,
      dependencyId: 'srv-2:cfg-1',
      displayName: 'Docs MCP server',
      recovery: { kind: 'mcp_oauth', serverId: 'srv-2', configId: 'cfg-1' },
    };
    const blocks: PersistedChatBlock[] = [
      {
        type: 'tool_result',
        toolUseId: 'tu-1',
        toolName: 'mcp__prod__query',
        output: 'HTTP 401',
        isError: true,
      },
    ];

    const out = attachAuthFailureToBlocks(blocks, {
      toolUseId: 'tu-1',
      failure,
      failures: [failure, second],
    });

    const block = out[0];
    expect(block.type === 'tool_result' && block.authFailure).toEqual(failure);
    expect(block.type === 'tool_result' && block.authFailures).toEqual([
      failure,
      second,
    ]);
  });

  it('back-fills the array from a producer that only knows one failure', () => {
    const blocks: PersistedChatBlock[] = [
      {
        type: 'tool_result',
        toolUseId: 'tu-1',
        toolName: 'mcp__prod__query',
        output: 'HTTP 401',
        isError: true,
      },
    ];

    const out = attachAuthFailureToBlocks(blocks, {
      toolUseId: 'tu-1',
      failure,
    });

    expect(out[0].type === 'tool_result' && out[0].authFailures).toEqual([
      failure,
    ]);
  });

  it('attaches a provider failure to the last text block when no tool use id is given', () => {
    const blocks: PersistedChatBlock[] = [
      { type: 'text', text: "You're not signed in to Claude." },
    ];
    const providerFailure: AuthDependencyFailure = {
      dependencyClass: 'provider',
      dependencyId: 'claude',
      displayName: 'Claude',
      failureClass: 'unauthenticated',
      recovery: { kind: 'provider_terminal', provider: 'claude' },
    };
    const out = attachAuthFailureToBlocks(blocks, { failure: providerFailure });
    expect(out[0].type === 'text' && out[0].authFailure).toEqual(
      providerFailure,
    );
  });
});

describe('applyTabEvent canopy_auth_failure wiring', () => {
  it('attaches a structured failure delivered as a canopy_auth_failure chat event', () => {
    const messages: ChatMessage[] = [
      {
        id: 'msg-1',
        role: 'assistant',
        timestamp: 1,
        blocks: [
          {
            type: 'tool_result',
            toolUseId: 'tu-1',
            toolName: 'mcp__prod__query',
            output: 'MCP error -32001: MCP server authorization required',
            isError: true,
          },
        ],
      },
    ];
    const tab = makeTab({ messages });

    const updated = applyTabEvent(tab, {
      type: CANOPY_AUTH_FAILURE_EVENT_TYPE,
      toolUseId: 'tu-1',
      failure,
    });

    const block = updated.messages[0].blocks[0];
    expect(block.type === 'tool_result' && block.authFailure).toEqual(failure);
  });

  it("attaches a provider failure with no toolUseId to the turn's error notice", () => {
    const messages: ChatMessage[] = [
      {
        id: 'msg-1',
        role: 'system',
        timestamp: 1,
        // The shape `handleClaudeErrorEvent` writes. The anchor is restricted
        // to notices the reducer authored for a failure (CAN-1814 review
        // round 2), so an arbitrary `system` text message no longer qualifies.
        blocks: [{ type: 'text', text: 'Error: Claude is not authenticated.' }],
      },
    ];
    const tab = makeTab({ messages });
    const providerFailure: AuthDependencyFailure = {
      dependencyClass: 'provider',
      dependencyId: 'claude',
      displayName: 'Claude',
      failureClass: 'unauthenticated',
      recovery: { kind: 'provider_terminal', provider: 'claude' },
    };

    const updated = applyTabEvent(tab, {
      type: CANOPY_AUTH_FAILURE_EVENT_TYPE,
      failure: providerFailure,
    });

    const block = updated.messages[0].blocks[0];
    expect(block.type === 'text' && block.authFailure).toEqual(providerFailure);
  });

  it('returns the tab unchanged when the toolUseId matches no block', () => {
    // `applyTabEvent` feeds memoized turn-group caches, so a non-matching
    // event must not mint a fresh tab (and fresh message) identity.
    const messages: ChatMessage[] = [
      {
        id: 'msg-1',
        role: 'assistant',
        timestamp: 1,
        blocks: [
          {
            type: 'tool_result',
            toolUseId: 'some-other-call',
            toolName: 'mcp__prod__query',
            output: 'ok',
            isError: false,
          },
        ],
      },
    ];
    const tab = makeTab({ messages });

    const updated = applyTabEvent(tab, {
      type: CANOPY_AUTH_FAILURE_EVENT_TYPE,
      toolUseId: 'tu-1',
      failure,
    });

    expect(updated).toBe(tab);
    expect(updated.messages).toBe(messages);
  });

  it('returns the tab unchanged when the failure payload is malformed', () => {
    const messages: ChatMessage[] = [
      {
        id: 'msg-1',
        role: 'assistant',
        timestamp: 1,
        blocks: [
          {
            type: 'tool_result',
            toolUseId: 'tu-1',
            toolName: 'mcp__prod__query',
            output: 'MCP error -32001: MCP server authorization required',
            isError: true,
          },
        ],
      },
    ];
    const tab = makeTab({ messages });

    const updated = applyTabEvent(tab, {
      type: CANOPY_AUTH_FAILURE_EVENT_TYPE,
      toolUseId: 'tu-1',
      failure: { dependencyClass: 'mcp' },
    });

    expect(updated).toBe(tab);
  });

  it('returns the tab unchanged when the failure is shape-valid but semantically invalid', () => {
    // failureClass 'quota_exceeded' is not a recoverable class
    // (isRecoverableAuthFailureClass), so pairing it with a real recovery
    // action (mcp_oauth) violates isValidAuthDependencyFailure's invariant:
    // only { kind: 'none' } may accompany a non-recoverable failure class.
    // A shape-only guard would let this through and show a reconnect CTA
    // for a failure reconnecting cannot fix.
    const messages: ChatMessage[] = [
      {
        id: 'msg-1',
        role: 'assistant',
        timestamp: 1,
        blocks: [
          {
            type: 'tool_result',
            toolUseId: 'tu-1',
            toolName: 'mcp__prod__query',
            output: 'MCP error -32001: MCP server authorization required',
            isError: true,
          },
        ],
      },
    ];
    const tab = makeTab({ messages });

    const updated = applyTabEvent(tab, {
      type: CANOPY_AUTH_FAILURE_EVENT_TYPE,
      toolUseId: 'tu-1',
      failure: {
        dependencyClass: 'mcp',
        dependencyId: 'srv-1:cfg-1',
        displayName: 'Prod MCP server',
        failureClass: 'quota_exceeded',
        recovery: {
          kind: 'mcp_oauth',
          serverId: 'srv-1',
          configId: 'cfg-1',
        },
      },
    });

    expect(updated).toBe(tab);
  });
});
