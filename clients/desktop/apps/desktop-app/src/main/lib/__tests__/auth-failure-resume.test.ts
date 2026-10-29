import type {
  AuthDependencyFailure,
  CanopyAuthFailureEventData,
} from '@canopy/protocol/auth-recovery';
import { CANOPY_AUTH_FAILURE_EVENT_TYPE } from '@canopy/protocol/auth-recovery';
import type { PersistedChatMessage } from '@canopy/desktop-shared/types';

jest.mock('../chat-turn-cancel', () => ({
  cancelChatTurn: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../ipc/os-notifications', () => ({
  showOsNotification: jest.fn().mockReturnValue({ shown: true }),
}));
jest.mock('../chat-tabs-reader', () => ({
  readChatTabsFile: jest.fn(),
}));
jest.mock('../../services/chat-service', () => ({
  buildExistingTabDispatchOptions: jest.fn().mockResolvedValue({}),
  sendWorktreeChatMessage: jest.fn().mockResolvedValue({ ok: true }),
}));
jest.mock('../../agents/session-manager', () => ({
  getAllActiveSessionInfos: jest.fn().mockReturnValue([]),
}));
// Mocked so the suite cannot write into the real `~/.canopy` observability
// tree, and so the recorded outcome is assertable.
jest.mock('../../observability', () => ({
  getObservabilityService: (): { recordSessionDiagnostic: jest.Mock } => ({
    recordSessionDiagnostic: mockRecordSessionDiagnostic,
  }),
}));
jest.mock('../main-process-logging', () => ({
  logMainProcessError: jest.fn(),
  logMainProcessWarn: jest.fn(),
}));

const mockRecordSessionDiagnostic = jest.fn();

import { readChatTabsFile } from '../chat-tabs-reader';
import {
  buildExistingTabDispatchOptions,
  sendWorktreeChatMessage,
} from '../../services/chat-service';
import { getAllActiveSessionInfos } from '../../agents/session-manager';
import {
  clearPendingAuthResume,
  stopTurnForAuthFailure,
} from '../auth-failure-turn-stop';
import {
  resumeChatsAfterGitHubLogin,
  resumeChatsAfterMcpOAuthSuccess,
} from '../auth-failure-resume';
import { logMainProcessError } from '../main-process-logging';

const mockedLogError = jest.mocked(logMainProcessError);

const mockedReadTabs = jest.mocked(readChatTabsFile);
const mockedSend = jest.mocked(sendWorktreeChatMessage);
const mockedBuildOptions = jest.mocked(buildExistingTabDispatchOptions);
const mockedSessions = jest.mocked(getAllActiveSessionInfos);

const TARGET = {
  projectId: 'ws-1',
  worktreeId: 'wt-1',
  chatId: 'chat-1',
} as const;

const getWindow = (): null => null;

function mcpFailure(): AuthDependencyFailure {
  return {
    dependencyClass: 'mcp',
    dependencyId: 'srv-1:cfg-1',
    displayName: 'Prod MCP server',
    failureClass: 'expired',
    recovery: { kind: 'mcp_oauth', serverId: 'srv-1', configId: 'cfg-1' },
  };
}

function authEvent(): CanopyAuthFailureEventData {
  const failure = mcpFailure();
  return {
    type: CANOPY_AUTH_FAILURE_EVENT_TYPE,
    toolUseId: 'tu-1',
    failure,
    failures: [failure],
  };
}

function seedTab(messages: PersistedChatMessage[]): void {
  mockedReadTabs.mockResolvedValue({
    version: 1,
    tabs: [{ id: TARGET.chatId, title: 'Chat', messages }],
    activeTabId: TARGET.chatId,
  });
}

const USER_MESSAGE: PersistedChatMessage = {
  id: 'm-1',
  role: 'user',
  blocks: [{ type: 'text', text: 'Look up the account records.' }],
  timestamp: 1,
};

const AGENT_ACTIVITY: PersistedChatMessage = {
  id: 'm-2',
  role: 'assistant',
  blocks: [
    {
      type: 'tool_use',
      id: 'tu-1',
      name: 'mcp__prod__list_records',
      input: '{}',
    },
  ],
  timestamp: 2,
};

beforeEach(() => {
  jest.clearAllMocks();
  clearPendingAuthResume(TARGET);
  mockedBuildOptions.mockResolvedValue({});
  mockedSend.mockResolvedValue({ ok: true, chatId: TARGET.chatId });
  mockedSessions.mockReturnValue([]);
});

describe('resumeChatsAfterMcpOAuthSuccess', () => {
  it('re-drives the interrupted turn with the usage-limit resume prompt', async () => {
    seedTab([USER_MESSAGE]);
    await stopTurnForAuthFailure({
      target: TARGET,
      event: authEvent(),
      toolName: 'mcp__prod__list_records',
      initiationSource: 'user',
      getWindow,
    });

    const statuses = await resumeChatsAfterMcpOAuthSuccess({
      serverId: 'srv-1',
      configId: 'cfg-1',
      getWindow,
    });

    expect(statuses).toEqual(['resumed']);
    expect(mockedSend).toHaveBeenCalledTimes(1);
    const [request] = mockedSend.mock.calls[0] ?? [];
    // The last turn was just the user's message failing before the agent did
    // anything, so `computeUsageLimitResumePrompt` re-sends it verbatim.
    expect(request?.text).toBe('Look up the account records.');
    expect(request?.projectId).toBe(TARGET.projectId);
    expect(request?.chatId).toBe(TARGET.chatId);
  });

  it('falls back to Continue when the agent already did work in the turn', async () => {
    seedTab([USER_MESSAGE, AGENT_ACTIVITY]);
    await stopTurnForAuthFailure({
      target: TARGET,
      event: authEvent(),
      toolName: 'mcp__prod__list_records',
      initiationSource: 'user',
      getWindow,
    });

    await resumeChatsAfterMcpOAuthSuccess({
      serverId: 'srv-1',
      configId: 'cfg-1',
      getWindow,
    });

    expect(mockedSend.mock.calls[0]?.[0]?.text).toBe('Continue');
  });

  it('requires an explicit retry when the interrupted call may have written', async () => {
    seedTab([USER_MESSAGE]);
    await stopTurnForAuthFailure({
      target: TARGET,
      event: authEvent(),
      toolName: 'mcp__prod__create_issue',
      initiationSource: 'user',
      getWindow,
    });

    const statuses = await resumeChatsAfterMcpOAuthSuccess({
      serverId: 'srv-1',
      configId: 'cfg-1',
      getWindow,
    });

    expect(statuses).toEqual(['requires-explicit-retry']);
    expect(mockedSend).not.toHaveBeenCalled();
  });

  it('never auto-resumes a background automation turn', async () => {
    seedTab([USER_MESSAGE]);
    await stopTurnForAuthFailure({
      target: TARGET,
      event: authEvent(),
      toolName: 'mcp__prod__list_records',
      initiationSource: 'automation',
      getWindow,
    });

    const statuses = await resumeChatsAfterMcpOAuthSuccess({
      serverId: 'srv-1',
      configId: 'cfg-1',
      getWindow,
    });

    expect(statuses).toEqual(['requires-explicit-retry']);
    expect(mockedSend).not.toHaveBeenCalled();
  });

  it('does not resume a chat that already has a turn in flight', async () => {
    seedTab([USER_MESSAGE]);
    await stopTurnForAuthFailure({
      target: TARGET,
      event: authEvent(),
      toolName: 'mcp__prod__list_records',
      initiationSource: 'user',
      getWindow,
    });
    mockedSessions.mockReturnValue([
      {
        chatId: TARGET.chatId,
        projectId: TARGET.projectId,
        worktreeId: TARGET.worktreeId,
        providerType: 'claude',
        turnActive: true,
        createdAt: 0,
        lastActivityAt: 0,
        turnCount: 1,
        pendingMessageCount: 0,
      },
    ]);

    const statuses = await resumeChatsAfterMcpOAuthSuccess({
      serverId: 'srv-1',
      configId: 'cfg-1',
      getWindow,
    });

    expect(statuses).toEqual(['chat-busy']);
    expect(mockedSend).not.toHaveBeenCalled();
  });

  it('does nothing when the reconnected server did not stop any turn', async () => {
    seedTab([USER_MESSAGE]);
    const statuses = await resumeChatsAfterMcpOAuthSuccess({
      serverId: 'srv-other',
      configId: 'cfg-other',
      getWindow,
    });
    expect(statuses).toEqual([]);
    expect(mockedSend).not.toHaveBeenCalled();
  });

  it('reports a dispatch failure instead of throwing', async () => {
    seedTab([USER_MESSAGE]);
    mockedSend.mockRejectedValue(new Error('dispatch blew up'));
    await stopTurnForAuthFailure({
      target: TARGET,
      event: authEvent(),
      toolName: 'mcp__prod__list_records',
      initiationSource: 'user',
      getWindow,
    });

    await expect(
      resumeChatsAfterMcpOAuthSuccess({
        serverId: 'srv-1',
        configId: 'cfg-1',
        getWindow,
      }),
    ).resolves.toEqual(['dispatch-failed']);
  });
});

// CAN-1814 review (minor). Every resume outcome was invisible: the dispatch
// failure was swallowed by a bare `catch {}` and the caller `void`ed the
// statuses, so a resume that silently never happened looked exactly like one
// that was never attempted.
describe('resume observability', () => {
  beforeEach(() => seedTab([USER_MESSAGE]));

  it('records a session diagnostic for a successful resume', async () => {
    await stopTurnForAuthFailure({
      target: TARGET,
      event: authEvent(),
      toolName: 'mcp__prod__list_issues',
      initiationSource: 'user',
      getWindow,
    });

    await resumeChatsAfterMcpOAuthSuccess({
      serverId: 'srv-1',
      configId: 'cfg-1',
      getWindow,
    });

    expect(mockRecordSessionDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'auth_resume_outcome',
        projectId: 'ws-1',
        worktreeId: 'wt-1',
        chatId: 'chat-1',
        authResumeStatus: 'resumed',
        authResumeTrigger: 'auto',
        authResumeDependencyIds: ['srv-1:cfg-1'],
      }),
    );
  });

  it('logs and records a dispatch failure instead of swallowing it', async () => {
    mockedSend.mockRejectedValueOnce(new Error('provider unavailable'));
    await stopTurnForAuthFailure({
      target: TARGET,
      event: authEvent(),
      toolName: 'mcp__prod__list_issues',
      initiationSource: 'user',
      getWindow,
    });

    const statuses = await resumeChatsAfterMcpOAuthSuccess({
      serverId: 'srv-1',
      configId: 'cfg-1',
      getWindow,
    });

    expect(statuses).toEqual(['dispatch-failed']);
    expect(mockedLogError).toHaveBeenCalled();
    expect(mockRecordSessionDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'auth_resume_outcome',
        authResumeStatus: 'dispatch-failed',
        error: 'provider unavailable',
      }),
    );
  });

  it('records the deliberate requires-explicit-retry outcome', async () => {
    await stopTurnForAuthFailure({
      target: TARGET,
      event: authEvent(),
      // A mutation by name, so an automatic resume is refused.
      toolName: 'mcp__prod__create_issue',
      initiationSource: 'user',
      getWindow,
    });

    const statuses = await resumeChatsAfterMcpOAuthSuccess({
      serverId: 'srv-1',
      configId: 'cfg-1',
      getWindow,
    });

    expect(statuses).toEqual(['requires-explicit-retry']);
    expect(mockRecordSessionDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'auth_resume_outcome',
        authResumeStatus: 'requires-explicit-retry',
      }),
    );
  });
});

function githubFailure(): AuthDependencyFailure {
  return {
    dependencyClass: 'integration',
    dependencyId: 'integration:github',
    displayName: 'GitHub',
    failureClass: 'unauthenticated',
    recovery: { kind: 'github_login' },
  };
}

async function stopForGitHub(
  failures: AuthDependencyFailure[] = [githubFailure()],
): Promise<void> {
  await stopTurnForAuthFailure({
    target: TARGET,
    event: { ...authEvent(), failure: failures[0], failures },
    toolName: 'mcp__github__list_issues',
    initiationSource: 'user',
    getWindow,
  });
}

describe('GitHub stopped-turn recovery', () => {
  it('claims once across concurrent credential refreshes', async () => {
    seedTab([USER_MESSAGE]);
    await stopForGitHub();
    const results = await Promise.all([
      resumeChatsAfterGitHubLogin({ getWindow }),
      resumeChatsAfterGitHubLogin({ getWindow }),
    ]);
    expect(results.flat()).toEqual(['resumed']);
    expect(mockedSend).toHaveBeenCalledTimes(1);
  });

  it.each(['github-first', 'mcp-first'])(
    'resumes mixed dependencies once: %s',
    async (order) => {
      seedTab([USER_MESSAGE]);
      await stopForGitHub([githubFailure(), mcpFailure()]);
      const github = (): Promise<unknown[]> =>
        resumeChatsAfterGitHubLogin({ getWindow });
      const mcp = (): Promise<unknown[]> =>
        resumeChatsAfterMcpOAuthSuccess({
          serverId: 'srv-1',
          configId: 'cfg-1',
          getWindow,
        });
      const [first, last] =
        order === 'github-first' ? [github, mcp] : [mcp, github];
      expect(await first()).toEqual([]);
      expect(mockedSend).not.toHaveBeenCalled();
      expect(await last()).toEqual(['resumed']);
      expect(mockedSend).toHaveBeenCalledTimes(1);
    },
  );

  it('does not resume a deleted chat', async () => {
    seedTab([]);
    mockedReadTabs.mockResolvedValue({
      version: 1,
      tabs: [],
      activeTabId: null,
    });
    await stopForGitHub();
    expect(await resumeChatsAfterGitHubLogin({ getWindow })).toEqual([
      'dispatch-failed',
    ]);
    expect(mockedSend).not.toHaveBeenCalled();
  });

  it('honors cancellation while a claimed recovery is reading the chat', async () => {
    seedTab([USER_MESSAGE]);
    mockedBuildOptions.mockImplementationOnce(() => {
      clearPendingAuthResume(TARGET);
      return Promise.resolve({});
    });
    await stopForGitHub();
    expect(await resumeChatsAfterGitHubLogin({ getWindow })).not.toContain(
      'resumed',
    );
    expect(mockedSend).not.toHaveBeenCalled();
  });

  it('records dispatch failure and does not retry on another refresh', async () => {
    seedTab([USER_MESSAGE]);
    await stopForGitHub();
    mockedSend.mockRejectedValueOnce(new Error('dispatch unavailable'));
    expect(await resumeChatsAfterGitHubLogin({ getWindow })).toEqual([
      'dispatch-failed',
    ]);
    expect(await resumeChatsAfterGitHubLogin({ getWindow })).toEqual([]);
    expect(mockRecordSessionDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ authResumeStatus: 'dispatch-failed' }),
    );
  });

  it('does not automatically resume another failure from an automated continuation', async () => {
    seedTab([USER_MESSAGE]);
    await stopForGitHub();
    await resumeChatsAfterGitHubLogin({ getWindow });
    const failure = githubFailure();
    await stopTurnForAuthFailure({
      target: TARGET,
      event: { ...authEvent(), failure, failures: [failure] },
      toolName: 'mcp__github__list_issues',
      initiationSource: 'automation',
      getWindow,
    });
    expect(await resumeChatsAfterGitHubLogin({ getWindow })).toEqual([
      'requires-explicit-retry',
    ]);
    expect(mockedSend).toHaveBeenCalledTimes(1);
  });
});
