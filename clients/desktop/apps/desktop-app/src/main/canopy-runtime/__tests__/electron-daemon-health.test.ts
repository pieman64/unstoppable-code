import {
  BackgroundServiceStatusSchema,
  type BackgroundServiceStatus,
} from '@canopy/desktop-shared/lib/background-service-status';
import {
  createElectronDaemonHealth,
  type ElectronDaemonHealth,
} from '../electron-daemon-health';

let health: ElectronDaemonHealth;
let pushed: BackgroundServiceStatus[];
const warn = jest.fn();
const info = jest.fn();

beforeEach(() => {
  warn.mockClear();
  info.mockClear();
  health = createElectronDaemonHealth({ warn, info });
  pushed = [];
  health.onStatusChanged((status) => void pushed.push(status));
  health.setConsumerEnabled('files_reads', true);
});

function gate(): {
  promise: Promise<boolean>;
  resolve: (live: boolean) => void;
  reject: (error: unknown) => void;
} {
  let resolve: (live: boolean) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<boolean>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

it('starts ok and moves to unavailable, then back on reach', () => {
  expect(health.getStatus()).toEqual({
    state: 'ok',
    retry: 'idle',
    sequence: 0,
  });
  health.observe({ kind: 'unreachable', reason: 'start_failed' });
  expect(health.getStatus()).toEqual({
    state: 'unavailable',
    reason: 'start_failed',
    retry: 'idle',
    sequence: 1,
  });
  // The same failure again (each read) is not a change.
  health.observe({ kind: 'unreachable', reason: 'start_failed' });
  health.observe({ kind: 'reached' });
  expect(pushed.map(({ state }) => state)).toEqual(['unavailable', 'ok']);
  expect(health.getStatus()).toEqual({
    state: 'ok',
    retry: 'idle',
    sequence: 2,
  });
  expect(warn).toHaveBeenCalledTimes(1);
  expect(warn).toHaveBeenCalledWith('Background service unavailable', {
    reason: 'start_failed',
  });
  expect(info).toHaveBeenCalledWith('Background service reachable again');
});

it('keeps a lost session hidden while the lease restarts the daemon, then ok on reach', () => {
  health.observe({ kind: 'lost' });
  // An expected restart (a crash or idle exit the lease relaunches): hidden.
  expect(health.getStatus()).toEqual({
    state: 'reconnecting',
    retry: 'idle',
    sequence: 1,
  });
  health.observe({ kind: 'lost' });
  health.observe({ kind: 'reached' });
  expect(pushed.map(({ state, reason }) => [state, reason])).toEqual([
    ['reconnecting', undefined],
    ['ok', undefined],
  ]);
  expect(warn).not.toHaveBeenCalled();
  expect(info).not.toHaveBeenCalled();
});

it('shows a restart that fails at once, with its reason', () => {
  health.observe({ kind: 'lost' });
  health.observe({ kind: 'unreachable', reason: 'reconnect_failed' });
  expect(health.getStatus()).toEqual({
    state: 'unavailable',
    reason: 'reconnect_failed',
    retry: 'idle',
    sequence: 2,
  });
  expect(warn).toHaveBeenCalledWith('Background service unavailable', {
    reason: 'reconnect_failed',
  });
  expect(health.isLatched()).toBe(true);
});

it('a loss keeps an earlier reason, and a failed reconnect replaces its own', () => {
  health.observe({ kind: 'unreachable', reason: 'start_failed' });
  health.observe({ kind: 'lost' });
  expect(health.getStatus()).toMatchObject({ reason: 'start_failed' });
  health.observe({ kind: 'reached' });
  health.observe({ kind: 'lost' });
  health.observe({ kind: 'unreachable', reason: 'reconnect_failed' });
  expect(health.getStatus()).toMatchObject({
    state: 'unavailable',
    reason: 'reconnect_failed',
  });
});

it('shows a failed reconnect after a loss, and a loss never hides it', () => {
  health.observe({ kind: 'lost' });
  health.observe({ kind: 'unreachable', reason: 'reconnect_failed' });
  health.observe({ kind: 'lost' });
  expect(health.getStatus()).toMatchObject({
    state: 'unavailable',
    reason: 'reconnect_failed',
  });
});

it('ignores events with no enabled consumer and resets when the last one turns off', () => {
  health.observe({ kind: 'unreachable', reason: 'connect_timeout' });
  health.setConsumerEnabled('files_reads', false);
  expect(health.getStatus().state).toBe('ok');
  health.observe({ kind: 'unreachable', reason: 'start_failed' });
  expect(health.getStatus()).toMatchObject({ state: 'ok', retry: 'idle' });
  health.setConsumerEnabled('files_reads', true);
  expect(health.getStatus().state).toBe('ok');
});

it('stop ignores every later event and retry', async () => {
  health.stop();
  health.observe({ kind: 'unreachable', reason: 'start_failed' });
  const attempt = jest.fn(() => Promise.resolve(true));
  await health.retry(attempt);
  expect(attempt).not.toHaveBeenCalled();
  expect(pushed).toEqual([]);
});

it('retry is a no-op with no enabled consumer', async () => {
  health.setConsumerEnabled('files_reads', false);
  const attempt = jest.fn(() => Promise.resolve(true));
  await expect(health.retry(attempt)).resolves.toMatchObject({ state: 'ok' });
  expect(attempt).not.toHaveBeenCalled();
});

it('coalesces concurrent retries and clears the notice when one reaches', async () => {
  health.observe({ kind: 'unreachable', reason: 'start_failed' });
  const pending = gate();
  const attempt = jest.fn(() => pending.promise);
  const first = health.retry(attempt);
  const second = health.retry(attempt);
  await Promise.resolve();
  expect(attempt).toHaveBeenCalledTimes(1);
  expect(health.getStatus()).toMatchObject({
    state: 'unavailable',
    retry: 'running',
  });
  pending.resolve(true);
  const [a, b] = await Promise.all([first, second]);
  expect(a).toBe(b);
  expect(a).toMatchObject({ state: 'ok', retry: 'idle' });
});

it('a failed retry stays on screen as failed until the service is reached', async () => {
  health.observe({ kind: 'unreachable', reason: 'start_failed' });
  const pending = gate();
  const retried = health.retry(() => pending.promise);
  // The attempt's own failure arrives through the connection service first.
  health.observe({ kind: 'unreachable', reason: 'connect_timeout' });
  pending.reject(new Error('Core launch failed.'));
  await expect(retried).resolves.toMatchObject({
    state: 'unavailable',
    reason: 'connect_timeout',
    retry: 'failed',
  });
  expect(pushed.map(({ retry }) => retry)).toEqual([
    'idle',
    'running',
    'running',
    'failed',
  ]);
  health.observe({ kind: 'reached' });
  expect(health.getStatus()).toMatchObject({ state: 'ok', retry: 'idle' });
});

it('a retry refused by a reached service leaves nothing to show', async () => {
  health.observe({ kind: 'unreachable', reason: 'start_failed' });
  await health.retry(() => {
    health.observe({ kind: 'reached' });
    return Promise.reject(new Error('Lease refused.'));
  });
  expect(health.getStatus()).toMatchObject({ state: 'ok', retry: 'idle' });
});

it('a reused session that is still reconnecting has not reached the service', async () => {
  health.observe({ kind: 'lost' });
  health.observe({ kind: 'unreachable', reason: 'reconnect_failed' });
  await expect(health.retry(() => Promise.resolve(false))).resolves.toEqual({
    state: 'unavailable',
    reason: 'reconnect_failed',
    retry: 'failed',
    sequence: 4,
  });
});

it('a retry that throws synchronously still ends, so the next one runs', async () => {
  health.observe({ kind: 'unreachable', reason: 'start_failed' });
  const failing = (): Promise<boolean> => {
    throw new Error('sync');
  };
  await expect(health.retry(failing)).resolves.toMatchObject({
    retry: 'failed',
  });
  const next = jest.fn(() => Promise.resolve(true));
  await expect(health.retry(next)).resolves.toMatchObject({ state: 'ok' });
  expect(next).toHaveBeenCalledTimes(1);
});

it('a throwing listener never blocks the others', () => {
  const later = jest.fn();
  health.onStatusChanged(() => {
    throw new Error('listener');
  });
  health.onStatusChanged(later);
  health.observe({ kind: 'unreachable', reason: 'host_unavailable' });
  expect(later).toHaveBeenCalledTimes(1);
});

describe('fallback and the start latch', () => {
  it.each([
    'start_failed',
    'connect_timeout',
    'host_unavailable',
    'reconnect_failed',
  ] as const)('latches on a %s until the next reach', (reason) => {
    expect(health.isLatched()).toBe(false);
    health.observe({ kind: 'unreachable', reason });
    expect(health.isLatched()).toBe(true);
    health.observe({ kind: 'reached' });
    expect(health.isLatched()).toBe(false);
  });

  it('never latches on a lost session', () => {
    health.observe({ kind: 'lost' });
    expect(health.getStatus()).toMatchObject({ state: 'reconnecting' });
    expect(health.isLatched()).toBe(false);
  });

  it('a fallback shows the warning, with its reason, even while ok', () => {
    health.noteFallback('files_reads', 'host_unavailable');
    expect(health.getStatus()).toEqual({
      state: 'unavailable',
      reason: 'host_unavailable',
      retry: 'idle',
      sequence: 1,
    });
    expect(health.isLatched()).toBe(true);
    // During a restart, a start-class fallback is a real failure: shown.
    health.observe({ kind: 'reached' });
    health.observe({ kind: 'lost' });
    health.noteFallback('files_reads', 'start_failed');
    expect(health.getStatus()).toMatchObject({
      state: 'unavailable',
      reason: 'start_failed',
    });
    expect(health.isLatched()).toBe(true);
    // An earlier reason stays.
    health.noteFallback('files_reads', 'connect_timeout');
    expect(health.getStatus()).toMatchObject({ reason: 'start_failed' });
    expect(warn).toHaveBeenCalledTimes(2);
    health.observe({ kind: 'reached' });
    expect(health.getStatus()).toMatchObject({ state: 'ok' });
    expect(health.isLatched()).toBe(false);
  });

  it('a lost-connection fallback while ok warns nothing: a real loss reports itself first', () => {
    // A session closed by its own lifetime, or a client the lease already
    // replaced: the service was reached, so nothing is shown or latched.
    health.noteFallback('files_reads', 'connection_lost');
    expect(health.getStatus()).toMatchObject({ state: 'ok' });
    expect(health.isLatched()).toBe(false);
    expect(warn).not.toHaveBeenCalled();
    expect(pushed).toEqual([]);
  });

  it('a lost-connection fallback during a restart stays hidden until the restart fails', () => {
    health.observe({ kind: 'lost' });
    health.noteFallback('files_reads', 'connection_lost');
    expect(health.getStatus()).toMatchObject({ state: 'reconnecting' });
    expect(health.isLatched()).toBe(false);
    expect(warn).not.toHaveBeenCalled();
    health.observe({ kind: 'unreachable', reason: 'reconnect_failed' });
    expect(health.getStatus()).toMatchObject({
      state: 'unavailable',
      reason: 'reconnect_failed',
    });
  });

  it('ignores a fallback from a disabled consumer, and after stop', () => {
    health.setConsumerEnabled('files_reads', false);
    health.noteFallback('files_reads', 'start_failed');
    expect(health.getStatus().state).toBe('ok');
    expect(health.isLatched()).toBe(false);
    health.setConsumerEnabled('files_reads', true);
    health.stop();
    health.noteFallback('files_reads', 'start_failed');
    expect(health.getStatus().state).toBe('ok');
    expect(health.isLatched()).toBe(false);
  });

  it('turning the last consumer off clears the latch', () => {
    health.observe({ kind: 'unreachable', reason: 'start_failed' });
    health.setConsumerEnabled('files_reads', false);
    health.setConsumerEnabled('files_reads', true);
    expect(health.isLatched()).toBe(false);
    expect(health.getStatus().state).toBe('ok');
  });

  it('Try again lifts the latch while it runs and re-arms it when it fails', async () => {
    health.observe({ kind: 'unreachable', reason: 'start_failed' });
    const pending = gate();
    const retried = health.retry(() => pending.promise);
    expect(health.isLatched()).toBe(false);
    pending.resolve(false);
    await retried;
    expect(health.isLatched()).toBe(true);
    await health.retry(() => Promise.resolve(true));
    expect(health.isLatched()).toBe(false);
  });

  it('a failed Try again leaves the latch off once the service was reached meanwhile', async () => {
    health.observe({ kind: 'unreachable', reason: 'start_failed' });
    await health.retry(() => {
      health.observe({ kind: 'reached' });
      health.observe({ kind: 'lost' });
      return Promise.resolve(false);
    });
    expect(health.getStatus()).toMatchObject({
      state: 'reconnecting',
      retry: 'idle',
    });
    expect(health.isLatched()).toBe(false);
  });
});

it('every status parses strict and carries codes only', () => {
  health.observe({ kind: 'lost' });
  health.observe({ kind: 'unreachable', reason: 'host_unavailable' });
  void health.retry(() => Promise.resolve(true));
  for (const status of [health.getStatus(), ...pushed]) {
    expect(BackgroundServiceStatusSchema.parse(status)).toEqual(status);
    expect(Object.keys(status).sort()).toEqual(
      status.reason
        ? ['reason', 'retry', 'sequence', 'state']
        : ['retry', 'sequence', 'state'],
    );
  }
  expect(pushed.map(({ sequence }) => sequence)).toEqual([1, 2, 3]);
  expect(() =>
    BackgroundServiceStatusSchema.parse({
      ...health.getStatus(),
      message: '/Users/someone',
    }),
  ).toThrow();
});
