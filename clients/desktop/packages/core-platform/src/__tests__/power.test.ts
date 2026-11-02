import type {
  PlatformExecutionOutcome,
  PlatformExecutionProcess,
  PlatformExecutionProcessServices,
  PlatformExecutionRequest,
  PlatformPowerAcquireResult,
  PlatformPowerAssertion,
} from '@canopy/core-runtime';
import {
  createHelperPowerServices,
  DARWIN_POWER_HELPER,
  linuxPowerHelper,
  type PowerHelper,
} from '../power/helper';
import { createWindowsPowerServices } from '../power/windows';

const flush = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

interface FakeChild extends PlatformExecutionProcess {
  /** Writes stdout bytes, or ends stdout with `null`. */
  emit(text: string | null): void;
  exit(outcome: Partial<PlatformExecutionOutcome>): void;
  readonly terminations: string[];
  failTerminate: boolean;
}

function fakeChild(): FakeChild {
  const chunks: (Uint8Array | null)[] = [];
  let waiting: ((value: Uint8Array | null) => void) | null = null;
  let settle: (outcome: PlatformExecutionOutcome) => void = () => undefined;
  const outcome = new Promise<PlatformExecutionOutcome>((resolve) => {
    settle = resolve;
  });
  const terminations: string[] = [];
  const child: FakeChild = {
    pid: 4242,
    stdin: { write: () => Promise.resolve(), end: () => Promise.resolve() },
    stderr: null,
    outcome,
    terminations,
    failTerminate: false,
    stdout: {
      read: (): Promise<Uint8Array | null> => {
        const next = chunks.shift();
        if (next !== undefined) return Promise.resolve(next);
        return new Promise((resolve) => {
          waiting = resolve;
        });
      },
      acknowledge: (): void => undefined,
      discard: (): void => undefined,
    },
    emit: (text): void => {
      const bytes = text === null ? null : new TextEncoder().encode(text);
      if (waiting) {
        const resolve = waiting;
        waiting = null;
        resolve(bytes);
      } else chunks.push(bytes);
    },
    exit: (value): void =>
      settle({
        kind: 'exited',
        code: 0,
        signal: null,
        output: 'complete',
        ...value,
      }),
    terminate: (options): Promise<void> => {
      terminations.push(options?.mode ?? 'force');
      if (child.failTerminate) return Promise.reject(new Error('lost'));
      child.exit({ kind: 'cancelled', code: null, signal: 'SIGTERM' });
      return Promise.resolve();
    },
  };
  return child;
}

interface Harness {
  readonly requests: PlatformExecutionRequest[];
  readonly children: FakeChild[];
  readonly processes: PlatformExecutionProcessServices;
  failStart: boolean;
}

function processHarness(): Harness {
  const harness: Harness = {
    requests: [],
    children: [],
    failStart: false,
    processes: {
      start: (request): Promise<PlatformExecutionProcess> => {
        harness.requests.push(request);
        if (harness.failStart)
          return Promise.reject(new Error('could not start'));
        const child = fakeChild();
        harness.children.push(child);
        return Promise.resolve(child);
      },
      shutdown: () => Promise.resolve(),
    },
  };
  return harness;
}

function acquired(result: PlatformPowerAcquireResult): PlatformPowerAssertion {
  if (result.kind !== 'acquired')
    throw new Error(`not acquired: ${result.kind}`);
  return result.assertion;
}

const LINUX = linuxPowerHelper({
  applicationName: 'Test daemon',
  exists: (path) => path === '/usr/bin/systemd-inhibit',
});

describe('helper power services', () => {
  it.each<[string, PowerHelper, string, readonly string[]]>([
    ['darwin', DARWIN_POWER_HELPER, '/usr/bin/caffeinate', ['-i']],
    [
      'linux',
      LINUX,
      '/usr/bin/systemd-inhibit',
      [
        '--what=sleep',
        '--mode=block',
        '--who=Test daemon',
        '--why=Agent work is running',
      ],
    ],
  ])(
    'runs the %s helper around a stdin-held command, without PATH or inherited environment',
    async (_os, helper, executable, args) => {
      const harness = processHarness();
      const power = createHelperPowerServices(helper, () => harness.processes);
      acquired(power.preventSystemSleep({ reason: 'Agent work is running' }));
      await flush();

      expect(harness.requests).toEqual([
        {
          executable,
          args: [
            ...args,
            '/bin/sh',
            '-c',
            "printf 'held\\n'; read -r _; exit 0",
          ],
          cwd: '/',
          environment: { PATH: '/usr/bin:/bin', LC_ALL: 'C' },
          stdin: 'pipe',
          stderr: 'discard',
          outputWindowBytes: 256,
        },
      ]);
    },
  );

  it('is held only once the command reports it, then released by a graceful stop', async () => {
    const harness = processHarness();
    const power = createHelperPowerServices(
      DARWIN_POWER_HELPER,
      () => harness.processes,
    );
    const assertion = acquired(power.preventSystemSleep({ reason: 'r' }));
    await flush();
    expect(assertion.isHeld()).toBe(false);

    harness.children[0]?.emit('he');
    harness.children[0]?.emit('ld\n');
    await expect(assertion.held).resolves.toBe(true);
    expect(assertion.isHeld()).toBe(true);

    await assertion.release();
    expect(harness.children[0]?.terminations).toEqual(['graceful']);
    expect(assertion.isHeld()).toBe(false);
    await expect(assertion.ended).resolves.toEqual({ kind: 'released' });
    await assertion.release();
    expect(harness.children[0]?.terminations).toEqual(['graceful']);
  });

  it('reports a helper that exits before holding as lost', async () => {
    const harness = processHarness();
    const power = createHelperPowerServices(LINUX, () => harness.processes);
    const assertion = acquired(power.preventSystemSleep({ reason: 'r' }));
    await flush();

    harness.children[0]?.emit(null);
    harness.children[0]?.exit({ code: 1 });

    await expect(assertion.held).resolves.toBe(false);
    await expect(assertion.ended).resolves.toEqual({
      kind: 'lost',
      reason: 'Sleep helper exited (code 1).',
    });
  });

  it('reports a held helper that ends unasked as lost', async () => {
    const harness = processHarness();
    const power = createHelperPowerServices(
      DARWIN_POWER_HELPER,
      () => harness.processes,
    );
    const assertion = acquired(power.preventSystemSleep({ reason: 'r' }));
    await flush();
    harness.children[0]?.emit('held\n');
    await assertion.held;

    harness.children[0]?.exit({
      kind: 'crashed',
      code: null,
      signal: 'SIGKILL',
    });

    await expect(assertion.ended).resolves.toEqual({
      kind: 'lost',
      reason: 'Sleep helper ended (SIGKILL).',
    });
    expect(assertion.isHeld()).toBe(false);
  });

  it('ends a helper that could not start', async () => {
    const harness = processHarness();
    harness.failStart = true;
    const power = createHelperPowerServices(
      DARWIN_POWER_HELPER,
      () => harness.processes,
    );
    const assertion = acquired(power.preventSystemSleep({ reason: 'r' }));

    await expect(assertion.held).resolves.toBe(false);
    await expect(assertion.ended).resolves.toEqual({
      kind: 'lost',
      reason: 'Sleep helper could not start.',
    });
    await expect(assertion.release()).resolves.toBeUndefined();
  });

  it('stops a helper released while it is still starting', async () => {
    const harness = processHarness();
    const power = createHelperPowerServices(
      DARWIN_POWER_HELPER,
      () => harness.processes,
    );
    const assertion = acquired(power.preventSystemSleep({ reason: 'r' }));

    await assertion.release();

    expect(harness.children[0]?.terminations).toEqual(['graceful']);
    await expect(assertion.held).resolves.toBe(false);
    await expect(assertion.ended).resolves.toEqual({ kind: 'released' });
  });

  it('rejects a release whose stop was not confirmed', async () => {
    const harness = processHarness();
    const power = createHelperPowerServices(
      DARWIN_POWER_HELPER,
      () => harness.processes,
    );
    const assertion = acquired(power.preventSystemSleep({ reason: 'r' }));
    await flush();
    const child = harness.children[0];
    if (!child) throw new Error('no child');
    child.failTerminate = true;

    await expect(assertion.release()).rejects.toThrow(
      'Sleep helper release could not be confirmed.',
    );
    child.exit({ kind: 'lost', code: null, signal: null });
    await expect(assertion.ended).resolves.toEqual({
      kind: 'lost',
      reason: 'Sleep helper release could not be confirmed.',
    });

    child.failTerminate = false;
    await expect(assertion.release()).resolves.toBeUndefined();
    expect(child.terminations).toEqual(['graceful', 'graceful']);
    await assertion.release();
    expect(child.terminations).toEqual(['graceful', 'graceful']);
  });

  it('is unavailable without systemd-inhibit and starts nothing', () => {
    const harness = processHarness();
    const power = createHelperPowerServices(
      linuxPowerHelper({ applicationName: 'x', exists: () => false }),
      () => harness.processes,
    );

    expect(power.preventSystemSleep({ reason: 'r' })).toEqual({
      kind: 'unavailable',
      reason: 'Sleep inhibition needs systemd-inhibit, which is missing.',
    });
    expect(harness.requests).toEqual([]);
  });

  it('falls back to /bin/systemd-inhibit', async () => {
    const harness = processHarness();
    const power = createHelperPowerServices(
      linuxPowerHelper({
        applicationName: 'x',
        exists: (path) => path === '/bin/systemd-inhibit',
      }),
      () => harness.processes,
    );
    acquired(power.preventSystemSleep({ reason: 'r' }));
    await flush();

    expect(harness.requests[0]?.executable).toBe('/bin/systemd-inhibit');
  });
});

describe('Windows power services', () => {
  function windowsHarness(accepts = true): {
    calls: boolean[];
    accepts: boolean[];
    power: ReturnType<typeof createWindowsPowerServices>;
  } {
    const calls: boolean[] = [];
    const answers = [accepts];
    const power = createWindowsPowerServices(() => (required): boolean => {
      calls.push(required);
      return answers.shift() ?? true;
    });
    return { calls, accepts: answers, power };
  }

  it('sets the execution state for the first holder and clears it after the last', async () => {
    const { calls, power } = windowsHarness();
    expect(power.mechanism).toBe('thread-execution-state');

    const first = acquired(power.preventSystemSleep({ reason: 'r' }));
    const second = acquired(power.preventSystemSleep({ reason: 'r' }));
    expect(calls).toEqual([true]);
    await expect(first.held).resolves.toBe(true);
    expect(first.isHeld()).toBe(true);

    await first.release();
    expect(calls).toEqual([true]);
    await second.release();
    await second.release();
    expect(calls).toEqual([true, false]);
    expect(second.isHeld()).toBe(false);
    await expect(second.ended).resolves.toEqual({ kind: 'released' });
  });

  it('fails a request Windows refused, holding nothing', () => {
    const { power } = windowsHarness(false);

    expect(power.preventSystemSleep({ reason: 'r' })).toEqual({
      kind: 'failed',
      reason: 'Windows refused the power execution state.',
    });
  });

  it('keeps the assertion when Windows does not clear the state', async () => {
    const { calls, accepts, power } = windowsHarness();
    const assertion = acquired(power.preventSystemSleep({ reason: 'r' }));
    accepts.push(false);

    expect(() => assertion.release()).toThrow(
      'Windows did not clear the power execution state.',
    );
    expect(assertion.isHeld()).toBe(true);
    await assertion.release();
    expect(calls).toEqual([true, false, false]);
    expect(assertion.isHeld()).toBe(false);
  });

  it('is unavailable when the addon cannot load, and loads once', () => {
    let loads = 0;
    const power = createWindowsPowerServices(() => {
      loads += 1;
      throw new Error('missing');
    });

    for (let attempt = 0; attempt < 2; attempt += 1)
      expect(power.preventSystemSleep({ reason: 'r' })).toEqual({
        kind: 'unavailable',
        reason: 'Power execution state is unavailable on this host.',
      });
    expect(loads).toBe(1);
  });
});
