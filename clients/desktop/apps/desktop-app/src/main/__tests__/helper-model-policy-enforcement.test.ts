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
jest.mock('../lib/git', () => ({
  resolveSharedAvailableBranchName: jest.fn(() =>
    Promise.resolve('feature-helper'),
  ),
  isBranchNameAvailable: jest.fn(() => Promise.resolve(true)),
  doesOriginBranchExist: jest.fn(() => Promise.resolve(false)),
  renameBranch: jest.fn(() => Promise.resolve()),
  appendBranchSuffix: jest.fn(
    (name: string, n: number): string => `${name}-${n}`,
  ),
}));
jest.mock('../lib/github-pr', () => ({
  hasGitHubPullRequestHistoryForBranch: jest.fn(() => Promise.resolve(false)),
}));
jest.mock('../lib/github-auth', () => ({ checkGitHubCliStatus: jest.fn() }));
jest.mock('../lib/resolve-worktree', () => ({
  doesBranchMatchWorktreeId: jest.fn(() => Promise.resolve({ matches: false })),
}));
jest.mock('../lib/worktree-branch-watcher', () => ({
  recordWorktreeBranchChange: jest.fn(() => Promise.resolve()),
}));
import { generateAndRenameBranch } from '../lib/branch-namer';
jest.mock('../integration/structured-helper-dispatch', () => ({
  runStructuredHelper: jest.fn(() =>
    Promise.resolve({ value: { branchName: 'feature-helper' }, usage: {} }),
  ),
  structuredHelperReportOnlyPermission: jest.fn(),
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
import { generateCommitMessage } from '../lib/commit-message-generator';
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
it('a policy-blocked Git or pull request text helper never starts a helper run', async () => {
  const branchOptions: Parameters<typeof generateAndRenameBranch>[0] = {
    projectId: 'project',
    worktreeId: 'worktree',
    cwd: '/repo',
    userMessage: 'Name the feature',
    branchResult: { matches: true },
  };
  mockBlocked.mockResolvedValue(true);
  await generateAndRenameBranch(branchOptions);
  await generateCommitMessage(commitOptions);
  await generatePrContent(prOptions);
  expect(helpers.runs).toHaveLength(0);
  mockBlocked.mockResolvedValue(false);
  mockCommit.mockResolvedValue({
    message: 'feat: Add helper',
    source: 'model',
    usage: {},
  });
  await generateAndRenameBranch(branchOptions);
  await generateCommitMessage(commitOptions);
  await generatePrContent(prOptions);
  expect(helpers.runs.map(({ kind }) => kind)).toEqual([
    'branch_naming',
    'commit_message_generation',
    'pr_generation',
  ]);
});
