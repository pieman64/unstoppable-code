import {
  resolvePlanDisplayStatus,
  type PlanExecutionEvidence,
} from '../planDisplayStatus';

function run(
  id: string,
  outcome: PlanExecutionEvidence['outcome'],
  startedAt: string | undefined,
  overrides: Partial<PlanExecutionEvidence> = {},
): PlanExecutionEvidence {
  return {
    kind: 'pipeline',
    id,
    outcome,
    ...(startedAt ? { startedAt } : {}),
    ...overrides,
  };
}

const T1 = '2026-10-01T10:00:00.000Z';
const T2 = '2026-10-01T11:00:00.000Z';
const T3 = '2026-10-01T12:00:00.000Z';

describe('resolvePlanDisplayStatus', () => {
  it('keeps Pending primary regardless of execution history', () => {
    expect(
      resolvePlanDisplayStatus({
        reviewStatus: 'pending',
        evidence: [run('a', 'succeeded', T1), run('b', 'active', T2)],
      }),
    ).toEqual({
      kind: 'pending',
      label: 'Pending',
      executeEmphasis: 'primary',
      primaryAction: 'execute',
    });
  });

  it('keeps Dismissed regardless of execution history, with secondary Execute', () => {
    expect(
      resolvePlanDisplayStatus({
        reviewStatus: 'dismissed',
        evidence: [run('a', 'active', T1)],
      }),
    ).toEqual({
      kind: 'dismissed',
      label: 'Dismissed',
      executeEmphasis: 'secondary',
      primaryAction: 'execute',
    });
  });

  it('shows Approved with secondary Execute when there is no evidence', () => {
    expect(resolvePlanDisplayStatus({ reviewStatus: 'approved' })).toEqual({
      kind: 'approved',
      label: 'Approved',
      executeEmphasis: 'secondary',
      primaryAction: 'execute',
    });
  });

  it('shows Implementing for an active (queued, running, or paused) attempt', () => {
    const status = resolvePlanDisplayStatus({
      reviewStatus: 'approved',
      evidence: [run('a', 'active', T1)],
    });
    expect(status).toMatchObject({
      kind: 'implementing',
      label: 'Implementing in workflow',
      selected: { id: 'a' },
      executeEmphasis: 'secondary',
      primaryAction: 'open',
    });
  });

  it('shows Implemented only for an explicit successful outcome', () => {
    expect(
      resolvePlanDisplayStatus({
        reviewStatus: 'approved',
        evidence: [run('a', 'succeeded', T1)],
      }),
    ).toMatchObject({ kind: 'implemented', selected: { id: 'a' } });
  });

  it('keeps Approved and reports the outcome when every attempt failed or was cancelled', () => {
    const status = resolvePlanDisplayStatus({
      reviewStatus: 'approved',
      evidence: [run('a', 'failed', T1), run('b', 'cancelled', T2)],
    });
    expect(status.kind).toBe('approved');
    expect(status.selected).toBeUndefined();
    expect(status.latestUnsuccessful).toMatchObject({
      id: 'b',
      outcome: 'cancelled',
    });
  });

  it('prefers an active attempt over an earlier or later success', () => {
    expect(
      resolvePlanDisplayStatus({
        reviewStatus: 'approved',
        evidence: [run('done', 'succeeded', T3), run('live', 'active', T1)],
      }),
    ).toMatchObject({ kind: 'implementing', selected: { id: 'live' } });
  });

  it('keeps Implemented after a later failed retry and reports that failure', () => {
    const status = resolvePlanDisplayStatus({
      reviewStatus: 'approved',
      evidence: [run('ok', 'succeeded', T1), run('retry', 'failed', T2)],
    });
    expect(status).toMatchObject({
      kind: 'implemented',
      selected: { id: 'ok' },
      latestUnsuccessful: { id: 'retry', outcome: 'failed' },
    });
  });

  it('keeps the latest failed outcome visible while another current attempt is active', () => {
    expect(
      resolvePlanDisplayStatus({
        reviewStatus: 'approved',
        evidence: [
          run('success', 'succeeded', T1),
          run('active', 'active', T2),
          run('retry', 'failed', T3),
        ],
      }),
    ).toMatchObject({
      kind: 'implementing',
      selected: { id: 'active' },
      latestUnsuccessful: { id: 'retry', outcome: 'failed' },
    });
    expect(
      resolvePlanDisplayStatus({
        reviewStatus: 'approved',
        evidence: [run('old', 'failed', T1), run('active', 'active', T2)],
      }).latestUnsuccessful,
    ).toBeUndefined();
  });

  it('does not let an older failure obscure a newer success', () => {
    const status = resolvePlanDisplayStatus({
      reviewStatus: 'approved',
      evidence: [run('old', 'failed', T1), run('new', 'succeeded', T2)],
    });
    expect(status).toMatchObject({
      kind: 'implemented',
      selected: { id: 'new' },
    });
    expect(status.latestUnsuccessful).toBeUndefined();
  });

  it('never manufactures a status from attempts it cannot place in time', () => {
    expect(
      resolvePlanDisplayStatus({
        reviewStatus: 'approved',
        evidence: [
          run('no-time', 'succeeded', undefined),
          run('bad-time', 'active', 'not a date'),
        ],
      }).kind,
    ).toBe('approved');
  });

  it('ignores attempts for another revision, by number or by start time', () => {
    const status = resolvePlanDisplayStatus({
      reviewStatus: 'approved',
      currentRevisionNumber: 2,
      currentRevisionCreatedAt: T2,
      evidence: [
        run('old-revision', 'succeeded', T3, { revisionNumber: 1 }),
        run('before-revision', 'active', T1),
      ],
    });
    expect(status.kind).toBe('approved');
    expect(status.latestUnsuccessful).toBeUndefined();
  });

  it('selects the newest of several successes, breaking time ties by id', () => {
    expect(
      resolvePlanDisplayStatus({
        reviewStatus: 'approved',
        evidence: [
          run('b', 'succeeded', T2),
          run('a', 'succeeded', T1),
          run('c', 'succeeded', T2),
        ],
      }).selected?.id,
    ).toBe('c');
    expect(
      resolvePlanDisplayStatus({
        reviewStatus: 'approved',
        evidence: [run('c', 'succeeded', T2), run('b', 'succeeded', T2)],
      }).selected?.id,
    ).toBe('c');
  });

  it('counts a duplicate execution id once, using its latest report', () => {
    const status = resolvePlanDisplayStatus({
      reviewStatus: 'approved',
      evidence: [run('a', 'active', T1), run('a', 'failed', T2)],
    });
    expect(status.kind).toBe('approved');
    expect(status.latestUnsuccessful).toMatchObject({
      id: 'a',
      outcome: 'failed',
    });
  });

  it('labels an unknown stored status in sentence case without upgrading it', () => {
    expect(
      resolvePlanDisplayStatus({
        reviewStatus: 'ARCHIVED',
        evidence: [run('a', 'succeeded', T1)],
      }),
    ).toEqual({
      kind: 'unknown',
      label: 'Archived',
      executeEmphasis: 'primary',
      primaryAction: 'execute',
    });
    expect(resolvePlanDisplayStatus({ reviewStatus: undefined }).label).toBe(
      '',
    );
  });

  it('requires revision linkage when the current revision date is unavailable', () => {
    expect(
      resolvePlanDisplayStatus({
        reviewStatus: 'approved',
        currentRevisionNumber: 2,
        evidence: [run('old', 'succeeded', T1)],
      }).kind,
    ).toBe('approved');
    expect(
      resolvePlanDisplayStatus({
        reviewStatus: 'approved',
        currentRevisionNumber: 2,
        evidence: [run('current', 'succeeded', T1, { revisionNumber: 2 })],
      }).kind,
    ).toBe('implemented');
  });

  it('names the chat venue and offers Open while a linked chat turn runs and after it finishes', () => {
    const chat = (
      id: string,
      outcome: PlanExecutionEvidence['outcome'],
      startedAt: string,
    ): PlanExecutionEvidence => ({ kind: 'chat', id, outcome, startedAt });
    expect(
      resolvePlanDisplayStatus({
        reviewStatus: 'approved',
        evidence: [chat('chat-1:m1', 'active', T1)],
      }),
    ).toMatchObject({
      kind: 'implementing',
      label: 'Implementing in chat',
      primaryAction: 'open',
      selected: { kind: 'chat', id: 'chat-1:m1' },
    });
    expect(
      resolvePlanDisplayStatus({
        reviewStatus: 'approved',
        evidence: [chat('chat-1:m1', 'succeeded', T1)],
      }),
    ).toMatchObject({
      kind: 'implemented',
      label: 'Finished in chat',
      primaryAction: 'open',
    });
    expect(
      resolvePlanDisplayStatus({
        reviewStatus: 'approved',
        evidence: [run('run', 'succeeded', T1)],
      }),
    ).toMatchObject({
      label: 'Implemented in workflow',
      primaryAction: 'open',
    });
    for (const outcome of ['failed', 'cancelled'] as const) {
      expect(
        resolvePlanDisplayStatus({
          reviewStatus: 'approved',
          evidence: [chat('chat-1:m1', outcome, T1)],
        }),
      ).toMatchObject({
        kind: 'approved',
        label: 'Approved',
        primaryAction: 'execute',
        latestUnsuccessful: { kind: 'chat', outcome },
      });
    }
  });

  it('prefers an active attempt across venues and keeps a retained success after a later failed chat retry', () => {
    expect(
      resolvePlanDisplayStatus({
        reviewStatus: 'approved',
        evidence: [
          run('run', 'succeeded', T3),
          { kind: 'chat', id: 'chat-1:m1', outcome: 'active', startedAt: T1 },
        ],
      }),
    ).toMatchObject({
      label: 'Implementing in chat',
      selected: { kind: 'chat', id: 'chat-1:m1' },
    });
    expect(
      resolvePlanDisplayStatus({
        reviewStatus: 'approved',
        evidence: [
          {
            kind: 'chat',
            id: 'chat-1:m1',
            outcome: 'succeeded',
            startedAt: T1,
          },
          { kind: 'chat', id: 'chat-2:m2', outcome: 'failed', startedAt: T2 },
        ],
      }),
    ).toMatchObject({
      label: 'Finished in chat',
      selected: { id: 'chat-1:m1' },
      latestUnsuccessful: { id: 'chat-2:m2', outcome: 'failed' },
    });
  });

  it('breaks equal start times across venues deterministically', () => {
    const evidence: PlanExecutionEvidence[] = [
      { kind: 'chat', id: 'a', outcome: 'succeeded', startedAt: T1 },
      run('a', 'succeeded', T1),
    ];
    for (const ordered of [evidence, [...evidence].reverse()]) {
      expect(
        resolvePlanDisplayStatus({
          reviewStatus: 'approved',
          evidence: ordered,
        }).selected?.kind,
      ).toBe('pipeline');
    }
  });

  it('resolves duplicate reports with equal start times independently of collection order', () => {
    const reports = [run('same', 'active', T1), run('same', 'failed', T1)];
    for (const evidence of [reports, [...reports].reverse()]) {
      expect(
        resolvePlanDisplayStatus({ reviewStatus: 'approved', evidence }),
      ).toMatchObject({
        kind: 'approved',
        latestUnsuccessful: { id: 'same', outcome: 'failed' },
      });
    }
  });
});
