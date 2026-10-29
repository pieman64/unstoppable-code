jest.mock('../ipc/register', () => ({
  registerIpcHandler: jest.fn(),
}));

jest.mock('../lib/detected-plan-persistence', () => ({
  readDetectedPlans: jest.fn(),
  appendDetectedPlans: jest.fn(),
  updateDetectedPlan: jest.fn(),
}));

jest.mock('../lib/detected-plan-matcher', () => ({
  matchCandidatePaths: jest.fn(),
}));

jest.mock('../lib/plan-detection-config', () => ({
  resolveWorktreePlanDetectionRules: jest.fn(),
}));

jest.mock('../lib/worktree-repo-entries', () => ({
  listWorkspaceWorktreeRepoEntries: jest.fn(),
}));

jest.mock('../lib/paths', () => ({
  getWorkspaceWorktreeDir: jest.fn(),
}));

jest.mock('../lib/validation', () => ({
  validateId: jest.fn(),
}));

jest.mock('../lib/window-send', () => ({
  sendToWindow: jest.fn(),
}));

jest.mock('node:crypto', () => ({
  randomUUID: jest.fn(),
}));

import { randomUUID } from 'node:crypto';
import type { ResolvedPlanDetectionRules } from '@canopy/desktop-shared/plan-detection';
import {
  WORKSPACE_ROOT_REPO_ID,
  type DetectedPlanEntry,
} from '@canopy/desktop-shared/types';
import {
  readDetectedPlans,
  appendDetectedPlans,
  updateDetectedPlan,
} from '../lib/detected-plan-persistence';
import { matchCandidatePaths } from '../lib/detected-plan-matcher';
import type { CandidateMatch } from '../lib/detected-plan-matcher';
import { resolveWorktreePlanDetectionRules } from '../lib/plan-detection-config';
import { listWorkspaceWorktreeRepoEntries } from '../lib/worktree-repo-entries';
import { getWorkspaceWorktreeDir } from '../lib/paths';
import { validateId } from '../lib/validation';
import { registerIpcHandler } from '../ipc/register';
import {
  registerDetectedPlansHandlers,
  scanDetectedPlans,
} from '../ipc/detected-plans';

const mockedRandomUUID = jest.mocked(randomUUID);
const mockedReadDetectedPlans = jest.mocked(readDetectedPlans);
const mockedAppendDetectedPlans = jest.mocked(appendDetectedPlans);
const mockedUpdateDetectedPlan = jest.mocked(updateDetectedPlan);
const mockedMatchCandidatePaths = jest.mocked(matchCandidatePaths);
const mockedResolveWorktreePlanDetectionRules = jest.mocked(
  resolveWorktreePlanDetectionRules,
);
const mockedListWorkspaceWorktreeRepoEntries = jest.mocked(
  listWorkspaceWorktreeRepoEntries,
);
const mockedGetWorkspaceWorktreeDir = jest.mocked(getWorkspaceWorktreeDir);
const mockedValidateId = jest.mocked(validateId);
const mockedRegisterIpcHandler = jest.mocked(registerIpcHandler);

const RULES_WITH_INCLUDES: ResolvedPlanDetectionRules = {
  includes: [
    {
      id: 'i1',
      label: 'Include plans',
      kind: 'include',
      pattern: 'docs/**/*.md',
      enabled: true,
    },
  ],
  excludes: [],
};

const RULES_EMPTY: ResolvedPlanDetectionRules = {
  includes: [],
  excludes: [],
};

function makeEntry(
  overrides: Partial<DetectedPlanEntry> = {},
): DetectedPlanEntry {
  return {
    id: 'entry-1',
    sourceRepoId: 'repo-a',
    sourceFilePath: 'docs/plan.md',
    status: 'detected',
    bannerSeen: false,
    detectedInChatId: 'chat-1',
    detectedAt: '2026-06-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('scanDetectedPlans', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedGetWorkspaceWorktreeDir.mockReturnValue('/wt/proj-1/worktree-1');
    mockedListWorkspaceWorktreeRepoEntries.mockResolvedValue([
      {
        repoId: 'repo-a',
        repoName: 'Repo A',
        repoPath: '/wt/proj-1/worktree-1/repos/repo-a',
      },
    ]);
    mockedRandomUUID.mockReturnValue(
      'new-uuid-1' as unknown as `${string}-${string}-${string}-${string}-${string}`,
    );
  });

  it('resolves rules, gets repos, matches candidates, and appends only new entries', async () => {
    mockedResolveWorktreePlanDetectionRules.mockResolvedValue(
      RULES_WITH_INCLUDES,
    );
    mockedReadDetectedPlans.mockResolvedValue([]);
    const match: CandidateMatch = {
      sourceRepoId: 'repo-a',
      sourceFilePath: 'docs/plan.md',
    };
    mockedMatchCandidatePaths.mockReturnValue([match]);
    const appended = makeEntry({ id: 'new-uuid-1' });
    mockedAppendDetectedPlans.mockResolvedValue([appended]);

    const result = await scanDetectedPlans({
      projectId: 'proj-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
      candidatePaths: ['/wt/proj-1/worktree-1/repos/repo-a/docs/plan.md'],
    });

    expect(mockedValidateId).toHaveBeenCalledWith('chat-1', 'chatId');
    expect(mockedResolveWorktreePlanDetectionRules).toHaveBeenCalledWith(
      'proj-1',
      'worktree-1',
    );
    expect(mockedGetWorkspaceWorktreeDir).toHaveBeenCalledWith(
      'proj-1',
      'worktree-1',
    );
    expect(mockedListWorkspaceWorktreeRepoEntries).toHaveBeenCalledWith(
      'proj-1',
      '/wt/proj-1/worktree-1',
    );
    expect(mockedMatchCandidatePaths).toHaveBeenCalledWith({
      candidatePaths: ['/wt/proj-1/worktree-1/repos/repo-a/docs/plan.md'],
      repos: [
        { repoId: 'repo-a', repoPath: '/wt/proj-1/worktree-1/repos/repo-a' },
      ],
      rules: RULES_WITH_INCLUDES,
    });
    expect(mockedAppendDetectedPlans).toHaveBeenCalledWith(
      'proj-1',
      'worktree-1',
      [
        expect.objectContaining({
          id: 'new-uuid-1',
          sourceRepoId: 'repo-a',
          sourceFilePath: 'docs/plan.md',
          status: 'detected',
          bannerSeen: false,
          detectedInChatId: 'chat-1',
        }),
      ],
    );
    expect(result.entries).toEqual([appended]);
    expect(result.newlyDetected).toHaveLength(1);
    expect(result.newlyDetected[0]).toMatchObject({
      sourceRepoId: 'repo-a',
      sourceFilePath: 'docs/plan.md',
      status: 'detected',
      bannerSeen: false,
      detectedInChatId: 'chat-1',
    });
  });

  it('excludes pre-existing entries from newlyDetected', async () => {
    const existing = makeEntry({
      id: 'existing-1',
      sourceRepoId: 'repo-a',
      sourceFilePath: 'docs/plan.md',
    });
    mockedResolveWorktreePlanDetectionRules.mockResolvedValue(
      RULES_WITH_INCLUDES,
    );
    mockedReadDetectedPlans.mockResolvedValue([existing]);
    const match: CandidateMatch = {
      sourceRepoId: 'repo-a',
      sourceFilePath: 'docs/plan.md',
    };
    mockedMatchCandidatePaths.mockReturnValue([match]);

    const result = await scanDetectedPlans({
      projectId: 'proj-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
      candidatePaths: ['/wt/proj-1/worktree-1/repos/repo-a/docs/plan.md'],
    });

    // Already exists: appendDetectedPlans should not be called
    expect(mockedAppendDetectedPlans).not.toHaveBeenCalled();
    // newlyDetected is empty since the match was pre-existing
    expect(result.newlyDetected).toHaveLength(0);
    // entries still returns the existing list
    expect(result.entries).toEqual([existing]);
  });

  it('returns empty newlyDetected when rules have no include patterns', async () => {
    mockedResolveWorktreePlanDetectionRules.mockResolvedValue(RULES_EMPTY);
    mockedReadDetectedPlans.mockResolvedValue([]);

    const result = await scanDetectedPlans({
      projectId: 'proj-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
      candidatePaths: ['/wt/proj-1/worktree-1/repos/repo-a/docs/plan.md'],
    });

    // No include rules: skip matching entirely
    expect(mockedMatchCandidatePaths).not.toHaveBeenCalled();
    expect(mockedAppendDetectedPlans).not.toHaveBeenCalled();
    expect(result.newlyDetected).toHaveLength(0);
    expect(result.entries).toHaveLength(0);
  });

  it('falls back to the workspace-root repo when listWorkspaceWorktreeRepoEntries returns empty', async () => {
    mockedResolveWorktreePlanDetectionRules.mockResolvedValue(
      RULES_WITH_INCLUDES,
    );
    mockedReadDetectedPlans.mockResolvedValue([]);
    mockedListWorkspaceWorktreeRepoEntries.mockResolvedValue([]);
    mockedMatchCandidatePaths.mockReturnValue([]);

    await scanDetectedPlans({
      projectId: 'proj-1',
      worktreeId: 'worktree-1',
      chatId: 'chat-1',
      candidatePaths: ['docs/plan.md'],
    });

    expect(mockedMatchCandidatePaths).toHaveBeenCalledWith(
      expect.objectContaining({
        repos: [
          {
            repoId: WORKSPACE_ROOT_REPO_ID,
            repoPath: '/wt/proj-1/worktree-1',
          },
        ],
      }),
    );
  });

  it('validates update request ids before persisting detected-plan updates', async () => {
    mockedUpdateDetectedPlan.mockResolvedValue([]);
    registerDetectedPlansHandlers(() => null);
    const updateHandler = mockedRegisterIpcHandler.mock.calls.find(
      ([channel]) => channel === 'detected-plans:update',
    )?.[1];
    expect(updateHandler).toBeDefined();

    await updateHandler?.(
      {},
      {
        projectId: 'proj-1',
        worktreeId: 'worktree-1',
        entryId: 'entry-1',
        status: 'imported',
        importedPlanId: 'plan-1',
      },
    );

    expect(mockedValidateId).toHaveBeenCalledWith('proj-1', 'projectId');
    expect(mockedValidateId).toHaveBeenCalledWith('worktree-1', 'worktreeId');
    expect(mockedValidateId).toHaveBeenCalledWith('entry-1', 'entryId');
    expect(mockedValidateId).toHaveBeenCalledWith('plan-1', 'importedPlanId');
  });
});
