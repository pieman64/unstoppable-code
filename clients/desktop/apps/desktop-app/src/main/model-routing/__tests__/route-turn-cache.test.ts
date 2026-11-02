const mockResolveDesktopAutoModel = jest.fn<
  Promise<unknown>,
  [
    {
      currentModelId?: string;
      currentContext?: { tokens: number; idleMs: number };
    },
    unknown,
  ]
>();

jest.mock('../../auth/provider-auth-state', () => ({
  isProviderNativelyAuthenticatedForRouting: (): Promise<boolean> =>
    Promise.resolve(true),
}));
jest.mock('../../lib/model-policy-state', () => ({
  isModelBlockedByStoredPolicy: (): Promise<boolean> => Promise.resolve(false),
}));
jest.mock('../client', () => ({
  get resolveDesktopAutoModel(): typeof mockResolveDesktopAutoModel {
    return mockResolveDesktopAutoModel;
  },
}));
jest.mock('../codex-account-models', () => ({
  readCodexAccountModelIds: (): Promise<null> => Promise.resolve(null),
}));
jest.mock('@canopy/desktop-shared/lib/gateway-model-availability', () => ({
  isGatewayRoutableModel: (): boolean => true,
  resolveGatewayModelEntry: (): undefined => undefined,
}));
jest.mock('@canopy/desktop-shared/types', () => ({
  AI_GATEWAY_MODELS: [],
  CLAUDE_MODELS: ['opus[1m]', 'sonnet'],
  CODEX_MODELS: [],
  getEffectiveSupportedThinkingLevelsForModel: (): string[] => ['high'],
  getExecutionHarnessForModel: (): string => 'claude',
  getModelDescription: (id: string): string => `${id} description`,
  getModelDisplayName: (id: string): string => id,
  getModelSource: (): string => 'claude-managed',
}));

import { routeDesktopAutoTurn } from '../route-turn';

const NOW = Date.parse('2026-09-21T12:00:00.000Z');

async function routeFollowUp(selectedModelId: string): Promise<{
  request: Parameters<typeof mockResolveDesktopAutoModel>[0];
  cacheMissContextTokens: number | undefined;
}> {
  mockResolveDesktopAutoModel.mockResolvedValueOnce({
    durableLoss: false,
    response: {
      schemaVersion: 1,
      requestId: 'message-2',
      outcome: 'selected',
      modelId: selectedModelId,
      routingCostUsd: 0,
      routingCredits: 0,
    },
  });
  const resolution = await routeDesktopAutoTurn({
    request: {
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
      userMessageId: 'message-2',
      text: 'Now add docs',
      model: 'opus[1m]',
    },
    tab: {
      id: 'chat-1',
      title: 'Chat',
      createdAt: '2026-09-21T00:00:00.000Z',
      model: 'opus[1m]',
      usage: { contextTokens: 80_000 } as never,
      messages: [
        {
          id: 'message-1',
          role: 'user',
          timestamp: NOW - 120_000,
          blocks: [{ type: 'text', text: 'Fix the bug' }],
        },
        {
          id: 'reply-1',
          role: 'assistant',
          timestamp: NOW - 60_000,
          blocks: [{ type: 'text', text: 'Fixed.' }],
        },
        {
          id: 'message-2',
          role: 'user',
          timestamp: NOW,
          blocks: [{ type: 'text', text: 'Now add docs' }],
        },
      ],
    },
    preferences: {
      defaultChatModelByProvider: {
        claude: { model: 'opus[1m]' },
        codex: { model: 'opus[1m]' },
      },
      defaultWorktreeModelByProvider: {
        claude: { model: 'opus[1m]' },
        codex: { model: 'opus[1m]' },
      },
    } as never,
    standalone: false,
    workspace: 'single-repo',
  });
  const request = mockResolveDesktopAutoModel.mock.calls.at(-1)?.[0];
  if (!request) throw new Error('Expected a routing request');
  return {
    request,
    cacheMissContextTokens: resolution?.attribution.cacheMissContextTokens,
  };
}

describe('routeDesktopAutoTurn prompt-cache context', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: NOW });
    mockResolveDesktopAutoModel.mockReset();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('reports the current model and its warm context size', async () => {
    const { request } = await routeFollowUp('opus[1m]');
    expect(request.currentModelId).toBe('opus[1m]');
    expect(request.currentContext).toEqual({ tokens: 80_000, idleMs: 60_000 });
  });

  it('records the context a switch had to re-read uncached', async () => {
    await expect(routeFollowUp('sonnet')).resolves.toMatchObject({
      cacheMissContextTokens: 80_000,
    });
  });

  it('records no cache miss when Auto keeps the current model', async () => {
    await expect(routeFollowUp('opus[1m]')).resolves.toMatchObject({
      cacheMissContextTokens: undefined,
    });
  });
});
