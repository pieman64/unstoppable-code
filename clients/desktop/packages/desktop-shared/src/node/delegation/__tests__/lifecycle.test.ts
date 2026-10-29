import type { AgentDelegationEvent } from '@canopy/protocol/delegation';
import { createDelegationRunState, reduceDelegationEvent } from '../lifecycle';

describe('managed child event ownership', () => {
  const initial = createDelegationRunState('child-1', 3);
  function event(
    sequence: number,
    payload: AgentDelegationEvent['event'],
    overrides: Partial<AgentDelegationEvent> = {},
  ): AgentDelegationEvent {
    return {
      delegationId: 'child-1',
      runGeneration: 3,
      sequence,
      occurredAt: sequence,
      event: payload,
      ...overrides,
    };
  }

  it('ignores foreign, stale-generation, and duplicate events', () => {
    const started = event(1, {
      type: 'started',
      nativeSessionId: 'native-child',
    });
    expect(
      reduceDelegationEvent(initial, {
        ...started,
        delegationId: 'other-child',
      }),
    ).toBe(initial);
    expect(
      reduceDelegationEvent(initial, { ...started, runGeneration: 2 }),
    ).toBe(initial);
    const running = reduceDelegationEvent(initial, started);
    expect(running).toMatchObject({
      status: 'running',
      nativeSessionId: 'native-child',
      sequence: 1,
    });
    expect(reduceDelegationEvent(running, started)).toBe(running);
  });

  it('moves a running child to a new native session without restarting it', () => {
    const running = reduceDelegationEvent(
      initial,
      event(1, { type: 'started', nativeSessionId: 'native-first' }),
    );
    const progressed = reduceDelegationEvent(
      running,
      event(2, { type: 'progress', text: 'halfway' }),
    );
    const rebound = reduceDelegationEvent(
      progressed,
      event(3, { type: 'started', nativeSessionId: 'native-reloaded' }),
    );
    expect(rebound).toEqual({
      ...progressed,
      sequence: 3,
      nativeSessionId: 'native-reloaded',
    });
    expect(rebound.startedAt).toBe(running.startedAt);
    expect(
      reduceDelegationEvent(
        rebound,
        event(4, { type: 'started', nativeSessionId: 'native-reloaded' }),
      ),
    ).toBe(rebound);
    expect(reduceDelegationEvent(rebound, event(5, { type: 'started' }))).toBe(
      rebound,
    );
  });

  it('retains a runner truncation marker when the text itself is below the byte bound', () => {
    const running = reduceDelegationEvent(
      initial,
      event(1, { type: 'started' }),
    );
    const partial = reduceDelegationEvent(
      running,
      event(2, { type: 'progress', text: 'First findings', truncated: true }),
    );
    expect(partial).toMatchObject({
      partialText: 'First findings',
      outputTruncated: true,
    });
    expect(
      reduceDelegationEvent(
        partial,
        event(3, { type: 'terminal', status: 'failed' }),
      ).outputTruncated,
    ).toBe(true);
  });

  it('settles once and retains the first terminal result', () => {
    const running = reduceDelegationEvent(
      initial,
      event(1, { type: 'started' }),
    );
    const completed = reduceDelegationEvent(
      running,
      event(2, {
        type: 'terminal',
        status: 'completed',
        finalText: 'Retained result',
        usage: { inputTokens: 5, outputTokens: 7 },
      }),
    );
    expect(
      reduceDelegationEvent(
        completed,
        event(3, {
          type: 'terminal',
          status: 'failed',
          error: {
            code: 'runtime_error',
            message: 'late error',
            retryable: false,
          },
        }),
      ),
    ).toBe(completed);
    expect(
      reduceDelegationEvent(
        completed,
        event(4, { type: 'progress', text: 'late text' }),
      ),
    ).toBe(completed);
    expect(completed).toMatchObject({
      status: 'completed',
      finalText: 'Retained result',
      usage: { inputTokens: 5, outputTokens: 7 },
    });
  });

  it('can cancel before native allocation and retains partial work on deadline', () => {
    const cancelled = reduceDelegationEvent(
      initial,
      event(1, { type: 'terminal', status: 'cancelled' }),
    );
    expect(cancelled.status).toBe('cancelled');
    const running = reduceDelegationEvent(
      initial,
      event(1, { type: 'started' }),
    );
    const progress = reduceDelegationEvent(
      running,
      event(2, { type: 'progress', text: 'Partial findings' }),
    );
    expect(
      reduceDelegationEvent(
        progress,
        event(3, { type: 'terminal', status: 'deadline_exceeded' }),
      ),
    ).toMatchObject({
      status: 'deadline_exceeded',
      partialText: 'Partial findings',
    });
  });

  it('replaces cumulative usage instead of double-counting notifications', () => {
    const running = reduceDelegationEvent(
      initial,
      event(1, { type: 'started' }),
    );
    const first = reduceDelegationEvent(
      running,
      event(2, { type: 'usage', usage: { inputTokens: 10, outputTokens: 2 } }),
    );
    const repeat = reduceDelegationEvent(
      first,
      event(3, { type: 'usage', usage: { inputTokens: 10, outputTokens: 2 } }),
    );
    expect(repeat.usage).toEqual(first.usage);
  });

  it('ignores invalid sequence numbers and replaces a native identity only in order while running', () => {
    for (const sequence of [0, -1, 0.5, Infinity]) {
      expect(
        reduceDelegationEvent(initial, event(sequence, { type: 'started' })),
      ).toBe(initial);
    }
    const running = reduceDelegationEvent(
      initial,
      event(2, { type: 'started', nativeSessionId: 'original' }),
    );
    // A stale or duplicate sequence cannot replace the identity.
    expect(
      reduceDelegationEvent(
        running,
        event(2, { type: 'started', nativeSessionId: 'replacement' }),
      ),
    ).toBe(running);
    const completed = reduceDelegationEvent(
      running,
      event(3, { type: 'terminal', status: 'completed' }),
    );
    // A settled run keeps the identity it finished with.
    expect(
      reduceDelegationEvent(
        completed,
        event(4, { type: 'started', nativeSessionId: 'replacement' }),
      ),
    ).toBe(completed);
  });

  it('retains complete results and keeps only allowlisted usage fields', () => {
    const usage = { inputTokens: 3, authAccountKey: 'private-account' };
    const completed = reduceDelegationEvent(
      initial,
      event(1, {
        type: 'terminal',
        status: 'completed',
        finalText: 'x'.repeat(16_385),
        usage,
      }),
    );
    expect(completed.outputTruncated).toBe(false);
    expect(completed.finalText).toHaveLength(16_385);
    expect(completed.usage).toEqual({ inputTokens: 3 });
  });
});
