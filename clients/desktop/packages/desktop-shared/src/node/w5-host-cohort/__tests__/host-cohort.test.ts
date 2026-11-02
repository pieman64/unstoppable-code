import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PlatformProcessInspection } from '@canopy/core-runtime';
import type * as Cohort from '..';

const TOKEN = '12345678-1234-4234-8234-123456789abc';
const SELF_IDENTITY = 'fixture-maintenance-self';
const SELF: PlatformProcessInspection = {
  state: 'running',
  startIdentity: SELF_IDENTITY,
};

let cohort: typeof Cohort;
let root: string;
let runtime: string;
let hosts: string;
let inspections: Map<number, PlatformProcessInspection>;
const inspect = (pid: number): Promise<PlatformProcessInspection> =>
  Promise.resolve(
    inspections.get(pid) ?? { state: 'unverifiable', reason: 'fixture' },
  );
const privateDirectory = {
  permissions: (): Promise<{ state: 'private' }> =>
    Promise.resolve({ state: 'private' }),
};
const quick = { inspect, retryDelaysMs: [1, 1] };
// POSIX modes and links; the win32 group below runs everywhere.
const posix = process.platform === 'win32' ? describe.skip : describe;

function members(): string[] {
  return existsSync(hosts)
    ? readdirSync(hosts).filter((name) => !name.startsWith('.'))
    : [];
}
function memberRecords(): unknown[] {
  return members().map((name): unknown =>
    JSON.parse(readFileSync(join(hosts, name), 'utf8')),
  );
}
function writeMember(name: string, record: object | string): void {
  mkdirSync(hosts, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(hosts, name),
    typeof record === 'string' ? record : JSON.stringify(record),
  );
}
function writeMaintenanceRecord(record: object | string): void {
  mkdirSync(runtime, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(runtime, 'w5-maintenance.json'),
    typeof record === 'string' ? record : JSON.stringify(record),
  );
}
function maintenanceRecord(): unknown {
  return JSON.parse(readFileSync(join(runtime, 'w5-maintenance.json'), 'utf8'));
}
function liveMember(pid: number): object {
  const seconds = 1_790_000_000;
  inspections.set(pid, {
    state: 'running',
    startIdentity: `darwin:v1:${pid}:${seconds}`,
  });
  return {
    version: 1,
    pid,
    startEstimateMs: seconds * 1000 + 400,
    hostKind: 'cli',
  };
}
function deadPid(): number {
  const child = spawnSync(process.execPath, [
    '-e',
    'process.stdout.write(String(process.pid))',
  ]);
  return Number(String(child.stdout));
}
function acquire(): Promise<Cohort.W5MaintenanceExclusion> {
  // The caller has verified a private runtime directory.
  mkdirSync(runtime, { recursive: true, mode: 0o700 });
  return cohort.acquireW5MaintenanceExclusion({
    dataRoot: root,
    owner: { pid: process.pid, startIdentity: SELF_IDENTITY },
    inspect,
    secureFiles: privateDirectory,
  });
}
/** Pruning runs detached after registration; wait for its last removal. */
async function pruned(name: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (existsSync(join(hosts, name)) && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 10));
}

beforeEach(() => {
  jest.resetModules();
  cohort = jest.requireActual<typeof Cohort>('..');
  root = realpathSync(mkdtempSync(join(tmpdir(), 'w5-cohort-')));
  runtime = join(root, 'runtime');
  hosts = join(runtime, 'hosts');
  inspections = new Map([[process.pid, SELF]]);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

posix('registration', () => {
  it('publishes one complete private member file per canonical root', async () => {
    await cohort.registerW5Host({ dataRoot: root, hostKind: 'cli', ...quick });
    const alias = join(mkdtempSync(join(tmpdir(), 'w5-alias-')), 'root');
    symlinkSync(root, alias);
    await cohort.registerW5Host({ dataRoot: alias, hostKind: 'cli', ...quick });
    await cohort.registerW5Host({ dataRoot: root, hostKind: 'cli', ...quick });
    const anyNumber: unknown = expect.any(Number);
    expect(memberRecords()).toEqual([
      {
        version: 1,
        pid: process.pid,
        startEstimateMs: anyNumber,
        hostKind: 'cli',
      },
    ]);
    expect(readdirSync(hosts)).toHaveLength(1);
    expect(statSync(runtime).mode & 0o777).toBe(0o700);
    expect(statSync(hosts).mode & 0o777).toBe(0o700);
    expect(statSync(join(hosts, members()[0] ?? '')).mode & 0o777).toBe(0o600);
    const [record] = memberRecords();
    const estimate: unknown =
      typeof record === 'object' && record !== null
        ? Reflect.get(record, 'startEstimateMs')
        : undefined;
    expect(
      Math.abs(Number(estimate) - (Date.now() - process.uptime() * 1000)),
    ).toBeLessThan(1000);
  });

  it('shares one member file between concurrent spellings of a root', async () => {
    const alias = join(mkdtempSync(join(tmpdir(), 'w5-alias-')), 'root');
    symlinkSync(root, alias);
    await Promise.all([
      cohort.registerW5Host({ dataRoot: root, hostKind: 'cli', ...quick }),
      cohort.registerW5Host({ dataRoot: alias, hostKind: 'cli', ...quick }),
    ]);
    expect(readdirSync(hosts)).toHaveLength(1);
    cohort.leaveW5HostCohortSync();
    expect(readdirSync(hosts)).toEqual([]);
  });

  it('creates a fresh data root and tightens an exposed runtime directory', async () => {
    const fresh = join(root, 'fresh', 'data');
    await cohort.registerW5Host({ dataRoot: fresh, hostKind: 'cli', ...quick });
    expect(readdirSync(join(fresh, 'runtime', 'hosts'))).toHaveLength(1);
    mkdirSync(runtime, { mode: 0o700 });
    chmodSync(runtime, 0o755);
    await cohort.registerW5Host({ dataRoot: root, hostKind: 'cli', ...quick });
    expect(statSync(runtime).mode & 0o777).toBe(0o700);
  });

  it.each(['symlink', 'file'] as const)(
    'refuses a runtime directory that is a %s',
    async (kind) => {
      if (kind === 'file') writeFileSync(runtime, 'not a directory');
      else {
        const target = mkdtempSync(join(tmpdir(), 'w5-runtime-target-'));
        symlinkSync(target, runtime);
      }
      await expect(
        cohort.registerW5Host({ dataRoot: root, hostKind: 'cli', ...quick }),
      ).rejects.toMatchObject({ reason: 'runtime-unavailable' });
      // Nothing is created through the link before the refusal.
      if (kind === 'symlink') expect(readdirSync(runtime)).toEqual([]);
    },
  );

  it.each([
    ['absent owner', { state: 'absent' }],
    [
      'reused owner PID',
      { state: 'running', startIdentity: 'fixture-other-start' },
    ],
  ] satisfies [string, PlatformProcessInspection][])(
    'is admitted past a record whose owner is departed (%s) and leaves it',
    async (_, owner) => {
      inspections.set(77, owner);
      const record = {
        version: 1,
        pid: 77,
        startIdentity: 'fixture-old',
        token: TOKEN,
      };
      writeMaintenanceRecord(record);
      await cohort.registerW5Host({
        dataRoot: root,
        hostKind: 'cli',
        ...quick,
      });
      expect(members()).toHaveLength(1);
      expect(maintenanceRecord()).toEqual(record);
    },
  );

  it.each([
    [
      'live owner',
      { version: 1, pid: 77, startIdentity: 'fixture-live', token: TOKEN },
    ],
    [
      'unknown owner',
      { version: 1, pid: 78, startIdentity: 'fixture-live', token: TOKEN },
    ],
    ['unreadable record', '{"version":1,"pid":77'],
    [
      'newer record',
      { version: 2, pid: 77, startIdentity: 'fixture-live', token: TOKEN },
    ],
  ] as const)(
    'backs off, then refuses with maintenance-held, for a %s',
    async (_, record) => {
      inspections.set(77, { state: 'running', startIdentity: 'fixture-live' });
      writeMaintenanceRecord(record);
      const seen: number[] = [];
      await expect(
        cohort.registerW5Host({
          dataRoot: root,
          hostKind: 'cli',
          retryDelaysMs: [1, 1],
          inspect: (pid) => {
            seen.push(members().length);
            return inspect(pid);
          },
        }),
      ).rejects.toMatchObject({ reason: 'maintenance-held' });
      // Write intent precedes every check; every attempt withdraws it.
      if (typeof record !== 'string' && record.version === 1)
        expect(seen).toEqual([1, 1, 1]);
      expect(members()).toEqual([]);
      expect(readdirSync(hosts)).toEqual([]);
      await expect(cohort.ensureW5HostMembership()).rejects.toMatchObject({
        reason: 'unregistered-writer',
      });
    },
  );

  it('is admitted once maintenance releases during the back-off', async () => {
    inspections.set(77, { state: 'running', startIdentity: 'fixture-live' });
    writeMaintenanceRecord({
      version: 1,
      pid: 77,
      startIdentity: 'fixture-live',
      token: TOKEN,
    });
    await cohort.registerW5Host({
      dataRoot: root,
      hostKind: 'cli',
      retryDelaysMs: [1, 1],
      inspect: (pid) => {
        rmSync(join(runtime, 'w5-maintenance.json'));
        return inspect(pid);
      },
    });
    expect(members()).toHaveLength(1);
  });

  it('prunes only members and staging files whose PID is gone, off the startup path', async () => {
    const dead = deadPid();
    const departed = '11111111-1111-4111-8111-111111111111.json';
    const living = '22222222-2222-4222-8222-222222222222.json';
    const unreadable = '33333333-3333-4333-8333-333333333333.json';
    const deadStaging = `.44444444-4444-4444-8444-444444444444.${dead}.tmp`;
    const liveStaging = `.55555555-5555-4555-8555-555555555555.${process.ppid}.tmp`;
    writeMember(departed, {
      version: 1,
      pid: dead,
      startEstimateMs: 1,
      hostKind: 'cli',
    });
    writeMember(living, {
      version: 1,
      pid: process.ppid,
      startEstimateMs: 1,
      hostKind: 'cli',
    });
    writeMember(unreadable, '{"version":1,');
    writeMember(deadStaging, 'partial');
    writeMember(liveStaging, 'partial');
    await cohort.registerW5Host({ dataRoot: root, hostKind: 'cli', ...quick });
    expect(readdirSync(hosts)).toContain(departed);
    // The departed member is listed after both staging files.
    await pruned(departed);
    const remaining = readdirSync(hosts);
    expect(remaining).not.toContain(departed);
    expect(remaining).not.toContain(deadStaging);
    expect(remaining).toEqual(
      expect.arrayContaining([living, unreadable, liveStaging]),
    );
    expect(remaining).toHaveLength(4);
  });

  it('leaves the cohort on a drained exit and can register again', async () => {
    await cohort.registerW5Host({ dataRoot: root, hostKind: 'cli', ...quick });
    const [first] = members();
    cohort.leaveW5HostCohortSync();
    expect(members()).toEqual([]);
    await cohort.registerW5Host({ dataRoot: root, hostKind: 'cli', ...quick });
    expect(members()).toHaveLength(1);
    expect(members()).not.toContain(first);
  });
});

posix('read-only CLI registration', () => {
  const originalDataDir = process.env.CANOPY_DATA_DIR;
  const originalNodeEnv = process.env.NODE_ENV;
  const readOnly = { ...quick, readOnlyWhenUnwritable: true };
  beforeEach(() => {
    process.env.CANOPY_DATA_DIR = root;
  });
  afterEach(() => {
    process.env.CANOPY_DATA_DIR = originalDataDir;
    process.env.NODE_ENV = originalNodeEnv;
    for (const path of [runtime, hosts])
      if (existsSync(path)) chmodSync(path, 0o700);
  });
  /** An owner-only directory this process cannot write into. */
  function lockedRuntime(): void {
    mkdirSync(runtime, { mode: 0o700 });
    chmodSync(runtime, 0o500);
  }

  it.each([
    ['runtime/hosts cannot be created', lockedRuntime, (): string => hosts],
    [
      'the member file cannot be written',
      (): void => {
        mkdirSync(hosts, { recursive: true, mode: 0o700 });
        chmodSync(hosts, 0o500);
      },
      (): string => hosts,
    ],
  ])(
    'continues read-only when %s, and refuses every shared write',
    async (_, lock, path) => {
      lock();
      await expect(
        cohort.registerW5Host({ dataRoot: root, hostKind: 'cli', ...quick }),
      ).rejects.toMatchObject({
        reason: 'runtime-unavailable',
        unwritable: { code: 'EACCES' },
      });
      await expect(
        cohort.registerW5Host({ dataRoot: root, hostKind: 'cli', ...readOnly }),
      ).resolves.toEqual({ kind: 'read-only', path: path(), code: 'EACCES' });
      // Production would register late; a read-only process never retries.
      process.env.NODE_ENV = 'production';
      for (const path of [runtime, hosts])
        if (existsSync(path)) chmodSync(path, 0o700);
      await expect(cohort.ensureW5HostMembership()).rejects.toMatchObject({
        reason: 'cohort-unavailable',
      });
      expect(members()).toEqual([]);
      await expect(acquire()).rejects.toMatchObject({ reason: 'host-active' });
    },
  );

  it.each([
    [
      'live',
      { version: 1, pid: 77, startIdentity: 'fixture-live', token: TOKEN },
    ],
    [
      'unknown',
      { version: 1, pid: 78, startIdentity: 'fixture-live', token: TOKEN },
    ],
    ['undecodable', '{"version":1,"pid":77'],
  ] as const)(
    'still refuses with maintenance-held for a %s record',
    async (_, record) => {
      inspections.set(77, { state: 'running', startIdentity: 'fixture-live' });
      writeMaintenanceRecord(record);
      chmodSync(runtime, 0o500);
      await expect(
        cohort.registerW5Host({ dataRoot: root, hostKind: 'cli', ...readOnly }),
      ).rejects.toMatchObject({ reason: 'maintenance-held' });
    },
  );

  it('continues past a departed record and refuses an unreadable one', async () => {
    inspections.set(77, { state: 'absent' });
    writeMaintenanceRecord({
      version: 1,
      pid: 77,
      startIdentity: 'fixture-old',
      token: TOKEN,
    });
    chmodSync(runtime, 0o500);
    await expect(
      cohort.registerW5Host({ dataRoot: root, hostKind: 'cli', ...readOnly }),
    ).resolves.toMatchObject({ kind: 'read-only' });
    chmodSync(join(runtime, 'w5-maintenance.json'), 0o000);
    jest.resetModules();
    cohort = jest.requireActual<typeof Cohort>('..');
    await expect(
      cohort.registerW5Host({ dataRoot: root, hostKind: 'cli', ...readOnly }),
    ).rejects.toMatchObject({ reason: 'runtime-unavailable' });
  });

  it.each(['symlink', 'file'] as const)(
    'refuses, never degrades, a runtime directory that is a %s',
    async (kind) => {
      if (kind === 'file') writeFileSync(runtime, 'not a directory');
      else
        symlinkSync(mkdtempSync(join(tmpdir(), 'w5-runtime-target-')), runtime);
      await expect(
        cohort.registerW5Host({ dataRoot: root, hostKind: 'cli', ...readOnly }),
      ).rejects.toMatchObject({ reason: 'runtime-unavailable' });
    },
  );

  describe('when nothing can be created inside the directory', () => {
    let target: string;
    beforeEach(() => {
      target = mkdtempSync(join(tmpdir(), 'w5-runtime-target-'));
      chmodSync(target, 0o500);
    });
    afterEach(() => {
      jest.restoreAllMocks();
      chmodSync(target, 0o700);
      rmSync(target, { recursive: true, force: true });
    });

    it.each([
      ['runtime is a link to it', (): void => symlinkSync(target, runtime)],
      [
        'runtime/hosts is a link to it',
        (): void => {
          mkdirSync(runtime, { mode: 0o700 });
          symlinkSync(target, hosts);
          chmodSync(runtime, 0o500);
        },
      ],
      [
        'runtime is foreign-owned',
        (): void => {
          lockedRuntime();
          // Simulated: creating another user's directory needs root.
          const uid = process.getuid?.() ?? 0;
          jest.spyOn(process, 'getuid').mockReturnValue(uid + 1);
        },
      ],
      [
        'runtime is exposed and cannot be tightened',
        (): void => {
          mkdirSync(runtime, { mode: 0o700 });
          chmodSync(runtime, 0o555);
          // Simulated: only a foreign owner or a sandbox refuses the chmod.
          jest
            .spyOn(fsPromises, 'chmod')
            .mockRejectedValue(
              Object.assign(new Error('fixture'), { code: 'EPERM' }),
            );
        },
      ],
    ])('refuses, never degrades, when %s', async (_, arrange) => {
      arrange();
      await expect(
        cohort.registerW5Host({ dataRoot: root, hostKind: 'cli', ...readOnly }),
      ).rejects.toMatchObject({ reason: 'runtime-unavailable' });
      await expect(cohort.ensureW5HostMembership()).rejects.toMatchObject({
        reason: 'unregistered-writer',
      });
    });
  });

  it('continues read-only when the data root cannot be created', async () => {
    const parent = join(root, 'locked');
    mkdirSync(parent, { mode: 0o500 });
    const fresh = join(parent, 'data');
    try {
      await expect(
        cohort.registerW5Host({
          dataRoot: fresh,
          hostKind: 'cli',
          ...readOnly,
        }),
      ).resolves.toEqual({ kind: 'read-only', path: fresh, code: 'EACCES' });
    } finally {
      chmodSync(parent, 0o700);
    }
  });
});

posix('atomic-file backstop', () => {
  const originalDataDir = process.env.CANOPY_DATA_DIR;
  const originalNodeEnv = process.env.NODE_ENV;
  beforeEach(() => {
    process.env.CANOPY_DATA_DIR = root;
  });
  afterEach(() => {
    process.env.CANOPY_DATA_DIR = originalDataDir;
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('fails an unregistered shared write under tests', async () => {
    await expect(cohort.ensureW5HostMembership()).rejects.toMatchObject({
      reason: 'unregistered-writer',
    });
    expect(members()).toEqual([]);
  });

  it('accepts a write after registration under any spelling of the root', async () => {
    const alias = join(mkdtempSync(join(tmpdir(), 'w5-alias-')), 'root');
    symlinkSync(root, alias);
    await cohort.registerW5Host({ dataRoot: alias, hostKind: 'cli', ...quick });
    await expect(cohort.ensureW5HostMembership()).resolves.toBeUndefined();
  });

  it('registers the process root late in production', async () => {
    process.env.NODE_ENV = 'production';
    await cohort.ensureW5HostMembership();
    await cohort.ensureW5HostMembership();
    expect(memberRecords()).toEqual([
      expect.objectContaining({ pid: process.pid, hostKind: 'lazy-writer' }),
    ]);
  });

  it('still refuses a late production registration under maintenance', async () => {
    process.env.NODE_ENV = 'production';
    // Unreadable, so no inspection decides: the record counts as live.
    writeMaintenanceRecord('{"version":1');
    await expect(cohort.ensureW5HostMembership()).rejects.toMatchObject({
      reason: 'maintenance-held',
    });
    expect(members()).toEqual([]);
  });
});

posix('maintenance exclusion', () => {
  it('holds with no members, names its token and releases once', async () => {
    const exclusion = await acquire();
    const anyToken: unknown = expect.stringMatching(/^[0-9a-f-]{36}$/);
    expect(maintenanceRecord()).toEqual({
      version: 1,
      pid: process.pid,
      startIdentity: 'fixture-maintenance-self',
      token: anyToken,
    });
    await expect(exclusion.isHeld()).resolves.toBe(true);
    await exclusion.release();
    await exclusion.release();
    expect(existsSync(join(runtime, 'w5-maintenance.json'))).toBe(false);
    await expect(exclusion.isHeld()).resolves.toBe(false);
  });

  it.each([
    ['live', (): object => liveMember(4242)],
    [
      'unknown',
      (): object => ({
        version: 1,
        pid: 4343,
        startEstimateMs: 1,
        hostKind: 'cli',
      }),
    ],
    ['unreadable', (): string => '{"version":1,"pid":'],
    ['newer', (): object => ({ ...liveMember(4242), version: 2 })],
  ])(
    'refuses a %s member with host-active and withdraws its record',
    async (_, make) => {
      const name = '66666666-6666-4666-8666-666666666666.json';
      writeMember(name, make());
      await expect(acquire()).rejects.toMatchObject({ reason: 'host-active' });
      expect(existsSync(join(runtime, 'w5-maintenance.json'))).toBe(false);
      expect(members()).toEqual([name]);
    },
  );

  it('refuses an unexpected entry but ignores dot-named staging files', async () => {
    writeMember('.77777777-7777-4777-8777-777777777777.123.tmp', '{"version":');
    writeMember('.DS_Store', 'metadata');
    const held = await acquire();
    await held.release();
    writeMember('notes.json', liveMember(4242));
    await expect(acquire()).rejects.toMatchObject({ reason: 'host-active' });
  });

  it.each([
    ['absent', { state: 'absent' }],
    [
      'reused PID',
      { state: 'running', startIdentity: 'darwin:v1:4242:1700000000' },
    ],
  ] satisfies [string, PlatformProcessInspection][])(
    'prunes a departed (%s) member and holds',
    async (_, inspection) => {
      writeMember(
        '88888888-8888-4888-8888-888888888888.json',
        liveMember(4242),
      );
      inspections.set(4242, inspection);
      const exclusion = await acquire();
      expect(members()).toEqual([]);
      await exclusion.release();
    },
  );

  it('refuses a member list it cannot prove private', async () => {
    writeMember('88888888-8888-4888-8888-888888888888.json', liveMember(4242));
    await expect(
      cohort.acquireW5MaintenanceExclusion({
        dataRoot: root,
        owner: { pid: process.pid, startIdentity: 'fixture-maintenance-self' },
        inspect,
        secureFiles: {
          permissions: () =>
            Promise.resolve({ state: 'insecure', reason: 'fixture ACL' }),
        },
      }),
    ).rejects.toMatchObject({ reason: 'cohort-ambiguous' });
    expect(existsSync(join(runtime, 'w5-maintenance.json'))).toBe(false);
  });

  it('replaces a departed earlier record and refuses a live or unprovable one', async () => {
    const earlier = {
      version: 1,
      pid: 77,
      startIdentity: 'fixture-old',
      token: TOKEN,
    };
    writeMaintenanceRecord(earlier);
    inspections.set(77, { state: 'absent' });
    const exclusion = await acquire();
    expect(maintenanceRecord()).not.toEqual(earlier);
    await exclusion.release();
    for (const [record, owner] of [
      [earlier, { state: 'running', startIdentity: 'fixture-old' }],
      [earlier, { state: 'unverifiable', reason: 'fixture' }],
      ['{"version":1', { state: 'absent' }],
    ] satisfies [object | string, PlatformProcessInspection][]) {
      writeMaintenanceRecord(record);
      inspections.set(77, owner);
      await expect(acquire()).rejects.toMatchObject({
        reason: 'cohort-ambiguous',
      });
      expect(readFileSync(join(runtime, 'w5-maintenance.json'), 'utf8')).toBe(
        typeof record === 'string' ? record : JSON.stringify(record),
      );
    }
  });

  it('stops validating once another token replaces the record', async () => {
    const exclusion = await acquire();
    writeMaintenanceRecord({
      version: 1,
      pid: process.pid,
      startIdentity: 'fixture-maintenance-self',
      token: TOKEN,
    });
    await expect(exclusion.isHeld()).resolves.toBe(false);
    await exclusion.release();
    expect(maintenanceRecord()).toMatchObject({ token: TOKEN });
  });

  it('keeps a maintenance process out of the cohort, and a member out of maintenance', async () => {
    const exclusion = await acquire();
    await expect(
      cohort.registerW5Host({ dataRoot: root, hostKind: 'cli', ...quick }),
    ).rejects.toMatchObject({ reason: 'maintenance-process' });
    expect(members()).toEqual([]);
    await exclusion.release();
    await cohort.registerW5Host({ dataRoot: root, hostKind: 'cli', ...quick });
    await expect(acquire()).rejects.toMatchObject({ reason: 'host-active' });
  });
});

describe('win32', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
  });
  afterEach(() => {
    if (platform) Object.defineProperty(process, 'platform', platform);
  });

  it('registers as a no-op and refuses maintenance', async () => {
    await cohort.registerW5Host({ dataRoot: root, hostKind: 'cli', ...quick });
    expect(existsSync(runtime)).toBe(false);
    await expect(cohort.ensureW5HostMembership()).resolves.toBeUndefined();
    await expect(acquire()).rejects.toMatchObject({
      reason: 'platform-unsupported',
    });
    expect(readdirSync(runtime)).toEqual([]);
  });
});
