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
jest.mock('../integration/structured-helper-dispatch', () => ({
  runStructuredHelper: jest.fn(() =>
    Promise.resolve({ value: { branchName: 'feature-helper' }, usage: {} }),
  ),
  structuredHelperReportOnlyPermission: jest.fn(),
}));
import { generateAndRenameBranch } from '../lib/branch-namer';
describe('worktree:schedule-task-branch-naming helper qualification', () => {
  it('names the branch through one branch_naming helper run', async () => {
    await generateAndRenameBranch({
      projectId: 'project',
      worktreeId: 'worktree',
      cwd: '/repo',
      userMessage: 'Name the feature',
      branchResult: { matches: true },
    });
    expect(helpers.runs).toHaveLength(1);
    expect(helpers.runs[0]).toMatchObject({
      kind: 'branch_naming',
      model: 'sonnet',
      origin: 'system',
      scope: { workspaceId: 'project', worktreeId: 'worktree' },
    });
  });
});
