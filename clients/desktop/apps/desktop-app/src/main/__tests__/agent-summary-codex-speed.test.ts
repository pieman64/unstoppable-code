/**
 * Codex speed admission for the Codex chat-summary helper in
 * `agents/utils.ts`: the exact requested speed is admitted from the resolved
 * invocation's trusted route facts before any transcript, thread, or turn,
 * and an unavailable speed fails through the helper's existing fallback
 * without running at another speed.
 */
import os from 'node:os';

const mockResolveHelperInvocation = jest.fn<Promise<unknown>, unknown[]>();
jest.mock('../ollama/helper-invocation', () => ({
  resolveHelperInvocation: (...args: unknown[]): Promise<unknown> =>
    mockResolveHelperInvocation(...args),
  resolveHelperWorkOwner: (): Promise<undefined> => Promise.resolve(undefined),
}));

jest.mock('../lib/model-policy-state', () => ({
  isModelBlockedByStoredPolicy: (): Promise<boolean> => Promise.resolve(false),
}));

jest.mock('../lib/preferences-store', () => ({
  readPreferencesFile: jest.fn(() => Promise.resolve({})),
  readLocalMemoryEnabledPreference: jest.fn(() => Promise.resolve(false)),
}));

jest.mock('../integration/claude-worker-session-service', () => ({
  getClaudeWorkerSessionService: jest.fn(() => ({
    runWorker: jest.fn(),
    cancel: jest.fn(),
  })),
}));

jest.mock('../lib/helper-observed-task', () => ({
  markObservedHelperTaskAiCreditsRouted: jest.fn(),
}));

const mockWorkspaceEnvironment = jest.fn<Record<string, string>, []>(
  () => ({}),
);
jest.mock('../lib/user-environment-runtime', () => ({
  resolveCodexRuntimeEnvironmentProfile: (): {
    environment: Record<string, string>;
    logicalWorkspaceEnvironmentId: string;
  } => ({
    environment: mockWorkspaceEnvironment(),
    logicalWorkspaceEnvironmentId: 'test-environment',
  }),
}));

const mockRunTurn = jest.fn<Promise<Record<string, unknown>>, [unknown]>();
const mockDeleteThread = jest.fn(() => Promise.resolve());
const mockStartThread = jest.fn((request: unknown) => {
  void request;
  return Promise.resolve({
    threadId: 'summary-thread',
    runTurn: mockRunTurn,
    delete: mockDeleteThread,
  });
});
jest.mock('../codex/runtime-service', () => ({
  getCodexRuntimeService: (): { startThread: typeof mockStartThread } => ({
    startThread: mockStartThread,
  }),
}));

const mockSeedTranscript = jest.fn();
jest.mock('../observability', () => ({
  getObservabilityService: (): unknown => ({
    finalizeObservedTask: jest.fn(),
    seedTranscript: mockSeedTranscript,
    appendTranscriptRecord: jest.fn(),
    updateObservedTask: jest.fn(),
  }),
}));

const mockAssertCodexSpeedAvailable = jest.fn(
  (request: { speed: string }): Promise<Record<string, unknown>> =>
    Promise.resolve({ speed: request.speed, availability: {}, generation: 5 }),
);
const mockReportCodexSpeedRejection = jest.fn(
  (report: unknown): boolean => report !== undefined,
);
jest.mock('../model-routing/codex-account-models', () => ({
  assertCodexSpeedAvailable: (request: {
    speed: string;
  }): Promise<Record<string, unknown>> =>
    mockAssertCodexSpeedAvailable(request),
  reportCodexSpeedRejection: (report: unknown): boolean =>
    mockReportCodexSpeedRejection(report),
}));

import { initCodexModels } from '@canopy/desktop-shared/types';
import { CodexSpeedUnsupportedError } from '@canopy/desktop-shared/lib/codex-speed';
import { generateChatSummary } from '../agents/utils';

const NATIVE_INVOCATION = {
  providerType: 'codex',
  source: 'codex-managed',
  harness: 'codex',
  sdkModel: 'gpt-5.5',
  aiCreditsRouted: false,
  dispose: (): void => undefined,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function startedThreadConfig(): unknown {
  const request: unknown = mockStartThread.mock.calls[0]?.[0];
  const params = isRecord(request) ? request.params : undefined;
  return isRecord(params) ? params.config : undefined;
}

describe('Codex chat summary speed admission', () => {
  let consoleErrorSpy: jest.SpyInstance;

  beforeAll(() => {
    initCodexModels([{ id: 'gpt-5.5', label: 'GPT 5.5' }]);
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockWorkspaceEnvironment.mockReturnValue({});
    mockResolveHelperInvocation.mockResolvedValue(NATIVE_INVOCATION);
    mockRunTurn.mockResolvedValue({
      status: 'completed',
      finalText: 'Rotate signing key',
      usage: {},
    });
    consoleErrorSpy = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it('admits the exact Ultra fast speed on the native route before starting a thread', async () => {
    await expect(
      generateChatSummary('Rotate the production signing key', {
        model: 'gpt-5.5',
        cwd: os.tmpdir(),
        workspaceId: 'workspace',
        modelConfig: { speed: 'ultrafast' },
      }),
    ).resolves.toMatchObject({
      text: 'Rotate signing key',
    });

    expect(mockAssertCodexSpeedAvailable).toHaveBeenCalledTimes(1);
    const admissionRequest: unknown =
      mockAssertCodexSpeedAvailable.mock.calls[0]?.[0];
    expect(admissionRequest).toMatchObject({
      speed: 'ultrafast',
      route: {
        runtimeModel: 'gpt-5.5',
        modelSource: 'codex-managed',
        harness: 'codex',
        routeProfile: 'codex-native',
      },
    });
    expect(
      mockAssertCodexSpeedAvailable.mock.invocationCallOrder[0],
    ).toBeLessThan(mockStartThread.mock.invocationCallOrder[0] ?? 0);
    expect(startedThreadConfig()).toMatchObject({ service_tier: 'ultrafast' });
  });

  it('classifies AI Credits routing and a user credential environment from trusted facts', async () => {
    mockResolveHelperInvocation.mockResolvedValueOnce({
      ...NATIVE_INVOCATION,
      sdkModel: 'openai/gpt-5.5',
      codexConfig: { model_provider: 'canopy_gateway' },
      aiCreditsRouted: true,
    });
    await generateChatSummary('Summarize', {
      model: 'gpt-5.5',
      cwd: os.tmpdir(),
      modelConfig: { speed: 'fast' },
    });
    const creditsRequest: unknown =
      mockAssertCodexSpeedAvailable.mock.lastCall?.[0];
    expect(creditsRequest).toMatchObject({
      speed: 'fast',
      route: {
        runtimeModel: 'openai/gpt-5.5',
        routeProfile: 'ai-credits',
      },
    });

    mockWorkspaceEnvironment.mockReturnValue({ OPENAI_API_KEY: 'sk-user' });
    await generateChatSummary('Summarize', {
      model: 'gpt-5.5',
      cwd: os.tmpdir(),
      modelConfig: { speed: 'ultrafast' },
    });
    const foreignRequest: unknown =
      mockAssertCodexSpeedAvailable.mock.lastCall?.[0];
    expect(foreignRequest).toMatchObject({
      speed: 'ultrafast',
      route: { routeProfile: 'foreign' },
    });
  });

  it('falls back visibly without any transcript, thread, or turn when Ultra fast is unavailable', async () => {
    mockAssertCodexSpeedAvailable.mockRejectedValueOnce(
      new CodexSpeedUnsupportedError(
        'ultrafast',
        'Ultra fast is not available for this model.',
      ),
    );

    await expect(
      generateChatSummary('Rotate the production signing key', {
        model: 'gpt-5.5',
        cwd: os.tmpdir(),
        observabilityTaskKey: 'helper:chat-summary:speed',
        modelConfig: { speed: 'ultrafast' },
      }),
    ).resolves.toEqual({
      text: 'Rotate the production signing key',
      usage: {},
      fallback: {
        reason: 'Ultra fast is not available for this model.',
        retryable: true,
      },
    });

    expect(mockSeedTranscript).not.toHaveBeenCalled();
    expect(mockStartThread).not.toHaveBeenCalled();
    expect(mockRunTurn).not.toHaveBeenCalled();
  });

  it('reports one failed Ultra fast summary turn against its admission', async () => {
    mockRunTurn.mockResolvedValueOnce({
      status: 'failed',
      finalText: '',
      usage: {},
      error: 'The requested service tier is not available for this model.',
      errorInfo: 'badRequest',
    });

    const result = await generateChatSummary('Rotate the key', {
      model: 'gpt-5.5',
      cwd: os.tmpdir(),
      modelConfig: { speed: 'ultrafast' },
    });

    expect(result.fallback?.reason).toContain('service tier');
    expect(mockRunTurn).toHaveBeenCalledTimes(1);
    expect(mockReportCodexSpeedRejection).toHaveBeenCalledTimes(1);
    expect(mockReportCodexSpeedRejection).toHaveBeenCalledWith({
      speed: 'ultrafast',
      runtimeModel: 'gpt-5.5',
      kind: 'tier',
      generation: 5,
    });
  });
});
