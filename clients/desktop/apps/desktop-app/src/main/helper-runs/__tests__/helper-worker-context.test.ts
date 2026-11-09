import type * as StructuredShared from '@canopy/desktop-shared/lib/structured-helper-query';
import type { HelperRunRequest } from '../helper-runs';
import type * as HelperRuns from '../helper-runs';
import type * as ClaudeModAdmissionLaunchModule from '../../agents/claude-mod-admission-launch';
import type { StructuredHelperDispatchOptions } from '../../integration/structured-helper-dispatch';
import {
  initClaudeModels,
  initCodexModels,
} from '@canopy/desktop-shared/types';
import {
  HelperOutsideWorkerError,
  runInHelperWorker,
} from '../helper-worker-context';
jest.mock('../../canopy-runtime/desktop-runtime', () => ({
  getActiveDesktopRuntimeIfAccepting: jest.fn(),
}));
const mockErrors: unknown[] = [];
jest.mock('../helper-runs', () => {
  const actual = jest.requireActual<typeof HelperRuns>('../helper-runs');
  return {
    ...actual,
    runHelperThroughWorker: async <T>(
      request: HelperRunRequest<T>,
    ): Promise<T> => {
      try {
        return await request.launch(new AbortController().signal);
      } catch (error) {
        mockErrors.push(error);
        throw error;
      }
    },
  };
});
let mockMode = 'canopy';
jest.mock('../../lib/preferences-store', () => ({
  readPreferencesFile: jest.fn(() =>
    Promise.resolve({ canopyBackgroundProcessesMode: mockMode }),
  ),
  readLocalMemoryEnabledPreference: jest.fn(() => Promise.resolve(false)),
}));
// Mod admission reads the real Claude config before a helper launch; this
// golden runs with it off, and the admission goldens cover it.
jest.mock('../../agents/claude-mod-admission-launch', () => ({
  ...jest.requireActual<typeof ClaudeModAdmissionLaunchModule>(
    '../../agents/claude-mod-admission-launch',
  ),
  resolveClaudeModAdmissionLaunch: (): Promise<undefined> =>
    Promise.resolve(undefined),
}));
jest.mock('../../lib/claude-tui-workers', () => ({
  getEffectiveClaudeWorkerModePreferences: jest.fn(() => ({
    canopyBackgroundProcessesMode: mockMode,
  })),
}));
jest.mock('../../lib/model-policy-state', () => ({
  isModelBlockedByStoredPolicy: jest.fn(() => Promise.resolve(false)),
}));
jest.mock('../../lib/model-gateway-state', () => ({
  checkModelGatewayRoute: jest.fn(() => Promise.resolve({ ok: true })),
}));
jest.mock('../../ollama/helper-invocation', () => ({
  resolveHelperWorkOwner: jest.fn(() => Promise.resolve(null)),
  resolveHelperInvocation: jest.fn((model: string) =>
    Promise.resolve({
      harness: model === 'gpt-test' ? 'codex' : 'claude',
      providerType: model === 'gpt-test' ? 'codex' : 'claude',
      sdkModel: model,
      source: model === 'gpt-test' ? 'codex' : 'claude',
      aiCreditsRouted: false,
      dispose: jest.fn(),
    }),
  ),
}));
jest.mock('../../agents/work-owner', () => ({
  resolveInvocationWorkOwner: jest.fn(() => Promise.resolve(null)),
}));
jest.mock('../../lib/helper-observed-task', () => ({
  markObservedHelperTaskAiCreditsRouted: jest.fn(),
}));
jest.mock('../../observability', () => ({
  getObservabilityService: jest.fn(() => ({
    beginClaudeQuery: jest.fn(),
    endClaudeQuery: jest.fn(),
    seedTranscript: jest.fn(),
    appendTranscriptRecord: jest.fn(),
    observeClaudeEvent: jest.fn(),
    updateObservedTask: jest.fn(),
  })),
}));
jest.mock('../../pipelines/config-paths', () => ({
  getBundledClaudeBinaryPath: jest.fn(() => '/mock/claude'),
  getBundledRgBinaryPath: jest.fn(() => '/mock/rg'),
  getEnhancedEnv: jest.fn(() => ({})),
}));
jest.mock('../../lib/user-environment-runtime', () => ({
  resolveCodexRuntimeEnvironmentProfile: jest.fn(() => ({
    environment: {},
    logicalWorkspaceEnvironmentId: null,
  })),
}));
jest.mock('../../codex/speed-policy', () => ({
  admitCodexSpeed: jest.fn(() => Promise.resolve({})),
  reportCodexSpeedTurnFailure: jest.fn(),
}));
const mockSdk = jest.fn(async function* () {
  yield await Promise.resolve({
    type: 'system',
    subtype: 'init',
    session_id: 'session',
  });
  yield {
    type: 'result',
    subtype: 'success',
    session_id: 'session',
    result: 'Summary',
    structured_output: {
      title: 'Title',
      description: 'Description',
      highlights: [],
    },
    usage: {},
  };
});
jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (): unknown => mockSdk(),
}));
const mockShared = jest.fn(() => Promise.resolve({ value: {}, usage: {} }));
jest.mock('@canopy/desktop-shared/lib/structured-helper-query', () => ({
  ...jest.requireActual<typeof StructuredShared>(
    '@canopy/desktop-shared/lib/structured-helper-query',
  ),
  runClaudeStructuredHelperQuery: (): unknown => mockShared(),
}));
const mockWorker = jest.fn(() =>
  Promise.resolve({
    status: 'success',
    finalText: 'Summary',
    usage: {},
    transcriptJsonl: '',
  }),
);
jest.mock('../../integration/claude-worker-session-service', () => ({
  getClaudeWorkerSessionService: jest.fn(() => ({ runWorker: mockWorker })),
}));
const mockStart = jest.fn(() =>
  Promise.resolve({
    threadId: 'thread',
    runTurn: jest.fn(() =>
      Promise.resolve({ status: 'completed', finalText: '{}', usage: {} }),
    ),
    delete: jest.fn(() => Promise.resolve()),
  }),
);
jest.mock('../../codex/runtime-service', () => ({
  getCodexRuntimeService: jest.fn(() => ({ startThread: mockStart })),
  codexRuntimeForWorkerRun: jest.fn(() => ({ startThread: mockStart })),
}));
import {
  runStructuredHelper,
  codexStructuredHelperRunner,
  runDesktopClaudeStructuredHelperQuery,
} from '../../integration/structured-helper-dispatch';
import { generateChatSummary } from '../../agents/utils';
import { generateWorktreeSummary } from '../../lib/worktree-summary-generator';
import { runPipelineAdvisorSdkTurn } from '../../pipelines/pipeline-advisor-sdk';
const structured: StructuredHelperDispatchOptions<Record<string, unknown>> = {
  kind: 'test',
  provider: 'claude',
  maxTurns: 1,
  localMemoryEnabled: false,
  label: 'Test',
  repoPath: '/repo',
  model: 'haiku',
  systemPrompt: 'System',
  userMessage: 'Prompt',
  schema: { type: 'object', properties: {} },
  isResult: (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null,
};
const cases = [
  {
    name: 'runStructuredHelper',
    invoke: (): Promise<unknown> => runStructuredHelper(structured),
  },
  {
    name: 'codexStructuredHelperRunner.run',
    invoke: (): Promise<unknown> =>
      codexStructuredHelperRunner.run({
        ...structured,
        combinedPrompt: 'Prompt',
      }),
  },
  {
    name: 'runDesktopClaudeStructuredHelperQuery',
    invoke: (): Promise<unknown> =>
      runDesktopClaudeStructuredHelperQuery(structured),
  },
  {
    name: 'runBackgroundTextWorker',
    invoke: (): Promise<unknown> => {
      mockMode = 'terminal';
      return generateChatSummary('Conversation', {
        model: 'haiku',
        cwd: process.env.TMPDIR,
      });
    },
  },
  {
    name: 'runObservedClaudeQuery',
    invoke: (): Promise<unknown> =>
      generateChatSummary('Conversation', {
        model: 'haiku',
        cwd: process.env.TMPDIR,
      }),
  },
  {
    name: 'runCodexHelperText',
    invoke: (): Promise<unknown> =>
      generateChatSummary('Conversation', {
        model: 'gpt-test',
        cwd: process.env.TMPDIR,
      }),
  },
  {
    name: 'runClaudeSummaryQuery',
    invoke: (): Promise<unknown> =>
      generateWorktreeSummary({
        projectId: 'workspace',
        cwd: '/repo',
        model: 'haiku',
        thinkingLevel: 'off',
        isFullRefresh: true,
        previousSummary: null,
        chatExcerpts: 'Conversation',
        gitDiff: 'diff',
        currentTurnCount: 1,
        isMultiRepo: false,
      }),
  },
  {
    name: 'runPipelineAdvisorSdkTurn',
    invoke: (): Promise<unknown> =>
      runPipelineAdvisorSdkTurn({
        provider: 'claude',
        model: 'haiku',
        thinkingLevel: 'off',
        executionDataDir: '/repo',
        systemPrompt: 'System',
        userPrompt: 'Prompt',
        schema: {},
        observabilityTaskKey: 'task',
      }),
  },
];
beforeEach(() => {
  initClaudeModels([{ id: 'haiku', label: 'Haiku' }]);
  initCodexModels([{ id: 'gpt-test', label: 'Codex' }]);
  mockMode = 'canopy';
  mockErrors.length = 0;
  for (const provider of [mockSdk, mockShared, mockWorker, mockStart])
    provider.mockClear();
});
it.each(cases)(
  'refuses each helper runner outside the local worker: $name',
  async ({ name, invoke }) => {
    let directError: unknown;
    try {
      await invoke();
    } catch (error) {
      directError = error;
    }
    const error = mockErrors[0] ?? directError;
    expect(error).toBeInstanceOf(HelperOutsideWorkerError);
    expect(error).toHaveProperty('message', expect.stringContaining(name));
    for (const provider of [mockSdk, mockShared, mockWorker, mockStart])
      expect(provider).not.toHaveBeenCalled();
    mockErrors.length = 0;
    await runInHelperWorker(
      { helperRunId: 'test', kind: 'chat_summary' },
      invoke,
    );
    expect(mockErrors).toHaveLength(0);
    expect(
      [mockSdk, mockShared, mockWorker, mockStart].some(
        (provider) => provider.mock.calls.length > 0,
      ),
    ).toBe(true);
  },
);
