import {
  ExecutionAccounting,
  ExecutionAdmissionError,
  WakeLockPolicy,
  type ExecutionAccountingLimits,
  type ExecutionResourceItem,
  type PlatformProcessTable,
  type PlatformProcessTableRow,
} from '../../index';
import { createFakePlatformPowerServices } from '../../platform/testing';

type Metadata =
  | { type: 'generic' }
  | { type: 'pipeline'; pipeline: { executionId: string } };

const MIB = 1024 * 1024;
const ROOT = 100;

const flush = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

function row(
  pid: number,
  ppid: number,
  command: string,
  memoryMib = 1,
  cpuPercent = 0,
): PlatformProcessTableRow {
  return {
    pid,
    ppid,
    pgid: pid,
    cpuPercent,
    memoryRssBytes: memoryMib * MIB,
    command,
  };
}

function table(rows: PlatformProcessTableRow[]): PlatformProcessTable {
  return { kind: 'sampled', rows: new Map(rows.map((r) => [r.pid, r])) };
}

interface Harness {
  readonly accounting: ExecutionAccounting<Metadata>;
  readonly limits: { current: ExecutionAccountingLimits };
  readonly tables: PlatformProcessTable[];
  readonly wake: string[];
}

function harness(
  options: { wakeLock?: boolean; host?: boolean } = {},
): Harness {
  const limits = {
    current: {
      maxActive: { pipeline: 2 },
      memoryGuardEnabled: true,
      warningMemoryBytes: 100 * MIB,
      criticalMemoryBytes: 200 * MIB,
    } satisfies ExecutionAccountingLimits,
  };
  const tables: PlatformProcessTable[] = [];
  const wake: string[] = [];
  const accounting = new ExecutionAccounting<Metadata>({
    rootPid: ROOT,
    readProcessTable: (): Promise<PlatformProcessTable> =>
      Promise.resolve(
        tables.shift() ?? { kind: 'unavailable', reason: 'no table' },
      ),
    ...(options.host
      ? {
          hostProcesses: (): ExecutionResourceItem<Metadata>[] => [
            {
              id: `host:${ROOT}`,
              kind: 'electron-main',
              groupId: 'app',
              label: 'Host main',
              pid: ROOT,
              cpuPercent: 1,
              memoryRssBytes: 10 * MIB,
              processCount: 1,
              status: 'running',
            },
          ],
        }
      : {}),
    limits: (): ExecutionAccountingLimits => limits.current,
    productName: 'Product',
    groupLabel: (id): string => `group:${id}`,
    executionIdOf: (metadata): string | undefined =>
      metadata?.type === 'pipeline' ? metadata.pipeline.executionId : undefined,
    now: (): number => Date.UTC(2026, 9, 28),
    ...(options.wakeLock
      ? {
          wakeLock: {
            acquire: (key: string, reason: string): void => {
              wake.push(`acquire ${key} (${reason})`);
            },
            release: (key: string): void => {
              wake.push(`release ${key}`);
            },
          },
        }
      : {}),
  });
  return { accounting, limits, tables, wake };
}

describe('ExecutionAccounting admission', () => {
  it('counts leases and pending starts against the family limit', () => {
    const { accounting } = harness();
    const lease = accounting.track('pipeline', 'exec-1');
    const pending = accounting.admit('pipeline');

    let refusal: unknown;
    try {
      accounting.admit('pipeline');
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toMatchObject({
      code: 'resource-guard-blocked',
      family: 'pipeline',
      reason: 'limit',
      maxActive: 2,
    });
    expect(accounting.familyStatus().pipeline).toEqual({
      active: 1,
      pending: 1,
      maxActive: 2,
      blocked: true,
    });

    pending.release();
    pending.release();
    accounting.admit('pipeline').release();
    lease.release();
    expect(accounting.familyStatus().pipeline).toEqual({
      active: 0,
      pending: 0,
      maxActive: 2,
      blocked: false,
    });
  });

  it('admits families without a limit and lets a host lift the limit', () => {
    const { accounting, limits } = harness();
    for (let index = 0; index < 5; index += 1) accounting.admit('script');
    expect(accounting.familyStatus().script).toEqual({
      active: 0,
      pending: 5,
      maxActive: null,
      blocked: false,
    });
    limits.current = {
      ...limits.current,
      maxActive: { pipeline: null },
    };
    accounting.track('pipeline', 'a');
    accounting.track('pipeline', 'b');
    accounting.track('pipeline', 'c');
    expect(() => accounting.admit('pipeline').release()).not.toThrow();
  });

  it('refuses memory-guarded families at critical memory while the guard is on', async () => {
    const { accounting, limits, tables } = harness({ host: true });
    tables.push(table([row(ROOT, 1, 'host'), row(200, ROOT, 'node', 250)]));
    const snapshot = await accounting.sample();
    expect(snapshot.pressure.level).toBe('critical');
    expect(snapshot.memoryGuardBlocked).toBe(true);
    expect(snapshot.families.pipeline.blocked).toBe(true);

    let refusal: unknown;
    try {
      accounting.admit('pipeline');
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(ExecutionAdmissionError);
    expect(refusal).toMatchObject({ reason: 'memory', maxActive: 2 });
    expect(() => accounting.admit('terminal').release()).not.toThrow();

    limits.current = { ...limits.current, memoryGuardEnabled: false };
    expect(accounting.isMemoryGuardBlocked()).toBe(false);
    expect(() => accounting.admit('pipeline').release()).not.toThrow();
  });
});

describe('ExecutionAccounting leases', () => {
  it('releases a lease when its work succeeds, crashes or is cancelled', async () => {
    const { accounting } = harness();
    const controller = new AbortController();
    const cancelled = new Promise<void>((_resolve, reject) => {
      controller.signal.addEventListener('abort', () => {
        reject(new Error('cancelled'));
      });
    });
    accounting
      .track('script', 'succeeds')
      .releaseWhenSettled(Promise.resolve('done'));
    accounting
      .track('terminal', 'crashes')
      .releaseWhenSettled(Promise.reject(new Error('exit 139')));
    accounting.track('codeGraph', 'cancelled').releaseWhenSettled(cancelled);
    expect(accounting.familyStatus().codeGraph.active).toBe(1);

    await flush();
    expect(accounting.familyStatus().script.active).toBe(0);
    expect(accounting.familyStatus().terminal.active).toBe(0);
    expect(accounting.familyStatus().codeGraph.active).toBe(1);

    controller.abort();
    await flush();
    expect(accounting.familyStatus().codeGraph.active).toBe(0);
  });

  it('keeps work and leases when a client unsubscribes or fails', async () => {
    const { accounting, tables } = harness();
    const lease = accounting.track('pipeline', 'exec-1');
    accounting.register({
      id: 'terminal:1',
      groupId: 'terminal',
      kind: 'terminal',
      label: 'zsh',
      pid: 300,
    });
    const seen: number[] = [];
    const closeFirst = accounting.subscribe(() => {
      throw new Error('client went away mid-delivery');
    });
    const closeSecond = accounting.subscribe((snapshot) => {
      seen.push(snapshot.families.pipeline.active);
    });

    tables.push(table([row(ROOT, 1, 'host'), row(300, ROOT, 'zsh')]));
    await accounting.sample();
    closeFirst();
    closeSecond();
    tables.push(table([row(ROOT, 1, 'host'), row(300, ROOT, 'zsh')]));
    const after = await accounting.sample();

    expect(seen).toEqual([1]);
    expect(after.families.pipeline.active).toBe(1);
    expect(after.groups.map((group) => group.id)).toEqual(['terminal', 'app']);
    lease.release();
  });

  it('holds the computer awake for pipelines only, through the core policy', async () => {
    const power = createFakePlatformPowerServices();
    const policy = new WakeLockPolicy(power);
    const accounting = new ExecutionAccounting<Metadata>({
      rootPid: ROOT,
      readProcessTable: (): Promise<PlatformProcessTable> =>
        Promise.resolve({ kind: 'unavailable', reason: 'none' }),
      limits: (): ExecutionAccountingLimits => ({
        maxActive: {},
        memoryGuardEnabled: false,
        warningMemoryBytes: 1,
        criticalMemoryBytes: 2,
      }),
      productName: 'Product',
      groupLabel: (id): string => id,
      executionIdOf: (): undefined => undefined,
      wakeLock: policy,
    });

    const releaseScript = accounting.keepAwake('script', 'run-1');
    expect(policy.getState().holderCount).toBe(0);
    const releasePipeline = accounting.keepAwake('pipeline', 'exec-1');
    await flush();
    expect(policy.getState()).toEqual({
      active: true,
      enabled: true,
      holderCount: 1,
    });
    releasePipeline();
    releasePipeline();
    releaseScript();
    await flush();
    expect(policy.getState().holderCount).toBe(0);
    expect(policy.getState().active).toBe(false);
  });

  it('names the holder the way the wake-lock policy keys it', () => {
    const { accounting, wake } = harness({ wakeLock: true });
    const release = accounting.keepAwake('pipeline', 'exec-9');
    release();
    expect(wake).toEqual([
      'acquire pipeline:exec-9 (pipeline execution)',
      'release pipeline:exec-9',
    ]);
  });
});

describe('ExecutionAccounting sampling', () => {
  it('rolls pipeline steps up under their execution and classifies providers', async () => {
    const { accounting, tables } = harness({ host: true });
    accounting.register({
      id: 'pipeline-execution:e1',
      groupId: 'pipelines',
      kind: 'pipeline-execution',
      label: 'Release',
      metadata: { type: 'pipeline', pipeline: { executionId: 'e1' } },
    });
    accounting.register({
      id: 'pipeline-step:e1:a',
      groupId: 'pipelines',
      kind: 'pipeline-step',
      label: 'a',
      pid: 200,
      metadata: { type: 'pipeline', pipeline: { executionId: 'e1' } },
    });
    tables.push(
      table([
        row(ROOT, 1, 'host'),
        row(200, ROOT, 'node', 4, 3),
        row(201, 200, 'sh', 2, 1),
        row(400, ROOT, 'claude', 8, 5),
        row(401, ROOT, 'codex.exe', 1, 0),
        row(500, 1, 'unrelated', 900, 50),
      ]),
    );
    const snapshot = await accounting.sample();
    const byId = Object.fromEntries(
      snapshot.groups.map((group) => [group.id, group]),
    );

    expect(snapshot.sampledAt).toBe('2026-10-28T00:00:00.000Z');
    expect(byId.pipelines).toMatchObject({
      label: 'group:pipelines',
      memoryRssBytes: 6 * MIB,
      processCount: 2,
      cpuPercent: 4,
    });
    expect(byId.pipelines?.items).toHaveLength(1);
    expect(byId.pipelines?.items[0]).toMatchObject({
      id: 'pipeline-execution:e1',
      status: 'running',
      children: [expect.objectContaining({ id: 'pipeline-step:e1:a' })],
    });
    expect(byId.claude?.items[0]).toMatchObject({
      id: 'claude:400',
      kind: 'chat-provider',
    });
    expect(byId.codex?.items[0]).toMatchObject({ id: 'codex:401' });
    expect(byId.app?.memoryRssBytes).toBe(10 * MIB);
    expect(snapshot.memoryRssBytes).toBe((10 + 6 + 8 + 1) * MIB);
    expect(snapshot.pressure).toEqual({
      level: 'ok',
      reasons: [],
      warningMemoryBytes: 100 * MIB,
      criticalMemoryBytes: 200 * MIB,
    });
  });

  it('counts the root process from the table when the host reports no rows of its own', async () => {
    const { accounting, tables } = harness();
    tables.push(
      table([row(ROOT, 1, 'canopy-daemon', 250), row(200, ROOT, 'node', 4)]),
    );
    const snapshot = await accounting.sample();

    expect(snapshot.memoryRssBytes).toBe(254 * MIB);
    expect(snapshot.pressure.level).toBe('critical');
    expect(snapshot.memoryGuardBlocked).toBe(true);
    expect(
      snapshot.groups.find((group) => group.id === 'app')?.items[0],
    ).toMatchObject({ id: `host:${ROOT}`, label: 'canopy-daemon' });
  });

  it('leaves the root to a host that reports its own rows', async () => {
    const { accounting, tables } = harness({ host: true });
    tables.push(table([row(ROOT, 1, 'host', 250)]));
    const snapshot = await accounting.sample();

    expect(snapshot.memoryRssBytes).toBe(10 * MIB);
    expect(snapshot.groups.find((group) => group.id === 'app')?.items).toEqual([
      expect.objectContaining({ id: `host:${ROOT}`, label: 'Host main' }),
    ]);
  });

  it('reports pressure unknown without a process table and an error without host rows', async () => {
    const { accounting } = harness();
    const snapshot = await accounting.sample();
    expect(snapshot.pressure).toMatchObject({
      level: 'unknown',
      reasons: ['process-table sampling unavailable'],
    });
    expect(snapshot.error).toBe('process-table sampling unavailable');
  });

  it('joins a sample already in flight and resets on dispose', async () => {
    const { accounting, tables } = harness();
    tables.push(table([row(ROOT, 1, 'host')]));
    const [first, second] = await Promise.all([
      accounting.sample(),
      accounting.sample(),
    ]);
    expect(first).toBe(second);
    expect(first.pressure.level).toBe('ok');

    accounting.register({
      id: 'script:1',
      groupId: 'scripts',
      kind: 'script',
      label: 'test',
    });
    accounting.dispose();
    expect(accounting.getRegistration('script:1')).toBeUndefined();
    expect(accounting.getSnapshot().pressure.level).toBe('unknown');
  });

  it('updates a registration until it is unregistered', () => {
    const { accounting } = harness();
    const handle = accounting.register({
      id: 'terminal:1',
      groupId: 'terminal',
      kind: 'terminal',
      label: 'zsh',
    });
    handle.update({ label: 'bash', id: 'other' });
    expect(accounting.getRegistration('terminal:1')?.label).toBe('bash');
    handle.unregister();
    handle.update({ label: 'fish' });
    expect(accounting.getRegistration('terminal:1')).toBeUndefined();
  });
});
