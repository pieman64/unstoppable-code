import {
  CODE_REVIEW_CHAT_PROJECT_ID,
  IPC_CHANNELS,
  PLAN_EXPLORE_CHAT_PROJECT_ID,
  STANDALONE_CHAT_PROJECT_ID,
} from '@canopy/desktop-shared/types';
import type {
  ApprovalDefaults,
  ApprovalMode,
  ApprovalsFile,
  PreferencesData,
} from '@canopy/desktop-shared/types';
import type { WorkspaceApprovalsManifest } from '../lib/workspace-approvals-manifest';

const mockHandlers = new Map<string, (...args: unknown[]) => unknown>();
const mockReadWorkspaceApprovals = jest.fn();
const mockReadPreferencesFile = jest.fn<Promise<Record<string, unknown>>, []>();
const mockPeekPreferencesLoadError = jest.fn();
const mockReadWorkspaceApprovalsManifest = jest.fn();
const mockResolveApproval = jest.fn();
const mockPendingApprovalRequests = jest.fn<unknown[], [owner: unknown]>(
  (): unknown[] => [],
);
const mockAddWorkspaceApprovalRule = jest.fn();
const mockRemoveWorkspaceApprovalRule = jest.fn();
const mockUpdatePreferencesFile = jest.fn();
const mockGetCodeReviewTargetSync = jest.fn();
const mockGetPlanExploreTargetSync = jest.fn();
const mockResolveCoworkWorkspaceId = jest.fn();

jest.mock('../ipc/register', () => ({
  registerIpcHandler: (
    channel: string,
    handler: (...args: unknown[]) => unknown,
  ): void => {
    mockHandlers.set(channel, handler);
  },
}));

jest.mock('../approvals/pending-approvals', () => ({
  resolveApproval: (...args: unknown[]): unknown =>
    mockResolveApproval(...args),
  pendingApprovalRequests: (owner: unknown): unknown[] =>
    mockPendingApprovalRequests(owner),
}));

jest.mock('../lib/approvals-persistence', () => ({
  readWorkspaceApprovals: (...args: unknown[]): unknown =>
    mockReadWorkspaceApprovals(...args),
  addWorkspaceApprovalRule: (...args: unknown[]): unknown =>
    mockAddWorkspaceApprovalRule(...args),
  removeWorkspaceApprovalRule: (...args: unknown[]): unknown =>
    mockRemoveWorkspaceApprovalRule(...args),
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
  updatePreferencesFile: (...args: unknown[]): unknown =>
    mockUpdatePreferencesFile(...args),
  peekPreferencesLoadError: (...args: unknown[]): unknown =>
    mockPeekPreferencesLoadError(...args),
}));

jest.mock('../lib/workspace-approvals-manifest', () => ({
  readWorkspaceApprovalsManifest: (...args: unknown[]): unknown =>
    mockReadWorkspaceApprovalsManifest(...args),
}));

jest.mock('../lib/code-review-registry', () => ({
  getCodeReviewTargetSync: (...args: unknown[]): unknown =>
    mockGetCodeReviewTargetSync(...args),
}));

jest.mock('../lib/plan-explore-registry', () => ({
  getPlanExploreTargetSync: (...args: unknown[]): unknown =>
    mockGetPlanExploreTargetSync(...args),
}));

jest.mock('../lib/cowork-migration-map', () => ({
  resolveCoworkWorkspaceId: (...args: unknown[]): unknown =>
    mockResolveCoworkWorkspaceId(...args),
}));

import {
  registerApprovalHandlers,
  setApprovalModeSetter,
  setApprovalOwnerResolver,
} from '../ipc/approvals';
import { beginPendingApprovalDefaultWrite } from '../lib/approval-mode-resolution';
import { registerWorkspaceTypes } from '../lib/workspace-registry';
import { getGlobalApprovalRulesRevision } from '../approvals/rule-revisions';

function emptyManifest(defaultMode?: ApprovalMode): WorkspaceApprovalsManifest {
  return {
    rules: [],
    ...(defaultMode ? { defaultMode } : {}),
  };
}

const APPROVAL_DEFAULTS: ApprovalDefaults = {
  worktree: 'ask',
  cowork: 'auto',
  appAdvisor: 'full-access',
};

function emptyApprovalsFile(defaultMode?: ApprovalMode): ApprovalsFile {
  return {
    version: 1,
    rules: [],
    ...(defaultMode ? { defaultMode } : {}),
  };
}

function preferencesWith(
  approvalDefaults: ApprovalDefaults,
): Pick<PreferencesData, 'approvalDefaults'> {
  return { approvalDefaults };
}

describe('approval:resolved-default IPC handler', () => {
  beforeEach(() => {
    mockHandlers.clear();
    jest.clearAllMocks();
    mockPeekPreferencesLoadError.mockReturnValue(null);
    mockReadWorkspaceApprovalsManifest.mockResolvedValue(emptyManifest());
    mockResolveCoworkWorkspaceId.mockImplementation(
      (workspaceId: string): string => workspaceId,
    );
    // The shared sentinel mapping only accepts a legacy cowork id that
    // actually resolves to a registered cowork workspace.
    registerWorkspaceTypes(new Map([['legacy-workspace', 'cowork']]));
    registerApprovalHandlers();
  });

  function getHandler(): (...args: unknown[]) => unknown {
    const handler = mockHandlers.get(IPC_CHANNELS.approvalResolvedDefault);
    if (!handler) throw new Error('handler not registered');
    return handler;
  }

  it('resolves to the surface preference default when no project override exists', async () => {
    mockReadWorkspaceApprovals.mockResolvedValue(emptyApprovalsFile());
    mockReadPreferencesFile.mockResolvedValue(
      preferencesWith(APPROVAL_DEFAULTS),
    );

    const result = await getHandler()({}, { projectId: 'proj-1' });

    expect(result).toBe('ask');
    expect(mockReadWorkspaceApprovals).toHaveBeenCalledWith('proj-1');
  });

  it('waits for a queued surface-default write before reading preferences', async () => {
    mockReadWorkspaceApprovals.mockResolvedValue(emptyApprovalsFile());
    mockReadPreferencesFile.mockResolvedValue(
      preferencesWith(APPROVAL_DEFAULTS),
    );
    const endPendingWrite = beginPendingApprovalDefaultWrite('worktree');

    const result = getHandler()({}, { projectId: 'proj-queued-write' });
    await Promise.resolve();

    expect(mockReadPreferencesFile).not.toHaveBeenCalled();
    endPendingWrite();
    await expect(result).resolves.toBe('ask');
    expect(mockReadPreferencesFile).toHaveBeenCalledTimes(1);
  });

  it('drains a same-surface write that queues while the resolver is waiting', async () => {
    mockReadWorkspaceApprovals.mockResolvedValue(emptyApprovalsFile());
    let committedMode: ApprovalMode = 'full-access';
    mockReadPreferencesFile.mockImplementation(() =>
      Promise.resolve(
        preferencesWith({
          worktree: committedMode,
          cowork: 'full-access',
          appAdvisor: 'full-access',
        }),
      ),
    );
    const endFirstWrite = beginPendingApprovalDefaultWrite('worktree');

    const result = getHandler()({}, { projectId: 'proj-overlapping-writes' });
    await Promise.resolve();
    const endSecondWrite = beginPendingApprovalDefaultWrite('worktree');
    endFirstWrite();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await Promise.resolve();
    }

    const readStartedBeforeSecondWriteCommitted =
      mockReadPreferencesFile.mock.calls.length > 0;
    committedMode = 'ask';
    endSecondWrite();

    expect(readStartedBeforeSecondWriteCommitted).toBe(false);
    await expect(result).resolves.toBe('ask');
    expect(mockReadPreferencesFile).toHaveBeenCalledTimes(1);
  });

  it('does not consume a write that starts after its committed read begins', async () => {
    mockReadWorkspaceApprovals.mockResolvedValue(emptyApprovalsFile());
    let resolvePreferences: (value: Record<string, unknown>) => void = () =>
      undefined;
    const preferencesRead = new Promise<Record<string, unknown>>((resolve) => {
      resolvePreferences = resolve;
    });
    mockReadPreferencesFile.mockReturnValueOnce(preferencesRead);

    const result = getHandler()({}, { projectId: 'proj-mid-read-write' });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      if (mockReadPreferencesFile.mock.calls.length > 0) break;
      await Promise.resolve();
    }
    expect(mockReadPreferencesFile).toHaveBeenCalledTimes(1);
    const endFailedWrite = beginPendingApprovalDefaultWrite('worktree');
    resolvePreferences(
      preferencesWith({
        worktree: 'full-access',
        cowork: 'full-access',
        appAdvisor: 'full-access',
      }),
    );
    endFailedWrite();

    await expect(result).resolves.toBe('full-access');
  });

  it('prefers the project approvals.json default over the surface preference', async () => {
    mockReadWorkspaceApprovals.mockResolvedValue(
      emptyApprovalsFile('full-access'),
    );
    mockReadPreferencesFile.mockResolvedValue(
      preferencesWith(APPROVAL_DEFAULTS),
    );

    const result = await getHandler()({}, { projectId: 'proj-1' });

    expect(result).toBe('full-access');
  });

  it('resolves a legacy cowork default against its owning project', async () => {
    mockReadWorkspaceApprovals.mockResolvedValue(
      emptyApprovalsFile('full-access'),
    );
    mockReadPreferencesFile.mockResolvedValue(
      preferencesWith(APPROVAL_DEFAULTS),
    );

    const result = await getHandler()(
      {},
      {
        projectId: STANDALONE_CHAT_PROJECT_ID,
        worktreeId: 'legacy-workspace',
      },
    );

    expect(result).toBe('full-access');
    expect(mockResolveCoworkWorkspaceId).toHaveBeenCalledWith(
      'legacy-workspace',
    );
    expect(mockReadWorkspaceApprovals).toHaveBeenCalledWith('legacy-workspace');
  });

  // CAN-3055: a DEGRADED preferences read must not be mistaken for a fresh
  // profile. `readPreferencesFile()` returns the (now all Full Access)
  // DEFAULT_PREFERENCES when the file is corrupt and recovery also failed, so
  // without consulting `peekPreferencesLoadError()` the picker would show —
  // and a send would use — unrestricted access because a file was unreadable.
  it('fails closed to Ask when the preferences read was degraded', async () => {
    mockReadWorkspaceApprovals.mockResolvedValue(emptyApprovalsFile());
    mockReadPreferencesFile.mockResolvedValue(
      preferencesWith({
        worktree: 'full-access',
        cowork: 'full-access',
        appAdvisor: 'full-access',
      }),
    );
    mockPeekPreferencesLoadError.mockReturnValue({
      stage: 'parse',
      message: 'Preferences file is corrupt.',
    });

    await expect(getHandler()({}, { projectId: 'proj-1' })).resolves.toBe(
      'ask',
    );
  });

  it('keeps a degraded preference result fail-closed after its error is acknowledged', async () => {
    let resolveWorkspaceApprovals: (value: ApprovalsFile) => void = () =>
      undefined;
    mockReadWorkspaceApprovals.mockReturnValueOnce(
      new Promise<ApprovalsFile>((resolve) => {
        resolveWorkspaceApprovals = resolve;
      }),
    );
    mockReadPreferencesFile.mockResolvedValue(
      preferencesWith({
        worktree: 'full-access',
        cowork: 'full-access',
        appAdvisor: 'full-access',
      }),
    );
    mockPeekPreferencesLoadError.mockReturnValue({
      stage: 'parse',
      message: 'Preferences file is corrupt.',
    });

    const result = getHandler()({}, { projectId: 'proj-acknowledged-error' });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await Promise.resolve();
    }
    mockPeekPreferencesLoadError.mockReturnValue(null);
    resolveWorkspaceApprovals(emptyApprovalsFile());

    await expect(result).resolves.toBe('ask');
  });

  it('fails closed when a legacy cowork project is missing', async () => {
    const result = await getHandler()(
      {},
      { projectId: STANDALONE_CHAT_PROJECT_ID },
    );

    expect(result).toBe('ask');
    expect(mockReadWorkspaceApprovals).not.toHaveBeenCalled();
    expect(mockReadPreferencesFile).not.toHaveBeenCalled();
  });

  it.each([
    {
      projectId: CODE_REVIEW_CHAT_PROJECT_ID,
      worktreeId: 'review-scope',
      resolver: mockGetCodeReviewTargetSync,
    },
    {
      projectId: PLAN_EXPLORE_CHAT_PROJECT_ID,
      worktreeId: 'plan-scope',
      resolver: mockGetPlanExploreTargetSync,
    },
  ])(
    'resolves $projectId defaults against the owning project',
    async ({ projectId, worktreeId, resolver }) => {
      resolver.mockReturnValue({ projectId: 'real-workspace' });
      mockReadWorkspaceApprovals.mockResolvedValue(
        emptyApprovalsFile('full-access'),
      );
      mockReadPreferencesFile.mockResolvedValue(
        preferencesWith(APPROVAL_DEFAULTS),
      );

      const result = await getHandler()({}, { projectId, worktreeId });

      expect(result).toBe('full-access');
      expect(resolver).toHaveBeenCalledWith(worktreeId);
      expect(mockReadWorkspaceApprovals).toHaveBeenCalledWith('real-workspace');
      expect(mockReadWorkspaceApprovalsManifest).toHaveBeenCalledWith(
        'real-workspace',
      );
    },
  );

  it('fails closed when a special-chat owner cannot be resolved', async () => {
    mockGetCodeReviewTargetSync.mockReturnValue(null);

    const result = await getHandler()(
      {},
      {
        projectId: CODE_REVIEW_CHAT_PROJECT_ID,
        worktreeId: 'missing-scope',
      },
    );

    expect(result).toBe('ask');
    expect(mockReadWorkspaceApprovals).not.toHaveBeenCalled();
    expect(mockReadPreferencesFile).not.toHaveBeenCalled();
  });

  it('rejects a malformed projectId before touching persistence', async () => {
    await expect(
      getHandler()({}, { projectId: 'Not Valid!' }),
    ).rejects.toThrow();
    expect(mockReadWorkspaceApprovals).not.toHaveBeenCalled();
  });

  it('does not let the canopy.json manifest escalate the surface preference', async () => {
    mockReadWorkspaceApprovals.mockResolvedValue(emptyApprovalsFile());
    mockReadWorkspaceApprovalsManifest.mockResolvedValue(emptyManifest('auto'));
    mockReadPreferencesFile.mockResolvedValue(
      preferencesWith(APPROVAL_DEFAULTS),
    );

    const result = await getHandler()({}, { projectId: 'proj-1' });

    expect(result).toBe('ask');
  });

  it('clamps the project approvals.json default with canopy.json', async () => {
    mockReadWorkspaceApprovals.mockResolvedValue(
      emptyApprovalsFile('full-access'),
    );
    mockReadWorkspaceApprovalsManifest.mockResolvedValue(emptyManifest('auto'));
    mockReadPreferencesFile.mockResolvedValue(
      preferencesWith(APPROVAL_DEFAULTS),
    );

    const result = await getHandler()({}, { projectId: 'proj-1' });

    expect(result).toBe('auto');
  });
});

describe('approval:mode-set IPC handler', () => {
  beforeEach(() => {
    mockHandlers.clear();
    jest.clearAllMocks();
    mockPeekPreferencesLoadError.mockReturnValue(null);
    registerApprovalHandlers();
  });

  afterEach(() => setApprovalModeSetter(null));

  // CAN-3055: `mode` reaches durable GLOBAL policy through the sticky-default
  // write-back, and `normalizeApprovalDefaults` falls back per key to the Full
  // Access product default rather than to the previously persisted value — so
  // an unvalidated mode would silently escalate a persisted Ask.
  it('rejects an approval mode that is not a valid ApprovalMode', async () => {
    const setter = jest.fn().mockResolvedValue(undefined);
    setApprovalModeSetter(setter);

    await expect(
      (
        mockHandlers.get(IPC_CHANNELS.approvalModeSet) ??
        ((): never => {
          throw new Error('handler not registered');
        })
      )(
        {},
        {
          projectId: 'proj-1',
          worktreeId: 'wt-1',
          chatId: 'chat-1',
          mode: 'full_access',
        },
      ),
    ).rejects.toThrow(/Invalid approval mode/);

    expect(setter).not.toHaveBeenCalled();
  });

  it.each(['projectId', 'worktreeId', 'chatId'] as const)(
    'validates %s before forwarding the request',
    async (field) => {
      const setter = jest.fn().mockResolvedValue(undefined);
      setApprovalModeSetter(setter);
      const handler = mockHandlers.get(IPC_CHANNELS.approvalModeSet);
      if (!handler) throw new Error('handler not registered');
      const request = {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-1',
        mode: 'ask' as const,
        [field]: 'Not Valid!',
      };

      await expect(handler({}, request)).rejects.toThrow();
      expect(setter).not.toHaveBeenCalled();
    },
  );
});

describe.each([IPC_CHANNELS.approvalRespond, IPC_CHANNELS.approvalDismiss])(
  '%s IPC handler',
  (channel) => {
    beforeEach(() => {
      mockHandlers.clear();
      jest.clearAllMocks();
      registerApprovalHandlers();
    });

    it('rejects a malformed requestId before resolving the approval', () => {
      const handler = mockHandlers.get(channel);
      if (!handler) throw new Error('handler not registered');
      const request =
        channel === IPC_CHANNELS.approvalRespond
          ? {
              requestId: 'Not Valid!',
              decision: { behavior: 'allow', scope: 'once' },
            }
          : { requestId: 'Not Valid!' };

      expect(() => handler({}, request)).toThrow();
      expect(mockResolveApproval).not.toHaveBeenCalled();
    });

    it('binds the approval resolution to the sender and chat identity', () => {
      const handler = mockHandlers.get(channel);
      if (!handler) throw new Error('handler not registered');
      const sender = {};
      const request =
        channel === IPC_CHANNELS.approvalRespond
          ? {
              requestId: 'request-1',
              projectId: 'project-1',
              worktreeId: 'worktree-1',
              chatId: 'chat-1',
              decision: { behavior: 'allow', scope: 'once' },
            }
          : {
              requestId: 'request-1',
              projectId: 'project-1',
              worktreeId: 'worktree-1',
              chatId: 'chat-1',
            };

      handler({ sender }, request);

      expect(mockResolveApproval).toHaveBeenCalledWith(
        'request-1',
        channel === IPC_CHANNELS.approvalRespond
          ? request.decision
          : { behavior: 'deny', scope: 'once' },
        sender,
        request,
      );
    });

    if (channel === IPC_CHANNELS.approvalRespond) {
      it.each([
        { behavior: 'permit', scope: 'once' },
        { behavior: 'allow', scope: 'forever' },
        { behavior: 'allow', scope: 'project' },
        {
          behavior: 'allow',
          scope: 'project',
          target: { kind: 'command', pattern: '' },
        },
        { behavior: 'allow', scope: 'once', stopTurn: true },
      ])('rejects malformed approval decision %#', (decision) => {
        const handler = mockHandlers.get(channel);
        if (!handler) throw new Error('handler not registered');
        const request = {
          requestId: 'request-1',
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          chatId: 'chat-1',
          decision,
        };

        expect(() => handler({ sender: {} }, request)).toThrow(
          'Invalid approval decision',
        );
        expect(mockResolveApproval).not.toHaveBeenCalled();
      });
    }
  },
);

describe('approval pending requests IPC handler', () => {
  it('scopes pending events to the requesting renderer', () => {
    mockHandlers.clear();
    jest.clearAllMocks();
    registerApprovalHandlers();
    const handler = mockHandlers.get(IPC_CHANNELS.approvalPendingRequests);
    if (!handler) throw new Error('handler not registered');
    const sender = {};

    handler({ sender });

    expect(mockPendingApprovalRequests).toHaveBeenCalledWith(sender);
  });
});

describe('approval rule mutation IPC handlers', () => {
  beforeEach(() => {
    mockHandlers.clear();
    jest.clearAllMocks();
    registerApprovalHandlers();
  });

  it.each(['project', 'global'] as const)(
    'validates %s rule IDs before adding',
    async (scope) => {
      const handler = mockHandlers.get(IPC_CHANNELS.approvalRuleAdd);
      if (!handler) throw new Error('handler not registered');
      const request = {
        scope,
        ...(scope === 'project' ? { workspaceId: 'workspace-1' } : {}),
        rule: {
          id: 'Not Valid!',
          behavior: 'allow',
          target: { kind: 'command', pattern: 'npm test *' },
          createdAt: '2026-07-23T00:00:00.000Z',
          origin: 'settings',
        },
      };

      await expect(handler({}, request)).rejects.toThrow();
      expect(mockAddWorkspaceApprovalRule).not.toHaveBeenCalled();
      expect(mockUpdatePreferencesFile).not.toHaveBeenCalled();
    },
  );

  it('invalidates live global rule caches after adding a rule', async () => {
    const handler = mockHandlers.get(IPC_CHANNELS.approvalRuleAdd);
    if (!handler) throw new Error('handler not registered');
    mockUpdatePreferencesFile.mockResolvedValue(undefined);
    const revisionBefore = getGlobalApprovalRulesRevision();

    await handler(
      {},
      {
        scope: 'global',
        rule: {
          id: 'rule-1',
          behavior: 'deny',
          target: { kind: 'command', pattern: 'git push *' },
          createdAt: '2026-07-28T00:00:00.000Z',
          origin: 'settings',
        },
      },
    );

    expect(getGlobalApprovalRulesRevision()).toBe(revisionBefore + 1);
  });

  it.each(['project', 'global'] as const)(
    'validates %s rule IDs before removing',
    async (scope) => {
      const handler = mockHandlers.get(IPC_CHANNELS.approvalRuleRemove);
      if (!handler) throw new Error('handler not registered');
      const request = {
        scope,
        ...(scope === 'project' ? { workspaceId: 'workspace-1' } : {}),
        ruleId: 'Not Valid!',
      };

      await expect(handler({}, request)).rejects.toThrow();
      expect(mockRemoveWorkspaceApprovalRule).not.toHaveBeenCalled();
      expect(mockUpdatePreferencesFile).not.toHaveBeenCalled();
    },
  );
});

describe('approval prompts answered from a paired computer', () => {
  const mainWindow = { id: 1 };
  const bridge = { id: 2 };
  const request = {
    requestId: 'request-1',
    projectId: 'project-1',
    worktreeId: 'worktree-1',
    chatId: 'chat-1',
  };

  beforeEach(() => {
    mockHandlers.clear();
    jest.clearAllMocks();
    setApprovalOwnerResolver((sender) =>
      sender === bridge ? mainWindow : sender,
    );
    registerApprovalHandlers();
  });

  afterEach(() => {
    setApprovalOwnerResolver(null);
  });

  function handler(channel: string): (...args: unknown[]) => unknown {
    const found = mockHandlers.get(channel);
    if (!found) throw new Error(`${channel} not registered`);
    return found;
  }

  it('lists, answers, and dismisses as the window that owns the prompts', () => {
    handler(IPC_CHANNELS.approvalPendingRequests)({ sender: bridge });
    expect(mockPendingApprovalRequests).toHaveBeenCalledWith(mainWindow);

    handler(IPC_CHANNELS.approvalRespond)(
      { sender: bridge },
      { ...request, decision: { behavior: 'allow', scope: 'once' } },
    );
    expect(mockResolveApproval).toHaveBeenLastCalledWith(
      'request-1',
      { behavior: 'allow', scope: 'once' },
      mainWindow,
      expect.objectContaining({ chatId: 'chat-1' }),
    );

    handler(IPC_CHANNELS.approvalDismiss)({ sender: bridge }, request);
    expect(mockResolveApproval).toHaveBeenLastCalledWith(
      'request-1',
      { behavior: 'deny', scope: 'once' },
      mainWindow,
      expect.objectContaining({ chatId: 'chat-1' }),
    );
  });

  it('also answers prompts the bridge itself owns', () => {
    mockResolveApproval.mockImplementation(
      (_id: string, _decision: unknown, owner: unknown) => owner === bridge,
    );
    mockPendingApprovalRequests.mockImplementation((owner: unknown) =>
      owner === bridge
        ? [{ requestId: 'bridge-1' }]
        : [{ requestId: 'main-1' }],
    );
    expect(
      handler(IPC_CHANNELS.approvalPendingRequests)({ sender: bridge }),
    ).toEqual([{ requestId: 'bridge-1' }, { requestId: 'main-1' }]);
    expect(
      handler(IPC_CHANNELS.approvalRespond)(
        { sender: bridge },
        { ...request, decision: { behavior: 'allow', scope: 'once' } },
      ),
    ).toBe(true);
  });

  it('keeps any other sender as the owner it is', () => {
    const other = { id: 3 };
    handler(IPC_CHANNELS.approvalPendingRequests)({ sender: other });
    expect(mockPendingApprovalRequests).toHaveBeenCalledWith(other);
  });
});
