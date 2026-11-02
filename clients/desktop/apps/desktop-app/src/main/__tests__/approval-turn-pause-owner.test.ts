import type {
  ApprovalCheck,
  ApprovalPromptDecision,
  ApprovalRule,
  ApprovalsFile,
} from '@canopy/desktop-shared/types';
import type * as FsPromises from 'node:fs/promises';
import type { Stats } from 'node:fs';
import type { ChatStateService } from '../services/chat-state-service';
import type { WorkspaceApprovalsManifest } from '../lib/workspace-approvals-manifest';
import type { WorkspaceApprovalsReadResult } from '../lib/approvals-persistence';

interface TurnPauseObservation {
  projectId: string;
  worktreeId: string;
  chatId: string;
  type: 'PauseOpened' | 'PauseClosed';
  ownerKind: 'approval' | 'question';
  ownerId: string;
  turnId?: string;
  atMs?: number;
}

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

const mockReadPreferencesFile = jest.fn<
  Promise<{ globalApprovalRules: ApprovalRule[] }>,
  []
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
  readPreferencesFile: (): Promise<{ globalApprovalRules: ApprovalRule[] }> =>
    mockReadPreferencesFile(),
  updatePreferencesFile: (
    update: (existing: { globalApprovalRules: ApprovalRule[] }) => {
      globalApprovalRules: ApprovalRule[];
    },
  ): Promise<{ globalApprovalRules: ApprovalRule[] }> =>
    Promise.resolve({
      globalApprovalRules:
        update({ globalApprovalRules: [] }).globalApprovalRules ?? [],
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

const mockRequestApprovalFromRenderer = jest.fn<
  Promise<ApprovalPromptDecision>,
  [unknown]
>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isRegistrationCallback(
  value: unknown,
): value is (requestId: string) => void {
  return typeof value === 'function';
}

function isAwaitingUserCallback(value: unknown): value is () => void {
  return typeof value === 'function';
}

jest.mock('../approvals/prompt-bridge', () => ({
  requestApprovalFromRenderer: (
    options: unknown,
  ): Promise<ApprovalPromptDecision> => {
    if (isRecord(options)) {
      const onRegistered = options.onRegistered;
      if (isRegistrationCallback(onRegistered)) {
        onRegistered('approval-request-1');
      }
      const onAwaitingUser = options.onAwaitingUser;
      if (isAwaitingUserCallback(onAwaitingUser)) onAwaitingUser();
    }
    return mockRequestApprovalFromRenderer(options);
  },
}));

jest.mock('../approvals/pending-approvals', () => ({
  cancelApproval: jest.fn(),
  rejectAllApprovalsForSession: jest.fn(),
  resolveApprovalFromMain: jest.fn().mockReturnValue(true),
}));

const mockUpdateCompatibilityTab = jest.fn<
  ReturnType<ChatStateService['updateCompatibilityTab']>,
  Parameters<ChatStateService['updateCompatibilityTab']>
>();
const mockCommitTurnPause = jest.fn<Promise<void>, [TurnPauseObservation]>();
jest.mock('../services/chat-state-service', () => ({
  getChatStateService: (): {
    commitTurnPause: typeof mockCommitTurnPause;
    updateCompatibilityTab: ChatStateService['updateCompatibilityTab'];
  } => ({
    commitTurnPause: mockCommitTurnPause,
    updateCompatibilityTab: mockUpdateCompatibilityTab,
  }),
}));

const mockRecordSessionDiagnostic = jest.fn<void, [unknown]>();
jest.mock('../observability', () => ({
  getObservabilityService: (): { recordSessionDiagnostic: jest.Mock } => ({
    recordSessionDiagnostic: mockRecordSessionDiagnostic,
  }),
}));

import {
  createApprovalSession,
  type ApprovalSessionContext,
} from '../approvals/approval-service';
import { resetApprovalSessionRegistryForTests } from '../approvals/approval-session-registry';

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

function commandCheck(command: string): ApprovalCheck {
  return { kind: 'command', command };
}

function commandDisplay(command: string): {
  title: string;
  details: { kind: 'command'; command: string };
  signal?: AbortSignal;
  onAwaitingUser?: () => void;
} {
  return { title: 'Run command', details: { kind: 'command', command } };
}

function expectPausePair(): void {
  expect(mockCommitTurnPause).toHaveBeenCalledTimes(2);
  const opened = mockCommitTurnPause.mock.calls[0]?.[0];
  const closed = mockCommitTurnPause.mock.calls[1]?.[0];
  expect(opened).toEqual(
    expect.objectContaining({
      projectId: 'proj-1',
      worktreeId: 'wt-1',
      chatId: 'chat-1',
      type: 'PauseOpened',
      ownerKind: 'approval',
    }),
  );
  expect(opened?.ownerId).toMatch(/^approval:/);
  expect(closed).toEqual({
    projectId: 'proj-1',
    worktreeId: 'wt-1',
    chatId: 'chat-1',
    type: 'PauseClosed',
    ownerKind: 'approval',
    ownerId: opened?.ownerId,
  });
  if (mockRequestApprovalFromRenderer.mock.calls.length > 0) {
    const requestOptions = mockRequestApprovalFromRenderer.mock.calls[0]?.[0];
    if (!isRecord(requestOptions) || !isRecord(requestOptions.event)) {
      throw new Error('Expected approval prompt event options');
    }
    expect(requestOptions.event.timerPauseOwnerId).toBe(opened?.ownerId);
  }
}

beforeEach(() => {
  jest.resetAllMocks();
  mockCommitTurnPause.mockResolvedValue(undefined);
  mockRealpath.mockImplementation((path) => Promise.resolve(path));
  mockLstat.mockRejectedValue(
    Object.assign(new Error('missing'), { code: 'ENOENT' }),
  );
  mockReadWorkspaceApprovals.mockResolvedValue(emptyApprovalsFile);
  mockAddWorkspaceApprovalRule.mockResolvedValue(emptyApprovalsFile);
  mockRemoveWorkspaceApprovalRule.mockResolvedValue(emptyApprovalsFile);
  mockReadWorkspaceApprovalsManifest.mockResolvedValue({ rules: [] });
  mockReadPreferencesFile.mockResolvedValue({ globalApprovalRules: [] });
  mockGetCodeReviewTargetSync.mockReturnValue(null);
  mockGetPlanExploreTargetSync.mockReturnValue(null);
  mockUpdateCompatibilityTab.mockResolvedValue({
    tabsFile: { version: 1, tabs: [], activeTabId: '' },
    updated: true,
  });
  mockRequestApprovalFromRenderer.mockResolvedValue({
    behavior: 'allow',
    scope: 'once',
  });
  resetApprovalSessionRegistryForTests();
});

describe('approval turn pause ownership', () => {
  it('opens and closes one owner for the prompt transition after a decision', async () => {
    const handle = createApprovalSession(makeCtx());

    await expect(
      handle.check(commandCheck('npm publish'), commandDisplay('npm publish')),
    ).resolves.toEqual({ decision: 'allow' });

    expectPausePair();
    handle.dispose();
  });

  it('closes the owner when the prompt is cancelled', async () => {
    const controller = new AbortController();
    const handle = createApprovalSession(makeCtx());
    const display = commandDisplay('npm publish');
    display.signal = controller.signal;
    display.onAwaitingUser = (): void => controller.abort();
    mockRequestApprovalFromRenderer.mockRejectedValue(
      new Error('approval cancelled'),
    );

    await expect(
      handle.check(commandCheck('npm publish'), display),
    ).rejects.toThrow('approval_request_resolved');
    await new Promise<void>((resolve) => setImmediate(resolve));

    expectPausePair();
    handle.dispose();
  });

  it('releases a committed pause when cancellation wins before publication', async () => {
    const controller = new AbortController();
    const display = commandDisplay('touch a');
    display.signal = controller.signal;
    mockCommitTurnPause.mockImplementation(async ({ type }) => {
      await Promise.resolve();
      if (type === 'PauseOpened') controller.abort();
    });
    const handle = createApprovalSession(makeCtx());
    await expect(
      handle.check(commandCheck('touch a'), display),
    ).rejects.toThrow('approval_request_resolved');
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(mockRequestApprovalFromRenderer).not.toHaveBeenCalled();
    expectPausePair();
    handle.dispose();
  });

  it('closes the owner when the renderer bridge throws', async () => {
    const handle = createApprovalSession(makeCtx());
    mockRequestApprovalFromRenderer.mockRejectedValue(
      new Error('bridge failed'),
    );

    await expect(
      handle.check(commandCheck('npm publish'), commandDisplay('npm publish')),
    ).resolves.toEqual({
      decision: 'deny',
      message: 'Approval prompt unavailable; denied by default.',
    });

    expectPausePair();
    handle.dispose();
  });

  it('closes the owner even when the legacy pause reports no timer change', async () => {
    const handle = createApprovalSession(makeCtx());
    mockUpdateCompatibilityTab.mockResolvedValue({
      tabsFile: { version: 1, tabs: [], activeTabId: '' },
      updated: false,
    });

    await expect(
      handle.check(commandCheck('npm publish'), commandDisplay('npm publish')),
    ).resolves.toEqual({ decision: 'allow' });

    expectPausePair();
    expect(mockUpdateCompatibilityTab).toHaveBeenCalledTimes(1);
    handle.dispose();
  });

  it('closes the owner when the legacy pause throws', async () => {
    const handle = createApprovalSession(makeCtx());
    mockUpdateCompatibilityTab.mockRejectedValue(new Error('timer failed'));

    await expect(
      handle.check(commandCheck('npm publish'), commandDisplay('npm publish')),
    ).resolves.toEqual({
      decision: 'deny',
      message: 'Approval prompt unavailable; denied by default.',
    });
    expect(mockRequestApprovalFromRenderer).not.toHaveBeenCalled();

    expectPausePair();
    handle.dispose();
  });

  it('closes the owner when the prompt generation changes after opening', async () => {
    const handle = createApprovalSession(makeCtx());
    mockUpdateCompatibilityTab.mockImplementation(() => {
      handle.invalidatePending?.();
      return Promise.resolve({
        tabsFile: { version: 1, tabs: [], activeTabId: '' },
        updated: true,
      });
    });

    await expect(
      handle.check(commandCheck('npm publish'), commandDisplay('npm publish')),
    ).resolves.toEqual({
      decision: 'deny',
      message: 'Approval prompt unavailable; denied by default.',
    });
    expect(mockRequestApprovalFromRenderer).not.toHaveBeenCalled();

    expectPausePair();
    handle.dispose();
  });

  it('releases the owner after an explicit denial', async () => {
    mockRequestApprovalFromRenderer.mockResolvedValue({
      behavior: 'deny',
      scope: 'once',
    });
    const handle = createApprovalSession(makeCtx());
    await expect(
      handle.check(commandCheck('touch a'), commandDisplay('touch a')),
    ).resolves.toMatchObject({ decision: 'deny' });
    expectPausePair();
    handle.dispose();
  });

  it('releases the owner when the prompt times out', async () => {
    mockRequestApprovalFromRenderer.mockRejectedValue(
      new Error('approval_timeout'),
    );
    const handle = createApprovalSession(makeCtx({ promptTimeoutMs: 10 }));
    await expect(
      handle.check(commandCheck('touch a'), commandDisplay('touch a')),
    ).resolves.toEqual({
      decision: 'deny',
      message: 'Approval prompt unavailable; denied by default.',
    });
    expectPausePair();
    handle.dispose();
  });

  it('waits for committed pause before publication and committed resume before allowing', async () => {
    const events: string[] = [];
    mockCommitTurnPause.mockImplementation(async ({ type }) => {
      await Promise.resolve();
      events.push(type);
    });
    mockRequestApprovalFromRenderer.mockImplementation(async () => {
      await Promise.resolve();
      expect(events).toEqual(['PauseOpened']);
      events.push('published');
      return { behavior: 'allow', scope: 'once' };
    });
    const handle = createApprovalSession(makeCtx());
    await expect(
      handle.check(commandCheck('touch a'), commandDisplay('touch a')),
    ).resolves.toEqual({ decision: 'allow' });
    expect(events).toEqual(['PauseOpened', 'published', 'PauseClosed']);
    handle.dispose();
  });

  it('denies provider continuation when releasing the pause cannot commit', async () => {
    mockCommitTurnPause
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('resume commit failed'));
    const handle = createApprovalSession(makeCtx());
    await expect(
      handle.check(commandCheck('touch a'), commandDisplay('touch a')),
    ).resolves.toEqual({
      decision: 'deny',
      message: 'Approval prompt unavailable; denied by default.',
    });
    expectPausePair();
    handle.dispose();
  });

  it('does not pause non-chat approval surfaces', async () => {
    const handle = createApprovalSession(
      makeCtx({ provider: 'cursor', trackChatTurn: false }),
    );

    await expect(
      handle.check(commandCheck('npm publish'), commandDisplay('npm publish')),
    ).resolves.toEqual({ decision: 'allow' });

    expect(mockCommitTurnPause).not.toHaveBeenCalled();
    expect(mockUpdateCompatibilityTab).not.toHaveBeenCalled();
    handle.dispose();
  });

  it('denies without publishing when committing a pause throws', async () => {
    const handle = createApprovalSession(makeCtx());
    mockCommitTurnPause.mockImplementation(() => {
      throw new Error('reducer unavailable');
    });

    await expect(
      handle.check(commandCheck('npm publish'), commandDisplay('npm publish')),
    ).resolves.toEqual({
      decision: 'deny',
      message: 'Approval prompt unavailable; denied by default.',
    });

    expect(mockRequestApprovalFromRenderer).not.toHaveBeenCalled();
    expect(mockCommitTurnPause).toHaveBeenCalledTimes(2);
    handle.dispose();
  });
});
