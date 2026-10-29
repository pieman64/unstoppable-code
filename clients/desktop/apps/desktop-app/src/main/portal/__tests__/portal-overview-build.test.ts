import { createPortalFreshSingleFlight } from '../portal-overview-build';

interface Gate {
  promise: Promise<string>;
  resolve: (value: string) => void;
  reject: (error: Error) => void;
}

function gate(): Gate {
  let resolve: (value: string) => void = () => undefined;
  let reject: (error: Error) => void = () => undefined;
  const promise = new Promise<string>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function settle(): Promise<void> {
  for (let round = 0; round < 5; round += 1) await Promise.resolve();
}

describe('createPortalFreshSingleFlight', () => {
  let clock = 0;
  const builds: Gate[] = [];
  const start = (): Promise<string> => {
    const build = gate();
    builds.push(build);
    return build.promise;
  };

  beforeEach(() => {
    clock = 0;
    builds.length = 0;
  });

  it('reuses an in-flight build that started after the caller arrived', async () => {
    const flight = createPortalFreshSingleFlight<string>(() => clock);
    clock = 10;
    const first = flight.acquire(5, start);
    const second = flight.acquire(10, start);
    expect(builds).toHaveLength(1);
    builds[0]?.resolve('built-at-10');
    await expect(first).resolves.toBe('built-at-10');
    await expect(second).resolves.toBe('built-at-10');
  });

  it('never hands an older build to a caller that arrived after it started', async () => {
    const flight = createPortalFreshSingleFlight<string>(() => clock);
    clock = 10;
    const older = flight.acquire(10, start);
    clock = 11;
    const later = flight.acquire(11, start);
    expect(builds).toHaveLength(1);
    builds[0]?.resolve('built-at-10');
    await expect(older).resolves.toBe('built-at-10');
    await settle();
    expect(builds).toHaveLength(2);
    builds[1]?.resolve('built-after-11');
    await expect(later).resolves.toBe('built-after-11');
  });

  it('runs exactly one more build for every caller arriving during a build', async () => {
    const flight = createPortalFreshSingleFlight<string>(() => clock);
    clock = 1;
    void flight.acquire(1, start);
    const waiting = [2, 3, 4].map((arrivedAt) => {
      clock = arrivedAt;
      return flight.acquire(arrivedAt, start);
    });
    expect(builds).toHaveLength(1);
    clock = 5;
    builds[0]?.resolve('first');
    await settle();
    expect(builds).toHaveLength(2);
    builds[1]?.resolve('second');
    await expect(Promise.all(waiting)).resolves.toEqual([
      'second',
      'second',
      'second',
    ]);
    expect(builds).toHaveLength(2);
  });

  it('still runs the follow-up build when the in-flight build fails', async () => {
    const flight = createPortalFreshSingleFlight<string>(() => clock);
    const failed = flight.acquire(0, start);
    clock = 1;
    const later = flight.acquire(1, start);
    builds[0]?.reject(new Error('build failed'));
    await expect(failed).rejects.toThrow('build failed');
    await settle();
    builds[1]?.resolve('recovered');
    await expect(later).resolves.toBe('recovered');
  });

  it('starts a fresh build once the previous one has settled', async () => {
    const flight = createPortalFreshSingleFlight<string>(() => clock);
    const first = flight.acquire(0, start);
    builds[0]?.resolve('first');
    await first;
    await settle();
    clock = 1;
    const next = flight.acquire(1, start);
    expect(builds).toHaveLength(2);
    builds[1]?.resolve('next');
    await expect(next).resolves.toBe('next');
  });
});
