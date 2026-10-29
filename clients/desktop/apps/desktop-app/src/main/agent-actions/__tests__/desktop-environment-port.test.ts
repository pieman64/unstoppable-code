const mockQuery = jest.fn<Promise<unknown>, [string, unknown, unknown]>();
const mockInstruction = jest.fn<Promise<unknown>, [string, unknown, unknown]>();

const mockResolveScopeOwner = jest.fn<Promise<unknown>, [unknown]>();
const mockBuildCatalog = jest.fn<unknown[], [unknown, unknown]>();

jest.mock('../../agents/work-owner', () => ({
  resolveAiCreditsScopeOwner: (scope: unknown): Promise<unknown> =>
    mockResolveScopeOwner(scope),
}));

jest.mock('../../portal/model-catalog-projection', () => ({
  buildProjectedModelCatalog: (model: unknown, options: unknown): unknown[] =>
    mockBuildCatalog(model, options),
}));

import type * as MessageCommandAdapter from '../../canopy-runtime/core-chat-message-command-adapter';

const mockLegacyCommands: unknown[] = [];

jest.mock('../../canopy-runtime/core-chat-message-command-adapter', () => {
  const actual = jest.requireActual<typeof MessageCommandAdapter>(
    '../../canopy-runtime/core-chat-message-command-adapter',
  );
  return {
    ...actual,
    withLegacyChatMessageCommand: (
      ...args: Parameters<typeof actual.withLegacyChatMessageCommand>
    ): Promise<unknown> => {
      mockLegacyCommands.push(args[0]);
      return actual.withLegacyChatMessageCommand(...args);
    },
  };
});

jest.mock('../../canopy-runtime/desktop-runtime-access', () => ({
  getDesktopCanopyRuntime: (): object => ({
    query: mockQuery,
    instruction: mockInstruction,
  }),
}));

import {
  AgentPortError,
  isUnknownWriteOutcome,
  type AgentActionCall,
  type AgentPostMessageInput,
} from '@canopy/agent-actions';
import { CanopyOperationError } from '@canopy/core-runtime';
import { evaluateApproval } from '@canopy/desktop-shared/lib/approval-engine';
import type {
  ApprovalCheck,
  ApprovalMode,
  ApprovalRule,
  ChatSendMessageRequest,
  ClaudeTerminalTurnState,
} from '@canopy/desktop-shared/types';
import {
  beginApprovalModeTransition,
  clearLiveApprovalMode,
  endApprovalModeTransition,
  setLiveApprovalMode,
} from '../../approvals/live-approval-modes';
import { createApprovalSession } from '../../approvals/approval-service';
import {
  markChatApprovalStateChanged,
  markGlobalApprovalRulesChanged,
  markWorkspaceApprovalRulesChanged,
} from '../../approvals/rule-revisions';
import { chatSendAdmissionCheck } from '../../services/chat-send-admission';
import type { CanopyInjectedToolRuntime } from '../../canopy-tools/core';
import {
  addWorkspaceApprovalRule,
  writeWorkspaceApprovals,
} from '../../lib/approvals-persistence';
import { seedEmptyApprovalRuleSources } from '../../__tests__/helpers/approval-rule-sources';
import {
  createDesktopEnvironmentPort,
  desktopEnvironmentPortDeps,
  terminalChatRefusal,
  type DesktopEnvironmentPortDeps,
  type DesktopChatApprovalPolicy,
  type DesktopRendererActionResult,
} from '../desktop-environment-port';
import {
  AgentSenderContextError,
  type AgentSenderRequestFields,
} from '../../agent-messaging/sender-context';
import { createDesktopAgentLineage } from '../desktop-limits-port';
import { executeDesktopAgentActionTool } from '../desktop-surface';
import { agentWriteMessageId } from '../desktop-write-turns';

const runtime: CanopyInjectedToolRuntime = {
  requestUserAnswers: () => Promise.resolve([]),
  loadScriptOutput: () => Promise.resolve({ found: false, lines: [] }),
  worktreeActionRuntime: {
    projectId: 'ws-1',
    worktreeId: 'wt-1',
    chatId: 'chat-parent',
    cwd: '/worktree',
    getWindow: () => null,
  },
};

const call: AgentActionCall<CanopyInjectedToolRuntime> = {
  host: runtime,
  scope: { workspaceId: 'ws-1', worktreeId: 'wt-1', chatId: 'chat-parent' },
  turnKey: 'turn-1',
  toolUseId: 'tool-1',
};

const chatItem = (
  chatId: string,
  state: string,
  worktreeId = 'wt-1',
): Record<string, unknown> => ({
  chatId,
  workspaceId: 'ws-1',
  worktreeId,
  title: chatId,
  state,
  revision: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
});

function queryResults(
  name: string,
  params: { scope?: { workspaceId?: string; worktreeId?: string } },
): unknown {
  switch (name) {
    case 'core.workspace.get':
      return {
        workspaceId: params.scope?.workspaceId ?? 'ws-1',
        name: 'Workspace',
        kind: params.scope?.workspaceId === 'cw-1' ? 'cowork' : 'git',
        repositorySources: [],
        settings: {},
      };
    case 'core.worktree.list':
      return {
        items: [
          {
            worktreeId: 'wt-1',
            workspaceId: 'ws-1',
            name: 'Main',
            state: 'ready',
            baseBranch: null,
            branch: 'main',
            createdAt: '2026-01-01T00:00:00.000Z',
          },
          {
            worktreeId: 'wt-2',
            workspaceId: 'ws-1',
            name: 'Feature',
            state: 'ready',
            baseBranch: null,
            branch: 'feature',
            createdAt: '2026-01-01T00:00:00.000Z',
          },
        ],
        nextCursor: null,
      };
    case 'core.chat.list':
      if (params.scope?.workspaceId === 'cw-1') {
        return {
          items:
            params.scope.worktreeId === 'entry-2'
              ? [
                  {
                    ...chatItem('chat-cowork', 'idle', 'entry-2'),
                    workspaceId: 'cw-1',
                  },
                ]
              : [],
          nextCursor: null,
        };
      }
      return {
        items:
          params.scope?.worktreeId === 'wt-2'
            ? [chatItem('chat-other', 'idle', 'wt-2')]
            : [
                chatItem('chat-parent', 'running'),
                chatItem('chat-busy', 'running'),
              ],
        nextCursor: null,
      };
    case 'core.chat.transcript.page':
      return {
        messages: [
          { id: 'u1', role: 'user', blocks: [], timestamp: 0 },
          {
            id: 'a1',
            role: 'assistant',
            blocks: [{ type: 'text', text: 'Finished.' }],
            timestamp: 1,
          },
        ],
        totalMessages: 2,
        transcriptRevision: 3,
        latestHumanMessage: {
          id: 'u1',
          role: 'user',
          blocks: [],
          timestamp: 0,
        },
      };
    default:
      throw new Error(`Unexpected query ${name}`);
  }
}

function policy(
  mode: ApprovalMode,
  sessionRules: readonly ApprovalRule[] = [],
  root = '/ws/worktrees/wt-1',
): Promise<DesktopChatApprovalPolicy> {
  return Promise.resolve({ mode, sessionRules, root });
}

/** Where a chat runs, as the worktree record and its selected repository resolve it. */
function executionRoot(chat: {
  worktreeId: string;
  selectedRepoId?: string;
}): string {
  return `/ws/worktrees/${chat.worktreeId}${chat.selectedRepoId ? `/${chat.selectedRepoId}` : ''}`;
}

function deps(
  overrides: Partial<DesktopEnvironmentPortDeps> = {},
): DesktopEnvironmentPortDeps {
  return withReservedTabs(
    desktopEnvironmentPortDeps({
      reserveChat: jest.fn(() => Promise.resolve()),
      messageCommitted: () => Promise.resolve(false),
      rendererAction: jest.fn((action: { type: string }) =>
        Promise.resolve(
          action.type === 'worktree.create'
            ? {
                ok: true,
                result: { workspaceId: 'ws-1', worktreeId: 'wt-new' },
              }
            : { ok: true },
        ),
      ),
      listModels: () => Promise.resolve({ models: [], defaultModelId: null }),
      chatApprovalPolicy: () => policy('full-access'),
      newChatApprovalMode: () => Promise.resolve('full-access'),
      chatExecutionRoot: (chat) => Promise.resolve(executionRoot(chat)),
      terminalDrivenChatIds: () => Promise.resolve([]),
      terminalTurnStates: () => Promise.resolve(() => undefined),
      agentSenderFields: () => Promise.resolve(undefined),
      lineage: createDesktopAgentLineage(),
      ...overrides,
    }),
  );
}

/** The calling chat's sender fields, as `buildAgentSenderRequest` captures them. */
function senderFields(acceptedInputId: string): AgentSenderRequestFields {
  const sender = {
    kind: 'project' as const,
    projectType: 'code' as const,
    projectId: 'ws-1',
    taskId: 'wt-1',
    chatId: 'chat-parent',
  };
  return {
    agentSent: { sender, chatTitle: 'Parent', projectLabel: 'Workspace' },
    agentSenderProvenance: {
      version: 1,
      capturedAt: '2026-10-20T12:00:00.000Z',
      acceptedInputId,
      sender,
      owner: { kind: 'personal' },
    },
    hiddenContext: { kind: 'agent-sender-context', text: 'sender context' },
  };
}

/**
 * Answers a reserved chat's approval policy from its tab, as the chat state
 * owner stores it: the reserved mode, deny rules, and selected repository.
 */
function withReservedTabs(
  inner: DesktopEnvironmentPortDeps,
): DesktopEnvironmentPortDeps {
  const tabs = new Map<string, ChatSendMessageRequest>();
  const key = (chat: { worktreeId: string; chatId?: string }): string =>
    `${chat.worktreeId}:${chat.chatId ?? ''}`;
  return {
    ...inner,
    reserveChat: (request, reserveCall): Promise<void> => {
      if (!tabs.has(key(request))) tabs.set(key(request), request);
      return inner.reserveChat(request, reserveCall);
    },
    chatApprovalPolicy: (
      chat,
      policyCall,
    ): Promise<DesktopChatApprovalPolicy> => {
      const tab = tabs.get(key(chat));
      if (!tab) return inner.chatApprovalPolicy(chat, policyCall);
      return Promise.resolve({
        mode: tab.approvalMode ?? 'full-access',
        ...(tab.approvalMode ? { tabMode: tab.approvalMode } : {}),
        sessionRules: (tab.sessionApprovalRules ?? []).filter(
          (rule) => rule.behavior === 'deny',
        ),
        root: executionRoot({
          worktreeId: chat.worktreeId,
          ...(tab.selectedRepoId ? { selectedRepoId: tab.selectedRepoId } : {}),
        }),
        ...(tab.selectedRepoId ? { selectedRepoId: tab.selectedRepoId } : {}),
      });
    },
  };
}

function callerOf(options: unknown): unknown {
  return typeof options === 'object' && options !== null && 'caller' in options
    ? options.caller
    : undefined;
}

function grantsOf(caller: unknown): unknown {
  return typeof caller === 'object' && caller !== null && 'grants' in caller
    ? caller.grants
    : undefined;
}

beforeAll(async () => {
  await seedEmptyApprovalRuleSources(['ws-1', 'cw-1']);
});

beforeEach(() => {
  mockQuery.mockReset();
  mockInstruction.mockReset();
  mockLegacyCommands.length = 0;
  mockQuery.mockImplementation(
    (name: string, params: { scope?: { worktreeId?: string } }) =>
      Promise.resolve(queryResults(name, params)),
  );
  mockInstruction.mockImplementation(
    (_name: string, params: { commandId: string }) =>
      Promise.resolve({
        commandId: params.commandId,
        revision: 2,
        outcome: 'applied',
      }),
  );
});

describe('desktop environment port', () => {
  it('reads every registered core query through the desktop dispatcher as an mcp caller', async () => {
    const port = createDesktopEnvironmentPort(deps());
    await port.query('core.workspace.get', { workspaceId: 'ws-1' }, call);
    await port.query(
      'core.worktree.list',
      { scope: { workspaceId: 'ws-1' } },
      call,
    );
    await port
      .query(
        'core.worktree.get',
        { scope: { workspaceId: 'ws-1' }, worktreeId: 'wt-1' },
        call,
      )
      .catch(() => undefined);
    await port.query(
      'core.chat.list',
      { scope: { workspaceId: 'ws-1', worktreeId: 'wt-1' } },
      call,
    );
    expect(mockQuery.mock.calls.map(([name]) => name)).toEqual([
      'core.workspace.get',
      'core.worktree.list',
      'core.worktree.get',
      'core.chat.list',
    ]);
    for (const [, , options] of mockQuery.mock.calls) {
      const caller = callerOf(options);
      expect(caller).toMatchObject({
        interfaceKind: 'mcp',
        clientInstanceId: 'agent-action:chat-parent',
      });
      expect(grantsOf(caller)).toContain('core.chat.read');
    }
  });

  it('routes a DispatchAction read from the tool call to the dispatcher', async () => {
    const result = await executeDesktopAgentActionTool(
      'dispatch_action',
      { action: { type: 'workspace.get' } },
      runtime,
      { toolUseId: 'tool-read' },
    );
    expect(result.isError).toBe(false);
    const [name, params, options] = mockQuery.mock.calls[0] ?? [];
    expect(name).toBe('core.workspace.get');
    expect(params).toEqual({
      scope: { workspaceId: 'ws-1' },
      workspaceId: 'ws-1',
    });
    expect(callerOf(options)).toMatchObject({ interfaceKind: 'mcp' });
  });

  it('finds a chat in any worktree and reads its latest response', async () => {
    const port = createDesktopEnvironmentPort(deps());
    await expect(
      port.getChat(
        { scope: { workspaceId: 'ws-1' }, chatId: 'chat-other' },
        call,
      ),
    ).resolves.toEqual({
      chatId: 'chat-other',
      workspaceId: 'ws-1',
      worktreeId: 'wt-2',
      title: 'chat-other',
      state: 'idle',
      modelId: null,
      lastResponse: 'Finished.',
    });
    await expect(
      port.getChat({ scope: { workspaceId: 'ws-1' }, chatId: 'missing' }, call),
    ).resolves.toBeNull();
  });

  it('starts a current-worktree chat: reserves it titled with the model and keeping the active tab, arms, then sends through core.chat.message.send', async () => {
    const order: string[] = [];
    const reserveChat = jest.fn<Promise<void>, [ChatSendMessageRequest]>(() => {
      order.push('reserved');
      return Promise.resolve();
    });
    mockInstruction.mockImplementation(
      (_name: string, params: { commandId: string }) => {
        order.push('sent');
        return Promise.resolve({
          commandId: params.commandId,
          revision: 2,
          outcome: 'applied',
        });
      },
    );
    const port = createDesktopEnvironmentPort(deps({ reserveChat }));
    const input = {
      scope: { workspaceId: 'ws-1', worktreeId: 'wt-1' },
      placement: 'current' as const,
      model: { id: 'claude-sonnet-4-6', thinkingLevel: 'high' as const },
      title: 'Review',
      message: { text: 'Review the change.' },
      lineage: { parentChatId: 'chat-parent', depth: 1 },
      idempotencyKey: 'key-1',
      beforeFirstMessage: (): Promise<void> => {
        order.push('armed');
        return Promise.resolve();
      },
    };
    const receipt = await port.startChat(input, call);
    expect(receipt).toMatchObject({
      worktreeId: 'wt-1',
      delivery: 'submitted',
    });
    expect(order).toEqual(['reserved', 'armed', 'sent']);
    expect(reserveChat).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreeId: 'wt-1',
        chatId: receipt.chatId,
        userMessageId: agentWriteMessageId('key-1'),
        text: 'Review the change.',
        title: 'Review',
        model: 'claude-sonnet-4-6',
        thinkingLevel: 'high',
        modelConfig: { thinkingLevel: 'high' },
        preserveActiveTab: true,
      }),
      call,
    );
    expect(mockInstruction).toHaveBeenCalledTimes(1);
    expect(mockInstruction.mock.calls[0]?.[0]).toBe('core.chat.message.send');
    expect(mockInstruction.mock.calls[0]?.[1]).toMatchObject({
      scope: { workspaceId: 'ws-1', worktreeId: 'wt-1' },
      chatId: receipt.chatId,
      messageId: agentWriteMessageId('key-1'),
      text: 'Review the change.',
    });
    await expect(port.startChat(input, call)).resolves.toEqual(receipt);
    expect(mockInstruction).toHaveBeenCalledTimes(1);
    await expect(
      port.callerDepth({
        ...call,
        scope: {
          workspaceId: 'ws-1',
          worktreeId: 'wt-1',
          chatId: receipt.chatId,
        },
      }),
    ).resolves.toBe(1);
  });

  it('creates a new worktree through the renderer bridge and sends its first message through core.chat.message.send', async () => {
    const rendererAction = jest.fn((action: { type: string }) =>
      Promise.resolve(
        action.type === 'worktree.create'
          ? { ok: true, result: { workspaceId: 'ws-1', worktreeId: 'wt-new' } }
          : { ok: true },
      ),
    );
    const reserveChat = jest.fn(() => Promise.resolve());
    const port = createDesktopEnvironmentPort(
      deps({ rendererAction, reserveChat }),
    );
    const receipt = await port.startChat(
      {
        scope: { workspaceId: 'ws-1', worktreeId: 'wt-1' },
        placement: 'new_worktree',
        message: { text: 'Prototype it.' },
        lineage: { parentChatId: 'chat-parent', depth: 1 },
        idempotencyKey: 'key-2',
      },
      call,
    );
    expect(receipt).toMatchObject({
      worktreeId: 'wt-new',
      delivery: 'queued_for_setup',
    });
    expect(rendererAction.mock.calls.map(([action]) => action)).toEqual([
      {
        type: 'worktree.create',
        workspaceId: 'ws-1',
        baseWorktreeId: 'wt-1',
        select: false,
      },
    ]);
    // The new worktree's tab is reserved through the chat state owner before
    // arming, like a current-worktree start; nothing activates it.
    expect(reserveChat).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreeId: 'wt-new',
        chatId: receipt.chatId,
        text: 'Prototype it.',
        preserveActiveTab: true,
      }),
      expect.anything(),
    );
    expect(mockInstruction).toHaveBeenCalledTimes(1);
    expect(mockInstruction.mock.calls[0]?.[0]).toBe('core.chat.message.send');
    expect(mockInstruction.mock.calls[0]?.[1]).toMatchObject({
      scope: { workspaceId: 'ws-1', worktreeId: 'wt-new' },
      chatId: receipt.chatId,
      messageId: agentWriteMessageId('key-2'),
      text: 'Prototype it.',
    });
  });

  it('reports a retryable bridge failure as retryable, and its retry creates the worktree', async () => {
    const rendererAction = jest
      .fn<
        Promise<DesktopRendererActionResult>,
        [{ type: string }, string, unknown]
      >()
      .mockResolvedValueOnce({
        ok: false,
        error: {
          message: 'Fresh source worktree status could not be verified.',
          retryable: true,
        },
      })
      .mockImplementation((action: { type: string }) =>
        Promise.resolve(
          action.type === 'worktree.create'
            ? {
                ok: true,
                result: { workspaceId: 'ws-1', worktreeId: 'wt-new' },
              }
            : { ok: true },
        ),
      );
    const port = createDesktopEnvironmentPort(deps({ rendererAction }));
    const input = {
      scope: { workspaceId: 'ws-1', worktreeId: 'wt-1' },
      placement: 'new_worktree' as const,
      message: { text: 'Prototype it.' },
      lineage: { parentChatId: 'chat-parent', depth: 1 },
      idempotencyKey: 'key-retry-worktree',
    };
    await expect(port.startChat(input, call)).rejects.toMatchObject({
      code: 'execution_failed',
      message: 'Fresh source worktree status could not be verified.',
      retryable: true,
    });
    await expect(port.startChat(input, call)).resolves.toMatchObject({
      worktreeId: 'wt-new',
    });
    expect(
      rendererAction.mock.calls
        .filter(([action]) => action.type === 'worktree.create')
        .map(([, requestId]) => requestId),
    ).toEqual(['key-retry-worktree:worktree', 'key-retry-worktree:worktree']);
  });

  it.each([
    ['deadline_exceeded', 'timeout'],
    ['unavailable', 'surface_unavailable'],
  ] as const)(
    'reports a dispatcher %s on the first send as an unknown outcome',
    async (kind, code) => {
      mockInstruction.mockRejectedValueOnce(
        new CanopyOperationError({
          kind,
          message: 'The send did not answer in time.',
          retry: { kind: 'same_idempotency_key' },
        }),
      );
      const port = createDesktopEnvironmentPort(deps());
      const failure = await port
        .startChat(
          {
            scope: { workspaceId: 'ws-1', worktreeId: 'wt-1' },
            placement: 'new_worktree',
            message: { text: 'Prototype it.' },
            lineage: { parentChatId: 'chat-parent', depth: 1 },
            idempotencyKey: `unknown-${code}`,
          },
          call,
        )
        .catch((error: unknown) => error);
      expect(failure).toMatchObject({ code, retryable: true });
      expect(isUnknownWriteOutcome(failure)).toBe(true);
    },
  );

  it('fails a new-worktree start when the bridge returns no worktree', async () => {
    const port = createDesktopEnvironmentPort(
      deps({
        rendererAction: () =>
          Promise.resolve({ ok: false, error: { message: 'Repair needed.' } }),
      }),
    );
    await expect(
      port.startChat(
        {
          scope: { workspaceId: 'ws-1', worktreeId: 'wt-1' },
          placement: 'new_worktree',
          message: { text: 'Hi' },
          lineage: { parentChatId: 'chat-parent', depth: 1 },
          idempotencyKey: 'key-3',
        },
        call,
      ),
    ).rejects.toEqual(new AgentPortError('execution_failed', 'Repair needed.'));
    expect(mockInstruction).not.toHaveBeenCalled();
  });

  it('posts through core.chat.message.send and reports a busy target as queued', async () => {
    const port = createDesktopEnvironmentPort(deps());
    const receipt = await port.postMessage(
      {
        scope: { workspaceId: 'ws-1', worktreeId: 'wt-1' },
        chatId: 'chat-busy',
        text: 'Also check the docs.',
        idempotencyKey: 'key-4',
      },
      call,
    );
    expect(receipt).toEqual({ chatId: 'chat-busy', delivery: 'queued' });
    const [name, params, options] = mockInstruction.mock.calls[0] ?? [];
    expect(name).toBe('core.chat.message.send');
    expect(params).toMatchObject({
      scope: { workspaceId: 'ws-1', worktreeId: 'wt-1' },
      chatId: 'chat-busy',
      text: 'Also check the docs.',
    });
    expect(callerOf(options)).toMatchObject({
      interfaceKind: 'mcp',
      grants: ['core.chat.write'],
    });
  });

  it('attributes a posted message to the calling chat, letting it wait for its code task setup', async () => {
    const agentSenderFields = jest.fn(
      (_call: unknown, acceptedInputId: string) =>
        Promise.resolve(senderFields(acceptedInputId)),
    );
    const port = createDesktopEnvironmentPort(deps({ agentSenderFields }));
    await port.postMessage(
      {
        scope: { workspaceId: 'ws-1', worktreeId: 'wt-1' },
        chatId: 'chat-busy',
        text: 'Also check the docs.',
        idempotencyKey: 'key-sender',
      },
      call,
    );
    const messageId = agentWriteMessageId('key-sender');
    expect(agentSenderFields).toHaveBeenCalledWith(call, messageId, 'ws-1');
    const [, params] = mockInstruction.mock.calls[0] ?? [];
    expect(mockLegacyCommands).toEqual([
      {
        schemaVersion: 1,
        commandId:
          typeof params === 'object' && params !== null && 'commandId' in params
            ? params.commandId
            : undefined,
        projectId: 'ws-1',
        worktreeId: 'wt-1',
        command: {
          type: 'chat.send_message',
          chatId: 'chat-busy',
          userMessageId: messageId,
          text: 'Also check the docs.',
          ...senderFields(messageId),
          agentSendSetup: { version: 1 },
        },
      },
    ]);
  });

  it("attributes a started chat's first message to the calling chat", async () => {
    const port = createDesktopEnvironmentPort(
      deps({
        agentSenderFields: (_call, acceptedInputId) =>
          Promise.resolve(senderFields(acceptedInputId)),
      }),
    );
    const receipt = await port.startChat(
      {
        scope: { workspaceId: 'ws-1', worktreeId: 'wt-1' },
        placement: 'current',
        message: { text: 'Review the change.' },
        lineage: { parentChatId: 'chat-parent', depth: 1 },
        idempotencyKey: 'key-start-sender',
      },
      call,
    );
    const messageId = agentWriteMessageId('key-start-sender');
    expect(mockLegacyCommands).toHaveLength(1);
    expect(mockLegacyCommands[0]).toMatchObject({
      command: {
        chatId: receipt.chatId,
        userMessageId: messageId,
        agentSent: senderFields(messageId).agentSent,
      },
    });
  });

  it("lets a new worktree's attributed first message wait for its setup", async () => {
    const port = createDesktopEnvironmentPort(
      deps({
        agentSenderFields: (_call, acceptedInputId) =>
          Promise.resolve(senderFields(acceptedInputId)),
      }),
    );
    await port.startChat(
      {
        scope: { workspaceId: 'ws-1', worktreeId: 'wt-1' },
        placement: 'new_worktree',
        message: { text: 'Build the spike.' },
        lineage: { parentChatId: 'chat-parent', depth: 1 },
        idempotencyKey: 'key-setup-sender',
      },
      call,
    );
    expect(mockLegacyCommands).toHaveLength(1);
    expect(mockLegacyCommands[0]).toMatchObject({
      worktreeId: 'wt-new',
      command: { agentSendSetup: { version: 1, startedChat: true } },
    });
  });

  it("admits an Auto chat's new-worktree first message again as its start was admitted", async () => {
    // Auto approves within its own root, so a plain comparison refuses a
    // chat in a sibling worktree; the start carries the caller's root there.
    const port = createDesktopEnvironmentPort(
      deps({
        chatApprovalPolicy: () => policy('auto'),
        agentSenderFields: (_call, acceptedInputId) =>
          Promise.resolve(senderFields(acceptedInputId)),
      }),
    );
    const receipt = await port.startChat(
      {
        scope: { workspaceId: 'ws-1', worktreeId: 'wt-1' },
        placement: 'new_worktree',
        message: { text: 'Build the spike.' },
        lineage: { parentChatId: 'chat-parent', depth: 1 },
        idempotencyKey: 'key-auto-start',
      },
      call,
    );
    const started = {
      workspaceId: 'ws-1',
      worktreeId: receipt.worktreeId,
      chatId: receipt.chatId,
    };
    expect(mockLegacyCommands).toHaveLength(1);
    await expect(
      port.agentStartedChatMessageAdmission(started, call),
    ).resolves.toBeUndefined();
    await expect(
      port.agentMessageAdmission(started, call),
    ).rejects.toMatchObject({ code: 'authorization_conflict' });
  });

  it('refuses a message whose sender cannot be verified, sending nothing', async () => {
    const refusing = (
      code: 'owner_context_unavailable' | 'owner_boundary',
    ): ReturnType<typeof createDesktopEnvironmentPort> =>
      createDesktopEnvironmentPort(
        deps({
          agentSenderFields: () =>
            Promise.reject(new AgentSenderContextError(code, 'Unverified.')),
        }),
      );
    const post = (key: string): AgentPostMessageInput => ({
      scope: { workspaceId: 'ws-1', worktreeId: 'wt-1' },
      chatId: 'chat-busy',
      text: 'Hi.',
      idempotencyKey: key,
    });
    await expect(
      refusing('owner_context_unavailable').postMessage(post('key-a'), call),
    ).rejects.toMatchObject({
      code: 'owner_context_unavailable',
      message: 'Unverified.',
    });
    await expect(
      refusing('owner_boundary').postMessage(post('key-b'), call),
    ).rejects.toMatchObject({
      code: 'not_found',
      message: 'The target chat is not available.',
    });
    expect(mockInstruction).not.toHaveBeenCalled();
  });

  it('resumes a start whose first message was committed before its receipt was kept', async () => {
    const committed = new Set<string>();
    mockInstruction.mockImplementation(
      (_name: string, params: { commandId: string; messageId: string }) => {
        committed.add(params.messageId);
        return Promise.resolve({
          commandId: params.commandId,
          revision: 2,
          outcome: 'applied',
        });
      },
    );
    const messageCommitted = (
      _chat: unknown,
      messageId: string,
    ): Promise<boolean> => Promise.resolve(committed.has(messageId));
    const input = {
      scope: { workspaceId: 'ws-1', worktreeId: 'wt-1' },
      placement: 'current' as const,
      message: { text: 'Review it.' },
      lineage: { parentChatId: 'chat-parent', depth: 1 },
      idempotencyKey: 'key-resume',
    };
    const first = await createDesktopEnvironmentPort(
      deps({ messageCommitted }),
    ).startChat(input, call);
    const retried = await createDesktopEnvironmentPort(
      deps({ messageCommitted }),
    ).startChat(input, call);
    expect(retried).toEqual(first);
    expect(mockInstruction).toHaveBeenCalledTimes(1);
  });

  it('adopts the reserved chat when a start retries after a failed first send', async () => {
    const tabs = new Map<string, number>();
    const reserveChat = jest.fn((request: { chatId?: string }) => {
      const id = request.chatId ?? '';
      if (!tabs.has(id)) tabs.set(id, 0);
      return Promise.resolve();
    });
    const sent: { chatId: string; messageId: string }[] = [];
    mockInstruction
      .mockImplementationOnce((_name: string, params: { commandId: string }) =>
        Promise.resolve({
          commandId: params.commandId,
          revision: 2,
          outcome: 'rejected',
          reason: 'provider unavailable',
        }),
      )
      .mockImplementation(
        (
          _name: string,
          params: { commandId: string; chatId: string; messageId: string },
        ) => {
          sent.push({ chatId: params.chatId, messageId: params.messageId });
          tabs.set(params.chatId, (tabs.get(params.chatId) ?? 0) + 1);
          return Promise.resolve({
            commandId: params.commandId,
            revision: 2,
            outcome: 'applied',
          });
        },
      );
    const armed: string[] = [];
    const input = {
      scope: { workspaceId: 'ws-1', worktreeId: 'wt-1' },
      placement: 'current' as const,
      message: { text: 'Review it.' },
      lineage: { parentChatId: 'chat-parent', depth: 1 },
      idempotencyKey: 'key-retry',
      beforeFirstMessage: (target: { chatId: string }): Promise<void> => {
        armed.push(target.chatId);
        return Promise.resolve();
      },
    };
    const port = createDesktopEnvironmentPort(deps({ reserveChat }));
    await expect(port.startChat(input, call)).rejects.toMatchObject({
      code: 'execution_failed',
      message: 'provider unavailable',
    });
    const receipt = await port.startChat(input, call);
    expect([...tabs.entries()]).toEqual([[receipt.chatId, 1]]);
    expect(armed).toEqual([receipt.chatId, receipt.chatId]);
    expect(sent).toEqual([
      { chatId: receipt.chatId, messageId: agentWriteMessageId('key-retry') },
    ]);
  });

  it('derives the chat and first message ids from its idempotency key', async () => {
    const start = (idempotencyKey: string): Promise<unknown> =>
      createDesktopEnvironmentPort(deps()).startChat(
        {
          scope: { workspaceId: 'ws-1', worktreeId: 'wt-1' },
          placement: 'current',
          message: { text: 'Hi' },
          lineage: { parentChatId: 'chat-parent', depth: 1 },
          idempotencyKey,
        },
        call,
      );
    await start('key-a');
    await start('key-b');
    const sent = mockInstruction.mock.calls.map(
      ([, params]) => params as { chatId: string; messageId: string },
    );
    expect(sent[0]?.chatId).toMatch(/^chat-[0-9a-f-]{36}$/);
    expect(sent[0]?.chatId).not.toBe(sent[1]?.chatId);
    expect(sent[0]?.messageId).not.toBe(sent[1]?.messageId);
  });

  describe('approval modes', () => {
    const startInput = (
      placement: 'current' | 'new_worktree',
      idempotencyKey: string,
    ): Parameters<
      ReturnType<typeof createDesktopEnvironmentPort>['startChat']
    >[0] => ({
      scope: { workspaceId: 'ws-1', worktreeId: 'wt-1' },
      placement,
      message: { text: 'Do it.' },
      lineage: { parentChatId: 'chat-parent', depth: 1 },
      idempotencyKey,
    });

    it.each([
      ['ask', 'full-access', 'ask'],
      ['auto', 'full-access', 'auto'],
      ['auto', 'ask', 'ask'],
      ['full-access', 'ask', 'ask'],
      ['full-access', 'full-access', 'full-access'],
    ] as const)(
      'starts a chat from a %s parent, where new chats default to %s, in %s mode',
      async (parentMode, newChatMode, expected) => {
        const reserveChat = jest.fn<Promise<void>, [ChatSendMessageRequest]>(
          () => Promise.resolve(),
        );
        const chatApprovalPolicy = jest.fn(() => policy(parentMode));
        const newChatApprovalMode = jest.fn(() => Promise.resolve(newChatMode));
        const port = createDesktopEnvironmentPort(
          deps({
            reserveChat,
            chatApprovalPolicy,
            newChatApprovalMode,
          }),
        );
        await port.startChat(startInput('current', `mode-${expected}-a`), call);
        expect(chatApprovalPolicy).toHaveBeenCalledWith(call.scope, call);
        expect(newChatApprovalMode).toHaveBeenCalledWith(
          { workspaceId: 'ws-1', worktreeId: 'wt-1' },
          call,
        );
        expect(reserveChat).toHaveBeenCalledWith(
          expect.objectContaining({ approvalMode: expected }),
          call,
        );
        expect(reserveChat.mock.calls[0]?.[0]).not.toHaveProperty(
          'sessionApprovalRules',
        );

        await port.startChat(
          startInput('new_worktree', `mode-${expected}-b`),
          call,
        );
        expect(newChatApprovalMode).toHaveBeenLastCalledWith(
          { workspaceId: 'ws-1', worktreeId: 'wt-new' },
          call,
        );
        expect(reserveChat).toHaveBeenLastCalledWith(
          expect.objectContaining({
            worktreeId: 'wt-new',
            approvalMode: expected,
          }),
          call,
        );
      },
    );

    it.each(['current', 'new_worktree'] as const)(
      "starts a %s chat that keeps the calling chat's session deny rules",
      async (placement) => {
        const denySrc: ApprovalRule = {
          id: 'deny-src',
          behavior: 'deny',
          target: { kind: 'file-write', path: '/ws/src/**' },
          createdAt: '2026-01-01T00:00:00.000Z',
          origin: 'prompt',
        };
        const allowPublish: ApprovalRule = {
          id: 'allow-publish',
          behavior: 'allow',
          target: { kind: 'command', pattern: 'npm publish' },
          createdAt: '2026-01-01T00:00:00.000Z',
          origin: 'prompt',
        };
        const callerPolicy = {
          mode: 'auto' as const,
          sessionRules: [denySrc, allowPublish],
          root: executionRoot({ worktreeId: 'wt-1' }),
        };
        const reserveChat = jest.fn<Promise<void>, [ChatSendMessageRequest]>(
          () => Promise.resolve(),
        );
        const port = createDesktopEnvironmentPort(
          deps({
            reserveChat,
            chatApprovalPolicy: () => Promise.resolve(callerPolicy),
            newChatApprovalMode: () => Promise.resolve('full-access'),
          }),
        );
        await port.startChat(startInput(placement, `deny-${placement}`), call);

        const write: ApprovalCheck = {
          kind: 'file-write',
          path: '/ws/src/security.ts',
          resolvedPath: '/ws/src/security.ts',
        };
        const evaluate = (
          mode: ApprovalMode,
          session: readonly ApprovalRule[],
        ): string =>
          evaluateApproval(write, {
            mode,
            rules: { session: [...session], project: [], global: [] },
            workspaceRoot: '/ws',
          }).outcome;
        expect(evaluate(callerPolicy.mode, callerPolicy.sessionRules)).toBe(
          'deny',
        );
        const requests = reserveChat.mock.calls.map(([request]) => request);
        expect(requests.length).toBeGreaterThan(0);
        for (const request of requests) {
          expect(request.sessionApprovalRules).toEqual([denySrc]);
          expect(
            evaluate(
              request.approvalMode ?? 'full-access',
              request.sessionApprovalRules ?? [],
            ),
          ).toBe('deny');
        }
        expect(reserveChat).toHaveBeenCalledWith(
          expect.objectContaining({
            worktreeId: placement === 'new_worktree' ? 'wt-new' : 'wt-1',
          }),
          call,
        );
      },
    );

    it("reads the calling chat's mode before it creates anything", async () => {
      const failing = (): Promise<never> =>
        Promise.reject(new Error('approvals unreadable'));
      const reserveChat = jest.fn(() => Promise.resolve());
      const rendererAction = jest.fn(() => Promise.resolve({ ok: true }));
      const port = createDesktopEnvironmentPort(
        deps({ reserveChat, rendererAction, chatApprovalPolicy: failing }),
      );
      await expect(
        port.startChat(startInput('current', 'unreadable-a'), call),
      ).rejects.toThrow('approvals unreadable');
      await expect(
        port.startChat(startInput('new_worktree', 'unreadable-b'), call),
      ).rejects.toThrow('approvals unreadable');
      expect(reserveChat).not.toHaveBeenCalled();
      expect(rendererAction).not.toHaveBeenCalled();
    });

    describe('a calling chat that switches from Auto to Ask during a start', () => {
      afterEach(() => {
        clearLiveApprovalMode('ws-1', 'wt-1', 'chat-parent');
      });

      /**
       * A world whose tabs hold what was reserved, as the chat state owner
       * does, and whose calling chat switches the way the mode setter does:
       * the live registry restricts at once, and the persisted mode follows
       * unless `liveOnly`.
       */
      function switchingWorld(options: { liveOnly?: boolean } = {}): {
        deps: Partial<DesktopEnvironmentPortDeps>;
        switchToAsk: () => void;
        tabs: Map<string, ChatSendMessageRequest>;
      } {
        let persistedMode: ApprovalMode = 'auto';
        const tabs = new Map<string, ChatSendMessageRequest>();
        return {
          tabs,
          switchToAsk: (): void => {
            setLiveApprovalMode('ws-1', 'wt-1', 'chat-parent', 'ask');
            if (!options.liveOnly) persistedMode = 'ask';
          },
          deps: {
            newChatApprovalMode: () => Promise.resolve('full-access'),
            reserveChat: jest.fn(
              (request: ChatSendMessageRequest): Promise<void> => {
                if (!tabs.has(request.chatId ?? '')) {
                  tabs.set(request.chatId ?? '', request);
                }
                return Promise.resolve();
              },
            ),
            chatApprovalPolicy: jest.fn(
              (chat: {
                workspaceId: string;
                worktreeId: string;
                chatId: string;
              }): Promise<DesktopChatApprovalPolicy> => {
                if (chat.chatId === 'chat-parent') {
                  return policy(persistedMode);
                }
                const tab = tabs.get(chat.chatId);
                return Promise.resolve({
                  mode: tab?.approvalMode ?? 'full-access',
                  sessionRules: tab?.sessionApprovalRules ?? [],
                  root: executionRoot(chat),
                });
              },
            ),
          },
        };
      }

      const write: ApprovalCheck = {
        kind: 'file-write',
        path: '/ws/worktrees/wt-1/src/index.ts',
        resolvedPath: '/ws/worktrees/wt-1/src/index.ts',
      };
      const outcome = (mode: ApprovalMode): string =>
        evaluateApproval(write, {
          mode,
          rules: { session: [], project: [], global: [] },
          workspaceRoot: '/ws/worktrees/wt-1',
        }).outcome;

      it.each([
        ['persisted', false],
        ['live-only', true],
      ] as const)(
        'reserves a new-worktree chat whose setup was delayed with the %s Ask mode',
        async (_case, liveOnly) => {
          const world = switchingWorld({ liveOnly });
          const rendererAction = jest.fn((action: { type: string }) => {
            if (action.type !== 'worktree.create') {
              return Promise.resolve({ ok: true });
            }
            world.switchToAsk();
            return Promise.resolve({
              ok: true,
              result: { workspaceId: 'ws-1', worktreeId: 'wt-new' },
            });
          });
          const port = createDesktopEnvironmentPort(
            deps({ ...world.deps, rendererAction }),
          );
          await port.startChat(
            startInput('new_worktree', `switch-setup-${_case}`),
            call,
          );

          const tab = Array.from(world.tabs.values())[0];
          expect(tab?.approvalMode).toBe('ask');
          expect(outcome(tab?.approvalMode ?? 'full-access')).toBe('prompt');
        },
      );

      it.each([
        ['current', 'persisted', false],
        ['current', 'live-only', true],
        ['new_worktree', 'persisted', false],
        ['new_worktree', 'live-only', true],
      ] as const)(
        'refuses to send a %s chat reserved in Auto before a %s switch',
        async (placement, _case, liveOnly) => {
          const world = switchingWorld({ liveOnly });
          const reserveChat = jest.fn(
            async (request: ChatSendMessageRequest) => {
              await world.deps.reserveChat?.(request, call);
              world.switchToAsk();
            },
          );
          const port = createDesktopEnvironmentPort(
            deps({ ...world.deps, reserveChat }),
          );
          await expect(
            port.startChat(
              startInput(placement, `switch-reserved-${placement}-${_case}`),
              call,
            ),
          ).rejects.toMatchObject({
            code: 'authorization_conflict',
            retryable: false,
          });
          expect(Array.from(world.tabs.values())[0]?.approvalMode).toBe('auto');
          expect(mockInstruction).not.toHaveBeenCalled();
        },
      );

      it.each(['current', 'new_worktree'] as const)(
        'refuses the first message of a %s start once the live mode switches while the start reads the calling chat',
        async (placement) => {
          const world = switchingWorld({ liveOnly: true });
          let parentReads = 0;
          const chatApprovalPolicy = jest.fn(
            (chat: {
              workspaceId: string;
              worktreeId: string;
              chatId: string;
            }) => {
              if (
                chat.chatId === 'chat-parent' &&
                ++parentReads === (placement === 'new_worktree' ? 3 : 2)
              ) {
                const read = policy('auto');
                world.switchToAsk();
                return read;
              }
              return (
                world.deps.chatApprovalPolicy?.(chat, call) ?? policy('ask')
              );
            },
          );
          const port = createDesktopEnvironmentPort(
            deps({ ...world.deps, chatApprovalPolicy }),
          );
          await expect(
            port.startChat(
              startInput(placement, `switch-final-${placement}`),
              call,
            ),
          ).rejects.toMatchObject({
            code: 'authorization_conflict',
            retryable: false,
          });
          expect(parentReads).toBe(placement === 'new_worktree' ? 3 : 2);
          expect(Array.from(world.tabs.values())[0]?.approvalMode).toBe('auto');
          expect(mockInstruction).not.toHaveBeenCalled();
        },
      );

      it('refuses a message once the calling chat switched to Ask during its read', async () => {
        const port = createDesktopEnvironmentPort(
          deps({
            chatApprovalPolicy: (chat) => {
              if (chat.chatId !== 'chat-parent') return policy('auto');
              const read = policy('auto');
              setLiveApprovalMode('ws-1', 'wt-1', 'chat-parent', 'ask');
              return read;
            },
          }),
        );
        await expect(
          port.postMessage(
            {
              scope: { workspaceId: 'ws-1', worktreeId: 'wt-1' },
              chatId: 'chat-busy',
              text: 'Write the release notes.',
              idempotencyKey: 'switch-post',
            },
            call,
          ),
        ).rejects.toMatchObject({ code: 'authorization_conflict' });
        expect(mockInstruction).not.toHaveBeenCalled();
      });

      it('refuses a message to a chat whose switch to Full Access is pending', async () => {
        const generation = beginApprovalModeTransition(
          'ws-1',
          'wt-1',
          'chat-busy',
          'full-access',
        );
        try {
          const port = createDesktopEnvironmentPort(
            deps({ chatApprovalPolicy: () => policy('auto') }),
          );
          await expect(
            port.postMessage(
              {
                scope: { workspaceId: 'ws-1', worktreeId: 'wt-1' },
                chatId: 'chat-busy',
                text: 'Write the release notes.',
                idempotencyKey: 'pending-target',
              },
              call,
            ),
          ).rejects.toMatchObject({ code: 'authorization_conflict' });
          expect(mockInstruction).not.toHaveBeenCalled();
        } finally {
          endApprovalModeTransition('ws-1', 'wt-1', 'chat-busy', generation);
        }
      });
    });

    describe('a policy that changes while the send reads its chat', () => {
      const canonicalTab: {
        approvalMode: ApprovalMode;
        sessionApprovalRules: ApprovalRule[];
      } = { approvalMode: 'auto', sessionApprovalRules: [] };
      const dispatched: unknown[] = [];

      /**
       * Answers core.chat.message.send as the chat state owner does: the
       * change lands while the send reads backend state, then the message is
       * admitted against the canonical tab in the step that commits it.
       */
      function admitAfter(change: () => void, times = 1): void {
        let remaining = times;
        mockInstruction.mockImplementation(
          async (
            _name: string,
            params: { commandId: string; chatId: string; messageId: string },
          ) => {
            if (remaining > 0) {
              remaining -= 1;
              change();
            }
            await Promise.resolve();
            const refusal = chatSendAdmissionCheck({
              projectId: 'ws-1',
              worktreeId: 'wt-1',
              chatId: params.chatId,
              userMessageId: params.messageId,
            })?.(canonicalTab);
            if (refusal !== undefined) {
              return {
                commandId: params.commandId,
                revision: 2,
                outcome: 'rejected',
                reason: refusal,
              };
            }
            dispatched.push(params.messageId);
            return {
              commandId: params.commandId,
              revision: 2,
              outcome: 'applied',
            };
          },
        );
      }

      const port = (): ReturnType<typeof createDesktopEnvironmentPort> =>
        createDesktopEnvironmentPort(
          deps({
            chatApprovalPolicy: (chat) =>
              chat.chatId === 'chat-parent'
                ? policy('auto')
                : Promise.resolve({
                    mode: canonicalTab.approvalMode,
                    tabMode: canonicalTab.approvalMode,
                    sessionRules: [...canonicalTab.sessionApprovalRules],
                    root: '/ws/worktrees/wt-1',
                  }),
          }),
        );
      const send = (key: string): Promise<unknown> =>
        port().postMessage(
          {
            scope: { workspaceId: 'ws-1', worktreeId: 'wt-1' },
            chatId: 'chat-busy',
            text: 'Run the deploy.',
            idempotencyKey: key,
          },
          call,
        );

      beforeEach(() => {
        canonicalTab.approvalMode = 'auto';
        canonicalTab.sessionApprovalRules = [];
        dispatched.length = 0;
      });

      afterEach(() => {
        clearLiveApprovalMode('ws-1', 'wt-1', 'chat-parent');
      });

      it('admits a message when nothing changed', async () => {
        admitAfter(() => undefined);
        await expect(send('unchanged')).resolves.toMatchObject({
          chatId: 'chat-busy',
        });
        expect(dispatched).toEqual([agentWriteMessageId('unchanged')]);
      });

      it.each([
        [
          'the target switches to Full Access',
          (): void => {
            canonicalTab.approvalMode = 'full-access';
          },
        ],
        [
          'the target gains a session grant',
          (): void => {
            canonicalTab.sessionApprovalRules = [
              {
                id: 'allow-publish',
                behavior: 'allow',
                target: { kind: 'command', pattern: 'npm publish' },
                createdAt: '2026-01-01T00:00:00.000Z',
                origin: 'prompt',
              },
            ];
          },
        ],
        [
          'the calling chat switches to Ask',
          (): void => {
            setLiveApprovalMode('ws-1', 'wt-1', 'chat-parent', 'ask');
          },
        ],
      ])('refuses at admission when %s', async (_case, change) => {
        admitAfter(change, Number.POSITIVE_INFINITY);
        await expect(send(`changed-${_case}`)).rejects.toMatchObject({
          code: 'authorization_conflict',
          retryable: false,
        });
        expect(dispatched).toEqual([]);
      });

      const unrelated: [string, () => void][] = [
        [
          'an approval setting changes without changing either policy',
          (): void => {
            markGlobalApprovalRulesChanged();
          },
        ],
        [
          'another workspace changes its approval rules',
          (): void => {
            markWorkspaceApprovalRulesChanged('ws-other');
          },
        ],
        [
          "the calling chat's approval state is rewritten unchanged",
          (): void => {
            markChatApprovalStateChanged({
              projectId: 'ws-1',
              worktreeId: 'wt-1',
              chatId: 'chat-parent',
            });
          },
        ],
      ];

      it.each(unrelated)(
        'checks again and admits the message when %s while it is checked',
        async (_case, change) => {
          admitAfter(change);
          await expect(send(`unrelated-${_case}`)).resolves.toMatchObject({
            chatId: 'chat-busy',
          });
          expect(dispatched).toEqual([
            agentWriteMessageId(`unrelated-${_case}`),
          ]);
          expect(mockInstruction).toHaveBeenCalledTimes(2);
        },
      );

      it('fails as retryable, sending nothing, when approval settings keep changing', async () => {
        admitAfter(() => {
          markGlobalApprovalRulesChanged();
        }, Number.POSITIVE_INFINITY);
        const failure = await send('settings-storm').catch(
          (error: unknown) => error,
        );
        expect(failure).toMatchObject({
          code: 'stale_ui_state',
          retryable: true,
        });
        expect(isUnknownWriteOutcome(failure)).toBe(false);
        expect(String((failure as Error).message)).toContain(
          'approval settings',
        );
        expect(dispatched).toEqual([]);
      });
    });

    describe('a message retried after its receipt was lost', () => {
      afterEach(() => {
        clearLiveApprovalMode('ws-1', 'wt-1', 'chat-parent');
      });

      it.each([
        [
          'replays the original receipt of a message its first attempt committed',
          true,
        ],
        ['refuses a message no attempt committed', false],
      ] as const)('%s', async (_case, firstCommits) => {
        const committed = new Set<string>();
        const port = createDesktopEnvironmentPort(
          deps({
            chatApprovalPolicy: () => policy('auto'),
            messageCommitted: (_chat, messageId) =>
              Promise.resolve(committed.has(messageId)),
          }),
        );
        mockInstruction.mockImplementation(
          (_name: string, params: { messageId: string }) => {
            if (firstCommits) committed.add(params.messageId);
            return Promise.reject(
              new CanopyOperationError({
                kind: 'deadline_exceeded',
                message: 'The send did not answer in time.',
                retry: { kind: 'same_idempotency_key' },
              }),
            );
          },
        );
        const input = {
          scope: { workspaceId: 'ws-1', worktreeId: 'wt-1' },
          chatId: 'chat-busy',
          text: 'Write the release notes.',
          idempotencyKey: `lost-receipt-${String(firstCommits)}`,
        };

        const lost = await port
          .postMessage(input, call)
          .catch((error: unknown) => error);
        expect(isUnknownWriteOutcome(lost)).toBe(true);
        setLiveApprovalMode('ws-1', 'wt-1', 'chat-parent', 'ask');

        if (firstCommits) {
          await expect(port.postMessage(input, call)).resolves.toEqual({
            chatId: 'chat-busy',
            delivery: 'queued',
          });
        } else {
          await expect(port.postMessage(input, call)).rejects.toMatchObject({
            code: 'authorization_conflict',
            retryable: false,
          });
        }
        expect(mockInstruction).toHaveBeenCalledTimes(1);
      });
    });

    it('replays a new worktree start whose first message an earlier attempt committed, without checking it again', async () => {
      const committed = new Set<string>();
      const port = createDesktopEnvironmentPort(
        deps({
          chatApprovalPolicy: () => policy('auto'),
          messageCommitted: (_chat, messageId) =>
            Promise.resolve(committed.has(messageId)),
        }),
      );
      mockInstruction.mockImplementation(
        (_name: string, params: { messageId: string }) => {
          committed.add(params.messageId);
          return Promise.reject(
            new CanopyOperationError({
              kind: 'deadline_exceeded',
              message: 'The send did not answer in time.',
              retry: { kind: 'same_idempotency_key' },
            }),
          );
        },
      );
      const input = {
        scope: { workspaceId: 'ws-1', worktreeId: 'wt-1' },
        placement: 'new_worktree' as const,
        message: { text: 'Prototype it.' },
        lineage: { parentChatId: 'chat-parent', depth: 1 },
        idempotencyKey: 'lost-start-receipt',
      };
      try {
        const lost = await port
          .startChat(input, call)
          .catch((error: unknown) => error);
        expect(isUnknownWriteOutcome(lost)).toBe(true);
        setLiveApprovalMode('ws-1', 'wt-1', 'chat-parent', 'ask');
        await expect(port.startChat(input, call)).resolves.toMatchObject({
          worktreeId: 'wt-new',
          delivery: 'queued_for_setup',
        });
        expect(mockInstruction).toHaveBeenCalledTimes(1);
      } finally {
        clearLiveApprovalMode('ws-1', 'wt-1', 'chat-parent');
      }
    });

    describe('a new worktree start whose policy changes before its first message is admitted', () => {
      const startInput = (
        idempotencyKey: string,
      ): Parameters<
        ReturnType<typeof createDesktopEnvironmentPort>['startChat']
      >[0] => ({
        scope: { workspaceId: 'ws-1', worktreeId: 'wt-1' },
        placement: 'new_worktree',
        message: { text: 'Prototype it.' },
        lineage: { parentChatId: 'chat-parent', depth: 1 },
        idempotencyKey,
      });

      afterEach(() => {
        clearLiveApprovalMode('ws-1', 'wt-1', 'chat-parent');
      });

      it.each([
        [
          'the calling chat switches to Ask',
          (): void => {
            setLiveApprovalMode('ws-1', 'wt-1', 'chat-parent', 'ask');
          },
        ],
      ])('refuses at admission when %s', async (_case, change) => {
        const reserved: ChatSendMessageRequest[] = [];
        const dispatched: string[] = [];
        const rendererAction = jest.fn(() =>
          Promise.resolve({
            ok: true,
            result: { workspaceId: 'ws-1', worktreeId: 'wt-new' },
          }),
        );
        const port = createDesktopEnvironmentPort(
          deps({
            rendererAction,
            chatApprovalPolicy: () => policy('auto'),
            reserveChat: (request) => {
              reserved.push(request);
              return Promise.resolve();
            },
          }),
        );
        let changeOnce: (() => void) | undefined = change;
        mockInstruction.mockImplementation(
          async (
            _name: string,
            params: { commandId: string; chatId: string; messageId: string },
          ) => {
            changeOnce?.();
            changeOnce = undefined;
            await Promise.resolve();
            const tab = reserved.find(
              (request) => request.chatId === params.chatId,
            );
            const refusal = chatSendAdmissionCheck({
              projectId: 'ws-1',
              worktreeId: 'wt-new',
              chatId: params.chatId,
              userMessageId: params.messageId,
            })?.({
              ...(tab?.approvalMode ? { approvalMode: tab.approvalMode } : {}),
              ...(tab?.sessionApprovalRules
                ? { sessionApprovalRules: tab.sessionApprovalRules }
                : {}),
            });
            if (refusal !== undefined) {
              return {
                commandId: params.commandId,
                revision: 2,
                outcome: 'rejected',
                reason: refusal,
              };
            }
            dispatched.push(params.messageId);
            return {
              commandId: params.commandId,
              revision: 2,
              outcome: 'applied',
            };
          },
        );
        const key = `worktree-${_case}`;

        const failure = await port
          .startChat(startInput(key), call)
          .catch((error: unknown) => error);
        expect(failure).toMatchObject({
          code: 'authorization_conflict',
          retryable: false,
        });
        expect(isUnknownWriteOutcome(failure)).toBe(false);
        expect(dispatched).toEqual([]);

        clearLiveApprovalMode('ws-1', 'wt-1', 'chat-parent');
        await expect(port.startChat(startInput(key), call)).resolves.toEqual({
          chatId: reserved[0]?.chatId,
          worktreeId: 'wt-new',
          delivery: 'queued_for_setup',
        });
        expect(dispatched).toEqual([agentWriteMessageId(key)]);
        expect(
          rendererAction.mock.calls.map((args: unknown[]) => args[1] as string),
        ).toEqual([`${key}:worktree`, `${key}:worktree`]);
      });
    });

    it.each([
      [
        'a workspace approval rule changes without changing either policy',
        (): void => {
          markWorkspaceApprovalRulesChanged('ws-1');
        },
      ],
      [
        "the calling chat's approval state is rewritten unchanged",
        (): void => {
          markChatApprovalStateChanged({
            projectId: 'ws-1',
            worktreeId: 'wt-1',
            chatId: 'chat-parent',
          });
        },
      ],
    ])(
      'admits a new worktree start whose first message is checked again when %s',
      async (_case, change) => {
        const reserved: ChatSendMessageRequest[] = [];
        const dispatched: string[] = [];
        const port = createDesktopEnvironmentPort(
          deps({
            chatApprovalPolicy: () => policy('auto'),
            reserveChat: (request) => {
              reserved.push(request);
              return Promise.resolve();
            },
          }),
        );
        let changeOnce: (() => void) | undefined = change;
        mockInstruction.mockImplementation(
          async (
            _name: string,
            params: { commandId: string; chatId: string; messageId: string },
          ) => {
            changeOnce?.();
            changeOnce = undefined;
            await Promise.resolve();
            const tab = reserved.find(
              (request) => request.chatId === params.chatId,
            );
            const refusal = chatSendAdmissionCheck({
              projectId: 'ws-1',
              worktreeId: 'wt-new',
              chatId: params.chatId,
              userMessageId: params.messageId,
            })?.({
              ...(tab?.approvalMode ? { approvalMode: tab.approvalMode } : {}),
              ...(tab?.sessionApprovalRules
                ? { sessionApprovalRules: tab.sessionApprovalRules }
                : {}),
            });
            if (refusal !== undefined) {
              return {
                commandId: params.commandId,
                revision: 2,
                outcome: 'rejected',
                reason: refusal,
              };
            }
            dispatched.push(params.messageId);
            return {
              commandId: params.commandId,
              revision: 2,
              outcome: 'applied',
            };
          },
        );
        const key = `unrelated-worktree-${_case}`;
        await expect(
          port.startChat(
            {
              scope: { workspaceId: 'ws-1', worktreeId: 'wt-1' },
              placement: 'new_worktree',
              message: { text: 'Prototype it.' },
              lineage: { parentChatId: 'chat-parent', depth: 1 },
              idempotencyKey: key,
            },
            call,
          ),
        ).resolves.toMatchObject({
          worktreeId: 'wt-new',
          delivery: 'queued_for_setup',
        });
        expect(dispatched).toEqual([agentWriteMessageId(key)]);
      },
    );

    describe("a start whose calling chat's approvals change while the start reads its policy", () => {
      const placements = [
        ['current', 'ws-1', 'wt-1'],
        ['new_worktree', 'ws-1', 'wt-1'],
        ['cowork current', 'cw-1', 'entry-1'],
      ] as const;
      const changes = ['deny', 'grant', 'mode'] as const;
      const cases = placements.flatMap((placement) =>
        changes.map((change) => [...placement, change] as const),
      );

      afterEach(() => {
        clearLiveApprovalMode('ws-1', 'wt-1', 'chat-parent');
        clearLiveApprovalMode('cw-1', 'entry-1', 'chat-parent');
      });

      it.each(cases)(
        'checks a %s start again when a %s/%s caller %s change commits mid-read, refusing it unless the started chat stays within the caller',
        async (placement, workspaceId, worktreeId, change) => {
          const startCall: AgentActionCall<CanopyInjectedToolRuntime> = {
            ...call,
            scope: { workspaceId, worktreeId, chatId: 'chat-parent' },
          };
          const callerRoot = executionRoot({ worktreeId });
          const grant = rule('allow', 'npm test');
          const callerRules: ApprovalRule[] = change === 'grant' ? [grant] : [];
          let callerMode: ApprovalMode = 'auto';
          const reserved: ChatSendMessageRequest[] = [];
          let changed = false;
          const commitChange = (): void => {
            changed = true;
            if (change === 'deny') {
              callerRules.push(rule('deny', 'rm -rf dist'));
            } else if (change === 'grant') {
              callerRules.splice(0, callerRules.length);
            } else {
              callerMode = 'ask';
              setLiveApprovalMode(
                workspaceId,
                worktreeId,
                'chat-parent',
                'ask',
              );
            }
            markChatApprovalStateChanged({
              projectId: workspaceId,
              worktreeId,
              chatId: 'chat-parent',
            });
          };
          const port = createDesktopEnvironmentPort(
            deps({
              chatApprovalPolicy: (chat) =>
                chat.chatId === 'chat-parent'
                  ? Promise.resolve({
                      mode: callerMode,
                      sessionRules: [...callerRules],
                      root: callerRoot,
                    })
                  : policy('auto'),
              newChatApprovalMode: () => Promise.resolve('auto'),
              reserveChat: (request) => {
                reserved.push(request);
                return Promise.resolve();
              },
              chatExecutionRoot: (chat) => {
                if (reserved.length > 0 && !changed) commitChange();
                return Promise.resolve(executionRoot(chat));
              },
            }),
          );
          const dispatched: string[] = [];
          mockInstruction.mockImplementation(
            async (
              _name: string,
              params: {
                commandId: string;
                chatId: string;
                messageId: string;
                scope: { workspaceId: string; worktreeId: string };
              },
            ) => {
              await Promise.resolve();
              const tab = reserved.find(
                (request) => request.chatId === params.chatId,
              );
              const refusal = chatSendAdmissionCheck({
                projectId: params.scope.workspaceId,
                worktreeId: params.scope.worktreeId,
                chatId: params.chatId,
                userMessageId: params.messageId,
              })?.({
                ...(tab?.approvalMode
                  ? { approvalMode: tab.approvalMode }
                  : {}),
                ...(tab?.sessionApprovalRules
                  ? { sessionApprovalRules: tab.sessionApprovalRules }
                  : {}),
                ...(tab?.selectedRepoId
                  ? { selectedRepoId: tab.selectedRepoId }
                  : {}),
              });
              if (refusal !== undefined) {
                return {
                  commandId: params.commandId,
                  revision: 2,
                  outcome: 'rejected',
                  reason: refusal,
                };
              }
              dispatched.push(params.messageId);
              return {
                commandId: params.commandId,
                revision: 2,
                outcome: 'applied',
              };
            },
          );

          const failure = await port
            .startChat(
              {
                scope: { workspaceId, worktreeId },
                placement:
                  placement === 'new_worktree' ? 'new_worktree' : 'current',
                message: { text: 'Do it.' },
                lineage: { parentChatId: 'chat-parent', depth: 1 },
                idempotencyKey: `mid-read-${placement}-${change}`,
              },
              startCall,
            )
            .catch((error: unknown) => error);

          expect(changed).toBe(true);
          if (change === 'grant') {
            expect(failure).not.toBeInstanceOf(Error);
            expect(dispatched).toHaveLength(1);
          } else {
            expect(failure).toMatchObject({
              code: 'authorization_conflict',
              retryable: false,
            });
            expect(dispatched).toEqual([]);
          }
        },
      );
    });

    it('refuses to message a chat that runs with broader approvals than the calling chat', async () => {
      const port = createDesktopEnvironmentPort(
        deps({
          chatApprovalPolicy: (chat) =>
            policy(chat.chatId === 'chat-parent' ? 'ask' : 'full-access'),
        }),
      );
      await expect(
        port.postMessage(
          {
            scope: { workspaceId: 'ws-1', worktreeId: 'wt-1' },
            chatId: 'chat-busy',
            text: 'Delete the build folder.',
            idempotencyKey: 'broader-1',
          },
          call,
        ),
      ).rejects.toMatchObject({
        code: 'authorization_conflict',
        retryable: false,
      });
      expect(mockInstruction).not.toHaveBeenCalled();
    });

    const rule = (
      behavior: 'allow' | 'deny',
      command: string,
      id = `${behavior}-${command}`,
    ): ApprovalRule => ({
      id,
      behavior,
      target: { kind: 'command', pattern: command },
      createdAt: '2026-01-01T00:00:00.000Z',
      origin: 'prompt',
    });
    const post = (
      port: ReturnType<typeof createDesktopEnvironmentPort>,
      key: string,
    ): Promise<unknown> =>
      port.postMessage(
        {
          scope: { workspaceId: 'ws-1', worktreeId: 'wt-1' },
          chatId: 'chat-busy',
          text: 'Run the deploy.',
          idempotencyKey: key,
        },
        call,
      );

    it.each([
      [
        'an allow grant only the target holds',
        [],
        [rule('allow', 'npm publish')],
      ],
      ['a deny rule the target lacks', [rule('deny', 'rm -rf dist')], []],
    ] as const)(
      'refuses to message an Ask chat with %s',
      async (_case, callerRules, targetRules) => {
        const port = createDesktopEnvironmentPort(
          deps({
            chatApprovalPolicy: (chat) =>
              policy(
                'ask',
                chat.chatId === 'chat-parent' ? callerRules : targetRules,
              ),
          }),
        );
        await expect(post(port, `grant-${_case}`)).rejects.toMatchObject({
          code: 'authorization_conflict',
          retryable: false,
        });
        expect(mockInstruction).not.toHaveBeenCalled();
      },
    );

    it("refuses to message an Ask chat in another repository that holds the caller's relative grant", async () => {
      const grant: ApprovalRule = {
        id: 'allow-deploy-config',
        behavior: 'allow',
        target: { kind: 'file-write', path: 'deploy/config.ts' },
        createdAt: '2026-01-01T00:00:00.000Z',
        origin: 'prompt',
      };
      const port = createDesktopEnvironmentPort(
        deps({
          chatApprovalPolicy: (chat) =>
            policy(
              'ask',
              [grant],
              executionRoot({
                worktreeId: 'wt-1',
                selectedRepoId:
                  chat.chatId === 'chat-parent' ? 'repo-a' : 'repo-b',
              }),
            ),
        }),
      );
      await expect(post(port, 'relative-grant')).rejects.toMatchObject({
        code: 'authorization_conflict',
        retryable: false,
      });
      expect(mockInstruction).not.toHaveBeenCalled();
    });

    it.each([
      ['refuses', 'repo-b'],
      ['allows', 'repo-a'],
    ] as const)(
      '%s a message to an Ask chat in %s that holds the npm test grant of a caller in repo-a',
      async (verdict, targetRepo) => {
        const npmTest = rule('allow', 'npm test');
        const roots = {
          caller: executionRoot({
            worktreeId: 'wt-1',
            selectedRepoId: 'repo-a',
          }),
          target: executionRoot({
            worktreeId: 'wt-1',
            selectedRepoId: targetRepo,
          }),
        };
        const allowsWithoutAsking = (root: string): boolean =>
          evaluateApproval(
            { kind: 'command', command: 'npm test', cwd: root },
            {
              mode: 'ask',
              rules: { session: [npmTest], project: [], global: [] },
              workspaceRoot: root,
            },
          ).outcome === 'allow';
        expect(allowsWithoutAsking(roots.caller)).toBe(true);
        expect(allowsWithoutAsking(roots.target)).toBe(true);
        const port = createDesktopEnvironmentPort(
          deps({
            chatApprovalPolicy: (chat) =>
              policy(
                'ask',
                [npmTest],
                chat.chatId === 'chat-parent' ? roots.caller : roots.target,
              ),
          }),
        );
        if (verdict === 'refuses') {
          await expect(
            post(port, `command-grant-${targetRepo}`),
          ).rejects.toMatchObject({
            code: 'authorization_conflict',
            retryable: false,
          });
          expect(mockInstruction).not.toHaveBeenCalled();
        } else {
          await post(port, `command-grant-${targetRepo}`);
          expect(mockInstruction.mock.calls[0]?.[0]).toBe(
            'core.chat.message.send',
          );
        }
      },
    );

    it('refuses to message an Auto chat in a sibling worktree from an Auto chat', async () => {
      const port = createDesktopEnvironmentPort(
        deps({
          chatApprovalPolicy: (chat) =>
            chat.chatId === 'chat-parent'
              ? policy('auto', [], '/ws/worktrees/wt-1')
              : policy('auto', [], '/ws/worktrees/wt-2'),
        }),
      );
      await expect(post(port, 'sibling-root')).rejects.toMatchObject({
        code: 'authorization_conflict',
        retryable: false,
      });
      expect(mockInstruction).not.toHaveBeenCalled();
    });

    it.each(['current', 'new_worktree'] as const)(
      'starts an Auto %s chat from an Auto chat: a new worktree is scope the start itself creates',
      async (placement) => {
        const reserveChat = jest.fn(() => Promise.resolve());
        const port = createDesktopEnvironmentPort(
          deps({
            reserveChat,
            chatApprovalPolicy: () => policy('auto', [], '/ws/worktrees/wt-1'),
            newChatApprovalMode: () => Promise.resolve('auto'),
          }),
        );
        await port.startChat(
          startInput(placement, `delegated-${placement}`),
          call,
        );
        expect(reserveChat).toHaveBeenCalledWith(
          expect.objectContaining({ approvalMode: 'auto' }),
          call,
        );
      },
    );

    describe("the policy each chat's approval session applies", () => {
      /** What a chat's own approval session decides, without prompting. */
      async function sessionDecides(
        chat: {
          worktreeId: string;
          mode: ApprovalMode;
          sessionRules: readonly ApprovalRule[];
          root: string;
        },
        check: ApprovalCheck,
      ): Promise<string> {
        const session = createApprovalSession({
          sessionKey: `port-${Math.random()}`,
          projectId: 'ws-1',
          worktreeId: chat.worktreeId,
          chatId: 'chat',
          provider: 'claude',
          workspaceRoot: chat.root,
          mode: chat.mode,
          sessionRules: [...chat.sessionRules],
          getWindow: () => null,
          trackChatTurn: false,
        });
        try {
          return (await session.evaluate?.(check)) ?? 'missing';
        } finally {
          session.dispose();
        }
      }

      afterEach(async () => {
        await writeWorkspaceApprovals('ws-1', { version: 1, rules: [] });
      });

      it('refuses to message an Ask chat in another repository whose workspace grant allows a write the caller is asked about', async () => {
        await addWorkspaceApprovalRule('ws-1', {
          id: 'allow-deploy',
          behavior: 'allow',
          target: { kind: 'file-write', path: 'deploy/**' },
          createdAt: '2026-01-01T00:00:00.000Z',
          origin: 'settings',
        });
        const rootOf = (chatId: string): string =>
          executionRoot({
            worktreeId: 'wt-1',
            selectedRepoId: chatId === 'chat-parent' ? 'repo-a' : 'repo-b',
          });
        const deployConfig = `${rootOf('chat-busy')}/deploy/config.ts`;
        const write: ApprovalCheck = { kind: 'file-write', path: deployConfig };
        const chat = (
          chatId: string,
        ): {
          worktreeId: string;
          mode: ApprovalMode;
          sessionRules: ApprovalRule[];
          root: string;
        } => ({
          worktreeId: 'wt-1',
          mode: 'ask',
          sessionRules: [],
          root: rootOf(chatId),
        });
        await expect(sessionDecides(chat('chat-parent'), write)).resolves.toBe(
          'prompt',
        );
        await expect(sessionDecides(chat('chat-busy'), write)).resolves.toBe(
          'allow',
        );

        const port = createDesktopEnvironmentPort(
          deps({
            chatApprovalPolicy: (target) =>
              policy('ask', [], rootOf(target.chatId)),
          }),
        );
        await expect(
          port.postMessage(
            {
              scope: { workspaceId: 'ws-1', worktreeId: 'wt-1' },
              chatId: 'chat-busy',
              text: 'Update the deploy config.',
              idempotencyKey: 'workspace-grant-repo-b',
            },
            call,
          ),
        ).rejects.toMatchObject({ code: 'authorization_conflict' });
        expect(mockInstruction).not.toHaveBeenCalled();
      });

      it("keeps the calling chat's src/** deny on its own files for a chat it starts in a new worktree", async () => {
        const denySrc: ApprovalRule = {
          id: 'deny-src',
          behavior: 'deny',
          target: { kind: 'file-write', path: 'src/**' },
          createdAt: '2026-01-01T00:00:00.000Z',
          origin: 'prompt',
        };
        const caller = {
          worktreeId: 'wt-1',
          mode: 'ask' as const,
          sessionRules: [denySrc],
          root: executionRoot({ worktreeId: 'wt-1' }),
        };
        const original: ApprovalCheck = {
          kind: 'file-write',
          path: `${caller.root}/src/index.ts`,
        };
        await expect(sessionDecides(caller, original)).resolves.toBe('deny');

        const reserveChat = jest.fn(() => Promise.resolve());
        const port = createDesktopEnvironmentPort(
          deps({
            reserveChat,
            chatApprovalPolicy: () => Promise.resolve(caller),
            newChatApprovalMode: () => Promise.resolve('full-access'),
          }),
        );
        await port.startChat(startInput('new_worktree', 'deny-original'), call);
        const reserved = reserveChat.mock.calls[0]?.[0] as
          | ChatSendMessageRequest
          | undefined;
        expect(reserved?.worktreeId).toBe('wt-new');
        const child = {
          worktreeId: 'wt-new',
          mode: reserved?.approvalMode ?? 'full-access',
          sessionRules: reserved?.sessionApprovalRules ?? [],
          root: executionRoot({ worktreeId: 'wt-new' }),
        };
        await expect(sessionDecides(child, original)).resolves.toBe('deny');
        // Its own copy of src is protected too.
        await expect(
          sessionDecides(child, {
            kind: 'file-write',
            path: `${child.root}/src/index.ts`,
          }),
        ).resolves.toBe('deny');
      });
    });

    describe("the calling chat's repository", () => {
      const repoACaller = (): Promise<DesktopChatApprovalPolicy> =>
        Promise.resolve({
          mode: 'auto',
          sessionRules: [],
          root: executionRoot({ worktreeId: 'wt-1', selectedRepoId: 'repo-a' }),
          selectedRepoId: 'repo-a',
        });
      const writeOutcome = (
        mode: ApprovalMode,
        session: readonly ApprovalRule[],
        root: string,
        path: string,
      ): string =>
        evaluateApproval(
          { kind: 'file-write', path, resolvedPath: path },
          {
            mode,
            rules: { session: [...session], project: [], global: [] },
            workspaceRoot: root,
          },
        ).outcome;

      it.each(['current', 'new_worktree'] as const)(
        'starts a %s chat scoped to it, so a sibling repository write still prompts',
        async (placement) => {
          const reserveChat = jest.fn<Promise<void>, [ChatSendMessageRequest]>(
            () => Promise.resolve(),
          );
          const port = createDesktopEnvironmentPort(
            deps({
              reserveChat,
              chatApprovalPolicy: repoACaller,
              newChatApprovalMode: () => Promise.resolve('full-access'),
            }),
          );
          await port.startChat(
            startInput(placement, `repo-scope-${placement}`),
            call,
          );

          const worktreeId = placement === 'current' ? 'wt-1' : 'wt-new';
          const sibling = `${executionRoot({ worktreeId })}/repo-b/config.ts`;
          const caller = await repoACaller();
          expect(
            writeOutcome(
              caller.mode,
              caller.sessionRules,
              caller.root ?? '',
              `${executionRoot({ worktreeId: 'wt-1' })}/repo-b/config.ts`,
            ),
          ).toBe('prompt');
          const requests = reserveChat.mock.calls.map(([request]) => request);
          expect(requests.length).toBeGreaterThan(0);
          for (const request of requests) {
            const childRoot = executionRoot({
              worktreeId: request.worktreeId,
              ...(request.selectedRepoId
                ? { selectedRepoId: request.selectedRepoId }
                : {}),
            });
            expect(childRoot).toBe(
              executionRoot({ worktreeId, selectedRepoId: 'repo-a' }),
            );
            expect(
              writeOutcome(
                request.approvalMode ?? 'full-access',
                request.sessionApprovalRules ?? [],
                childRoot,
                sibling,
              ),
            ).toBe('prompt');
          }
        },
      );

      it.each([
        ['current', 'broader', '/ws/worktrees/wt-1'],
        ['current', 'unresolvable', undefined],
        ['new_worktree', 'broader', '/ws/worktrees/wt-new'],
        ['new_worktree', 'unresolvable', undefined],
      ] as const)(
        'refuses a %s start whose chat would run in a %s root',
        async (placement, _case, childRoot) => {
          const reserveChat = jest.fn(() => Promise.resolve());
          const rendererAction = jest.fn((action: { type: string }) =>
            Promise.resolve(
              action.type === 'worktree.create'
                ? {
                    ok: true,
                    result: { workspaceId: 'ws-1', worktreeId: 'wt-new' },
                  }
                : { ok: true },
            ),
          );
          const port = createDesktopEnvironmentPort(
            deps({
              reserveChat,
              rendererAction,
              chatApprovalPolicy: repoACaller,
              newChatApprovalMode: () => Promise.resolve('full-access'),
              chatExecutionRoot: (chat) =>
                Promise.resolve(
                  chat.selectedRepoId ? childRoot : executionRoot(chat),
                ),
            }),
          );
          await expect(
            port.startChat(
              startInput(placement, `outside-${placement}-${_case}`),
              call,
            ),
          ).rejects.toMatchObject({
            code: 'authorization_conflict',
            retryable: false,
          });
          expect(reserveChat).not.toHaveBeenCalled();
          expect(mockInstruction).not.toHaveBeenCalled();
          expect(
            rendererAction.mock.calls.map(([action]) => action.type),
          ).not.toContain('worktree-chat.send_message');
        },
      );

      it('refuses to start a chat when the calling chat has no root', async () => {
        const reserveChat = jest.fn(() => Promise.resolve());
        const port = createDesktopEnvironmentPort(
          deps({
            reserveChat,
            chatApprovalPolicy: () =>
              Promise.resolve({ mode: 'ask', sessionRules: [] }),
          }),
        );
        await expect(
          port.startChat(startInput('current', 'rootless-caller'), call),
        ).rejects.toMatchObject({ code: 'authorization_conflict' });
        expect(reserveChat).not.toHaveBeenCalled();
      });
    });

    it('messages a chat whose session grants the calling chat also holds', async () => {
      const port = createDesktopEnvironmentPort(
        deps({
          chatApprovalPolicy: (chat) =>
            policy(
              'ask',
              chat.chatId === 'chat-parent'
                ? [
                    rule('allow', 'npm test', 'caller-rule'),
                    rule('allow', 'ls'),
                  ]
                : [rule('allow', 'npm test', 'target-rule')],
            ),
        }),
      );
      await post(port, 'grant-covered');
      expect(mockInstruction.mock.calls[0]?.[0]).toBe('core.chat.message.send');
    });

    it.each([
      ['auto', 'auto'],
      ['auto', 'ask'],
      ['full-access', 'auto'],
    ] as const)(
      'lets a %s chat message a chat that runs in %s mode',
      async (parentMode, targetMode) => {
        const chatApprovalPolicy = jest.fn((chat: { chatId: string }) =>
          policy(chat.chatId === 'chat-parent' ? parentMode : targetMode),
        );
        const port = createDesktopEnvironmentPort(deps({ chatApprovalPolicy }));
        await port.postMessage(
          {
            scope: { workspaceId: 'ws-1', worktreeId: 'wt-1' },
            chatId: 'chat-busy',
            text: 'Also check the docs.',
            idempotencyKey: `narrower-${parentMode}-${targetMode}`,
          },
          call,
        );
        expect(chatApprovalPolicy).toHaveBeenCalledWith(
          { workspaceId: 'ws-1', worktreeId: 'wt-1', chatId: 'chat-busy' },
          call,
        );
        expect(mockInstruction.mock.calls[0]?.[0]).toBe(
          'core.chat.message.send',
        );
      },
    );
  });

  it.each(['current', 'new_worktree'] as const)(
    "records a %s start's lineage before its first message is sent",
    async (placement) => {
      const depths: number[] = [];
      const lineage = createDesktopAgentLineage();
      const depthOf = (chatId: string): Promise<void> => {
        depths.push(lineage.depthOf(chatId));
        return Promise.resolve();
      };
      const port = createDesktopEnvironmentPort(deps({ lineage }));
      mockInstruction.mockImplementation(
        async (
          _name: string,
          params: { commandId: string; chatId: string },
        ) => {
          await depthOf(params.chatId);
          return {
            commandId: params.commandId,
            revision: 2,
            outcome: 'applied',
          };
        },
      );
      await port.startChat(
        {
          scope: { workspaceId: 'ws-1', worktreeId: 'wt-1' },
          placement,
          message: { text: 'Nest it.' },
          lineage: { parentChatId: 'chat-parent', depth: 2 },
          idempotencyKey: `lineage-${placement}`,
        },
        call,
      );
      expect(depths).toEqual([2]);
    },
  );

  it("submits each agent write's message under the id its inline watchers are bound to", async () => {
    const bound: (string | null)[] = [];
    const port = createDesktopEnvironmentPort(deps());
    await port.startChat(
      {
        scope: { workspaceId: 'ws-1', worktreeId: 'wt-1' },
        placement: 'current',
        message: { text: 'Start.' },
        lineage: { parentChatId: 'chat-parent', depth: 1 },
        idempotencyKey: 'bound-start',
        beforeFirstMessage: () => {
          bound.push(agentWriteMessageId('bound-start'));
          return Promise.resolve();
        },
      },
      call,
    );
    expect(mockInstruction.mock.calls.at(-1)?.[1]).toMatchObject({
      messageId: agentWriteMessageId('bound-start'),
    });
    await port.postMessage(
      {
        scope: { workspaceId: 'ws-1', worktreeId: 'wt-1' },
        chatId: 'chat-busy',
        text: 'Next.',
        idempotencyKey: 'bound-post',
      },
      call,
    );
    expect(mockInstruction.mock.calls.at(-1)?.[1]).toMatchObject({
      messageId: agentWriteMessageId('bound-post'),
    });
    await port.startChat(
      {
        scope: { workspaceId: 'ws-1', worktreeId: 'wt-1' },
        placement: 'new_worktree',
        message: { text: 'Prototype.' },
        lineage: { parentChatId: 'chat-parent', depth: 1 },
        idempotencyKey: 'worktree-start',
        beforeFirstMessage: () => {
          bound.push(agentWriteMessageId('worktree-start'));
          return Promise.resolve();
        },
      },
      call,
    );
    expect(mockInstruction.mock.calls.at(-1)?.[1]).toMatchObject({
      messageId: agentWriteMessageId('worktree-start'),
    });
    expect(bound).toEqual([
      agentWriteMessageId('bound-start'),
      agentWriteMessageId('worktree-start'),
    ]);
  });

  it('lists models for the owner of the calling chat', async () => {
    const owner = { kind: 'organization', organizationId: 'org-1' };
    mockResolveScopeOwner.mockResolvedValue(owner);
    mockBuildCatalog.mockReturnValue([
      { id: 'model-a', isDefault: true },
      { id: 'model-b' },
    ]);
    await expect(
      desktopEnvironmentPortDeps().listModels(call),
    ).resolves.toEqual({
      models: [{ id: 'model-a', isDefault: true }, { id: 'model-b' }],
      defaultModelId: 'model-a',
    });
    expect(mockResolveScopeOwner).toHaveBeenCalledWith({
      kind: 'work',
      projectId: 'ws-1',
      worktreeId: 'wt-1',
      chatId: 'chat-parent',
    });
    expect(mockBuildCatalog).toHaveBeenCalledWith(undefined, {
      cursor: true,
      copilot: true,
      owner,
    });
  });

  describe('in a Cowork workspace', () => {
    const coworkCall: AgentActionCall<CanopyInjectedToolRuntime> = {
      ...call,
      scope: {
        workspaceId: 'cw-1',
        worktreeId: 'entry-1',
        chatId: 'chat-parent',
      },
    };
    const coworkDeps = (): DesktopEnvironmentPortDeps =>
      deps({
        listWorkEntries: () =>
          Promise.resolve([
            {
              entryId: 'entry-1',
              title: 'Plan',
              createdAt: '2026-01-01T00:00:00.000Z',
            },
            {
              entryId: 'entry-2',
              title: 'Notes',
              createdAt: '2026-01-02T00:00:00.000Z',
            },
          ]),
      });

    it('attributes a posted message without waiting for setup', async () => {
      const port = createDesktopEnvironmentPort(
        deps({
          ...coworkDeps(),
          agentSenderFields: (_call, acceptedInputId) =>
            Promise.resolve(senderFields(acceptedInputId)),
        }),
      );
      await port.postMessage(
        {
          scope: { workspaceId: 'cw-1', worktreeId: 'entry-2' },
          chatId: 'chat-cowork',
          text: 'Hi.',
          idempotencyKey: 'key-cowork-post',
        },
        coworkCall,
      );
      expect(mockLegacyCommands).toHaveLength(1);
      expect(mockLegacyCommands[0]?.command).toMatchObject(
        senderFields(agentWriteMessageId('key-cowork-post')),
      );
      expect(mockLegacyCommands[0]?.command).not.toHaveProperty(
        'agentSendSetup',
      );
    });

    it('finds a chat in another Work Entry', async () => {
      const port = createDesktopEnvironmentPort(coworkDeps());
      await expect(
        port.getChat(
          { scope: { workspaceId: 'cw-1' }, chatId: 'chat-cowork' },
          coworkCall,
        ),
      ).resolves.toMatchObject({
        chatId: 'chat-cowork',
        workspaceId: 'cw-1',
        worktreeId: 'entry-2',
      });
    });
  });

  describe('agent message admission', () => {
    const target = {
      workspaceId: 'ws-1',
      worktreeId: 'wt-9',
      chatId: 'chat-x',
    };
    const askCaller = (chat: {
      chatId: string;
    }): Promise<DesktopChatApprovalPolicy> =>
      chat.chatId === 'chat-parent'
        ? policy('ask')
        : policy('ask', [], '/ws/worktrees/wt-9');

    it('refuses a terminal-driven target, whose approvals it cannot read', async () => {
      const port = createDesktopEnvironmentPort(
        deps({ terminalDrivenChatIds: () => Promise.resolve(['chat-x']) }),
      );
      await expect(
        port.agentMessageAdmission(target, call),
      ).rejects.toMatchObject({
        code: 'invalid_target',
        message: terminalChatRefusal('chat-x'),
      });
    });

    it('refuses a target with broader approvals than the calling chat', async () => {
      const port = createDesktopEnvironmentPort(
        deps({
          chatApprovalPolicy: (chat) =>
            chat.chatId === 'chat-parent'
              ? policy('ask')
              : policy('full-access', [], '/ws/worktrees/wt-9'),
        }),
      );
      await expect(
        port.agentMessageAdmission(target, call),
      ).rejects.toMatchObject({ code: 'authorization_conflict' });
    });

    it('admits a contained target and reports changed approvals as retryable', async () => {
      let revision = 1;
      const port = createDesktopEnvironmentPort(
        deps({
          chatApprovalPolicy: askCaller,
          approvalSettingsRevision: () => revision,
        }),
      );
      const admission = await port.agentMessageAdmission(target, call);
      expect(admission.check({})).toBeUndefined();
      expect(admission.refusal()).toBeUndefined();
      revision = 2;
      expect(admission.check({})).toEqual(expect.any(String));
      expect(admission.refusal()).toMatchObject({
        code: 'stale_ui_state',
        retryable: true,
      });
    });

    it("refuses a send whose own copy of the tab's settings is not the one it read", async () => {
      const port = createDesktopEnvironmentPort(
        deps({ chatApprovalPolicy: askCaller }),
      );
      await expect(
        port.agentMessageAdmission(target, call, { kind: 'chat' }),
      ).resolves.toBeDefined();
      await expect(
        port.agentMessageAdmission(target, call, {
          selectedRepoId: 'other-repo',
        }),
      ).rejects.toMatchObject({ code: 'stale_ui_state', retryable: true });
      await expect(
        port.agentMessageAdmission(target, call, {
          providerType: 'claude',
          interfaceMode: 'claude-code',
          sdkSessionId: 'session',
        }),
      ).rejects.toMatchObject({
        code: 'invalid_target',
        message: terminalChatRefusal('chat-x'),
      });
    });

    it("compares a queued send's carried approval settings with the target's current ones", async () => {
      const denySecrets: ApprovalRule = {
        id: 'deny-secrets',
        behavior: 'deny',
        target: { kind: 'file-write', path: '/ws/worktrees/wt-9/secrets/**' },
        createdAt: '2026-01-01T00:00:00.000Z',
        origin: 'prompt',
      };
      let targetRules: readonly ApprovalRule[] = [];
      const port = createDesktopEnvironmentPort(
        deps({
          chatApprovalPolicy: (chat) =>
            chat.chatId === 'chat-parent'
              ? policy('ask')
              : policy('ask', targetRules, '/ws/worktrees/wt-9'),
        }),
      );
      // The mode the tab runs in, resolved when the send was queued.
      await expect(
        port.agentMessageAdmission(target, call, { approvalMode: 'ask' }),
      ).resolves.toBeDefined();
      targetRules = [denySecrets];
      // A send without its own copy of the rules runs with the tab's.
      await expect(
        port.agentMessageAdmission(target, call, {}),
      ).resolves.toBeDefined();
      // Rules carried from before the deny would run without it.
      await expect(
        port.agentMessageAdmission(target, call, { sessionApprovalRules: [] }),
      ).rejects.toMatchObject({ code: 'stale_ui_state' });
      await expect(
        port.agentMessageAdmission(target, call, {
          approvalMode: 'full-access',
        }),
      ).rejects.toMatchObject({ code: 'stale_ui_state' });
    });

    it('refuses at commit a target its terminal drives by then', async () => {
      const terminal: { turnState?: ClaudeTerminalTurnState } = {};
      const port = createDesktopEnvironmentPort(
        deps({
          chatApprovalPolicy: askCaller,
          terminalTurnStates: () => Promise.resolve(() => terminal.turnState),
        }),
      );
      const admission = await port.agentMessageAdmission(target, call);
      const claudeTab = {
        kind: 'chat' as const,
        providerType: 'claude' as const,
      };
      expect(admission.check(claudeTab)).toBeUndefined();
      expect(
        admission.check({
          ...claudeTab,
          interfaceMode: 'claude-code',
          sdkSessionId: 'session',
        }),
      ).toBe(terminalChatRefusal('chat-x'));
      terminal.turnState = 'running';
      expect(admission.check(claudeTab)).toBe(terminalChatRefusal('chat-x'));
      expect(admission.refusal()).toMatchObject({
        code: 'invalid_target',
        message: terminalChatRefusal('chat-x'),
      });
    });
  });

  describe('agent chat start admission', () => {
    const task = { workspaceId: 'ws-1', worktreeId: 'wt-9' };

    it("starts the chat in the stricter of the calling chat's mode and the default", async () => {
      const port = createDesktopEnvironmentPort(
        deps({ chatApprovalPolicy: () => policy('ask') }),
      );
      await expect(
        port.agentChatStartAdmission(task, true, call),
      ).resolves.toEqual({ approvalMode: 'ask' });
    });

    it('refuses before anything is created a first message the new chat would not admit', async () => {
      const denySrc: ApprovalRule = {
        id: 'deny-src',
        behavior: 'deny',
        target: { kind: 'file-write', path: '/ws/src/**' },
        createdAt: '2026-01-01T00:00:00.000Z',
        origin: 'prompt',
      };
      const port = createDesktopEnvironmentPort(
        deps({ chatApprovalPolicy: () => policy('ask', [denySrc]) }),
      );
      await expect(
        port.agentChatStartAdmission(task, true, call),
      ).rejects.toMatchObject({ code: 'authorization_conflict' });
      await expect(
        port.agentChatStartAdmission(task, false, call),
      ).resolves.toEqual({ approvalMode: 'ask' });
    });
  });

  it('maps dispatcher failures to port errors', async () => {
    mockQuery.mockRejectedValueOnce(
      new CanopyOperationError({
        kind: 'not_found',
        message: 'Worktree not found.',
        retry: { kind: 'never' },
      }),
    );
    const port = createDesktopEnvironmentPort(deps());
    await expect(
      port.query(
        'core.worktree.get',
        { scope: { workspaceId: 'ws-1' }, worktreeId: 'wt-x' },
        call,
      ),
    ).rejects.toEqual(new AgentPortError('not_found', 'Worktree not found.'));
  });
});
