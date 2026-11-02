import { createDesktopTranscriptReadPort } from '../desktop-transcript-read-port';
const mockQuery = jest.fn<Promise<unknown>, [string, unknown, unknown]>();
const mockInstruction = jest.fn<Promise<unknown>, [string, unknown, unknown]>();

jest.mock('../../canopy-runtime/desktop-runtime-access', () => ({
  getDesktopCanopyRuntime: (): object => ({
    query: mockQuery,
    instruction: mockInstruction,
  }),
}));

import {
  createInMemoryAgentActionLimits,
  createInMemoryAgentActionReceipts,
  type AgentActionCall,
  type AgentActionSplitPort,
  type AgentChatWatcherPort,
} from '@canopy/agent-actions';
import type {
  ClaudeTerminalTurnState,
  PersistedChatTab,
} from '@canopy/desktop-shared/types';
import type { CanopyInjectedToolRuntime } from '../../canopy-tools/core';
import { isTerminalDrivenChat } from '../../lib/terminal-driven-chat';
import {
  createDesktopEnvironmentPort,
  desktopEnvironmentPortDeps,
  terminalChatRefusal,
} from '../desktop-environment-port';
import { createDesktopAgentLineage } from '../desktop-limits-port';
import { createDesktopAgentActionSurface } from '../desktop-surface';
import { seedEmptyApprovalRuleSources } from '../../__tests__/helpers/approval-rule-sources';

const runtime: CanopyInjectedToolRuntime = {
  requestUserAnswers: () => Promise.resolve([]),
  loadScriptOutput: () => Promise.resolve({ found: false, lines: [] }),
  worktreeActionRuntime: {
    projectId: 'ws-1',
    worktreeId: 'wt-1',
    chatId: 'chat-parent',
    cwd: '/ws/worktrees/wt-1',
    getWindow: () => null,
  },
  worktreeWatcherRuntime: {
    projectId: 'ws-1',
    worktreeId: 'wt-1',
    chatId: 'chat-parent',
  },
};

const call: AgentActionCall<CanopyInjectedToolRuntime> = {
  host: runtime,
  scope: { workspaceId: 'ws-1', worktreeId: 'wt-1', chatId: 'chat-parent' },
  actorKey: 'local-desktop-user',
  turnKey: 'chat-parent:u1',
  toolUseId: 'tool-1',
};

const tab = (
  id: string,
  fields: Partial<PersistedChatTab>,
): PersistedChatTab => ({
  id,
  title: id,
  createdAt: '2026-01-01T00:00:00.000Z',
  messages: [],
  ...fields,
});

/** The persisted tabs and live terminal turns of worktree wt-1. */
const TABS: Record<
  string,
  { tab: PersistedChatTab; turn?: ClaudeTerminalTurnState }
> = {
  'chat-parent': { tab: tab('chat-parent', { providerType: 'claude' }) },
  'chat-sdk': {
    tab: tab('chat-sdk', { providerType: 'claude', interfaceMode: 'canopy' }),
  },
  'chat-terminal': {
    tab: tab('chat-terminal', {
      providerType: 'claude',
      interfaceMode: 'claude-code',
      sdkSessionId: 'session-1',
    }),
  },
  'chat-terminal-turn': {
    tab: tab('chat-terminal-turn', { providerType: 'claude' }),
    turn: 'running',
  },
};

function chatItem(chatId: string): Record<string, unknown> {
  return {
    chatId,
    workspaceId: 'ws-1',
    worktreeId: 'wt-1',
    title: chatId,
    state: 'idle',
    revision: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

function harness(): {
  dispatch: (action: Record<string, unknown>) => Promise<unknown>;
  reserveChat: jest.Mock;
  record: jest.Mock;
  reserve: jest.Mock;
  armChatCompletion: jest.Mock;
  chatApprovalPolicy: jest.Mock;
} {
  const reserveChat = jest.fn(() => Promise.resolve());
  const chatApprovalPolicy = jest.fn(() =>
    Promise.resolve({
      mode: 'ask' as const,
      sessionRules: [],
      root: '/ws/worktrees/wt-1',
    }),
  );
  const environment = createDesktopEnvironmentPort(
    desktopEnvironmentPortDeps({
      reserveChat,
      listModels: () => Promise.resolve({ models: [], defaultModelId: null }),
      chatApprovalPolicy,
      newChatApprovalMode: () => Promise.resolve('ask'),
      chatExecutionRoot: (chat) =>
        Promise.resolve(`/ws/worktrees/${chat.worktreeId}`),
      terminalDrivenChatIds: (_scope, chatIds) =>
        Promise.resolve(
          chatIds.filter((chatId) => {
            const entry = TABS[chatId];
            return entry ? isTerminalDrivenChat(entry.tab, entry.turn) : false;
          }),
        ),
      agentSenderFields: () => Promise.resolve(undefined),
      lineage: createDesktopAgentLineage(),
    }),
  );
  const limits = createInMemoryAgentActionLimits();
  const reserve = jest.fn((request: Parameters<typeof limits.reserve>[0]) =>
    limits.reserve(request),
  );
  const receipts =
    createInMemoryAgentActionReceipts<CanopyInjectedToolRuntime>();
  const record = jest.fn((...args: Parameters<typeof receipts.record>) =>
    receipts.record(...args),
  );
  const armChatCompletion = jest.fn(() =>
    Promise.resolve({ watcherId: 'watcher-1', created: true }),
  );
  const chatWatchers: AgentChatWatcherPort<CanopyInjectedToolRuntime> = {
    armChatCompletion,
    list: () => Promise.resolve([]),
    delete: (ids) =>
      Promise.resolve(
        ids.map((watcherId) => ({ watcherId, status: 'deleted' as const })),
      ),
  };
  const split: AgentActionSplitPort<CanopyInjectedToolRuntime> = {
    start: () => Promise.resolve({ text: 'unused', isError: true }),
  };
  const surface = createDesktopAgentActionSurface(runtime, {
    ports: {
      environment,
      transcriptRead: createDesktopTranscriptReadPort(),
      limits: { ...limits, reserve },
      chatWatchers,
      split,
      receipts: { ...receipts, record },
    },
  });
  return {
    dispatch: async (action) =>
      JSON.parse(
        (await surface.execute('dispatch_action', { action }, call)).text,
      ) as unknown,
    reserveChat,
    record,
    reserve,
    armChatCompletion,
    chatApprovalPolicy,
  };
}

beforeEach(() => {
  mockQuery.mockReset();
  mockInstruction.mockReset();
  mockQuery.mockImplementation((name: string) => {
    if (name === 'core.chat.list') {
      return Promise.resolve({
        items: Object.keys(TABS).map(chatItem),
        nextCursor: null,
      });
    }
    if (name === 'core.workspace.get') {
      return Promise.resolve({
        workspaceId: 'ws-1',
        name: 'Workspace',
        kind: 'git',
        repositorySources: [],
        settings: {},
      });
    }
    if (name === 'core.worktree.list') {
      return Promise.resolve({ items: [], nextCursor: null });
    }
    if (name === 'core.chat.transcript.page') {
      return Promise.resolve({
        messages: [],
        totalMessages: 0,
        transcriptRevision: 1,
      });
    }
    return Promise.reject(new Error(`Unexpected query ${name}`));
  });
  mockInstruction.mockImplementation((_name: string, params: unknown) => {
    if (
      !params ||
      typeof params !== 'object' ||
      !('commandId' in params) ||
      typeof params.commandId !== 'string'
    )
      throw new Error('Expected commandId');
    return Promise.resolve({
      commandId: params.commandId,
      revision: 2,
      outcome: 'applied',
    });
  });
});

beforeAll(async () => {
  await seedEmptyApprovalRuleSources(['ws-1']);
});

describe('terminal-driven chats', () => {
  it.each(['chat-terminal', 'chat-terminal-turn'])(
    'refuses chat.send_message to %s without recording, reserving, arming, or dispatching anything',
    async (chatId) => {
      const h = harness();
      const json = await h.dispatch({
        type: 'chat.send_message',
        chatId,
        message: 'Run the deploy.',
        watchers: [{ label: 'Deploy finished' }],
      });
      expect(json).toEqual({
        requestId: 'tool-1',
        ok: false,
        error: { code: 'invalid_target', message: terminalChatRefusal(chatId) },
      });
      expect(h.record).not.toHaveBeenCalled();
      expect(h.reserve).not.toHaveBeenCalled();
      expect(h.armChatCompletion).not.toHaveBeenCalled();
      expect(h.chatApprovalPolicy).not.toHaveBeenCalled();
      expect(h.reserveChat).not.toHaveBeenCalled();
      expect(mockInstruction).not.toHaveBeenCalled();
    },
  );

  it('lists and reads terminal-driven chats as not messageable', async () => {
    const h = harness();
    expect(await h.dispatch({ type: 'chat.list' })).toMatchObject({
      ok: true,
      result: {
        chats: [
          { chatId: 'chat-parent', messageable: true },
          { chatId: 'chat-sdk', messageable: true },
          { chatId: 'chat-terminal', messageable: false },
          { chatId: 'chat-terminal-turn', messageable: false },
        ],
      },
    });
    expect(
      await h.dispatch({ type: 'chat.get', chatId: 'chat-terminal' }),
    ).toMatchObject({
      ok: true,
      result: { chat: { chatId: 'chat-terminal', messageable: false } },
    });
  });

  it('still messages a chat that runs in the app', async () => {
    const h = harness();
    expect(
      await h.dispatch({ type: 'chat.get', chatId: 'chat-sdk' }),
    ).toMatchObject({ result: { chat: { messageable: true } } });
    expect(
      await h.dispatch({
        type: 'chat.send_message',
        chatId: 'chat-sdk',
        message: 'Also check the docs.',
      }),
    ).toMatchObject({ ok: true, result: { chatId: 'chat-sdk' } });
    expect(mockInstruction.mock.calls[0]?.[0]).toBe('core.chat.message.send');
  });
});
