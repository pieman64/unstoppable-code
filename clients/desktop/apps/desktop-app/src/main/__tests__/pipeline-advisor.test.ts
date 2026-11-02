import type * as PreferencesStoreModule from '../lib/preferences-store';
import type { resolveHelperInvocation } from '../ollama/helper-invocation';

jest.mock('../lib/window-send', () => ({
  sendToWindow: jest.fn(),
}));

jest.mock('../lib/preferences-store', () => {
  const actual = jest.requireActual<typeof PreferencesStoreModule>(
    '../lib/preferences-store',
  );
  return Object.defineProperties(
    {},
    {
      ...Object.getOwnPropertyDescriptors(actual),
      readPreferencesFile: {
        value: jest.fn(),
        enumerable: true,
      },
    },
  );
});

const mockLoadExecutionState = jest.fn();
jest.mock('@canopy/desktop-shared/node/pipelines/executor', () => ({
  get loadExecutionState(): typeof mockLoadExecutionState {
    return mockLoadExecutionState;
  },
}));

const mockAdvisorSnapshots = new Map<string, PipelineAdvisorSnapshot>();
jest.mock('../pipelines/pipeline-advisor-store', () => ({
  getPipelineExecutionDataDir: (
    executionsDir: string,
    executionId: string,
  ): string => `${executionsDir}/${executionId}`,
  readPipelineAdvisorSnapshot: jest.fn(
    (
      _executionsDir: string,
      executionId: string,
    ): Promise<PipelineAdvisorSnapshot | null> =>
      Promise.resolve(mockAdvisorSnapshots.get(executionId) ?? null),
  ),
  writePipelineAdvisorSnapshot: jest.fn(
    (
      _executionsDir: string,
      snapshot: PipelineAdvisorSnapshot,
    ): Promise<void> => {
      mockAdvisorSnapshots.set(snapshot.executionId, snapshot);
      return Promise.resolve();
    },
  ),
  normalizePipelineAdvisorReports: (
    reports: PipelineAdvisorReport[],
  ): PipelineAdvisorReport[] => reports.slice(-50),
}));

const mockRunPipelineAdvisorSdkTurn = jest.fn<
  Promise<PipelineAdvisorSdkTurnResult>,
  [PipelineAdvisorSdkTurnInput]
>();
const mockIsModelBlockedByStoredPolicy = jest.fn<
  Promise<boolean>,
  [model: string]
>(() => Promise.resolve(false));
const mockResolveHelperInvocation = jest.fn<
  ReturnType<typeof resolveHelperInvocation>,
  Parameters<typeof resolveHelperInvocation>
>(() =>
  Promise.resolve({
    providerType: 'codex' as const,
    source: 'codex-managed' as const,
    harness: 'codex' as const,
    sdkModel: 'gpt-5.5',
    aiCreditsRouted: false,
    dispose: () => undefined,
  }),
);

jest.mock('../lib/model-policy-state', () => ({
  isModelBlockedByStoredPolicy: (model: string): Promise<boolean> =>
    mockIsModelBlockedByStoredPolicy(model),
}));
jest.mock('../ollama/helper-invocation', () => ({
  resolveHelperInvocation: (
    ...args: Parameters<typeof resolveHelperInvocation>
  ): ReturnType<typeof resolveHelperInvocation> =>
    mockResolveHelperInvocation(...args),
  resolveHelperWorkOwner: jest.fn(() => Promise.resolve({ kind: 'personal' })),
}));
jest.mock('../pipelines/pipeline-advisor-sdk', () => ({
  PIPELINE_ADVISOR_SYSTEM_PROMPT: 'advisor system prompt',
  get runPipelineAdvisorSdkTurn(): typeof mockRunPipelineAdvisorSdkTurn {
    return mockRunPipelineAdvisorSdkTurn;
  },
}));

const mockStartObservedTask = jest.fn();
const mockSeedTranscript = jest.fn();
const mockAppendTranscriptRecord = jest.fn();
const mockUpdateObservedTask = jest.fn();
const mockFinalizeObservedTask = jest.fn();
const mockMarkObservedTaskAccountProxyRouted = jest.fn();
jest.mock('../observability', () => ({
  getObservabilityService: jest.fn(() => ({
    get startObservedTask(): typeof mockStartObservedTask {
      return mockStartObservedTask;
    },
    get seedTranscript(): typeof mockSeedTranscript {
      return mockSeedTranscript;
    },
    get appendTranscriptRecord(): typeof mockAppendTranscriptRecord {
      return mockAppendTranscriptRecord;
    },
    get updateObservedTask(): typeof mockUpdateObservedTask {
      return mockUpdateObservedTask;
    },
    get finalizeObservedTask(): typeof mockFinalizeObservedTask {
      return mockFinalizeObservedTask;
    },
    get markObservedTaskAccountProxyRouted(): typeof mockMarkObservedTaskAccountProxyRouted {
      return mockMarkObservedTaskAccountProxyRouted;
    },
  })),
}));

import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  initCodexModels,
  initOllamaModels,
  type PreferencesData,
} from '@canopy/desktop-shared/types';
import type {
  PipelineAdvisorReport,
  PipelineAdvisorSnapshot,
} from '@canopy/desktop-shared/types/pipeline';
import type {
  ExecutionHandle,
  ExecutionRuntime,
  ExecutionState,
} from '@canopy/desktop-shared/node/pipelines/executor';
import type {
  PipelineAdvisorSdkTurnInput,
  PipelineAdvisorSdkTurnResult,
} from '../pipelines/pipeline-advisor-sdk';
import {
  getPipelineAdvisorService,
  PIPELINE_ADVISOR_REPORT_SCHEMA,
} from '../pipelines/pipeline-advisor';
import {
  DEFAULT_PREFERENCES,
  readPreferencesFile,
} from '../lib/preferences-store';

const mockReadPreferencesFile = jest.mocked(readPreferencesFile);

initCodexModels([{ id: 'gpt-5.5', label: 'GPT 5.5' }]);
initOllamaModels([
  {
    id: 'ollama-qwen3-coder',
    rawModelId: 'qwen3-coder',
    label: 'qwen3-coder',
    show: { capabilities: ['completion', 'tools'] },
  },
]);

let tempDir: string;

/**
 * Build a fully-typed preferences fixture: overriding on top of
 * `DEFAULT_PREFERENCES` keeps the mock an actual `PreferencesData` value
 * without smuggling shape errors past the compiler with an `as` cast.
 */
function advisorPreferences(
  overrides: Partial<PreferencesData>,
): PreferencesData {
  return { ...DEFAULT_PREFERENCES, ...overrides };
}

beforeEach(async () => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-05-13T00:00:00.000Z'));
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'pipeline-advisor-'));
  mockAdvisorSnapshots.clear();
  mockIsModelBlockedByStoredPolicy.mockResolvedValue(false);
  mockResolveHelperInvocation.mockResolvedValue({
    providerType: 'codex',
    source: 'codex-managed',
    harness: 'codex',
    sdkModel: 'gpt-5.5',
    aiCreditsRouted: false,
    dispose: () => undefined,
  });
  mockReadPreferencesFile.mockResolvedValue(
    advisorPreferences({
      pipelineAdvisorEnabled: true,
      pipelineAdvisorModel: 'gpt-5.5',
      pipelineAdvisorThinkingLevel: 'high',
      providerModelConfigDefaults: { codex: { fastMode: false } },
    }),
  );
  mockLoadExecutionState.mockResolvedValue(null);
  mockRunPipelineAdvisorSdkTurn.mockImplementation(
    (input): Promise<PipelineAdvisorSdkTurnResult> =>
      Promise.resolve({
        report: createSdkReport(),
        rawText: JSON.stringify(createSdkReport()),
        sdkSessionId: input.sdkSessionId ?? 'thread-1',
        usage: { inputTokens: 10, outputTokens: 5, messageCount: 1 },
      }),
  );
});

afterEach(async () => {
  getPipelineAdvisorService().shutdown('app-quit');
  await flushPromises();
  jest.useRealTimers();
  jest.clearAllMocks();
  await rm(tempDir, { recursive: true, force: true });
});

function createState(overrides: Partial<ExecutionState> = {}): ExecutionState {
  // Version-4 persisted states predate the materialized job/group fields.
  return {
    version: 4,
    id: 'execution-1',
    pipeline_id: 'pipeline-1',
    pipeline_snapshot: { name: 'Pipeline 1', scope: ['directory'], jobs: {} },
    status: 'running',
    jobs: {},
    started_at: '2026-05-13T00:00:00.000Z',
    cwd: tempDir,
    env: {},
    inputs: {},
    project_id: 'project-1',
    ...overrides,
  } as ExecutionState;
}

function createHandle(state: ExecutionState): {
  handle: ExecutionHandle;
  resolveCompletion: (state?: ExecutionState) => void;
} {
  let currentState = state;
  let resolve!: (state: ExecutionState) => void;
  const completion = new Promise<ExecutionState>((innerResolve) => {
    resolve = innerResolve;
  });
  return {
    handle: {
      id: currentState.id,
      cancel: jest.fn(
        (): Promise<ExecutionState> => Promise.resolve(currentState),
      ),
      getState: jest.fn(() => currentState),
      waitForCompletion: jest.fn(() => completion),
    },
    resolveCompletion: (nextState = currentState): void => {
      currentState = nextState;
      resolve(nextState);
    },
  };
}

function createRuntime(): ExecutionRuntime {
  return {
    // Pipeline fixtures do not enforce an org model policy.
    isModelBlockedByOrgPolicy: (): Promise<boolean> => Promise.resolve(false),
    isOrgModelPolicyActive: (): Promise<boolean> => Promise.resolve(false),
    executionsDir: tempDir,
    tempRootDir: tempDir,
    bundledActionsDir: tempDir,
    getProjectActionsDir: () => tempDir,
    getProjectPipelinesDir: () => tempDir,
  };
}

function createSdkReport(): Pick<
  PipelineAdvisorReport,
  'health' | 'eta' | 'inefficiencies' | 'summary' | 'recommendations'
> {
  return {
    health: {
      status: 'healthy',
      score: 90,
      summary: 'Healthy',
      evidence: ['step completed'],
      blockers: [],
    },
    eta: {
      status: 'available',
      remainingSeconds: 120,
      confidence: 'medium',
      rationale: 'Two minutes remain.',
    },
    inefficiencies: [],
    summary: 'Running well.',
    recommendations: [],
  };
}

function createFinalReport(): Pick<
  PipelineAdvisorReport,
  'health' | 'eta' | 'inefficiencies' | 'summary' | 'recommendations'
> {
  return {
    ...createSdkReport(),
    eta: {
      status: 'complete',
      confidence: 'high',
      rationale: 'Pipeline finished.',
    },
    summary: 'Pipeline finished.',
  };
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function waitForAdvisorTimer(): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    if (jest.getTimerCount() > 0) {
      return;
    }
    await jest.advanceTimersByTimeAsync(0);
    await flushPromises();
  }
}

async function waitForSdkCalls(count: number): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    if (mockRunPipelineAdvisorSdkTurn.mock.calls.length >= count) {
      return;
    }
    await jest.advanceTimersByTimeAsync(0);
    await flushPromises();
  }
}

function getSdkTurnInput(
  callIndex: number,
): PipelineAdvisorSdkTurnInput | undefined {
  return mockRunPipelineAdvisorSdkTurn.mock.calls[callIndex]?.[0];
}

function getLastSdkTurnInput(): PipelineAdvisorSdkTurnInput | undefined {
  return getSdkTurnInput(mockRunPipelineAdvisorSdkTurn.mock.calls.length - 1);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function collectMissingStrictRequiredProperties(
  schema: unknown,
  path = '$',
): string[] {
  if (!isRecord(schema)) {
    return [];
  }

  const missing: string[] = [];
  if (isRecord(schema.properties)) {
    const required = Array.isArray(schema.required)
      ? new Set(
          schema.required.filter(
            (item): item is string => typeof item === 'string',
          ),
        )
      : new Set<string>();
    for (const key of Object.keys(schema.properties)) {
      if (!required.has(key)) {
        missing.push(`${path}.${key}`);
      }
    }
    for (const [key, child] of Object.entries(schema.properties)) {
      missing.push(
        ...collectMissingStrictRequiredProperties(child, `${path}.${key}`),
      );
    }
  }

  if (schema.items !== undefined) {
    missing.push(
      ...collectMissingStrictRequiredProperties(schema.items, `${path}[]`),
    );
  }

  return missing;
}

it('uses a Codex-compatible strict structured output schema', () => {
  expect(
    collectMissingStrictRequiredProperties(PIPELINE_ADVISOR_REPORT_SCHEMA),
  ).toEqual([]);
});

it('starts the initial advisor turn five seconds after watchExecution', async () => {
  const { handle } = createHandle(createState());
  getPipelineAdvisorService().watchExecution({
    handle,
    runtime: createRuntime(),
    getWindow: () => null,
  });
  await flushPromises();
  await waitForAdvisorTimer();

  expect(mockRunPipelineAdvisorSdkTurn).not.toHaveBeenCalled();

  await jest.advanceTimersByTimeAsync(5_000);
  await waitForSdkCalls(1);
  await flushPromises();

  expect(mockRunPipelineAdvisorSdkTurn).toHaveBeenCalledWith(
    expect.objectContaining({
      provider: 'codex',
      model: 'gpt-5.5',
      sdkSessionId: undefined,
    }),
  );
  const snapshot = mockAdvisorSnapshots.get('execution-1') as
    | { sdkSessionId?: string; reports: { kind: string }[] }
    | undefined;
  expect(snapshot?.sdkSessionId).toBe('thread-1');
  expect(snapshot?.reports[0].kind).toBe('initial');
});

it('resolves the persisted Ollama advisor model for loopback dispatch', async () => {
  mockResolveHelperInvocation.mockResolvedValueOnce({
    providerType: 'ollama',
    source: 'ollama',
    harness: 'codex',
    sdkModel: 'qwen3-coder',
    codexConfig: {
      model_provider: 'canopy_ollama',
      model_providers: {
        canopy_ollama: {
          name: 'Ollama',
          base_url: 'http://127.0.0.1:11434/v1',
          wire_api: 'responses',
        },
      },
    },
    aiCreditsRouted: false,
    dispose: () => undefined,
  });
  mockReadPreferencesFile.mockResolvedValueOnce(
    advisorPreferences({
      pipelineAdvisorEnabled: true,
      pipelineAdvisorModel: 'ollama-qwen3-coder',
      pipelineAdvisorThinkingLevel: 'high',
      providerModelConfigDefaults: { codex: { fastMode: false } },
    }),
  );
  const { handle } = createHandle(
    createState({
      version: 5,
      model_config: { fastMode: true },
      execution_context: 'org:123e4567-e89b-12d3-a456-426614174000',
    }),
  );
  getPipelineAdvisorService().watchExecution({
    handle,
    runtime: createRuntime(),
    getWindow: () => null,
  });
  await flushPromises();
  await waitForAdvisorTimer();
  await jest.advanceTimersByTimeAsync(5_000);
  await waitForSdkCalls(1);

  expect(mockResolveHelperInvocation).toHaveBeenCalledWith(
    'ollama-qwen3-coder',
    undefined,
    {
      allowNoNativeAuthFallback: false,
      workspaceId: 'project-1',
      executionContext: 'org:123e4567-e89b-12d3-a456-426614174000',
      signal: mockResolveHelperInvocation.mock.calls[0]?.[2]?.signal,
    },
  );
  expect(mockRunPipelineAdvisorSdkTurn).toHaveBeenCalledWith(
    expect.objectContaining({
      provider: 'codex',
      model: 'qwen3-coder',
      codexConfig: {
        model_provider: 'canopy_ollama',
        model_providers: {
          canopy_ollama: {
            name: 'Ollama',
            base_url: 'http://127.0.0.1:11434/v1',
            wire_api: 'responses',
          },
        },
      },
    }),
  );
  expect(mockStartObservedTask).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({
      provider: 'ollama',
      modelSource: 'ollama',
      executionHarness: 'codex',
      serviceTier: 'priority',
      label: 'Workflow Advisor',
    }),
  );
});

it('records AI Credits routing on the Advisor audit entry', async () => {
  mockResolveHelperInvocation.mockResolvedValueOnce({
    providerType: 'codex',
    source: 'codex-managed',
    harness: 'codex',
    sdkModel: 'gateway-gpt',
    codexConfig: { model_provider: 'canopy-gateway' },
    aiCreditsRouted: true,
    dispose: () => undefined,
  });
  const { handle } = createHandle(createState());

  getPipelineAdvisorService().watchExecution({
    handle,
    runtime: createRuntime(),
    getWindow: () => null,
  });
  await flushPromises();
  await waitForAdvisorTimer();
  await jest.advanceTimersByTimeAsync(5_000);
  await waitForSdkCalls(1);

  expect(mockUpdateObservedTask).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({
      provider: 'codex',
      modelSource: 'codex-managed',
      executionHarness: 'codex',
      aiCreditsRouted: true,
    }),
  );
});

it('keeps an Advisor turn the account proxy served off the native account', async () => {
  mockResolveHelperInvocation.mockResolvedValueOnce({
    providerType: 'claude',
    source: 'claude-managed',
    harness: 'claude',
    sdkModel: 'sonnet',
    envOverride: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:4100/route' },
    aiCreditsRouted: false,
    dispose: () => undefined,
    accountProxyRouted: true,
  });
  const { handle } = createHandle(createState());

  getPipelineAdvisorService().watchExecution({
    handle,
    runtime: createRuntime(),
    getWindow: () => null,
  });
  await flushPromises();
  await waitForAdvisorTimer();
  await jest.advanceTimersByTimeAsync(5_000);
  await waitForSdkCalls(1);

  expect(mockMarkObservedTaskAccountProxyRouted).toHaveBeenCalledWith(
    expect.stringMatching(/^pipeline-advisor:execution-1:initial:/),
  );
});

it('passes the resolved invocation route facts for Codex speed admission', async () => {
  mockResolveHelperInvocation.mockResolvedValueOnce({
    providerType: 'codex',
    source: 'codex-managed',
    harness: 'codex',
    sdkModel: 'gateway-gpt',
    codexConfig: { model_provider: 'canopy-gateway' },
    aiCreditsRouted: true,
    dispose: () => undefined,
  });
  const { handle } = createHandle(
    createState({ model_config: { speed: 'ultrafast' } }),
  );

  getPipelineAdvisorService().watchExecution({
    handle,
    runtime: createRuntime(),
    getWindow: () => null,
  });
  await flushPromises();
  await waitForAdvisorTimer();
  await jest.advanceTimersByTimeAsync(5_000);
  await waitForSdkCalls(1);

  expect(mockRunPipelineAdvisorSdkTurn).toHaveBeenCalledWith(
    expect.objectContaining({
      model: 'gateway-gpt',
      modelConfig: { speed: 'ultrafast' },
      codexConfig: { model_provider: 'canopy-gateway' },
      codexSpeedRoute: {
        selectedModel: 'gpt-5.5',
        modelSource: 'codex-managed',
        providerType: 'codex',
        gateway: 'ai-credits',
      },
    }),
  );
});

it('attributes Ollama audit entries before helper invocation can fail', async () => {
  mockResolveHelperInvocation.mockRejectedValueOnce(
    new Error('Ollama is unavailable'),
  );
  mockReadPreferencesFile.mockResolvedValueOnce(
    advisorPreferences({
      pipelineAdvisorEnabled: true,
      pipelineAdvisorModel: 'ollama-qwen3-coder',
      pipelineAdvisorThinkingLevel: 'high',
      providerModelConfigDefaults: { codex: { fastMode: false } },
    }),
  );
  const { handle } = createHandle(createState());

  getPipelineAdvisorService().watchExecution({
    handle,
    runtime: createRuntime(),
    getWindow: () => null,
  });
  await flushPromises();
  await waitForAdvisorTimer();
  await jest.advanceTimersByTimeAsync(5_000);
  await flushPromises();

  expect(mockStartObservedTask).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({
      provider: 'ollama',
      modelSource: 'ollama',
      executionHarness: 'codex',
    }),
  );
  expect(mockRunPipelineAdvisorSdkTurn).not.toHaveBeenCalled();
  expect(mockFinalizeObservedTask).toHaveBeenCalledWith(
    expect.any(String),
    'failure',
    'Ollama is unavailable',
    {},
  );
});

it('preserves a restored advisor snapshot when its model becomes blocked', async () => {
  const preservedReport: PipelineAdvisorReport = {
    version: 1,
    reportId: 'preserved-report',
    executionId: 'execution-1',
    kind: 'periodic',
    generatedAt: '2026-05-12T23:59:00.000Z',
    pipelineStatus: 'running',
    health: {
      status: 'healthy',
      score: 90,
      summary: 'Preserved health report',
      evidence: ['preserved evidence'],
      blockers: [],
    },
    eta: {
      status: 'available',
      remainingSeconds: 120,
      confidence: 'medium',
      rationale: 'Preserved ETA',
    },
    inefficiencies: [],
    summary: 'Preserved report',
    recommendations: [],
  };
  mockAdvisorSnapshots.set('execution-1', {
    version: 1,
    executionId: 'execution-1',
    executionDataDir: `${tempDir}/execution-1`,
    stateFilePath: `${tempDir}/execution-1.json`,
    provider: 'codex',
    model: 'gpt-5.5',
    thinkingLevel: 'high',
    sdkSessionId: 'preserved-session',
    status: 'waiting',
    turnCount: 3,
    backoffIndex: 1,
    lastUpdatedAt: '2026-05-12T23:59:00.000Z',
    reports: [preservedReport],
    latestReport: preservedReport,
  });
  mockIsModelBlockedByStoredPolicy.mockResolvedValue(true);
  const { handle } = createHandle(createState());

  getPipelineAdvisorService().watchExecution({
    handle,
    runtime: createRuntime(),
    getWindow: () => null,
  });
  for (let index = 0; index < 20; index += 1) {
    const snapshot = mockAdvisorSnapshots.get('execution-1');
    if (snapshot?.lastError) {
      break;
    }
    await jest.advanceTimersByTimeAsync(0);
    await flushPromises();
  }

  expect(mockRunPipelineAdvisorSdkTurn).not.toHaveBeenCalled();
  expect(mockAdvisorSnapshots.get('execution-1')).toMatchObject({
    sdkSessionId: 'preserved-session',
    turnCount: 4,
    reports: [{ reportId: 'preserved-report' }],
    latestReport: { reportId: 'preserved-report' },
    lastError: {
      message:
        'Workflow Advisor was skipped: this model is blocked by your organization policy.',
    },
  });
});

it('fails closed before dispatch when the configured advisor model is blocked by organization policy', async () => {
  mockIsModelBlockedByStoredPolicy.mockResolvedValue(true);
  const { handle } = createHandle(createState());

  getPipelineAdvisorService().watchExecution({
    handle,
    runtime: createRuntime(),
    getWindow: () => null,
  });
  for (let index = 0; index < 20; index += 1) {
    if (mockAdvisorSnapshots.has('execution-1')) {
      break;
    }
    await jest.advanceTimersByTimeAsync(0);
    await flushPromises();
  }

  expect(mockIsModelBlockedByStoredPolicy).toHaveBeenCalledWith('gpt-5.5');
  expect(mockRunPipelineAdvisorSdkTurn).not.toHaveBeenCalled();
  expect(mockAdvisorSnapshots.get('execution-1')).toMatchObject({
    status: 'waiting',
    lastError: {
      message:
        'Workflow Advisor was skipped: this model is blocked by your organization policy.',
    },
  });
});

it('rechecks organization policy immediately before each advisor dispatch', async () => {
  mockIsModelBlockedByStoredPolicy
    .mockResolvedValueOnce(false)
    .mockResolvedValue(true);
  const { handle } = createHandle(createState());

  getPipelineAdvisorService().watchExecution({
    handle,
    runtime: createRuntime(),
    getWindow: () => null,
  });
  await flushPromises();
  await waitForAdvisorTimer();
  await jest.advanceTimersByTimeAsync(5_000);
  await flushPromises();

  expect(mockIsModelBlockedByStoredPolicy).toHaveBeenCalledTimes(2);
  expect(mockRunPipelineAdvisorSdkTurn).not.toHaveBeenCalled();
  expect(mockSeedTranscript).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({ provider: 'codex' }),
  );
  expect(mockAdvisorSnapshots.get('execution-1')).toMatchObject({
    status: 'waiting',
    lastError: {
      message:
        'Workflow Advisor was skipped: this model is blocked by your organization policy.',
    },
  });
});

it('starts an immediate advisor turn when manually refreshed on an active supervisor', async () => {
  const state = createState();
  const { handle } = createHandle(state);
  getPipelineAdvisorService().watchExecution({
    handle,
    runtime: createRuntime(),
    getWindow: () => null,
  });
  await flushPromises();
  await waitForAdvisorTimer();
  await jest.advanceTimersByTimeAsync(5_000);
  await waitForSdkCalls(1);
  await waitForAdvisorTimer();

  let snapshot = mockAdvisorSnapshots.get('execution-1') as
    | { status?: string; nextUpdateAt?: string; reports?: { kind: string }[] }
    | undefined;
  expect(snapshot?.status).toBe('waiting');
  expect(snapshot?.nextUpdateAt).toBeDefined();

  await expect(
    getPipelineAdvisorService().runForExistingExecution({
      executionId: state.id,
      runtime: createRuntime(),
      getWindow: () => null,
    }),
  ).resolves.toMatchObject({
    executionId: state.id,
    status: 'starting',
    nextUpdateAt: undefined,
  });
  await waitForSdkCalls(2);
  await flushPromises();

  const latestSdkInput = getLastSdkTurnInput();
  expect(latestSdkInput?.userPrompt).toContain(
    'Provide an updated pipeline health assessment',
  );
  expect(latestSdkInput?.sdkSessionId).toBe('thread-1');
  expect(latestSdkInput?.workspaceId).toBe('project-1');
  snapshot = mockAdvisorSnapshots.get('execution-1');
  expect(snapshot?.reports?.map((report) => report.kind)).toEqual([
    'initial',
    'periodic',
  ]);
});

it('does not start automatic advisor turns when the advisor is disabled', async () => {
  mockReadPreferencesFile.mockResolvedValueOnce(
    advisorPreferences({
      pipelineAdvisorEnabled: false,
      pipelineAdvisorModel: 'gpt-5.5',
      pipelineAdvisorThinkingLevel: 'high',
      providerModelConfigDefaults: { codex: { fastMode: false } },
    }),
  );
  const { handle } = createHandle(createState());

  getPipelineAdvisorService().watchExecution({
    handle,
    runtime: createRuntime(),
    getWindow: () => null,
  });
  await flushPromises();
  await jest.advanceTimersByTimeAsync(5_000);
  await flushPromises();

  expect(mockRunPipelineAdvisorSdkTurn).not.toHaveBeenCalled();
  expect(mockAdvisorSnapshots.get('execution-1')).toBeUndefined();
});

it('continues scheduled advisor turns after a manual run when automatic advisors are enabled', async () => {
  mockReadPreferencesFile.mockResolvedValueOnce(
    advisorPreferences({
      pipelineAdvisorEnabled: false,
      pipelineAdvisorModel: 'gpt-5.5',
      pipelineAdvisorThinkingLevel: 'high',
      providerModelConfigDefaults: { codex: { fastMode: false } },
    }),
  );
  const state = createState();
  const { handle } = createHandle(state);
  getPipelineAdvisorService().watchExecution({
    handle,
    runtime: createRuntime(),
    getWindow: () => null,
  });
  await flushPromises();
  await jest.advanceTimersByTimeAsync(5_000);
  await flushPromises();
  expect(mockRunPipelineAdvisorSdkTurn).not.toHaveBeenCalled();

  mockLoadExecutionState.mockResolvedValue(state);
  await expect(
    getPipelineAdvisorService().runForExistingExecution({
      executionId: state.id,
      runtime: createRuntime(),
      getWindow: () => null,
    }),
  ).resolves.toMatchObject({
    executionId: state.id,
    status: 'starting',
  });
  await waitForSdkCalls(1);
  await waitForAdvisorTimer();

  let snapshot = mockAdvisorSnapshots.get('execution-1');
  expect(snapshot?.reports?.[0]?.kind).toBe('initial');
  expect(snapshot?.status).toBe('waiting');
  expect(snapshot?.nextUpdateAt).toBeDefined();

  await jest.advanceTimersByTimeAsync(2 * 60_000);
  await waitForSdkCalls(2);
  await flushPromises();

  const latestSdkInput = getLastSdkTurnInput();
  expect(latestSdkInput?.userPrompt).toContain(
    'Provide an updated pipeline health assessment',
  );
  expect(latestSdkInput?.sdkSessionId).toBe('thread-1');
  snapshot = mockAdvisorSnapshots.get('execution-1');
  expect(snapshot?.reports?.map((report) => report.kind)).toEqual([
    'initial',
    'periodic',
  ]);
  expect(snapshot?.status).toBe('waiting');
});

it('starts a one-shot final advisor run for an existing terminal execution', async () => {
  const state = createState({
    status: 'cancelled',
    completed_at: '2026-05-13T00:05:00.000Z',
  });
  mockLoadExecutionState.mockResolvedValue(state);

  await expect(
    getPipelineAdvisorService().runForExistingExecution({
      executionId: state.id,
      runtime: createRuntime(),
      getWindow: () => null,
    }),
  ).resolves.toMatchObject({
    executionId: state.id,
    status: 'starting',
  });
  await waitForSdkCalls(1);
  await flushPromises();

  expect(getLastSdkTurnInput()?.userPrompt).toContain(
    'The pipeline has finished.',
  );
  const snapshot = mockAdvisorSnapshots.get('execution-1');
  expect(snapshot?.status).toBe('cancelled');
  expect(snapshot?.reports?.[0]?.kind).toBe('final');
});

it('allows on-demand advisor runs when automatic advisor starts are disabled', async () => {
  mockReadPreferencesFile.mockResolvedValueOnce(
    advisorPreferences({
      pipelineAdvisorEnabled: false,
      pipelineAdvisorModel: 'gpt-5.5',
      pipelineAdvisorThinkingLevel: 'high',
      providerModelConfigDefaults: { codex: { fastMode: false } },
    }),
  );
  const state = createState({
    status: 'cancelled',
    completed_at: '2026-05-13T00:05:00.000Z',
  });
  mockLoadExecutionState.mockResolvedValue(state);

  await expect(
    getPipelineAdvisorService().runForExistingExecution({
      executionId: state.id,
      runtime: createRuntime(),
      getWindow: () => null,
    }),
  ).resolves.toMatchObject({
    executionId: state.id,
    status: 'starting',
  });
  await waitForSdkCalls(1);
  const latestSdkInput = getLastSdkTurnInput();
  expect(latestSdkInput?.model).toBe('gpt-5.5');
  expect(latestSdkInput?.userPrompt).toContain('The pipeline has finished.');
});

it('includes the execution data directory in the first advisor prompt', async () => {
  const { handle } = createHandle(createState());
  getPipelineAdvisorService().watchExecution({
    handle,
    runtime: createRuntime(),
    getWindow: () => null,
  });
  await flushPromises();
  await waitForAdvisorTimer();
  await jest.advanceTimersByTimeAsync(5_000);
  await waitForSdkCalls(1);

  expect(mockRunPipelineAdvisorSdkTurn.mock.calls[0][0].userPrompt).toContain(
    `Pipeline execution data directory: ${tempDir}/execution-1`,
  );
});

it('records the execution model config service tier on Codex advisor audit entries', async () => {
  const { handle } = createHandle(
    createState({
      version: 5,
      model_config: { fastMode: true },
    }),
  );
  getPipelineAdvisorService().watchExecution({
    handle,
    runtime: createRuntime(),
    getWindow: () => null,
  });
  await flushPromises();
  await waitForAdvisorTimer();
  await jest.advanceTimersByTimeAsync(5_000);
  await waitForSdkCalls(1);

  expect(mockStartObservedTask).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({
      provider: 'codex',
      serviceTier: 'priority',
    }),
  );
  expect(getLastSdkTurnInput()).toEqual(
    expect.objectContaining({
      modelConfig: { fastMode: true },
    }),
  );
});

it('adds a heuristic ETA when the advisor returns unknown for a running pipeline with timing evidence', async () => {
  jest.setSystemTime(new Date('2026-05-13T00:05:00.000Z'));
  mockRunPipelineAdvisorSdkTurn.mockResolvedValueOnce({
    report: {
      ...createSdkReport(),
      eta: {
        status: 'unknown',
        expectedCompletionAt: null,
        remainingSeconds: null,
        confidence: 'low',
        rationale: 'Cannot infer the remaining runtime.',
      },
    },
    rawText: '{}',
    sdkSessionId: 'thread-1',
    usage: {},
  });
  const agentStep = {
    id: 'review',
    uses: 'builtin/agent-prompt',
    shell: 'bash',
    continue_on_error: false,
    timeout_minutes: 360,
    skip_on_missing_action: false,
  } as const;
  const scriptStep = {
    id: 'summarize',
    run: 'echo done',
    shell: 'bash',
    continue_on_error: false,
    timeout_minutes: 360,
    skip_on_missing_action: false,
  } as const;
  const state = createState({
    pipeline_snapshot: {
      name: 'Pipeline 1',
      scope: ['directory'],
      jobs: {
        completed_review: {
          name: 'Completed review',
          needs: [],
          timeout_minutes: 360,
          max_retries: 0,
          continue_on_error: false,
          steps: [agentStep],
        },
        running_review: {
          name: 'Running review',
          needs: [],
          timeout_minutes: 360,
          max_retries: 0,
          continue_on_error: false,
          steps: [agentStep],
        },
        summarize: {
          name: 'Summarize',
          needs: ['completed_review', 'running_review'],
          timeout_minutes: 360,
          max_retries: 0,
          continue_on_error: false,
          steps: [scriptStep],
        },
      },
    },
    jobs: {
      completed_review: {
        status: 'success',
        steps: {
          review: {
            status: 'success',
            outputs: {},
            dynamic_env: {},
            started_at: '2026-05-13T00:00:00.000Z',
            completed_at: '2026-05-13T00:03:00.000Z',
          },
        },
        outputs: {},
        started_at: '2026-05-13T00:00:00.000Z',
        completed_at: '2026-05-13T00:03:00.000Z',
      },
      running_review: {
        status: 'running',
        steps: {
          review: {
            status: 'running',
            outputs: {},
            dynamic_env: {},
            started_at: '2026-05-13T00:03:30.000Z',
          },
        },
        outputs: {},
        started_at: '2026-05-13T00:03:30.000Z',
      },
      summarize: {
        status: 'pending',
        steps: {
          summarize: {
            status: 'pending',
            outputs: {},
            dynamic_env: {},
          },
        },
        outputs: {},
      },
    },
  });
  const { handle } = createHandle(state);

  getPipelineAdvisorService().watchExecution({
    handle,
    runtime: createRuntime(),
    getWindow: () => null,
  });
  await flushPromises();
  await waitForAdvisorTimer();
  await jest.advanceTimersByTimeAsync(5_000);
  await waitForSdkCalls(1);
  await flushPromises();

  const snapshot = mockAdvisorSnapshots.get('execution-1') as
    | {
        latestReport?: {
          eta?: {
            status?: string;
            remainingSeconds?: number;
            confidence?: string;
            rationale?: string;
          };
        };
      }
    | undefined;
  expect(snapshot?.latestReport?.eta?.status).toBe('available');
  expect(snapshot?.latestReport?.eta?.remainingSeconds).toBeGreaterThan(0);
  expect(snapshot?.latestReport?.eta?.confidence).toBe('medium');
  expect(snapshot?.latestReport?.eta?.rationale).toContain(
    'Heuristic estimate',
  );
});

it('uses the required backoff sequence and resumes the prior sdk session', async () => {
  const { handle } = createHandle(createState());
  getPipelineAdvisorService().watchExecution({
    handle,
    runtime: createRuntime(),
    getWindow: () => null,
  });
  await flushPromises();
  await waitForAdvisorTimer();
  await jest.advanceTimersByTimeAsync(5_000);
  await waitForSdkCalls(1);
  await flushPromises();

  const delays: number[] = [120_000, 300_000, 600_000, 900_000, 900_000];
  for (let index = 0; index < delays.length; index += 1) {
    const delay = delays[index] ?? 0;
    await jest.advanceTimersByTimeAsync(delay);
    await waitForSdkCalls(index + 2);
    await flushPromises();
  }

  expect(mockRunPipelineAdvisorSdkTurn).toHaveBeenCalledTimes(6);
  expect(mockRunPipelineAdvisorSdkTurn.mock.calls[1][0]).toEqual(
    expect.objectContaining({ sdkSessionId: 'thread-1' }),
  );
  const snapshot = mockAdvisorSnapshots.get('execution-1');
  expect(snapshot?.backoffIndex).toBe(6);
});

it('starts a new sdk session when a restored snapshot resolves to a different harness', async () => {
  mockAdvisorSnapshots.set('execution-1', {
    version: 1,
    executionId: 'execution-1',
    executionDataDir: `${tempDir}/execution-1`,
    stateFilePath: `${tempDir}/execution-1.json`,
    provider: 'claude',
    model: 'gpt-5.5',
    thinkingLevel: 'high',
    sdkSessionId: 'claude-session',
    status: 'waiting',
    turnCount: 1,
    backoffIndex: 1,
    lastUpdatedAt: '2026-05-12T23:59:00.000Z',
    reports: [],
  });
  mockRunPipelineAdvisorSdkTurn.mockResolvedValueOnce({
    report: createSdkReport(),
    rawText: JSON.stringify(createSdkReport()),
    sdkSessionId: 'codex-session',
    usage: {},
  });
  const { handle } = createHandle(createState());

  getPipelineAdvisorService().watchExecution({
    handle,
    runtime: createRuntime(),
    getWindow: () => null,
  });
  await flushPromises();
  await waitForAdvisorTimer();
  await jest.advanceTimersByTimeAsync(5_000);
  await waitForSdkCalls(1);
  await flushPromises();

  expect(getLastSdkTurnInput()).toEqual(
    expect.objectContaining({
      provider: 'codex',
      sdkSessionId: undefined,
    }),
  );
  expect(mockSeedTranscript).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({
      provider: 'codex',
      injectedPrompts: [
        expect.objectContaining({
          provider: 'codex',
        }),
      ],
    }),
  );
  expect(mockAdvisorSnapshots.get('execution-1')).toMatchObject({
    provider: 'codex',
    sdkSessionId: 'codex-session',
  });
  expect(mockUpdateObservedTask).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({
      executionHarness: 'codex',
      serviceTier: 'default',
    }),
  );
});

it('runs a final turn when the pipeline completes before the initial timer', async () => {
  const runningState = createState();
  const { handle, resolveCompletion } = createHandle(runningState);
  getPipelineAdvisorService().watchExecution({
    handle,
    runtime: createRuntime(),
    getWindow: () => null,
  });
  await flushPromises();
  await waitForAdvisorTimer();

  resolveCompletion(
    createState({
      status: 'success',
      completed_at: '2026-05-13T00:00:00.500Z',
    }),
  );
  await waitForSdkCalls(1);
  await flushPromises();

  expect(getLastSdkTurnInput()?.userPrompt).toContain(
    'The pipeline has finished.',
  );
  await jest.advanceTimersByTimeAsync(5_000);
  expect(mockRunPipelineAdvisorSdkTurn).toHaveBeenCalledTimes(1);
});

it('persists non-final advisor failures without marking the snapshot failed', async () => {
  mockRunPipelineAdvisorSdkTurn.mockRejectedValueOnce(new Error('SDK failed'));
  const { handle } = createHandle(createState());

  getPipelineAdvisorService().watchExecution({
    handle,
    runtime: createRuntime(),
    getWindow: () => null,
  });
  await flushPromises();
  await waitForAdvisorTimer();
  await jest.advanceTimersByTimeAsync(5_000);
  await waitForSdkCalls(1);
  await flushPromises();

  const snapshot = mockAdvisorSnapshots.get('execution-1') as
    | {
        status?: string;
        lastError?: { message?: string };
        nextUpdateAt?: string;
      }
    | undefined;
  expect(snapshot?.status).toBe('waiting');
  expect(snapshot?.lastError?.message).toBe('SDK failed');
  expect(snapshot?.nextUpdateAt).toBeDefined();
  expect(mockFinalizeObservedTask).toHaveBeenCalledWith(
    expect.any(String),
    'failure',
    'SDK failed',
    {},
  );
});

it('removes empty string array entries from normalized reports before storage', async () => {
  mockRunPipelineAdvisorSdkTurn.mockResolvedValueOnce({
    report: {
      ...createSdkReport(),
      health: {
        status: 'healthy',
        score: 89,
        summary: 'Healthy',
        evidence: ['', 'step completed', ''],
        blockers: ['', 'waiting on job'],
      },
      recommendations: ['', 'Keep monitoring'],
    },
    rawText: '{}',
    sdkSessionId: 'thread-1',
    usage: {},
  });
  const { handle } = createHandle(createState());
  getPipelineAdvisorService().watchExecution({
    handle,
    runtime: createRuntime(),
    getWindow: () => null,
  });
  await flushPromises();
  await waitForAdvisorTimer();
  await jest.advanceTimersByTimeAsync(5_000);
  await waitForSdkCalls(1);
  await flushPromises();

  const snapshot = mockAdvisorSnapshots.get('execution-1') as
    | {
        latestReport?: {
          health: { evidence: string[]; blockers: string[] };
          recommendations: string[];
        };
      }
    | undefined;
  expect(snapshot?.latestReport?.health.evidence).toEqual(['step completed']);
  expect(snapshot?.latestReport?.health.blockers).toEqual(['waiting on job']);
  expect(snapshot?.latestReport?.recommendations).toEqual(['Keep monitoring']);
});

it('does not duplicate a final report for the same completed_at', async () => {
  const completedAt = '2026-05-13T00:02:00.000Z';
  const finalReport: PipelineAdvisorReport = {
    ...createFinalReport(),
    version: 1,
    reportId: 'final-report',
    executionId: 'execution-1',
    kind: 'final',
    generatedAt: completedAt,
    pipelineStatus: 'success',
  };
  mockAdvisorSnapshots.set('execution-1', {
    version: 1,
    executionId: 'execution-1',
    executionDataDir: `${tempDir}/execution-1`,
    stateFilePath: `${tempDir}/execution-1.json`,
    provider: 'codex',
    model: 'gpt-5.5',
    thinkingLevel: 'high',
    sdkSessionId: 'thread-1',
    status: 'completed',
    turnCount: 1,
    backoffIndex: 0,
    lastUpdatedAt: completedAt,
    finalizedCompletedAt: completedAt,
    reports: [finalReport],
    latestReport: finalReport,
  });
  const { handle } = createHandle(
    createState({ status: 'success', completed_at: completedAt }),
  );

  getPipelineAdvisorService().watchExecution({
    handle,
    runtime: createRuntime(),
    getWindow: () => null,
  });
  await flushPromises();
  await waitForAdvisorTimer();
  await jest.advanceTimersByTimeAsync(5_000);
  await flushPromises();

  expect(mockRunPipelineAdvisorSdkTurn).not.toHaveBeenCalled();
  const snapshot = mockAdvisorSnapshots.get('execution-1') as
    | { reports: unknown[] }
    | undefined;
  expect(snapshot?.reports).toHaveLength(1);
});

it('does not mutate a finalized snapshot when its model later becomes blocked', async () => {
  const completedAt = '2026-05-13T00:02:00.000Z';
  const finalReport: PipelineAdvisorReport = {
    version: 1,
    reportId: 'final-report',
    executionId: 'execution-1',
    kind: 'final',
    generatedAt: completedAt,
    pipelineStatus: 'success',
    health: {
      status: 'healthy',
      score: 100,
      summary: 'Pipeline completed successfully.',
      evidence: ['all jobs passed'],
      blockers: [],
    },
    eta: {
      status: 'complete',
      confidence: 'high',
      rationale: 'Pipeline finished.',
    },
    inefficiencies: [],
    summary: 'Pipeline finished.',
    recommendations: [],
  };
  const finalizedSnapshot: PipelineAdvisorSnapshot = {
    version: 1,
    executionId: 'execution-1',
    executionDataDir: `${tempDir}/execution-1`,
    stateFilePath: `${tempDir}/execution-1.json`,
    provider: 'codex',
    model: 'gpt-5.5',
    thinkingLevel: 'high',
    sdkSessionId: 'thread-1',
    status: 'completed',
    turnCount: 1,
    backoffIndex: 0,
    lastUpdatedAt: completedAt,
    finalizedCompletedAt: completedAt,
    reports: [finalReport],
    latestReport: finalReport,
  };
  mockAdvisorSnapshots.set('execution-1', finalizedSnapshot);
  mockIsModelBlockedByStoredPolicy.mockResolvedValue(true);
  const { handle } = createHandle(
    createState({ status: 'success', completed_at: completedAt }),
  );

  getPipelineAdvisorService().watchExecution({
    handle,
    runtime: createRuntime(),
    getWindow: () => null,
  });
  await flushPromises();
  await waitForAdvisorTimer();
  await jest.advanceTimersByTimeAsync(5_000);
  await flushPromises();

  expect(mockRunPipelineAdvisorSdkTurn).not.toHaveBeenCalled();
  expect(mockAdvisorSnapshots.get('execution-1')).toMatchObject({
    status: 'completed',
    turnCount: 1,
    finalizedCompletedAt: completedAt,
  });
  expect(mockAdvisorSnapshots.get('execution-1')).not.toHaveProperty(
    'lastError',
  );
});

it('reactivates retry snapshots and resumes the existing sdk session', async () => {
  const finalReport: PipelineAdvisorReport = {
    ...createFinalReport(),
    version: 1,
    reportId: 'final-report',
    executionId: 'execution-1',
    kind: 'final',
    generatedAt: '2026-05-13T00:02:00.000Z',
    pipelineStatus: 'failure',
  };
  mockAdvisorSnapshots.set('execution-1', {
    version: 1,
    executionId: 'execution-1',
    executionDataDir: `${tempDir}/execution-1`,
    stateFilePath: `${tempDir}/execution-1.json`,
    provider: 'codex',
    model: 'gpt-5.5',
    thinkingLevel: 'high',
    sdkSessionId: 'thread-retry',
    status: 'completed',
    turnCount: 1,
    backoffIndex: 3,
    lastUpdatedAt: '2026-05-13T00:02:00.000Z',
    finalizedCompletedAt: '2026-05-13T00:02:00.000Z',
    reports: [finalReport],
    latestReport: finalReport,
  });
  const { handle } = createHandle(createState());

  getPipelineAdvisorService().watchExecution({
    handle,
    runtime: createRuntime(),
    getWindow: () => null,
  });
  await flushPromises();
  await waitForAdvisorTimer();

  let snapshot = mockAdvisorSnapshots.get('execution-1') as
    | {
        sdkSessionId?: string;
        status?: string;
        turnCount?: number;
        backoffIndex?: number;
        reports?: { kind: string }[];
        latestReport?: PipelineAdvisorReport;
        finalizedCompletedAt?: string;
        lastError?: unknown;
      }
    | undefined;
  expect(snapshot).toMatchObject({
    status: 'starting',
    turnCount: 1,
    backoffIndex: 0,
  });
  expect(snapshot?.reports?.map((report) => report.kind)).toEqual(['final']);
  expect(snapshot?.latestReport?.kind).toBe('final');
  expect(snapshot?.finalizedCompletedAt).toBeUndefined();
  expect(snapshot?.lastError).toBeUndefined();

  await jest.advanceTimersByTimeAsync(5_000);
  await waitForSdkCalls(1);

  expect(mockRunPipelineAdvisorSdkTurn).toHaveBeenCalledWith(
    expect.objectContaining({ sdkSessionId: 'thread-retry' }),
  );
  snapshot = mockAdvisorSnapshots.get('execution-1');
  expect(snapshot?.sdkSessionId).toBe('thread-retry');
  expect(snapshot?.finalizedCompletedAt).toBeUndefined();
  expect(snapshot?.lastError).toBeUndefined();
  expect(snapshot?.reports?.map((report) => report.kind)).toEqual([
    'final',
    'initial',
  ]);
});

it('watches an immediate retry while the previous final advisor turn is still pending', async () => {
  const pendingFinal = createDeferred<PipelineAdvisorSdkTurnResult>();
  mockRunPipelineAdvisorSdkTurn
    .mockResolvedValueOnce({
      report: createSdkReport(),
      rawText: JSON.stringify(createSdkReport()),
      sdkSessionId: 'thread-1',
      usage: { inputTokens: 10, outputTokens: 5, messageCount: 1 },
    })
    .mockReturnValueOnce(pendingFinal.promise)
    .mockResolvedValueOnce({
      report: createSdkReport(),
      rawText: JSON.stringify(createSdkReport()),
      sdkSessionId: 'thread-1',
      usage: { inputTokens: 12, outputTokens: 6, messageCount: 1 },
    });
  const first = createHandle(createState());
  const runtime = createRuntime();

  getPipelineAdvisorService().watchExecution({
    handle: first.handle,
    runtime,
    getWindow: () => null,
  });
  await flushPromises();
  await waitForAdvisorTimer();
  await jest.advanceTimersByTimeAsync(5_000);
  await waitForSdkCalls(1);
  await flushPromises();

  first.resolveCompletion(
    createState({
      status: 'success',
      completed_at: '2026-05-13T00:01:00.000Z',
    }),
  );
  await waitForSdkCalls(2);

  const retry = createHandle(createState());
  getPipelineAdvisorService().watchExecution({
    handle: retry.handle,
    runtime,
    getWindow: () => null,
  });
  await flushPromises();
  await waitForAdvisorTimer();
  await jest.advanceTimersByTimeAsync(5_000);
  await waitForSdkCalls(3);

  const retrySdkInput = getSdkTurnInput(2);
  expect(retrySdkInput?.sdkSessionId).toBe('thread-1');
  expect(retrySdkInput?.userPrompt).toContain(
    'Current pipeline status: running',
  );
  expect(mockFinalizeObservedTask).toHaveBeenCalledWith(
    expect.any(String),
    'interrupted',
    'Workflow Advisor interrupted by retry',
  );

  pendingFinal.resolve({
    report: createFinalReport(),
    rawText: JSON.stringify(createFinalReport()),
    sdkSessionId: 'thread-1',
    usage: {},
  });
  await flushPromises();
});

it('does not dispatch an advisor turn after interruption during invocation resolution', async () => {
  const pendingInvocation = createDeferred<{
    providerType: 'codex';
    source: 'codex-managed';
    harness: 'codex';
    sdkModel: 'gpt-5.5';
    aiCreditsRouted: false;
    dispose: () => void;
  }>();
  mockResolveHelperInvocation.mockReturnValueOnce(pendingInvocation.promise);
  const first = createHandle(
    createState({
      status: 'success',
      completed_at: '2026-05-13T00:01:00.000Z',
    }),
  );
  const runtime = createRuntime();

  getPipelineAdvisorService().watchExecution({
    handle: first.handle,
    runtime,
    getWindow: () => null,
  });
  await flushPromises();
  await waitForAdvisorTimer();
  await jest.advanceTimersByTimeAsync(5_000);
  await flushPromises();
  expect(mockResolveHelperInvocation).toHaveBeenCalledTimes(1);

  const retry = createHandle(createState());
  getPipelineAdvisorService().watchExecution({
    handle: retry.handle,
    runtime,
    getWindow: () => null,
  });
  pendingInvocation.resolve({
    providerType: 'codex',
    source: 'codex-managed',
    harness: 'codex',
    sdkModel: 'gpt-5.5',
    aiCreditsRouted: false,
    dispose: () => undefined,
  });
  await flushPromises();

  expect(mockRunPipelineAdvisorSdkTurn).not.toHaveBeenCalled();
  expect(mockFinalizeObservedTask).toHaveBeenCalledWith(
    expect.any(String),
    'interrupted',
    'Workflow Advisor interrupted by retry',
  );
});

it('forwards retained quota recovery and aborts advisor work on shutdown', async () => {
  const waitForQuotaRecovery = jest.fn(() => Promise.resolve());
  mockResolveHelperInvocation.mockResolvedValueOnce({
    providerType: 'codex',
    source: 'codex-managed',
    harness: 'codex',
    sdkModel: 'gpt-5.5',
    aiCreditsRouted: false,
    dispose: () => undefined,
    waitForQuotaRecovery,
  });
  const pending = createDeferred<PipelineAdvisorSdkTurnResult>();
  mockRunPipelineAdvisorSdkTurn.mockReturnValueOnce(pending.promise);
  const { handle } = createHandle(createState());
  getPipelineAdvisorService().watchExecution({
    handle,
    runtime: createRuntime(),
    getWindow: () => null,
  });
  await flushPromises();
  await waitForAdvisorTimer();
  await jest.advanceTimersByTimeAsync(5_000);
  await waitForSdkCalls(1);
  try {
    expect(getSdkTurnInput(0)?.waitForQuotaRecovery).toBe(waitForQuotaRecovery);
    const controller = getSdkTurnInput(0)?.abortController;
    getPipelineAdvisorService().shutdown();
    expect(controller?.signal.aborted).toBe(true);
  } finally {
    pending.resolve({
      report: createSdkReport(),
      rawText: '',
      sdkSessionId: 'thread-1',
      usage: {},
    });
    await flushPromises();
  }
});

it('retains failed advisor usage when a quota wait ends without recovery', async () => {
  mockRunPipelineAdvisorSdkTurn.mockRejectedValueOnce(
    Object.assign(new Error('Quota wait stopped'), {
      usage: { inputTokens: 7 },
    }),
  );
  const { handle } = createHandle(createState());
  getPipelineAdvisorService().watchExecution({
    handle,
    runtime: createRuntime(),
    getWindow: () => null,
  });
  await flushPromises();
  await waitForAdvisorTimer();
  await jest.advanceTimersByTimeAsync(5_000);
  await waitForSdkCalls(1);
  await flushPromises();
  expect(mockFinalizeObservedTask).toHaveBeenCalledWith(
    expect.any(String),
    'failure',
    'Quota wait stopped',
    { inputTokens: 7 },
  );
});
