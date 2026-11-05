import type * as HelperRuns from '../helper-runs/helper-runs';
import type * as InlineHelperRuns from './helpers/inline-helper-runs';
import { initClaudeModels } from '@canopy/desktop-shared/types';
const mockRuntime = jest.fn<unknown, []>();
const mockDispose = jest.fn();
jest.mock('../canopy-runtime/desktop-runtime', () => ({
  getActiveDesktopRuntimeIfAccepting: (): unknown => mockRuntime(),
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
      dispose: mockDispose,
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
  mockDispose.mockClear();
  mockRuntime.mockReturnValue(null);
});
import { generateHandoffSummary } from '../agents/utils';
it('generates the handoff summary through one chat_handoff_summary helper run', async () => {
  const result = await generateHandoffSummary('Conversation', {
    model: 'haiku',
    workspaceId: 'workspace',
  });
  expect(result).toEqual({
    text: 'Summary from worker',
    usage: { inputTokens: 3, outputTokens: 2 },
  });
  expect(helpers.runs).toHaveLength(1);
  expect(helpers.runs[0]).toMatchObject({
    kind: 'chat_handoff_summary',
    model: 'haiku',
    origin: 'client',
    scope: { workspaceId: 'workspace' },
  });
});

it.each(['unavailable', 'refused dispatch'])(
  'disposes the handoff invocation when the worker is %s before launch',
  async (failure) => {
    const actual = jest.requireActual<typeof HelperRuns>(
      '../helper-runs/helper-runs',
    );
    if (failure === 'refused dispatch')
      mockRuntime.mockReturnValue({
        helperRuns: {
          run: jest.fn(() => Promise.reject(new Error('Dispatch refused'))),
        },
      });
    const run = jest
      .spyOn(helpers, 'runHelperThroughWorker')
      .mockImplementation(actual.runHelperThroughWorker);
    try {
      await expect(
        generateHandoffSummary('Conversation', {
          model: 'haiku',
          workspaceId: 'workspace',
        }),
      ).rejects.toBeInstanceOf(actual.HelperWorkerUnavailableError);
      expect(mockWorker).not.toHaveBeenCalled();
      expect(mockDispose).toHaveBeenCalledTimes(1);
    } finally {
      run.mockRestore();
    }
  },
);
