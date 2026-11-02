const mockEmitSessionEndedBackgroundTaskNotification = jest.fn();
jest.mock('../lib/session-ended-background-tasks', () => ({
  get emitSessionEndedBackgroundTaskNotification(): typeof mockEmitSessionEndedBackgroundTaskNotification {
    return mockEmitSessionEndedBackgroundTaskNotification;
  },
}));

const mockWakeLockAcquire = jest.fn();
const mockWakeLockRelease = jest.fn();
jest.mock('../power/wake-lock-service', () => ({
  getWakeLockService: jest.fn(() => ({
    acquire: mockWakeLockAcquire,
    release: mockWakeLockRelease,
  })),
}));

jest.mock('../lib/e2e-gate', () => ({ isE2eBuild: (): boolean => true }));
jest.mock('../observability', () => ({
  getObservabilityService: jest.fn(() => ({
    recordSessionDiagnostic: jest.fn(),
    interruptMatchingEntries: jest.fn(),
  })),
}));
jest.mock('../lib/bg-output-poller', () => ({
  flushAndStopOutputPollingForSession: jest.fn().mockResolvedValue(undefined),
  stopAllOutputPolling: jest.fn(),
}));
jest.mock('../mcp/pending-requests', () => ({
  rejectAllForSession: jest.fn(),
}));
jest.mock('../plugins/plugin-cleanup', () => ({
  cleanupChatSkillPluginDir: jest.fn(),
  cleanupWorktreeChatPluginDirs: jest.fn(),
}));
jest.mock('../lib/window-send', () => ({ sendToWindow: jest.fn() }));
jest.mock('../auth/provider-auth-state', () => ({
  peekProviderNativeAuthAvailability: jest.fn(() => ({ ollama: true })),
}));
jest.mock('../lib/model-policy-state', () => ({
  isModelBlockedByStoredPolicy: jest.fn().mockResolvedValue(false),
}));

import type { AgentSession } from '../agents/types';
import {
  assertChatCanClose,
  assertWorkspaceCanBeRemoved,
  assertWorktreeCanBeRemoved,
  chatBlocksClose,
  chatCloseBlockReason,
  chatHasBackgroundWork,
  listBackgroundWorkTargets,
  subscribeBackgroundWork,
  workspaceBlocksClose,
  workspaceHasBackgroundWork,
  worktreeBlocksClose,
  worktreeHasBackgroundWork,
} from '../agents/background-work';
import {
  applyE2eIngestedLiveBackgroundTaskEvent,
  recordSessionEvent,
  registerSession,
} from '../agents/session-manager';
import * as sessionManagerExports from '../agents/session-manager';
import {
  BACKGROUND_WORK_CHAT_REFUSAL,
  BACKGROUND_WORK_REMOVAL_REFUSAL,
  LIVE_DELEGATES_CHAT_REFUSAL,
  LIVE_DELEGATES_REMOVAL_REFUSAL,
  LiveDelegationsError,
  setDelegationActivity,
} from '../agents/delegation/activity';

function createSession(): AgentSession {
  return {
    sendMessage: jest.fn(),
    cancel: jest.fn().mockResolvedValue(undefined),
    destroy: jest.fn().mockResolvedValue(undefined),
    setPlanMode: jest.fn().mockResolvedValue(undefined),
    setApprovalMode: jest.fn().mockResolvedValue(undefined),
    setThinkingLevel: jest.fn().mockResolvedValue(undefined),
    setModel: jest.fn().mockResolvedValue(undefined),
  };
}

function startSession(key: string): void {
  registerSession(key, createSession(), new AbortController(), 'claude');
}

function startCodexSession(key: string): void {
  registerSession(key, createSession(), new AbortController(), 'codex');
}

function isUnknownFunction(
  value: unknown,
): value is (...args: unknown[]) => unknown {
  return typeof value === 'function';
}

function invokeSessionManagerExport(name: string, ...args: unknown[]): unknown {
  const exported: unknown = Reflect.get(sessionManagerExports, name);
  if (!isUnknownFunction(exported)) return undefined;
  return exported(...args);
}

function setLiveTask(key: string, taskId: string, taskType: string): void {
  recordSessionEvent(key, {
    type: 'system',
    subtype: 'background_tasks_changed',
    tasks: [{ task_id: taskId, task_type: taskType }],
  });
}

function setE2eLiveTask(
  projectId: string,
  worktreeId: string,
  chatId: string,
  taskId: string,
  taskType: string,
): void {
  applyE2eIngestedLiveBackgroundTaskEvent(projectId, worktreeId, chatId, {
    type: 'system',
    subtype: 'background_tasks_changed',
    tasks: [{ task_id: taskId, task_type: taskType }],
  });
}

describe('background work selectors', () => {
  it('uses Codex child and terminal snapshots in selectors and subscribers without duplicating owners', () => {
    const agentScope = {
      projectId: 'codex-selector-project',
      worktreeId: 'codex-selector-worktree',
      chatId: 'agent',
    };
    const shellScope = { ...agentScope, chatId: 'shell' };
    const agentKey = `${agentScope.projectId}/${agentScope.worktreeId}/${agentScope.chatId}`;
    const shellKey = `${shellScope.projectId}/${shellScope.worktreeId}/${shellScope.chatId}`;
    startCodexSession(agentKey);
    startCodexSession(shellKey);
    const agentToken = invokeSessionManagerExport(
      'registerCodexBackgroundOwner',
      agentScope,
    );
    const shellToken = invokeSessionManagerExport(
      'registerCodexBackgroundOwner',
      shellScope,
    );
    const listener = jest.fn();
    const unsubscribe = subscribeBackgroundWork(listener);

    try {
      expect(
        invokeSessionManagerExport(
          'replaceCodexLiveBackgroundTasks',
          agentToken,
          {
            revision: 1,
            tasks: [{ taskId: 'child-thread', taskType: 'local_agent' }],
          },
        ),
      ).toBe(true);
      expect(
        invokeSessionManagerExport(
          'replaceCodexLiveBackgroundTasks',
          shellToken,
          {
            revision: 1,
            tasks: [{ taskId: 'background-terminal', taskType: 'local_bash' }],
          },
        ),
      ).toBe(true);
      expect(listener).toHaveBeenCalledWith(agentKey);
      expect(listener).toHaveBeenCalledWith(shellKey);

      expect(
        chatHasBackgroundWork(
          agentScope.projectId,
          agentScope.worktreeId,
          agentScope.chatId,
        ),
      ).toBe(true);
      expect(
        chatBlocksClose(
          agentScope.projectId,
          agentScope.worktreeId,
          agentScope.chatId,
        ),
      ).toBe(true);
      expect(() =>
        assertChatCanClose(
          agentScope.projectId,
          agentScope.worktreeId,
          agentScope.chatId,
        ),
      ).toThrow(BACKGROUND_WORK_CHAT_REFUSAL);
      expect(
        chatHasBackgroundWork(
          shellScope.projectId,
          shellScope.worktreeId,
          shellScope.chatId,
        ),
      ).toBe(true);
      expect(
        chatBlocksClose(
          shellScope.projectId,
          shellScope.worktreeId,
          shellScope.chatId,
        ),
      ).toBe(false);
      expect(() =>
        assertChatCanClose(
          shellScope.projectId,
          shellScope.worktreeId,
          shellScope.chatId,
        ),
      ).not.toThrow();

      setDelegationActivity('codex-managed-owner', agentKey, 1);
      const targetsForAgent = listBackgroundWorkTargets().filter(
        (target) => target.sessionKey === agentKey,
      );
      expect(targetsForAgent).toHaveLength(1);
      // D11's count: the live delegation plus the chat's live agent task.
      expect(targetsForAgent[0]).toMatchObject({
        hasBackgroundWork: true,
        blocksClose: true,
        backgroundTasks: 2,
      });
      expect(
        chatCloseBlockReason(
          agentScope.projectId,
          agentScope.worktreeId,
          agentScope.chatId,
        ),
      ).toBe('delegates');
      setDelegationActivity('codex-managed-owner', agentKey, 0);
      expect(
        chatCloseBlockReason(
          agentScope.projectId,
          agentScope.worktreeId,
          agentScope.chatId,
        ),
      ).toBe('background');
    } finally {
      unsubscribe();
    }
  });

  it('distinguishes background shell work from work that blocks close', () => {
    startSession('selector-project/selector-worktree/shell');
    startSession('selector-project/selector-worktree/agent');
    startSession('selector-project/selector-worktree/workflow');
    setLiveTask(
      'selector-project/selector-worktree/shell',
      'shell-task',
      'local_bash',
    );
    setLiveTask(
      'selector-project/selector-worktree/agent',
      'agent-task',
      'local_agent',
    );
    setLiveTask(
      'selector-project/selector-worktree/workflow',
      'workflow-task',
      'local_workflow',
    );
    setDelegationActivity(
      'selector-delegate',
      'selector-project/selector-worktree/delegated',
      0,
      1,
    );
    setDelegationActivity(
      'selector-live-delegate',
      'selector-project/selector-worktree/live-delegated',
      1,
    );

    expect(
      chatHasBackgroundWork('selector-project', 'selector-worktree', 'shell'),
    ).toBe(true);
    expect(
      chatBlocksClose('selector-project', 'selector-worktree', 'shell'),
    ).toBe(false);
    expect(
      chatBlocksClose('selector-project', 'selector-worktree', 'agent'),
    ).toBe(true);
    expect(
      chatBlocksClose('selector-project', 'selector-worktree', 'workflow'),
    ).toBe(true);
    expect(
      chatHasBackgroundWork(
        'selector-project',
        'selector-worktree',
        'delegated',
      ),
    ).toBe(true);
    expect(
      chatBlocksClose('selector-project', 'selector-worktree', 'delegated'),
    ).toBe(true);
    expect(
      chatBlocksClose(
        'selector-project',
        'selector-worktree',
        'live-delegated',
      ),
    ).toBe(true);
  });

  it('aggregates worktree and workspace answers over scoped chat keys', () => {
    startSession('aggregate-project/aggregate-worktree/first-chat');
    startSession('aggregate-project/aggregate-worktree/second-chat');
    startSession('aggregate-project/other-worktree/other-chat');
    startSession(
      'other-aggregate-project/aggregate-worktree/other-project-chat',
    );
    setLiveTask(
      'aggregate-project/aggregate-worktree/first-chat',
      'shell-task',
      'local_bash',
    );
    setLiveTask(
      'aggregate-project/other-worktree/other-chat',
      'workflow-task',
      'local_workflow',
    );
    setE2eLiveTask(
      'aggregate-project',
      'aggregate-worktree',
      'delegated-chat',
      'agent-task',
      'local_bash',
    );

    expect(
      worktreeHasBackgroundWork('aggregate-project', 'aggregate-worktree'),
    ).toBe(true);
    expect(worktreeBlocksClose('aggregate-project', 'aggregate-worktree')).toBe(
      false,
    );
    expect(worktreeBlocksClose('aggregate-project', 'other-worktree')).toBe(
      true,
    );
    expect(workspaceHasBackgroundWork('aggregate-project')).toBe(true);
    expect(workspaceBlocksClose('aggregate-project')).toBe(true);
    expect(workspaceHasBackgroundWork('other-aggregate-project')).toBe(false);
  });

  it('unions live task owners and delegation activity in the target list', () => {
    startSession('targets-project/targets-worktree/empty-chat');
    startSession('targets-project/targets-worktree/shell-chat');
    setLiveTask(
      'targets-project/targets-worktree/shell-chat',
      'shell-task',
      'local_bash',
    );
    setDelegationActivity(
      'target-delegate',
      'targets-project/targets-worktree/delegation-only-chat',
      1,
    );

    const targets = listBackgroundWorkTargets();
    expect(targets).toEqual(
      expect.arrayContaining([
        {
          sessionKey: 'targets-project/targets-worktree/empty-chat',
          projectId: 'targets-project',
          worktreeId: 'targets-worktree',
          chatId: 'empty-chat',
          hasBackgroundWork: false,
          blocksClose: false,
          backgroundTasks: 0,
        },
        {
          sessionKey: 'targets-project/targets-worktree/shell-chat',
          projectId: 'targets-project',
          worktreeId: 'targets-worktree',
          chatId: 'shell-chat',
          hasBackgroundWork: true,
          blocksClose: false,
          backgroundTasks: 1,
        },
        {
          sessionKey: 'targets-project/targets-worktree/delegation-only-chat',
          projectId: 'targets-project',
          worktreeId: 'targets-worktree',
          chatId: 'delegation-only-chat',
          hasBackgroundWork: true,
          blocksClose: true,
          backgroundTasks: 1,
        },
      ]),
    );
  });

  it('subscribes to task and delegation changes and unsubscribes both sources', () => {
    startSession('subscribe-project/subscribe-worktree/live-chat');
    const listener = jest.fn();
    const unsubscribe = subscribeBackgroundWork(listener);
    setLiveTask(
      'subscribe-project/subscribe-worktree/live-chat',
      'live-task',
      'local_bash',
    );
    setDelegationActivity(
      'subscribe-delegate',
      'subscribe-project/subscribe-worktree/delegated-chat',
      1,
    );
    expect(listener).toHaveBeenCalledWith(
      'subscribe-project/subscribe-worktree/live-chat',
    );
    expect(listener).toHaveBeenCalledWith(
      'subscribe-project/subscribe-worktree/delegated-chat',
    );

    const callsBeforeUnsubscribe = listener.mock.calls.length;
    unsubscribe();
    recordSessionEvent('subscribe-project/subscribe-worktree/live-chat', {
      type: 'system',
      subtype: 'task_progress',
      task_id: 'live-task',
      summary: 'changed after unsubscribe',
    });
    setDelegationActivity(
      'subscribe-delegate',
      'subscribe-project/subscribe-worktree/delegated-chat',
      0,
    );
    expect(listener).toHaveBeenCalledTimes(callsBeforeUnsubscribe);

    // The selector is composed against the same live task source.
    expect(
      chatHasBackgroundWork(
        'subscribe-project',
        'subscribe-worktree',
        'live-chat',
      ),
    ).toBe(true);
  });
});

describe('close and removal refusals', () => {
  it('names delegates first, then provider agents and workflows, and never shells', () => {
    startSession('refusal-project/refusal-worktree/shell');
    startSession('refusal-project/refusal-worktree/agent');
    startSession('refusal-project/refusal-worktree/both');
    setLiveTask(
      'refusal-project/refusal-worktree/shell',
      'shell',
      'local_bash',
    );
    setLiveTask(
      'refusal-project/refusal-worktree/agent',
      'agent',
      'local_workflow',
    );
    setLiveTask('refusal-project/refusal-worktree/both', 'both', 'local_agent');
    setDelegationActivity(
      'refusal-delegate',
      'refusal-project/refusal-worktree/both',
      1,
    );

    expect(
      chatCloseBlockReason('refusal-project', 'refusal-worktree', 'shell'),
    ).toBeNull();
    expect(
      chatCloseBlockReason('refusal-project', 'refusal-worktree', 'agent'),
    ).toBe('background');
    expect(
      chatCloseBlockReason('refusal-project', 'refusal-worktree', 'both'),
    ).toBe('delegates');

    expect(() =>
      assertChatCanClose('refusal-project', 'refusal-worktree', 'shell'),
    ).not.toThrow();
    expect(() =>
      assertChatCanClose('refusal-project', 'refusal-worktree', 'agent'),
    ).toThrow(new LiveDelegationsError(BACKGROUND_WORK_CHAT_REFUSAL));
    expect(() =>
      assertChatCanClose('refusal-project', 'refusal-worktree', 'both'),
    ).toThrow(new LiveDelegationsError(LIVE_DELEGATES_CHAT_REFUSAL));

    setDelegationActivity(
      'refusal-delegate',
      'refusal-project/refusal-worktree/both',
      0,
    );
  });

  it('refuses worktree and workspace removal for agents and workflows but not shells', () => {
    startSession('removal-shell-project/removal-worktree/chat');
    setLiveTask(
      'removal-shell-project/removal-worktree/chat',
      'shell',
      'local_bash',
    );
    expect(() =>
      assertWorktreeCanBeRemoved('removal-shell-project', 'removal-worktree'),
    ).not.toThrow();
    expect(() =>
      assertWorkspaceCanBeRemoved('removal-shell-project'),
    ).not.toThrow();

    setE2eLiveTask(
      'removal-agent-project',
      'removal-worktree',
      'chat',
      'agent',
      'local_agent',
    );
    expect(() =>
      assertWorktreeCanBeRemoved('removal-agent-project', 'removal-worktree'),
    ).toThrow(new LiveDelegationsError(BACKGROUND_WORK_REMOVAL_REFUSAL));
    expect(() => assertWorkspaceCanBeRemoved('removal-agent-project')).toThrow(
      new LiveDelegationsError(BACKGROUND_WORK_REMOVAL_REFUSAL),
    );

    setDelegationActivity(
      'removal-delegate',
      'removal-agent-project/removal-worktree/chat',
      1,
    );
    expect(() =>
      assertWorktreeCanBeRemoved('removal-agent-project', 'removal-worktree'),
    ).toThrow(new LiveDelegationsError(LIVE_DELEGATES_REMOVAL_REFUSAL));
    setDelegationActivity(
      'removal-delegate',
      'removal-agent-project/removal-worktree/chat',
      0,
    );
  });
});
