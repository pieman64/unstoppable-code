import type * as InlineHelperRuns from './helpers/inline-helper-runs';
import { initClaudeModels } from '@canopy/desktop-shared/types';
jest.mock('../canopy-runtime/desktop-runtime', () => ({
  getActiveDesktopRuntimeIfAccepting: jest.fn(),
}));
jest.mock('../helper-runs/helper-runs', () => {
  const { inlineHelperRunsModule } = jest.requireActual<
    typeof InlineHelperRuns
  >('./helpers/inline-helper-runs');
  return inlineHelperRunsModule();
});
const mockBlocked = jest.fn<Promise<boolean>, []>();
jest.mock('../lib/model-policy-state', () => ({
  isModelBlockedByStoredPolicy: (): Promise<boolean> => mockBlocked(),
}));
jest.mock('../lib/preferences-store', () => ({
  readPreferencesFile: jest.fn(() =>
    Promise.resolve({ canopyBackgroundProcessesMode: 'terminal' }),
  ),
  readLocalMemoryEnabledPreference: jest.fn(() => Promise.resolve(false)),
}));
jest.mock('../lib/claude-tui-workers', () => ({
  getEffectiveClaudeWorkerModePreferences: jest.fn(() => ({
    canopyBackgroundProcessesMode: 'terminal',
  })),
}));
jest.mock('../ollama/helper-invocation', () => ({
  resolveHelperWorkOwner: jest.fn(() => Promise.resolve({ kind: 'personal' })),
  resolveHelperInvocation: jest.fn(() =>
    Promise.resolve({
      harness: 'claude',
      source: 'claude',
      providerType: 'claude',
      sdkModel: 'haiku',
      aiCreditsRouted: false,
      dispose: jest.fn(),
    }),
  ),
}));
jest.mock('../lib/model-gateway-state', () => ({
  checkModelGatewayRoute: jest.fn(() => Promise.resolve({ ok: true })),
}));
jest.mock('../observability', () => ({ getObservabilityService: jest.fn() }));
jest.mock('../lib/helper-observed-task', () => ({
  markObservedHelperTaskAiCreditsRouted: jest.fn(),
}));
const mockWorker = jest.fn(() =>
  Promise.resolve({
    status: 'success',
    finalText: 'Summary from worker',
    usage: { inputTokens: 3, outputTokens: 2 },
  }),
);
jest.mock('../integration/claude-worker-session-service', () => ({
  getClaudeWorkerSessionService: jest.fn(() => ({ runWorker: mockWorker })),
}));
const helpers = jest.requireMock<
  ReturnType<typeof InlineHelperRuns.inlineHelperRunsModule>
>('../helper-runs/helper-runs');
beforeEach(() => {
  initClaudeModels([{ id: 'haiku', label: 'Haiku' }]);
  helpers.runs.length = 0;
  mockBlocked.mockResolvedValue(false);
  mockWorker.mockClear();
});
jest.mock('../agents/work-owner', () => ({
  resolveInvocationWorkOwner: jest.fn(() => Promise.resolve(null)),
}));
const mockStructured = jest.fn();
jest.mock('../integration/structured-helper-dispatch', () => ({
  runStructuredHelper: (...args: unknown[]): unknown => mockStructured(...args),
  structuredHelperReadOnlyPermission: jest.fn(),
}));
import { generateWorktreeSummary } from '../lib/worktree-summary-generator';
it('runs each summary attempt as a worktree_summary helper run', async () => {
  mockStructured
    .mockResolvedValueOnce({ value: null, usage: { inputTokens: 2 } })
    .mockResolvedValueOnce({
      value: {
        title: 'Feature',
        description: 'Feature work',
        highlights: ['Changed code'],
      },
      usage: { inputTokens: 3 },
    });
  const result = await generateWorktreeSummary({
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
    userInitiated: true,
  });
  expect(result.summary?.title).toBe('Feature');
  expect(result.usage.inputTokens).toBe(5);
  expect(helpers.runs).toHaveLength(2);
  for (const run of helpers.runs)
    expect(run).toMatchObject({
      kind: 'worktree_summary',
      model: 'haiku',
      origin: 'client',
      scope: { workspaceId: 'workspace' },
    });
});
