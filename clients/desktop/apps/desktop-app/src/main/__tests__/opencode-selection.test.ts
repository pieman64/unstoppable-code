import { assertOpenCodeSelectionAvailable } from '../opencode/selection';
import type {
  OpenCodeExecutionRuntime,
  openOpenCodeExecutionRuntime,
} from '../opencode/execution-runtime';
import { prepareOpenCodeInferenceRoute } from '@canopy/desktop-shared/node/opencode/inference-route';
import { initAgentModels } from '@canopy/desktop-shared/types';

const mockNative = jest.fn(() =>
  Promise.resolve({ supportedThinkingLevels: ['high' as const] }),
);
jest.mock('../opencode/connection', (): unknown => ({
  assertOpenCodeModelAvailable: () => mockNative(),
}));
const mockAttribution = jest.fn<
  Promise<{ workOwner: { kind: 'personal' } }>,
  [unknown]
>(() => Promise.resolve({ workOwner: { kind: 'personal' as const } }));
jest.mock('../agents/ai-credits-routing', (): unknown => ({
  resolveAiCreditsAttribution: (projectId: string, worktreeId: string) =>
    mockAttribution({ projectId, worktreeId }),
}));
const mockOwner = jest.fn<Promise<{ kind: 'personal' }>, [unknown]>(() =>
  Promise.resolve({ kind: 'personal' }),
);
jest.mock('../agents/work-owner', (): unknown => ({
  resolveAiCreditsScopeOwner: (scope: unknown) => mockOwner(scope),
  resolveBackgroundWorkOwner: (scope: unknown) => mockOwner(scope),
}));
const mockClose = jest.fn(() => Promise.resolve());
const mockRuntime = jest.fn<
  Promise<OpenCodeExecutionRuntime>,
  [Parameters<typeof openOpenCodeExecutionRuntime>[0]]
>();
jest.mock('../opencode/execution-runtime', (): unknown => ({
  openOpenCodeExecutionRuntime: (input: Parameters<typeof mockRuntime>[0]) =>
    mockRuntime(input),
}));
const session = {
  projectId: 'project',
  worktreeId: 'worktree',
  chatId: 'chat',
};
const route = prepareOpenCodeInferenceRoute({
  baseUrl: `http://127.0.0.1:54321/codex-gateway/${'a'.repeat(48)}`,
  protocol: 'openai-responses',
  model: {
    id: 'provider/model',
    contextWindow: 128000,
    outputLimit: 16384,
    supportsVision: false,
  },
  bindingKey: 'b'.repeat(64),
}).route;

beforeEach(() => {
  jest.clearAllMocks();
  initAgentModels([]);
  mockRuntime.mockResolvedValue({
    runtimeIdentity: { version: '1.18.34', platform: 'darwin-arm64' },
    executable: '/verified/opencode',
    env: {},
    providerConfig: {},
    generation: 1,
    signal: new AbortController().signal,
    close: mockClose,
    rawModelId: 'canopy-inference/provider/model',
    supportedThinkingLevels: [],
    accountScope: 'ai_credits',
    inferenceFunding: 'ai-credits',
    inferenceRoute: route,
  });
});
afterEach(() => initAgentModels([]));

it.each(['opencode:fixture%2Fmodel', 'gateway-model'])(
  'admits an Agent through its base model: %s',
  async (baseModel) => {
    initAgentModels([
      {
        id: 'agent_model_review',
        name: 'Review',
        baseModel,
        instructions: '',
        pluginSelections: { collectionIds: [], skillRefs: [], pluginRefs: [] },
        createdAt: '',
        updatedAt: '',
        available: true,
      },
    ]);
    const result = await assertOpenCodeSelectionAvailable({
      model: 'agent_model_review',
      session,
    });
    if (baseModel.startsWith('opencode:')) {
      expect(result.kind).toBe('native');
      expect(mockNative).toHaveBeenCalledTimes(1);
      expect(mockRuntime).not.toHaveBeenCalled();
    } else {
      expect(result.kind).toBe('gateway');
      expect(mockRuntime).toHaveBeenCalledWith(
        expect.objectContaining({ model: baseModel }),
      );
      expect(mockNative).not.toHaveBeenCalled();
    }
  },
);

it('leaves native admission independent of app funding', async () => {
  await expect(
    assertOpenCodeSelectionAvailable({
      model: 'opencode:fixture%2Fmodel',
      session,
    }),
  ).resolves.toEqual({ kind: 'native', supportedThinkingLevels: ['high'] });
  expect(mockRuntime).not.toHaveBeenCalled();
  expect(mockAttribution).not.toHaveBeenCalled();
  expect(mockOwner).not.toHaveBeenCalled();
});
it('returns captured funding and releases the unused preflight lease', async () => {
  await expect(
    assertOpenCodeSelectionAvailable({ model: 'gateway-model', session }),
  ).resolves.toMatchObject({
    kind: 'gateway',
    inferenceBindingKey: 'b'.repeat(64),
    funding: 'ai-credits',
    supportedThinkingLevels: [],
  });
  expect(mockNative).not.toHaveBeenCalled();
  expect(mockClose).toHaveBeenCalledTimes(1);
});
it('refuses missing model and cancelled admission before opening a lease', async () => {
  await expect(
    assertOpenCodeSelectionAvailable({ model: undefined, session }),
  ).rejects.toThrow('Choose');
  await expect(
    assertOpenCodeSelectionAvailable({
      model: 'gateway-model',
      session,
      signal: AbortSignal.abort(),
    }),
  ).rejects.toThrow();
  expect(mockRuntime).not.toHaveBeenCalled();
});
it('closes a runtime withdrawn before admission completes', async () => {
  const current = await mockRuntime({
    model: 'gateway-model',
    sessionId: 'test',
    signal: new AbortController().signal,
    attribution: () => mockAttribution(session),
  });
  mockRuntime.mockResolvedValueOnce({
    ...current,
    signal: AbortSignal.abort(),
  });
  await expect(
    assertOpenCodeSelectionAvailable({ model: 'gateway-model', session }),
  ).rejects.toThrow();
  expect(mockClose).toHaveBeenCalledTimes(1);
});

it('snapshots the target before asynchronous authority lookup', async () => {
  const target = { ...session };
  const pending = assertOpenCodeSelectionAvailable({
    model: 'gateway-model',
    session: target,
  });
  target.projectId = 'another-project';
  await pending;
  const input = mockRuntime.mock.calls[0]?.[0];
  if (!input) throw new Error('Missing admission runtime');
  await input.attribution();
  expect(mockAttribution).toHaveBeenCalledWith({
    projectId: session.projectId,
    worktreeId: session.worktreeId,
  });
  expect(mockOwner).toHaveBeenCalledWith({ kind: 'work', ...session });
  expect(input.workspaceId).toBe(session.projectId);
});
