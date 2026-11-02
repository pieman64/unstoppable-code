import { openOpenCodeExecutionRuntime } from '../opencode/execution-runtime';
import { openOpenCodeInferenceLease } from '../opencode/inference-host';
import {
  openManagedOpenCodeRuntime,
  assertOpenCodeModelAvailable,
  assertOpenCodeRuntimeModelAvailable,
} from '../opencode/connection';
import { resolveGatewayModelEntry } from '@canopy/desktop-shared/lib/gateway-model-availability';

jest.mock('../opencode/inference-host', () => ({
  openOpenCodeInferenceLease: jest.fn(),
}));
jest.mock('../opencode/connection', () => ({
  openManagedOpenCodeRuntime: jest.fn(),
  assertOpenCodeModelAvailable: jest.fn(),
  assertOpenCodeRuntimeModelAvailable: jest.fn(),
}));
jest.mock('@canopy/desktop-shared/lib/gateway-model-availability', () => ({
  resolveGatewayModelEntry: jest.fn(),
  resolveOwnerScopedModelId: (model: string): string => model,
}));
const model = {
  id: 'opencode:vendor%2Fmodel',
  rawModelId: 'vendor/model',
  label: 'Native',
  supportedThinkingLevels: [],
  supportsVision: false,
};
const close = jest.fn(() => Promise.resolve());
const dispose = jest.fn();
const attribution = jest.fn(() =>
  Promise.resolve({ workOwner: { kind: 'personal' as const } }),
);
let leaseAbort: AbortController;
const options = (): Parameters<typeof openOpenCodeExecutionRuntime>[0] => ({
  model: 'gateway-model',
  cwd: '/workspace',
  workspaceId: 'workspace',
  sessionId: 'session',
  signal: new AbortController().signal,
  attribution,
});
beforeEach(() => {
  jest.clearAllMocks();
  leaseAbort = new AbortController();
  jest.mocked(resolveGatewayModelEntry).mockReturnValue({
    modelId: 'gateway-model',
    gatewayId: 'vendor/model',
    recommendedHarness: 'codex',
    family: 'gpt',
    contextWindow: 128000,
    supportedThinkingLevels: [],
    supportsPromptCaching: false,
    gatewayOnly: true,
    toolSchemaProfile: 'standard',
  });
  jest.mocked(openOpenCodeInferenceLease).mockResolvedValue({
    route: {
      bindingKey: 'a'.repeat(64),
      protocol: 'openai-responses',
      baseUrl: `http://127.0.0.1:43123/codex-gateway/${'b'.repeat(48)}`,
      model: {
        id: 'vendor/model',
        contextWindow: 128000,
        outputLimit: 16384,
        supportsVision: false,
      },
    },
    funding: 'ai-credits',
    signal: leaseAbort.signal,
    dispose,
    failureError: () => new Error('terminal managed failure'),
  });
  jest.mocked(assertOpenCodeModelAvailable).mockResolvedValue(model);
  jest.mocked(assertOpenCodeRuntimeModelAvailable).mockResolvedValue(model);
  jest.mocked(openManagedOpenCodeRuntime).mockImplementation((input) =>
    Promise.resolve({
      executable: '/managed/opencode',
      env: {},
      providerConfig: {},
      signal: input.signal,
      runtimeIdentity: { version: '1.18.34', platform: 'darwin-arm64' },
      generation: 1,
      close,
    }),
  );
});
it('opens native execution without reading app authority or billing', async () => {
  const runtime = await openOpenCodeExecutionRuntime({
    ...options(),
    model: model.id,
  });
  expect(attribution).not.toHaveBeenCalled();
  expect(openOpenCodeInferenceLease).not.toHaveBeenCalled();
  expect(runtime.rawModelId).toBe('vendor/model');
  expect(runtime.accountScope).toBe('native');
  expect(runtime.failureError).toBeUndefined();
  await runtime.close();
  await runtime.close();
  expect(close).toHaveBeenCalledTimes(1);
  expect(dispose).not.toHaveBeenCalled();
});
it('uses scoped native discovery for pipeline environment models', async () => {
  const runtime = await openOpenCodeExecutionRuntime({
    ...options(),
    model: model.id,
    scopedModelDiscovery: true,
  });
  expect(assertOpenCodeRuntimeModelAvailable).toHaveBeenCalledWith(
    model.id,
    expect.any(Object),
    '/workspace',
  );
  expect(assertOpenCodeModelAvailable).not.toHaveBeenCalled();
  await runtime.close();
});
it('opens a managed runtime with isolated config and retains its failure adapter after close', async () => {
  const runtime = await openOpenCodeExecutionRuntime(options());
  expect(openManagedOpenCodeRuntime).toHaveBeenCalledWith(
    expect.objectContaining({ providerConfiguration: 'host-inference' }),
  );
  expect(assertOpenCodeModelAvailable).not.toHaveBeenCalled();
  expect(runtime.rawModelId).toBe('canopy-inference/vendor/model');
  expect(runtime.accountScope).toBe('ai_credits');
  expect(runtime.supportedThinkingLevels).toEqual([]);
  expect(openOpenCodeInferenceLease).toHaveBeenCalledWith(
    expect.objectContaining({
      outputLimit: 16384,
      attribution: { workOwner: { kind: 'personal' } },
    }),
  );
  await runtime.close();
  await runtime.close();
  expect(close).toHaveBeenCalledTimes(1);
  expect(dispose).toHaveBeenCalledTimes(1);
  expect(runtime.failureError?.().message).toBe('terminal managed failure');
});
it('cleans up the lease when executable verification fails', async () => {
  jest
    .mocked(openManagedOpenCodeRuntime)
    .mockRejectedValueOnce(new Error('verification failed'));
  await expect(openOpenCodeExecutionRuntime(options())).rejects.toThrow(
    'verification failed',
  );
  expect(dispose).toHaveBeenCalledTimes(1);
  expect(close).not.toHaveBeenCalled();
});
it('closes a late runtime and the lease if cancellation wins during opening', async () => {
  const input = options();
  const abort = new AbortController();
  input.signal = abort.signal;
  const original = jest
    .mocked(openManagedOpenCodeRuntime)
    .getMockImplementation();
  jest.mocked(openManagedOpenCodeRuntime).mockImplementationOnce((request) => {
    abort.abort();
    if (!original) throw new Error('Missing fixture');
    return original(request);
  });
  await expect(openOpenCodeExecutionRuntime(input)).rejects.toThrow();
  expect(dispose).toHaveBeenCalledTimes(1);
  expect(close).toHaveBeenCalledTimes(1);
});
it('captures model and workspace options before awaited attribution', async () => {
  const input = options();
  const pending = openOpenCodeExecutionRuntime(input);
  input.model = 'changed';
  input.workspaceId = 'changed';
  const runtime = await pending;
  expect(openOpenCodeInferenceLease).toHaveBeenCalledWith(
    expect.objectContaining({ model: 'gateway-model' }),
  );
  expect(openManagedOpenCodeRuntime).toHaveBeenCalledWith(
    expect.objectContaining({ workspaceId: 'workspace' }),
  );
  await runtime.close();
});
it('withdraws the runtime signal when account authority is revoked', async () => {
  const runtime = await openOpenCodeExecutionRuntime(options());
  leaseAbort.abort();
  expect(runtime.signal.aborted).toBe(true);
  await runtime.close();
});
it('refuses an unknown route before opening a native process', async () => {
  jest.mocked(resolveGatewayModelEntry).mockReturnValue(undefined);
  await expect(openOpenCodeExecutionRuntime(options())).rejects.toThrow(
    'unavailable',
  );
  expect(openManagedOpenCodeRuntime).not.toHaveBeenCalled();
  expect(openOpenCodeInferenceLease).not.toHaveBeenCalled();
});

it('rejects a delegated route whose funding authority changed before launch', async () => {
  await expect(
    openOpenCodeExecutionRuntime({
      ...options(),
      expectedInferenceBindingKey: 'c'.repeat(64),
    }),
  ).rejects.toThrow('funding account changed');
  expect(dispose).toHaveBeenCalledTimes(1);
  expect(openManagedOpenCodeRuntime).not.toHaveBeenCalled();
});

it('keeps managed cleanup failures terminal after a possibly paid request', async () => {
  const runtime = await openOpenCodeExecutionRuntime(options());
  close.mockRejectedValueOnce(new Error('ECONNRESET'));
  await expect(runtime.close()).rejects.toThrow('terminal managed failure');
  expect(dispose).toHaveBeenCalledTimes(1);
});
