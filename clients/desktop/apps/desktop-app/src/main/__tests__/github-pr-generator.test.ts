jest.mock('../canopy-runtime/desktop-runtime', () => ({
  getActiveDesktopRuntimeIfAccepting: jest.fn(),
}));
import type * as InlineHelperRuns from './helpers/inline-helper-runs';
import { initClaudeModels } from '@canopy/desktop-shared/types';
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
  readPreferencesFile: (): Promise<unknown> =>
    Promise.resolve({
      branchNamingModel: 'sonnet',
      branchNamingThinkingLevel: 'high',
      branchNamingInstructions: '',
      branchNamingPluginSelections: {},
      branchNamePrefixMode: 'none',
    }),
  readLocalMemoryEnabledPreference: (): Promise<boolean> =>
    Promise.resolve(false),
}));
jest.mock('../ollama/helper-invocation', () => ({
  resolveHelperWorkOwner: (): Promise<unknown> =>
    Promise.resolve({ kind: 'personal' }),
  resolveHelperInvocation: (): Promise<unknown> =>
    Promise.resolve({
      harness: 'claude',
      providerType: 'claude',
      sdkModel: 'sonnet',
      aiCreditsRouted: false,
      dispose: (): void => undefined,
    }),
}));
jest.mock('../lib/helper-observed-task', () => ({
  startObservedHelperTask: jest.fn(),
  finalizeObservedHelperTask: jest.fn(),
  markObservedHelperTaskAiCreditsRouted: jest.fn(),
  buildHelperPluginRunOptions: jest.fn(() => ({})),
}));
jest.mock('../lib/helper-transcript-observer', () => ({
  createHelperTranscriptObserver: jest.fn(() => ({
    seed: jest.fn(),
    appendEvent: jest.fn(),
  })),
}));
jest.mock('../observability', () => ({
  getObservabilityService: jest.fn(() => ({
    seedTranscript: jest.fn(),
    updateObservedTask: jest.fn(),
  })),
}));
const helpers = jest.requireMock<
  ReturnType<typeof InlineHelperRuns.inlineHelperRunsModule>
>('../helper-runs/helper-runs');
beforeEach(() => {
  initClaudeModels([{ id: 'sonnet', label: 'Sonnet' }]);
  helpers.runs.length = 0;
  mockBlocked.mockResolvedValue(false);
});
jest.mock('../integration/structured-helper-dispatch', () => ({
  createStructuredHelperRunner: jest.fn(),
  codexStructuredHelperRunner: {},
  structuredHelperReadOnlyPermission: jest.fn(),
}));
jest.mock('../agents/ai-credits-quota-state', () => ({
  markProviderQuotaReached: jest.fn(),
}));
jest.mock('../lib/commit-generation-model-candidates', () => ({
  isDemotedForQuota: jest.fn(() => false),
}));
const mockCommit = jest.fn();
jest.mock('@canopy/desktop-shared/lib/commit-message-generator', () => ({
  generateCommitMessageWithUsage: (...args: unknown[]): unknown =>
    mockCommit(...args),
}));
jest.mock('@canopy/desktop-shared/lib/github-pr-generator', () => ({
  generatePrContentWithUsage: jest.fn(() =>
    Promise.resolve({
      content: { title: 'Feature', body: 'Body' },
      source: 'model',
      usage: {},
    }),
  ),
}));
import type { generateCommitMessage } from '../lib/commit-message-generator';
import { generatePrContent } from '../lib/github-pr-generator';
const commitOptions: Parameters<typeof generateCommitMessage>[0] = {
  repoPath: '/repo',
  branchName: 'feature',
  diff: 'diff',
  model: 'sonnet',
  instructions: '',
  instructionMode: 'append',
  auditContext: { projectId: 'project', worktreeId: 'worktree' },
};
const prOptions = {
  ...commitOptions,
  baseBranch: 'develop',
  commitLog: 'commit',
};
it('generates pull request content through one pr_generation helper run', async () => {
  await generatePrContent(prOptions);
  expect(helpers.runs).toHaveLength(1);
  expect(helpers.runs[0]).toMatchObject({
    kind: 'pr_generation',
    origin: 'client',
    scope: { workspaceId: 'project', worktreeId: 'worktree' },
  });
});
