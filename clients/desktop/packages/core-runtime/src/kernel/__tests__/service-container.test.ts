import { runInNewContext } from 'node:vm';
import {
  createServiceContainer,
  type RuntimeHealth,
  type RuntimeService,
  type ServiceContainerOptions,
} from '../service-container';

const NEVER = new AbortController().signal;
const hang = (): Promise<void> => new Promise<void>(() => undefined);
const boom =
  (message: string): (() => never) =>
  () => {
    throw new Error(message);
  };

let log: string[] = [];
let changes: RuntimeHealth[] = [];
let react: (health: RuntimeHealth) => void = () => undefined;
beforeEach(() => {
  log = [];
  changes = [];
  react = (): void => undefined;
});

const svc = (
  name: string,
  extra: Partial<RuntimeService> = {},
): RuntimeService => ({
  name,
  plane: 'core',
  start: (): void => void log.push(`start ${name}`),
  stop: { 3: () => void log.push(`stop3 ${name}`) },
  ...extra,
});

const create = (
  services: RuntimeService[],
  profile: ServiceContainerOptions['profile'] = 'core',
): ReturnType<typeof createServiceContainer> =>
  createServiceContainer({
    profile,
    services,
    onChange: (health) => {
      changes.push(health);
      react(health);
    },
  });

describe('createServiceContainer construction', () => {
  it('orders dependencies first and deterministically', () => {
    const services = [svc('c', { dependsOn: ['b', 'a'] }), svc('b')];
    expect(create([...services, svc('a'), svc('d')]).order).toEqual([
      'b',
      'a',
      'c',
      'd',
    ]);
  });

  it.each([
    ['duplicate names', [svc('a'), svc('a')], 'Duplicate service name a'],
    ['unknown dependencies', [svc('a', { dependsOn: ['x'] })], 'unknown'],
    [
      'cycles',
      [svc('a', { dependsOn: ['b'] }), svc('b', { dependsOn: ['a'] })],
      'Service dependency cycle: a -> b -> a',
    ],
    ['self cycles', [svc('a', { dependsOn: ['a'] })], 'cycle: a -> a'],
    [
      'required-on-optional edges',
      [svc('a', { required: false }), svc('b', { dependsOn: ['a'] })],
      'Required service b cannot depend on optional service a',
    ],
  ])('rejects %s', (_label, services, message) => {
    expect(() => create(services)).toThrow(message);
  });

  it('rejects services on planes the profile excludes', () => {
    expect(() => create([svc('a')], 'worker')).toThrow(
      'Runtime profile worker cannot host core service a',
    );
  });

  it('snapshots validated inputs against later mutation', async () => {
    const a = svc('a', { start: boom('a boom') });
    const b = svc('b');
    const container = create([a, b]);
    a.required = false;
    b.dependsOn = ['a'];
    await expect(container.start()).rejects.toThrow('Service a failed');
    expect(container.order).toEqual(['a', 'b']);
  });
});

describe('createServiceContainer startup', () => {
  it('gates start on migrations, preserves receivers, and is ready only afterwards', async () => {
    const migration = {
      id: 'm1',
      run(this: { id: string }): void {
        log.push(`migrate ${this.id}`);
      },
    };
    const container = create([
      svc('a', {
        migrations: [migration],
        start(this: RuntimeService): void {
          log.push(`start ${this.name}`);
        },
      }),
      svc('b', { dependsOn: ['a'] }),
    ]);
    expect(container.health().state).toBe('starting');
    const first = container.start();
    expect(container.start()).toBe(first);
    await first;
    expect(log).toEqual(['migrate m1', 'start a', 'start b']);
    expect(container.health()).toEqual({
      state: 'ready',
      checks: [
        { name: 'a', status: 'pass', message: null },
        { name: 'b', status: 'pass', message: null },
      ],
    });
    expect(changes.map((c) => c.state)).toEqual([
      'starting',
      'starting',
      'starting',
      'ready',
    ]);
  });

  it('settles as degraded when a required migration fails, skipping every start', async () => {
    const container = create([
      svc('a', { migrations: [{ id: 'm1', run: boom('bad') }] }),
      svc('b'),
    ]);
    await expect(container.start()).rejects.toThrow(
      'Service a failed to start: Migration m1 failed: bad',
    );
    expect(log).toEqual([]);
    expect(container.health()).toEqual({
      state: 'degraded',
      checks: [
        { name: 'a', status: 'fail', message: 'Migration m1 failed: bad' },
        { name: 'b', status: 'warn', message: 'Not started' },
      ],
    });
  });

  it('formats arbitrary thrown values without throwing', async () => {
    const hostile: unknown = Object.create(null);
    const start = (): never => {
      throw hostile;
    };
    await expect(create([svc('a', { start })]).start()).rejects.toThrow(
      'Service a failed to start: Unknown error',
    );
  });

  it('degrades on an optional failure, blocks its dependents, and starts the rest', async () => {
    const container = create([
      svc('opt', { required: false, start: boom('opt boom') }),
      svc('child', { required: false, dependsOn: ['opt'] }),
      svc('req'),
    ]);
    await container.start();
    expect(log).toEqual(['start req']);
    expect(container.health()).toEqual({
      state: 'degraded',
      checks: [
        { name: 'opt', status: 'warn', message: 'opt boom' },
        {
          name: 'child',
          status: 'warn',
          message: 'Dependency opt is unavailable',
        },
        { name: 'req', status: 'pass', message: null },
      ],
    });
  });

  describe.each(['observer', 'migration', 'start'])(
    'when a synchronous %s reenters start()',
    (via) => {
      it.each([false, true])(
        'shares one startup (b fails: %s)',
        async (fails) => {
          const seen: Promise<void>[] = [];
          const reenter = (from: string): void => {
            if (from !== 'observer') log.push(from);
            if (from === via) seen.push(container.start());
          };
          react = (): void => reenter('observer');
          const container = create([
            svc('a', {
              // Without migrations, the start hook runs synchronously.
              migrations:
                via === 'start'
                  ? []
                  : [{ id: 'm1', run: (): void => reenter('migration') }],
              start: () => void reenter('start'),
            }),
            svc('b', fails ? { start: boom('b boom') } : {}),
          ]);
          const first = container.start();
          await (fails ? expect(first).rejects.toThrow('b boom') : first);
          expect(seen.length).toBeGreaterThan(0);
          expect(new Set([first, ...seen]).size).toBe(1);
          await container.stopPhase(3, NEVER);
          expect(log).toEqual([
            ...(via === 'start' ? [] : ['migration']),
            'start',
            ...(fails ? [] : ['start b']),
            'stop3 b',
            'stop3 a',
          ]);
        },
      );
    },
  );

  it('waits for cross-realm promises and bounds them by the stop deadline', async () => {
    let foreignHang = hang;
    runInNewContext('use(() => new Promise(() => {}))', {
      use: (fn: () => Promise<void>): void => void (foreignHang = fn),
    });
    expect(foreignHang()).not.toBeInstanceOf(Promise);
    const container = create([
      svc('a', { start: foreignHang, stop: { 3: foreignHang } }),
    ]);
    const started = container.start();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(container.health().state).toBe('starting');
    const deadline = new AbortController();
    const stopped = container.stopPhase(3, deadline.signal);
    await expect(started).rejects.toThrow('stopped before startup');
    deadline.abort(new Error('deadline'));
    await expect(stopped).rejects.toThrow('phase 3 failed: a: deadline');
  });

  it('publishes transitions an observer causes, without recursion or failure', async () => {
    const container = create([svc('a')]);
    react = (health): void => {
      container.health();
      if (health.state === 'ready') container.markStopping();
      throw new Error('observer broke');
    };
    await container.start();
    expect(changes.map((c) => c.state)).toEqual([
      'starting',
      'starting',
      'ready',
      'stopping',
    ]);
  });

  it('publishes deduped health hook transitions and normalizes check names', async () => {
    let status: 'pass' | 'warn' = 'warn';
    const container = create([
      svc('a', { health: () => ({ name: 'x', status, message: 'probe' }) }),
      svc('b', { health: boom('probe broke') }),
    ]);
    await container.start();
    expect(container.health().checks).toEqual([
      { name: 'a', status: 'warn', message: 'probe' },
      { name: 'b', status: 'warn', message: 'Health check threw: probe broke' },
    ]);
    changes.length = 0;
    status = 'pass';
    container.health();
    container.health();
    expect(changes.map((c) => c.checks[0])).toEqual([
      { name: 'a', status: 'pass', message: 'probe' },
    ]);
  });
});

describe('createServiceContainer shutdown', () => {
  it('markStopping is terminal and idempotent, and start cannot publish ready afterwards', async () => {
    let release: () => void = () => undefined;
    const start = (): Promise<void> =>
      new Promise<void>((resolve) => (release = resolve));
    const container = create([svc('a', { start })]);
    const started = container.start();
    container.markStopping();
    container.markStopping();
    release();
    await expect(started).rejects.toThrow('stopped before startup completed');
    expect(container.health().state).toBe('stopping');
    expect(changes.filter((c) => c.state === 'stopping')).toHaveLength(1);
    expect(changes.some((c) => c.state === 'ready')).toBe(false);
    await expect(container.start()).rejects.toThrow('stopped before startup');
  });

  it('interrupts a hung migration and stops only attempted services in reverse', async () => {
    const stopDuringMigration = (): Promise<void> => {
      container.markStopping();
      return hang();
    };
    const container = create([
      svc('a'),
      svc('b', {
        dependsOn: ['a'],
        migrations: [
          { id: 'm1', run: stopDuringMigration },
          { id: 'm2', run: (): void => void log.push('migrate m2') },
        ],
      }),
      svc('c'),
    ]);
    await expect(container.start()).rejects.toThrow('stopped before startup');
    await container.stopPhase(3, NEVER);
    expect(log).toEqual(['start a', 'stop3 b', 'stop3 a']);
  });

  it('invokes every hook in reverse after the deadline and aggregates failures', async () => {
    const stop4 = (name: string, wait: boolean): RuntimeService['stop'] => ({
      4: (): Promise<void> => {
        log.push(`stop4 ${name}`);
        if (wait) return hang();
        throw new Error('stuck');
      },
    });
    const container = create([
      svc('a', { stop: stop4('a', true) }),
      svc('b', { stop: stop4('b', false) }),
      svc('c', { stop: stop4('c', true) }),
    ]);
    await container.start();
    const deadline = new AbortController();
    const stopped = container.stopPhase(4, deadline.signal);
    await new Promise<void>((resolve) => setImmediate(resolve));
    deadline.abort(new Error('deadline'));
    await expect(stopped).rejects.toThrow(
      'Service stop phase 4 failed: c: deadline; b: stuck; a: deadline',
    );
    expect(log.slice(3)).toEqual(['stop4 c', 'stop4 b', 'stop4 a']);
  });

  it('runs hooks even when the deadline has already expired', async () => {
    const container = create([svc('a'), svc('b')]);
    await container.start();
    const deadline = new AbortController();
    deadline.abort(new Error('deadline'));
    await container.stopPhase(3, deadline.signal);
    expect(log.slice(2)).toEqual(['stop3 b', 'stop3 a']);
  });
});
