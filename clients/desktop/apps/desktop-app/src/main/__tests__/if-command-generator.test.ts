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
jest.mock('electron', () => ({
  app: { getPath: (): string => process.cwd() },
}));
jest.mock('../lib/preferences-store', () => ({
  readLocalMemoryEnabledPreference: jest.fn(() => Promise.resolve(false)),
}));
jest.mock('../ollama/helper-invocation', () => ({
  resolveHelperInvocation: jest.fn(() =>
    Promise.resolve({
      harness: 'claude',
      providerType: 'claude',
      sdkModel: 'haiku',
      aiCreditsRouted: false,
      dispose: jest.fn(),
    }),
  ),
}));
jest.mock('../lib/helper-observed-task', () => ({
  startObservedHelperTask: jest.fn(),
  finalizeObservedHelperTask: jest.fn(),
  markObservedHelperTaskAiCreditsRouted: jest.fn(),
}));
jest.mock('../observability', () => ({
  getObservabilityService: jest.fn(() => ({
    seedTranscript: jest.fn(),
    appendTranscriptRecord: jest.fn(),
    updateObservedTask: jest.fn(),
  })),
}));
const mockStructured = jest.fn();
jest.mock('@canopy/desktop-shared/lib/structured-helper-query', () => ({
  runClaudeStructuredHelperQuery: (...args: unknown[]): unknown =>
    mockStructured(...args),
}));
jest.mock('../integration/structured-helper-dispatch', () => ({
  runDesktopClaudeStructuredHelperQuery: (...args: unknown[]): unknown =>
    mockStructured(...args),
  codexStructuredHelperRunner: {},
}));
const helpers = jest.requireMock<
  ReturnType<typeof InlineHelperRuns.inlineHelperRunsModule>
>('../helper-runs/helper-runs');
beforeEach(() => {
  initClaudeModels([{ id: 'haiku', label: 'Haiku' }]);
  helpers.runs.length = 0;
  mockStructured.mockResolvedValue({ value: null, usage: { inputTokens: 3 } });
});
import { generateAutomationIfCommand } from '../automations/if-command-generator';
it('generates through one automation_if_command_generation helper run', async () => {
  mockStructured.mockResolvedValue({
    value: { command: 'exit 0' },
    usage: { inputTokens: 3 },
  });
  expect(
    await generateAutomationIfCommand({
      description: 'Every morning',
      model: 'haiku',
      thinkingLevel: 'off',
    }),
  ).toEqual({ command: 'exit 0' });
  expect(helpers.runs).toHaveLength(1);
  expect(helpers.runs[0]).toMatchObject({
    kind: 'automation_if_command_generation',
    model: 'haiku',
    origin: 'client',
    scope: {},
  });
});
