import type {
  AgentAuditEntry,
  AgentAuditStatus,
} from '@canopy/desktop-shared/types';
import type { ExecutionState } from '@canopy/desktop-shared/node/pipelines/executor';
import type {
  PipelineAdvisorReport,
  PipelineAdvisorSnapshot,
} from '@canopy/desktop-shared/types/pipeline';
import type {
  PipelineAdvisorSdkTurnInput,
  PipelineAdvisorSdkTurnResult,
} from '../pipeline-advisor-sdk';

const mockReadPreferencesFile = jest.fn<Promise<unknown>, []>();
const mockLoadExecutionState = jest.fn<
  Promise<ExecutionState | null>,
  [string, string]
>();
const mockAdvisorSnapshots = new Map<string, PipelineAdvisorSnapshot>();
const mockRunPipelineAdvisorSdkTurn = jest.fn<
  Promise<PipelineAdvisorSdkTurnResult>,
  [PipelineAdvisorSdkTurnInput]
>();
const mockIsModelBlockedByStoredPolicy = jest.fn<
  Promise<boolean>,
  [string, unknown]
>();
const mockResolveHelperInvocation = jest.fn<
  Promise<{
    providerType: 'codex';
    source: 'codex-managed';
    harness: 'codex';
    sdkModel: string;
    aiCreditsRouted: boolean;
  }>,
  [string, ...unknown[]]
>();
const mockStartObservedTask = jest.fn<void, [string, AgentAuditEntry]>();
const mockSeedTranscript = jest.fn<void, [string, unknown]>();
const mockAppendTranscriptRecord = jest.fn<void, [string, unknown]>();
const mockUpdateObservedTask = jest.fn<
  void,
  [string, Record<string, unknown>]
>();
const mockFinalizeObservedTask = jest.fn<
  void,
  [string, AgentAuditStatus, string?]
>();

jest.mock('../../lib/window-send', () => ({ sendToWindow: jest.fn() }));
jest.mock('../../lib/preferences-store', () => ({
  readPreferencesFile: (): Promise<unknown> => mockReadPreferencesFile(),
}));
jest.mock('@canopy/desktop-shared/node/pipelines/executor', () => ({
  loadExecutionState: (
    executionId: string,
    executionsDir: string,
  ): Promise<ExecutionState | null> =>
    mockLoadExecutionState(executionId, executionsDir),
}));
jest.mock('../pipeline-advisor-store', () => ({
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
jest.mock('../../lib/model-policy-state', () => ({
  isModelBlockedByStoredPolicy: (
    model: string,
    workOwner: unknown,
  ): Promise<boolean> => mockIsModelBlockedByStoredPolicy(model, workOwner),
}));
jest.mock('../../ollama/helper-invocation', () => ({
  resolveHelperInvocation: (
    model: string,
    ...args: unknown[]
  ): Promise<{
    providerType: 'codex';
    source: 'codex-managed';
    harness: 'codex';
    sdkModel: string;
    aiCreditsRouted: boolean;
  }> => mockResolveHelperInvocation(model, ...args),
  resolveHelperWorkOwner: jest.fn(() => Promise.resolve({ kind: 'personal' })),
}));
jest.mock('../pipeline-advisor-sdk', () => ({
  PIPELINE_ADVISOR_SYSTEM_PROMPT: 'advisor system prompt',
  runPipelineAdvisorSdkTurn: (
    input: PipelineAdvisorSdkTurnInput,
  ): Promise<PipelineAdvisorSdkTurnResult> =>
    mockRunPipelineAdvisorSdkTurn(input),
}));
jest.mock('../../observability', () => ({
  getObservabilityService: jest.fn(() => ({
    startObservedTask: (taskKey: string, entry: AgentAuditEntry): void =>
      mockStartObservedTask(taskKey, entry),
    seedTranscript: (taskKey: string, seed: unknown): void =>
      mockSeedTranscript(taskKey, seed),
    appendTranscriptRecord: (taskKey: string, record: unknown): void =>
      mockAppendTranscriptRecord(taskKey, record),
    updateObservedTask: (
      taskKey: string,
      patch: Record<string, unknown>,
    ): void => mockUpdateObservedTask(taskKey, patch),
    finalizeObservedTask: (
      taskKey: string,
      status: AgentAuditStatus,
      error?: string,
    ): void => mockFinalizeObservedTask(taskKey, status, error),
  })),
}));

import { initCodexModels } from '@canopy/desktop-shared/types';
import type { ExecutionRuntime } from '@canopy/desktop-shared/node/pipelines/executor';
import { getPipelineAdvisorService } from '../pipeline-advisor';

initCodexModels([{ id: 'gpt-5.6', label: 'GPT 5.6' }]);

function createState(overrides: Partial<ExecutionState> = {}): ExecutionState {
  return {
    version: 4,
    id: 'execution',
    pipeline_id: 'pipeline',
    pipeline_snapshot: { name: 'Pipeline', jobs: {} },
    status: 'running',
    jobs: {},
    started_at: '2026-10-08T12:00:00.000Z',
    cwd: '/tmp',
    env: {},
    inputs: {},
    project_id: 'project',
    ...overrides,
  };
}

function createRuntime(): ExecutionRuntime {
  return {
    isModelBlockedByOrgPolicy: () => Promise.resolve(false),
    isOrgModelPolicyActive: () => Promise.resolve(false),
    executionsDir: '/pipeline-executions',
    tempRootDir: '/tmp',
    bundledActionsDir: '/actions',
    getProjectActionsDir: () => '/actions',
    getProjectPipelinesDir: () => '/pipelines',
  };
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

async function flushPromises(): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    await Promise.resolve();
  }
}

function createReport(): PipelineAdvisorReport {
  return {
    version: 1,
    reportId: 'report',
    executionId: 'child',
    kind: 'initial',
    generatedAt: '2026-10-08T12:00:00.000Z',
    pipelineStatus: 'running',
    health: {
      status: 'healthy',
      score: 90,
      summary: 'Healthy',
      evidence: [],
      blockers: [],
    },
    eta: {
      status: 'unknown',
      confidence: 'low',
      rationale: 'Insufficient data.',
    },
    inefficiencies: [],
    summary: 'Healthy.',
    recommendations: [],
  };
}

beforeEach(() => {
  mockAdvisorSnapshots.clear();
  mockReadPreferencesFile.mockResolvedValue({
    pipelineAdvisorEnabled: true,
    pipelineAdvisorModel: 'gpt-5.6',
    pipelineAdvisorThinkingLevel: 'high',
    providerModelConfigDefaults: {},
  });
  mockIsModelBlockedByStoredPolicy.mockResolvedValue(false);
  mockResolveHelperInvocation.mockResolvedValue({
    providerType: 'codex',
    source: 'codex-managed',
    harness: 'codex',
    sdkModel: 'gpt-5.6',
    aiCreditsRouted: false,
  });
  mockStartObservedTask.mockClear();
  mockSeedTranscript.mockClear();
  mockAppendTranscriptRecord.mockClear();
  mockUpdateObservedTask.mockClear();
  mockFinalizeObservedTask.mockClear();
});

afterEach(async () => {
  getPipelineAdvisorService().shutdown('app-quit');
  await flushPromises();
  jest.clearAllMocks();
});

describe('pipeline Advisor root execution capture', () => {
  it('does not delay provider invocation on a stalled parent read', async () => {
    const child = createState({
      id: 'child',
      parent_execution_id: 'parent',
    });
    const parent = createState({
      id: 'parent',
      parent_execution_id: 'root',
    });
    const root = createState({ id: 'root' });
    const parentLoad = createDeferred<ExecutionState | null>();
    const sdkTurn = createDeferred<PipelineAdvisorSdkTurnResult>();
    mockLoadExecutionState.mockImplementation((executionId: string) => {
      if (executionId === 'parent') return parentLoad.promise;
      if (executionId === 'root') return Promise.resolve(root);
      return Promise.resolve(child);
    });
    mockRunPipelineAdvisorSdkTurn.mockReturnValue(sdkTurn.promise);

    try {
      await getPipelineAdvisorService().runForExistingExecution({
        executionId: 'child',
        runtime: createRuntime(),
        getWindow: () => null,
      });
      await flushPromises();

      expect(mockRunPipelineAdvisorSdkTurn).toHaveBeenCalledTimes(1);

      parentLoad.resolve(parent);
      await flushPromises();
      expect(mockUpdateObservedTask).toHaveBeenCalledWith(
        expect.stringContaining('pipeline-advisor:child'),
        { rootPipelineExecutionId: 'root' },
      );
    } finally {
      parentLoad.resolve(parent);
      sdkTurn.resolve({
        report: createReport(),
        rawText: 'report',
        sdkSessionId: 'advisor-session',
        usage: { inputTokens: 1, outputTokens: 1 },
      });
      await flushPromises();
      getPipelineAdvisorService().shutdown('app-quit');
    }
  });
});
