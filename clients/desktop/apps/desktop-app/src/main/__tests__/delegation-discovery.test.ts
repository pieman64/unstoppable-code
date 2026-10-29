const mockBoundary = jest.fn(() => Promise.resolve(true));
const mockAuth = jest.fn(() => Promise.resolve(true));
const mockPeekAuth = jest.fn(() => ({ ollama: true, codex: true }));
const mockAccountIdentity = jest.fn<{ providerAccountKey: string } | null, []>(
  () => ({ providerAccountKey: 'codex:me@example.test' }),
);
const mockBlocked = jest.fn<Promise<boolean>, [string]>(() =>
  Promise.resolve(false),
);
const mockRouting = jest.fn<Promise<{ reason: string } | null>, []>(() =>
  Promise.resolve(null),
);
const mockEnvironment: Record<string, string> = {};
let mockAgentPluginSelections: { mcpServerRefs?: string[] } | undefined;
const mockMaterializeAgentPlugins = jest.fn(() =>
  Promise.resolve({ files: {}, toolNames: ['read', 'search'] }),
);
const mockResolveAgentModelRuntime = jest.fn(({ model }: { model: string }) => {
  if (model === 'disabled')
    return Promise.reject(new Error('Disabled model is not selectable'));
  return Promise.resolve({
    selectedModel: model,
    runtimeModel: model === 'agent' ? 'native' : model,
    executionHarness: 'codex',
    providerType: 'codex',
    pluginSelections: model === 'agent' ? mockAgentPluginSelections : undefined,
  });
});
const models = [
  {
    id: 'native',
    label: 'Native',
    modelSource: 'codex-managed',
    defaultHarness: 'codex',
    enabled: true,
    selectable: true,
    supportedThinkingLevels: ['low', 'high', 'ultra'],
  },
  {
    id: 'credit',
    label: 'Credit route',
    modelSource: 'ai-gateway',
    defaultHarness: 'codex',
    enabled: true,
    selectable: true,
    supportedThinkingLevels: ['low'],
  },
];
jest.mock('../lib/model-config', () => ({
  listAuthoritativeConfiguredModels: (): typeof models => models,
  getAuthoritativeConfiguredModel: (
    id: string,
  ): (typeof models)[number] | undefined =>
    models.find((model) => model.id === id),
}));
jest.mock('../agents/agent-model-store', () => ({
  listAgentModels: (): Promise<{ id: string; name: string }[]> =>
    Promise.resolve([{ id: 'agent', name: 'Reviewer' }]),
}));
jest.mock('../agents/agent-model-runtime', () => ({
  resolveAgentModelRuntime: mockResolveAgentModelRuntime,
}));
jest.mock('../agents/delegation/file-process', () => ({
  delegationFileBoundaryAvailable: mockBoundary,
  openDelegationFiles: jest.fn(),
}));
jest.mock('../agents/delegation/agent-projection', () => ({
  materializeDelegationAgentPlugins: mockMaterializeAgentPlugins,
}));
jest.mock('../lib/model-policy-state', () => ({
  isModelBlockedByStoredPolicy: mockBlocked,
}));
jest.mock('../lib/user-environment-runtime', () => ({
  resolveCodexRuntimeEnvironmentProfile: (): {
    environment: Record<string, string>;
  } => ({
    environment: mockEnvironment,
  }),
}));
jest.mock('../auth/provider-auth-state', () => ({
  isProviderNativelyAuthenticatedForRouting: mockAuth,
  peekFreshProviderNativeAuthAvailability: mockPeekAuth,
  peekProviderAccountIdentity: mockAccountIdentity,
}));
jest.mock('../agents/ai-credits-routing', () => ({
  resolveAiCreditsRoutingAttempt: mockRouting,
}));
jest.mock('@canopy/desktop-shared/node/e2e-mock-env', () => ({
  resolveAnthropicMockEnvOverride: (): undefined => undefined,
}));
import { discoverManagedDelegationModels } from '../agents/delegation/discovery';
import { DelegationAgentCapabilityError } from '../agents/delegation/agent-capability-error';
import {
  clearDelegationModelRejections,
  DELEGATION_MODEL_REJECTION_TTL_MS,
  recordDelegationModelRejection,
} from '../agents/delegation/model-rejections';
const owner = {
  projectId: 'p',
  worktreeId: 'w',
  chatId: 'c',
  cwd: '/w',
  selectedModel: 'agent',
};
beforeEach(() => {
  jest.clearAllMocks();
  models.splice(2);
  mockAuth.mockResolvedValue(true);
  mockPeekAuth.mockReturnValue({ ollama: true, codex: true });
  mockAccountIdentity.mockReturnValue({
    providerAccountKey: 'codex:me@example.test',
  });
  clearDelegationModelRejections();
  mockBoundary.mockResolvedValue(true);
  mockBlocked.mockResolvedValue(false);
  mockRouting.mockResolvedValue(null);
  mockAgentPluginSelections = undefined;
  mockMaterializeAgentPlugins.mockResolvedValue({
    files: {},
    toolNames: ['read', 'search'],
  });
  for (const key of Object.keys(mockEnvironment)) delete mockEnvironment[key];
});
it('surfaces disabled authoritative models with their configured metadata', async () => {
  models.push({
    id: 'disabled',
    label: 'Disabled route',
    modelSource: 'claude-managed',
    defaultHarness: 'claude',
    enabled: false,
    selectable: false,
    supportedThinkingLevels: ['low', 'ultra'],
  });

  const result = await discoverManagedDelegationModels(owner);

  expect(result.models.find((model) => model.modelId === 'disabled')).toEqual({
    modelId: 'disabled',
    label: 'Disabled route',
    harnessId: 'claude',
    runtimeKind: 'claude-sdk',
    capabilities: [
      'read',
      'search',
      'write',
      'resume',
      'follow_up',
      'worktree',
      'progress',
      'usage',
      'cancel',
      'foreground',
      'background',
    ],
    supportedThinkingLevels: ['low'],
    availability: 'unavailable',
    authState: 'unknown',
    disabledReason: 'This model is disabled.',
  });
  expect(mockResolveAgentModelRuntime).not.toHaveBeenCalledWith({
    model: 'disabled',
  });
});
it('discovers Agent base-route capabilities, recommends an available model and leaves billing checks explicit', async () => {
  const result = await discoverManagedDelegationModels(owner);
  // An Agent that inherits the default resolves it for the parent's workspace.
  expect(mockResolveAgentModelRuntime).toHaveBeenCalledWith({
    model: 'agent',
    inheritDefaultFrom: { projectId: owner.projectId },
  });
  expect(result.recommendedModelId).toBe('agent');
  expect(result.models[2]).toMatchObject({
    modelId: 'agent',
    supportedThinkingLevels: ['low', 'high'],
    availability: 'available',
    authState: 'ready',
  });
  expect(result.models[1]).toMatchObject({
    availability: 'unknown',
    authState: 'unknown',
  });
  expect(result.models[1]?.disabledReason).toContain('validated at launch');
  expect(mockAuth).not.toHaveBeenCalled();
});
it('does not advertise or recommend an Agent rejected by launch-time plugin validation', async () => {
  mockAgentPluginSelections = { mcpServerRefs: ['configured-server'] };
  mockMaterializeAgentPlugins.mockRejectedValue(
    new Error(
      'The Agent selection requires unavailable delegated capabilities',
    ),
  );

  const result = await discoverManagedDelegationModels(owner);

  expect(mockMaterializeAgentPlugins).toHaveBeenCalledWith(
    mockAgentPluginSelections,
    expect.any(Function),
    'codex',
  );
  expect(result.recommendedModelId).not.toBe('agent');
  expect(result.models[2]).toMatchObject({
    modelId: 'agent',
    availability: 'unavailable',
    authState: 'unknown',
  });
});
it('refreshes auth and policy on each discovery and never recommends unavailable routes', async () => {
  await discoverManagedDelegationModels(owner);
  mockPeekAuth.mockReturnValue({ ollama: true, codex: false });
  mockBlocked.mockImplementation((id) => Promise.resolve(id === 'credit'));
  const result = await discoverManagedDelegationModels(owner);
  expect(result.recommendedModelId).toBeUndefined();
  expect(result.models[0]).toMatchObject({
    availability: 'unavailable',
    authState: 'required',
  });
  expect(result.models[1].disabledReason).toContain('organization policy');
});
it('reports safe actionable capability failures without exposing resolver diagnostics', async () => {
  mockAgentPluginSelections = { mcpServerRefs: ['configured-server'] };
  const error = new DelegationAgentCapabilityError('missing_selection');
  Object.defineProperty(error, 'cause', { value: new Error('PRIVATE_TOKEN') });
  mockMaterializeAgentPlugins.mockRejectedValue(error);
  const result = await discoverManagedDelegationModels(owner);
  expect(result.models[2]).toMatchObject({
    availability: 'unavailable',
    disabledReason: error.publicMessage,
  });
  expect(JSON.stringify(result)).not.toContain('PRIVATE_TOKEN');
});
it('keeps cold-cache provider authentication unknown without probing', async () => {
  mockPeekAuth.mockReturnValue({ ollama: true });

  const result = await discoverManagedDelegationModels(owner);

  expect(mockAuth).not.toHaveBeenCalled();
  expect(result.models[0]).toMatchObject({
    availability: 'unknown',
    authState: 'unknown',
  });
  expect(result.models[0].disabledReason).toContain('validated at launch');
});
it('does not advertise an unvalidated boundary or environment-only Codex route', async () => {
  mockBoundary.mockResolvedValue(false);
  expect(
    (await discoverManagedDelegationModels(owner)).models.every(
      (model) => model.availability === 'unavailable',
    ),
  ).toBe(true);
  mockBoundary.mockResolvedValue(true);
  mockEnvironment.OPENAI_API_KEY = 'private credential';
  const result = await discoverManagedDelegationModels(owner);
  expect(result.models[0].disabledReason).toContain('environment-only');
  expect(JSON.stringify(result)).not.toContain('private credential');
});

describe('on Windows', () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  beforeEach(() => {
    if (!descriptor) throw new Error('Expected the platform property');
    Object.defineProperty(process, 'platform', {
      ...descriptor,
      value: 'win32',
    });
  });
  afterEach(() => {
    if (descriptor) Object.defineProperty(process, 'platform', descriptor);
  });

  it('offers Codex routes without a Windows sandbox', async () => {
    const codex = (await discoverManagedDelegationModels(owner)).models[0];
    expect(codex.availability).toBe('available');
    expect(codex.disabledReason).toBeUndefined();
  });
});

it('stops advertising a model the provider refused for the signed-in account', async () => {
  recordDelegationModelRejection({
    accountKey: 'codex:me@example.test',
    modelId: 'native',
  });
  const result = await discoverManagedDelegationModels(owner);
  const expected = {
    availability: 'unavailable',
    authState: 'ready',
    disabledReason: 'This model is not available for the signed-in account.',
  };
  expect(result.models[0]).toMatchObject({ modelId: 'native', ...expected });
  // An Agent on the refused runtime model is refused too.
  expect(result.models[2]).toMatchObject({ modelId: 'agent', ...expected });
  expect(result.recommendedModelId).toBeUndefined();

  // Another account keeps the model.
  mockAccountIdentity.mockReturnValue({
    providerAccountKey: 'codex:other@example.test',
  });
  expect(
    (await discoverManagedDelegationModels(owner)).models[0],
  ).toMatchObject({ availability: 'available' });
});

it('forgets a refused model after the rejection expires', async () => {
  recordDelegationModelRejection(
    { accountKey: 'codex:me@example.test', modelId: 'native' },
    Date.now() - DELEGATION_MODEL_REJECTION_TTL_MS - 1,
  );
  expect(
    (await discoverManagedDelegationModels(owner)).models[0],
  ).toMatchObject({ availability: 'available' });
});
