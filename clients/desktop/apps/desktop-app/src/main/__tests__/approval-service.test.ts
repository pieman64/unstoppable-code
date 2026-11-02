import {
  FAIL_CLOSED_MESSAGE,
  USER_DENIED_MESSAGE,
  savedRuleDeniedMessage,
} from '@canopy/protocol/approvals';
import * as approvalEngine from '@canopy/desktop-shared/lib/approval-engine';
import {
  CODE_REVIEW_CHAT_PROJECT_ID,
  IPC_CHANNELS,
  STANDALONE_CHAT_PROJECT_ID,
} from '@canopy/desktop-shared/types';
import type * as FsPromises from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import type {
  ApprovalCheck,
  ApprovalPromptDecision,
  ApprovalRule,
  ApprovalsFile,
  ChatTabsFile,
  PersistedChatTab,
} from '@canopy/desktop-shared/types';
import type { WorkspaceApprovalsManifest } from '../lib/workspace-approvals-manifest';
import type { WorkspaceApprovalsReadResult } from '../lib/approvals-persistence';
import type { ChatStateService } from '../services/chat-state-service';

const mockRealpath = jest.fn<Promise<string>, [string]>();
const mockLstat = jest.fn<Promise<Pick<Stats, 'isSymbolicLink'>>, [string]>();
jest.mock('node:fs/promises', () => ({
  ...jest.requireActual<typeof FsPromises>('node:fs/promises'),
  realpath: (path: string): Promise<string> => mockRealpath(path),
  lstat: (path: string): Promise<Pick<Stats, 'isSymbolicLink'>> =>
    mockLstat(path),
}));

const mockReadWorkspaceApprovals = jest.fn<Promise<ApprovalsFile>, [string]>();
let mockWorkspaceApprovalsStatus: 'ok' | 'missing' | 'unreadable' = 'ok';
const mockAddWorkspaceApprovalRule = jest.fn<
  Promise<ApprovalsFile>,
  [string, ApprovalRule]
>();
const mockRemoveWorkspaceApprovalRule = jest.fn<
  Promise<ApprovalsFile>,
  [string, string]
>();
jest.mock('../lib/approvals-persistence', () => ({
  getWorkspaceApprovalsFilePath: (workspaceId: string): string =>
    `/workspace/${workspaceId}/approvals.json`,
  readWorkspaceApprovalsResult: async (
    workspaceId: string,
  ): Promise<WorkspaceApprovalsReadResult> => ({
    file: await mockReadWorkspaceApprovals(workspaceId),
    status: mockWorkspaceApprovalsStatus,
  }),
  addWorkspaceApprovalRule: (
    workspaceId: string,
    rule: ApprovalRule,
  ): Promise<ApprovalsFile> => mockAddWorkspaceApprovalRule(workspaceId, rule),
  removeWorkspaceApprovalRule: (
    workspaceId: string,
    ruleId: string,
  ): Promise<ApprovalsFile> =>
    mockRemoveWorkspaceApprovalRule(workspaceId, ruleId),
}));

jest.mock('../lib/paths', () => ({
  getPreferencesFilePath: (): string => '/data/preferences.json',
  getMigrationsFilePath: (): string => '/data/migrations.json',
}));

const mockReadWorkspaceApprovalsManifest = jest.fn<
  Promise<WorkspaceApprovalsManifest>,
  [string]
>();
jest.mock('../lib/workspace-approvals-manifest', () => ({
  readWorkspaceApprovalsManifest: (
    workspaceId: string,
  ): Promise<WorkspaceApprovalsManifest> =>
    mockReadWorkspaceApprovalsManifest(workspaceId),
}));

const mockGetCodeReviewTargetSync = jest.fn();
jest.mock('../lib/code-review-registry', () => ({
  getCodeReviewTargetSync: (...args: unknown[]): unknown =>
    mockGetCodeReviewTargetSync(...args),
}));

const mockGetPlanExploreTargetSync = jest.fn();
jest.mock('../lib/plan-explore-registry', () => ({
  getPlanExploreTargetSync: (...args: unknown[]): unknown =>
    mockGetPlanExploreTargetSync(...args),
}));

interface FakePreferences {
  globalApprovalRules: ApprovalRule[];
}

const mockReadPreferencesFile = jest.fn<Promise<FakePreferences>, []>();
let mockPreferencesLoadError: Error | null = null;
const mockUpdatePreferencesFile = jest.fn<
  Promise<FakePreferences>,
  [(existing: FakePreferences) => Partial<FakePreferences>]
>();
jest.mock('../lib/preferences-store', () => ({
  readPreferencesFileDetailed: async (): Promise<{
    preferences: Awaited<ReturnType<typeof mockReadPreferencesFile>>;
    authority: 'ok' | 'unreadable';
  }> => ({
    preferences: await mockReadPreferencesFile(),
    authority: mockPreferencesLoadError !== null ? 'unreadable' : 'ok',
  }),
  peekPreferencesLoadError: (): Error | null => mockPreferencesLoadError,
  readPreferencesFile: (): Promise<FakePreferences> =>
    mockReadPreferencesFile(),
  updatePreferencesFile: (
    updater: (existing: FakePreferences) => Partial<FakePreferences>,
  ): Promise<FakePreferences> => mockUpdatePreferencesFile(updater),
}));

const mockRequestApprovalFromRenderer = jest.fn<
  Promise<ApprovalPromptDecision>,
  [unknown]
>();
jest.mock('../approvals/prompt-bridge', () => ({
  requestApprovalFromRenderer: (
    options: unknown,
  ): Promise<ApprovalPromptDecision> => {
    // Mirror the real bridge: hand the caller the requestId of the prompt it
    // just registered, so the handle can find its own standing card.
    const onRegistered = isRecord(options) ? options.onRegistered : undefined;
    if (
      isRegistrationCallback(onRegistered) &&
      nextPromptRequestId !== undefined
    ) {
      onRegistered(nextPromptRequestId);
    }
    const onAwaitingUser = isRecord(options)
      ? options.onAwaitingUser
      : undefined;
    if (isAwaitingUserCallback(onAwaitingUser)) onAwaitingUser();
    return mockRequestApprovalFromRenderer(options);
  },
}));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isAwaitingUserCallback(value: unknown): value is () => void {
  return typeof value === 'function';
}

function isRegistrationCallback(
  value: unknown,
): value is (requestId: string) => void {
  return typeof value === 'function';
}

/** requestId the mocked bridge reports for the next prompt it registers. */
let nextPromptRequestId: string | undefined;

const mockRejectAllApprovalsForSession = jest.fn<void, [string, string?]>();
const mockResolveApprovalFromMain = jest.fn<
  boolean,
  [string, string, ApprovalPromptDecision]
>();
jest.mock('../approvals/pending-approvals', () => ({
  rejectAllApprovalsForSession: (sessionKey: string, reason?: string): void => {
    if (reason === undefined) {
      mockRejectAllApprovalsForSession(sessionKey);
    } else {
      mockRejectAllApprovalsForSession(sessionKey, reason);
    }
  },
  resolveApprovalFromMain: (
    requestId: string,
    sessionKey: string,
    decision: ApprovalPromptDecision,
  ): boolean => mockResolveApprovalFromMain(requestId, sessionKey, decision),
}));

const mockSendToWindow = jest.fn<boolean, unknown[]>();
jest.mock('../lib/window-send', () => ({
  sendToWindow: (...args: unknown[]): boolean => mockSendToWindow(...args),
}));

type UpdateCompatibilityTab = ChatStateService['updateCompatibilityTab'];
function emptyCompatibilityTabResult(
  updated: boolean = true,
): Awaited<ReturnType<UpdateCompatibilityTab>> {
  const tabsFile: ChatTabsFile = {
    version: 1,
    tabs: [],
    activeTabId: '',
  };
  // Preserve the legacy no-selection value while keeping the typed fixture boundary current.
  Reflect.set(tabsFile, 'activeTabId', null);
  return { tabsFile, updated };
}

// These updater tests intentionally provide partial legacy tabs to exercise only projected fields.
function legacyPartialPersistedChatTab(
  tab: Partial<PersistedChatTab>,
): PersistedChatTab {
  return tab as unknown as PersistedChatTab;
}

const mockUpdateCompatibilityTab = jest.fn<
  ReturnType<UpdateCompatibilityTab>,
  Parameters<UpdateCompatibilityTab>
>();
type ObserveTurnPause = ChatStateService['commitTurnPause'];
const mockObserveTurnPause = jest.fn<
  ReturnType<ObserveTurnPause>,
  Parameters<ObserveTurnPause>
>();
jest.mock('../services/chat-state-service', () => ({
  getChatStateService: (): {
    updateCompatibilityTab: UpdateCompatibilityTab;
    commitTurnPause: ObserveTurnPause;
  } => ({
    commitTurnPause: mockObserveTurnPause,
    updateCompatibilityTab: mockUpdateCompatibilityTab,
  }),
}));

const mockLogMainProcessWarn = jest.fn<void, [string, unknown]>();
jest.mock('../lib/main-process-logging', () => ({
  logMainProcessWarn: (message: string, context: unknown): void =>
    mockLogMainProcessWarn(message, context),
}));

const mockRecordSessionDiagnostic = jest.fn<void, [unknown]>();
jest.mock('../observability', () => ({
  getObservabilityService: (): {
    recordSessionDiagnostic: jest.Mock;
  } => ({
    recordSessionDiagnostic: mockRecordSessionDiagnostic,
  }),
}));

import {
  createApprovalSession,
  type ApprovalCheckDisplay,
  type ApprovalSessionContext,
} from '../approvals/approval-service';
import {
  markGlobalApprovalRulesChanged,
  markWorkspaceApprovalRulesChanged,
} from '../approvals/rule-revisions';
import {
  reevaluatePendingApprovalsForChat,
  requestChatApproval,
  resetApprovalSessionRegistryForTests,
} from '../approvals/approval-session-registry';
import {
  clearLiveApprovalMode,
  setLiveApprovalMode,
} from '../approvals/live-approval-modes';

const emptyApprovalsFile: ApprovalsFile = { version: 1, rules: [] };

function makeCtx(
  overrides: Partial<ApprovalSessionContext> = {},
): ApprovalSessionContext {
  return {
    sessionKey: 'session-1',
    projectId: 'proj-1',
    worktreeId: 'wt-1',
    chatId: 'chat-1',
    provider: 'claude',
    workspaceRoot: '/workspace',
    mode: 'ask',
    sessionRules: [],
    getWindow: () => null,
    ...overrides,
  };
}

function containingText(text: string): unknown {
  return expect.stringContaining(text);
}

function commandCheck(command: string): ApprovalCheck {
  return { kind: 'command', command };
}

function commandDisplay(command: string): ApprovalCheckDisplay {
  return {
    title: 'Run command',
    details: { kind: 'command', command },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRealpath.mockImplementation((path) => Promise.resolve(path));
  mockLstat.mockRejectedValue(
    Object.assign(new Error('missing'), { code: 'ENOENT' }),
  );
  mockReadWorkspaceApprovals.mockResolvedValue(emptyApprovalsFile);
  mockWorkspaceApprovalsStatus = 'ok';
  mockReadPreferencesFile.mockResolvedValue({ globalApprovalRules: [] });
  mockPreferencesLoadError = null;
  mockAddWorkspaceApprovalRule.mockResolvedValue(emptyApprovalsFile);
  mockRemoveWorkspaceApprovalRule.mockResolvedValue(emptyApprovalsFile);
  mockUpdatePreferencesFile.mockResolvedValue({ globalApprovalRules: [] });
  mockReadWorkspaceApprovalsManifest.mockResolvedValue({ rules: [] });
  mockGetCodeReviewTargetSync.mockReturnValue(null);
  mockGetPlanExploreTargetSync.mockReturnValue(null);
  mockUpdateCompatibilityTab.mockResolvedValue({
    ...emptyCompatibilityTabResult(),
  });
  nextPromptRequestId = undefined;
  mockResolveApprovalFromMain.mockReturnValue(true);
  resetApprovalSessionRegistryForTests();
  clearLiveApprovalMode('proj-1', 'wt-1', 'chat-1');
});

describe('createApprovalSession - check', () => {
  it.each([false, true])(
    'uses system attribution when a denial has no known rule tier (untracked rule: %p)',
    async (untrackedRule) => {
      const rule: ApprovalRule = {
        id: 'untracked',
        behavior: 'deny',
        target: { kind: 'command', pattern: 'git status' },
        createdAt: '2026-10-24',
        origin: 'settings',
      };
      const evaluate = jest
        .spyOn(approvalEngine, 'evaluateApproval')
        .mockReturnValue({
          outcome: 'deny',
          ...(untrackedRule ? { matchedRule: rule } : {}),
        });
      const handle = createApprovalSession(makeCtx());
      try {
        await expect(
          handle.check(
            commandCheck('git status'),
            commandDisplay('git status'),
          ),
        ).resolves.toEqual({
          decision: 'deny',
          message: 'Denied by the approval policy.',
        });
        expect(mockRequestApprovalFromRenderer).not.toHaveBeenCalled();
        expect(mockUpdateCompatibilityTab).not.toHaveBeenCalled();
      } finally {
        handle.dispose();
        evaluate.mockRestore();
      }
    },
  );

  it.each(['session', 'project', 'global', 'repository'] as const)(
    'attributes a saved %s deny rule without prompting or a safety receipt',
    async (scope) => {
      const rule: ApprovalRule = {
        id: 'saved-deny',
        behavior: 'deny',
        target: { kind: 'command', pattern: 'git status' },
        createdAt: '2026-10-24',
        origin: scope === 'repository' ? 'canopy-json' : 'settings',
      };
      const ctx = makeCtx();
      if (scope === 'session') ctx.sessionRules.push(rule);
      if (scope === 'project')
        mockReadWorkspaceApprovals.mockResolvedValue({
          version: 1,
          rules: [rule],
        });
      if (scope === 'global')
        mockReadPreferencesFile.mockResolvedValue({
          globalApprovalRules: [rule],
        });
      if (scope === 'repository')
        mockReadWorkspaceApprovalsManifest.mockResolvedValue({ rules: [rule] });
      const handle = createApprovalSession(ctx);

      await expect(
        handle.check(commandCheck('git status'), commandDisplay('git status')),
      ).resolves.toEqual({
        decision: 'deny',
        message: `Blocked by a saved deny rule (${scope} scope). This call cannot be approved from a prompt while the rule exists. Do not retry or repackage the blocked operation.`,
      });
      expect(mockRequestApprovalFromRenderer).not.toHaveBeenCalled();
      expect(mockUpdateCompatibilityTab).not.toHaveBeenCalled();
      expect(mockRecordSessionDiagnostic).toHaveBeenCalledTimes(1);
      expect(mockRecordSessionDiagnostic).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'approval_decision',
          decision: 'deny',
          scope: scope === 'repository' ? 'project' : scope,
        }),
      );
      handle.dispose();
    },
  );

  it.each([
    undefined,
    '',
    ' \n\t ',
    'Not on this branch.',
    'First line.\nKeep this detail.',
  ])('attributes explicit denial with reason %p', async (reason) => {
    mockRequestApprovalFromRenderer.mockResolvedValue({
      behavior: 'deny',
      scope: 'once',
      message: reason,
      stopTurn: true,
    });
    const handle = createApprovalSession(makeCtx());
    await expect(
      handle.check(commandCheck('git status'), commandDisplay('git status')),
    ).resolves.toEqual({
      decision: 'deny',
      stopTurn: true,
      message: reason?.trim()
        ? `The user denied this tool call: ${reason}`
        : 'The user denied this tool call.',
    });
    handle.dispose();
  });

  it.each(['session', 'project', 'global'] as const)(
    'attributes failed %s rule persistence according to the current response',
    async (scope) => {
      for (const behavior of ['deny', 'allow'] as const) {
        mockRequestApprovalFromRenderer.mockResolvedValue({
          behavior,
          scope,
          target: { kind: 'command', pattern: 'git status' },
          message: 'Do not publish.\nUse another branch.',
          stopTurn: true,
        });
        const failure = new Error('Rule persistence unavailable');
        mockAddWorkspaceApprovalRule.mockRejectedValue(failure);
        mockUpdatePreferencesFile.mockRejectedValue(failure);
        mockUpdateCompatibilityTab.mockImplementation(
          (_scope, _chatId, _updater, operationId?: string) => {
            if (operationId?.startsWith('approval-session-rule:'))
              return Promise.reject(failure);
            return Promise.resolve(emptyCompatibilityTabResult());
          },
        );
        const ctx = makeCtx();
        const handle = createApprovalSession(ctx);
        await expect(
          handle.check(
            commandCheck('git status'),
            commandDisplay('git status'),
          ),
        ).resolves.toEqual({
          decision: 'deny',
          ...(behavior === 'deny' ? { stopTurn: true } : {}),
          message:
            behavior === 'deny'
              ? 'The user denied this tool call: Do not publish.\nUse another branch.'
              : 'Approval prompt unavailable; denied by default.',
        });
        expect(ctx.sessionRules).toEqual([]);
        handle.dispose();
      }
    },
  );

  it.each(['deny', 'allow'] as const)(
    'fails closed when a %s session rule cannot be committed',
    async (behavior) => {
      mockRequestApprovalFromRenderer.mockResolvedValue({
        behavior,
        scope: 'session',
        target: { kind: 'command', pattern: 'git status' },
      });
      mockUpdateCompatibilityTab.mockImplementation(
        (_scope, _chatId, _updater, operationId?: string) =>
          Promise.resolve(
            emptyCompatibilityTabResult(
              operationId === undefined ||
                !operationId.startsWith('approval-session-rule:'),
            ),
          ),
      );
      const ctx = makeCtx();
      const handle = createApprovalSession(ctx);
      await expect(
        handle.check(commandCheck('git status'), commandDisplay('git status')),
      ).resolves.toEqual({
        decision: 'deny',
        message:
          behavior === 'deny'
            ? 'The user denied this tool call.'
            : 'Approval prompt unavailable; denied by default.',
      });
      expect(ctx.sessionRules).toEqual([]);
      handle.dispose();
    },
  );

  it.each(['invalidate', 'dispose'] as const)(
    'uses the system message after %s regardless of a late response',
    async (operation) => {
      for (const behavior of ['deny', 'allow'] as const) {
        let resolvePrompt: (decision: ApprovalPromptDecision) => void = () => {
          throw new Error('No prompt');
        };
        mockRequestApprovalFromRenderer.mockReturnValueOnce(
          new Promise((resolve) => {
            resolvePrompt = resolve;
          }),
        );
        const handle = createApprovalSession(makeCtx());
        const pending = handle.check(
          commandCheck('git status'),
          commandDisplay('git status'),
        );
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (operation === 'dispose') handle.dispose();
        else handle.invalidatePending?.();
        resolvePrompt({
          behavior,
          scope: 'global',
          target: { kind: 'command', pattern: 'git status' },
          message: 'Obsolete reason',
          stopTurn: true,
        });
        await expect(pending).resolves.toEqual({
          decision: 'deny',
          message: 'Approval prompt unavailable; denied by default.',
        });
        expect(mockUpdatePreferencesFile).not.toHaveBeenCalled();
        handle.dispose();
      }
    },
  );

  it.each(['neither', 'session', 'display', 'both'])(
    'calls the per-check prompt callback once after the session callback when %s throws',
    async (throws) => {
      const order: string[] = [];
      mockRequestApprovalFromRenderer.mockResolvedValue({
        behavior: 'allow',
        scope: 'once',
      });
      const sessionCallback = jest.fn(() => {
        order.push('session');
        if (throws === 'session' || throws === 'both')
          throw new Error('session callback');
      });
      const displayCallback = jest.fn(() => {
        order.push('display');
        if (throws === 'display' || throws === 'both')
          throw new Error('display callback');
      });
      const handle = createApprovalSession(
        makeCtx({ onAwaitingUser: sessionCallback }),
      );
      const display = {
        ...commandDisplay('ls'),
        onAwaitingUser: displayCallback,
      };
      await expect(handle.check(commandCheck('ls'), display)).resolves.toEqual({
        decision: 'allow',
      });
      expect(order).toEqual(['session', 'display']);
      expect(sessionCallback).toHaveBeenCalledTimes(1);
      expect(displayCallback).toHaveBeenCalledTimes(1);
    },
  );

  it('never calls prompt callbacks for an auto-allowed check', async () => {
    const sessionCallback = jest.fn();
    const displayCallback = jest.fn();
    const handle = createApprovalSession(
      makeCtx({ mode: 'full-access', onAwaitingUser: sessionCallback }),
    );
    const display = {
      ...commandDisplay('ls'),
      onAwaitingUser: displayCallback,
    };
    await expect(handle.check(commandCheck('ls'), display)).resolves.toEqual({
      decision: 'allow',
    });
    expect(sessionCallback).not.toHaveBeenCalled();
    expect(displayCallback).not.toHaveBeenCalled();
    expect(mockRequestApprovalFromRenderer).not.toHaveBeenCalled();
  });

  it('returns a specific safety denial and commits its correlated receipt without prompting', async () => {
    const handle = createApprovalSession(makeCtx());
    const command = 'git push --force origin HEAD';
    const outcome = await handle.check(commandCheck(command), {
      ...commandDisplay(command),
      toolUseId: 'tool-1',
      subagentId: 'child-1',
    });
    expect(outcome).toEqual({
      decision: 'deny',
      message: containingText('Blocked by a safety rule (force-push)'),
    });
    expect(mockRequestApprovalFromRenderer).not.toHaveBeenCalled();
    expect(mockRecordSessionDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'approval_decision',
        approvalDecisionSource: 'safety-rule',
      }),
    );
    expect(mockUpdateCompatibilityTab).toHaveBeenCalledWith(
      { projectId: 'proj-1', worktreeId: 'wt-1' },
      'chat-1',
      expect.any(Function),
      expect.stringContaining('approval-safety-denied:'),
    );
    handle.dispose();
  });
  it('routes a non-chat Cursor write through policy and renderer without creating chat timer state', async (): Promise<void> => {
    mockRequestApprovalFromRenderer.mockResolvedValue({
      behavior: 'allow',
      scope: 'once',
    });
    const handle = createApprovalSession(
      makeCtx({ provider: 'cursor', trackChatTurn: false }),
    );
    expect(
      await handle.check(
        { kind: 'file-write', path: '/workspace/proj-1/result.txt' },
        {
          title: 'Create test file',
          details: { kind: 'file-write', path: '/workspace/proj-1/result.txt' },
        },
      ),
    ).toEqual({ decision: 'allow' });
    const expectedEvent: unknown = expect.objectContaining({
      provider: 'cursor',
      surface: 'non-chat',
      title: 'Create test file',
    });
    expect(mockRequestApprovalFromRenderer).toHaveBeenCalledWith(
      expect.objectContaining({ event: expectedEvent }),
    );
    expect(mockUpdateCompatibilityTab).not.toHaveBeenCalled();
    handle.dispose();
  });
  it('prompts before a remembered command writes the workspace policy file', async () => {
    mockRequestApprovalFromRenderer.mockResolvedValue({
      behavior: 'deny',
      scope: 'once',
    });
    mockReadPreferencesFile.mockResolvedValue({
      globalApprovalRules: [
        {
          id: 'allow-copy',
          behavior: 'allow',
          target: { kind: 'command', pattern: 'cp payload *' },
          createdAt: '2026-08-05T00:00:00.000Z',
          origin: 'settings',
        },
      ],
    });
    for (const command of [
      'cp payload /workspace/proj-1/approvals.json',
      'cp payload approvals.json',
    ]) {
      const handle = createApprovalSession(makeCtx());
      const outcome = await handle.check(
        { kind: 'command', command, cwd: '/workspace/proj-1' },
        commandDisplay(command),
      );

      expect(outcome).toEqual({
        decision: 'deny',
        message: USER_DENIED_MESSAGE,
      });
    }
    expect(mockRequestApprovalFromRenderer).toHaveBeenCalledTimes(2);
  });

  it('prompts before an Auto-mode write to the project policy file', async () => {
    mockRequestApprovalFromRenderer.mockResolvedValue({
      behavior: 'deny',
      scope: 'once',
    });
    mockReadPreferencesFile.mockResolvedValue({
      globalApprovalRules: [
        {
          id: 'allow-workspace',
          behavior: 'allow',
          target: { kind: 'file-write', path: '/workspace/**' },
          createdAt: '2026-08-05T00:00:00.000Z',
          origin: 'settings',
        },
      ],
    });
    const handle = createApprovalSession(
      makeCtx({ mode: 'auto', workspaceRoot: '/workspace' }),
    );

    const outcome = await handle.check(
      { kind: 'file-write', path: '/workspace/proj-1/approvals.json' },
      {
        title: 'Write file',
        details: {
          kind: 'file-write',
          path: '/workspace/proj-1/approvals.json',
        },
      },
    );

    expect(outcome).toEqual({ decision: 'deny', message: USER_DENIED_MESSAGE });
    expect(mockRequestApprovalFromRenderer).toHaveBeenCalledTimes(1);
  });

  it('prompts before an Auto-mode write to global approval preferences', async () => {
    mockRequestApprovalFromRenderer.mockResolvedValue({
      behavior: 'deny',
      scope: 'once',
    });
    mockReadPreferencesFile.mockResolvedValue({
      globalApprovalRules: [
        {
          id: 'allow-data',
          behavior: 'allow',
          target: { kind: 'file-write', path: '/data/**' },
          createdAt: '2026-08-05T00:00:00.000Z',
          origin: 'settings',
        },
      ],
    });
    const handle = createApprovalSession(
      makeCtx({ mode: 'auto', workspaceRoot: '/workspace' }),
    );

    const outcome = await handle.check(
      { kind: 'file-write', path: '/data/preferences.json' },
      {
        title: 'Write file',
        details: {
          kind: 'file-write',
          path: '/data/preferences.json',
        },
      },
    );

    expect(outcome).toEqual({ decision: 'deny', message: USER_DENIED_MESSAGE });
    expect(mockRequestApprovalFromRenderer).toHaveBeenCalledTimes(1);
  });

  it('probes case sensitivity using the project path when it is empty', async () => {
    const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(
      process,
      'platform',
    );
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'darwin',
    });
    const workspaceRoot = '/Volumes/CaseSensitive/Repo';
    mockRealpath.mockImplementation((path) => {
      if (path === '/volumes/CaseSensitive/Repo') {
        return Promise.resolve(workspaceRoot);
      }
      if (path === '/Volumes/CaseSensitive/repo') {
        return Promise.reject(
          Object.assign(new Error('missing'), { code: 'ENOENT' }),
        );
      }
      return Promise.resolve(path);
    });
    mockRequestApprovalFromRenderer.mockResolvedValue({
      behavior: 'deny',
      scope: 'once',
    });

    try {
      const handle = createApprovalSession(
        makeCtx({ mode: 'auto', workspaceRoot }),
      );
      const outcome = await handle.check(
        {
          kind: 'file-write',
          path: '/Volumes/CaseSensitive/repo/secret.txt',
        },
        {
          title: 'Write file',
          details: {
            kind: 'file-write',
            path: '/Volumes/CaseSensitive/repo/secret.txt',
          },
        },
      );

      expect(outcome.decision).toBe('deny');
      expect(mockRequestApprovalFromRenderer).toHaveBeenCalledTimes(1);
      expect(mockRealpath).toHaveBeenCalledWith('/Volumes/CaseSensitive/repo');
    } finally {
      if (originalPlatformDescriptor) {
        Object.defineProperty(process, 'platform', originalPlatformDescriptor);
      }
    }
  });

  it('matches deny rules by case in an empty case-insensitive project', async () => {
    const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(
      process,
      'platform',
    );
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'darwin',
    });
    const workspaceRoot = '/Volumes/Default/Repo';
    mockRealpath.mockImplementation((path) => {
      if (
        path === '/Volumes/Default/repo' ||
        path === '/Volumes/Default/Repo'
      ) {
        return Promise.resolve(workspaceRoot);
      }
      if (
        path === '/Volumes/Default/Repo/secret' ||
        path === '/Volumes/Default/Repo/secret/file.ts'
      ) {
        return Promise.reject(
          Object.assign(new Error('missing'), { code: 'ENOENT' }),
        );
      }
      return Promise.resolve(path);
    });
    mockReadWorkspaceApprovals.mockResolvedValue({
      version: 1,
      rules: [
        {
          id: 'deny-secret',
          behavior: 'deny',
          target: {
            kind: 'file-write',
            path: '/Volumes/Default/Repo/Secret/**',
          },
          createdAt: '2026-07-27T00:00:00.000Z',
          origin: 'settings',
        },
      ],
    });

    try {
      const handle = createApprovalSession(
        makeCtx({ mode: 'auto', workspaceRoot }),
      );
      const outcome = await handle.check(
        {
          kind: 'file-write',
          path: '/Volumes/Default/Repo/secret/file.ts',
        },
        {
          title: 'Write file',
          details: {
            kind: 'file-write',
            path: '/Volumes/Default/Repo/secret/file.ts',
          },
        },
      );

      expect(outcome.decision).toBe('deny');
      expect(mockRequestApprovalFromRenderer).not.toHaveBeenCalled();
    } finally {
      if (originalPlatformDescriptor) {
        Object.defineProperty(process, 'platform', originalPlatformDescriptor);
      }
    }
  });

  it('matches command deny rules case-insensitively on case-insensitive filesystems', async () => {
    const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(
      process,
      'platform',
    );
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'win32',
    });
    mockReadWorkspaceApprovals.mockResolvedValue({
      version: 1,
      rules: [
        {
          id: 'deny-publish',
          behavior: 'deny',
          target: { kind: 'command', pattern: 'npm publish *' },
          createdAt: '2026-07-30T00:00:00.000Z',
          origin: 'settings',
        },
      ],
    });

    try {
      const handle = createApprovalSession(makeCtx({ mode: 'full-access' }));
      const outcome = await handle.check(
        commandCheck('NPM publish package'),
        commandDisplay('NPM publish package'),
      );

      expect(outcome.decision).toBe('deny');
      expect(mockRequestApprovalFromRenderer).not.toHaveBeenCalled();
    } finally {
      if (originalPlatformDescriptor) {
        Object.defineProperty(process, 'platform', originalPlatformDescriptor);
      }
    }
  });

  it('does not auto-allow writes through a dangling symlink', async () => {
    mockRealpath.mockImplementation((path) => {
      if (path === '/workspace') {
        return Promise.resolve(path);
      }
      return Promise.reject(
        Object.assign(new Error('missing'), { code: 'ENOENT' }),
      );
    });
    mockLstat.mockImplementation((path: string) => {
      if (path === '/workspace/link') {
        return Promise.resolve({ isSymbolicLink: (): boolean => true });
      }
      return Promise.reject(
        Object.assign(new Error('missing'), { code: 'ENOENT' }),
      );
    });
    mockRequestApprovalFromRenderer.mockResolvedValue({
      behavior: 'deny',
      scope: 'once',
    });
    mockReadPreferencesFile.mockResolvedValue({
      globalApprovalRules: [
        {
          id: 'allow-workspace',
          behavior: 'allow',
          target: { kind: 'file-write', path: '/workspace/**' },
          createdAt: '2026-07-24T00:00:00.000Z',
          origin: 'settings',
        },
      ],
    });

    const handle = createApprovalSession(makeCtx({ mode: 'auto' }));
    const outcome = await handle.check(
      { kind: 'file-write', path: '/workspace/link/file.ts' },
      {
        title: 'Write file',
        details: { kind: 'file-write', path: '/workspace/link/file.ts' },
      },
    );

    expect(outcome.decision).toBe('deny');
    expect(mockRequestApprovalFromRenderer).toHaveBeenCalledTimes(1);
  });

  it('safety-denies destructive command operands resolved through a symlink', async () => {
    mockRealpath.mockImplementation((path) => {
      if (path === '/workspace/root-link') {
        return Promise.resolve('/');
      }
      if (path === '/workspace/root-link/*') {
        return Promise.reject(
          Object.assign(new Error('missing glob'), { code: 'ENOENT' }),
        );
      }
      return Promise.resolve(path);
    });
    mockLstat.mockRejectedValue(
      Object.assign(new Error('missing'), { code: 'ENOENT' }),
    );
    mockReadPreferencesFile.mockResolvedValue({
      globalApprovalRules: [
        {
          id: 'allow-rm',
          behavior: 'allow',
          target: { kind: 'command', pattern: 'rm -rf *' },
          createdAt: '2026-07-28T00:00:00.000Z',
          origin: 'settings',
        },
      ],
    });

    const ctx = makeCtx();
    const handle = createApprovalSession(ctx);
    const outcome = await handle.check(
      commandCheck('rm -rf root-link/*'),
      commandDisplay('rm -rf root-link/*'),
    );

    expect(outcome).toEqual({
      decision: 'deny',
      message: containingText('Blocked by a safety rule ('),
    });
    expect(mockRequestApprovalFromRenderer).not.toHaveBeenCalled();
  });

  it('canonicalizes native PowerShell recursive deletions before rule matching', async () => {
    mockReadPreferencesFile.mockResolvedValue({
      globalApprovalRules: [
        {
          id: 'allow-remove-item',
          behavior: 'allow',
          target: { kind: 'command', pattern: 'Remove-Item -Recurse *' },
          createdAt: '2026-07-28T00:00:00.000Z',
          origin: 'settings',
        },
      ],
    });

    for (const command of [
      'Remove-Item -Recurse -Force /',
      'Remove-Item -Recurse -Force -Path:/',
      'Remove-Item -Recurse -Force -LiteralPath:~',
      'Remove-Item -Recurse -Force -UnknownValue:/tmp/scratch',
    ]) {
      const handle = createApprovalSession(makeCtx());
      const outcome = await handle.check(
        commandCheck(command),
        commandDisplay(command),
      );

      expect(outcome).toEqual({
        decision: 'deny',
        message: containingText('Blocked by a safety rule ('),
      });
    }
    expect(mockRequestApprovalFromRenderer).not.toHaveBeenCalled();
  });

  it('resolves destructive operands against the provider cwd', async () => {
    mockReadPreferencesFile.mockResolvedValue({
      globalApprovalRules: [
        {
          id: 'allow-rm',
          behavior: 'allow',
          target: { kind: 'command', pattern: 'rm -rf *' },
          createdAt: '2026-07-28T00:00:00.000Z',
          origin: 'settings',
        },
      ],
    });

    const handle = createApprovalSession(makeCtx());
    const outcome = await handle.check(
      { kind: 'command', command: 'rm -rf tmp', cwd: '/' },
      commandDisplay('rm -rf tmp'),
    );

    expect(outcome).toEqual({
      decision: 'deny',
      message: containingText('Blocked by a safety rule ('),
    });
    expect(mockRequestApprovalFromRenderer).not.toHaveBeenCalled();
  });

  it('expands shell current-directory tildes before protected-path checks', async () => {
    mockReadPreferencesFile.mockResolvedValue({
      globalApprovalRules: [
        {
          id: 'allow-rm',
          behavior: 'allow',
          target: { kind: 'command', pattern: 'rm -rf *' },
          createdAt: '2026-07-28T00:00:00.000Z',
          origin: 'settings',
        },
      ],
    });

    const handle = createApprovalSession(makeCtx());
    const command = 'rm -rf ~+/../..';
    const outcome = await handle.check(
      { kind: 'command', command, cwd: '/workspace/nested' },
      commandDisplay(command),
    );

    expect(outcome).toEqual({
      decision: 'deny',
      message: containingText('Blocked by a safety rule ('),
    });
    expect(mockRequestApprovalFromRenderer).not.toHaveBeenCalled();
  });

  it('expands current-username tildes before protected-path checks', async () => {
    mockReadPreferencesFile.mockResolvedValue({
      globalApprovalRules: [
        {
          id: 'allow-rm',
          behavior: 'allow',
          target: { kind: 'command', pattern: 'rm -rf *' },
          createdAt: '2026-07-28T00:00:00.000Z',
          origin: 'settings',
        },
      ],
    });

    for (const operand of [
      `~${userInfo().username}`,
      `~${userInfo().username}/Documents`,
      `'~${userInfo().username}/Documents'`,
      `"~${userInfo().username}/Documents"`,
    ]) {
      const handle = createApprovalSession(makeCtx());
      const command = `rm -rf ${operand}`;
      const outcome = await handle.check(
        { kind: 'command', command, cwd: '/workspace' },
        commandDisplay(command),
      );

      expect(outcome).toEqual({
        decision: 'deny',
        message: containingText('Blocked by a safety rule ('),
      });
      expect(mockRequestApprovalFromRenderer).not.toHaveBeenCalled();
    }
    expect(mockRealpath).toHaveBeenCalledWith(homedir());
  });

  it('fails closed when a username-form tilde cannot be resolved safely', async () => {
    mockReadPreferencesFile.mockResolvedValue({
      globalApprovalRules: [
        {
          id: 'allow-rm',
          behavior: 'allow',
          target: { kind: 'command', pattern: 'rm -rf *' },
          createdAt: '2026-07-28T00:00:00.000Z',
          origin: 'settings',
        },
      ],
    });

    const handle = createApprovalSession(makeCtx());
    const command = 'rm -rf ~unknown-canopy-user/Documents';
    const outcome = await handle.check(
      { kind: 'command', command, cwd: '/workspace' },
      commandDisplay(command),
    );

    expect(outcome).toEqual({
      decision: 'deny',
      message: containingText('Blocked by a safety rule ('),
    });
    expect(mockRequestApprovalFromRenderer).not.toHaveBeenCalled();
  });

  it('fails closed when destructive operands depend on shell OLDPWD', async () => {
    mockReadPreferencesFile.mockResolvedValue({
      globalApprovalRules: [
        {
          id: 'allow-rm',
          behavior: 'allow',
          target: { kind: 'command', pattern: 'rm -rf *' },
          createdAt: '2026-07-28T00:00:00.000Z',
          origin: 'settings',
        },
      ],
    });

    const handle = createApprovalSession(makeCtx());
    const command = 'rm -rf ~-/Downloads';
    const outcome = await handle.check(
      { kind: 'command', command, cwd: '/workspace' },
      commandDisplay(command),
    );

    expect(outcome).toEqual({
      decision: 'deny',
      message: containingText('Blocked by a safety rule ('),
    });
    expect(mockRequestApprovalFromRenderer).not.toHaveBeenCalled();
  });

  it('tracks direct cd segments before destructive commands', async () => {
    mockReadPreferencesFile.mockResolvedValue({
      globalApprovalRules: [
        {
          id: 'allow-rm',
          behavior: 'allow',
          target: { kind: 'command', pattern: 'cd *' },
          createdAt: '2026-07-28T00:00:00.000Z',
          origin: 'settings',
        },
      ],
    });

    const command = 'cd / && rm -rf tmp';
    const handle = createApprovalSession(makeCtx());
    const outcome = await handle.check(
      { kind: 'command', command, cwd: '/workspace' },
      commandDisplay(command),
    );

    expect(outcome).toEqual({
      decision: 'deny',
      message: containingText('Blocked by a safety rule ('),
    });
    expect(mockRequestApprovalFromRenderer).not.toHaveBeenCalled();
  });

  it('fails closed when cd depends on shell-maintained OLDPWD', async () => {
    mockReadPreferencesFile.mockResolvedValue({
      globalApprovalRules: [
        {
          id: 'allow-rm',
          behavior: 'allow',
          target: { kind: 'command', pattern: '*' },
          createdAt: '2026-07-28T00:00:00.000Z',
          origin: 'settings',
        },
      ],
    });

    const command = 'cd /tmp && cd - && rm -rf Documents';
    const handle = createApprovalSession(makeCtx());
    const outcome = await handle.check(
      { kind: 'command', command, cwd: homedir() },
      commandDisplay(command),
    );

    expect(outcome).toEqual({
      decision: 'deny',
      message: containingText('Blocked by a safety rule ('),
    });
    expect(mockRequestApprovalFromRenderer).not.toHaveBeenCalled();
  });

  it('tracks wrapped cd and direct pushd segments before destructive commands', async () => {
    mockReadPreferencesFile.mockResolvedValue({
      globalApprovalRules: [
        {
          id: 'allow-rm',
          behavior: 'allow',
          target: { kind: 'command', pattern: '*' },
          createdAt: '2026-07-28T00:00:00.000Z',
          origin: 'settings',
        },
      ],
    });

    for (const command of [
      'command cd / && rm -rf tmp',
      'builtin cd / && rm -rf tmp',
      'builtin pushd / && rm -rf tmp',
      'pushd / && rm -rf tmp',
    ]) {
      const handle = createApprovalSession(makeCtx());
      const outcome = await handle.check(
        { kind: 'command', command, cwd: '/workspace' },
        commandDisplay(command),
      );

      expect(outcome).toEqual({
        decision: 'deny',
        message: containingText('Blocked by a safety rule ('),
      });
      expect(mockRequestApprovalFromRenderer).not.toHaveBeenCalled();
    }
  });

  it('fails closed when CDPATH can change the shell-resolved cwd', async () => {
    mockReadPreferencesFile.mockResolvedValue({
      globalApprovalRules: [
        {
          id: 'allow-rm',
          behavior: 'allow',
          target: { kind: 'command', pattern: '*' },
          createdAt: '2026-07-28T00:00:00.000Z',
          origin: 'settings',
        },
      ],
    });

    const command = 'CDPATH=/ cd Users && rm -rf tirish';
    const handle = createApprovalSession(makeCtx());
    const outcome = await handle.check(
      { kind: 'command', command, cwd: '/workspace' },
      commandDisplay(command),
    );

    expect(outcome).toEqual({
      decision: 'deny',
      message: containingText('Blocked by a safety rule ('),
    });
    expect(mockRequestApprovalFromRenderer).not.toHaveBeenCalled();
  });

  it('fails closed when a tilde-based cd obscures the destructive cwd', async () => {
    mockReadPreferencesFile.mockResolvedValue({
      globalApprovalRules: [
        {
          id: 'allow-rm',
          behavior: 'allow',
          target: { kind: 'command', pattern: '*' },
          createdAt: '2026-07-28T00:00:00.000Z',
          origin: 'settings',
        },
      ],
    });

    const command = 'cd ~ && rm -rf Downloads';
    const handle = createApprovalSession(makeCtx());
    const outcome = await handle.check(
      { kind: 'command', command, cwd: '/workspace' },
      commandDisplay(command),
    );

    expect(outcome).toEqual({
      decision: 'deny',
      message: containingText('Blocked by a safety rule ('),
    });
    expect(mockRequestApprovalFromRenderer).not.toHaveBeenCalled();
  });

  it('fails closed when env changes cwd before a destructive command', async () => {
    mockReadPreferencesFile.mockResolvedValue({
      globalApprovalRules: [
        {
          id: 'allow-rm',
          behavior: 'allow',
          target: { kind: 'command', pattern: '*' },
          createdAt: '2026-07-28T00:00:00.000Z',
          origin: 'settings',
        },
      ],
    });

    for (const command of [
      'env -C / rm -rf tmp',
      'env -C/ rm -rf home',
      "env -S '-C / rm -rf tmp'",
    ]) {
      const handle = createApprovalSession(makeCtx());
      const outcome = await handle.check(
        { kind: 'command', command, cwd: '/workspace' },
        commandDisplay(command),
      );

      expect(outcome).toEqual({
        decision: 'deny',
        message: containingText('Blocked by a safety rule ('),
      });
      expect(mockRequestApprovalFromRenderer).not.toHaveBeenCalled();
    }
  });

  it('fails closed when directory-stack mutations obscure the destructive cwd', async () => {
    mockReadPreferencesFile.mockResolvedValue({
      globalApprovalRules: [
        {
          id: 'allow-rm',
          behavior: 'allow',
          target: { kind: 'command', pattern: '*' },
          createdAt: '2026-07-28T00:00:00.000Z',
          origin: 'settings',
        },
      ],
    });

    for (const command of [
      'pushd /; rm -rf tmp',
      'pushd / && pushd +0 && rm -rf tmp',
      'popd && rm -rf tmp',
      'dirs -c && rm -rf tmp',
    ]) {
      const handle = createApprovalSession(makeCtx());
      const outcome = await handle.check(
        { kind: 'command', command, cwd: '/workspace' },
        commandDisplay(command),
      );

      expect(outcome).toEqual({
        decision: 'deny',
        message: containingText('Blocked by a safety rule ('),
      });
      expect(mockRequestApprovalFromRenderer).not.toHaveBeenCalled();
    }
  });

  it('fails closed after alternate cwd-changing commands', async () => {
    mockReadPreferencesFile.mockResolvedValue({
      globalApprovalRules: [
        {
          id: 'allow-rm',
          behavior: 'allow',
          target: { kind: 'command', pattern: '*' },
          createdAt: '2026-07-28T00:00:00.000Z',
          origin: 'settings',
        },
      ],
    });

    for (const command of [
      'Set-Location / && rm -rf tmp',
      'sl / && rm -rf tmp',
      'chdir / && rm -rf tmp',
    ]) {
      const handle = createApprovalSession(makeCtx());
      const outcome = await handle.check(
        { kind: 'command', command, cwd: '/workspace' },
        commandDisplay(command),
      );

      expect(outcome).toEqual({
        decision: 'deny',
        message: containingText('Blocked by a safety rule ('),
      });
      expect(mockRequestApprovalFromRenderer).not.toHaveBeenCalled();
    }
  });

  it('fails closed when a cd control flow cannot prove the effective cwd', async () => {
    mockReadPreferencesFile.mockResolvedValue({
      globalApprovalRules: [
        {
          id: 'allow-rm',
          behavior: 'allow',
          target: { kind: 'command', pattern: 'cd *' },
          createdAt: '2026-07-28T00:00:00.000Z',
          origin: 'settings',
        },
      ],
    });

    const command = 'cd /; rm -rf tmp';
    const handle = createApprovalSession(makeCtx());
    const outcome = await handle.check(
      { kind: 'command', command, cwd: '/workspace' },
      commandDisplay(command),
    );

    expect(outcome).toEqual({
      decision: 'deny',
      message: containingText('Blocked by a safety rule ('),
    });
    expect(mockRequestApprovalFromRenderer).not.toHaveBeenCalled();
  });

  it('short-circuits on a matching rule without calling the prompt bridge', async () => {
    const rule: ApprovalRule = {
      id: 'r1',
      behavior: 'allow',
      target: { kind: 'command', pattern: 'ls' },
      createdAt: '2026-07-20T00:00:00.000Z',
      origin: 'settings',
    };
    mockReadPreferencesFile.mockResolvedValue({ globalApprovalRules: [rule] });

    const ctx = makeCtx();
    const handle = createApprovalSession(ctx);
    const outcome = await handle.check(
      commandCheck('ls'),
      commandDisplay('ls'),
    );

    expect(outcome).toEqual({ decision: 'allow' });
    expect(mockRequestApprovalFromRenderer).not.toHaveBeenCalled();
    expect(mockRecordSessionDiagnostic).toHaveBeenCalledTimes(1);
    expect(mockRecordSessionDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'approval_decision',
        decision: 'allow',
        scope: 'global',
        targetKind: 'command',
        chatId: 'chat-1',
        providerType: 'claude',
      }),
    );
  });

  it('evaluates a folder grant against descendant deny rules without prompting or recording', async () => {
    const rule: ApprovalRule = {
      id: 'deny-evidence',
      behavior: 'deny',
      target: { kind: 'file-write', path: 'evidence.txt' },
      createdAt: '2026-09-28T00:00:00.000Z',
      origin: 'settings',
    };
    const ctx = makeCtx();
    const handle = createApprovalSession(ctx);
    await expect(
      handle.evaluate?.({
        kind: 'file-write',
        path: ctx.workspaceRoot,
        isGrant: true,
      }),
    ).resolves.toBe('prompt');

    mockReadPreferencesFile.mockResolvedValue({ globalApprovalRules: [rule] });
    const denying = createApprovalSession(makeCtx());
    await expect(
      denying.evaluate?.({
        kind: 'file-write',
        path: ctx.workspaceRoot,
        isGrant: true,
      }),
    ).resolves.toBe('deny');
    expect(mockRequestApprovalFromRenderer).not.toHaveBeenCalled();
    expect(mockRecordSessionDiagnostic).not.toHaveBeenCalled();

    denying.dispose();
    await expect(
      denying.evaluate?.({ kind: 'file-write', path: ctx.workspaceRoot }),
    ).resolves.toBe('deny');
  });

  it('prompt -> allow-once returns allow and persists nothing', async () => {
    mockRequestApprovalFromRenderer.mockResolvedValue({
      behavior: 'allow',
      scope: 'once',
    });
    const ctx = makeCtx();

    const handle = createApprovalSession(ctx);
    const outcome = await handle.check(
      commandCheck('ls'),
      commandDisplay('ls'),
    );

    expect(outcome).toEqual({ decision: 'allow' });
    expect(ctx.sessionRules).toEqual([]);
    expect(mockAddWorkspaceApprovalRule).not.toHaveBeenCalled();
    expect(mockUpdatePreferencesFile).not.toHaveBeenCalled();
    expect(mockSendToWindow).not.toHaveBeenCalled();
  });

  it('durably pauses and resumes the active turn timer around a renderer prompt', async () => {
    mockRequestApprovalFromRenderer.mockResolvedValue({
      behavior: 'allow',
      scope: 'once',
    });
    const handle = createApprovalSession(makeCtx());

    await expect(
      handle.check(commandCheck('npm test'), commandDisplay('npm test')),
    ).resolves.toEqual({ decision: 'allow' });

    const timerMutations = mockUpdateCompatibilityTab.mock.calls.map(
      (call) => call[3],
    );
    expect(timerMutations).toEqual([
      expect.stringMatching(/^approval-turn-timer-pause:/),
      expect.stringMatching(/^approval-turn-timer-resume:/),
    ]);
  });

  it('persists releases after hidden continuation messages for sequential approvals', async () => {
    type Tab = Parameters<Parameters<UpdateCompatibilityTab>[2]>[0];
    let tab: Tab = {
      id: 'chat-1',
      title: 'Chat',
      createdAt: '2026-09-17T00:00:00Z',
      messages: [
        {
          id: 'timer',
          role: 'system',
          timestamp: 1000,
          blocks: [{ type: 'turn_timer', startedAt: 1000, completedAt: null }],
        },
        {
          id: 'delivery',
          role: 'user',
          timestamp: 2000,
          hidden: true,
          blocks: [{ type: 'text', text: 'Delegate finished' }],
        },
      ],
    };
    mockUpdateCompatibilityTab.mockImplementation((_scope, _chat, update) => {
      const updated = update(tab, undefined);
      if (updated) tab = updated;
      return Promise.resolve({
        tabsFile: { version: 1, tabs: [tab], activeTabId: tab.id },
        updated: !!updated,
      });
    });
    mockRequestApprovalFromRenderer.mockImplementation(() => {
      expect(tab.messages[0].blocks[0]).toMatchObject({
        resumedAt: null,
        pauseOwnerIds: [expect.any(String)],
      });
      return Promise.resolve({ behavior: 'allow', scope: 'once' });
    });
    const handle = createApprovalSession(makeCtx());
    for (const command of ['npm test', 'npm run build']) {
      await expect(
        handle.check(commandCheck(command), commandDisplay(command)),
      ).resolves.toEqual({ decision: 'allow' });
      expect(tab.messages[0].blocks[0]).toHaveProperty(
        'resumedAt',
        expect.any(Number),
      );
      expect(tab.messages[0].blocks[0]).not.toHaveProperty('pauseOwnerIds');
    }
    handle.dispose();
  });

  it.each([
    ['settled while the prompt was open', 'completed', true],
    ['still running', 'streaming', false],
  ] as const)(
    'completes the turn timer on release only when its turn %s',
    async (_label, statusAtRelease, completes) => {
      type Tab = Parameters<Parameters<UpdateCompatibilityTab>[2]>[0];
      let tab: Tab = {
        id: 'chat-1',
        title: 'Chat',
        createdAt: '2026-10-07T00:00:00Z',
        messages: [
          {
            id: 'timer',
            role: 'system',
            timestamp: 1000,
            blocks: [
              { type: 'turn_timer', startedAt: 1000, completedAt: null },
            ],
          },
        ],
      };
      // A delegate's approval pauses its parent's timer outside the parent's
      // event commit chain, so the parent's terminal event can commit while
      // the timer is paused; that event leaves a paused timer open.
      let status: 'streaming' | 'completed' = 'streaming';
      mockUpdateCompatibilityTab.mockImplementation((_scope, _chat, update) => {
        const updated = update(tab, { status, queuedMessageIds: [] });
        if (updated) tab = updated;
        return Promise.resolve({
          tabsFile: { version: 1, tabs: [tab], activeTabId: tab.id },
          updated: !!updated,
        });
      });
      mockRequestApprovalFromRenderer.mockImplementation(() => {
        status = statusAtRelease;
        return Promise.resolve({ behavior: 'allow', scope: 'once' });
      });
      const handle = createApprovalSession(makeCtx());

      await expect(
        handle.check(commandCheck('npm test'), commandDisplay('npm test')),
      ).resolves.toEqual({ decision: 'allow' });

      const [timer] = tab.messages[0].blocks;
      if (timer?.type !== 'turn_timer') throw new Error('Expected a timer');
      expect(timer.resumedAt).toEqual(expect.any(Number));
      expect(timer).not.toHaveProperty('pauseOwnerIds');
      expect(timer.completedAt).toBe(completes ? timer.resumedAt : null);
      handle.dispose();
    },
  );

  it('fails closed when the durable approval timer pause cannot be committed', async () => {
    mockUpdateCompatibilityTab.mockRejectedValueOnce(
      new Error('chat-state persistence unavailable'),
    );
    const handle = createApprovalSession(makeCtx());

    await expect(
      handle.check(commandCheck('npm test'), commandDisplay('npm test')),
    ).resolves.toEqual({
      decision: 'deny',
      message: 'Approval prompt unavailable; denied by default.',
    });

    expect(mockRequestApprovalFromRenderer).not.toHaveBeenCalled();
  });

  it('does not register a renderer prompt after cancellation wins the timer-pause race', async () => {
    let markPauseStarted!: () => void;
    const pauseStarted = new Promise<void>((resolve) => {
      markPauseStarted = resolve;
    });
    let releasePause!: (
      result: Awaited<ReturnType<UpdateCompatibilityTab>>,
    ) => void;
    const pauseCommit = new Promise<
      Awaited<ReturnType<UpdateCompatibilityTab>>
    >((resolve) => {
      releasePause = resolve;
    });
    mockUpdateCompatibilityTab.mockImplementationOnce(() => {
      markPauseStarted();
      return pauseCommit;
    });
    mockRequestApprovalFromRenderer.mockResolvedValue({
      behavior: 'allow',
      scope: 'once',
    });
    const handle = createApprovalSession(makeCtx());

    const outcome = handle.check(
      commandCheck('npm test'),
      commandDisplay('npm test'),
    );
    await pauseStarted;
    if (!handle.invalidatePending) {
      throw new Error('Pending approval invalidation is unavailable');
    }
    handle.invalidatePending();
    releasePause({
      ...emptyCompatibilityTabResult(),
    });

    await expect(outcome).resolves.toEqual({
      decision: 'deny',
      message: 'Approval prompt unavailable; denied by default.',
    });
    expect(mockRequestApprovalFromRenderer).not.toHaveBeenCalled();
    expect(mockRejectAllApprovalsForSession).toHaveBeenCalledWith(
      'session-1',
      'turn_cancelled',
    );
    expect(mockUpdateCompatibilityTab.mock.calls[1]?.[3]).toMatch(
      /^approval-turn-timer-resume:/,
    );
  });

  it('prompt -> allow-session pushes to sessionRules and fires approvalRuleAdded', async () => {
    const target = { kind: 'command' as const, pattern: 'ls' };
    mockRequestApprovalFromRenderer.mockResolvedValue({
      behavior: 'allow',
      scope: 'session',
      target,
    });
    const ctx = makeCtx();

    const handle = createApprovalSession(ctx);
    const outcome = await handle.check(
      commandCheck('ls'),
      commandDisplay('ls'),
    );

    expect(outcome).toEqual({ decision: 'allow' });
    expect(ctx.sessionRules).toHaveLength(1);
    expect(ctx.sessionRules[0]).toEqual(
      expect.objectContaining({
        behavior: 'allow',
        target,
        origin: 'prompt',
      }),
    );
    expect(mockUpdateCompatibilityTab).toHaveBeenCalledWith(
      { projectId: 'proj-1', worktreeId: 'wt-1' },
      'chat-1',
      expect.any(Function),
      `approval-session-rule:${ctx.sessionRules[0]?.id}`,
    );
    const updateTab = mockUpdateCompatibilityTab.mock.calls.find(
      (call) => call[3] === `approval-session-rule:${ctx.sessionRules[0]?.id}`,
    )?.[2];
    if (!updateTab) throw new Error('missing session-rule updater');
    expect(
      updateTab(legacyPartialPersistedChatTab({ id: 'chat-1' }), undefined),
    ).toEqual({
      id: 'chat-1',
      sessionApprovalRules: [ctx.sessionRules[0]],
    });
    expect(mockSendToWindow).toHaveBeenCalledTimes(1);
    expect(mockSendToWindow).toHaveBeenCalledWith(
      null,
      IPC_CHANNELS.approvalRuleAdded,
      {
        projectId: 'proj-1',
        worktreeId: 'wt-1',
        chatId: 'chat-1',
        rule: ctx.sessionRules[0],
      },
    );
  });

  it('prompt -> deny-global persists a deny rule then returns deny', async () => {
    const target = { kind: 'command' as const, pattern: 'ls' };
    mockRequestApprovalFromRenderer.mockResolvedValue({
      behavior: 'deny',
      scope: 'global',
      target,
      message: 'Never allowed.',
    });

    const handle = createApprovalSession(makeCtx());
    const outcome = await handle.check(
      commandCheck('ls'),
      commandDisplay('ls'),
    );

    expect(outcome).toEqual({
      decision: 'deny',
      message: 'The user denied this tool call: Never allowed.',
    });
    expect(mockUpdatePreferencesFile).toHaveBeenCalledTimes(1);
    const [updater] = mockUpdatePreferencesFile.mock.calls[0];
    const result = updater({ globalApprovalRules: [] });
    expect(result.globalApprovalRules).toHaveLength(1);
    expect(result.globalApprovalRules?.[0]).toEqual(
      expect.objectContaining({ behavior: 'deny', target, origin: 'prompt' }),
    );
  });

  it('fails closed with a denial message when the prompt bridge throws', async () => {
    mockRequestApprovalFromRenderer.mockRejectedValue(
      new Error('Window not available'),
    );

    const handle = createApprovalSession(makeCtx());
    const outcome = await handle.check(
      commandCheck('ls'),
      commandDisplay('ls'),
    );

    expect(outcome).toEqual({
      decision: 'deny',
      message: 'Approval prompt unavailable; denied by default.',
    });
    expect(mockRecordSessionDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'approval_decision',
        decision: 'deny',
        scope: 'once',
      }),
    );
  });

  it('fails closed when the prompt bridge returns a malformed decision', async () => {
    mockRequestApprovalFromRenderer.mockResolvedValue({
      behavior: 'unexpected',
      scope: 'once',
    } as unknown as ApprovalPromptDecision);

    const handle = createApprovalSession(makeCtx());
    const outcome = await handle.check(
      commandCheck('ls'),
      commandDisplay('ls'),
    );

    expect(outcome).toEqual({
      decision: 'deny',
      message: 'Approval prompt unavailable; denied by default.',
    });
    expect(mockAddWorkspaceApprovalRule).not.toHaveBeenCalled();
    expect(mockUpdatePreferencesFile).not.toHaveBeenCalled();
  });

  it('fails closed when approval policy cannot be read', async () => {
    mockReadWorkspaceApprovals.mockRejectedValue(
      new Error('approval policy is corrupt'),
    );

    const handle = createApprovalSession(makeCtx());
    await expect(
      handle.check(commandCheck('ls'), commandDisplay('ls')),
    ).resolves.toEqual({
      decision: 'deny',
      message: 'Approval prompt unavailable; denied by default.',
    });
    expect(mockRequestApprovalFromRenderer).not.toHaveBeenCalled();
  });

  it('serializes concurrent prompts and re-evaluates the queued check instead of double-prompting', async () => {
    let resolveFirstPrompt: (decision: ApprovalPromptDecision) => void = () => {
      throw new Error('resolveFirstPrompt called before initialization');
    };
    const firstPromptPromise = new Promise<ApprovalPromptDecision>(
      (resolve) => {
        resolveFirstPrompt = resolve;
      },
    );
    mockRequestApprovalFromRenderer.mockReturnValueOnce(firstPromptPromise);

    const handle = createApprovalSession(makeCtx());

    const outcome1Promise = handle.check(
      commandCheck('ls'),
      commandDisplay('ls'),
    );
    const outcome2Promise = handle.check(
      commandCheck('ls'),
      commandDisplay('ls'),
    );

    // Flush microtasks so both checks reach as far as they can go without the
    // first prompt's decision. Only the first should have reached the
    // renderer bridge — the second is queued behind it.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(mockRequestApprovalFromRenderer).toHaveBeenCalledTimes(1);

    resolveFirstPrompt({
      behavior: 'allow',
      scope: 'session',
      target: { kind: 'command', pattern: 'ls' },
    });

    const [outcome1, outcome2] = await Promise.all([
      outcome1Promise,
      outcome2Promise,
    ]);

    expect(outcome1).toEqual({ decision: 'allow' });
    expect(outcome2).toEqual({ decision: 'allow' });
    // The second check re-evaluated against the session-scope rule the first
    // check's prompt persisted, so it never reached the renderer bridge.
    expect(mockRequestApprovalFromRenderer).toHaveBeenCalledTimes(1);
  });

  it('caches project and global rules for the TTL window', async () => {
    const handle = createApprovalSession(makeCtx());

    await handle.check(commandCheck('ls'), commandDisplay('ls'));
    mockRequestApprovalFromRenderer.mockResolvedValue({
      behavior: 'allow',
      scope: 'once',
    });
    await handle.check(commandCheck('pwd'), commandDisplay('pwd'));

    expect(mockReadWorkspaceApprovals).toHaveBeenCalledTimes(1);
    expect(mockReadWorkspaceApprovalsManifest).toHaveBeenCalledTimes(1);
    expect(mockReadPreferencesFile).toHaveBeenCalledTimes(1);
  });

  it('forces prompts and does not cache an unreadable project policy', async () => {
    mockWorkspaceApprovalsStatus = 'unreadable';
    mockReadWorkspaceApprovals.mockResolvedValue({
      version: 1,
      rules: [],
      defaultMode: 'ask',
    });
    mockReadPreferencesFile.mockResolvedValue({
      globalApprovalRules: [
        {
          id: 'global-allow',
          behavior: 'allow',
          target: { kind: 'command', pattern: '*' },
          createdAt: '2026-07-28T00:00:00.000Z',
          origin: 'settings',
        },
      ],
    });
    mockRequestApprovalFromRenderer.mockResolvedValue({
      behavior: 'deny',
      scope: 'once',
    });
    const handle = createApprovalSession(makeCtx({ mode: 'auto' }));

    await handle.check(commandCheck('ls'), commandDisplay('ls'));
    await handle.check(commandCheck('pwd'), commandDisplay('pwd'));

    expect(mockRequestApprovalFromRenderer).toHaveBeenCalledTimes(2);
    // Each check evaluates once before entering the serialized prompt queue and
    // once after acquiring it. An unreadable policy must be reloaded for both.
    expect(mockReadWorkspaceApprovals).toHaveBeenCalledTimes(4);
  });

  it('forces prompts and does not cache unreadable global preferences', async () => {
    mockPreferencesLoadError = new Error('preferences unreadable');
    mockReadPreferencesFile.mockResolvedValue({
      globalApprovalRules: [
        {
          id: 'fallback-global-allow',
          behavior: 'allow',
          target: { kind: 'command', pattern: '*' },
          createdAt: '2026-08-20T00:00:00.000Z',
          origin: 'settings',
        },
      ],
    });
    mockRequestApprovalFromRenderer.mockResolvedValue({
      behavior: 'deny',
      scope: 'once',
    });
    const handle = createApprovalSession(makeCtx({ mode: 'auto' }));

    await handle.check(commandCheck('ls'), commandDisplay('ls'));
    await handle.check(commandCheck('pwd'), commandDisplay('pwd'));

    expect(mockRequestApprovalFromRenderer).toHaveBeenCalledTimes(2);
    expect(mockReadPreferencesFile).toHaveBeenCalledTimes(4);
  });

  it('pins a known gap: project and global grants added after an agent send was admitted still apply to its turn (CAN-4723)', async () => {
    // The admitted cap (CAN-4821) holds only the chat's mode and session
    // rules; this turn runs at Ask with none of the chat's grants.
    const handle = createApprovalSession(
      makeCtx({ mode: 'ask', sessionRules: [] }),
    );
    const grant = (id: string, pattern: string): ApprovalRule => ({
      id,
      behavior: 'allow',
      target: { kind: 'command', pattern },
      createdAt: '2026-10-23T00:00:00.000Z',
      origin: 'settings',
    });

    // Granted at the project and global tiers after admission.
    mockReadWorkspaceApprovals.mockResolvedValue({
      version: 1,
      rules: [grant('project-grant', 'npm run lint')],
    });
    markWorkspaceApprovalRulesChanged('proj-1');
    mockReadPreferencesFile.mockResolvedValue({
      globalApprovalRules: [grant('global-grant', 'git push')],
    });
    markGlobalApprovalRulesChanged();

    // CAN-4723 owns capping these tiers; until then the turn gains them.
    await expect(
      handle.check(
        commandCheck('npm run lint'),
        commandDisplay('npm run lint'),
      ),
    ).resolves.toEqual({ decision: 'allow' });
    await expect(
      handle.check(commandCheck('git push'), commandDisplay('git push')),
    ).resolves.toEqual({ decision: 'allow' });
    expect(mockRequestApprovalFromRenderer).not.toHaveBeenCalled();
  });

  it('pins a known gap: a project deny rule removed after an agent send was admitted no longer applies to its turn (CAN-4723)', async () => {
    const handle = createApprovalSession(
      makeCtx({ mode: 'full-access', sessionRules: [] }),
    );
    // In force when the send was admitted.
    mockReadWorkspaceApprovals.mockResolvedValue({
      version: 1,
      rules: [
        {
          id: 'project-deny',
          behavior: 'deny',
          target: { kind: 'command', pattern: 'git push' },
          createdAt: '2026-10-23T00:00:00.000Z',
          origin: 'settings',
        },
      ],
    });
    markWorkspaceApprovalRulesChanged('proj-1');
    await expect(
      handle.check(commandCheck('git push'), commandDisplay('git push')),
    ).resolves.toEqual(expect.objectContaining({ decision: 'deny' }));

    // Removed before the turn's next tool call. CAN-4723 owns capping this.
    mockReadWorkspaceApprovals.mockResolvedValue({ version: 1, rules: [] });
    markWorkspaceApprovalRulesChanged('proj-1');
    await expect(
      handle.check(commandCheck('git push'), commandDisplay('git push')),
    ).resolves.toEqual({ decision: 'allow' });
  });

  it('invalidates cached project rules when another writer changes them', async () => {
    mockRequestApprovalFromRenderer.mockResolvedValue({
      behavior: 'deny',
      scope: 'once',
    });
    const handle = createApprovalSession(makeCtx());

    await handle.check(
      commandCheck('echo initial'),
      commandDisplay('echo initial'),
    );

    mockReadWorkspaceApprovals.mockResolvedValue({
      version: 1,
      rules: [
        {
          id: 'external-project-deny',
          behavior: 'deny',
          target: { kind: 'command', pattern: 'echo blocked' },
          createdAt: '2026-07-28T00:00:00.000Z',
          origin: 'settings',
        },
      ],
    });
    markWorkspaceApprovalRulesChanged('proj-1');

    await expect(
      handle.check(
        commandCheck('echo blocked'),
        commandDisplay('echo blocked'),
      ),
    ).resolves.toEqual({
      decision: 'deny',
      message: savedRuleDeniedMessage('project'),
    });
    expect(mockReadWorkspaceApprovals).toHaveBeenCalledTimes(2);
    expect(mockRequestApprovalFromRenderer).toHaveBeenCalledTimes(1);
  });

  it('invalidates cached global rules when another writer changes them', async () => {
    mockRequestApprovalFromRenderer.mockResolvedValue({
      behavior: 'deny',
      scope: 'once',
    });
    const handle = createApprovalSession(makeCtx());

    await handle.check(
      commandCheck('echo initial'),
      commandDisplay('echo initial'),
    );

    mockReadPreferencesFile.mockResolvedValue({
      globalApprovalRules: [
        {
          id: 'external-global-deny',
          behavior: 'deny',
          target: { kind: 'command', pattern: 'echo blocked' },
          createdAt: '2026-07-28T00:00:00.000Z',
          origin: 'settings',
        },
      ],
    });
    markGlobalApprovalRulesChanged();

    await expect(
      handle.check(
        commandCheck('echo blocked'),
        commandDisplay('echo blocked'),
      ),
    ).resolves.toEqual({
      decision: 'deny',
      message: savedRuleDeniedMessage('global'),
    });
    expect(mockReadPreferencesFile).toHaveBeenCalledTimes(2);
    expect(mockRequestApprovalFromRenderer).toHaveBeenCalledTimes(1);
  });

  it('denies a command matched by a canopy.json manifest rule with an empty approvals.json', async () => {
    mockReadWorkspaceApprovals.mockResolvedValue(emptyApprovalsFile);
    mockReadWorkspaceApprovalsManifest.mockResolvedValue({
      rules: [
        {
          id: 'manifest-rule-1',
          behavior: 'deny',
          target: { kind: 'command', pattern: 'rm -rf *' },
          createdAt: '2026-07-20T00:00:00.000Z',
          origin: 'canopy-json',
        },
      ],
    });

    const handle = createApprovalSession(makeCtx());
    const outcome = await handle.check(
      commandCheck('rm -rf foo'),
      commandDisplay('rm -rf foo'),
    );

    expect(outcome).toEqual({
      decision: 'deny',
      message: savedRuleDeniedMessage('repository'),
    });
    expect(mockRequestApprovalFromRenderer).not.toHaveBeenCalled();
    expect(mockRecordSessionDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'approval_decision',
        decision: 'deny',
        scope: 'project',
        targetKind: 'command',
      }),
    );
  });

  it('does not treat a canopy.json allow rule as user approval', async () => {
    mockReadWorkspaceApprovalsManifest.mockResolvedValue({
      rules: [
        {
          id: 'manifest-rule-allow',
          behavior: 'allow',
          target: { kind: 'command', pattern: 'npm test *' },
          createdAt: '2026-07-20T00:00:00.000Z',
          origin: 'canopy-json',
        },
      ],
    });
    mockRequestApprovalFromRenderer.mockResolvedValue({
      behavior: 'allow',
      scope: 'once',
    });

    const handle = createApprovalSession(makeCtx());
    await expect(
      handle.check(commandCheck('npm test'), commandDisplay('npm test')),
    ).resolves.toEqual({ decision: 'allow' });
    expect(mockRequestApprovalFromRenderer).toHaveBeenCalledTimes(1);
  });

  describe('browser uploads', () => {
    const uploadCheck: ApprovalCheck = {
      kind: 'browser-upload',
      origin: 'https://upload.example',
      topOrigin: 'https://app.example',
      files: [{ displayPath: 'report.csv', sizeBytes: 8 }],
    };
    const uploadDisplay: ApprovalCheckDisplay = {
      title: 'Upload report.csv to upload.example?',
      details: {
        kind: 'browser-upload',
        origin: 'https://upload.example',
        topOrigin: 'https://app.example',
        files: [{ displayPath: 'report.csv', sizeBytes: 8 }],
      },
      suggestedTarget: {
        kind: 'browser-upload',
        origin: 'https://upload.example',
      },
    };

    it('asks in Full Access, and a chat-scoped allow answers the next upload to that site', async () => {
      mockRequestApprovalFromRenderer.mockResolvedValue({
        behavior: 'allow',
        scope: 'session',
        target: { kind: 'browser-upload', origin: 'https://upload.example' },
      });
      const handle = createApprovalSession(makeCtx({ mode: 'full-access' }));

      await expect(handle.check(uploadCheck, uploadDisplay)).resolves.toEqual({
        decision: 'allow',
      });
      await expect(handle.check(uploadCheck, uploadDisplay)).resolves.toEqual({
        decision: 'allow',
      });
      expect(mockRequestApprovalFromRenderer).toHaveBeenCalledTimes(1);

      mockRequestApprovalFromRenderer.mockResolvedValue({
        behavior: 'deny',
        scope: 'once',
      });
      await expect(
        handle.check(
          { ...uploadCheck, origin: 'https://other.example' },
          uploadDisplay,
        ),
      ).resolves.toMatchObject({ decision: 'deny' });
      expect(mockRequestApprovalFromRenderer).toHaveBeenCalledTimes(2);
    });

    it('denies by a canopy.json deny rule without asking, and still asks past a canopy.json allow', async () => {
      mockReadWorkspaceApprovalsManifest.mockResolvedValue({
        rules: [
          {
            id: 'manifest-upload-deny',
            behavior: 'deny',
            target: {
              kind: 'browser-upload',
              origin: 'https://upload.example',
            },
            createdAt: '2026-07-20T00:00:00.000Z',
            origin: 'canopy-json',
          },
          {
            id: 'manifest-upload-allow',
            behavior: 'allow',
            target: { kind: 'browser-upload', origin: 'https://other.example' },
            createdAt: '2026-07-20T00:00:00.000Z',
            origin: 'canopy-json',
          },
        ],
      });
      mockRequestApprovalFromRenderer.mockResolvedValue({
        behavior: 'deny',
        scope: 'once',
      });
      const handle = createApprovalSession(makeCtx({ mode: 'full-access' }));

      await expect(handle.check(uploadCheck, uploadDisplay)).resolves.toEqual({
        decision: 'deny',
        message: savedRuleDeniedMessage('repository'),
      });
      expect(mockRequestApprovalFromRenderer).not.toHaveBeenCalled();
      await handle.check(
        { ...uploadCheck, origin: 'https://other.example' },
        uploadDisplay,
      );
      expect(mockRequestApprovalFromRenderer).toHaveBeenCalledTimes(1);
    });

    it('denies another case of a denied path beside a site-wide allow on a case-insensitive filesystem', async () => {
      const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(
        process,
        'platform',
      );
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value: 'win32',
      });
      mockReadWorkspaceApprovals.mockResolvedValue({
        version: 1,
        rules: [
          {
            id: 'allow-site',
            behavior: 'allow',
            target: {
              kind: 'browser-upload',
              origin: 'https://upload.example',
            },
            createdAt: '2026-10-15T00:00:00.000Z',
            origin: 'settings',
          },
          {
            id: 'deny-secrets',
            behavior: 'deny',
            target: {
              kind: 'browser-upload',
              origin: 'https://upload.example',
              path: 'secrets/**',
            },
            createdAt: '2026-10-15T00:00:00.000Z',
            origin: 'settings',
          },
        ],
      });

      try {
        const handle = createApprovalSession(makeCtx({ mode: 'ask' }));
        await expect(
          handle.check(
            {
              ...uploadCheck,
              files: [{ displayPath: 'Secrets/key.pem', sizeBytes: 8 }],
            },
            uploadDisplay,
          ),
        ).resolves.toMatchObject({ decision: 'deny' });
        expect(mockRequestApprovalFromRenderer).not.toHaveBeenCalled();
      } finally {
        if (originalPlatformDescriptor) {
          Object.defineProperty(
            process,
            'platform',
            originalPlatformDescriptor,
          );
        }
      }
    });
  });

  describe('browser file requests', () => {
    const fileRequest: ApprovalCheck = {
      kind: 'browser-file-request',
      origin: 'https://upload.example',
      topOrigin: 'https://app.example',
      multiple: false,
    };
    const fileRequestDisplay: ApprovalCheckDisplay = {
      title: 'Choose a file for upload.example',
      details: {
        kind: 'browser-file-request',
        origin: 'https://upload.example',
        topOrigin: 'https://app.example',
        multiple: false,
      },
    };

    it('asks every time in Full Access, even after the user chose files once', async () => {
      mockRequestApprovalFromRenderer.mockResolvedValue({
        behavior: 'allow',
        scope: 'once',
      });
      const handle = createApprovalSession(makeCtx({ mode: 'full-access' }));
      for (let index = 0; index < 2; index++)
        await expect(
          handle.check(fileRequest, fileRequestDisplay),
        ).resolves.toEqual({ decision: 'allow' });
      expect(mockRequestApprovalFromRenderer).toHaveBeenCalledTimes(2);
    });
  });

  it('loads and persists code-review policy through the owning project', async () => {
    mockGetCodeReviewTargetSync.mockReturnValue({
      projectId: 'owner-workspace',
      worktreeId: 'owner-worktree',
    });
    mockRequestApprovalFromRenderer.mockResolvedValue({
      behavior: 'allow',
      scope: 'project',
      target: { kind: 'command', pattern: 'npm test *' },
    });

    const handle = createApprovalSession(
      makeCtx({
        projectId: CODE_REVIEW_CHAT_PROJECT_ID,
        worktreeId: 'scope-key',
      }),
    );
    await handle.check(commandCheck('npm test'), commandDisplay('npm test'));

    expect(mockReadWorkspaceApprovals).toHaveBeenCalledWith('owner-workspace');
    expect(mockReadWorkspaceApprovalsManifest).toHaveBeenCalledWith(
      'owner-workspace',
    );
    expect(mockAddWorkspaceApprovalRule).toHaveBeenCalledWith(
      'owner-workspace',
      expect.objectContaining({ behavior: 'allow' }),
    );
  });

  it('loads and persists legacy cowork policy through the owning project', async () => {
    mockRequestApprovalFromRenderer.mockResolvedValue({
      behavior: 'allow',
      scope: 'project',
      target: { kind: 'command', pattern: 'npm test *' },
    });

    const handle = createApprovalSession(
      makeCtx({
        projectId: STANDALONE_CHAT_PROJECT_ID,
        worktreeId: 'cowork-workspace',
      }),
    );
    await handle.check(commandCheck('npm test'), commandDisplay('npm test'));

    expect(mockReadWorkspaceApprovals).toHaveBeenCalledWith('cowork-workspace');
    expect(mockReadWorkspaceApprovalsManifest).toHaveBeenCalledWith(
      'cowork-workspace',
    );
    expect(mockAddWorkspaceApprovalRule).toHaveBeenCalledWith(
      'cowork-workspace',
      expect.objectContaining({
        behavior: 'allow',
        target: { kind: 'command', pattern: 'npm test *' },
      }),
    );
  });
});

describe('createApprovalSession - setMode', () => {
  it('affects subsequent check calls', async () => {
    const ctx = makeCtx({ mode: 'ask' });
    const handle = createApprovalSession(ctx);
    handle.setMode('full-access');

    const outcome = await handle.check(
      commandCheck('anything'),
      commandDisplay('anything'),
    );

    expect(outcome).toEqual({ decision: 'allow' });
    expect(mockRequestApprovalFromRenderer).not.toHaveBeenCalled();
  });

  it('changes the policy context key for mode and persisted rule revisions', () => {
    const handle = createApprovalSession(
      makeCtx({ projectId: 'policy-context-project', mode: 'auto' }),
    );
    const key = (): string => {
      if (!handle.policyContextKey)
        throw new Error('Expected approval policy context key');
      return handle.policyContextKey();
    };
    const initial = key();

    handle.setMode('ask');
    const modeChanged = key();
    expect(modeChanged).not.toBe(initial);

    markWorkspaceApprovalRulesChanged('policy-context-project');
    const projectChanged = key();
    expect(projectChanged).not.toBe(modeChanged);

    markGlobalApprovalRulesChanged();
    expect(key()).not.toBe(projectChanged);
  });
});

describe('createApprovalSession - dispose', () => {
  it('rejects all pending approvals for the session', () => {
    const handle = createApprovalSession(makeCtx({ sessionKey: 'session-9' }));
    handle.dispose();

    expect(mockRejectAllApprovalsForSession).toHaveBeenCalledWith('session-9');
  });

  it('fails closed for checks queued or started after disposal', async () => {
    let resolvePrompt: (decision: ApprovalPromptDecision) => void = () => {
      throw new Error('Approval prompt was not initialized');
    };
    mockRequestApprovalFromRenderer.mockReturnValueOnce(
      new Promise((resolve) => {
        resolvePrompt = resolve;
      }),
    );
    const ctx = makeCtx();
    const handle = createApprovalSession(ctx);
    const active = handle.check(commandCheck('first'), commandDisplay('first'));
    const queued = handle.check(
      commandCheck('second'),
      commandDisplay('second'),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));

    handle.dispose();
    resolvePrompt({
      behavior: 'allow',
      scope: 'session',
      target: { kind: 'command', pattern: 'first *' },
    });

    await expect(active).resolves.toEqual({
      decision: 'deny',
      message: FAIL_CLOSED_MESSAGE,
    });
    await expect(queued).resolves.toEqual(
      expect.objectContaining({ decision: 'deny' }),
    );
    await expect(
      handle.check(commandCheck('third'), commandDisplay('third')),
    ).resolves.toEqual(expect.objectContaining({ decision: 'deny' }));
    expect(mockRequestApprovalFromRenderer).toHaveBeenCalledTimes(1);
    expect(ctx.sessionRules).toEqual([]);
  });
});

describe('createApprovalSession - turn cancellation', () => {
  it('invalidates stale prompt decisions without disposing the session', async () => {
    let resolvePrompt: (decision: ApprovalPromptDecision) => void = () => {
      throw new Error('Approval prompt was not initialized');
    };
    mockRequestApprovalFromRenderer.mockReturnValueOnce(
      new Promise((resolve) => {
        resolvePrompt = resolve;
      }),
    );
    const ctx = makeCtx({ sessionKey: 'session-cancelled-turn' });
    const handle = createApprovalSession(ctx);
    const staleCheck = handle.check(
      commandCheck('npm publish'),
      commandDisplay('npm publish'),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));

    handle.invalidatePending?.();
    resolvePrompt({
      behavior: 'allow',
      scope: 'global',
      target: { kind: 'command', pattern: 'npm publish *' },
    });

    await expect(staleCheck).resolves.toEqual({
      decision: 'deny',
      message: FAIL_CLOSED_MESSAGE,
    });
    expect(mockRejectAllApprovalsForSession).toHaveBeenCalledWith(
      'session-cancelled-turn',
      'turn_cancelled',
    );
    expect(mockUpdatePreferencesFile).not.toHaveBeenCalled();

    handle.setMode('full-access');
    await expect(
      handle.check(commandCheck('npm test'), commandDisplay('npm test')),
    ).resolves.toEqual({ decision: 'allow' });
  });

  // CAN-4469 D-release: a save that started is kept after Stop; only the
  // action it was asked for is withdrawn.
  it.each(['allow', 'deny'] as const)(
    'keeps a project %s rule whose save started before cancellation',
    async (behavior) => {
      let finishPersistence: (file: ApprovalsFile) => void = () => {
        throw new Error('Project persistence was not initialized');
      };
      mockAddWorkspaceApprovalRule.mockReturnValueOnce(
        new Promise((resolve) => {
          finishPersistence = resolve;
        }),
      );
      mockRequestApprovalFromRenderer.mockResolvedValueOnce({
        behavior,
        scope: 'project',
        target: { kind: 'command', pattern: 'npm publish *' },
      });
      const handle = createApprovalSession(
        makeCtx({ sessionKey: 'session-project-race' }),
      );
      const pending = handle.check(
        commandCheck('npm publish'),
        commandDisplay('npm publish'),
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      const persistedRule = mockAddWorkspaceApprovalRule.mock.calls[0]?.[1];
      expect(persistedRule).toMatchObject({ behavior });

      handle.invalidatePending?.();
      finishPersistence(emptyApprovalsFile);

      await expect(pending).resolves.toEqual({
        decision: 'deny',
        message: FAIL_CLOSED_MESSAGE,
      });
      expect(mockRemoveWorkspaceApprovalRule).not.toHaveBeenCalled();
      handle.dispose();
    },
  );

  it('keeps a session rule whose save started before cancellation for the chat', async () => {
    let finishPersistence: (
      value: Awaited<ReturnType<UpdateCompatibilityTab>>,
    ) => void = () => {
      throw new Error('Session persistence was not initialized');
    };
    const persistence = new Promise<
      Awaited<ReturnType<UpdateCompatibilityTab>>
    >((resolve) => {
      finishPersistence = resolve;
    });
    mockUpdateCompatibilityTab.mockImplementation(
      (_scope, _chatId, _update, mutationId?: string) => {
        if (mutationId?.startsWith('approval-session-rule:')) {
          return persistence;
        }
        return Promise.resolve(emptyCompatibilityTabResult());
      },
    );
    mockRequestApprovalFromRenderer.mockResolvedValueOnce({
      behavior: 'allow',
      scope: 'session',
      target: { kind: 'command', pattern: 'npm publish *' },
    });
    const ctx = makeCtx({ sessionKey: 'session-rule-race' });
    const handle = createApprovalSession(ctx);
    const pending = handle.check(
      commandCheck('npm publish'),
      commandDisplay('npm publish'),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    const persistedCall = mockUpdateCompatibilityTab.mock.calls.find((call) =>
      call[3]?.startsWith('approval-session-rule:'),
    );
    expect(persistedCall).toBeDefined();

    handle.invalidatePending?.();
    finishPersistence(emptyCompatibilityTabResult());

    await expect(pending).resolves.toEqual({
      decision: 'deny',
      message: FAIL_CLOSED_MESSAGE,
    });
    const mutationIds = mockUpdateCompatibilityTab.mock.calls.map(
      (call) => call[3],
    );
    expect(
      mutationIds.filter((id) => id?.startsWith('approval-session-rule')),
    ).toHaveLength(1);
    expect(ctx.sessionRules).toEqual([
      expect.objectContaining({
        behavior: 'allow',
        target: { kind: 'command', pattern: 'npm publish *' },
      }),
    ]);
    expect(mockSendToWindow).toHaveBeenCalledWith(
      null,
      IPC_CHANNELS.approvalRuleAdded,
      expect.objectContaining({ chatId: 'chat-1', rule: ctx.sessionRules[0] }),
    );
    // The chat's next request is covered by the saved grant.
    await expect(
      handle.check(commandCheck('npm publish'), commandDisplay('npm publish')),
    ).resolves.toEqual({ decision: 'allow' });
    expect(mockRequestApprovalFromRenderer).toHaveBeenCalledTimes(1);
    handle.dispose();
  });

  it.each(['allow', 'deny'] as const)(
    'keeps a global %s rule whose save started before shutdown',
    async (behavior) => {
      let finishPersistence: (preferences: FakePreferences) => void = () => {
        throw new Error('Global persistence was not initialized');
      };
      mockUpdatePreferencesFile.mockReturnValueOnce(
        new Promise((resolve) => {
          finishPersistence = resolve;
        }),
      );
      mockRequestApprovalFromRenderer.mockResolvedValueOnce({
        behavior,
        scope: 'global',
        target: { kind: 'command', pattern: 'npm publish *' },
      });
      const handle = createApprovalSession(
        makeCtx({ sessionKey: 'session-global-race' }),
      );
      const pending = handle.check(
        commandCheck('npm publish'),
        commandDisplay('npm publish'),
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      const persistUpdater = mockUpdatePreferencesFile.mock.calls[0]?.[0];
      expect(persistUpdater).toBeDefined();
      const persisted = persistUpdater?.({ globalApprovalRules: [] });
      const persistedRules = persisted?.globalApprovalRules ?? [];
      expect(persistedRules).toEqual([expect.objectContaining({ behavior })]);

      handle.dispose();
      finishPersistence({ globalApprovalRules: persistedRules });

      await expect(pending).resolves.toEqual({
        decision: 'deny',
        message: FAIL_CLOSED_MESSAGE,
      });
      expect(mockUpdatePreferencesFile).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['session', 'project', 'global'] as const)(
    'records the denial when a %s rule cannot be saved',
    async (scope) => {
      mockRequestApprovalFromRenderer.mockResolvedValue({
        behavior: 'allow',
        scope,
        target: { kind: 'command', pattern: 'npm publish *' },
      });
      const failure = new Error('Rule persistence unavailable');
      mockAddWorkspaceApprovalRule.mockRejectedValue(failure);
      mockUpdatePreferencesFile.mockRejectedValue(failure);
      mockUpdateCompatibilityTab.mockImplementation(
        (_scope, _chatId, _updater, operationId?: string) =>
          Promise.resolve(
            emptyCompatibilityTabResult(
              operationId === undefined ||
                !operationId.startsWith('approval-session-rule:'),
            ),
          ),
      );
      const handle = createApprovalSession(makeCtx());
      await expect(
        handle.check(
          commandCheck('npm publish'),
          commandDisplay('npm publish'),
        ),
      ).resolves.toEqual({ decision: 'deny', message: FAIL_CLOSED_MESSAGE });
      expect(mockRecordSessionDiagnostic).toHaveBeenCalledTimes(1);
      expect(mockRecordSessionDiagnostic).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'approval_decision',
          decision: 'deny',
          scope: 'once',
          targetKind: 'command',
        }),
      );
      handle.dispose();
    },
  );
});

/**
 * CAN-3083: widening the approval mode while a prompt is on screen re-runs the
 * policy for that standing card and releases it if the new mode would not have
 * asked. The invariant under test throughout: a mode change may only ever
 * *release* a pending prompt; it may never decide against the user.
 */
describe('createApprovalSession - pending re-evaluation on mode widening', () => {
  /**
   * Starts a check that reaches a prompt and parks there forever, so the card
   * is genuinely standing when the widening arrives. Returns the (deliberately
   * unawaited) check promise.
   */
  function standingPrompt(
    handle: ReturnType<typeof createApprovalSession>,
    check: ApprovalCheck,
    display: ApprovalCheckDisplay,
    requestId = 'req-1',
  ): Promise<unknown> {
    nextPromptRequestId = requestId;
    mockRequestApprovalFromRenderer.mockImplementation(
      () => new Promise<ApprovalPromptDecision>(() => {}),
    );
    const pending = handle.check(check, display);
    pending.catch(() => undefined);
    return pending;
  }

  /** Guards every "stays standing" assertion against a false pass. */
  function expectCardIsStanding(): void {
    expect(mockRequestApprovalFromRenderer).toHaveBeenCalledTimes(1);
  }

  /**
   * Lets the parked prompt reach the pending registry before the widening
   * runs. Needs real macrotask turns, not just microtasks: reaching the bridge
   * goes through the rule loads and the dynamic import of the chat-state
   * service that owns the durable turn-timer pause.
   */
  async function settleMicrotasks(): Promise<void> {
    for (let i = 0; i < 5; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  const denyRule: ApprovalRule = {
    id: 'deny-ls',
    behavior: 'deny',
    target: { kind: 'command', pattern: 'ls *' },
    createdAt: '2026-09-22T00:00:00.000Z',
    origin: 'settings',
  };

  it('releases a standing card as allow-once when the user switches to Full Access', async () => {
    const handle = createApprovalSession(makeCtx());
    void standingPrompt(
      handle,
      commandCheck('ls apps/web/src/app/'),
      commandDisplay('ls apps/web/src/app/'),
    );
    await settleMicrotasks();
    expect(mockRequestApprovalFromRenderer).toHaveBeenCalledTimes(1);

    await handle.reevaluatePendingApprovals('full-access');

    expect(mockResolveApprovalFromMain).toHaveBeenCalledWith(
      'req-1',
      'session-1',
      { behavior: 'allow', scope: 'once' },
    );
    // Never re-prompts: the whole point is that the user is not asked twice.
    expect(mockRequestApprovalFromRenderer).toHaveBeenCalledTimes(1);
    handle.dispose();
  });

  it('mints no durable rule - the widening already persisted the mode', async () => {
    const handle = createApprovalSession(makeCtx());
    void standingPrompt(
      handle,
      commandCheck('ls apps/web/src/app/'),
      commandDisplay('ls apps/web/src/app/'),
    );
    await settleMicrotasks();

    await handle.reevaluatePendingApprovals('full-access');

    expect(mockAddWorkspaceApprovalRule).not.toHaveBeenCalled();
    expect(mockUpdatePreferencesFile).not.toHaveBeenCalled();
    handle.dispose();
  });

  it('releases an in-workspace write on ask -> auto', async () => {
    const handle = createApprovalSession(makeCtx());
    void standingPrompt(
      handle,
      { kind: 'file-write', path: '/workspace/src/a.ts' },
      {
        title: 'Write src/a.ts',
        details: { kind: 'file-write', path: '/workspace/src/a.ts' },
      },
    );
    await settleMicrotasks();
    expectCardIsStanding();

    await handle.reevaluatePendingApprovals('auto');

    expect(mockResolveApprovalFromMain).toHaveBeenCalledWith(
      'req-1',
      'session-1',
      { behavior: 'allow', scope: 'once' },
    );
    handle.dispose();
  });

  it('leaves an out-of-workspace write standing on ask -> auto', async () => {
    const handle = createApprovalSession(makeCtx());
    void standingPrompt(
      handle,
      { kind: 'file-write', path: '/elsewhere/a.ts' },
      {
        title: 'Write /elsewhere/a.ts',
        details: { kind: 'file-write', path: '/elsewhere/a.ts' },
      },
    );
    await settleMicrotasks();
    expectCardIsStanding();

    await handle.reevaluatePendingApprovals('auto');

    expect(mockResolveApprovalFromMain).not.toHaveBeenCalled();
    expect(mockUpdateCompatibilityTab).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.stringContaining('approval-resolution:'),
    );
    handle.dispose();
  });

  it('leaves a command standing on ask -> auto, which widens writes only', async () => {
    const handle = createApprovalSession(makeCtx());
    void standingPrompt(
      handle,
      commandCheck('ls apps/web/src/app/'),
      commandDisplay('ls apps/web/src/app/'),
    );
    await settleMicrotasks();
    expectCardIsStanding();

    await handle.reevaluatePendingApprovals('auto');

    expect(mockResolveApprovalFromMain).not.toHaveBeenCalled();
    handle.dispose();
  });

  it('never releases a card a deny rule now matches, even for Full Access', async () => {
    // Deny rules are mode-independent and run before every mode branch, so a
    // rule added (or a canopy.json pulled) while the card sat there produces
    // `deny` under any mode. Leaving it standing is deliberate: auto-denying
    // would kill the turn of a user who just *widened* permissions.
    const handle = createApprovalSession(makeCtx());
    void standingPrompt(
      handle,
      commandCheck('ls apps/web/src/app/'),
      commandDisplay('ls apps/web/src/app/'),
    );
    await settleMicrotasks();
    expectCardIsStanding();
    mockReadPreferencesFile.mockResolvedValue({
      globalApprovalRules: [denyRule],
    });
    markGlobalApprovalRulesChanged();

    await handle.reevaluatePendingApprovals('full-access');

    expect(mockResolveApprovalFromMain).not.toHaveBeenCalled();
    handle.dispose();
  });

  it('records the newly observable stale-deny hazard instead of acting on it', async () => {
    const handle = createApprovalSession(makeCtx());
    void standingPrompt(
      handle,
      commandCheck('ls apps/web/src/app/'),
      commandDisplay('ls apps/web/src/app/'),
    );
    await settleMicrotasks();
    expectCardIsStanding();
    mockReadPreferencesFile.mockResolvedValue({
      globalApprovalRules: [denyRule],
    });
    markGlobalApprovalRulesChanged();

    await handle.reevaluatePendingApprovals('full-access');

    expect(mockRecordSessionDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'approval_stale_deny_observed',
        approvalStaleDenyRequestId: 'req-1',
        chatId: 'chat-1',
      }),
    );
    handle.dispose();
  });

  it('leaves a card standing when the rule file is unreadable, even for Full Access', async () => {
    // `forcePrompt` forces `ask` and strips allow rules, so an unreadable rule
    // file can only ever yield `prompt`. Fail-closed must survive a widening.
    const handle = createApprovalSession(makeCtx());
    void standingPrompt(
      handle,
      commandCheck('ls apps/web/src/app/'),
      commandDisplay('ls apps/web/src/app/'),
    );
    await settleMicrotasks();
    mockPreferencesLoadError = new Error('preferences unreadable');
    markGlobalApprovalRulesChanged();
    expectCardIsStanding();

    await handle.reevaluatePendingApprovals('full-access');

    expect(mockResolveApprovalFromMain).not.toHaveBeenCalled();
    handle.dispose();
  });

  it('honours a restriction that landed during the re-evaluation', async () => {
    // The downgrade path publishes to the live registry before anything else,
    // so a second read of it at the moment of the grant yields the tighter
    // mode and the card correctly stays up.
    const handle = createApprovalSession(makeCtx());
    void standingPrompt(
      handle,
      commandCheck('ls apps/web/src/app/'),
      commandDisplay('ls apps/web/src/app/'),
    );
    await settleMicrotasks();
    expectCardIsStanding();
    setLiveApprovalMode('proj-1', 'wt-1', 'chat-1', 'ask');

    await handle.reevaluatePendingApprovals('full-access');

    expect(mockResolveApprovalFromMain).not.toHaveBeenCalled();
    handle.dispose();
  });

  it('is a no-op after dispose', async () => {
    const handle = createApprovalSession(makeCtx());
    void standingPrompt(
      handle,
      commandCheck('ls apps/web/src/app/'),
      commandDisplay('ls apps/web/src/app/'),
    );
    await settleMicrotasks();
    handle.dispose();

    await handle.reevaluatePendingApprovals('full-access');

    expect(mockResolveApprovalFromMain).not.toHaveBeenCalled();
  });

  it('is a no-op after the chat-wide broadcast once the handle unregisters', async () => {
    const handle = createApprovalSession(makeCtx());
    void standingPrompt(
      handle,
      commandCheck('ls apps/web/src/app/'),
      commandDisplay('ls apps/web/src/app/'),
    );
    await settleMicrotasks();
    handle.dispose();

    await reevaluatePendingApprovalsForChat(
      'proj-1',
      'wt-1',
      'chat-1',
      'full-access',
    );

    expect(mockResolveApprovalFromMain).not.toHaveBeenCalled();
  });

  it('reaches the standing card through the chat-wide broadcast', async () => {
    const handle = createApprovalSession(makeCtx());
    void standingPrompt(
      handle,
      commandCheck('ls apps/web/src/app/'),
      commandDisplay('ls apps/web/src/app/'),
    );
    await settleMicrotasks();

    await reevaluatePendingApprovalsForChat(
      'proj-1',
      'wt-1',
      'chat-1',
      'full-access',
    );

    expect(mockResolveApprovalFromMain).toHaveBeenCalledWith(
      'req-1',
      'session-1',
      { behavior: 'allow', scope: 'once' },
    );
    handle.dispose();
  });

  it('does not release a card whose turn was cancelled mid re-evaluation', async () => {
    const handle = createApprovalSession(makeCtx());
    void standingPrompt(
      handle,
      commandCheck('ls apps/web/src/app/'),
      commandDisplay('ls apps/web/src/app/'),
    );
    await settleMicrotasks();
    let releaseRules: (() => void) | undefined;
    mockReadPreferencesFile.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseRules = (): void => resolve({ globalApprovalRules: [] });
        }),
    );
    markGlobalApprovalRulesChanged();

    const reevaluation = handle.reevaluatePendingApprovals('full-access');
    await settleMicrotasks();
    handle.invalidatePending?.();
    releaseRules?.();
    await reevaluation;

    expect(mockResolveApprovalFromMain).not.toHaveBeenCalled();
    handle.dispose();
  });

  it('commits the transcript record before resolving the prompt', async () => {
    const order: string[] = [];
    mockUpdateCompatibilityTab.mockImplementation(
      (_scope, _chatId, _updater, reason?: string) => {
        if (
          typeof reason === 'string' &&
          reason.startsWith('approval-resolution:')
        ) {
          order.push('commit');
        }
        return Promise.resolve(emptyCompatibilityTabResult());
      },
    );
    mockResolveApprovalFromMain.mockImplementation(() => {
      order.push('resolve');
      return true;
    });
    mockSendToWindow.mockImplementation(() => {
      order.push('event');
      return true;
    });
    const handle = createApprovalSession(makeCtx());
    void standingPrompt(
      handle,
      commandCheck('ls apps/web/src/app/'),
      commandDisplay('ls apps/web/src/app/'),
    );
    await settleMicrotasks();

    await handle.reevaluatePendingApprovals('full-access');

    expect(order).toEqual(['commit', 'resolve', 'event']);
    handle.dispose();
  });

  it('writes one approval_resolution_info block carrying every released title', async () => {
    const handle = createApprovalSession(makeCtx());
    void standingPrompt(handle, commandCheck('ls apps/web/src/app/'), {
      title: 'ls apps/web/src/app/',
      details: { kind: 'command', command: 'ls apps/web/src/app/' },
    });
    await settleMicrotasks();

    await handle.reevaluatePendingApprovals('full-access');

    const commit = mockUpdateCompatibilityTab.mock.calls.find(
      (call) =>
        typeof call[3] === 'string' &&
        call[3].startsWith('approval-resolution:'),
    );
    expect(commit).toBeDefined();
    const updater = commit?.[2];
    if (!updater) throw new Error('missing updater');
    const updated = updater(
      {
        id: 'chat-1',
        title: 'chat',
        messages: [],
      } as unknown as Parameters<typeof updater>[0],
      undefined,
    );
    const messages =
      updated && typeof updated === 'object' && 'messages' in updated
        ? updated.messages
        : [];
    expect(messages).toEqual([
      expect.objectContaining({
        role: 'system',
        blocks: [
          expect.objectContaining({
            type: 'approval_resolution_info',
            resolvedBy: 'mode-change',
            mode: 'full-access',
            previousMode: 'ask',
            titles: ['ls apps/web/src/app/'],
          }),
        ],
      }),
    ]);
    handle.dispose();
  });

  it('releases nothing and sends nothing when the transcript commit fails', async () => {
    // An auto-approval that cannot be recorded is exactly the unrecorded
    // privileged action this change exists to prevent.
    mockUpdateCompatibilityTab.mockImplementation(
      (_scope, _chatId, _updater, reason?: string) =>
        typeof reason === 'string' && reason.startsWith('approval-resolution:')
          ? Promise.reject(new Error('disk full'))
          : Promise.resolve(emptyCompatibilityTabResult()),
    );
    const handle = createApprovalSession(makeCtx());
    void standingPrompt(
      handle,
      commandCheck('ls apps/web/src/app/'),
      commandDisplay('ls apps/web/src/app/'),
    );
    await settleMicrotasks();

    await expect(
      handle.reevaluatePendingApprovals('full-access'),
    ).resolves.toBeUndefined();

    expect(mockResolveApprovalFromMain).not.toHaveBeenCalled();
    expect(mockSendToWindow).not.toHaveBeenCalledWith(
      expect.anything(),
      IPC_CHANNELS.approvalAutoResolved,
      expect.anything(),
    );
    handle.dispose();
  });

  it('sends approval:auto-resolved with the chat identity and the committed message', async () => {
    const handle = createApprovalSession(makeCtx());
    void standingPrompt(
      handle,
      commandCheck('ls apps/web/src/app/'),
      commandDisplay('ls apps/web/src/app/'),
    );
    await settleMicrotasks();

    await handle.reevaluatePendingApprovals('full-access');

    const expectedMessage: unknown = expect.objectContaining({
      role: 'system',
    });
    expect(mockSendToWindow).toHaveBeenCalledWith(
      null,
      IPC_CHANNELS.approvalAutoResolved,
      expect.objectContaining({
        requestId: 'req-1',
        projectId: 'proj-1',
        worktreeId: 'wt-1',
        chatId: 'chat-1',
        reason: 'mode-change',
        mode: 'full-access',
        previousMode: 'ask',
        resolutionMessage: expectedMessage,
      }),
    );
    handle.dispose();
  });

  it('reports the mode the chat was in before the widening, not the mode already applied to the handle', async () => {
    // Production order matters here. `ipc/chat.ts` pushes the new mode into
    // every runtime owner first — `session.setApprovalMode` and
    // `ClaudeTerminalSessionService.setApprovalMode` both call
    // `handle.setMode` — and only then dispatches the re-evaluation. So by the
    // time this runs the handle's own `mode` is *already* the widened one, and
    // deriving `previousMode` from it silently yields "same as mode" every
    // time. The pre-widening mode has to be threaded in explicitly, or the
    // `previousMode` field on `ApprovalAutoResolvedEvent` and on the
    // `approval_resolution_info` block can never be populated in production.
    const handle = createApprovalSession(makeCtx());
    void standingPrompt(
      handle,
      commandCheck('ls apps/web/src/app/'),
      commandDisplay('ls apps/web/src/app/'),
    );
    await settleMicrotasks();
    handle.setMode('full-access');

    await handle.reevaluatePendingApprovals('full-access', 'ask');

    expect(mockSendToWindow).toHaveBeenCalledWith(
      null,
      IPC_CHANNELS.approvalAutoResolved,
      expect.objectContaining({ mode: 'full-access', previousMode: 'ask' }),
    );
    const commit = mockUpdateCompatibilityTab.mock.calls.find(
      (call) =>
        typeof call[3] === 'string' &&
        call[3].startsWith('approval-resolution:'),
    );
    const updater = commit?.[2];
    if (!updater) throw new Error('missing updater');
    const updated = updater(
      {
        id: 'chat-1',
        title: 'chat',
        messages: [],
      } as unknown as Parameters<typeof updater>[0],
      undefined,
    );
    const messages =
      updated && typeof updated === 'object' && 'messages' in updated
        ? updated.messages
        : [];
    expect(messages).toEqual([
      expect.objectContaining({
        blocks: [
          expect.objectContaining({
            mode: 'full-access',
            previousMode: 'ask',
          }),
        ],
      }),
    ]);
    handle.dispose();
  });

  it('omits previousMode when the widening did not actually change the mode', async () => {
    const handle = createApprovalSession(makeCtx());
    void standingPrompt(
      handle,
      commandCheck('ls apps/web/src/app/'),
      commandDisplay('ls apps/web/src/app/'),
    );
    await settleMicrotasks();

    await handle.reevaluatePendingApprovals('full-access', 'full-access');

    const event = mockSendToWindow.mock.calls.find(
      (call) => call[1] === IPC_CHANNELS.approvalAutoResolved,
    )?.[2];
    expect(event).toBeDefined();
    expect(event && typeof event === 'object' && 'previousMode' in event).toBe(
      false,
    );
    handle.dispose();
  });

  it('records the decision as mode-widened, not as a prompt click', async () => {
    // The record is emitted by the `promptForDecision` continuation the
    // release resumes, not by the widening path -- see "records exactly one
    // approval_decision per mode-widened grant" below for why. Settling the
    // bridge promise is therefore part of the flow under test.
    const handle = createApprovalSession(makeCtx());
    nextPromptRequestId = 'req-1';
    let answer: ((decision: ApprovalPromptDecision) => void) | undefined;
    mockRequestApprovalFromRenderer.mockImplementation(
      () =>
        new Promise<ApprovalPromptDecision>((resolve) => {
          answer = resolve;
        }),
    );
    const pending = handle.check(
      commandCheck('ls apps/web/src/app/'),
      commandDisplay('ls apps/web/src/app/'),
    );
    pending.catch(() => undefined);
    await settleMicrotasks();
    mockResolveApprovalFromMain.mockImplementation(
      (_requestId: string, _sessionKey: string, decision) => {
        answer?.(decision);
        return true;
      },
    );

    await handle.reevaluatePendingApprovals('full-access');
    await pending;
    await settleMicrotasks();

    expect(mockRecordSessionDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'approval_decision',
        decision: 'allow',
        scope: 'once',
        approvalDecisionSource: 'mode-widened',
      }),
    );
    handle.dispose();
  });

  it('skips a card the user answered first - their explicit decision wins', async () => {
    mockResolveApprovalFromMain.mockReturnValue(false);
    const handle = createApprovalSession(makeCtx());
    void standingPrompt(
      handle,
      commandCheck('ls apps/web/src/app/'),
      commandDisplay('ls apps/web/src/app/'),
    );
    await settleMicrotasks();

    await handle.reevaluatePendingApprovals('full-access');

    expect(mockSendToWindow).not.toHaveBeenCalledWith(
      expect.anything(),
      IPC_CHANNELS.approvalAutoResolved,
      expect.anything(),
    );
    handle.dispose();
  });

  it('is a no-op for a non-chat surface, which has no transcript to record into', async () => {
    const handle = createApprovalSession(
      makeCtx({ provider: 'cursor', trackChatTurn: false }),
    );
    void standingPrompt(
      handle,
      commandCheck('ls apps/web/src/app/'),
      commandDisplay('ls apps/web/src/app/'),
    );
    await settleMicrotasks();

    await handle.reevaluatePendingApprovals('full-access');

    expect(mockResolveApprovalFromMain).not.toHaveBeenCalled();
    handle.dispose();
  });

  it('resolves a queued check through the chain without ever prompting for it', async () => {
    // Checks parked behind `promptChain` re-run the policy when their turn
    // comes, reading the mode `setMode` already mutated - so queued checks
    // pick up the widened mode for free. This pins that.
    const handle = createApprovalSession(makeCtx());
    nextPromptRequestId = 'req-1';
    let answerFirst: ((decision: ApprovalPromptDecision) => void) | undefined;
    mockRequestApprovalFromRenderer.mockImplementation(
      () =>
        new Promise<ApprovalPromptDecision>((resolve) => {
          answerFirst = resolve;
        }),
    );
    const first = handle.check(
      commandCheck('ls one/'),
      commandDisplay('ls one/'),
    );
    await settleMicrotasks();
    const second = handle.check(
      commandCheck('ls two/'),
      commandDisplay('ls two/'),
    );
    await settleMicrotasks();
    expect(mockRequestApprovalFromRenderer).toHaveBeenCalledTimes(1);

    handle.setMode('full-access');
    answerFirst?.({ behavior: 'allow', scope: 'once' });

    expect(await first).toEqual({ decision: 'allow' });
    expect(await second).toEqual({ decision: 'allow' });
    expect(mockRequestApprovalFromRenderer).toHaveBeenCalledTimes(1);
    handle.dispose();
  });

  /** Helper: read back the messages a commit/correction updater produced. */
  function messagesFor(reasonPrefix: string, seed: unknown[] = []): unknown[] {
    const call = mockUpdateCompatibilityTab.mock.calls
      .filter(
        (entry) =>
          typeof entry[3] === 'string' && entry[3].startsWith(reasonPrefix),
      )
      .at(-1);
    const updater = call?.[2];
    if (!updater) throw new Error(`no ${reasonPrefix} call`);
    const updated = updater(
      {
        id: 'chat-1',
        title: 'chat',
        messages: seed,
      } as unknown as Parameters<typeof updater>[0],
      undefined,
    );
    return updated && typeof updated === 'object' && 'messages' in updated
      ? updated.messages
      : [];
  }

  it('removes the receipt entirely when the card lost the race', async () => {
    // The commit deliberately precedes the grant, so its title list is
    // speculative. If the user answers the card during that durable write,
    // `resolveApprovalFromMain` declines to settle it -- and without this
    // correction the transcript keeps a permanent "Approved by switching to
    // Full Access" naming a request the user actually DENIED.
    //
    // One card is the whole story: `promptChain` serializes renderer prompts
    // per handle, so a handle never has two standing at once. The partial
    // rewrite in `reconcileApprovalResolutionMessage` is defensive.
    const handle = createApprovalSession(makeCtx());
    void standingPrompt(
      handle,
      commandCheck('ls apps/web/src/app/'),
      commandDisplay('ls apps/web/src/app/'),
    );
    await settleMicrotasks();
    mockResolveApprovalFromMain.mockReturnValue(false);

    await handle.reevaluatePendingApprovals('full-access', 'ask');

    const committedId = (
      messagesFor('approval-resolution:')[0] as { id: string }
    ).id;
    expect(
      messagesFor('approval-resolution-correction:', [
        { id: committedId, role: 'system', blocks: [], timestamp: 0 },
      ]),
    ).toEqual([]);
    expect(mockSendToWindow).not.toHaveBeenCalledWith(
      expect.anything(),
      IPC_CHANNELS.approvalAutoResolved,
      expect.anything(),
    );
    handle.dispose();
  });

  it('does not correct the receipt when every card released', async () => {
    const handle = createApprovalSession(makeCtx());
    void standingPrompt(
      handle,
      commandCheck('ls apps/web/src/app/'),
      commandDisplay('ls apps/web/src/app/'),
    );
    await settleMicrotasks();

    await handle.reevaluatePendingApprovals('full-access', 'ask');

    expect(
      mockUpdateCompatibilityTab.mock.calls.filter(
        (entry) =>
          typeof entry[3] === 'string' &&
          entry[3].startsWith('approval-resolution-correction:'),
      ),
    ).toHaveLength(0);
    handle.dispose();
  });

  it('releases nothing when live authority narrows while the receipt is being committed', async () => {
    // The downgrade path publishes to the live registry synchronously before
    // entering its queued operation, so a restriction can land after the
    // pre-commit clamp and before the grant. Without a third read immediately
    // before the synchronous claim, the prompt is allowed under the wider mode
    // while live authority has already narrowed.
    const handle = createApprovalSession(makeCtx());
    void standingPrompt(
      handle,
      commandCheck('ls apps/web/src/app/'),
      commandDisplay('ls apps/web/src/app/'),
    );
    await settleMicrotasks();

    mockUpdateCompatibilityTab.mockImplementation(
      (_scope, _chatId, _updater, reason?: string) => {
        if (
          typeof reason === 'string' &&
          reason.startsWith('approval-resolution:')
        ) {
          setLiveApprovalMode('proj-1', 'wt-1', 'chat-1', 'ask');
        }
        return Promise.resolve(emptyCompatibilityTabResult());
      },
    );

    await handle.reevaluatePendingApprovals('full-access', 'ask');

    expect(mockResolveApprovalFromMain).not.toHaveBeenCalled();
    expect(mockSendToWindow).not.toHaveBeenCalledWith(
      expect.anything(),
      IPC_CHANNELS.approvalAutoResolved,
      expect.anything(),
    );
    clearLiveApprovalMode('proj-1', 'wt-1', 'chat-1');
    handle.dispose();
  });

  it('records exactly one approval_decision per mode-widened grant, tagged at the source', async () => {
    // Releasing through the bridge promise resumes `promptForDecision`, which
    // runs its own `recordDecision`. Recording in the widening path too emits
    // two events for one grant -- one tagged `mode-widened`, one untagged --
    // defeating the distinction the field exists to draw.
    const handle = createApprovalSession(makeCtx());
    nextPromptRequestId = 'req-1';
    let answer: ((decision: ApprovalPromptDecision) => void) | undefined;
    mockRequestApprovalFromRenderer.mockImplementation(
      () =>
        new Promise<ApprovalPromptDecision>((resolve) => {
          answer = resolve;
        }),
    );
    const pending = handle.check(
      commandCheck('ls apps/web/src/app/'),
      commandDisplay('ls apps/web/src/app/'),
    );
    pending.catch(() => undefined);
    await settleMicrotasks();
    // Settling the bridge promise is what `resolveApprovalFromMain` does in
    // production; the mock returns true without doing it, so drive it here.
    mockResolveApprovalFromMain.mockImplementation(
      (_requestId: string, _sessionKey: string, decision) => {
        answer?.(decision);
        return true;
      },
    );
    mockRecordSessionDiagnostic.mockClear();

    await handle.reevaluatePendingApprovals('full-access', 'ask');
    expect(await pending).toEqual({ decision: 'allow' });
    await settleMicrotasks();

    const decisions = mockRecordSessionDiagnostic.mock.calls
      .map(([entry]) => entry)
      .filter(
        (entry): entry is { kind: string; approvalDecisionSource?: string } =>
          typeof entry === 'object' &&
          entry !== null &&
          'kind' in entry &&
          entry.kind === 'approval_decision',
      );
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toEqual(
      expect.objectContaining({
        decision: 'allow',
        approvalDecisionSource: 'mode-widened',
      }),
    );
    handle.dispose();
  });

  it('re-runs the widening against a prompt that registered while it was in flight', async () => {
    // A check that cleared its policy read under the old mode and was still
    // inside the durable turn-timer commit when the widening landed is in
    // neither view: not yet in `inFlightPrompts` for the broadcast, and never
    // re-run afterwards. It would sit there asking about something the current
    // mode no longer prompts for -- the original CAN-3083 report.
    const handle = createApprovalSession(makeCtx());
    let widened = false;
    mockUpdateCompatibilityTab.mockImplementation(
      (_scope, _chatId, _updater, reason?: string) => {
        // Land the widening inside the durable turn-timer pause -- after the
        // policy read, before `onRegistered`. `inFlightPrompts` is still empty
        // here, so the broadcast itself finds nothing to release.
        if (
          !widened &&
          typeof reason === 'string' &&
          reason.startsWith('approval-turn-timer-pause:')
        ) {
          widened = true;
          handle.setMode('full-access');
          void handle.reevaluatePendingApprovals('full-access', 'ask');
        }
        return Promise.resolve(emptyCompatibilityTabResult());
      },
    );

    void standingPrompt(
      handle,
      commandCheck('ls apps/web/src/app/'),
      commandDisplay('ls apps/web/src/app/'),
    );
    await settleMicrotasks();

    expect(widened).toBe(true);
    expect(mockResolveApprovalFromMain).toHaveBeenCalledWith(
      'req-1',
      'session-1',
      { behavior: 'allow', scope: 'once' },
    );
    handle.dispose();
  });

  /** Every `approval_decision` diagnostic recorded so far. */
  function approvalDecisions(): Array<Record<string, unknown>> {
    return mockRecordSessionDiagnostic.mock.calls
      .map(([entry]) => entry)
      .filter(
        (entry): entry is Record<string, unknown> =>
          typeof entry === 'object' &&
          entry !== null &&
          (entry as { kind?: unknown }).kind === 'approval_decision',
      );
  }

  it('still records the grant when the turn is cancelled before the resumed continuation returns', async () => {
    // The release settles the bridge promise, commits the receipt and sends
    // the event -- and THEN `promptForDecision` resumes, whose `finally`
    // awaits the durable turn-timer resume. A cancellation landing in that
    // window makes the continuation return `deny` without recording anything.
    // If the record lived only there, a privileged action would be committed
    // to the transcript and announced to the renderer with zero audit trail.
    const handle = createApprovalSession(makeCtx());
    nextPromptRequestId = 'req-1';
    let answer: ((decision: ApprovalPromptDecision) => void) | undefined;
    mockRequestApprovalFromRenderer.mockImplementation(
      () =>
        new Promise<ApprovalPromptDecision>((resolve) => {
          answer = resolve;
        }),
    );
    const pending = handle.check(
      commandCheck('ls apps/web/src/app/'),
      commandDisplay('ls apps/web/src/app/'),
    );
    pending.catch(() => undefined);
    await settleMicrotasks();
    mockResolveApprovalFromMain.mockImplementation(
      (_requestId: string, _sessionKey: string, decision) => {
        answer?.(decision);
        // Cancel the turn in the same breath, so the resuming continuation
        // takes its `disposed || generation !== promptGeneration` return.
        handle.invalidatePending?.();
        return true;
      },
    );
    mockRecordSessionDiagnostic.mockClear();

    await handle.reevaluatePendingApprovals('full-access', 'ask');
    await pending;
    await settleMicrotasks();

    const decisions = approvalDecisions();
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toEqual(
      expect.objectContaining({
        decision: 'allow',
        approvalDecisionSource: 'mode-widened',
      }),
    );
    handle.dispose();
  });

  it('does not claim a prompt twice when widening re-evaluations overlap', async () => {
    // Two overlapping widenings over one standing prompt: A claims it, then
    // B's post-commit live-map check observes that the prompt is no longer
    // pending and does not attempt a second claim. The resuming continuation
    // must still record no SECOND, untagged decision -- the "user clicked
    // Allow once" conflation the source field exists to prevent.
    const handle = createApprovalSession(makeCtx());
    nextPromptRequestId = 'req-1';
    let answer: ((decision: ApprovalPromptDecision) => void) | undefined;
    mockRequestApprovalFromRenderer.mockImplementation(
      () =>
        new Promise<ApprovalPromptDecision>((resolve) => {
          answer = resolve;
        }),
    );
    const pending = handle.check(
      commandCheck('ls apps/web/src/app/'),
      commandDisplay('ls apps/web/src/app/'),
    );
    pending.catch(() => undefined);
    await settleMicrotasks();

    let claims = 0;
    mockResolveApprovalFromMain.mockImplementation(
      (_requestId: string, _sessionKey: string, decision) => {
        claims += 1;
        answer?.(decision);
        return true;
      },
    );
    mockRecordSessionDiagnostic.mockClear();

    // B is already past its own `stillPending` snapshot when A claims.
    await Promise.all([
      handle.reevaluatePendingApprovals('full-access', 'ask'),
      handle.reevaluatePendingApprovals('full-access', 'ask'),
    ]);
    await pending;
    await settleMicrotasks();

    expect(claims).toBe(1);
    const decisions = approvalDecisions();
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toEqual(
      expect.objectContaining({ approvalDecisionSource: 'mode-widened' }),
    );
    handle.dispose();
  });

  it('reports previousMode on the registration-window fallback', async () => {
    // The fallback has no dispatcher value of its own, and the handle's `mode`
    // is already widened -- so without the stashed value the receipt silently
    // drops `previousMode` on exactly the path CAN-3083 reported.
    const handle = createApprovalSession(makeCtx());
    let widened = false;
    mockUpdateCompatibilityTab.mockImplementation(
      (_scope, _chatId, _updater, reason?: string) => {
        if (
          !widened &&
          typeof reason === 'string' &&
          reason.startsWith('approval-turn-timer-pause:')
        ) {
          widened = true;
          handle.setMode('full-access');
          void handle.reevaluatePendingApprovals('full-access', 'ask');
        }
        return Promise.resolve(emptyCompatibilityTabResult());
      },
    );

    void standingPrompt(
      handle,
      commandCheck('ls apps/web/src/app/'),
      commandDisplay('ls apps/web/src/app/'),
    );
    await settleMicrotasks();

    expect(messagesFor('approval-resolution:')).toEqual([
      expect.objectContaining({
        blocks: [
          expect.objectContaining({
            type: 'approval_resolution_info',
            mode: 'full-access',
            previousMode: 'ask',
          }),
        ],
      }),
    ]);
    handle.dispose();
  });

  it('omits previousMode when the live clamp makes the release a narrowing', async () => {
    // `previousMode: 'full-access'` beside `mode: 'ask'` would render a
    // widening receipt that describes a narrowing.
    // Card stands under `ask`. A session rule then lands (as one would from a
    // prior grant or the settings UI) so the re-evaluation allows regardless
    // of mode, while live authority has already been clamped to `auto` and the
    // dispatcher reports the chat was in `full-access`.
    const sessionRules: ApprovalRule[] = [];
    const handle = createApprovalSession(makeCtx({ sessionRules }));
    void standingPrompt(
      handle,
      commandCheck('ls apps/web/src/app/'),
      commandDisplay('ls apps/web/src/app/'),
    );
    await settleMicrotasks();

    sessionRules.push({
      id: 'allow-ls',
      behavior: 'allow',
      target: { kind: 'command', pattern: 'ls *' },
      createdAt: '2026-09-22T00:00:00.000Z',
      origin: 'prompt',
    });
    setLiveApprovalMode('proj-1', 'wt-1', 'chat-1', 'auto');

    await handle.reevaluatePendingApprovals('full-access', 'full-access');

    const block = (
      messagesFor('approval-resolution:')[0] as {
        blocks: Array<Record<string, unknown>>;
      }
    ).blocks[0];
    expect(block.mode).toBe('auto');
    expect(block.previousMode).toBeUndefined();
    // The rule, not the mode change, is the authority that granted this.
    expect(
      approvalDecisions().filter(
        (entry) => entry.approvalDecisionSource === 'mode-widened',
      ),
    ).toEqual([expect.objectContaining({ scope: 'session' })]);
    clearLiveApprovalMode('proj-1', 'wt-1', 'chat-1');
    handle.dispose();
  });

  it('counts a standing stale deny once, not once per re-evaluation pass', () => {
    // This diagnostic is meant to be evidence of how often the hazard arises.
    // The dispatcher and the `onRegistered` fallback can both re-evaluate the
    // same card, so counting per pass would inflate exactly the number a
    // decision about fixing it would rest on.
    return (async (): Promise<void> => {
      const handle = createApprovalSession(makeCtx());
      void standingPrompt(
        handle,
        commandCheck('ls apps/web/src/app/'),
        commandDisplay('ls apps/web/src/app/'),
      );
      await settleMicrotasks();
      expectCardIsStanding();
      // Deny rule lands while the card is up, as in the sibling tests.
      mockReadPreferencesFile.mockResolvedValue({
        globalApprovalRules: [denyRule],
      });
      markGlobalApprovalRulesChanged();
      mockRecordSessionDiagnostic.mockClear();

      await handle.reevaluatePendingApprovals('full-access', 'ask');
      await handle.reevaluatePendingApprovals('full-access', 'ask');
      await handle.reevaluatePendingApprovals('full-access', 'ask');

      const staleDenies = mockRecordSessionDiagnostic.mock.calls
        .map(([entry]) => entry)
        .filter(
          (entry) =>
            typeof entry === 'object' &&
            entry !== null &&
            (entry as { kind?: unknown }).kind ===
              'approval_stale_deny_observed',
        );
      expect(staleDenies).toHaveLength(1);
      // The card must still be standing -- a deny never releases it.
      expect(mockResolveApprovalFromMain).not.toHaveBeenCalled();
      handle.dispose();
    })();
  });
});

describe('requestChatApproval through a live session', () => {
  const write: ApprovalCheck = {
    kind: 'file-write',
    path: '/workspace/downloads/report.csv',
  };
  const display: ApprovalCheckDisplay = {
    title: 'Save report.csv to downloads/report.csv?',
    details: { kind: 'file-write', path: 'downloads/report.csv' },
  };

  it('allows a write inside the workspace in Auto without a prompt', async () => {
    createApprovalSession(makeCtx({ mode: 'auto' }));

    await expect(
      requestChatApproval('proj-1', 'wt-1', 'chat-1', write, display),
    ).resolves.toMatchObject({ decision: 'allow' });
    expect(mockRequestApprovalFromRenderer).not.toHaveBeenCalled();
  });

  it("prompts in the chat's dock in Ask and returns the answer", async () => {
    mockRequestApprovalFromRenderer.mockResolvedValue({
      behavior: 'deny',
      scope: 'once',
    });
    createApprovalSession(makeCtx({ mode: 'ask' }));

    await expect(
      requestChatApproval('proj-1', 'wt-1', 'chat-1', write, display),
    ).resolves.toMatchObject({ decision: 'deny' });
    expect(mockRequestApprovalFromRenderer).toHaveBeenCalledTimes(1);
  });

  it('denies once the session is disposed', async () => {
    const handle = createApprovalSession(makeCtx({ mode: 'full-access' }));
    handle.dispose();

    await expect(
      requestChatApproval('proj-1', 'wt-1', 'chat-1', write, display),
    ).resolves.toMatchObject({ decision: 'deny' });
    expect(mockRequestApprovalFromRenderer).not.toHaveBeenCalled();
  });
});

describe('safety denial receipt lifecycle', () => {
  const command = 'git push --force origin HEAD';
  let tab: PersistedChatTab;

  beforeEach(() => {
    tab = {
      id: 'chat-1',
      title: 'Chat',
      messages: [],
      createdAt: '2026-10-23T00:00:00Z',
    };
    mockUpdateCompatibilityTab.mockImplementation((_scope, _chatId, update) => {
      const next = update(tab, undefined);
      if (next) tab = next;
      return Promise.resolve({
        tabsFile: { version: 1, tabs: [tab], activeTabId: tab.id },
        updated: next !== null,
      });
    });
  });

  it('deduplicates overlapping checks and replay across handles, but retains distinct calls and subagents', async () => {
    const context = makeCtx({ getTurnUserMessageId: () => 'turn-1' });
    const handle = createApprovalSession(context);
    const display = {
      ...commandDisplay(command),
      toolUseId: 'call-1',
      subagentId: 'child-1',
    };
    await Promise.all([
      handle.check(commandCheck(command), display),
      handle.check(commandCheck(command), display),
    ]);
    expect(tab.messages).toHaveLength(1);
    handle.dispose();
    const recreated = createApprovalSession(context);
    await recreated.check(commandCheck(command), display);
    await recreated.check(commandCheck(command), {
      ...display,
      toolUseId: 'call-2',
    });
    await recreated.check(commandCheck(command), {
      ...display,
      subagentId: 'child-2',
    });
    expect(tab.messages).toHaveLength(3);
    expect(new Set(tab.messages.map((message) => message.id)).size).toBe(3);
    expect(tab.messages[0]?.blocks[0]).toMatchObject({
      turnUserMessageId: 'turn-1',
      toolUseId: 'call-1',
      subagentId: 'child-1',
    });
    recreated.dispose();
  });

  it('retains separate checks without invocation IDs and separates reused IDs in different turns', async () => {
    let turn = 'turn-1';
    const handle = createApprovalSession(
      makeCtx({ getTurnUserMessageId: () => turn }),
    );
    await handle.check(commandCheck(command), commandDisplay(command));
    await handle.check(commandCheck(command), commandDisplay(command));
    const display = { ...commandDisplay(command), toolUseId: 'call' };
    await handle.check(commandCheck(command), display);
    turn = 'turn-2';
    await handle.check(commandCheck(command), display);
    expect(tab.messages).toHaveLength(4);
    handle.dispose();
  });

  it('awaits persistence and preserves ownership and evaluated mode through cancellation and shutdown', async () => {
    let release: (() => void) | undefined;
    let entered: (() => void) | undefined;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const commit = mockUpdateCompatibilityTab.getMockImplementation();
    mockUpdateCompatibilityTab.mockImplementation(async (...args) => {
      entered?.();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      if (!commit) throw new Error('Missing commit');
      return commit(...args);
    });
    let turn = 'original-turn';
    const handle = createApprovalSession(
      makeCtx({ getTurnUserMessageId: () => turn }),
    );
    let settled = false;
    const check = handle
      .check(commandCheck(command), {
        ...commandDisplay(command),
        toolUseId: 'call',
      })
      .then((outcome) => {
        settled = true;
        return outcome;
      });
    await waiting;
    expect(settled).toBe(false);
    turn = 'next-turn';
    handle.setMode('full-access');
    handle.invalidatePending?.();
    handle.dispose();
    release?.();
    expect(await check).toMatchObject({
      decision: 'deny',
      message: containingText('(force-push)'),
    });
    expect(mockUpdateCompatibilityTab.mock.calls[0]?.slice(0, 2)).toEqual([
      { projectId: 'proj-1', worktreeId: 'wt-1' },
      'chat-1',
    ]);
    expect(tab.messages[0]?.blocks[0]).toMatchObject({
      mode: 'ask',
      turnUserMessageId: 'original-turn',
    });
  });

  it('keeps the specific denial and its receipt when the check aborts during persistence', async () => {
    let release: (() => void) | undefined;
    let entered: (() => void) | undefined;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const commit = mockUpdateCompatibilityTab.getMockImplementation();
    mockUpdateCompatibilityTab.mockImplementation(async (...args) => {
      entered?.();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      if (!commit) throw new Error('Missing commit');
      return commit(...args);
    });
    const controller = new AbortController();
    const handle = createApprovalSession(makeCtx());
    const check = handle.check(commandCheck(command), {
      ...commandDisplay(command),
      toolUseId: 'aborted-call',
      signal: controller.signal,
    });
    await waiting;
    controller.abort();
    release?.();
    await expect(check).resolves.toMatchObject({
      decision: 'deny',
      message: containingText('(force-push)'),
    });
    expect(tab.messages[0]?.blocks[0]).toMatchObject({
      toolUseId: 'aborted-call',
    });
    handle.dispose();
  });

  it('keeps the specific denial on commit rejection and retries only the receipt with the same identity', async () => {
    mockUpdateCompatibilityTab.mockRejectedValueOnce(
      new Error(`disk failed: ${command}`),
    );
    const handle = createApprovalSession(makeCtx());
    const display = { ...commandDisplay(command), toolUseId: 'call' };
    const outcome = await handle.check(commandCheck(command), display);
    expect(outcome).toMatchObject({
      decision: 'deny',
      message: containingText('(force-push)'),
    });
    expect(tab.messages).toHaveLength(0);
    expect(mockLogMainProcessWarn).toHaveBeenCalledWith(
      'approval_safety_denied_receipt_failed',
      expect.objectContaining({ reason: 'force-push', chatId: 'chat-1' }),
    );
    expect(JSON.stringify(mockLogMainProcessWarn.mock.calls)).not.toContain(
      command,
    );
    await handle.check(commandCheck(command), display);
    await handle.check(commandCheck(command), display);
    expect(tab.messages).toHaveLength(1);
    expect(mockRequestApprovalFromRenderer).not.toHaveBeenCalled();
    handle.dispose();
  });

  it('recognizes canonical mutation replay even when the updater is skipped', async () => {
    const handle = createApprovalSession(makeCtx());
    const display = { ...commandDisplay(command), toolUseId: 'call' };
    await handle.check(commandCheck(command), display);
    mockUpdateCompatibilityTab.mockResolvedValueOnce({
      tabsFile: { version: 1, tabs: [tab], activeTabId: tab.id },
      updated: false,
    });
    await handle.check(commandCheck(command), display);
    expect(tab.messages).toHaveLength(1);
    expect(mockLogMainProcessWarn).not.toHaveBeenCalled();
    handle.dispose();
  });

  it('reports a missing receipt destination without changing the denial', async () => {
    mockUpdateCompatibilityTab.mockResolvedValueOnce(
      emptyCompatibilityTabResult(false),
    );
    const handle = createApprovalSession(makeCtx());
    expect(
      await handle.check(commandCheck(command), commandDisplay(command)),
    ).toMatchObject({
      decision: 'deny',
      message: containingText('(force-push)'),
    });
    expect(mockLogMainProcessWarn).toHaveBeenCalledTimes(1);
    handle.dispose();
  });

  it('redacts and bounds stored command display text with an explicit marker', async () => {
    const longCommand = `${command}; echo token=secret-value ${'x'.repeat(5000)}`;
    const handle = createApprovalSession(makeCtx());
    await handle.check(commandCheck(longCommand), commandDisplay(longCommand));
    const block = tab.messages[0]?.blocks[0];
    if (block?.type !== 'approval_safety_denied_info')
      throw new Error('Missing receipt');
    expect(block.command).toHaveLength(4000);
    expect(block.command).not.toContain('secret-value');
    expect(block.command).toMatch(/\[truncated\]$/);
    handle.dispose();
  });

  it('excludes non-chat, saved-rule denials, and Full access from receipts', async () => {
    const nonChat = createApprovalSession(makeCtx({ trackChatTurn: false }));
    expect(
      await nonChat.check(commandCheck(command), commandDisplay(command)),
    ).toMatchObject({
      decision: 'deny',
      message: containingText('(force-push)'),
    });
    nonChat.dispose();
    const full = createApprovalSession(makeCtx({ mode: 'full-access' }));
    expect(
      await full.check(commandCheck(command), commandDisplay(command)),
    ).toEqual({ decision: 'allow' });
    full.dispose();
    const saved = createApprovalSession(
      makeCtx({
        sessionRules: [
          {
            id: 'deny',
            behavior: 'deny',
            target: { kind: 'command', pattern: 'git status' },
            createdAt: '2026-10-23',
            origin: 'settings',
          },
        ],
      }),
    );
    expect(
      await saved.check(
        commandCheck('git status'),
        commandDisplay('git status'),
      ),
    ).toEqual({ decision: 'deny', message: savedRuleDeniedMessage('session') });
    expect(mockUpdateCompatibilityTab).not.toHaveBeenCalled();
    saved.dispose();
  });

  it('uses the same safety handler after queued re-evaluation', async () => {
    let release: ((decision: ApprovalPromptDecision) => void) | undefined;
    mockRequestApprovalFromRenderer.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const handle = createApprovalSession(makeCtx());
    const first = handle.check(
      commandCheck('git status'),
      commandDisplay('git status'),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    const second = handle.check(commandCheck('rm -rf /workspace/link'), {
      ...commandDisplay('rm -rf /workspace/link'),
      toolUseId: 'queued-call',
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    mockRealpath.mockImplementation((path) =>
      Promise.resolve(path === '/workspace/link' ? '/' : path),
    );
    release?.({ behavior: 'allow', scope: 'once' });
    expect(await first).toEqual({ decision: 'allow' });
    expect(await second).toMatchObject({
      decision: 'deny',
      message: containingText('(destructive delete)'),
    });
    expect(mockRequestApprovalFromRenderer).toHaveBeenCalledTimes(1);
    expect(
      tab.messages.some((message) =>
        message.blocks.some(
          (block) =>
            block.type === 'approval_safety_denied_info' &&
            block.toolUseId === 'queued-call',
        ),
      ),
    ).toBe(true);
    handle.dispose();
  });
});
