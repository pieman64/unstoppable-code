import { TurnDispatchTiming } from '../lib/turn-dispatch-timing';

describe('TurnDispatchTiming', () => {
  it('records phase durations and emits only after a slow enqueue', async () => {
    let now = 10;
    const timing = new TurnDispatchTiming((): number => now);

    await timing.measure('auth_preflight', () => {
      now += 500;
    });
    await timing.measure('prompt_commit', () => {
      now += 1_100;
    });
    await timing.measure('enqueue', (): void => {
      now += 450;
    });

    const diagnostic = timing.markEnqueued();
    expect(diagnostic).toMatchObject({
      kind: 'turn_dispatch_slow',
      totalMs: 2_050,
      endpoint: 'enqueued',
      phases: [
        { phase: 'prompt_commit', elapsedMs: 1_100 },
        { phase: 'auth_preflight', elapsedMs: 500 },
        { phase: 'enqueue', elapsedMs: 450 },
      ],
    });
    expect(timing.markEnqueued()).toBeUndefined();

    now += 75;
    expect(timing.markFirstProviderEvent()).toMatchObject({
      kind: 'turn_dispatch_slow',
      totalMs: 2_125,
      endpoint: 'first_event',
    });
    expect(timing.markFirstProviderEvent()).toBeUndefined();
  });

  it('keeps the first-event milestone when an event arrives before the enqueue', async () => {
    let now = 0;
    const timing = new TurnDispatchTiming((): number => now);
    now = 100;
    expect(timing.markFirstProviderEvent()).toBeUndefined();
    await timing.measure('session_config', (): void => {
      now = 2_500;
    });
    expect(timing.markEnqueued()).toMatchObject({ endpoint: 'enqueued' });
    now = 2_800;
    expect(timing.markFirstProviderEvent()).toMatchObject({
      endpoint: 'first_event',
      totalMs: 2_800,
    });
  });

  it('does not emit a diagnostic for a fast enqueue', async () => {
    let now = 10;
    const timing = new TurnDispatchTiming((): number => now);
    await timing.measure('session_config', () => {
      now += 1_999;
    });

    expect(timing.markEnqueued()).toBeUndefined();
    now += 10;
    expect(timing.markFirstProviderEvent()).toBeUndefined();
  });

  it('retains elapsed time for a phase whose operation rejects', async () => {
    let now = 0;
    const timing = new TurnDispatchTiming((): number => now);
    await expect(
      timing.measure('auth_preflight', (): Promise<void> => {
        now += 2_100;
        return Promise.reject(new Error('not part of the timing record'));
      }),
    ).rejects.toThrow('not part of the timing record');

    expect(timing.markEnqueued()?.phases).toEqual([
      { phase: 'auth_preflight', elapsedMs: 2_100 },
    ]);
  });
});
