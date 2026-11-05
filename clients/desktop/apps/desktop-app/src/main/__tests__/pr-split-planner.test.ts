jest.mock('../canopy-runtime/desktop-runtime', () => ({
  getActiveDesktopRuntimeIfAccepting: jest.fn(),
}));
import type * as InlineHelperRuns from './helpers/inline-helper-runs';
import type {
  PrDiffSnapshot,
  SplitPlan,
} from '@canopy/desktop-shared/types/github';
import { initClaudeModels } from '@canopy/desktop-shared/types';
jest.mock('../helper-runs/helper-runs', () => {
  const { inlineHelperRunsModule } = jest.requireActual<
    typeof InlineHelperRuns
  >('./helpers/inline-helper-runs');
  return inlineHelperRunsModule();
});
const mockSnapshot: PrDiffSnapshot = {
  baseRef: 'base',
  headRef: 'head',
  files: [],
  totalAdditions: 0,
  totalDeletions: 0,
};
const mockPlan: SplitPlan = {
  finalGoal: 'Preserve the feature',
  concerns: [],
  children: [],
  parallelizable: '',
  landOrder: '',
  buildTestCommand: '',
  unassignedHunks: [],
};
jest.mock('@canopy/desktop-shared/node/lib/pr-split-diff', () => ({
  gatherPrDiffSnapshot: jest.fn(() => Promise.resolve(mockSnapshot)),
}));
jest.mock('../lib/resolve-worktree', () => ({
  resolveWorktreeCwd: jest.fn(() => '/missing-qualification-repo'),
}));
jest.mock('../lib/workspace-registry', () => ({
  isMultiRepoWorkspace: jest.fn(() => false),
}));
jest.mock('../lib/worktree-base-branches', () => ({
  resolveEffectiveBaseBranchForRepo: jest.fn(() => Promise.resolve(null)),
}));
jest.mock('../lib/git', () => ({
  getCurrentBranch: jest.fn(() => Promise.resolve('feature')),
  fetchOrigin: jest.fn(() => Promise.resolve()),
  resolveRefSha: jest.fn((_path: string, ref: string) =>
    Promise.resolve(ref === 'HEAD' ? 'head' : 'base'),
  ),
  isAncestor: jest.fn(() => Promise.resolve(true)),
}));
jest.mock('../lib/github-pr', () => ({
  fetchRepoPrTrackingData: jest.fn(() =>
    Promise.resolve({
      snapshot: {
        pr: {
          state: 'open',
          number: 1,
          htmlUrl: 'https://github.com/example/repo/pull/1',
          title: 'Feature',
          body: '',
          isCrossRepository: false,
        },
        branch: {
          baseRefName: 'develop',
          headSha: 'head',
          headRefName: 'feature',
        },
      },
    }),
  ),
}));
jest.mock('../lib/preferences-store', () => ({
  readPreferencesFile: jest.fn(() =>
    Promise.resolve({
      splitPrPlannerModel: 'sonnet',
      splitPrPlannerThinkingLevel: 'high',
    }),
  ),
  readLocalMemoryEnabledPreference: jest.fn(() => Promise.resolve(false)),
}));
jest.mock('../lib/helper-observed-task', () => ({
  startObservedHelperTask: jest.fn(),
  finalizeObservedHelperTask: jest.fn(),
}));
jest.mock('../lib/helper-transcript-observer', () => ({
  createHelperTranscriptObserver: jest.fn(() => ({
    seed: jest.fn(),
    appendEvent: jest.fn(),
  })),
}));
jest.mock('../agents/work-owner', () => ({
  resolveInvocationWorkOwner: jest.fn(() => Promise.resolve(null)),
}));
jest.mock('../ollama/helper-invocation', () => ({
  resolveHelperInvocation: jest.fn(() =>
    Promise.resolve({
      harness: 'claude',
      providerType: 'claude',
      dispose: jest.fn(),
    }),
  ),
}));
jest.mock('../integration/structured-helper-dispatch', () => ({
  runStructuredHelper: jest.fn(() =>
    Promise.resolve({ value: mockPlan, usage: {} }),
  ),
  structuredHelperReportOnlyPermission: jest.fn(),
}));
import { planPrSplit } from '../lib/pr-split-planner';
const helpers = jest.requireMock<
  ReturnType<typeof InlineHelperRuns.inlineHelperRunsModule>
>('../helper-runs/helper-runs');
it('plans the split through one pr_split_planning helper run', async () => {
  initClaudeModels([{ id: 'sonnet', label: 'Sonnet' }]);
  await planPrSplit({ projectId: 'project', worktreeId: 'worktree' });
  expect(helpers.runs).toHaveLength(1);
  expect(helpers.runs[0]).toMatchObject({
    kind: 'pr_split_planning',
    model: 'sonnet',
    origin: 'client',
    scope: { workspaceId: 'project', worktreeId: 'worktree' },
  });
});
