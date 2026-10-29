import type { PersistedChatMessage } from '@canopy/desktop-shared/types';
import { delegationTranscriptMessages } from '@canopy/agent-transcript';

jest.mock('../portal/portal-event-bus', () => ({
  createPortalEvent: jest.fn(),
  enqueuePortalEvent: jest.fn(),
  isCanopyPortalActive: jest.fn(() => true),
}));

jest.mock('../services/portal-chat-tabs-cache', () => ({
  portalChatTabsCache: { read: jest.fn() },
}));

const readDelegationItems = jest.fn();
jest.mock('../services/chat-state-service', () => ({
  getChatStateService: (): {
    readDelegationItems: typeof readDelegationItems;
  } => ({
    readDelegationItems,
  }),
}));

import { getWorktreeChatTranscriptSeed } from '../services/chat-service';
import { portalChatTabsCache } from '../services/portal-chat-tabs-cache';
import { registerWorkspaceTypes } from '../lib/workspace-registry';

const mockedPortalChatTabsCache = jest.mocked(portalChatTabsCache);

function loggedCard(): PersistedChatMessage {
  const [card] = delegationTranscriptMessages({
    delegationId: 'child',
    runGeneration: 1,
    sequence: 2,
    parentHarnessId: 'claude',
    parentTurnId: 'prompt',
    parentToolCallId: 'spawn',
    createdAt: 2,
    transcriptStore: 'chat-log-v1',
    task: {
      description: 'Review',
      prompt: 'Review it',
      executionMode: 'background',
    },
    snapshot: {
      delegationId: 'child',
      status: 'completed',
      outputTruncated: false,
      finalText: 'Done',
      routeSnapshot: {
        selectedModelId: 'model',
        runtimeModelId: 'model',
        harnessId: 'claude',
      },
    },
    transcript: [],
  });
  if (!card) throw new Error('Missing card');
  return card;
}

describe('Portal transcript seed for logged delegate cards', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    registerWorkspaceTypes(new Map());
    const tabs = {
      version: 1,
      activeTabId: 'chat',
      tabs: [
        {
          id: 'chat',
          title: 'Chat',
          createdAt: '2026-10-06T00:00:00.000Z',
          messages: [
            {
              id: 'prompt',
              role: 'user' as const,
              timestamp: 1,
              blocks: [{ type: 'text' as const, text: 'Delegate' }],
            },
            loggedCard(),
          ],
        },
      ],
    };
    mockedPortalChatTabsCache.read.mockResolvedValue(tabs);
  });

  it('projects a logged card with the children from its delegate log', async () => {
    readDelegationItems.mockResolvedValue([
      {
        id: 'finding',
        type: 'text',
        text: 'Finding from the delegate log',
        sequence: 1,
        occurredAt: 3,
      },
    ]);
    const seed = await getWorktreeChatTranscriptSeed({
      workspaceId: 'workspace',
      worktreeId: 'tree',
      chatId: 'chat',
    });
    expect(readDelegationItems).toHaveBeenCalledWith({
      projectId: 'workspace',
      worktreeId: 'tree',
      chatId: 'chat',
      delegationId: 'child',
      runGeneration: 1,
    });
    expect(JSON.stringify(seed.messages)).toContain(
      'Finding from the delegate log',
    );
  });

  it('still projects the card when its log cannot be read', async () => {
    readDelegationItems.mockRejectedValue(new Error('unreadable'));
    const seed = await getWorktreeChatTranscriptSeed({
      workspaceId: 'workspace',
      worktreeId: 'tree',
      chatId: 'chat',
    });
    expect(JSON.stringify(seed.messages)).toContain('Done');
  });
});
