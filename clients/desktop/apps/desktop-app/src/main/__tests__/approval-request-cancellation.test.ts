import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import type {
  ApprovalCheck,
  ApprovalPromptDecision,
  ApprovalRequestEvent,
  ApprovalRule,
  ApprovalsFile,
} from '@canopy/desktop-shared/types';
import type * as FsPromises from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { EventEmitter } from 'node:events';
import type { WindowSendResult } from '../lib/window-send';
import type { SendableBrowserWindow } from '../lib/window-send';
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

const emptyApprovalsFile: ApprovalsFile = { version: 1, rules: [] };
const mockReadWorkspaceApprovals = jest.fn<Promise<ApprovalsFile>, [string]>();
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
    status: 'ok',
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

interface TestPreferences {
  globalApprovalRules: ApprovalRule[];
}

const mockReadPreferencesFile = jest.fn<Promise<TestPreferences>, []>();
const mockUpdatePreferencesFile = jest.fn<
  Promise<TestPreferences>,
  [(existing: TestPreferences) => Partial<TestPreferences>]
>();
jest.mock('../lib/preferences-store', () => ({
  readPreferencesFileDetailed: async (): Promise<{
    preferences: Awaited<ReturnType<typeof mockReadPreferencesFile>>;
    authority: 'ok' | 'unreadable';
  }> => ({
    preferences: await mockReadPreferencesFile(),
    authority: 'ok',
  }),
  peekPreferencesLoadError: (): null => null,
  readPreferencesFile: (): Promise<TestPreferences> =>
    mockReadPreferencesFile(),
  updatePreferencesFile: (
    updater: (existing: TestPreferences) => Partial<TestPreferences>,
  ): Promise<TestPreferences> => mockUpdatePreferencesFile(updater),
}));

const mockSendToWindow = jest.fn<boolean, [unknown, string, unknown]>();
const mockSendToWindowDetailed = jest.fn<
  WindowSendResult,
  [unknown, string, unknown]
>();
jest.mock('../lib/window-send', () => ({
  sendToWindow: (window: unknown, channel: string, payload: unknown): boolean =>
    mockSendToWindow(window, channel, payload),
  sendToWindowDetailed: (
    window: unknown,
    channel: string,
    payload: unknown,
  ): WindowSendResult => mockSendToWindowDetailed(window, channel, payload),
}));

const mockRecordSessionDiagnostic = jest.fn<void, [unknown]>();
const mockPauseChatTurn = jest.fn<void, [string, string, string]>();
const mockResumeChatTurn = jest.fn<void, [string, string, string]>();
jest.mock('../observability', () => ({
  getObservabilityService: (): {
    recordSessionDiagnostic: jest.Mock;
    pauseChatTurn: jest.Mock;
    resumeChatTurn: jest.Mock;
  } => ({
    recordSessionDiagnostic: mockRecordSessionDiagnostic,
    pauseChatTurn: mockPauseChatTurn,
    resumeChatTurn: mockResumeChatTurn,
  }),
}));

const mockAttentionMark = jest.fn();
const mockAttentionClear = jest.fn();
jest.mock('../services/attention-tracker', () => ({
  getAttentionTracker: (): { mark: jest.Mock; clear: jest.Mock } => ({
    mark: mockAttentionMark,
    clear: mockAttentionClear,
  }),
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

type UpdateCompatibilityTab = ChatStateService['updateCompatibilityTab'];
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

import * as approvalService from '../approvals/approval-service';
import {
  createApprovalSession,
  type ApprovalSessionContext,
} from '../approvals/approval-service';
import {
  pendingApprovalRequests,
  resolveApproval,
} from '../approvals/pending-approvals';

const ownerWebContents = Object.assign(new EventEmitter(), {
  isCrashed: (): boolean => false,
  isDestroyed: (): boolean => false,
  send: jest.fn(),
  mainFrame: {
    detached: false,
    isDestroyed: (): boolean => false,
  },
});

const ownerWindow: SendableBrowserWindow = {
  isDestroyed: (): boolean => false,
  webContents: ownerWebContents,
};

function makeContext(
  overrides: Partial<ApprovalSessionContext> = {},
): ApprovalSessionContext {
  return {
    sessionKey: 'session-request-cancellation',
    projectId: 'project-1',
    worktreeId: 'worktree-1',
    chatId: 'chat-1',
    provider: 'claude',
    workspaceRoot: '/workspace',
    mode: 'ask',
    sessionRules: [],
    getWindow: () => ownerWindow,
    ...overrides,
  };
}

function commandCheck(command: string): ApprovalCheck {
  return { kind: 'command', command };
}

function commandDisplay(
  command: string,
  signal?: AbortSignal,
  onAwaitingUser?: () => void,
): {
  title: string;
  details: { kind: 'command'; command: string };
  signal?: AbortSignal;
  onAwaitingUser?: () => void;
} {
  return {
    title: `Run ${command}`,
    details: { kind: 'command', command },
    ...(signal !== undefined ? { signal } : {}),
    ...(onAwaitingUser !== undefined ? { onAwaitingUser } : {}),
  };
}

function resolveRequest(
  request: ApprovalRequestEvent,
  decision: ApprovalPromptDecision,
): boolean {
  return resolveApproval(request.requestId, decision, ownerWebContents, {
    projectId: request.projectId,
    worktreeId: request.worktreeId,
    chatId: request.chatId,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  ownerWebContents.removeAllListeners();
  mockRealpath.mockImplementation((path) => Promise.resolve(path));
  mockLstat.mockRejectedValue(
    Object.assign(new Error('missing'), { code: 'ENOENT' }),
  );
  mockReadWorkspaceApprovals.mockResolvedValue(emptyApprovalsFile);
  mockAddWorkspaceApprovalRule.mockResolvedValue(emptyApprovalsFile);
  mockRemoveWorkspaceApprovalRule.mockResolvedValue(emptyApprovalsFile);
  mockReadWorkspaceApprovalsManifest.mockResolvedValue({ rules: [] });
  mockReadPreferencesFile.mockResolvedValue({ globalApprovalRules: [] });
  mockUpdatePreferencesFile.mockImplementation((update) =>
    Promise.resolve({
      globalApprovalRules:
        update({ globalApprovalRules: [] }).globalApprovalRules ?? [],
    }),
  );
  mockSendToWindow.mockReturnValue(true);
  mockSendToWindowDetailed.mockReturnValue({ delivered: true });
  mockUpdateCompatibilityTab.mockResolvedValue({
    tabsFile: { version: 1, tabs: [], activeTabId: '' },
    updated: true,
  });
  mockGetCodeReviewTargetSync.mockReturnValue(null);
  mockGetPlanExploreTargetSync.mockReturnValue(null);
});

describe('approval request cancellation', () => {
  it('exports the cancellation rejection reason', () => {
    expect(approvalService).toHaveProperty(
      'APPROVAL_REQUEST_RESOLVED',
      'approval_request_resolved',
    );
  });

  it('rejects an already-aborted check without showing or recording a prompt', async () => {
    const controller = new AbortController();
    controller.abort();
    const handle = createApprovalSession(makeContext({ mode: 'full-access' }));

    await expect(
      handle.check(commandCheck('npm publish'), {
        ...commandDisplay('npm publish', controller.signal),
      }),
    ).rejects.toThrow('approval_request_resolved');

    expect(pendingApprovalRequests(ownerWebContents)).toEqual([]);
    expect(mockSendToWindowDetailed).not.toHaveBeenCalled();
    expect(mockAttentionMark).not.toHaveBeenCalled();
    expect(mockRecordSessionDiagnostic).not.toHaveBeenCalled();
    handle.dispose();
  });

  it('cancels only its prompt when another same-session prompt is pending', async () => {
    const controller = new AbortController();
    let canceledPromptReady: (() => void) | undefined;
    let siblingPromptReady: (() => void) | undefined;
    const canceledPrompt = new Promise<void>((resolve) => {
      canceledPromptReady = resolve;
    });
    const siblingPrompt = new Promise<void>((resolve) => {
      siblingPromptReady = resolve;
    });
    const cancelledHandle = createApprovalSession(makeContext());
    const siblingHandle = createApprovalSession(makeContext());
    const cancelledCheck = cancelledHandle.check(
      commandCheck('npm publish'),
      commandDisplay('npm publish', controller.signal, () =>
        canceledPromptReady?.(),
      ),
    );
    const siblingCheck = siblingHandle.check(
      commandCheck('npm test'),
      commandDisplay('npm test', undefined, () => siblingPromptReady?.()),
    );

    await Promise.all([canceledPrompt, siblingPrompt]);
    const prompts = pendingApprovalRequests(ownerWebContents);
    expect(prompts).toHaveLength(2);
    const canceledRequest = prompts.find((prompt) =>
      prompt.title.includes('npm publish'),
    );
    const siblingRequest = prompts.find((prompt) =>
      prompt.title.includes('npm test'),
    );
    if (!canceledRequest || !siblingRequest) {
      throw new Error('Expected both same-session prompts to be registered');
    }

    try {
      controller.abort();
      expect(pendingApprovalRequests(ownerWebContents)).toEqual([
        siblingRequest,
      ]);
      await expect(cancelledCheck).rejects.toThrow('approval_request_resolved');
      expect(
        resolveRequest(canceledRequest, {
          behavior: 'allow',
          scope: 'global',
          target: { kind: 'command', pattern: 'npm publish' },
        }),
      ).toBe(false);
      expect(mockUpdatePreferencesFile).not.toHaveBeenCalled();
      expect(mockAddWorkspaceApprovalRule).not.toHaveBeenCalled();
      expect(
        mockUpdateCompatibilityTab.mock.calls.some(([, , , reason]) =>
          String(reason).startsWith('approval-session-rule:'),
        ),
      ).toBe(false);
      expect(
        mockSendToWindowDetailed.mock.calls.filter(
          ([, channel, payload]) =>
            channel === IPC_CHANNELS.approvalCancelled &&
            typeof payload === 'object' &&
            payload !== null &&
            'requestId' in payload &&
            payload.requestId === canceledRequest.requestId,
        ),
      ).toHaveLength(1);
      expect(
        resolveRequest(siblingRequest, { behavior: 'allow', scope: 'once' }),
      ).toBe(true);
      await expect(siblingCheck).resolves.toEqual({ decision: 'allow' });
      expect(mockRecordSessionDiagnostic).toHaveBeenCalledTimes(1);
      expect(mockRecordSessionDiagnostic).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'approval_decision',
          decision: 'allow',
        }),
      );
    } finally {
      cancelledHandle.dispose();
      siblingHandle.dispose();
      await Promise.all([
        cancelledCheck.catch(() => undefined),
        siblingCheck.catch(() => undefined),
      ]);
    }
  });

  it('cancels a queued check before it opens its own prompt', async () => {
    const controller = new AbortController();
    let firstPromptReady: (() => void) | undefined;
    const firstReady = new Promise<void>((resolve) => {
      firstPromptReady = resolve;
    });
    const handle = createApprovalSession(makeContext());
    const firstCheck = handle.check(
      commandCheck('npm test'),
      commandDisplay('npm test', undefined, () => firstPromptReady?.()),
    );
    const queuedCheck = handle.check(
      commandCheck('npm publish'),
      commandDisplay('npm publish', controller.signal),
    );

    await firstReady;
    const firstRequest = pendingApprovalRequests(ownerWebContents)[0];
    if (!firstRequest)
      throw new Error('Expected the first prompt to be pending');

    try {
      controller.abort();
      await expect(queuedCheck).rejects.toThrow('approval_request_resolved');
      expect(pendingApprovalRequests(ownerWebContents)).toEqual([firstRequest]);
      expect(
        mockSendToWindowDetailed.mock.calls.filter(
          ([, channel, payload]) =>
            channel === IPC_CHANNELS.approvalRequest &&
            typeof payload === 'object' &&
            payload !== null &&
            'title' in payload &&
            payload.title === 'Run npm publish',
        ),
      ).toHaveLength(0);

      expect(
        resolveRequest(firstRequest, { behavior: 'allow', scope: 'once' }),
      ).toBe(true);
      await expect(firstCheck).resolves.toEqual({ decision: 'allow' });
      expect(mockRecordSessionDiagnostic).toHaveBeenCalledTimes(1);
    } finally {
      handle.dispose();
      await Promise.all([
        firstCheck.catch(() => undefined),
        queuedCheck.catch(() => undefined),
      ]);
    }
  });

  it('does not deliver a prompt when aborted during durable timer pause', async () => {
    const controller = new AbortController();
    let finishPause: (() => void) | undefined;
    let pauseStarted: (() => void) | undefined;
    let resumeFinished: (() => void) | undefined;
    const pauseIsPending = new Promise<void>((resolve) => {
      pauseStarted = resolve;
    });
    const timerResumed = new Promise<void>((resolve) => {
      resumeFinished = resolve;
    });
    mockUpdateCompatibilityTab.mockImplementation(
      (_identity, _chatId, _update, reason) => {
        if (String(reason).startsWith('approval-turn-timer-resume:')) {
          resumeFinished?.();
        }
        return Promise.resolve({
          tabsFile: { version: 1, tabs: [], activeTabId: '' },
          updated: true,
        });
      },
    );
    mockUpdateCompatibilityTab.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishPause = (): void =>
            resolve({
              tabsFile: { version: 1, tabs: [], activeTabId: '' },
              updated: true,
            });
          pauseStarted?.();
        }),
    );
    const handle = createApprovalSession(makeContext());
    const pendingCheck = handle.check(
      commandCheck('npm publish'),
      commandDisplay('npm publish', controller.signal),
    );

    try {
      await pauseIsPending;
      controller.abort();
      await expect(pendingCheck).rejects.toThrow('approval_request_resolved');
      finishPause?.();
      await timerResumed;

      expect(pendingApprovalRequests(ownerWebContents)).toEqual([]);
      expect(mockSendToWindowDetailed).not.toHaveBeenCalled();
      expect(mockRecordSessionDiagnostic).not.toHaveBeenCalled();
    } finally {
      finishPause?.();
      handle.dispose();
      await pendingCheck.catch(() => undefined);
    }
  });

  it.each(['session', 'project', 'global'] as const)(
    'does not accept a remembered %s allow when abort races the renderer answer',
    async (scope) => {
      const controller = new AbortController();
      let promptReady: (() => void) | undefined;
      const ready = new Promise<void>((resolve) => {
        promptReady = resolve;
      });
      const handle = createApprovalSession(makeContext());
      const pendingCheck = handle.check(
        commandCheck('npm publish'),
        commandDisplay('npm publish', controller.signal, () => promptReady?.()),
      );
      await ready;
      const request = pendingApprovalRequests(ownerWebContents)[0];
      if (!request)
        throw new Error('Expected the approval prompt to be pending');

      expect(
        resolveRequest(request, {
          behavior: 'allow',
          scope,
          target: { kind: 'command', pattern: 'npm publish' },
        }),
      ).toBe(true);
      controller.abort();

      await expect(pendingCheck).rejects.toThrow('approval_request_resolved');
      expect(mockUpdatePreferencesFile).not.toHaveBeenCalled();
      expect(mockAddWorkspaceApprovalRule).not.toHaveBeenCalled();
      expect(mockUpdateCompatibilityTab).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.stringContaining('approval-session-rule:'),
      );
      expect(mockRecordSessionDiagnostic).not.toHaveBeenCalled();
      expect(pendingApprovalRequests(ownerWebContents)).toEqual([]);
      handle.dispose();
    },
  );

  it('keeps an accepted remembered allow when abort follows acceptance', async () => {
    const controller = new AbortController();
    const addAbortListener = jest.spyOn(controller.signal, 'addEventListener');
    const removeAbortListener = jest.spyOn(
      controller.signal,
      'removeEventListener',
    );
    let promptReady: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      promptReady = resolve;
    });
    let markPersistenceStarted: (() => void) | undefined;
    const persistenceStarted = new Promise<void>((resolve) => {
      markPersistenceStarted = resolve;
    });
    let finishPersistence: ((preferences: TestPreferences) => void) | undefined;
    mockUpdatePreferencesFile.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishPersistence = resolve;
          markPersistenceStarted?.();
        }),
    );
    const handle = createApprovalSession(makeContext());
    const pendingCheck = handle.check(
      commandCheck('npm publish'),
      commandDisplay('npm publish', controller.signal, () => promptReady?.()),
    );
    await ready;
    const request = pendingApprovalRequests(ownerWebContents)[0];
    if (!request) throw new Error('Expected the approval prompt to be pending');

    expect(
      resolveRequest(request, {
        behavior: 'allow',
        scope: 'global',
        target: { kind: 'command', pattern: 'npm publish' },
      }),
    ).toBe(true);
    await persistenceStarted;
    controller.abort();
    const update = mockUpdatePreferencesFile.mock.calls[0]?.[0];
    if (!update || !finishPersistence) {
      throw new Error('Expected the global rule write to be pending');
    }
    finishPersistence({
      globalApprovalRules:
        update({ globalApprovalRules: [] }).globalApprovalRules ?? [],
    });

    await expect(pendingCheck).resolves.toEqual({ decision: 'allow' });
    expect(mockRecordSessionDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'approval_decision', decision: 'allow' }),
    );
    expect(
      addAbortListener.mock.calls.some(([event]) => event === 'abort'),
    ).toBe(true);
    expect(
      removeAbortListener.mock.calls.some(([event]) => event === 'abort'),
    ).toBe(true);
    handle.dispose();
  });
});
