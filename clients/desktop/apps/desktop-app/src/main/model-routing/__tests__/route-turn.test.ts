const mockResolveDesktopAutoModel = jest.fn();

jest.mock('../../auth/provider-auth-state', () => ({
  isProviderNativelyAuthenticatedForRouting: (): Promise<boolean> =>
    Promise.resolve(true),
}));
jest.mock('../../lib/model-policy-state', () => ({
  isModelBlockedByStoredPolicy: (): Promise<boolean> => Promise.resolve(false),
}));
jest.mock('../codex-account-models', () => ({
  readCodexAccountModelIds: (): Promise<null> => Promise.resolve(null),
}));
jest.mock('../client', () => ({
  get resolveDesktopAutoModel(): typeof mockResolveDesktopAutoModel {
    return mockResolveDesktopAutoModel;
  },
}));
jest.mock('@canopy/desktop-shared/lib/gateway-model-availability', () => ({
  isGatewayRoutableModel: (): boolean => true,
  resolveGatewayModelEntry: (): { gatewayId: string } => ({
    gatewayId: 'anthropic/only-model',
  }),
}));
jest.mock('@canopy/desktop-shared/types', () => {
  return {
    AI_GATEWAY_MODELS: [],
    CLAUDE_MODELS: ['only-model'],
    CODEX_MODELS: [],
    getEffectiveSupportedThinkingLevelsForModel: (): string[] => ['high'],
    getExecutionHarnessForModel: (): string => 'claude',
    getModelDescription: (): string => 'Only eligible model',
    getModelDisplayName: (): string => 'Only model',
    getModelSource: (): string => 'claude-managed',
  };
});

import { routeDesktopAutoTurn } from '../route-turn';
import { finalizeModelRoutingSavings } from '@canopy/protocol/model-routing';

describe('routeDesktopAutoTurn', () => {
  it.each([false, true])(
    'keeps the selected harness when only one candidate remains (OpenCode: %s)',
    async (opencode) => {
      mockResolveDesktopAutoModel.mockClear();
      mockResolveDesktopAutoModel.mockResolvedValueOnce({
        durableLoss: false,
        response: {
          schemaVersion: 1,
          requestId: 'message-1',
          outcome: 'fallback',
          modelId: 'anthropic/only-model',
          fallbackReason: 'no_eligible_models',
          routingCostUsd: 0,
          routingCredits: 0,
        },
      });
      const resolution = await routeDesktopAutoTurn({
        request: {
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          chatId: 'chat-1',
          userMessageId: 'message-1',
          text: 'Do the work',
          model: 'only-model',
        },
        tab: {
          id: 'chat-1',
          ...(opencode ? { executionHarness: 'opencode' as const } : {}),
          title: 'Chat',
          createdAt: '2026-09-21T00:00:00.000Z',
          messages: [],
        },
        preferences: {
          defaultChatModelByProvider: {
            claude: { model: 'only-model' },
            codex: { model: 'only-model' },
          },
          defaultWorktreeModelByProvider: {
            claude: { model: 'only-model' },
            codex: { model: 'only-model' },
          },
        } as never,
        standalone: true,
        workspace: 'cowork',
      });

      if (opencode) {
        expect(mockResolveDesktopAutoModel).not.toHaveBeenCalled();
        expect(resolution).toBeNull();
        return;
      }

      expect(mockResolveDesktopAutoModel).toHaveBeenCalledWith(
        expect.objectContaining({
          requestId: 'message-1',
          fallbackModelId: 'anthropic/only-model',
          candidates: [
            expect.objectContaining({ modelId: 'anthropic/only-model' }),
          ],
        }),
        {},
      );
      expect(resolution).not.toBeNull();
      if (resolution === null) throw new Error('Expected routing resolution');
      expect(resolution).toMatchObject({
        modelId: 'only-model',
        harness: 'claude',
        durableLoss: false,
        attribution: {
          selectionMode: 'auto',
          outcome: 'fallback',
          selectedModelId: 'only-model',
          routingCostUsd: 0,
          routingCredits: 0,
        },
      });
      expect(
        finalizeModelRoutingSavings({
          attribution: resolution.attribution,
          usageComplete: true,
          selectedExecutionCostUsd: 0.01,
          selectedCostBasis: 'api_equivalent',
          benchmark: {
            status: 'priced',
            costUsd: 0.02,
            pricingRevision: 'test',
          },
        }).savings,
      ).toMatchObject({ status: 'computed', netEstimatedSavingsUsd: 0.01 });
    },
  );
  it('sends the session work owner and signal with the resolve call (CAN-3462)', async () => {
    mockResolveDesktopAutoModel.mockResolvedValueOnce({
      durableLoss: false,
      response: {
        schemaVersion: 1,
        requestId: 'message-2',
        outcome: 'selected',
        modelId: 'anthropic/only-model',
      },
    });
    const owner = {
      kind: 'organization' as const,
      organizationId: '123e4567-e89b-12d3-a456-426614174000',
    };
    const controller = new AbortController();

    await routeDesktopAutoTurn({
      request: {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        userMessageId: 'message-2',
        text: 'Do the work',
        model: 'only-model',
      },
      tab: {
        id: 'chat-1',
        title: 'Chat',
        createdAt: '2026-09-21T00:00:00.000Z',
        messages: [],
      },
      preferences: {
        defaultChatModelByProvider: {
          claude: { model: 'only-model' },
          codex: { model: 'only-model' },
        },
        defaultWorktreeModelByProvider: {
          claude: { model: 'only-model' },
          codex: { model: 'only-model' },
        },
      } as never,
      standalone: true,
      workspace: 'cowork',
      signal: controller.signal,
      workOwner: owner,
    });

    expect(mockResolveDesktopAutoModel).toHaveBeenLastCalledWith(
      expect.objectContaining({ requestId: 'message-2' }),
      { signal: controller.signal, workOwner: owner },
    );
  });
});
