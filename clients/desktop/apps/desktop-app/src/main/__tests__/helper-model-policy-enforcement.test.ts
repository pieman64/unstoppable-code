/**
 * Org model policy enforcement for the one-shot helper flows that send
 * high-value repo content (task descriptions, diffs, commit logs) to an
 * explicitly configured helper model.
 *
 * These helpers previously bypassed the policy entirely: only interactive chat,
 * pipelines, and the Portal model catalog were gated, so on personal provider
 * auth a blocked model was still reachable through branch naming, commit
 * message generation, and PR content generation.
 */
import type * as PreferencesStoreModule from '../lib/preferences-store';

const mockIsModelBlockedByStoredPolicy = jest.fn<
  Promise<boolean>,
  [string | undefined]
>(() => Promise.resolve(false));

jest.mock('../lib/model-policy-state', () => ({
  isModelBlockedByStoredPolicy: (
    modelId: string | undefined,
  ): Promise<boolean> => mockIsModelBlockedByStoredPolicy(modelId),
}));

const mockReadPreferencesFile = jest.fn();

jest.mock('../lib/preferences-store', () => ({
  ...jest.requireActual<typeof PreferencesStoreModule>(
    '../lib/preferences-store',
  ),
  readPreferencesFile: (): unknown => mockReadPreferencesFile(),
  readLocalMemoryEnabledPreference: (): Promise<boolean> =>
    Promise.resolve(false),
}));

/**
 * The first provider-facing call every gated helper makes. Rejecting with a
 * sentinel proves the gate let the run through instead of refusing it.
 */
const HELPER_INVOCATION_SENTINEL = 'helper-invocation-reached';
const mockResolveHelperInvocation = jest.fn(() =>
  Promise.reject(new Error(HELPER_INVOCATION_SENTINEL)),
);

jest.mock('../ollama/helper-invocation', () => ({
  resolveHelperInvocation: (): Promise<never> => mockResolveHelperInvocation(),
  resolveHelperWorkOwner: jest.fn(() => Promise.resolve({ kind: 'personal' })),
}));

const PLUGIN_RESOLUTION_SENTINEL = 'plugin-resolution-reached';
const mockWithResolvedHelperPlugins = jest.fn(() =>
  Promise.reject(new Error(PLUGIN_RESOLUTION_SENTINEL)),
);
const mockRunWithOptionalHelperPlugins = jest.fn(() =>
  Promise.reject(new Error(PLUGIN_RESOLUTION_SENTINEL)),
);

jest.mock('../lib/helper-plugin-resolution', () => ({
  withResolvedHelperPlugins: (): Promise<never> =>
    mockWithResolvedHelperPlugins(),
  runWithOptionalHelperPlugins: (): Promise<never> =>
    mockRunWithOptionalHelperPlugins(),
}));

const mockStartObservedTask = jest.fn();
const mockFinalizeObservedTask = jest.fn();
const mockUpdateObservedTask = jest.fn();
const mockSeedTranscript = jest.fn();
const mockAppendTranscriptRecord = jest.fn();

jest.mock('../observability', () => ({
  getObservabilityService: (): unknown => ({
    startObservedTask: mockStartObservedTask,
    finalizeObservedTask: mockFinalizeObservedTask,
    updateObservedTask: mockUpdateObservedTask,
    seedTranscript: mockSeedTranscript,
    appendTranscriptRecord: mockAppendTranscriptRecord,
  }),
}));

jest.mock('../lib/github-auth', () => ({
  ...jest.requireActual<object>('../lib/github-auth'),
  checkGitHubCliStatus: jest.fn(() => Promise.resolve({ username: '' })),
}));

const mockRenameBranch = jest.fn(() => Promise.resolve());

jest.mock('../lib/git', () => ({
  appendBranchSuffix: (branchName: string, suffix: number): string =>
    `${branchName}-${suffix}`,
  doesOriginBranchExist: jest.fn(() => Promise.resolve(false)),
  getCurrentBranch: jest.fn(() => Promise.resolve('')),
  isBranchNameAvailable: jest.fn(() => Promise.resolve(true)),
  renameBranch: (): Promise<void> => mockRenameBranch(),
  resolveSharedAvailableBranchName: jest.fn((_paths: string[], name: string) =>
    Promise.resolve(name),
  ),
  validateBranchName: jest.fn(() => Promise.resolve(true)),
}));

jest.mock('../lib/github-pr', () => ({
  hasGitHubPullRequestHistoryForBranch: jest.fn(() => Promise.resolve(false)),
}));

jest.mock('../lib/resolve-worktree', () => ({
  doesBranchMatchWorktreeId: jest.fn(() => Promise.resolve({ matches: false })),
}));

jest.mock('../lib/worktree-branch-watcher', () => ({
  recordWorktreeBranchChange: jest.fn(() => Promise.resolve()),
}));

import {
  initClaudeModels,
  type PreferencesData,
} from '@canopy/desktop-shared/types';
import { DEFAULT_PREFERENCES } from '../lib/preferences-store';
import { generateAndRenameBranch } from '../lib/branch-namer';
import { generateCommitMessage } from '../lib/commit-message-generator';
import { generatePrContent } from '../lib/github-pr-generator';

initClaudeModels([
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
]);

const BLOCKED_MODEL = 'claude-sonnet-4-6';

function makePreferences(
  overrides: Partial<PreferencesData> = {},
): PreferencesData {
  return {
    ...DEFAULT_PREFERENCES,
    branchNamePrefixMode: 'none',
    branchNamingModel: BLOCKED_MODEL,
    ...overrides,
  };
}

describe('org model policy enforcement for one-shot helpers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsModelBlockedByStoredPolicy.mockResolvedValue(false);
    mockReadPreferencesFile.mockResolvedValue(makePreferences());
    mockResolveHelperInvocation.mockImplementation(() =>
      Promise.reject(new Error(HELPER_INVOCATION_SENTINEL)),
    );
    mockWithResolvedHelperPlugins.mockImplementation(() =>
      Promise.reject(new Error(PLUGIN_RESOLUTION_SENTINEL)),
    );
    mockRunWithOptionalHelperPlugins.mockImplementation(() =>
      Promise.reject(new Error(PLUGIN_RESOLUTION_SENTINEL)),
    );
  });

  describe('branch naming', () => {
    const branchOptions = {
      projectId: 'proj',
      worktreeId: 'wt',
      cwd: '/repo',
      userMessage: 'Add a webhook receiver for billing events',
      branchResult: { matches: true } as const,
      observabilityTaskKey: 'helper:branch-naming:proj/wt',
    };

    it('refuses and leaves the default branch name in place when the model is blocked', async () => {
      mockIsModelBlockedByStoredPolicy.mockResolvedValue(true);

      await expect(generateAndRenameBranch(branchOptions)).resolves.toEqual({});

      expect(mockIsModelBlockedByStoredPolicy).toHaveBeenCalledWith(
        BLOCKED_MODEL,
      );
      expect(mockWithResolvedHelperPlugins).not.toHaveBeenCalled();
      expect(mockRenameBranch).not.toHaveBeenCalled();
      expect(mockFinalizeObservedTask).toHaveBeenCalledWith(
        'helper:branch-naming:proj/wt',
        'failure',
        'Branch naming was skipped: this model is blocked by your organization policy.',
      );
    });

    it('runs branch naming normally when no policy blocks the model', async () => {
      await expect(generateAndRenameBranch(branchOptions)).rejects.toThrow(
        PLUGIN_RESOLUTION_SENTINEL,
      );

      expect(mockIsModelBlockedByStoredPolicy).toHaveBeenCalledWith(
        BLOCKED_MODEL,
      );
      expect(mockWithResolvedHelperPlugins).toHaveBeenCalledTimes(1);
    });
  });

  describe('commit message generation', () => {
    const commitOptions = {
      repoPath: '/repo',
      branchName: 'alice/add-webhook-receiver',
      diff: 'diff --git a/secret.ts b/secret.ts',
      model: BLOCKED_MODEL,
      instructions: '',
      instructionMode: 'append' as const,
    };

    it('refuses and falls back to the branch-derived message when the model is blocked', async () => {
      mockIsModelBlockedByStoredPolicy.mockResolvedValue(true);

      await expect(generateCommitMessage(commitOptions)).resolves.toBe(
        'Alice add webhook receiver',
      );

      expect(mockIsModelBlockedByStoredPolicy).toHaveBeenCalledWith(
        BLOCKED_MODEL,
      );
      // The diff never reaches provider resolution.
      expect(mockResolveHelperInvocation).not.toHaveBeenCalled();
      expect(mockFinalizeObservedTask).toHaveBeenCalledWith(
        expect.stringContaining('helper:commit-message:'),
        'failure',
        'Commit message generation was skipped: this model is blocked by your organization policy.',
        undefined,
      );
    });

    it('runs commit message generation normally when no policy blocks the model', async () => {
      // A helper failure never aborts the git action (CAN-3866): the
      // invocation error is recorded and the branch-derived title returned.
      await expect(generateCommitMessage(commitOptions)).resolves.toBe(
        'Alice add webhook receiver',
      );

      expect(mockIsModelBlockedByStoredPolicy).toHaveBeenCalledWith(
        BLOCKED_MODEL,
      );
      expect(mockResolveHelperInvocation).toHaveBeenCalledTimes(1);
      expect(mockFinalizeObservedTask).toHaveBeenCalledWith(
        expect.stringContaining('helper:commit-message:'),
        'failure',
        expect.stringContaining(HELPER_INVOCATION_SENTINEL),
        undefined,
      );
    });
  });

  describe('PR content generation', () => {
    const prOptions = {
      repoPath: '/repo',
      branchName: 'alice/add-webhook-receiver',
      baseBranch: 'main',
      diff: 'diff --git a/secret.ts b/secret.ts',
      commitLog: '- add webhook receiver',
      model: BLOCKED_MODEL,
      instructions: '',
      instructionMode: 'append',
    };

    it('refuses and falls back to branch/commit-log content when the model is blocked', async () => {
      mockIsModelBlockedByStoredPolicy.mockResolvedValue(true);

      await expect(generatePrContent(prOptions)).resolves.toEqual({
        title: 'Alice add webhook receiver',
        body: '## Changes\n\n- add webhook receiver',
      });

      expect(mockIsModelBlockedByStoredPolicy).toHaveBeenCalledWith(
        BLOCKED_MODEL,
      );
      // The diff and commit log never reach provider resolution.
      expect(mockResolveHelperInvocation).not.toHaveBeenCalled();
      expect(mockFinalizeObservedTask).toHaveBeenCalledWith(
        expect.stringContaining('helper:pr-generation:'),
        'failure',
        'PR content generation was skipped: this model is blocked by your organization policy.',
        undefined,
      );
    });

    it('runs PR content generation normally when no policy blocks the model', async () => {
      await expect(generatePrContent(prOptions)).rejects.toThrow(
        HELPER_INVOCATION_SENTINEL,
      );

      expect(mockIsModelBlockedByStoredPolicy).toHaveBeenCalledWith(
        BLOCKED_MODEL,
      );
      expect(mockResolveHelperInvocation).toHaveBeenCalledTimes(1);
    });
  });
});
