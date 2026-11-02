import type {
  AuthDependencyFailure,
  CanopyAuthFailureEventData,
} from '@canopy/protocol/auth-recovery';
import { CANOPY_AUTH_FAILURE_EVENT_TYPE } from '@canopy/protocol/auth-recovery';

jest.mock('../code-review-registry', () => ({
  getCodeReviewTarget: jest.fn((scopeKey: string) =>
    Promise.resolve(
      scopeKey === 'review-scope'
        ? { projectId: 'ws-1', worktreeId: 'wt-1' }
        : null,
    ),
  ),
}));
jest.mock('../chat-turn-cancel', () => ({
  cancelChatTurn: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../ipc/os-notifications', () => ({
  showOsNotification: jest.fn().mockReturnValue({ shown: true }),
}));
// The ONLY path that opens a browser for an MCP reconnect. Asserted
// not-called on the background turn so a future "just log them in" shortcut
// cannot quietly reintroduce CAN-492's surprise browser logins.
jest.mock('../../mcp/oauth-client', () => ({
  startMcpOAuthFlow: jest.fn(),
}));

import {
  EMPTY_SPACE_NOTIFICATION_POLICY_SNAPSHOT,
  spaceNotificationScopeKey,
} from '@canopy/desktop-shared/lib/space-notification-policy';
import { publishSpaceNotificationPolicy } from '../space-notification-gate';
import { CODE_REVIEW_CHAT_PROJECT_ID } from '@canopy/desktop-shared/types';
import { cancelChatTurn } from '../chat-turn-cancel';
import { showOsNotification } from '../../ipc/os-notifications';
import { startMcpOAuthFlow } from '../../mcp/oauth-client';
import {
  clearPendingAuthResume,
  PENDING_AUTH_RESUME_TTL_MS,
  readPendingAuthResume,
  stopTurnForAuthFailure,
  takePendingAuthResumesForMcpServer,
  takePendingAuthResumesForGitHub,
} from '../auth-failure-turn-stop';

const mockedCancel = jest.mocked(cancelChatTurn);
const mockedNotify = jest.mocked(showOsNotification);
const mockedStartOAuth = jest.mocked(startMcpOAuthFlow);

const TARGET = {
  projectId: 'ws-1',
  worktreeId: 'wt-1',
  chatId: 'chat-1',
} as const;

const getWindow = (): null => null;
const REVIEW_TARGET = {
  projectId: CODE_REVIEW_CHAT_PROJECT_ID,
  worktreeId: 'review-scope',
  chatId: 'review-chat',
} as const;

function mcpFailure(
  overrides: Partial<AuthDependencyFailure> = {},
): AuthDependencyFailure {
  return {
    dependencyClass: 'mcp',
    dependencyId: 'srv-1:cfg-1',
    displayName: 'Prod MCP server',
    failureClass: 'expired',
    recovery: { kind: 'mcp_oauth', serverId: 'srv-1', configId: 'cfg-1' },
    ...overrides,
  };
}

function githubFailure(
  overrides: Partial<AuthDependencyFailure> = {},
): AuthDependencyFailure {
  return {
    dependencyClass: 'integration',
    dependencyId: 'integration:github',
    displayName: 'GitHub',
    failureClass: 'unauthenticated',
    recovery: { kind: 'github_login' },
    ...overrides,
  };
}

function authEvent(failure: AuthDependencyFailure): CanopyAuthFailureEventData {
  return {
    type: CANOPY_AUTH_FAILURE_EVENT_TYPE,
    toolUseId: 'tu-1',
    failure,
    failures: [failure],
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  clearPendingAuthResume(TARGET);
});

describe('stopTurnForAuthFailure', () => {
  it('cancels the turn for a recoverable failure and records a pending resume', async () => {
    const result = await stopTurnForAuthFailure({
      target: TARGET,
      event: authEvent(mcpFailure()),
      toolName: 'mcp__prod__list_records',
      initiationSource: 'user',
      getWindow,
    });

    expect(result.stopped).toBe(true);
    expect(mockedCancel).toHaveBeenCalledWith(TARGET, 'teardown', undefined, {
      preserveAuthRecovery: true,
    });
    const pending = readPendingAuthResume(TARGET);
    expect(pending?.dependencyIds).toEqual(['srv-1:cfg-1']);
    expect(pending?.autoResumeSafe).toBe(true);
    expect(pending?.foreground).toBe(true);
  });

  // CAN-1814 PR 4 made `integration` a producible class for the first time.
  // The stop is gated on `recovery.kind`, and `github_login` is a real action,
  // so a GitHub blocker stops the turn for the same reason an MCP one does:
  // the fix is a button rendered above the agent's own output, and letting it
  // keep going burns the run theorising about the wrong problem.
  it('cancels the turn for an integration failure with a github_login recovery', async () => {
    const failure = githubFailure();
    const result = await stopTurnForAuthFailure({
      target: TARGET,
      event: authEvent(failure),
      toolName: 'mcp__canopy__WatchGitHubItems',
      initiationSource: 'user',
      getWindow,
    });

    expect(result.stopped).toBe(true);
    expect(mockedCancel).toHaveBeenCalledWith(TARGET, 'teardown', undefined, {
      preserveAuthRecovery: true,
    });
    const pending = readPendingAuthResume(TARGET);
    expect(pending?.dependencyIds).toEqual(['integration:github']);
    expect(pending?.failures).toEqual([failure]);
  });

  // `WatchGitHubItems` creates a durable watcher, and no allowlisted read verb
  // opens its name. Nothing auto-resumes it: there is no GitHub settle
  // listener either, so recovery always ends in an explicit retry.
  it('never auto-resumes a turn interrupted on WatchGitHubItems', async () => {
    const result = await stopTurnForAuthFailure({
      target: TARGET,
      event: authEvent(githubFailure()),
      toolName: 'mcp__canopy__WatchGitHubItems',
      initiationSource: 'user',
      getWindow,
    });

    expect(result.autoResumeSafe).toBe(false);
    expect(readPendingAuthResume(TARGET)?.autoResumeSafe).toBe(false);
  });

  it('does not hand an integration record to the MCP reconnect claim', async () => {
    await stopTurnForAuthFailure({
      target: TARGET,
      event: authEvent(githubFailure()),
      toolName: 'mcp__canopy__WatchGitHubItems',
      initiationSource: 'user',
      getWindow,
    });

    expect(takePendingAuthResumesForMcpServer('srv-1', 'cfg-1')).toEqual([]);
    expect(readPendingAuthResume(TARGET)).not.toBeNull();
  });

  it('does NOT cancel the turn for a non-recoverable failure', async () => {
    const result = await stopTurnForAuthFailure({
      target: TARGET,
      event: authEvent(
        mcpFailure({
          failureClass: 'insufficient_scope',
          recovery: { kind: 'none' },
        }),
      ),
      toolName: 'mcp__prod__list_records',
      initiationSource: 'user',
      getWindow,
    });

    expect(result.stopped).toBe(false);
    expect(mockedCancel).not.toHaveBeenCalled();
    expect(readPendingAuthResume(TARGET)).toBeNull();
  });

  it('marks a possibly-mutating interruption as needing an explicit retry', async () => {
    await stopTurnForAuthFailure({
      target: TARGET,
      event: authEvent(mcpFailure()),
      toolName: 'mcp__prod__create_issue',
      initiationSource: 'user',
      getWindow,
    });

    expect(readPendingAuthResume(TARGET)?.autoResumeSafe).toBe(false);
  });

  it('notifies instead of logging in for a background automation turn (CAN-492)', async () => {
    const result = await stopTurnForAuthFailure({
      target: TARGET,
      event: authEvent(mcpFailure()),
      toolName: 'mcp__prod__list_records',
      initiationSource: 'automation',
      getWindow,
    });

    expect(result.stopped).toBe(true);
    expect(result.notified).toBe(true);
    expect(mockedNotify).toHaveBeenCalledTimes(1);
    const [request] = mockedNotify.mock.calls[0] ?? [];
    expect(request?.body).toContain('Prod MCP server');
    const pending = readPendingAuthResume(TARGET);
    expect(pending?.foreground).toBe(false);
    // Read-only tool, but a background turn still never auto-resumes: the
    // recovery in front of it is an interactive login nobody is there to do.
    expect(pending?.autoResumeSafe).toBe(false);
    // And nothing opened a browser (CAN-492).
    expect(mockedStartOAuth).not.toHaveBeenCalled();
  });

  it('records the stop but raises no banner when the chat’s space is muted', async () => {
    publishSpaceNotificationPolicy({
      ...EMPTY_SPACE_NOTIFICATION_POLICY_SNAPSHOT,
      accountKey: 'user-1',
      spaces: {
        [spaceNotificationScopeKey(TARGET)]: {
          notificationSpaceId: 'space-1',
          revision: 1,
          override: 'mute',
          transitions: [],
        },
      },
    });
    try {
      const result = await stopTurnForAuthFailure({
        target: TARGET,
        event: authEvent(mcpFailure()),
        toolName: 'mcp__prod__list_records',
        initiationSource: 'automation',
        getWindow,
      });
      expect(result).toMatchObject({ stopped: true, notified: false });
      expect(mockedNotify).not.toHaveBeenCalled();
      expect(readPendingAuthResume(TARGET)?.foreground).toBe(false);
    } finally {
      publishSpaceNotificationPolicy(EMPTY_SPACE_NOTIFICATION_POLICY_SNAPSHOT);
    }
  });

  it('gates a code-review chat by the real worktree it reviews', async () => {
    publishSpaceNotificationPolicy({
      ...EMPTY_SPACE_NOTIFICATION_POLICY_SNAPSHOT,
      accountKey: 'user-1',
      spaces: {
        [spaceNotificationScopeKey(TARGET)]: {
          notificationSpaceId: 'space-1',
          revision: 1,
          override: 'mute',
          transitions: [],
        },
      },
    });
    try {
      const result = await stopTurnForAuthFailure({
        target: REVIEW_TARGET,
        event: authEvent(mcpFailure()),
        toolName: 'mcp__prod__list_records',
        initiationSource: 'automation',
        getWindow,
      });
      expect(result).toMatchObject({ stopped: true, notified: false });
      expect(mockedNotify).not.toHaveBeenCalled();
    } finally {
      publishSpaceNotificationPolicy(EMPTY_SPACE_NOTIFICATION_POLICY_SNAPSHOT);
      clearPendingAuthResume(REVIEW_TARGET);
    }
  });

  it('does not notify for a foreground turn', async () => {
    await stopTurnForAuthFailure({
      target: TARGET,
      event: authEvent(mcpFailure()),
      toolName: 'mcp__prod__list_records',
      initiationSource: 'user',
      getWindow,
    });
    expect(mockedNotify).not.toHaveBeenCalled();
  });
});

describe('takePendingAuthResumesForMcpServer', () => {
  it('claims the record whose recovery names the reconnected server', async () => {
    await stopTurnForAuthFailure({
      target: TARGET,
      event: authEvent(mcpFailure()),
      toolName: 'mcp__prod__list_records',
      initiationSource: 'user',
      getWindow,
    });

    expect(takePendingAuthResumesForMcpServer('srv-9', 'cfg-9')).toEqual([]);
    const claimed = takePendingAuthResumesForMcpServer('srv-1', 'cfg-1');
    expect(claimed).toHaveLength(1);
    // Claiming is destructive so one reconnect drives at most one resume.
    expect(takePendingAuthResumesForMcpServer('srv-1', 'cfg-1')).toEqual([]);
  });

  it('drops records older than the TTL rather than resuming a stale turn', async () => {
    const now = Date.parse('2026-09-03T00:00:00.000Z');
    await stopTurnForAuthFailure({
      target: TARGET,
      event: authEvent(mcpFailure()),
      toolName: 'mcp__prod__list_records',
      initiationSource: 'user',
      getWindow,
      now,
    });

    expect(
      takePendingAuthResumesForMcpServer(
        'srv-1',
        'cfg-1',
        now + PENDING_AUTH_RESUME_TTL_MS + 1,
      ),
    ).toEqual([]);
  });
});

// CAN-1814 review (important). The read-only name gate judges ONE tool; the
// cancel it triggers aborts the whole session. A sibling write still in flight
// when the batch is cancelled never lands its `tool_result`, so the resumed
// session replays a `tool_use` with no result and the model re-issues it.
describe('batch-aware auto-resume safety', () => {
  it('refuses auto-resume when a sibling tool call never landed', async () => {
    const result = await stopTurnForAuthFailure({
      target: TARGET,
      event: authEvent(mcpFailure()),
      // A read by name — the old gate said "safe" on this alone.
      toolName: 'mcp__prod__list_issues',
      batchHasUnresolvedToolCalls: true,
      initiationSource: 'user',
      getWindow,
    });

    expect(result.stopped).toBe(true);
    expect(result.autoResumeSafe).toBe(false);
    expect(readPendingAuthResume(TARGET)?.autoResumeSafe).toBe(false);
  });

  it('still auto-resumes a read whose batch fully landed', async () => {
    const result = await stopTurnForAuthFailure({
      target: TARGET,
      event: authEvent(mcpFailure()),
      toolName: 'mcp__prod__list_issues',
      batchHasUnresolvedToolCalls: false,
      initiationSource: 'user',
      getWindow,
    });

    expect(result.autoResumeSafe).toBe(true);
  });
});

// CAN-1814 review (minor). One provider event can produce SEVERAL pairings — an
// MCP 401 plus an errored Canopy-injected tool, say — and each `set()` over the
// last, so the first pairing's dependencies were silently dropped and the turn
// was cancelled twice.
describe('merging the pairings of one provider event', () => {
  it('merges dependencies and cancels once for a shared stop group', async () => {
    await stopTurnForAuthFailure({
      target: TARGET,
      event: authEvent(mcpFailure()),
      toolName: 'mcp__prod__list_issues',
      stopGroupId: 'group-1',
      initiationSource: 'user',
      getWindow,
    });
    await stopTurnForAuthFailure({
      target: TARGET,
      event: authEvent(githubFailure()),
      toolName: 'WatchGitHubItems',
      stopGroupId: 'group-1',
      initiationSource: 'user',
      getWindow,
    });

    const pending = readPendingAuthResume(TARGET);
    expect(pending?.dependencyIds).toEqual([
      'srv-1:cfg-1',
      'integration:github',
    ]);
    expect(mockedCancel).toHaveBeenCalledTimes(1);
  });

  // AND, never OR. The turn is one unit: an injected tool that is not
  // name-safe makes the whole interruption unsafe to repeat, even though the
  // MCP half was a plain read.
  it('ands autoResumeSafe across the group', async () => {
    await stopTurnForAuthFailure({
      target: TARGET,
      event: authEvent(mcpFailure()),
      toolName: 'mcp__prod__list_issues',
      stopGroupId: 'group-1',
      initiationSource: 'user',
      getWindow,
    });
    expect(readPendingAuthResume(TARGET)?.autoResumeSafe).toBe(true);

    await stopTurnForAuthFailure({
      target: TARGET,
      event: authEvent(githubFailure()),
      toolName: 'WatchGitHubItems',
      stopGroupId: 'group-1',
      initiationSource: 'user',
      getWindow,
    });
    expect(readPendingAuthResume(TARGET)?.autoResumeSafe).toBe(false);
  });

  // A record left over from an EARLIER unrecovered turn must still be replaced
  // and must still cancel, or that later turn would keep running.
  it('replaces and cancels again for a different stop group', async () => {
    await stopTurnForAuthFailure({
      target: TARGET,
      event: authEvent(mcpFailure()),
      stopGroupId: 'group-1',
      initiationSource: 'user',
      getWindow,
    });
    await stopTurnForAuthFailure({
      target: TARGET,
      event: authEvent(githubFailure()),
      stopGroupId: 'group-2',
      initiationSource: 'user',
      getWindow,
    });

    expect(readPendingAuthResume(TARGET)?.dependencyIds).toEqual([
      'integration:github',
    ]);
    expect(mockedCancel).toHaveBeenCalledTimes(2);
  });
});

// CAN-1814 review (minor). Claiming is destructive, so claiming a turn blocked
// on TWO servers when only the first reconnects dispatched a resume that
// immediately failed on the second — and left the second reconnect with
// nothing to resume.
describe('multi-dependency resume claiming', () => {
  const otherServerFailure = mcpFailure({
    dependencyId: 'srv-2:cfg-2',
    displayName: 'Other MCP server',
    recovery: { kind: 'mcp_oauth', serverId: 'srv-2', configId: 'cfg-2' },
  });

  async function stopOnBothServers(): Promise<void> {
    await stopTurnForAuthFailure({
      target: TARGET,
      event: {
        type: CANOPY_AUTH_FAILURE_EVENT_TYPE,
        toolUseId: 'tu-1',
        failure: mcpFailure(),
        failures: [mcpFailure(), otherServerFailure],
      },
      toolName: 'mcp__prod__list_issues',
      initiationSource: 'user',
      getWindow,
    });
  }

  it('does not claim while another blocked server is still outstanding', async () => {
    await stopOnBothServers();

    expect(takePendingAuthResumesForMcpServer('srv-1', 'cfg-1')).toEqual([]);
    expect(readPendingAuthResume(TARGET)).not.toBeNull();
  });

  it('claims once the last blocked server reconnects', async () => {
    await stopOnBothServers();

    takePendingAuthResumesForMcpServer('srv-1', 'cfg-1');
    const claimed = takePendingAuthResumesForMcpServer('srv-2', 'cfg-2');

    expect(claimed).toHaveLength(1);
    expect(claimed[0].dependencyIds).toEqual(['srv-1:cfg-1', 'srv-2:cfg-2']);
    // Still destructive once fully satisfied: a repeated settle event must not
    // re-dispatch into a chat that already resumed.
    expect(takePendingAuthResumesForMcpServer('srv-2', 'cfg-2')).toEqual([]);
    expect(readPendingAuthResume(TARGET)).toBeNull();
  });

  it('still claims a single-dependency record on its first reconnect', async () => {
    await stopTurnForAuthFailure({
      target: TARGET,
      event: authEvent(mcpFailure()),
      initiationSource: 'user',
      getWindow,
    });

    expect(takePendingAuthResumesForMcpServer('srv-1', 'cfg-1')).toHaveLength(
      1,
    );
  });
});

describe('GitHub dependency settlement', () => {
  it.each(['github-first', 'mcp-first'])(
    'waits for every dependency: %s',
    async (order) => {
      const github = githubFailure();
      const mcp = mcpFailure();
      await stopTurnForAuthFailure({
        target: TARGET,
        event: { ...authEvent(github), failures: [github, mcp] },
        toolName: 'list_records',
        initiationSource: 'user',
        getWindow,
      });
      const githubSettle = (): unknown[] => takePendingAuthResumesForGitHub();
      const mcpSettle = (): unknown[] =>
        takePendingAuthResumesForMcpServer('srv-1', 'cfg-1');
      const [first, last] =
        order === 'github-first'
          ? [githubSettle, mcpSettle]
          : [mcpSettle, githubSettle];
      expect(first()).toEqual([]);
      expect(readPendingAuthResume(TARGET)).not.toBeNull();
      expect(last()).toHaveLength(1);
      expect(githubSettle()).toEqual([]);
      expect(mcpSettle()).toEqual([]);
    },
  );

  it('satisfies only the desktop GitHub credential dependency', async () => {
    const github = githubFailure();
    const other = githubFailure({
      dependencyId: 'integration:github-enterprise',
    });
    await stopTurnForAuthFailure({
      target: TARGET,
      event: { ...authEvent(github), failures: [github, other] },
      toolName: 'list_records',
      initiationSource: 'user',
      getWindow,
    });
    expect(takePendingAuthResumesForGitHub()).toEqual([]);
    expect(readPendingAuthResume(TARGET)?.satisfiedDependencyIds).toEqual([
      'integration:github',
    ]);
  });
});
