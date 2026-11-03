import {
  STANDALONE_CHAT_PROJECT_ID,
  type AgentScheduledSend,
  type ScheduledActivity,
} from '@canopy/desktop-shared/types';
import type * as ProjectBotPortModule from '../../agent-actions/desktop-project-bot-port';
import { AgentChatSendError } from '../../agent-messaging/send-orchestration';
import {
  AUTOMATION_OWNER_MISMATCH_MESSAGE,
  automationRefusalError,
  automationSendCaller,
  automationSendIds,
  dispatchAutomationAction,
  staysNativeAutomationSend,
} from '../automation-send';

let mockContextsEnabled = true;
const mockSavedOwner = jest.fn();
const mockRunPort = jest.fn();

jest.mock('../../services/background-execution-context', () => ({
  backgroundExecutionContextEnabled: (): boolean => mockContextsEnabled,
}));
jest.mock('../../lib/project-owner', () => ({
  resolveProjectSavedOwner: (...args: unknown[]): unknown =>
    mockSavedOwner(...args),
}));
jest.mock('../../agent-actions/desktop-project-bot-port', () => ({
  ...jest.requireActual<typeof ProjectBotPortModule>(
    '../../agent-actions/desktop-project-bot-port',
  ),
  runPipelineProjectBotAction: (...args: unknown[]): unknown =>
    mockRunPort(...args),
}));

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const ACTIVITY = { id: 'automation-1', name: 'Daily triage' };
const TARGET = { projectId: 'workspace-1', worktreeId: 'worktree-1' };

beforeEach(() => {
  mockContextsEnabled = true;
  mockSavedOwner.mockReset();
  mockRunPort.mockReset();
});

describe('automationSendCaller', () => {
  it('uses the bound organization context when background contexts are on', async () => {
    const caller = await automationSendCaller(
      {
        ...ACTIVITY,
        executionContext: 'org:5f0c7a4e-1b2d-4c3e-9f8a-0b1c2d3e4f5a',
      },
      TARGET,
    );
    expect(caller).toStrictEqual({
      kind: 'pipeline',
      source: {
        kind: 'automation',
        automationId: 'automation-1',
        automationName: 'Daily triage',
        owner: {
          kind: 'organization',
          organizationId: '5f0c7a4e-1b2d-4c3e-9f8a-0b1c2d3e4f5a',
        },
      },
    });
    expect(mockSavedOwner).not.toHaveBeenCalled();
  });

  it('falls back to the target’s saved owner when contexts are off (Review Focus 2)', async () => {
    mockContextsEnabled = false;
    mockSavedOwner.mockResolvedValue({
      kind: 'organization',
      organizationId: 'org-2',
    });
    const caller = await automationSendCaller(
      {
        ...ACTIVITY,
        executionContext: 'org:5f0c7a4e-1b2d-4c3e-9f8a-0b1c2d3e4f5a',
      },
      TARGET,
    );
    expect(caller.source.owner).toStrictEqual({
      kind: 'organization',
      organizationId: 'org-2',
    });
    expect(mockSavedOwner).toHaveBeenCalledWith(TARGET);
  });

  it('falls back to the target’s saved owner for an unbound automation', async () => {
    mockSavedOwner.mockResolvedValue({
      kind: 'organization',
      organizationId: 'org-3',
    });
    const caller = await automationSendCaller(ACTIVITY, TARGET);
    expect(caller.source.owner).toStrictEqual({
      kind: 'organization',
      organizationId: 'org-3',
    });
  });

  it('runs an Orchestrator target with no owner as Personal', async () => {
    mockSavedOwner.mockResolvedValue({ kind: 'none' });
    const caller = await automationSendCaller(ACTIVITY, {
      projectId: 'app-advisor',
    });
    expect(caller.source.owner).toStrictEqual({ kind: 'personal' });
  });

  it('refuses an unparseable bound context with the owner-mismatch text', async () => {
    await expect(
      automationSendCaller(
        { ...ACTIVITY, executionContext: 'not a context' },
        TARGET,
      ),
    ).rejects.toThrow(AUTOMATION_OWNER_MISMATCH_MESSAGE);
  });

  it('refuses an unknown saved owner with the owner-mismatch text', async () => {
    mockSavedOwner.mockResolvedValue({ kind: 'unknown' });
    await expect(automationSendCaller(ACTIVITY, TARGET)).rejects.toThrow(
      AUTOMATION_OWNER_MISMATCH_MESSAGE,
    );
  });

  it('leaves agent admission unset (Open question 2)', async () => {
    const caller = await automationSendCaller(
      { ...ACTIVITY, executionContext: 'personal' },
      TARGET,
    );
    expect(caller.source.agentOrigin).toBeUndefined();
  });
});

describe('automationSendIds', () => {
  it('is stable for a run and differs across runs and kinds', () => {
    const first = automationSendIds('run-1', 'session', 'codex');
    expect(automationSendIds('run-1', 'session', 'codex')).toStrictEqual(first);
    expect(automationSendIds('run-2', 'session', 'codex').commandId).not.toBe(
      first.commandId,
    );
    expect(automationSendIds('run-1', 'create', 'codex').commandId).not.toBe(
      first.commandId,
    );
  });

  it('keeps today’s session message IDs', () => {
    expect(automationSendIds('run-1', 'session', 'codex').userMessageId).toBe(
      'automation-run-1',
    );
    expect(
      automationSendIds(
        '9b1c1f0e-2a5b-4c8e-9f00-0d1e2f3a4b5c',
        'session',
        'opencode',
      ).userMessageId,
    ).toBe('9b1c1f0e-2a5b-4c8e-9f00-0d1e2f3a4b5c');
  });

  it('derives every other ID as a version-5 UUID', () => {
    const ids = automationSendIds('run-1', 'create', undefined);
    for (const value of [
      ids.commandId,
      ids.userMessageId,
      ids.tabId,
      ids.createTabCommandId,
      ids.taskId,
    ])
      expect(value).toMatch(UUID);
    expect(new Set(Object.values(ids)).size).toBe(Object.keys(ids).length);
  });
});

describe('automationRefusalError', () => {
  it.each([
    'not_found',
    'owner_boundary',
    'owner_context_unavailable',
    'authorization_conflict',
  ] as const)('reads %s as an owner mismatch', (code) => {
    expect(
      automationRefusalError('worktree_session_prompt', {
        code,
        message: 'The target chat is not available.',
      }).message,
    ).toBe(AUTOMATION_OWNER_MISMATCH_MESSAGE);
  });

  it('keeps the name-free reason for any other refusal', () => {
    expect(
      automationRefusalError('worktree_session_prompt', {
        code: 'unsupported_action',
        message: 'Setup queuing is only supported for code targets.',
      }).message,
    ).toBe(
      'The automation could not send its message. Setup queuing is only supported for code targets.',
    );
  });
});

describe('staysNativeAutomationSend', () => {
  type D4Activity = Pick<ScheduledActivity, 'action' | 'agentScheduledSend'>;
  const session = {
    type: 'worktree_session_prompt',
    workspaceId: 'workspace-1',
    worktreeId: 'worktree-1',
    chatId: 'chat-1',
    prompt: 'Continue',
  } as const;
  const agentScheduledSend: AgentScheduledSend = {
    version: 1,
    agentSent: {
      sender: {
        kind: 'project',
        projectType: 'code',
        projectId: 'workspace-2',
        taskId: 'worktree-2',
        chatId: 'chat-2',
      },
      chatTitle: 'Planner',
      projectLabel: 'Other',
    },
    provenance: {
      version: 1,
      capturedAt: '2026-10-28T00:00:00.000Z',
      acceptedInputId: 'input-1',
      sender: {
        kind: 'project',
        projectType: 'code',
        projectId: 'workspace-2',
        taskId: 'worktree-2',
        chatId: 'chat-2',
      },
      owner: { kind: 'personal' },
    },
  };
  const cases: Array<[string, D4Activity]> = [
    [
      'a usage-limit resume',
      { action: { ...session, purpose: 'usage_limit_resume' } },
    ],
    [
      'a composer scheduled send',
      { action: { ...session, purpose: 'scheduled_send' } },
    ],
    ['an agent scheduled send', { action: session, agentScheduledSend }],
    [
      'a legacy standalone-addressed session prompt',
      {
        action: {
          ...session,
          workspaceId: STANDALONE_CHAT_PROJECT_ID,
          worktreeId: 'chat-project-1',
        },
      },
    ],
    [
      'the Home scheduled task',
      {
        action: {
          type: 'worktree_prompt',
          workspaceId: 'workspace-1',
          prompt: 'Go',
          purpose: 'scheduled_task',
        },
      },
    ],
  ];

  it.each(cases)('keeps %s native', (_label, activity) => {
    expect(staysNativeAutomationSend(activity)).toBe(true);
  });

  it('moves an ordinary session or worktree prompt', () => {
    expect(staysNativeAutomationSend({ action: session })).toBe(false);
    expect(
      staysNativeAutomationSend({
        action: {
          type: 'worktree_prompt',
          workspaceId: 'workspace-1',
          prompt: 'Go',
        },
      }),
    ).toBe(false);
  });
});

describe('dispatchAutomationAction', () => {
  const action = {
    type: 'projects.send_message',
    projectId: 'workspace-1',
    taskId: 'worktree-1',
    chatId: 'chat-1',
    text: 'Continue',
  } as const;
  const caller = {
    kind: 'pipeline',
    source: {
      kind: 'automation',
      automationId: 'automation-1',
      automationName: 'Daily triage',
      owner: { kind: 'personal' },
    },
  } as const;

  it('returns the receipt and passes the options without the action type', async () => {
    const receipt = {
      address: {
        projectId: 'workspace-1',
        taskId: 'worktree-1',
        chatId: 'chat-1',
      },
      acceptedAt: '2026-10-28T00:00:00.000Z',
      watcherReceipts: [],
      disposition: 'started',
      messageId: 'automation-run-1',
    };
    mockRunPort.mockResolvedValue(receipt);
    await expect(
      dispatchAutomationAction(action, caller, {
        actionType: 'worktree_session_prompt',
        composition: { inputMode: 'typed' },
      }),
    ).resolves.toBe(receipt);
    expect(mockRunPort).toHaveBeenCalledWith(action, caller, {
      composition: { inputMode: 'typed' },
    });
  });

  it('maps a typed refusal to run history text', async () => {
    mockRunPort.mockRejectedValue(
      new AgentChatSendError('not_found', 'The target chat is not available.'),
    );
    await expect(
      dispatchAutomationAction(action, caller, {
        actionType: 'worktree_session_prompt',
      }),
    ).rejects.toThrow(AUTOMATION_OWNER_MISMATCH_MESSAGE);
  });

  it('reports retryable storage unavailability from the real send with an unreadable store', async () => {
    const { __setDesktopW5FileStoreForTests } =
      await import('../../lib/w5-commit-log-file-store');
    __setDesktopW5FileStoreForTests({
      read: () => Promise.resolve({ state: 'unreadable' }),
      replace: () => Promise.reject(new Error('Read must not write')),
      remove: () => Promise.reject(new Error('Read must not write')),
    });
    const { createDesktopRuntime } =
      await import('../../canopy-runtime/desktop-runtime');
    const sidebar = await import('../../lib/sidebar-items');
    const persistence = await import('../../lib/workspace-persistence');
    const { readEffectiveWorkspaceConfig } =
      await import('../../lib/workspace-source');
    const runtime = createDesktopRuntime({
      workspaceServices: {
        readAllSidebarItems: sidebar.readAllSidebarItems,
        readAllSidebarItemsSnapshot: sidebar.readAllSidebarItemsSnapshot,
        readWorkspaceIndexEntry: sidebar.readWorkspaceIndexEntry,
        readWorkspaceIndexEntryDetailed:
          sidebar.readWorkspaceIndexEntryDetailed,
        readWorkspaceConfig: persistence.readWorkspaceConfig,
        readWorkspaceWorktrees: persistence.readWorkspaceWorktrees,
        readEffectiveWorkspaceConfig,
      },
    });
    const actual = jest.requireActual<typeof ProjectBotPortModule>(
      '../../agent-actions/desktop-project-bot-port',
    );
    mockRunPort.mockImplementation(actual.runPipelineProjectBotAction);
    try {
      const storageMessage: unknown =
        expect.stringMatching(/storage.*unavailable/i);
      await expect(
        dispatchAutomationAction(action, caller, {
          actionType: 'worktree_session_prompt',
        }),
      ).rejects.toMatchObject({
        message: storageMessage,
        payload: { kind: 'unavailable', retry: { kind: 'same_request' } },
      });
    } finally {
      await runtime.shutdown();
      __setDesktopW5FileStoreForTests(undefined);
    }
  });

  it('rethrows anything else unchanged', async () => {
    const failure = new Error('disk full');
    mockRunPort.mockRejectedValue(failure);
    await expect(
      dispatchAutomationAction(action, caller, {
        actionType: 'worktree_session_prompt',
      }),
    ).rejects.toBe(failure);
  });
});
