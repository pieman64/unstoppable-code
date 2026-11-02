import type {
  AgentUsageOverview,
  ScheduledActivity,
  UsageLimitedSessionGroup,
} from '@canopy/desktop-shared/types';
import {
  excludeScheduledResumeSessions,
  shouldShowInterruptedSessionsBanner,
  summarizeInterruptedSessions,
} from '../interruptedSessions';

const groups: UsageLimitedSessionGroup[] = [
  {
    groupId: 'ws-b',
    groupKind: 'workspace',
    workspaceId: 'ws-b',
    workspaceName: 'Workspace B',
    sessions: [
      {
        kind: 'pipeline',
        executionId: 'exec-1',
        statusReasonIds: ['r1'],
        pipelineName: 'Release',
        detectedAt: 3,
        pausedStepCount: 1,
        modelLabels: [],
        otherBlockingReasonCount: 0,
      },
    ],
  },
  {
    groupId: 'ws-a',
    groupKind: 'workspace',
    workspaceId: 'ws-a',
    workspaceName: 'Workspace A',
    sessions: [
      {
        kind: 'chat',
        projectId: 'ws-a',
        worktreeId: 'wt',
        chatId: 'c2',
        provider: 'codex',
        chatTitle: 'Two',
        detectedAt: 2,
        worktreeName: 'main',
        resumeReason: 'app_shutdown',
      },
      {
        kind: 'chat',
        projectId: 'ws-a',
        worktreeId: 'wt',
        chatId: 'c1',
        provider: 'claude',
        chatTitle: 'One',
        detectedAt: 1,
        worktreeName: 'main',
        resumeReason: 'usage_limit',
      },
    ],
  },
];

describe('summarizeInterruptedSessions', () => {
  it('counts every session across providers and reasons', () => {
    expect(summarizeInterruptedSessions(groups).count).toBe(3);
  });

  it('builds an order-independent signature from the session identities', () => {
    const forward = summarizeInterruptedSessions(groups).signature;
    const reversed = summarizeInterruptedSessions(
      [...groups].reverse().map((group) => ({
        ...group,
        sessions: [...group.sessions].reverse(),
      })),
    ).signature;
    expect(forward).toBe(reversed);
    expect(forward).toContain('chat:ws-a/wt/c1');
    expect(forward).toContain('pipeline:exec-1');
  });

  it('changes the signature when the set of sessions changes', () => {
    const full = summarizeInterruptedSessions(groups).signature;
    const partial = summarizeInterruptedSessions([
      { ...groups[1], sessions: [groups[1].sessions[0]] },
    ]).signature;
    expect(partial).not.toBe(full);
  });

  it('returns an empty summary for no groups', () => {
    expect(summarizeInterruptedSessions([])).toEqual({
      count: 0,
      readiness: {
        total: 0,
        readyCount: 0,
        waitingCount: 0,
        chatCount: 0,
        pipelineCount: 0,
        readyChatCount: 0,
        readyPipelineCount: 0,
        waitingProviders: [],
      },
      signature: '',
      sessions: [],
    });
  });

  it('keeps the display and destination details of each session in key order', () => {
    const forward = summarizeInterruptedSessions(groups).sessions;
    const reversed = summarizeInterruptedSessions(
      [...groups].reverse().map((group) => ({
        ...group,
        sessions: [...group.sessions].reverse(),
      })),
    ).sessions;
    expect(reversed).toEqual(forward);
    expect(forward).toEqual([
      {
        key: 'chat:ws-a/wt/c1',
        kind: 'chat',
        title: 'One',
        workspaceId: 'ws-a',
        workspaceName: 'Workspace A',
        target: { projectId: 'ws-a', worktreeId: 'wt', chatId: 'c1' },
        worktreeName: 'main',
        readiness: { state: 'ready' },
      },
      {
        key: 'chat:ws-a/wt/c2',
        kind: 'chat',
        title: 'Two',
        workspaceId: 'ws-a',
        workspaceName: 'Workspace A',
        target: { projectId: 'ws-a', worktreeId: 'wt', chatId: 'c2' },
        worktreeName: 'main',
        readiness: { state: 'ready' },
      },
      {
        key: 'pipeline:exec-1/["r1"]',
        kind: 'pipeline',
        title: 'Release',
        workspaceId: 'ws-b',
        workspaceName: 'Workspace B',
        executionId: 'exec-1',
        readiness: { state: 'ready' },
      },
    ]);
  });

  it('updates display details without changing the dismissal signature', () => {
    const before = summarizeInterruptedSessions(groups);
    const renamed = summarizeInterruptedSessions([
      groups[0],
      {
        ...groups[1],
        workspaceName: 'Renamed workspace',
        sessions: groups[1].sessions.map((session) =>
          session.kind === 'chat'
            ? { ...session, chatTitle: `${session.chatTitle} renamed` }
            : session,
        ),
      },
    ]);
    expect(renamed.signature).toBe(before.signature);
    expect(renamed.sessions.map((session) => session.title)).toEqual([
      'One renamed',
      'Two renamed',
      'Release',
    ]);
    expect(renamed.sessions[0]?.workspaceName).toBe('Renamed workspace');
  });

  describe('with a usage snapshot', () => {
    const NOW = Date.parse('2026-10-25T12:00:00.000Z');
    const RESET = '2026-10-27T18:13:00.000Z';
    const blockedCodex = (resetsAt?: string): AgentUsageOverview => ({
      updatedAt: '2026-10-25T12:00:00.000Z',
      providers: [
        {
          provider: 'codex',
          authState: 'authenticated',
          hasRemainingLimits: false,
          rateLimits: [
            {
              limitId: 'codex',
              secondary: {
                usedPercent: 100,
                windowDurationMins: 7 * 24 * 60,
                ...(resetsAt ? { resetsAt } : {}),
              },
            },
          ],
        },
      ],
    });
    const mixed: UsageLimitedSessionGroup[] = [
      {
        groupId: 'ws',
        groupKind: 'workspace',
        workspaceId: 'ws',
        workspaceName: 'Workspace',
        sessions: [
          chatSession('claude-1', 'claude'),
          chatSession('claude-2', 'claude'),
          chatSession('codex-1', 'codex'),
        ],
      },
    ];

    it('counts waiting sessions apart from ready ones', () => {
      const summary = summarizeInterruptedSessions(
        mixed,
        blockedCodex(RESET),
        NOW,
      );
      expect(summary.count).toBe(3);
      expect(summary.readiness).toEqual({
        total: 3,
        readyCount: 2,
        waitingCount: 1,
        chatCount: 3,
        pipelineCount: 0,
        readyChatCount: 2,
        readyPipelineCount: 0,
        waitingProviders: ['codex'],
        sharedWaitingResetMs: Date.parse(RESET),
      });
    });

    it('treats a missing snapshot as ready, like the Usage card', () => {
      const summary = summarizeInterruptedSessions(mixed, undefined, NOW);
      expect(summary.readiness.readyCount).toBe(3);
      expect(summary.readiness.waitingCount).toBe(0);
    });

    it('changes the signature when readiness changes, not when time passes', () => {
      const waiting = summarizeInterruptedSessions(
        mixed,
        blockedCodex(RESET),
        NOW,
      );
      const laterWaiting = summarizeInterruptedSessions(
        mixed,
        blockedCodex(RESET),
        NOW + 60_000,
      );
      const cleared = summarizeInterruptedSessions(
        mixed,
        blockedCodex(RESET),
        Date.parse(RESET),
      );
      expect(laterWaiting.signature).toBe(waiting.signature);
      expect(cleared.signature).not.toBe(waiting.signature);
      // An all-ready set keeps the original key-only signature.
      expect(cleared.signature).toBe(
        summarizeInterruptedSessions(mixed).signature,
      );
    });
  });
});

function chatSession(
  chatId: string,
  provider: 'claude' | 'codex',
): UsageLimitedSessionGroup['sessions'][number] {
  return {
    kind: 'chat',
    projectId: 'ws',
    worktreeId: 'wt',
    chatId,
    provider,
    chatTitle: chatId,
    detectedAt: 1,
    resumeReason: 'usage_limit',
    worktreeName: 'main',
  };
}

describe('shouldShowInterruptedSessionsBanner', () => {
  const summary = summarizeInterruptedSessions(groups);

  it('hides when nothing is interrupted', () => {
    expect(
      shouldShowInterruptedSessionsBanner(
        summarizeInterruptedSessions([]),
        null,
      ),
    ).toBe(false);
  });

  it('shows when sessions exist and nothing was dismissed', () => {
    expect(shouldShowInterruptedSessionsBanner(summary, null)).toBe(true);
  });

  it('stays hidden while the dismissed set is unchanged', () => {
    expect(
      shouldShowInterruptedSessionsBanner(summary, summary.signature),
    ).toBe(false);
  });

  it('returns once the interrupted set changes after a dismissal', () => {
    const changed = summarizeInterruptedSessions([groups[1]]);
    expect(
      shouldShowInterruptedSessionsBanner(changed, summary.signature),
    ).toBe(true);
  });
});

describe('excludeScheduledResumeSessions', () => {
  const NOW = Date.parse('2026-10-25T12:00:00.000Z');
  const FUTURE = '2026-10-25T13:00:00.000Z';

  function automation(
    id: string,
    target: { workspaceId: string; worktreeId: string; chatId: string },
    options: {
      purpose?: 'usage_limit_resume' | 'scheduled_send';
      nextRunAt?: string;
    } = {},
  ): ScheduledActivity {
    return {
      version: 1,
      id,
      name: id,
      enabled: true,
      schedule: { kind: 'one_time', runAt: FUTURE, timezone: 'local' },
      action: {
        type: 'worktree_session_prompt',
        ...target,
        prompt: 'continue',
        purpose: options.purpose ?? 'usage_limit_resume',
      },
      createdAt: FUTURE,
      updatedAt: FUTURE,
      nextRunAt: options.nextRunAt ?? FUTURE,
      failureCount: 0,
    };
  }

  const c1 = { workspaceId: 'ws-a', worktreeId: 'wt', chatId: 'c1' };
  const c2 = { workspaceId: 'ws-a', worktreeId: 'wt', chatId: 'c2' };

  it('drops a chat with a pending usage-limit resume and changes the summary', () => {
    const before = summarizeInterruptedSessions(groups);
    const filtered = excludeScheduledResumeSessions(
      groups,
      [automation('a1', c1)],
      NOW,
    );
    const after = summarizeInterruptedSessions(filtered);
    expect(after.count).toBe(2);
    expect(after.signature).not.toBe(before.signature);
    expect(after.signature).not.toContain('chat:ws-a/wt/c1');
    expect(after.signature).toContain('chat:ws-a/wt/c2');
  });

  it('keeps pipelines, preserves order, and removes emptied groups', () => {
    const filtered = excludeScheduledResumeSessions(
      groups,
      [automation('a1', c1), automation('a2', c2)],
      NOW,
    );
    expect(filtered.map((group) => group.groupId)).toEqual(['ws-b']);
    expect(filtered[0].sessions[0].kind).toBe('pipeline');
  });

  it('matches the exact workspace, worktree, and chat', () => {
    const near = [
      automation('ws', { ...c1, workspaceId: 'ws-b' }),
      automation('wt', { ...c1, worktreeId: 'other' }),
      automation('chat', { ...c1, chatId: 'other' }),
    ];
    expect(
      summarizeInterruptedSessions(
        excludeScheduledResumeSessions(groups, near, NOW),
      ).count,
    ).toBe(3);
  });

  it('keeps chats with only ordinary scheduled sends or passed resumes', () => {
    const activities = [
      automation('send', c1, { purpose: 'scheduled_send' }),
      automation('past', c2, { nextRunAt: '2026-10-25T11:00:00.000Z' }),
    ];
    expect(
      summarizeInterruptedSessions(
        excludeScheduledResumeSessions(groups, activities, NOW),
      ).count,
    ).toBe(3);
  });

  it('stays excluded until the last duplicate resume is removed', () => {
    const first = automation('first', c1);
    const second = automation('second', c1);
    const count = (activities: ScheduledActivity[]): number =>
      summarizeInterruptedSessions(
        excludeScheduledResumeSessions(groups, activities, NOW),
      ).count;
    expect(count([first, second])).toBe(2);
    expect(count([second])).toBe(2);
    expect(count([])).toBe(3);
  });

  it('does not mutate its input', () => {
    const snapshot = JSON.stringify(groups);
    excludeScheduledResumeSessions(groups, [automation('a1', c1)], NOW);
    expect(JSON.stringify(groups)).toBe(snapshot);
  });

  it('keeps only the retained scheduled chats in place', () => {
    const snapshot = JSON.stringify(groups);
    const filtered = excludeScheduledResumeSessions(
      groups,
      [automation('a1', c1), automation('a2', c2)],
      NOW,
      new Set(['chat:ws-a/wt/c1']),
    );
    expect(
      filtered.map((group) =>
        group.sessions.map((session) =>
          session.kind === 'chat' ? session.chatId : session.executionId,
        ),
      ),
    ).toEqual([['exec-1'], ['c1']]);
    expect(JSON.stringify(groups)).toBe(snapshot);
  });

  it('keeps a group whose only remaining chat is retained', () => {
    const chatsOnly = groups.slice(1);
    const filtered = excludeScheduledResumeSessions(
      chatsOnly,
      [automation('a1', c1), automation('a2', c2)],
      NOW,
      new Set(['chat:ws-a/wt/c2']),
    );
    expect(filtered.map((group) => group.groupId)).toEqual(['ws-a']);
    expect(
      excludeScheduledResumeSessions(
        chatsOnly,
        [automation('a1', c1), automation('a2', c2)],
        NOW,
        new Set(),
      ),
    ).toEqual([]);
  });
});
