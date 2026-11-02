import { openOpenCodeInferenceLease } from '../opencode/inference-host';
import { resolveRoutingOverrideAttribution } from '../agents/ai-credits-routing';
jest.mock('../opencode/inference-host', () => ({
  openOpenCodeInferenceLease: jest.fn(),
}));
jest.mock('../agents/ai-credits-routing', () => ({
  resolveRoutingOverrideAttribution: jest.fn(),
}));
jest.mock('@canopy/desktop-shared/lib/gateway-model-availability', () => ({
  resolveOwnerScopedModelId: (model: string): string => model,
  resolveGatewayModelEntry: (
    model: string,
  ):
    | { modelId: string; gatewayId: string; contextWindow: number }
    | undefined =>
    model === 'gateway-model'
      ? {
          modelId: model,
          gatewayId: 'vendor/model',
          contextWindow: 128000,
        }
      : undefined,
}));
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runOpenCodeTurn } from '@canopy/desktop-shared/node/opencode/turn-driver';
import { evaluateApproval } from '@canopy/desktop-shared/lib/approval-engine';
import type { ApprovalRule } from '@canopy/desktop-shared/types';
import type { ApprovalSessionHandle } from '../approvals/approval-service';
import { createApprovalSession } from '../approvals/approval-service';
import { runDesktopOpenCodePipelinePrompt } from '../pipelines/opencode-prompt-runner';
import { prepareOpenCodePipelineCapabilities } from '../pipelines/opencode-pipeline-capabilities';
import {
  assertOpenCodeConnectionGeneration,
  assertOpenCodeModelAvailable,
} from '../opencode/connection';

jest.mock('@canopy/desktop-shared/node/opencode/turn-driver', () => ({
  runOpenCodeTurn: jest.fn(),
}));
const mockClose = jest.fn(() => Promise.resolve());
let mockRuntimeController = new AbortController();
jest.mock('../pipelines/opencode-pipeline-capabilities', () => ({
  prepareOpenCodePipelineCapabilities: jest.fn(),
}));
const mockRuntimeModel = jest.fn(
  (_model: string, runtime: { env: NodeJS.ProcessEnv }, _cwd: string) => {
    void _cwd;
    if (runtime.env.PIPELINE_ONLY_PROVIDER !== 'enabled')
      return Promise.resolve({ supportedThinkingLevels: [] });
    return Promise.resolve({ supportedThinkingLevels: ['high'] });
  },
);
jest.mock('../opencode/connection', () => ({
  openManagedOpenCodeRuntime: jest.fn(
    ({
      signal,
      environment,
    }: {
      signal: AbortSignal;
      environment?: Record<string, string>;
    }) =>
      Promise.resolve({
        executable: process.execPath,
        env: environment ?? {},
        signal: AbortSignal.any([signal, mockRuntimeController.signal]),
        generation: 7,
        close: mockClose,
      }),
  ),
  assertOpenCodeModelAvailable: jest.fn(() =>
    Promise.resolve({ supportedThinkingLevels: [] }),
  ),
  assertOpenCodeRuntimeModelAvailable: (
    ...args: Parameters<typeof mockRuntimeModel>
  ): ReturnType<typeof mockRuntimeModel> => mockRuntimeModel(...args),
  assertOpenCodeConnectionGeneration: jest.fn(),
}));
jest.mock('../approvals/approval-service', () => ({
  createApprovalSession: jest.fn(),
}));
const check = jest.fn<
  ReturnType<ApprovalSessionHandle['check']>,
  Parameters<ApprovalSessionHandle['check']>
>();
const dispose = jest.fn();
const invalidatePending = jest.fn();
const reevaluatePendingApprovals =
  (): ApprovalSessionHandle['reevaluatePendingApprovals'] =>
    jest.fn<
      ReturnType<ApprovalSessionHandle['reevaluatePendingApprovals']>,
      Parameters<ApprovalSessionHandle['reevaluatePendingApprovals']>
    >(() => Promise.resolve());
let cwd: string;
beforeEach(async () => {
  jest.clearAllMocks();
  jest.mocked(prepareOpenCodePipelineCapabilities).mockReset();
  mockRuntimeController = new AbortController();
  cwd = await mkdtemp(join(tmpdir(), 'opencode-pipeline-approval-'));
  jest.mocked(createApprovalSession).mockReturnValue({
    check,
    dispose,
    invalidatePending,
    reevaluatePendingApprovals: reevaluatePendingApprovals(),
    setMode: jest.fn(),
  });
  jest.mocked(runOpenCodeTurn).mockImplementation(async (_request, host) => {
    await host.onSession?.('session', {
      version: 3,
      sessionId: 'session',
      digest: 'a'.repeat(64),
      generation: 1,
    });
    const outcome = await host.authorize({
      sessionId: 'session',
      toolCallId: 'write',
      toolName: 'write',
      toolArgs: { filePath: join(cwd, 'sentinel.txt'), content: 'value' },
    });
    return {
      sessionId: 'session',
      responseText: outcome.decision,
      isError: false,
      cancelled: false,
      message: '',
    };
  });
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});
function run(
  signal?: AbortSignal,
  overrides: Partial<
    Parameters<typeof runDesktopOpenCodePipelinePrompt>[0]
  > = {},
): ReturnType<typeof runDesktopOpenCodePipelinePrompt> {
  return runDesktopOpenCodePipelinePrompt({
    cwd,
    executionsDir: join(cwd, 'executions'),
    projectId: 'project',
    executionId: 'execution',
    jobId: 'job',
    stepId: 'step',
    attempt: 1,
    environment: {},
    model: 'opencode:fixture%2Fmodel',
    prompt: 'Write',
    permissionPreset: 'dangerous_all',
    totalTimeoutMs: 10_000,
    signal,
    ...overrides,
  });
}
test.each(['project', 'global'] as const)(
  'pipeline Full Access honors saved %s file denies',
  async (scope) => {
    check.mockImplementation((input) => {
      const denied = [
        {
          id: 'deny',
          behavior: 'deny',
          target: { kind: 'file-write', path: join(cwd, 'sentinel.txt') },
          origin: 'settings',
          createdAt: '2026-10-09T00:00:00Z',
        },
      ] satisfies ApprovalRule[];
      const evaluation = evaluateApproval(input, {
        mode: 'full-access',
        workspaceRoot: cwd,
        rules: {
          session: [],
          project: scope === 'project' ? denied : [],
          global: scope === 'global' ? denied : [],
        },
      });
      return Promise.resolve({
        decision: evaluation.outcome === 'allow' ? 'allow' : 'deny',
      });
    });
    expect(await run()).toMatchObject({ status: 'success', rawText: 'deny' });
    expect(check).toHaveBeenCalledWith(
      { kind: 'file-write', path: join(cwd, 'sentinel.txt') },
      expect.anything(),
    );
    expect(createApprovalSession).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'project',
        workspaceRoot: cwd,
        mode: 'full-access',
        trackChatTurn: false,
        provider: 'opencode',
      }),
    );
    expect(
      jest.mocked(createApprovalSession).mock.calls[0][0].getWindow(),
    ).toBeNull();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(mockClose).toHaveBeenCalledTimes(1);
  },
);
test('pipeline allows a shared-policy grant and releases its approval session', async () => {
  check.mockResolvedValue({ decision: 'allow' });
  expect(await run()).toMatchObject({ status: 'success', rawText: 'allow' });
  expect(check).toHaveBeenCalledTimes(1);
  expect(dispose).toHaveBeenCalledTimes(1);
});
test('a pending shared-policy grant is withdrawn on cancellation', async () => {
  const controller = new AbortController();
  check.mockImplementation(() => {
    controller.abort();
    return Promise.resolve({ decision: 'allow' });
  });
  expect(await run(controller.signal)).toMatchObject({ status: 'cancelled' });
  expect(invalidatePending).toHaveBeenCalled();
  expect(dispose).toHaveBeenCalledTimes(1);
});

test('runtime revocation interrupts pending capability discovery and releases the runtime', async () => {
  const step = new AbortController();
  let preparationSignal: AbortSignal | undefined;
  let discoveryStopped = false;
  let reportStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    reportStarted = resolve;
  });
  jest.mocked(prepareOpenCodePipelineCapabilities).mockImplementationOnce(
    (_request, _profile, signal) =>
      new Promise((_resolve, reject) => {
        preparationSignal = signal;
        signal.addEventListener(
          'abort',
          () => {
            discoveryStopped = true;
            reject(new Error('Capability discovery revoked'));
          },
          { once: true },
        );
        reportStarted?.();
      }),
  );
  const pending = run(step.signal, {
    pluginSelections: {
      collectionIds: ['selected'],
      pluginRefs: [],
      skillRefs: [],
    },
  });
  try {
    await started;
    mockRuntimeController.abort();
    expect(step.signal.aborted).toBe(false);
    expect(preparationSignal?.aborted).toBe(true);
    expect(discoveryStopped).toBe(true);
    expect(await pending).toMatchObject({ status: 'failure' });
    expect(runOpenCodeTurn).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(mockClose).toHaveBeenCalledTimes(1);
  } finally {
    step.abort();
    await pending;
  }
});

test('a read-only preset cannot be widened by shared policy', async () => {
  check.mockResolvedValue({ decision: 'allow' });
  expect(await run(undefined, { permissionPreset: 'read_only' })).toMatchObject(
    {
      status: 'success',
      rawText: 'deny',
    },
  );
  expect(check).not.toHaveBeenCalled();
  expect(dispose).toHaveBeenCalledTimes(1);
});
test('a shared-policy prompt denial stays denied without an approval window', async () => {
  check.mockResolvedValue({
    decision: 'deny',
    message: 'Window not available',
  });
  jest.mocked(runOpenCodeTurn).mockImplementation(async (_request, host) => {
    const outcome = await host.authorize({
      sessionId: 'session',
      toolCallId: 'network',
      toolName: 'webfetch',
      toolArgs: { url: 'https://example.com/' },
    });
    return {
      sessionId: 'session',
      responseText: outcome.decision,
      isError: false,
      cancelled: false,
      message: '',
    };
  });
  expect(await run(undefined, { permissionPreset: 'plan' })).toMatchObject({
    status: 'success',
    rawText: 'deny',
  });
  expect(check).toHaveBeenCalledTimes(1);
  expect(createApprovalSession).toHaveBeenCalledWith(
    expect.objectContaining({ mode: 'ask' }),
  );
  expect(
    jest.mocked(createApprovalSession).mock.calls[0][0].getWindow(),
  ).toBeNull();
});
test('authority revoked while shared policy is resolving cannot grant a tool', async () => {
  check.mockImplementation(() => {
    jest
      .mocked(assertOpenCodeConnectionGeneration)
      .mockImplementationOnce(() => {
        throw new Error('OpenCode connection changed.');
      });
    return Promise.resolve({ decision: 'allow' });
  });
  expect(await run()).toMatchObject({
    status: 'failure',
    failure: { message: 'OpenCode connection changed.' },
  });
  expect(dispose).toHaveBeenCalledTimes(1);
  expect(mockClose).toHaveBeenCalledTimes(1);
});
test('a failed driver releases its approval session and runtime', async () => {
  jest
    .mocked(runOpenCodeTurn)
    .mockRejectedValueOnce(new Error('fixture driver failed'));
  expect(await run()).toMatchObject({
    status: 'failure',
    failure: { message: 'fixture driver failed' },
  });
  expect(dispose).toHaveBeenCalledTimes(1);
  expect(mockClose).toHaveBeenCalledTimes(1);
});
test('schema retries receive separate approval sessions that are each disposed', async () => {
  const approvals: ApprovalSessionHandle[] = [];
  const observedApprovals: ApprovalSessionHandle[] = [];
  const capabilityDisposers: jest.Mock[] = [];
  let currentApproval: (() => ApprovalSessionHandle) | undefined;
  let capabilitySignal: AbortSignal | undefined;
  jest.mocked(createApprovalSession).mockImplementation(() => {
    const approval = {
      check,
      dispose,
      invalidatePending,
      reevaluatePendingApprovals: reevaluatePendingApprovals(),
      setMode: jest.fn(),
    };
    approvals.push(approval);
    return approval;
  });
  jest
    .mocked(prepareOpenCodePipelineCapabilities)
    .mockImplementation((_request, _profile, signal, readApproval) => {
      currentApproval = readApproval;
      capabilitySignal = signal;
      const disposeCapabilities = jest.fn();
      capabilityDisposers.push(disposeCapabilities);
      return Promise.resolve({ dispose: disposeCapabilities });
    });
  jest.mocked(runOpenCodeTurn).mockImplementation(() => {
    if (!currentApproval) throw new Error('Capabilities were not prepared');
    expect(capabilitySignal?.aborted).toBe(false);
    observedApprovals.push(currentApproval());
    return Promise.resolve({
      sessionId: 'session',
      responseText: observedApprovals.length === 1 ? 'invalid' : '{}',
      isError: false,
      cancelled: false,
      message: '',
    });
  });
  expect(
    await run(undefined, {
      schema: { type: 'object' },
      pluginSelections: {
        collectionIds: ['selected'],
        pluginRefs: [],
        skillRefs: [],
      },
    }),
  ).toMatchObject({ status: 'success' });
  const sessions = jest
    .mocked(createApprovalSession)
    .mock.calls.map(([context]) => context.sessionKey);
  expect(sessions).toHaveLength(2);
  expect(new Set(sessions).size).toBe(2);
  expect(prepareOpenCodePipelineCapabilities).toHaveBeenCalledTimes(2);
  expect(observedApprovals[0]).toBe(approvals[0]);
  expect(observedApprovals[1]).toBe(approvals[1]);
  expect(approvals[1]).not.toBe(approvals[0]);
  expect(capabilityDisposers).toHaveLength(2);
  for (const disposeCapabilities of capabilityDisposers) {
    expect(disposeCapabilities).toHaveBeenCalledTimes(1);
  }
  expect(dispose).toHaveBeenCalledTimes(2);
  expect(mockClose).toHaveBeenCalledTimes(2);
});

test('pipeline-only providers use the opened runtime for model and thinking capabilities', async () => {
  jest
    .mocked(assertOpenCodeModelAvailable)
    .mockRejectedValueOnce(
      new Error('This OpenCode model is unavailable in the global catalog.'),
    );
  check.mockResolvedValue({ decision: 'allow' });
  const result = await run(undefined, {
    model: 'opencode:pipeline%2Fonly',
    environment: { PIPELINE_ONLY_PROVIDER: 'enabled' },
    thinkingLevel: 'high',
  });
  expect(result).toMatchObject({ status: 'success', rawText: 'allow' });
  expect(mockRuntimeModel).toHaveBeenCalledWith(
    'opencode:pipeline%2Fonly',
    expect.objectContaining({ env: { PIPELINE_ONLY_PROVIDER: 'enabled' } }),
    cwd,
  );
  expect(jest.mocked(runOpenCodeTurn).mock.calls[0][0].thinkingLevel).toBe(
    'high',
  );
  expect(mockClose).toHaveBeenCalledTimes(1);
});

test.each(['read_only', 'plan'] as const)(
  '%s permits native reads while retaining saved read denials',
  async (permissionPreset) => {
    let denyRead = false;
    check.mockImplementation((input) => {
      const context = jest.mocked(createApprovalSession).mock.calls.at(-1)?.[0];
      if (!context) throw new Error('Missing approval session');
      const evaluation = evaluateApproval(input, {
        mode: context.mode,
        workspaceRoot: cwd,
        rules: {
          session: context.sessionRules,
          project: denyRead
            ? [
                {
                  id: 'deny-read',
                  behavior: 'deny',
                  origin: 'settings',
                  target: { kind: 'tool', toolName: 'Read' },
                  createdAt: '2026-10-12T00:00:00Z',
                },
              ]
            : [],
          global: [],
        },
      });
      return Promise.resolve({
        decision: evaluation.outcome === 'allow' ? 'allow' : 'deny',
      });
    });
    jest.mocked(runOpenCodeTurn).mockImplementation(async (_request, host) => {
      const outcome = await host.authorize({
        sessionId: 'session',
        toolCallId: 'read',
        toolName: 'read',
        toolArgs: { filePath: join(cwd, 'SKILL.md') },
      });
      return {
        sessionId: 'session',
        responseText: outcome.decision,
        isError: false,
        cancelled: false,
        message: '',
      };
    });
    expect(await run(undefined, { permissionPreset })).toMatchObject({
      status: 'success',
      rawText: 'allow',
    });
    denyRead = true;
    expect(await run(undefined, { permissionPreset })).toMatchObject({
      status: 'success',
      rawText: 'deny',
    });
  },
);

test('managed pipeline inference keeps its captured owner and shared approval checks', async () => {
  const owner = {
    kind: 'organization' as const,
    organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  };
  jest
    .mocked(resolveRoutingOverrideAttribution)
    .mockResolvedValue({ workOwner: owner });
  const releaseLease = jest.fn();
  const route = {
    bindingKey: 'a'.repeat(64),
    protocol: 'openai-responses' as const,
    baseUrl: `http://127.0.0.1:43123/codex-gateway/${'b'.repeat(48)}`,
    model: {
      id: 'vendor/model',
      contextWindow: 128000,
      outputLimit: 16384,
      supportsVision: false,
    },
  };
  jest.mocked(openOpenCodeInferenceLease).mockResolvedValue({
    route,
    funding: 'org-gateway',
    signal: new AbortController().signal,
    dispose: releaseLease,
    failureError: () => new Error('terminal'),
  });
  check.mockResolvedValue({ decision: 'deny', message: 'Saved deny' });
  const result = await run(undefined, {
    model: 'gateway-model',
    worktreeId: 'captured-worktree',
    executionContext: `organization:${owner.organizationId}`,
  });
  expect(result.status).toBe('success');
  if (result.status === 'success') expect(result.rawText).toBe('deny');
  expect(resolveRoutingOverrideAttribution).toHaveBeenCalledWith({
    workspaceId: 'project',
    worktreeId: 'captured-worktree',
    executionContext: `organization:${owner.organizationId}`,
    environmentRuntime: 'pipeline',
  });
  expect(openOpenCodeInferenceLease).toHaveBeenCalledWith(
    expect.objectContaining({ attribution: { workOwner: owner } }),
  );
  expect(jest.mocked(runOpenCodeTurn).mock.calls[0]?.[0]).toMatchObject({
    inferenceRoute: route,
    rawModelId: 'canopy-inference/vendor/model',
  });
  expect(check).toHaveBeenCalled();
  expect(releaseLease).toHaveBeenCalledTimes(1);
  expect(mockClose).toHaveBeenCalledTimes(1);
});
