import { queuedMessageForceKind } from '../queued-message-force';

describe('queuedMessageForceKind', () => {
  it.each([undefined, 'idle', 'background', 'foreground'] as const)(
    'uses Retry for a credit-blocked row in phase %s, including background holds',
    (turnPhase) => {
      for (const retryable of [undefined, false, true]) {
        for (const waitingReason of [
          undefined,
          'background_work',
          'steer_unavailable',
        ] as const) {
          const row = {
            turnPhase,
            retryable,
            waitingReason,
            retryBlockedReason: 'insufficient_credits' as const,
          };
          expect(queuedMessageForceKind(row)).toBe('retry');
        }
      }
    },
  );

  it('interrupts only while a foreground turn runs, or for a host that reports no phase', () => {
    expect(queuedMessageForceKind({ turnPhase: 'foreground' })).toBe(
      'interrupt',
    );
    expect(queuedMessageForceKind({})).toBe('interrupt');
  });

  it('retries a row still queued while no foreground turn runs', () => {
    expect(queuedMessageForceKind({ turnPhase: 'idle' })).toBe('retry');
    expect(queuedMessageForceKind({ turnPhase: 'background' })).toBe('retry');
  });

  it('retries a failed or uncertain delivery in any phase', () => {
    expect(
      queuedMessageForceKind({ turnPhase: 'foreground', retryable: true }),
    ).toBe('retry');
    expect(queuedMessageForceKind({ retryable: true })).toBe('retry');
  });

  it('runs a row held for background work now, in any phase', () => {
    expect(
      queuedMessageForceKind({
        turnPhase: 'foreground',
        waitingReason: 'background_work',
      }),
    ).toBe('run-now');
    expect(
      queuedMessageForceKind({
        turnPhase: 'background',
        waitingReason: 'background_work',
      }),
    ).toBe('run-now');
    expect(
      queuedMessageForceKind({
        turnPhase: 'idle',
        waitingReason: 'background_work',
        retryable: true,
      }),
    ).toBe('run-now');
    expect(queuedMessageForceKind({ waitingReason: 'background_work' })).toBe(
      'run-now',
    );
  });

  it('keeps the phase rule for a row waiting for the agent to take it', () => {
    expect(
      queuedMessageForceKind({
        turnPhase: 'foreground',
        waitingReason: 'steer_unavailable',
      }),
    ).toBe('interrupt');
    expect(
      queuedMessageForceKind({
        turnPhase: 'idle',
        waitingReason: 'steer_unavailable',
      }),
    ).toBe('retry');
  });
});
