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
import {
  generateChatSummary,
  generateArchiveSummary,
  generateHandoffSummary,
} from '../agents/utils';
it('a policy-blocked summary never starts a helper run', async () => {
  mockBlocked.mockResolvedValue(true);
  await generateChatSummary('Conversation', {
    model: 'haiku',
    workspaceId: 'workspace',
  });
  await generateArchiveSummary('Conversation', { workspaceId: 'workspace' });
  await expect(
    generateHandoffSummary('Conversation', {
      model: 'haiku',
      workspaceId: 'workspace',
    }),
  ).rejects.toThrow('blocked');
  expect(helpers.runs).toHaveLength(0);
  expect(mockWorker).not.toHaveBeenCalled();
  mockBlocked.mockResolvedValue(false);
  await generateChatSummary('Conversation', {
    model: 'haiku',
    cwd: process.env.TMPDIR,
    workspaceId: 'workspace',
  });
  expect(helpers.runs).toHaveLength(1);
});
it('generates a chat summary through one chat_summary helper run', async () => {
  const result = await generateChatSummary('Conversation', {
    model: 'haiku',
    cwd: process.env.TMPDIR,
    workspaceId: 'workspace',
  });
  expect(result).toEqual({
    text: 'Summary from worker',
    usage: { inputTokens: 3, outputTokens: 2 },
  });
  expect(helpers.runs).toHaveLength(1);
  expect(helpers.runs[0]).toMatchObject({
    kind: 'chat_summary',
    model: 'haiku',
    origin: 'system',
    scope: { workspaceId: 'workspace' },
  });
});
