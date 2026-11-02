import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  IPC_CHANNELS,
  type ApprovalMode,
  type ApprovalPromptDecision,
  type ApprovalRequestEvent,
  type ApprovalRule,
  type ApprovalsFile,
} from '@canopy/desktop-shared/types';
import type { AgentDelegationEvent } from '@canopy/protocol/delegation';
import type { WindowSendResult } from '../lib/window-send';
import type { SendableBrowserWindow } from '../lib/window-send';
import type { WorkspaceApprovalsManifest } from '../lib/workspace-approvals-manifest';
import type { WorkspaceApprovalsReadResult } from '../lib/approvals-persistence';

interface TestPreferences {
  globalApprovalRules: ApprovalRule[];
}

const emptyApprovalsFile: ApprovalsFile = { version: 1, rules: [] };
let mockWorkspaceApprovals = emptyApprovalsFile;
let mockGlobalApprovalRules: ApprovalRule[] = [];
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

const mockUpdateCompatibilityTab = jest.fn();
jest.mock('../services/chat-state-service', () => ({
  getChatStateService: (): { updateCompatibilityTab: jest.Mock } => ({
    updateCompatibilityTab: mockUpdateCompatibilityTab,
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

jest.mock('../lib/paths', () => ({
  getPreferencesFilePath: (): string => '/data/preferences.json',
  getMigrationsFilePath: (): string => '/data/migrations.json',
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

import {
  createApprovalSession,
  type ApprovalSessionHandle,
} from '../approvals/approval-service';
import {
  pendingApprovalRequests,
  resolveApproval,
} from '../approvals/pending-approvals';
import { DelegationNativePolicy } from '../agents/delegation/native-policy';

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

type RequestKind = 'command' | 'fileChange' | 'permissions' | 'mcp';

interface ApprovalSystem {
  readonly approval: ApprovalSessionHandle;
  readonly tools: DelegationNativePolicy;
  readonly runController: AbortController;
  readonly events: AgentDelegationEvent['event'][];
  readonly sessionRules: ApprovalRule[];
}

let cwd: string;
let sessionNumber = 0;

function makeApprovalSystem(
  runController = new AbortController(),
): ApprovalSystem {
  const events: AgentDelegationEvent['event'][] = [];
  const sessionRules: ApprovalRule[] = [];
  const mode: ApprovalMode = 'ask';
  const approval = createApprovalSession({
    sessionKey: `delegation-approval-resolved-${++sessionNumber}`,
    projectId: 'project-1',
    worktreeId: 'worktree-1',
    chatId: 'chat-1',
    provider: 'codex',
    workspaceRoot: cwd,
    mode,
    sessionRules,
    getWindow: () => ownerWindow,
    trackChatTurn: false,
  });
  const tools = new DelegationNativePolicy({
    cwd,
    writePaths: ['src'],
    mcpServerNames: ['selected_review'],
    mode: (): ApprovalMode => mode,
    signal: runController.signal,
    delegationId: 'delegation-1',
    allowed: (): Promise<boolean> => Promise.resolve(true),
    approval,
    emit: (event): Promise<void> => {
      events.push(event);
      return Promise.resolve();
    },
  });
  return { approval, tools, runController, events, sessionRules };
}

type CodexApprovalWithRequestSignal = (
  method: string,
  request: Record<string, unknown>,
  requestSignal?: AbortSignal,
) => Promise<Record<string, unknown>>;

function approveCodexWithRequestSignal(
  tools: DelegationNativePolicy,
  method: string,
  request: Record<string, unknown>,
  requestSignal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const approve: CodexApprovalWithRequestSignal =
    tools.approveCodex.bind(tools);
  return approve(method, request, requestSignal);
}

function startRequest(
  tools: DelegationNativePolicy,
  kind: RequestKind,
  requestSignal?: AbortSignal,
  itemId = `request-${kind}`,
): Promise<unknown> {
  const file = path.join(cwd, 'src/file.ts');
  if (kind === 'command')
    return approveCodexWithRequestSignal(
      tools,
      'item/commandExecution/requestApproval',
      { kind: 'command', itemId, cwd, command: 'npm publish' },
      requestSignal,
    );
  if (kind === 'fileChange') {
    tools.observeCodex('item/started', {
      item: {
        type: 'fileChange',
        id: itemId,
        changes: [{ path: file, kind: { type: 'update' } }],
      },
    });
    return approveCodexWithRequestSignal(
      tools,
      'item/fileChange/requestApproval',
      { itemId },
      requestSignal,
    );
  }
  if (kind === 'permissions')
    return approveCodexWithRequestSignal(
      tools,
      'item/permissions/requestApproval',
      {
        itemId,
        permissions: { fileSystem: { read: [], write: [file] } },
      },
      requestSignal,
    );
  return tools.authorizeMcp(
    'selected_review',
    'review_evidence',
    {},
    itemId,
    requestSignal,
  );
}

function requestTitle(kind: RequestKind): string {
  if (kind === 'command') return 'Delegated task wants to run a command';
  if (kind === 'fileChange') return 'Delegated task wants to modify a file';
  if (kind === 'permissions')
    return 'Delegated task wants additional file access';
  return 'Delegated task wants to use review_evidence';
}

function deniedResult(kind: RequestKind): unknown {
  if (kind === 'permissions') return { permissions: {}, scope: 'turn' };
  if (kind === 'mcp') return false;
  return { decision: 'decline' };
}

function rememberedDecision(
  kind: RequestKind,
  scope: 'global' | 'session' = 'global',
): ApprovalPromptDecision {
  if (kind === 'command')
    return {
      behavior: 'allow',
      scope,
      target: { kind: 'command', pattern: 'npm publish' },
    };
  if (kind === 'mcp')
    return {
      behavior: 'allow',
      scope,
      target: {
        kind: 'mcp',
        server: 'selected_review',
        tool: 'review_evidence',
      },
    };
  return {
    behavior: 'allow',
    scope,
    target: { kind: 'file-write', path: path.join(cwd, 'src/file.ts') },
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

// Poll by time, not ticks: the policy awaits real fs checks before the card appears.
async function waitForPendingRequest(
  title: string,
): Promise<ApprovalRequestEvent> {
  for (const deadline = Date.now() + 4_000; Date.now() < deadline; ) {
    const request = pendingApprovalRequests(ownerWebContents).find((entry) =>
      entry.title.includes(title),
    );
    if (request) return request;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Expected an approval request containing: ${title}`);
}

async function flushUntilCardOrSettled(
  operation: Promise<unknown>,
): Promise<void> {
  let settled = false;
  void operation.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  for (const deadline = Date.now() + 4_000; Date.now() < deadline; ) {
    if (settled || pendingApprovalRequests(ownerWebContents).length > 0) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

async function denyVisibleApprovalRequests(): Promise<void> {
  let emptyPolls = 0;
  for (const deadline = Date.now() + 4_000; Date.now() < deadline; ) {
    const pending = pendingApprovalRequests(ownerWebContents);
    if (pending.length === 0) {
      emptyPolls += 1;
      if (emptyPolls === 2) return;
    } else {
      emptyPolls = 0;
      for (const request of pending) {
        resolveRequest(request, { behavior: 'deny', scope: 'once' });
      }
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

function approvalRequestCalls(channel: string): unknown[][] {
  return mockSendToWindowDetailed.mock.calls.filter(
    ([, sentChannel]) => sentChannel === channel,
  );
}

beforeEach(async () => {
  cwd = await mkdtemp(path.join(os.tmpdir(), 'delegation-approval-resolved-'));
  await mkdir(path.join(cwd, 'src'));
  await writeFile(path.join(cwd, 'src/file.ts'), 'before');
  ownerWebContents.removeAllListeners();
  mockWorkspaceApprovals = emptyApprovalsFile;
  mockGlobalApprovalRules = [];
  jest.clearAllMocks();
  mockUpdateCompatibilityTab.mockResolvedValue({ updated: true, tabsFile: {} });
  mockReadWorkspaceApprovals.mockImplementation(() =>
    Promise.resolve(mockWorkspaceApprovals),
  );
  mockAddWorkspaceApprovalRule.mockImplementation((_workspaceId, rule) => {
    mockWorkspaceApprovals = {
      ...mockWorkspaceApprovals,
      rules: [...mockWorkspaceApprovals.rules, rule],
    };
    return Promise.resolve(mockWorkspaceApprovals);
  });
  mockRemoveWorkspaceApprovalRule.mockImplementation((_workspaceId, ruleId) => {
    mockWorkspaceApprovals = {
      ...mockWorkspaceApprovals,
      rules: mockWorkspaceApprovals.rules.filter((rule) => rule.id !== ruleId),
    };
    return Promise.resolve(mockWorkspaceApprovals);
  });
  mockReadPreferencesFile.mockImplementation(() =>
    Promise.resolve({ globalApprovalRules: mockGlobalApprovalRules }),
  );
  mockUpdatePreferencesFile.mockImplementation((update) => {
    mockGlobalApprovalRules =
      update({ globalApprovalRules: mockGlobalApprovalRules })
        .globalApprovalRules ?? mockGlobalApprovalRules;
    return Promise.resolve({ globalApprovalRules: mockGlobalApprovalRules });
  });
  mockReadWorkspaceApprovalsManifest.mockResolvedValue({ rules: [] });
  mockSendToWindow.mockReturnValue(true);
  mockSendToWindowDetailed.mockReturnValue({ delivered: true });
  mockGetCodeReviewTargetSync.mockReturnValue(null);
  mockGetPlanExploreTargetSync.mockReturnValue(null);
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

it.each(['command', 'fileChange', 'permissions', 'mcp'] as const)(
  'rejects an already-aborted %s request before the parent approval is shown',
  async (kind) => {
    const system = makeApprovalSystem();
    const requestSignal = new AbortController();
    requestSignal.abort();
    const operation = startRequest(
      system.tools,
      kind,
      requestSignal.signal,
      `already-aborted-${kind}`,
    );

    try {
      await flushUntilCardOrSettled(operation);
      expect(pendingApprovalRequests(ownerWebContents)).toEqual([]);
      expect(approvalRequestCalls(IPC_CHANNELS.approvalRequest)).toHaveLength(
        0,
      );
      await expect(operation).resolves.toEqual(deniedResult(kind));
      expect(mockRecordSessionDiagnostic).not.toHaveBeenCalled();
    } finally {
      await denyVisibleApprovalRequests();
      system.approval.dispose();
      await Promise.allSettled([operation]);
    }
  },
);

it.each(['command', 'fileChange', 'permissions', 'mcp'] as const)(
  'dismisses a pending %s request without deciding the same-session sibling',
  async (kind) => {
    const system = makeApprovalSystem();
    const requestSignal = new AbortController();
    const operation = startRequest(
      system.tools,
      kind,
      requestSignal.signal,
      `pending-${kind}`,
    );
    const siblingKind: RequestKind =
      kind === 'command' ? 'fileChange' : 'command';
    let sibling: Promise<unknown> | undefined;

    try {
      const canceledRequest = await waitForPendingRequest(requestTitle(kind));
      sibling = startRequest(
        system.tools,
        siblingKind,
        undefined,
        `sibling-${kind}`,
      );
      requestSignal.abort();
      expect(
        pendingApprovalRequests(ownerWebContents).some(
          (request) => request.requestId === canceledRequest.requestId,
        ),
      ).toBe(false);

      await expect(operation).resolves.toEqual(deniedResult(kind));
      const siblingRequest = await waitForPendingRequest(
        requestTitle(siblingKind),
      );
      const pending = pendingApprovalRequests(ownerWebContents);
      expect(pending).toHaveLength(1);
      expect(pending[0]?.requestId).not.toBe(canceledRequest.requestId);
      expect(pending[0]?.requestId).toBe(siblingRequest.requestId);
      expect(
        approvalRequestCalls(IPC_CHANNELS.approvalCancelled).some(
          ([, , payload]) =>
            typeof payload === 'object' &&
            payload !== null &&
            'requestId' in payload &&
            payload.requestId === canceledRequest.requestId,
        ),
      ).toBe(true);
      expect(mockUpdatePreferencesFile).not.toHaveBeenCalled();
      expect(mockAddWorkspaceApprovalRule).not.toHaveBeenCalled();
      expect(mockRecordSessionDiagnostic).not.toHaveBeenCalled();

      expect(
        resolveRequest(siblingRequest, { behavior: 'allow', scope: 'once' }),
      ).toBe(true);
      await expect(sibling).resolves.toEqual({ decision: 'accept' });
      expect(mockRecordSessionDiagnostic).toHaveBeenCalledTimes(1);
      expect(mockRecordSessionDiagnostic).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'approval_decision',
          decision: 'allow',
          targetKind: siblingKind === 'command' ? 'command' : 'file-write',
        }),
      );
      expect(system.events).toEqual([
        { type: 'approval', pending: true },
        { type: 'approval', pending: false },
        { type: 'approval', pending: true },
        { type: 'approval', pending: false },
      ]);
    } finally {
      await denyVisibleApprovalRequests();
      system.approval.dispose();
      await Promise.allSettled([operation, ...(sibling ? [sibling] : [])]);
    }
  },
);

it.each([
  ['command', 'global'],
  ['fileChange', 'global'],
  ['permissions', 'global'],
  ['mcp', 'global'],
  ['command', 'session'],
  ['fileChange', 'session'],
  ['permissions', 'session'],
  ['mcp', 'session'],
] as const)(
  'does not persist or record a remembered %s %s approval when abort wins the answer race',
  async (kind, scope) => {
    const system = makeApprovalSystem();
    const requestSignal = new AbortController();
    const operation = startRequest(
      system.tools,
      kind,
      requestSignal.signal,
      `answer-race-${kind}`,
    );

    try {
      const request = await waitForPendingRequest(requestTitle(kind));
      expect(resolveRequest(request, rememberedDecision(kind, scope))).toBe(
        true,
      );
      requestSignal.abort();

      const outcome = await operation;
      expect(mockGlobalApprovalRules).toEqual([]);
      expect(mockUpdatePreferencesFile).not.toHaveBeenCalled();
      expect(mockAddWorkspaceApprovalRule).not.toHaveBeenCalled();
      expect(mockUpdateCompatibilityTab).not.toHaveBeenCalled();
      expect(system.sessionRules).toEqual([]);
      expect(mockRecordSessionDiagnostic).not.toHaveBeenCalled();
      expect(pendingApprovalRequests(ownerWebContents)).toEqual([]);
      expect(outcome).toEqual(deniedResult(kind));
    } finally {
      await denyVisibleApprovalRequests();
      system.approval.dispose();
      await Promise.allSettled([operation]);
    }
  },
);

it('persists and records a successful remembered approval through the real session', async () => {
  const system = makeApprovalSystem();
  const operation = system.approval.check(
    { kind: 'command', command: 'npm publish', cwd },
    {
      title: requestTitle('command'),
      details: { kind: 'command', command: 'npm publish', cwd },
      suggestedTarget: { kind: 'command', pattern: 'npm publish' },
      toolUseId: 'remembered',
    },
  );

  try {
    const request = await waitForPendingRequest(requestTitle('command'));
    expect(resolveRequest(request, rememberedDecision('command'))).toBe(true);

    await expect(operation).resolves.toMatchObject({ decision: 'allow' });
    expect(mockGlobalApprovalRules).toHaveLength(1);
    expect(mockGlobalApprovalRules[0]).toMatchObject({
      behavior: 'allow',
      origin: 'prompt',
      target: { kind: 'command', pattern: 'npm publish' },
    });
    expect(mockUpdatePreferencesFile).toHaveBeenCalledTimes(1);
    expect(mockRecordSessionDiagnostic).toHaveBeenCalledTimes(1);
    expect(mockRecordSessionDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'approval_decision',
        decision: 'allow',
        scope: 'global',
        targetKind: 'command',
      }),
    );
  } finally {
    await denyVisibleApprovalRequests();
    system.approval.dispose();
    await Promise.allSettled([operation]);
  }
});

it('dismisses the real approval prompt on run cancellation and denies the request', async () => {
  const system = makeApprovalSystem();
  const operation = startRequest(
    system.tools,
    'command',
    undefined,
    'run-cancel',
  );

  try {
    const request = await waitForPendingRequest(requestTitle('command'));
    system.runController.abort();
    expect(pendingApprovalRequests(ownerWebContents)).toEqual([]);

    await expect(operation).resolves.toEqual({ decision: 'decline' });
    expect(pendingApprovalRequests(ownerWebContents)).toEqual([]);
    expect(
      approvalRequestCalls(IPC_CHANNELS.approvalCancelled).some(
        ([, , payload]) =>
          typeof payload === 'object' &&
          payload !== null &&
          'requestId' in payload &&
          payload.requestId === request.requestId,
      ),
    ).toBe(true);
    expect(mockRecordSessionDiagnostic).not.toHaveBeenCalled();
  } finally {
    await denyVisibleApprovalRequests();
    system.approval.dispose();
    await Promise.allSettled([operation]);
  }
});
