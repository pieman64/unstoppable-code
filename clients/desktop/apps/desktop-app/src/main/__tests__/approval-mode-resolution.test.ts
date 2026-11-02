import {
  APP_ADVISOR_PROJECT_ID,
  CODE_REVIEW_CHAT_PROJECT_ID,
  PIPELINE_EDITOR_PROJECT_ID,
  PLAN_EXPLORE_CHAT_PROJECT_ID,
  STANDALONE_CHAT_PROJECT_ID,
} from '@canopy/desktop-shared/types';
import type { ApprovalDefaults } from '@canopy/desktop-shared/types';
import {
  PRODUCT_DEFAULT_APPROVAL_MODE,
  UNRESOLVABLE_TARGET_APPROVAL_MODE,
  beginApprovalDefaultIntent,
  beginPendingApprovalDefaultWrite,
  commitApprovalDefaultIntent,
  defaultsKeyForSurface,
  isApprovalDefaultIntentCurrent,
  resolveApprovalMode,
  resolveApprovalProjectId,
  resolvePersistedApprovalMode,
  surfaceForChat,
} from '../lib/approval-mode-resolution';

const mockReadWorkspaceApprovals = jest.fn();
const mockReadWorkspaceApprovalsManifest = jest.fn();
const mockReadPreferencesFile = jest.fn<Promise<Record<string, unknown>>, []>();
const mockPeekPreferencesLoadError = jest.fn();
const mockResolveWorktreeTargetIds = jest.fn();

jest.mock('../lib/approvals-persistence', () => ({
  readWorkspaceApprovals: (...args: unknown[]): unknown =>
    mockReadWorkspaceApprovals(...args),
}));
jest.mock('../lib/workspace-approvals-manifest', () => ({
  readWorkspaceApprovalsManifest: (...args: unknown[]): unknown =>
    mockReadWorkspaceApprovalsManifest(...args),
}));
jest.mock('../lib/preferences-store', () => ({
  readPreferencesFileDetailed: async (): Promise<{
    preferences: Awaited<ReturnType<typeof mockReadPreferencesFile>>;
    authority: 'ok' | 'unreadable';
  }> => ({
    preferences: await mockReadPreferencesFile(),
    authority: mockPeekPreferencesLoadError() != null ? 'unreadable' : 'ok',
  }),
  readPreferencesFile: (): Promise<Record<string, unknown>> =>
    mockReadPreferencesFile(),
  peekPreferencesLoadError: (...args: unknown[]): unknown =>
    mockPeekPreferencesLoadError(...args),
}));
jest.mock('../lib/resolve-worktree', () => ({
  resolveWorktreeTargetIds: (...args: unknown[]): unknown =>
    mockResolveWorktreeTargetIds(...args),
}));

const DEFAULTS: ApprovalDefaults = {
  worktree: 'ask',
  cowork: 'auto',
  appAdvisor: 'full-access',
};

describe('resolveApprovalMode', () => {
  let endPendingWrite: (() => void) | undefined;

  afterEach(() => {
    if (endPendingWrite) {
      endPendingWrite();
      endPendingWrite = undefined;
    }
  });

  it('prefers tabMode over every other tier', () => {
    expect(
      resolveApprovalMode({
        tabMode: 'auto',
        hookMode: 'ask',
        workspaceDefault: 'ask',
        canopyJsonDefault: 'ask',
        surface: 'worktree',
        defaults: DEFAULTS,
      }),
    ).toBe('auto');
  });

  it('lets hookMode de-escalate the locally effective policy', () => {
    expect(
      resolveApprovalMode({
        hookMode: 'ask',
        workspaceDefault: 'auto',
        canopyJsonDefault: 'ask',
        surface: 'worktree',
        defaults: DEFAULTS,
      }),
    ).toBe('ask');
  });

  it('does not let hookMode escalate a local Ask policy', () => {
    expect(
      resolveApprovalMode({
        hookMode: 'auto',
        workspaceDefault: 'ask',
        surface: 'worktree',
        defaults: DEFAULTS,
      }),
    ).toBe('ask');
  });

  it('clamps workspaceDefault with a more restrictive canopy.json default', () => {
    expect(
      resolveApprovalMode({
        workspaceDefault: 'auto',
        canopyJsonDefault: 'ask',
        surface: 'worktree',
        defaults: DEFAULTS,
      }),
    ).toBe('ask');
  });

  it('lets canopyJsonDefault de-escalate the surface default', () => {
    expect(
      resolveApprovalMode({
        canopyJsonDefault: 'ask',
        surface: 'cowork',
        defaults: DEFAULTS,
      }),
    ).toBe('ask');
  });

  it('does not let canopyJsonDefault escalate the surface default', () => {
    expect(
      resolveApprovalMode({
        canopyJsonDefault: 'auto',
        surface: 'worktree',
        defaults: DEFAULTS,
      }),
    ).toBe('ask');
  });

  it('falls back to defaults[surface] when nothing else is defined', () => {
    expect(
      resolveApprovalMode({
        surface: 'worktree',
        defaults: DEFAULTS,
      }),
    ).toBe('ask');
    expect(
      resolveApprovalMode({
        surface: 'cowork',
        defaults: DEFAULTS,
      }),
    ).toBe('auto');
    expect(
      resolveApprovalMode({
        surface: 'app-advisor',
        defaults: DEFAULTS,
      }),
    ).toBe('full-access');
  });

  it('falls back to "ask" when defaults are uncustomized (all fields "ask")', () => {
    const emptyDefaults: ApprovalDefaults = {
      worktree: 'ask',
      cowork: 'ask',
      appAdvisor: 'ask',
    };
    expect(
      resolveApprovalMode({
        surface: 'worktree',
        defaults: emptyDefaults,
      }),
    ).toBe('ask');
    expect(
      resolveApprovalMode({
        surface: 'cowork',
        defaults: emptyDefaults,
      }),
    ).toBe('ask');
    expect(
      resolveApprovalMode({
        surface: 'app-advisor',
        defaults: emptyDefaults,
      }),
    ).toBe('ask');
  });

  it('does not resolve from an uncommitted pending default', () => {
    endPendingWrite = beginPendingApprovalDefaultWrite('worktree');

    expect(
      resolveApprovalMode({
        surface: 'worktree',
        defaults: {
          worktree: 'full-access',
          cowork: 'full-access',
          appAdvisor: 'full-access',
        },
      }),
    ).toBe('full-access');

    endPendingWrite();
    endPendingWrite = undefined;
    expect(
      resolveApprovalMode({
        surface: 'worktree',
        defaults: {
          worktree: 'full-access',
          cowork: 'full-access',
          appAdvisor: 'full-access',
        },
      }),
    ).toBe('full-access');
  });
});

describe('surfaceForChat', () => {
  it('classifies the standalone/cowork sentinel id as cowork', () => {
    expect(surfaceForChat(STANDALONE_CHAT_PROJECT_ID)).toBe('cowork');
  });

  it('classifies the App Advisor project id as app-advisor', () => {
    expect(surfaceForChat(APP_ADVISOR_PROJECT_ID)).toBe('app-advisor');
  });

  it('classifies the Pipeline Editor project id as app-advisor', () => {
    expect(surfaceForChat(PIPELINE_EDITOR_PROJECT_ID)).toBe('app-advisor');
  });

  it('classifies a plain project id (worktree/plan-explore/code-review) as worktree', () => {
    expect(surfaceForChat('some-project-id')).toBe('worktree');
  });
});

describe('resolvePersistedApprovalMode', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPeekPreferencesLoadError.mockReturnValue(null);
    mockReadWorkspaceApprovals.mockResolvedValue({
      version: 1,
      defaultMode: 'ask',
      rules: [],
    });
    mockReadWorkspaceApprovalsManifest.mockResolvedValue({ rules: [] });
    mockReadPreferencesFile.mockResolvedValue({
      approvalDefaults: {
        worktree: 'full-access',
        cowork: 'full-access',
        appAdvisor: 'full-access',
      },
    });
  });

  it.each([
    [CODE_REVIEW_CHAT_PROJECT_ID, 'code-review-scope'],
    [PLAN_EXPLORE_CHAT_PROJECT_ID, 'plan-explore-scope'],
  ])(
    'reads sentinel approval sidecars from the owning worktree for %s',
    async (projectId, worktreeId) => {
      mockResolveWorktreeTargetIds.mockReturnValue({
        projectId: 'real-project',
        worktreeId: 'real-worktree',
      });

      await expect(
        resolvePersistedApprovalMode(projectId, worktreeId),
      ).resolves.toBe('ask');
      expect(mockResolveWorktreeTargetIds).toHaveBeenCalledWith(
        projectId,
        worktreeId,
      );
      expect(mockReadWorkspaceApprovals).toHaveBeenCalledWith('real-project');
      expect(mockReadWorkspaceApprovalsManifest).toHaveBeenCalledWith(
        'real-project',
      );
    },
  );

  // Regression guard for the constant split (CAN-3055). The product default is
  // Full Access, but an unresolvable target is a read failure and must stay
  // Ask. Collapsing the two constants back into one would fail this.
  it('returns Ask, not the Full Access product default, when the target cannot be resolved', async () => {
    mockResolveWorktreeTargetIds.mockReturnValue(null);

    await expect(
      resolvePersistedApprovalMode(
        CODE_REVIEW_CHAT_PROJECT_ID,
        'missing-scope',
      ),
    ).resolves.toBe('ask');
    expect(mockReadWorkspaceApprovals).not.toHaveBeenCalled();
    expect(mockReadWorkspaceApprovalsManifest).not.toHaveBeenCalled();
  });

  it('resolves Full Access for a fresh profile with no workspace overrides', async () => {
    mockResolveWorktreeTargetIds.mockReturnValue({
      projectId: 'fresh-project',
      worktreeId: 'fresh-worktree',
    });
    mockReadWorkspaceApprovals.mockResolvedValue({ version: 1, rules: [] });

    await expect(
      resolvePersistedApprovalMode('fresh-project', 'fresh-worktree'),
    ).resolves.toBe('full-access');
  });

  // CAN-3055 regression: a DEGRADED preferences read must not be mistaken for
  // a fresh profile. `readPreferencesFile()` silently returns
  // DEFAULT_PREFERENCES when the file is corrupt/unreadable and recovery also
  // failed, and those defaults are now all Full Access — so without consulting
  // `peekPreferencesLoadError()` an unreadable preferences file would grant
  // unrestricted execution. `full-access` skips the `canUseTool` hook entirely
  // (`allowDangerouslySkipPermissions`), so approval-service's `forcePrompt`
  // safeguard never runs and cannot catch this downstream.
  it('fails closed to Ask when the preferences read was degraded', async () => {
    mockResolveWorktreeTargetIds.mockReturnValue({
      projectId: 'degraded-project',
      worktreeId: 'degraded-worktree',
    });
    mockReadWorkspaceApprovals.mockResolvedValue({ version: 1, rules: [] });
    // Exactly what readPreferencesFile() returns on a failed recovery: the
    // Full Access defaults, with the load error left pending.
    mockReadPreferencesFile.mockResolvedValue({
      approvalDefaults: {
        worktree: 'full-access',
        cowork: 'full-access',
        appAdvisor: 'full-access',
      },
    });
    mockPeekPreferencesLoadError.mockReturnValue({
      stage: 'parse',
      message: 'Preferences file is corrupt.',
    });

    await expect(
      resolvePersistedApprovalMode('degraded-project', 'degraded-worktree'),
    ).resolves.toBe('ask');
  });

  it('still honors a fresh profile when no load error is pending', async () => {
    // Guard against over-correcting: a genuinely fresh install (no file, no
    // last-good) leaves `peekPreferencesLoadError()` null and must keep the
    // Full Access product default.
    mockResolveWorktreeTargetIds.mockReturnValue({
      projectId: 'fresh-project',
      worktreeId: 'fresh-worktree',
    });
    mockReadWorkspaceApprovals.mockResolvedValue({ version: 1, rules: [] });
    mockPeekPreferencesLoadError.mockReturnValue(null);

    await expect(
      resolvePersistedApprovalMode('fresh-project', 'fresh-worktree'),
    ).resolves.toBe('full-access');
  });

  it('still resolves Ask when approvals.json is unreadable', async () => {
    mockResolveWorktreeTargetIds.mockReturnValue({
      projectId: 'corrupt-project',
      worktreeId: 'corrupt-worktree',
    });
    // Shape of UNREADABLE_APPROVALS_FILE in `lib/approvals-persistence.ts`.
    mockReadWorkspaceApprovals.mockResolvedValue({
      version: 1,
      defaultMode: 'ask',
      rules: [],
    });

    await expect(
      resolvePersistedApprovalMode('corrupt-project', 'corrupt-worktree'),
    ).resolves.toBe('ask');
  });

  it('lets a canopy.json Ask default clamp a Full Access user default', async () => {
    mockResolveWorktreeTargetIds.mockReturnValue({
      projectId: 'repo-project',
      worktreeId: 'repo-worktree',
    });
    mockReadWorkspaceApprovals.mockResolvedValue({ version: 1, rules: [] });
    mockReadWorkspaceApprovalsManifest.mockResolvedValue({
      rules: [],
      defaultMode: 'ask',
    });

    await expect(
      resolvePersistedApprovalMode('repo-project', 'repo-worktree'),
    ).resolves.toBe('ask');
  });
});

describe('approval mode constants', () => {
  it('keeps the product default and the fail-closed fallback separate', () => {
    expect(PRODUCT_DEFAULT_APPROVAL_MODE).toBe('full-access');
    expect(UNRESOLVABLE_TARGET_APPROVAL_MODE).toBe('ask');
  });
});

describe('approval default intent ordering', () => {
  it('does not let a newer pending intent suppress an older committed choice', () => {
    const older = beginApprovalDefaultIntent('worktree');
    beginApprovalDefaultIntent('worktree');

    commitApprovalDefaultIntent('worktree', older);

    expect(isApprovalDefaultIntentCurrent('worktree', older)).toBe(true);
  });

  it('lets a newer committed choice suppress an older committed choice', () => {
    const older = beginApprovalDefaultIntent('cowork');
    const newer = beginApprovalDefaultIntent('cowork');
    commitApprovalDefaultIntent('cowork', older);
    commitApprovalDefaultIntent('cowork', newer);

    expect(isApprovalDefaultIntentCurrent('cowork', older)).toBe(false);
    expect(isApprovalDefaultIntentCurrent('cowork', newer)).toBe(true);
  });
});

describe('defaultsKeyForSurface', () => {
  it('maps each surface onto its ApprovalDefaults key', () => {
    expect(defaultsKeyForSurface('worktree')).toBe('worktree');
    expect(defaultsKeyForSurface('cowork')).toBe('cowork');
    expect(defaultsKeyForSurface('app-advisor')).toBe('appAdvisor');
  });
});

describe('resolveApprovalProjectId', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns a plain project id unchanged without consulting the registry', () => {
    expect(resolveApprovalProjectId('plain-project', 'worktree')).toBe(
      'plain-project',
    );
    expect(mockResolveWorktreeTargetIds).not.toHaveBeenCalled();
  });

  it.each([
    CODE_REVIEW_CHAT_PROJECT_ID,
    PLAN_EXPLORE_CHAT_PROJECT_ID,
    STANDALONE_CHAT_PROJECT_ID,
  ])('maps the %s sentinel onto its owning workspace', (projectId) => {
    mockResolveWorktreeTargetIds.mockReturnValue({
      projectId: 'owning-workspace',
      worktreeId: 'owning-worktree',
    });

    expect(resolveApprovalProjectId(projectId, 'scope')).toBe(
      'owning-workspace',
    );
    expect(mockResolveWorktreeTargetIds).toHaveBeenCalledWith(
      projectId,
      'scope',
    );
  });

  it('returns undefined for a sentinel with no worktree id', () => {
    expect(
      resolveApprovalProjectId(CODE_REVIEW_CHAT_PROJECT_ID),
    ).toBeUndefined();
    expect(mockResolveWorktreeTargetIds).not.toHaveBeenCalled();
  });

  it('returns undefined when the sentinel cannot be resolved', () => {
    mockResolveWorktreeTargetIds.mockReturnValue(null);

    expect(
      resolveApprovalProjectId(STANDALONE_CHAT_PROJECT_ID, 'missing'),
    ).toBeUndefined();
  });
});
