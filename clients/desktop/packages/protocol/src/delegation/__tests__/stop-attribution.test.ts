import {
  DELEGATION_NOT_DESCENDANT_ERROR,
  DELEGATION_STOP_REASONS,
  isAgentDelegationTranscript,
  isDelegationStopReason,
  isDelegationStoppedBy,
} from '..';

function transcriptWith(snapshot: Record<string, unknown>): unknown {
  return {
    delegationId: 'child-a',
    runGeneration: 1,
    sequence: 1,
    parentHarnessId: 'claude',
    parentTurnId: 'turn-a',
    parentToolCallId: 'call-a',
    createdAt: 1,
    task: {
      description: 'Review',
      prompt: 'Inspect the change.',
      executionMode: 'background',
    },
    snapshot: {
      delegationId: 'child-a',
      status: 'cancelled',
      requestedModelId: 'review-model',
      outputTruncated: false,
      ...snapshot,
    },
    transcript: [],
  };
}

describe('delegation stop attribution contract', () => {
  it('knows every stop reason, including parent and ancestor stops', () => {
    expect(DELEGATION_STOP_REASONS).toEqual(
      expect.arrayContaining(['stopped_by_parent', 'ancestor_stopped']),
    );
    expect(isDelegationStopReason('ancestor_stopped')).toBe(true);
    expect(isDelegationStopReason('crashed')).toBe(false);
    expect(isDelegationStopReason(undefined)).toBe(false);
  });

  it('defines one denial for a delegation outside the caller’s subtree', () => {
    expect(DELEGATION_NOT_DESCENDANT_ERROR).toEqual({
      code: 'parent_unavailable',
      message: 'That delegation is not one of your descendants.',
      retryable: false,
    });
    expect(Object.isFrozen(DELEGATION_NOT_DESCENDANT_ERROR)).toBe(true);
  });

  it('accepts user and agent attribution and rejects anything else', () => {
    expect(isDelegationStoppedBy({ kind: 'user' })).toBe(true);
    expect(isDelegationStoppedBy({ kind: 'agent', depth: 0 })).toBe(true);
    expect(
      isDelegationStoppedBy({
        kind: 'agent',
        depth: 2,
        delegationId: 'parent-b',
        description: 'Audit the parser',
      }),
    ).toBe(true);
    for (const value of [
      { kind: 'user', depth: 0 },
      { kind: 'agent' },
      { kind: 'agent', depth: -1 },
      { kind: 'agent', depth: 10 },
      { kind: 'agent', depth: 1, delegationId: '' },
      { kind: 'agent', depth: 1, description: 'x'.repeat(201) },
      { kind: 'agent', depth: 1, message: 'Stopped.' },
      { kind: 'system' },
      'user',
    ])
      expect([value, isDelegationStoppedBy(value)]).toEqual([value, false]);
  });

  it('validates retained attribution and child IDs without breaking older snapshots', () => {
    expect(isAgentDelegationTranscript(transcriptWith({}))).toBe(true);
    expect(
      isAgentDelegationTranscript(
        transcriptWith({
          stopReason: 'ancestor_stopped',
          cancelledByUser: false,
          stoppedBy: { kind: 'user' },
          error: {
            code: 'terminated_by_parent',
            message: "Stopped because you stopped 'Plan'.",
            retryable: false,
          },
          childDelegationIds: ['child-b', 'child-c'],
        }),
      ),
    ).toBe(true);
    expect(
      isAgentDelegationTranscript(
        transcriptWith({ stoppedBy: { kind: 'robot' } }),
      ),
    ).toBe(false);
    expect(
      isAgentDelegationTranscript(
        transcriptWith({
          childDelegationIds: Array.from({ length: 65 }, (_, i) => `c-${i}`),
        }),
      ),
    ).toBe(false);
  });
});
