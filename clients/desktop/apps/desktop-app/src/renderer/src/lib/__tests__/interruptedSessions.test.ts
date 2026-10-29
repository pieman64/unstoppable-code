import type { UsageLimitedSessionGroup } from '@canopy/desktop-shared/types';
import {
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
      signature: '',
    });
  });
});

describe('shouldShowInterruptedSessionsBanner', () => {
  const summary = summarizeInterruptedSessions(groups);

  it('hides when nothing is interrupted', () => {
    expect(
      shouldShowInterruptedSessionsBanner({ count: 0, signature: '' }, null),
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
