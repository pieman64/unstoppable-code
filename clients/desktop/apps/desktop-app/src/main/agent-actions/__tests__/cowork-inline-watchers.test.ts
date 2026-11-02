import { createDesktopTranscriptReadPort } from '../desktop-transcript-read-port';
// chat.create in a Cowork workspace with inline watchers, through the real
// desktop surface, environment port, and chat watcher port. The watcher
// service mock applies the real Cowork rule: a standalone_chat target must
// already be a chat of the workspace when the watcher is set up.

const mockChats = new Set<string>();
const mockSetupOrder: string[] = [];

jest.mock('../../lib/workspace-registry', () => ({
  ...jest.requireActual<object>('../../lib/workspace-registry'),
  isCoworkWorkspace: (projectId: string): boolean => projectId === 'cw-1',
}));

jest.mock('../../canopy-runtime/desktop-runtime-access', () => ({
  getDesktopCanopyRuntime: (): object => ({
    query: () => Promise.reject(new Error('unused')),
    instruction: (
      _name: string,
      params: { commandId: string; chatId: string },
    ): Promise<object> => {
      mockSetupOrder.push(`send:${params.chatId}`);
      return Promise.resolve({
        commandId: params.commandId,
        revision: 2,
        outcome: 'applied',
      });
    },
  }),
}));

jest.mock('../../app-advisor/watchers', () => ({
  getAppAdvisorWatcherService: (): object => ({
    findWatcherCreatedBy: (): Promise<null> => Promise.resolve(null),
    fireIfTurnSettled: (): Promise<boolean> => Promise.resolve(false),
    setup: (input: {
      watchers: { target: { kind: string; chatId?: string } }[];
    }): Promise<object> => {
      const [entry] = input.watchers;
      mockSetupOrder.push(`arm:${entry?.target.chatId ?? ''}`);
      if (
        entry?.target.kind === 'standalone_chat' &&
        !mockChats.has(entry.target.chatId ?? '')
      ) {
        return Promise.resolve({
          ok: false,
          error: 'Watcher target chat is unavailable.',
          rejectedIndex: 0,
        });
      }
      return Promise.resolve({
        ok: true,
        results: [{ status: 'created', watcher: { id: 'watcher-1' } }],
      });
    },
  }),
}));

import {
  createInMemoryAgentActionLimits,
  createInMemoryAgentActionReceipts,
  type AgentActionSplitPort,
} from '@canopy/agent-actions';
import type { ChatSendMessageRequest } from '@canopy/desktop-shared/types';
import type { CanopyInjectedToolRuntime } from '../../canopy-tools/core';
import {
  createDesktopEnvironmentPort,
  desktopEnvironmentPortDeps,
} from '../desktop-environment-port';
import { createDesktopAgentLineage } from '../desktop-limits-port';
import { createDesktopAgentActionSurface } from '../desktop-surface';
import { desktopChatWatcherPort } from '../desktop-watcher-port';
import { seedEmptyApprovalRuleSources } from '../../__tests__/helpers/approval-rule-sources';

const runtime: CanopyInjectedToolRuntime = {
  requestUserAnswers: () => Promise.resolve([]),
  loadScriptOutput: () => Promise.resolve({ found: false, lines: [] }),
  worktreeActionRuntime: {
    projectId: 'cw-1',
    worktreeId: 'entry-1',
    chatId: 'chat-parent',
    cwd: '/cowork',
    executionScope: 'directory',
    getWindow: () => null,
  },
  worktreeWatcherRuntime: {
    projectId: 'cw-1',
    worktreeId: 'entry-1',
    chatId: 'chat-parent',
  },
};

const unusedSplit: AgentActionSplitPort<CanopyInjectedToolRuntime> = {
  start: () => Promise.resolve({ text: 'unused', isError: true }),
};

function surface(): ReturnType<typeof createDesktopAgentActionSurface> {
  const recordChat = (request: ChatSendMessageRequest): Promise<void> => {
    if (request.chatId) mockChats.add(request.chatId);
    return Promise.resolve();
  };
  const environment = createDesktopEnvironmentPort(
    desktopEnvironmentPortDeps({
      messageCommitted: () => Promise.resolve(false),
      reserveChat: (request) => {
        mockSetupOrder.push(`reserve:${request.chatId ?? ''}`);
        return recordChat(request);
      },
      listModels: () => Promise.resolve({ models: [], defaultModelId: null }),
      agentSenderFields: () => Promise.resolve(undefined),
      lineage: createDesktopAgentLineage(),
    }),
  );
  return createDesktopAgentActionSurface(runtime, {
    ports: {
      environment,
      transcriptRead: createDesktopTranscriptReadPort(),
      limits: createInMemoryAgentActionLimits(),
      chatWatchers: desktopChatWatcherPort,
      split: unusedSplit,
      receipts: createInMemoryAgentActionReceipts(),
    },
  });
}

beforeAll(async () => {
  await seedEmptyApprovalRuleSources(['cw-1', 'ws-1']);
});

describe('chat.create in a Cowork workspace', () => {
  beforeEach(() => {
    mockChats.clear();
    mockSetupOrder.length = 0;
  });

  it('arms its inline watchers on the new chat before the first message', async () => {
    const result = await surface().execute(
      'dispatch_action',
      {
        action: {
          type: 'chat.create',
          message: 'Review the notes.',
          watchers: [{ label: 'Review finished' }],
        },
      },
      {
        host: runtime,
        scope: {
          workspaceId: 'cw-1',
          worktreeId: 'entry-1',
          chatId: 'chat-parent',
        },
        actorKey: 'local-desktop-user',
        turnKey: 'chat-parent:u1',
        toolUseId: 'tool-1',
      },
    );
    const json: unknown = JSON.parse(result.text);
    expect(json).toMatchObject({
      ok: true,
      result: {
        worktreeId: 'entry-1',
        watchers: [{ ok: true, watcherId: 'watcher-1' }],
      },
    });
    const chatId =
      typeof json === 'object' &&
      json !== null &&
      'result' in json &&
      typeof json.result === 'object' &&
      json.result !== null &&
      'chatId' in json.result
        ? json.result.chatId
        : undefined;
    expect(mockSetupOrder).toEqual([
      `reserve:${String(chatId)}`,
      `arm:${String(chatId)}`,
      `send:${String(chatId)}`,
    ]);
  });
});
