import {
  WakeLockPolicy,
  wakeLockHolder,
  type WakeLockPolicyState,
  type WakeLockRecord,
} from '../../index';
import {
  createFakePlatformPowerServices,
  type FakePlatformPowerServices,
} from '../../platform/testing';

const flush = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

interface Harness {
  readonly power: FakePlatformPowerServices;
  readonly policy: WakeLockPolicy;
  readonly records: WakeLockRecord[];
  readonly warnings: string[];
  readonly states: WakeLockPolicyState[];
}

function harness(
  mechanism?: Parameters<typeof createFakePlatformPowerServices>[0],
): Harness {
  const power = createFakePlatformPowerServices(mechanism);
  const records: WakeLockRecord[] = [];
  const warnings: string[] = [];
  const states: WakeLockPolicyState[] = [];
  const policy = new WakeLockPolicy(power, {
    record: (record): void => {
      records.push(record);
    },
    warn: (reason): void => {
      warnings.push(reason);
    },
    now: (): number => 7,
  });
  policy.onStateChanged((state): void => {
    states.push(state);
  });
  return { power, policy, records, warnings, states };
}

describe('wakeLockHolder', () => {
  it('names each holder kind with its fixed reason', () => {
    expect(wakeLockHolder('chat', 'w/t/c')).toEqual([
      'chat:w/t/c',
      'agent chat turn',
    ]);
    expect(wakeLockHolder('delegation', 'w/t/c')).toEqual([
      'delegation:w/t/c',
      'delegated task',
    ]);
    expect(wakeLockHolder('pipeline', 'exec-1')).toEqual([
      'pipeline:exec-1',
      'pipeline execution',
    ]);
  });
});

describe('WakeLockPolicy', () => {
  it('holds one assertion for any number of holders', () => {
    const { power, policy } = harness();

    policy.acquire(...wakeLockHolder('chat', 'a'));
    policy.acquire(...wakeLockHolder('delegation', 'a'));
    policy.acquire(...wakeLockHolder('pipeline', 'b'));

    expect(power.assertions).toHaveLength(1);
    expect(power.assertions[0]?.reason).toBe('Agent work is running');
    policy.release('chat:a');
    policy.release('delegation:a');
    expect(power.live()).toHaveLength(1);
    policy.release('pipeline:b');
    expect(power.live()).toEqual([]);
    expect(policy.getState()).toEqual({
      active: false,
      enabled: true,
      holderCount: 0,
    });
  });

  it('reports active only once an asynchronous backend holds the assertion', async () => {
    const { power, policy, records, states } = harness();
    power.outcomes.push('pending');

    policy.acquire(...wakeLockHolder('pipeline', 'exec-1'));
    expect(policy.getState().active).toBe(false);
    expect(records.map(({ kind }) => kind)).toEqual(['wake_lock_acquired']);

    power.assertions[0]?.hold();
    await flush();

    expect(policy.getState().active).toBe(true);
    expect(records.at(-1)).toEqual({
      kind: 'wake_lock_started',
      blockerId: 1,
      holderCount: 1,
      enabled: true,
    });
    expect(states.at(-1)).toEqual({
      active: true,
      enabled: true,
      holderCount: 1,
    });
  });

  it('does not request a second assertion while the first is starting', () => {
    const { power, policy } = harness();
    power.outcomes.push('pending');

    policy.acquire(...wakeLockHolder('chat', 'a'));
    policy.acquire(...wakeLockHolder('chat', 'a'));
    policy.acquire(...wakeLockHolder('pipeline', 'b'));

    expect(power.assertions).toHaveLength(1);
  });

  it('releases a starting assertion when its last holder leaves', async () => {
    const { power, policy } = harness();
    power.outcomes.push('pending');

    policy.acquire(...wakeLockHolder('pipeline', 'exec-1'));
    policy.release('pipeline:exec-1');
    power.assertions[0]?.hold();
    await flush();

    expect(power.assertions[0]?.state).toBe('released');
    expect(policy.getState().active).toBe(false);
  });

  it('replaces a held assertion the backend lost while holders remain', async () => {
    const { power, policy, records, warnings } = harness();

    policy.acquire(...wakeLockHolder('pipeline', 'exec-1'));
    power.assertions[0]?.lose('Sleep helper exited (code 1).');
    await flush();

    expect(power.assertions).toHaveLength(2);
    expect(power.assertions[1]?.state).toBe('held');
    expect(records.map(({ kind }) => kind)).toEqual([
      'wake_lock_acquired',
      'wake_lock_started',
      'wake_lock_stopped',
      'wake_lock_error',
      'wake_lock_started',
    ]);
    expect(records[3]).toEqual({
      kind: 'wake_lock_error',
      reason: 'Sleep helper exited (code 1).',
      holderCount: 1,
      enabled: true,
      blockerId: 1,
    });
    expect(warnings).toEqual(['Sleep helper exited (code 1).']);
  });

  it('does not retry an assertion that ended before it was held until the next holder change', async () => {
    const { power, policy } = harness();
    power.outcomes.push('pending');

    policy.acquire(...wakeLockHolder('pipeline', 'exec-1'));
    power.assertions[0]?.lose('Sleep inhibition was refused.');
    await flush();

    expect(power.assertions).toHaveLength(1);
    expect(policy.getState().active).toBe(false);

    policy.acquire(...wakeLockHolder('chat', 'a'));
    expect(power.assertions).toHaveLength(2);
  });

  it('reports an unavailable backend once', () => {
    const { power, policy, records } = harness();
    power.outcomes.push('unavailable', 'unavailable');

    policy.acquire(...wakeLockHolder('chat', 'a'));
    policy.acquire(...wakeLockHolder('chat', 'b'));

    expect(records.filter(({ kind }) => kind === 'wake_lock_error')).toEqual([
      {
        kind: 'wake_lock_error',
        reason: 'power unavailable',
        holderCount: 1,
        enabled: true,
      },
    ]);
  });

  it('never requests an assertion from a host without a mechanism', () => {
    const { power, policy, records } = harness('unavailable');

    policy.acquire(...wakeLockHolder('chat', 'a'));

    expect(power.assertions).toEqual([]);
    expect(records.map(({ kind }) => kind)).toEqual(['wake_lock_acquired']);
  });

  it('keeps a refused release for a retry at shutdown', async () => {
    const { power, policy, records } = harness();

    policy.acquire(...wakeLockHolder('chat', 'a'));
    power.assertions[0]?.refuseNextRelease('release refused');
    policy.release('chat:a');

    expect(power.live()).toHaveLength(1);
    expect(records.at(-1)).toMatchObject({
      kind: 'wake_lock_error',
      reason: 'release refused',
      blockerId: 1,
    });
    await expect(policy.shutdown()).resolves.toBe(true);
    expect(power.live()).toEqual([]);
  });

  it('retries a release that failed after it was requested', async () => {
    const { power, policy, records } = harness();

    policy.acquire(...wakeLockHolder('pipeline', 'exec-1'));
    power.assertions[0]?.failNextRelease(
      'Sleep helper release could not be confirmed.',
    );
    policy.release('pipeline:exec-1');
    await flush();

    expect(power.assertions[0]?.state).toBe('held');
    expect(records.at(-1)).toMatchObject({
      kind: 'wake_lock_error',
      reason: 'Sleep helper release could not be confirmed.',
      blockerId: 1,
    });
    // Still held, so the state does not claim the computer may sleep.
    expect(policy.getState()).toEqual({
      active: true,
      enabled: true,
      holderCount: 0,
    });

    await expect(policy.shutdown()).resolves.toBe(true);
    expect(power.live()).toEqual([]);
  });

  it('stays active while a release is still stopping the backend', async () => {
    const { power, policy, states } = harness();

    policy.acquire(...wakeLockHolder('pipeline', 'exec-1'));
    power.assertions[0]?.holdNextRelease();
    policy.release('pipeline:exec-1');
    await flush();

    expect(policy.getState()).toEqual({
      active: true,
      enabled: true,
      holderCount: 0,
    });

    power.assertions[0]?.settleRelease();
    await flush();

    expect(policy.getState().active).toBe(false);
    expect(states.at(-1)).toEqual({
      active: false,
      enabled: true,
      holderCount: 0,
    });
  });

  it('retries an unconfirmed release at the next holder change', async () => {
    const { power, policy } = harness();

    policy.acquire(...wakeLockHolder('pipeline', 'exec-1'));
    power.assertions[0]?.failNextRelease('unconfirmed');
    policy.release('pipeline:exec-1');
    await flush();
    policy.acquire(...wakeLockHolder('chat', 'a'));
    await flush();

    expect(power.assertions[0]?.state).toBe('released');
    expect(power.live()).toHaveLength(1);
  });

  describe('holdUntil', () => {
    it.each([
      ['success', (): Promise<string> => Promise.resolve('success')],
      ['failure', (): Promise<string> => Promise.reject(new Error('crashed'))],
      [
        'cancellation',
        (): Promise<string> =>
          Promise.reject(new DOMException('cancelled', 'AbortError')),
      ],
    ])('releases the holder on %s', async (_outcome, settle) => {
      const { power, policy } = harness();
      let finish: () => void = () => undefined;
      const work = new Promise<void>((resolve) => {
        finish = resolve;
      }).then(settle);
      work.catch(() => undefined);

      policy.holdUntil('pipeline', 'exec-1', work);
      expect(policy.getHolders()).toEqual([
        { key: 'pipeline:exec-1', reason: 'pipeline execution', acquiredAt: 7 },
      ]);
      expect(power.live()).toHaveLength(1);

      finish();
      await flush();

      expect(policy.getHolders()).toEqual([]);
      expect(power.live()).toEqual([]);
    });

    it('keeps the assertion while another holder remains', async () => {
      const { power, policy } = harness();
      let finish: () => void = () => undefined;
      const work = new Promise<void>((resolve) => {
        finish = resolve;
      });

      policy.acquire(...wakeLockHolder('chat', 'a'));
      policy.holdUntil('pipeline', 'exec-1', work);
      finish();
      await flush();

      expect(policy.getHolders().map(({ key }) => key)).toEqual(['chat:a']);
      expect(power.live()).toHaveLength(1);
    });
  });
});
