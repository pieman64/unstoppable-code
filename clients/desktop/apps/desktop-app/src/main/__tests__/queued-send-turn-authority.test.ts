import * as creditRouting from '../agents/ai-credits-routing';
/**
 * CAN-4469 P7: queued, restored and Portal sends take their approval
 * authority from the chat's saved tab when the turn starts.
 *
 * Real: `ChatStateService` over a V2 repository in a temporary directory
 * (including the startup reconcile that restores queued sends), chat-service,
 * chat-queue-service, live approval modes, the chat tab reader and
 * `resolveChatTurnApprovalAuthority`. Stubbed: the provider turn. The stub
 * reads its authority with `resolveChatTurnApprovalAuthority`, the read
 * `dispatchWorktreeChatTurn` makes when it creates the session (covered in
 * `worktree-chat-turn.test.ts`), and records what the turn would run with.
 */
import type * as PathModule from 'node:path';
import type {
  ApprovalMode,
  ApprovalRule,
  ChatSendMessageRequest,
} from '@canopy/desktop-shared/types';

const mockGetCanopyDataDir = jest.fn<string, []>();
jest.mock('@canopy/desktop-shared/canopy-paths', () => ({
  getCanopyDataDir: (): string => mockGetCanopyDataDir(),
  getCanopySecureDataDir: (): string => `${mockGetCanopyDataDir()}/secure-data`,
  getPrimaryBrandDataDir: (): string => mockGetCanopyDataDir(),
  getResolvedCanopyDataDir: (): {
    path: string;
    source: 'primary';
    allCandidates: string[];
  } => ({
    path: mockGetCanopyDataDir(),
    source: 'primary',
    allCandidates: [mockGetCanopyDataDir()],
  }),
  getUserEnvironmentFilePath: (): string =>
    `${mockGetCanopyDataDir()}/environments.json`,
  resetResolvedCanopyDataDirCache: (): void => undefined,
}));
jest.mock('../lib/workspace-approvals-manifest', () => ({
  readWorkspaceApprovalsManifest: (): Promise<{ rules: [] }> =>
    Promise.resolve({ rules: [] }),
}));
jest.mock('../observability', () => ({
  getObservabilityService: (): Record<string, jest.Mock> => ({
    recordSessionDiagnostic: jest.fn(),
    recordAppDiagnostic: jest.fn(),
    observeSteeringInput: jest.fn(),
    startChatTurn: jest.fn(),
    completeChatTurn: jest.fn(),
  }),
}));
jest.mock('../integration/claude-terminal-session-service', () => ({
  getClaudeTerminalSessionService: (): {
    getState: () => undefined;
    setApprovalMode: () => Promise<void>;
  } => ({
    getState: () => undefined,
    setApprovalMode: () => Promise.resolve(),
  }),
}));
jest.mock('../account-proxy/routing', () => ({
  previewAccountProxySessionRoute: (): Promise<boolean> =>
    Promise.resolve(true),
}));
jest.mock('../agents/agent-default-model', () => ({
  resolveCatalogAgentDefaultModel: (): Promise<undefined> =>
    Promise.resolve(undefined),
  resolveSendModelPin: (): Promise<undefined> => Promise.resolve(undefined),
}));
jest.mock('../notifications/campaigns/activation-signals', () => ({
  latchFirstTaskSubmitted: jest.fn(),
}));
jest.mock('../lib/window-send', () => ({
  sendToWindow: jest.fn(() => true),
  sendToWindowDetailed: jest.fn(() => ({ delivered: true })),
}));
jest.mock('../portal/portal-event-bus', () => ({
  createPortalEvent: jest.fn((type: string, payload: unknown) => ({
    type,
    payload,
  })),
  enqueuePortalEvent: jest.fn(),
  isCanopyPortalActive: jest.fn(() => false),
  notifyPortalStructureChanged: jest.fn(),
}));
jest.mock('../app-advisor/watchers', () => ({
  getAppAdvisorWatcherService: jest.fn(() => ({
    handleNewChatStartedEvent: jest.fn(),
    handleChatTerminalEvent: jest.fn(),
  })),
}));
jest.mock('../app-advisor/chat-service', () => ({
  dispatchAppAdvisorChatMessage: jest.fn(),
}));
jest.mock('../lib/usage-limited-chats-registry', () => ({
  clearUsageLimitedChat: jest.fn(() => Promise.resolve()),
  recordInterruptedChats: jest.fn(() => Promise.resolve()),
}));
jest.mock('../lib/model-policy-state', () => ({
  isModelBlockedByStoredPolicy: (): Promise<boolean> => Promise.resolve(false),
  isModelBlockedByCurrentPolicy: (): boolean => false,
}));
jest.mock('../lib/transient-error-retry-service', () => ({
  cancelTransientRetryForChat: jest.fn(() => false),
}));
jest.mock('../lib/auth-preflight', () => ({
  assertTurnAuthDependencies: (): Promise<void> => Promise.resolve(),
}));
jest.mock('../agents/session-manager', () => ({
  subscribeGlobalPluginDefaultsRevision: jest.fn(() => jest.fn()),
  subscribeChatSessionActivity: jest.fn(() => jest.fn()),
  subscribeLiveBackgroundTasks: jest.fn(() => jest.fn()),
  getChatSessionLiveness: jest.fn(() => ({
    foreground: false,
    background: false,
  })),
  chatHasNativeBackgroundWork: jest.fn(() => false),
  getSessionTurnSettings: jest.fn(() => undefined),
  getGlobalPluginDefaultsRevision: jest.fn(() => 0),
  getSessionGlobalPluginDefaultsRevision: jest.fn(() => undefined),
  getSessionPluginSelections: jest.fn(() => undefined),
  getActiveChatIds: jest.fn(() => []),
  getActiveSessionInfos: jest.fn(() => []),
  hasPendingCodexContinuation: jest.fn(() => false),
  getSession: jest.fn(() => undefined),
  buildSessionKey: (
    projectId: string,
    worktreeId: string,
    chatId: string,
  ): string => `${projectId}/${worktreeId}/${chatId}`,
  cancelActiveChatTurn: jest.fn(() => false),
  requestChatTurnCancel: jest.fn(),
  destroySession: jest.fn(() => Promise.resolve()),
}));
jest.mock('../agents/work-owner', () => ({
  resolveAiCreditsScopeOwner: (): Promise<{ kind: 'personal' }> =>
    Promise.resolve({ kind: 'personal' }),
}));
jest.mock('../agents/session-event-router', () => ({
  drainCurrentSessionEvents: jest.fn(() => Promise.resolve()),
}));
jest.mock('../services/split-lock-service', () => ({
  assertNotSplitLocked: jest.fn(),
}));
jest.mock('../agents/delegation/lifecycle', () => ({
  claimDelegationDelivery: jest.fn(() => false),
  isDelegationDeliveryActive: jest.fn(() => false),
  releaseDelegationDelivery: jest.fn(),
}));
const mockChatDir = jest.fn<string, []>();
const mockWorkspaceRoot = jest.fn<string, []>();
jest.mock('../lib/resolve-worktree', () => {
  const path = jest.requireActual<typeof PathModule>('node:path');
  return {
    resolveWorktreeTargetIds: (
      projectId: string,
      worktreeId: string,
    ): { projectId: string; worktreeId: string } => ({ projectId, worktreeId }),
    resolveWorktreeCwd: (): string => mockWorkspaceRoot(),
    resolveChatTabsFilePath: (_projectId: string, worktreeId: string): string =>
      path.join(mockChatDir(), 'chats', `${worktreeId}.json`),
    resolveChatArchivesFilePath: (
      _projectId: string,
      worktreeId: string,
    ): string =>
      path.join(mockChatDir(), 'chat-archives', `${worktreeId}.json`),
    resolveChatJournalFilePath: (
      _projectId: string,
      worktreeId: string,
    ): string =>
      path.join(mockChatDir(), 'chat-journals', `${worktreeId}.jsonl`),
  };
});

interface TurnOptions {
  projectId: string;
  worktreeId: string;
  chatId: string;
  userMessageId: string;
  text?: string;
  approvalMode?: ApprovalMode;
  sessionApprovalRules?: ApprovalRule[];
  onTurnAccepted?: () => void;
}
const mockDispatchTurn = jest.fn<Promise<void>, [TurnOptions]>();
jest.mock('../lib/worktree-chat-turn', () => ({
  dispatchWorktreeChatTurn: (options: TurnOptions): Promise<void> =>
    mockDispatchTurn(options),
}));

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  clearLiveApprovalMode,
  setLiveApprovalMode,
} from '../approvals/live-approval-modes';
import {
  getApprovalSettingsRevision,
  markApprovalDefaultsChanged,
} from '../approvals/rule-revisions';
import * as approvalModeResolution from '../lib/approval-mode-resolution';
import { resolveChatTurnApprovalAuthority } from '../lib/chat-turn-approval-authority';
import { resetPreferencesLoadErrorForTests } from '../lib/preferences-store';
import { registerWorkspaceTypes } from '../lib/workspace-registry';
import { getChatQueueService } from '../services/chat-queue-service';
import { getChatTurnOwnership } from '../services/chat-turn-ownership';
import {
  ChatSendAdmissionRefusedError,
  withChatSendAdmission,
} from '../services/chat-send-admission';
import {
  dispatchLocalWorktreeChatMessage,
  sendWorktreeChatMessage,
  setAutoModelRoutingDispatcher,
  setWorktreeChatWindowAccessor,
} from '../services/chat-service';
import {
  ChatStateService,
  resetChatStateServiceForTests,
} from '../services/chat-state-service';
import type { ScopePaths } from '../services/chat-state-contracts';
import { ChatStateV2Repository } from '../services/chat-state-v2-repository';

const SCOPE = { projectId: 'proj-p7', worktreeId: 'wt-p7' };
const CHAT = 'chat-p7';
const TARGET = { ...SCOPE, chatId: CHAT };
const GRANT: ApprovalRule = {
  id: 'grant-npm-test',
  behavior: 'allow',
  target: { kind: 'command', pattern: 'npm test' },
  createdAt: '2026-10-23T00:00:00.000Z',
  origin: 'prompt',
};
const DENY: ApprovalRule = {
  id: 'deny-rm',
  behavior: 'deny',
  target: { kind: 'command', pattern: 'rm -rf *' },
  createdAt: '2026-10-23T00:00:00.000Z',
  origin: 'prompt',
};

interface StartedTurn {
  userMessageId: string;
  /** What the send handed the turn. */
  sent: { approvalMode?: ApprovalMode; ruleIds: string[] };
  /** What the turn starts with. */
  approvalMode: ApprovalMode;
  ruleIds: string[];
}

// Real restores and queue drains over fsync'd commits; slow under load.
jest.setTimeout(120_000);

let tempDir: string;
let chatDir: string;
let repositories: ChatStateV2Repository[] = [];
let services: ChatStateService[] = [];
let turns: StartedTurn[] = [];
let refusals: string[] = [];
let beforeTurnStart: (() => Promise<void>) | undefined;

function ruleIds(rules: readonly ApprovalRule[] | undefined): string[] {
  return (rules ?? []).map((rule) => rule.id);
}

function scopePaths(scope: { worktreeId: string }): ScopePaths {
  return {
    tabs: join(chatDir, 'chats', `${scope.worktreeId}.json`),
    archives: join(chatDir, 'chat-archives', `${scope.worktreeId}.json`),
    journal: join(chatDir, 'chat-journals', `${scope.worktreeId}.jsonl`),
  };
}

/** The running app's chat state; `dispatch` omitted sends commands to the queue. */
function openChatState(dispatchToQueue = false): ChatStateService {
  const repository = new ChatStateV2Repository({ resolvePaths: scopePaths });
  repositories.push(repository);
  const service = new ChatStateService({
    repository,
    ...(dispatchToQueue
      ? {}
      : { dispatch: (): Promise<void> => Promise.resolve() }),
    onInputPickup: (): Promise<void> => Promise.resolve(),
    authorizeSend: (): Promise<void> => Promise.resolve(),
    cleanupSession: (): Promise<void> => Promise.resolve(),
    recordDiagnostic: jest.fn(),
    inputSession: (): Promise<undefined> => Promise.resolve(undefined),
  });
  resetChatStateServiceForTests(service);
  return service;
}

/**
 * Quit, then a new process whose chat state is built as the app builds it:
 * its first read runs the startup reconcile that restores and drains queued
 * sends.
 */
async function restart(): Promise<ChatStateService> {
  for (const repository of repositories) await repository.drainAll();
  repositories = [];
  for (const service of services) await service.drain();
  services = [];
  clearLiveApprovalMode(SCOPE.projectId, SCOPE.worktreeId, CHAT);
  getChatQueueService().resetForTests();
  const service = new ChatStateService({
    dispatch: (): Promise<void> => Promise.resolve(),
    onInputPickup: (): Promise<void> => Promise.resolve(),
    authorizeSend: (): Promise<void> => Promise.resolve(),
    cleanupSession: (): Promise<void> => Promise.resolve(),
    recordDiagnostic: jest.fn(),
    inputSession: (): Promise<undefined> => Promise.resolve(undefined),
  });
  services.push(service);
  resetChatStateServiceForTests(service);
  return service;
}

async function createChat(
  service: ChatStateService,
  approvalMode: ApprovalMode,
  sessionApprovalRules: ApprovalRule[] = [],
): Promise<void> {
  await service.command({
    schemaVersion: 1,
    commandId: `create-${CHAT}`,
    ...SCOPE,
    command: {
      type: 'chat.create_tab',
      tabId: CHAT,
      title: 'Queued chat',
      providerType: 'claude',
      approvalMode,
    },
  });
  if (sessionApprovalRules.length > 0)
    await setSavedRules(service, sessionApprovalRules);
}

/** The commit a "This chat" grant, or its removal, makes. */
async function setSavedRules(
  service: ChatStateService,
  sessionApprovalRules: ApprovalRule[],
): Promise<void> {
  const result = await service.updateCompatibilityTab(
    SCOPE,
    CHAT,
    (tab) => ({ ...tab, sessionApprovalRules }),
    `rules-${ruleIds(sessionApprovalRules).join('-') || 'none'}-${Date.now()}`,
  );
  expect(result.updated).toBe(true);
}

/** The approvalModeSet restriction: live registry first, then the saved tab. */
async function narrowToAsk(service: ChatStateService): Promise<void> {
  setLiveApprovalMode(SCOPE.projectId, SCOPE.worktreeId, CHAT, 'ask');
  await narrowSavedModeToAsk(service);
}

/** A saved-tab-only narrowing, with no live registry write. */
async function narrowSavedModeToAsk(service: ChatStateService): Promise<void> {
  const result = await service.updateCompatibilityTab(
    SCOPE,
    CHAT,
    (tab) => ({ ...tab, approvalMode: 'ask' }),
    `narrow-${Date.now()}`,
  );
  expect(result.updated).toBe(true);
}

async function savedTab(service: ChatStateService): Promise<{
  approvalMode: ApprovalMode | undefined;
  ruleIds: string[];
}> {
  const tab = (
    await service.getCompatibilityTabs(SCOPE, { chatIds: [CHAT] })
  ).tabs.find((candidate) => candidate.id === CHAT);
  return {
    approvalMode: tab?.approvalMode,
    ruleIds: ruleIds(tab?.sessionApprovalRules),
  };
}

/** Holds the queue the way a turn running at quit does. */
function holdBehindRunningTurn(): void {
  const queue = getChatQueueService();
  queue.invalidatePendingInputOperations(TARGET);
  queue.confirmTurnRevived(TARGET, 'turn-running-at-quit');
  expect(queue.isTurnActive(TARGET)).toBe(true);
}

/** The queued requests the chat state holds durably for a restart. */
async function durableQueuedRequests(
  service: ChatStateService,
): Promise<ChatSendMessageRequest[]> {
  const runtime = (await service.getState(SCOPE)).runtimeByChatId[CHAT];
  return (runtime?.queuedMessages ?? []).map((message) => message.request);
}

let turnSettled: (() => void) | undefined;

/** Resolves once `count` turns started or were refused, or fails after 60 s. */
async function untilTurnsSettled(count: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      new Promise<void>((resolveSettled) => {
        const check = (): void => {
          if (turns.length + refusals.length >= count) resolveSettled();
        };
        turnSettled = check;
        check();
      }),
      new Promise<void>((resolveTimeout) => {
        timer = setTimeout(resolveTimeout, 60_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    turnSettled = undefined;
  }
  for (let tick = 0; tick < 5; tick += 1)
    await new Promise<void>((resolveTick) => setImmediate(resolveTick));
  expect(turns.length + refusals.length).toBeGreaterThanOrEqual(count);
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'queued-send-authority-'));
  chatDir = join(tempDir, 'chat-state');
  mockChatDir.mockReturnValue(chatDir);
  mockGetCanopyDataDir.mockReturnValue(join(tempDir, 'data'));
  const root = join(tempDir, 'repo');
  await mkdir(root, { recursive: true });
  mockWorkspaceRoot.mockReturnValue(root);
  resetPreferencesLoadErrorForTests();
  registerWorkspaceTypes(new Map());
  getChatQueueService().resetForTests();
  // Each test reuses the chat id; its canonical owners must not carry over.
  getChatTurnOwnership().resetScopesForTests();
  setWorktreeChatWindowAccessor(() => null);
  setAutoModelRoutingDispatcher((request) => Promise.resolve(request));
  clearLiveApprovalMode(SCOPE.projectId, SCOPE.worktreeId, CHAT);
  repositories = [];
  services = [];
  turns = [];
  refusals = [];
  beforeTurnStart = undefined;
  mockDispatchTurn.mockReset().mockImplementation(async (options) => {
    await beforeTurnStart?.();
    try {
      const authority = await resolveChatTurnApprovalAuthority(options);
      turns.push({
        userMessageId: options.userMessageId,
        sent: {
          ...(options.approvalMode
            ? { approvalMode: options.approvalMode }
            : {}),
          ruleIds: ruleIds(options.sessionApprovalRules),
        },
        approvalMode: authority.approvalMode,
        ruleIds: ruleIds(authority.sessionApprovalRules),
      });
    } catch (error) {
      refusals.push(error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      turnSettled?.();
    }
  });
});

afterEach(async () => {
  getChatQueueService().resetForTests();
  for (const repository of repositories) await repository.drainAll();
  for (const service of services) await service.drain();
  resetChatStateServiceForTests();
  clearLiveApprovalMode(SCOPE.projectId, SCOPE.worktreeId, CHAT);
  await rm(tempDir, { recursive: true, force: true });
});

describe('Portal sends', () => {
  it('keeps a canonical credit-refused queued prompt held through restart', async () => {
    const service = openChatState();
    await createChat(service, 'ask');
    holdBehindRunningTurn();
    await sendWorktreeChatMessage({
      ...TARGET,
      userMessageId: 'credit-held',
      text: 'Original saved prompt',
      providerType: 'claude',
    });
    await service.updateCompatibilityTab(
      SCOPE,
      CHAT,
      (tab) => ({
        ...tab,
        aiCreditsNoBillingSource: { provider: 'claude', detectedAt: 1 },
      }),
      'credit-refused',
    );
    const restarted = await restart();
    await restarted.getState(SCOPE);
    for (let tick = 0; tick < 5; tick += 1)
      await new Promise<void>((resolve) => setImmediate(resolve));
    expect(turns).toHaveLength(0);
    expect(
      getChatQueueService().getWorktreeSnapshots(
        SCOPE.projectId,
        SCOPE.worktreeId,
      )[0]?.queue[0],
    ).toMatchObject({
      text: 'Original saved prompt',
      retryable: true,
      retryBlockedReason: 'insufficient_credits',
    });
    expect(await durableQueuedRequests(restarted)).toEqual([
      expect.objectContaining({
        userMessageId: 'credit-held',
        text: 'Original saved prompt',
      }),
    ]);
  });

  it('retries the original refused queued prompt once through canonical persistence', async () => {
    const funding = jest
      .spyOn(creditRouting, 'getAiCreditsRoutingContext')
      .mockResolvedValue({
        cskToken: 'fixture-only',
        accountIdentity: 'fixture-account',
        email: null,
        creditsEligible: true,
        creditsEligibilityKnown: true,
        cloudBaseUrl: 'https://example.test',
        guestPrincipal: false,
      });
    try {
      const service = openChatState();
      await createChat(service, 'ask');
      const queue = getChatQueueService();
      await queue.pauseForAuthentication(TARGET, 'hold');
      await sendWorktreeChatMessage({
        ...TARGET,
        userMessageId: 'credit-original',
        text: 'Original prompt\nexactly as queued',
        providerType: 'claude',
      });
      const row = queue.getWorktreeSnapshots(
        SCOPE.projectId,
        SCOPE.worktreeId,
      )[0]?.queue[0];
      expect(row).toBeDefined();
      queue.releaseAuthenticationPause(TARGET, 'hold');
      await queue.force(TARGET, row.id);
      await untilTurnsSettled(1);
      await service.updateCompatibilityTab(
        SCOPE,
        CHAT,
        (tab) => ({
          ...tab,
          aiCreditsNoBillingSource: { provider: 'claude', detectedAt: 1 },
        }),
        'credit-original-refused',
      );
      queue.onTurnTerminal(
        TARGET,
        'error',
        'credit-original',
        'insufficient_credits',
      );
      await service.getState(SCOPE);
      expect(await durableQueuedRequests(service)).toEqual([
        expect.objectContaining({
          userMessageId: 'credit-original',
          text: 'Original prompt\nexactly as queued',
        }),
      ]);
      await queue.refreshCreditHolds();
      expect(mockDispatchTurn).toHaveBeenCalledTimes(1);
      const retried = await Promise.all([
        queue.force(TARGET, row.id),
        queue.force(TARGET, row.id),
      ]);
      expect(retried.filter((result) => result === 'applied')).toHaveLength(1);
      await untilTurnsSettled(2);
      expect(mockDispatchTurn).toHaveBeenCalledTimes(2);
      expect(mockDispatchTurn.mock.calls[1]?.[0]).toMatchObject({
        userMessageId: 'credit-original',
        text: 'Original prompt\nexactly as queued',
      });
      expect(await durableQueuedRequests(service)).toHaveLength(0);
    } finally {
      funding.mockRestore();
    }
  });

  it('S3a/S3c: a Portal send queued at Full Access and restored after the chat is narrowed to Ask runs at Ask without the removed grant, and never writes Full Access back', async () => {
    const service = openChatState();
    await createChat(service, 'full-access', [GRANT]);
    holdBehindRunningTurn();
    await sendWorktreeChatMessage({
      ...TARGET,
      userMessageId: 'portal-restored',
      text: 'Continue the task',
      providerType: 'claude',
    });
    // The queued row holds no copy of the chat's approval state.
    const queued = await durableQueuedRequests(service);
    expect(queued).toHaveLength(1);
    expect(queued[0]).not.toHaveProperty('approvalMode');
    expect(queued[0]).not.toHaveProperty('sessionApprovalRules');

    await narrowToAsk(service);
    await setSavedRules(service, []);

    const restarted = await restart();
    await restarted.getState(SCOPE);
    await untilTurnsSettled(1);

    expect(turns).toEqual([
      expect.objectContaining({
        userMessageId: 'portal-restored',
        approvalMode: 'ask',
        ruleIds: [],
      }),
    ]);
    expect(await savedTab(restarted)).toEqual({
      approvalMode: 'ask',
      ruleIds: [],
    });
  });

  it('S3a (live): a queued Portal send drained without a restart runs at Ask without the removed grant', async () => {
    const service = openChatState();
    await createChat(service, 'full-access', [GRANT]);
    const queue = getChatQueueService();
    await queue.pauseForAuthentication(TARGET, 'held');
    await sendWorktreeChatMessage({
      ...TARGET,
      userMessageId: 'portal-live',
      text: 'Continue the task',
      providerType: 'claude',
    });
    await narrowToAsk(service);
    await setSavedRules(service, []);

    queue.releaseAuthenticationPause(TARGET, 'held');
    const rowIds = queue
      .getWorktreeSnapshots(SCOPE.projectId, SCOPE.worktreeId)
      .flatMap((snapshot) => snapshot.queue.map((row) => row.id));
    expect(rowIds).toHaveLength(1);
    for (const rowId of rowIds)
      await expect(queue.force(TARGET, rowId)).resolves.toBe('applied');
    await untilTurnsSettled(1);

    expect(turns).toEqual([
      expect.objectContaining({
        userMessageId: 'portal-live',
        approvalMode: 'ask',
        ruleIds: [],
      }),
    ]);
    expect((await savedTab(service)).approvalMode).toBe('ask');
  });

  it('runs a live Portal send with the caller options it was queued with, and with the saved authority', async () => {
    const service = openChatState();
    await createChat(service, 'auto', [GRANT]);
    const onTurnAccepted = jest.fn();

    await sendWorktreeChatMessage(
      {
        ...TARGET,
        userMessageId: 'portal-now',
        text: 'Run it now',
        providerType: 'claude',
      },
      { onTurnAccepted },
    );
    await untilTurnsSettled(1);

    expect(turns).toEqual([
      expect.objectContaining({
        userMessageId: 'portal-now',
        approvalMode: 'auto',
        ruleIds: [GRANT.id],
      }),
    ]);
    // The queue handed back the same request object it was given, so the
    // caller's live options still reach the dispatch.
    const dispatched = mockDispatchTurn.mock.calls[0]?.[0];
    expect(typeof dispatched?.onTurnAccepted).toBe('function');
    expect((await savedTab(service)).approvalMode).toBe('auto');
  });

  it('D-S3e: a grant removed after the restored send was dispatched, before its turn starts, never reaches the turn', async () => {
    const service = openChatState();
    await createChat(service, 'full-access', [GRANT]);
    holdBehindRunningTurn();
    await sendWorktreeChatMessage({
      ...TARGET,
      userMessageId: 'portal-removed-late',
      text: 'Continue the task',
      providerType: 'claude',
    });

    const restarted = await restart();
    beforeTurnStart = async (): Promise<void> => {
      beforeTurnStart = undefined;
      await setSavedRules(restarted, []);
      await narrowSavedModeToAsk(restarted);
    };
    await restarted.getState(SCOPE);
    await untilTurnsSettled(1);

    expect(turns).toHaveLength(1);
    // The dispatch read the grant and Full Access before the removal...
    expect(turns[0].sent).toEqual({
      approvalMode: 'full-access',
      ruleIds: [GRANT.id],
    });
    // ...and the turn starts with what the chat holds now.
    expect(turns[0]).toMatchObject({ approvalMode: 'ask', ruleIds: [] });
    expect(await savedTab(restarted)).toEqual({
      approvalMode: 'ask',
      ruleIds: [],
    });
  });
});

describe('desktop queued sends', () => {
  it('S3b/S3d: a restored desktop send runs at the saved Ask with only its own deny rule, not the allow rule it carried', async () => {
    const service = openChatState();
    await createChat(service, 'full-access');
    holdBehindRunningTurn();
    await dispatchLocalWorktreeChatMessage({
      ...TARGET,
      userMessageId: 'desktop-restored',
      text: 'Continue the task',
      providerType: 'claude',
      approvalMode: 'full-access',
      sessionApprovalRules: [GRANT, DENY],
    });
    await narrowToAsk(service);

    const restarted = await restart();
    await restarted.getState(SCOPE);
    await untilTurnsSettled(1);

    expect(turns).toEqual([
      {
        userMessageId: 'desktop-restored',
        sent: { approvalMode: 'full-access', ruleIds: [GRANT.id, DENY.id] },
        approvalMode: 'ask',
        ruleIds: [DENY.id],
      },
    ]);
    expect(await savedTab(restarted)).toEqual({
      approvalMode: 'ask',
      ruleIds: [],
    });
  });

  it('D-S3-adm: a restored desktop send is stopped by a send-admission check that refuses the saved tab', async () => {
    const service = openChatState();
    await createChat(service, 'full-access');
    holdBehindRunningTurn();
    await dispatchLocalWorktreeChatMessage({
      ...TARGET,
      userMessageId: 'desktop-admission',
      text: 'Continue the task',
      providerType: 'claude',
      approvalMode: 'full-access',
    });
    await narrowToAsk(service);

    const consulted: (ApprovalMode | undefined)[] = [];
    const restarted = await restart();
    await withChatSendAdmission(
      { ...TARGET, userMessageId: 'desktop-admission' },
      (tab) => {
        consulted.push(tab.approvalMode);
        return tab.approvalMode === 'full-access'
          ? undefined
          : 'The approval settings changed before the message was admitted.';
      },
      async () => {
        await restarted.getState(SCOPE);
        await untilTurnsSettled(1);
      },
    );

    expect(consulted).toEqual(['ask']);
    expect(turns).toEqual([]);
    expect(refusals).toEqual([
      'The approval settings changed before the message was admitted.',
    ]);
  });
});

describe('admitted chat.send_message sends', () => {
  async function sendCommand(
    service: ChatStateService,
    userMessageId: string,
  ): Promise<string> {
    const result = await service.command({
      schemaVersion: 1,
      commandId: `send-${userMessageId}`,
      ...SCOPE,
      command: {
        type: 'chat.send_message',
        chatId: CHAT,
        userMessageId,
        text: 'Continue the task',
      },
    });
    return result.outcome;
  }

  it('a grant removed between the commit and the turn start never reaches the turn', async () => {
    const service = openChatState(true);
    await createChat(service, 'full-access', [GRANT]);
    beforeTurnStart = async (): Promise<void> => {
      beforeTurnStart = undefined;
      await setSavedRules(service, []);
    };

    expect(await sendCommand(service, 'command-removed')).toBe('applied');
    await untilTurnsSettled(1);

    expect(turns).toHaveLength(1);
    // Committed with the grant...
    expect(turns[0].sent.ruleIds).toEqual([GRANT.id]);
    // ...started without it.
    expect(turns[0]).toMatchObject({
      approvalMode: 'full-access',
      ruleIds: [],
    });
  });

  it('a grant removed between the admission check and the turn start stops the turn', async () => {
    const service = openChatState(true);
    await createChat(service, 'full-access', [GRANT]);
    beforeTurnStart = async (): Promise<void> => {
      beforeTurnStart = undefined;
      await setSavedRules(service, []);
    };
    const checked: string[][] = [];

    await withChatSendAdmission(
      { ...TARGET, userMessageId: 'command-checked' },
      (tab) => {
        checked.push(ruleIds(tab.sessionApprovalRules));
        return ruleIds(tab.sessionApprovalRules).includes(GRANT.id)
          ? undefined
          : 'The approval settings changed before the message was admitted.';
      },
      async () => {
        await sendCommand(service, 'command-checked').catch(() => undefined);
        await untilTurnsSettled(1);
      },
    );

    // Admitted at commit, refused at turn start.
    expect(checked).toEqual([[GRANT.id], []]);
    expect(turns).toEqual([]);
    expect(refusals).toEqual([
      'The approval settings changed before the message was admitted.',
    ]);
    await expect(
      resolveChatTurnApprovalAuthority({
        ...TARGET,
        userMessageId: 'command-checked',
      }),
    ).resolves.toEqual({
      approvalMode: 'full-access',
      chatApprovalMode: 'full-access',
      sessionApprovalRules: [],
    });
  });

  it('an agent send queued after its admission runs within what was admitted when the chat is widened before it dispatches, across a restart', async () => {
    const LATER_GRANT: ApprovalRule = {
      ...GRANT,
      id: 'grant-npm-lint',
      target: { kind: 'command', pattern: 'npm run lint' },
    };
    const service = openChatState(true);
    await createChat(service, 'auto', [GRANT]);
    holdBehindRunningTurn();

    // Admitted while the chat ran at Auto with one grant; the check's scope
    // ends once the send is queued.
    await withChatSendAdmission(
      { ...TARGET, userMessageId: 'agent-queued' },
      (tab) =>
        tab.approvalMode === 'auto'
          ? undefined
          : 'The approval settings changed before the message was admitted.',
      () => sendCommand(service, 'agent-queued'),
    );
    const queued = await durableQueuedRequests(service);
    expect(queued.map((request) => request.admittedApproval)).toEqual([
      { approvalMode: 'auto', sessionApprovalRules: [GRANT] },
    ]);

    // Widened before the queued send dispatches.
    const widened = await service.updateCompatibilityTab(
      SCOPE,
      CHAT,
      (tab) => ({
        ...tab,
        approvalMode: 'full-access',
        sessionApprovalRules: [GRANT, LATER_GRANT],
      }),
      `widen-${Date.now()}`,
    );
    expect(widened.updated).toBe(true);

    const restarted = await restart();
    await restarted.getState(SCOPE);
    await untilTurnsSettled(1);

    expect(refusals).toEqual([]);
    expect(turns).toEqual([
      expect.objectContaining({
        userMessageId: 'agent-queued',
        approvalMode: 'auto',
        ruleIds: [GRANT.id],
      }),
    ]);
  });

  describe('into a chat without a saved mode whose default widens around the admission check', () => {
    let resolveSpy: jest.SpyInstance | undefined;

    /**
     * A chat that runs at its default, Ask. After `widenOnNextRead`, the next
     * read of the default finds it widened to Full Access, as when a settings
     * write lands while it is read.
     */
    async function chatAtDefault(service: ChatStateService): Promise<{
      widenOnNextRead: () => void;
      widened: () => boolean;
    }> {
      await service.command({
        schemaVersion: 1,
        commandId: `create-${CHAT}`,
        ...SCOPE,
        command: {
          type: 'chat.create_tab',
          tabId: CHAT,
          title: 'Queued chat',
          providerType: 'claude',
        },
      });
      await setSavedRules(service, [GRANT]);
      let widened = false;
      let pendingWiden = false;
      resolveSpy = jest
        .spyOn(approvalModeResolution, 'resolvePersistedApprovalMode')
        .mockImplementation((_projectId, _worktreeId, tabMode) => {
          if (tabMode !== undefined) return Promise.resolve(tabMode);
          if (pendingWiden) {
            pendingWiden = false;
            widened = true;
            markApprovalDefaultsChanged();
          }
          return Promise.resolve(widened ? 'full-access' : 'ask');
        });
      return {
        widenOnNextRead: (): void => {
          pendingWiden = true;
        },
        widened: () => widened,
      };
    }

    afterEach(() => {
      resolveSpy?.mockRestore();
      resolveSpy = undefined;
    });

    async function send(
      service: ChatStateService,
      userMessageId: string,
      check: () => string | undefined,
    ): Promise<string> {
      return withChatSendAdmission(
        { ...TARGET, userMessageId },
        check,
        async () => {
          const result = await service.command({
            schemaVersion: 1,
            commandId: `send-${userMessageId}`,
            ...SCOPE,
            command: {
              type: 'chat.send_message',
              chatId: CHAT,
              userMessageId,
              text: 'Continue the task',
            },
          });
          return result.outcome;
        },
      );
    }

    it('queues an agent send at the default its check admitted, and its turn starts there after the default widens, across a restart', async () => {
      const service = openChatState(true);
      const chat = await chatAtDefault(service);
      holdBehindRunningTurn();
      const admittedAt = getApprovalSettingsRevision();

      // As root agent sends check: refused once the approval settings it read
      // have changed. The default widens right after the commit admits it.
      const outcome = await send(service, 'agent-widened', () => {
        if (getApprovalSettingsRevision() !== admittedAt)
          return 'The approval settings changed.';
        chat.widenOnNextRead();
        return undefined;
      });
      await approvalModeResolution.resolvePersistedApprovalMode(
        SCOPE.projectId,
        SCOPE.worktreeId,
      );

      expect(outcome).toBe('applied');
      expect(chat.widened()).toBe(true);
      expect(
        (await durableQueuedRequests(service)).map(
          (request) => request.admittedApproval,
        ),
      ).toEqual([{ approvalMode: 'ask', sessionApprovalRules: [GRANT] }]);

      const restarted = await restart();
      await restarted.getState(SCOPE);
      await untilTurnsSettled(1);

      expect(refusals).toEqual([]);
      expect(turns).toEqual([
        expect.objectContaining({
          userMessageId: 'agent-widened',
          approvalMode: 'ask',
          ruleIds: [GRANT.id],
        }),
      ]);
    });

    it('admits at Ask a send whose check holds though the default changed as it was read', async () => {
      const service = openChatState(true);
      const chat = await chatAtDefault(service);
      holdBehindRunningTurn();
      // The read before the commit finds the default widening; a check that
      // does not track the settings revision still admits the send.
      chat.widenOnNextRead();

      expect(await send(service, 'agent-changed', () => undefined)).toBe(
        'applied',
      );

      expect(chat.widened()).toBe(true);
      expect(
        (await durableQueuedRequests(service)).map(
          (request) => request.admittedApproval,
        ),
      ).toEqual([{ approvalMode: 'ask', sessionApprovalRules: [GRANT] }]);
    });

    it('queues a send at the default its admission check admitted', async () => {
      const service = openChatState(true);
      await chatAtDefault(service);
      holdBehindRunningTurn();

      expect(await send(service, 'agent-steady', () => undefined)).toBe(
        'applied',
      );

      expect(
        (await durableQueuedRequests(service)).map(
          (request) => request.admittedApproval,
        ),
      ).toEqual([{ approvalMode: 'ask', sessionApprovalRules: [GRANT] }]);
    });
  });

  it('a send committed with no admission check carries no admitted approval', async () => {
    const service = openChatState(true);
    await createChat(service, 'auto', [GRANT]);
    holdBehindRunningTurn();

    await sendCommand(service, 'user-queued');

    const queued = await durableQueuedRequests(service);
    expect(queued).toHaveLength(1);
    expect(queued[0]).not.toHaveProperty('admittedApproval');
  });
});

describe('a send with no saved tab', () => {
  it('starts with no grants and refuses a registered admission check', async () => {
    openChatState();
    await expect(
      resolveChatTurnApprovalAuthority({
        ...TARGET,
        userMessageId: 'no-tab',
        approvalMode: 'full-access',
        sessionApprovalRules: [GRANT, DENY],
      }),
    ).resolves.toEqual(
      expect.objectContaining({ sessionApprovalRules: [DENY] }),
    );
    await expect(
      withChatSendAdmission(
        { ...TARGET, userMessageId: 'no-tab-checked' },
        () => undefined,
        () =>
          resolveChatTurnApprovalAuthority({
            ...TARGET,
            userMessageId: 'no-tab-checked',
          }),
      ),
    ).rejects.toThrow(ChatSendAdmissionRefusedError);
  });
});
