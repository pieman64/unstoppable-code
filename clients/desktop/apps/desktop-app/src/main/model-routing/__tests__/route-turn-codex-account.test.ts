const mockResolveDesktopAutoModel = jest.fn<
  Promise<unknown>,
  [{ candidates: { modelId: string }[] }, unknown]
>();
const mockReadCodexAccountModelIds = jest.fn();

jest.mock('../../auth/provider-auth-state', () => ({
  isProviderNativelyAuthenticatedForRouting: (): Promise<boolean> =>
    Promise.resolve(true),
}));
jest.mock('../../lib/model-policy-state', () => ({
  isModelBlockedByStoredPolicy: (): Promise<boolean> => Promise.resolve(false),
}));
jest.mock('../client', () => ({
  resolveDesktopAutoModel: mockResolveDesktopAutoModel,
}));
jest.mock('../codex-account-models', () => ({
  readCodexAccountModelIds: mockReadCodexAccountModelIds,
}));
jest.mock('@canopy/desktop-shared/lib/gateway-model-availability', () => ({
  isGatewayRoutableModel: (): boolean => true,
  resolveGatewayModelEntry: (): undefined => undefined,
}));
jest.mock('@canopy/desktop-shared/types', () => ({
  AI_GATEWAY_MODELS: [],
  CLAUDE_MODELS: [],
  CODEX_MODELS: ['gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-6-luna'],
  getEffectiveSupportedThinkingLevelsForModel: (): string[] => ['high'],
  getExecutionHarnessForModel: (): string => 'codex',
  getModelDescription: (id: string): string => `${id} description`,
  getModelDisplayName: (id: string): string => id,
  getModelSource: (): string => 'codex-managed',
}));

import { routeDesktopAutoTurn } from '../route-turn';

async function candidateIdsForTurn(): Promise<string[]> {
  mockResolveDesktopAutoModel.mockResolvedValueOnce({
    durableLoss: false,
    response: {
      schemaVersion: 1,
      requestId: 'message-1',
      outcome: 'selected',
      modelId: 'gpt-5.6-luna',
      routingCostUsd: 0,
      routingCredits: 0,
    },
  });
  await routeDesktopAutoTurn({
    request: {
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
      userMessageId: 'message-1',
      text: 'Do the work',
      model: 'gpt-5.6-luna',
    },
    tab: {
      id: 'chat-1',
      title: 'Chat',
      createdAt: '2026-09-21T00:00:00.000Z',
      messages: [],
    },
    preferences: {
      defaultChatModelByProvider: {
        claude: { model: 'gpt-5.6-luna' },
        codex: { model: 'gpt-5.6-luna' },
      },
      defaultWorktreeModelByProvider: {
        claude: { model: 'gpt-5.6-luna' },
        codex: { model: 'gpt-5.6-luna' },
      },
    } as never,
    standalone: false,
    workspace: 'single-repo',
  });
  const candidates =
    mockResolveDesktopAutoModel.mock.calls.at(-1)?.[0].candidates ?? [];
  return candidates.map(({ modelId }) => modelId);
}

describe('routeDesktopAutoTurn with a Codex sign-in', () => {
  beforeEach(() => {
    mockResolveDesktopAutoModel.mockReset();
    mockReadCodexAccountModelIds.mockReset();
  });

  it('offers only the Codex models the signed-in account can run', async () => {
    mockReadCodexAccountModelIds.mockResolvedValue(
      new Set(['gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.5']),
    );
    await expect(candidateIdsForTurn()).resolves.toEqual([
      'gpt-5.6-luna',
      'gpt-5.6-terra',
    ]);
  });

  it('keeps every native Codex model when the account list is unknown', async () => {
    mockReadCodexAccountModelIds.mockResolvedValue(null);
    await expect(candidateIdsForTurn()).resolves.toEqual([
      'gpt-5.6-luna',
      'gpt-5.6-terra',
      'gpt-6-luna',
    ]);
  });
});
