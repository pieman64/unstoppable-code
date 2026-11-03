// Electron main's W5 host-cohort admission (CAN-3797 W11-2): startup
// registration under the canonical root, the brief retry and refusal while
// maintenance holds it, and the gate the default commit-log host waits for.
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createPlatformEndpointServices,
  hostPlatformOperatingSystem,
  hostPlatformServices,
} from '@canopy/core-platform';
import type { PlatformProcessInspection } from '@canopy/core-runtime';
import type * as HostModule from '../../w5-commit-log/commit-log-host';
import type * as AdmissionModule from '../w5-host-admission';
import type * as MaintenanceModule from '../w5-maintenance';

const MAINTENANCE_OWNER = 4_194_301;
const MAINTENANCE_IDENTITY = 'fixture-maintenance-start';
const posix = process.platform === 'win32' ? describe.skip : describe;

let admission: typeof AdmissionModule;
let base: string;
let root: string;
let link: string;
let owner: PlatformProcessInspection;
let warn: jest.SpyInstance;
const inspect = (pid: number): Promise<PlatformProcessInspection> =>
  Promise.resolve(
    pid === MAINTENANCE_OWNER
      ? owner
      : { state: 'unverifiable', reason: 'fixture' },
  );
const quick = { inspect, retryDelaysMs: [1, 1] };

function members(dataRoot = root): Record<string, unknown>[] {
  const hosts = join(dataRoot, 'runtime', 'hosts');
  if (!existsSync(hosts)) return [];
  return readdirSync(hosts)
    .filter((name) => !name.startsWith('.'))
    .map((name) => {
      const record: unknown = JSON.parse(
        readFileSync(join(hosts, name), 'utf8'),
      );
      if (typeof record !== 'object' || record === null)
        throw new Error('member record is not an object');
      return Object.fromEntries(Object.entries(record));
    });
}

function holdMaintenance(dataRoot = root): void {
  mkdirSync(join(dataRoot, 'runtime'), { recursive: true, mode: 0o700 });
  writeFileSync(
    join(dataRoot, 'runtime', 'w5-maintenance.json'),
    JSON.stringify({
      version: 1,
      pid: MAINTENANCE_OWNER,
      startIdentity: MAINTENANCE_IDENTITY,
      token: '12345678-1234-4234-8234-123456789abc',
    }),
  );
}

beforeEach(() => {
  jest.resetModules();
  admission = jest.requireActual<typeof AdmissionModule>(
    '../w5-host-admission',
  );
  // Maintenance publishes a Unix socket. macOS's long per-user tmpdir can
  // exceed its 103-byte socket limit before the injected filesystem failure.
  const tempRoot = process.platform === 'darwin' ? '/tmp' : tmpdir();
  base = realpathSync(mkdtempSync(join(tempRoot, 'w5-ha-')));
  root = join(base, 'data');
  link = join(base, 'linked-data');
  mkdirSync(root, { mode: 0o700 });
  // A junction needs no privilege on Windows.
  symlinkSync(root, link, process.platform === 'win32' ? 'junction' : 'dir');
  owner = { state: 'running', startIdentity: MAINTENANCE_IDENTITY };
  warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  warn.mockRestore();
  rmSync(base, { recursive: true, force: true });
});

posix('Electron startup admission', () => {
  it('registers once under the canonical root, as an Electron host', async () => {
    await expect(admission.admitDesktopW5Host(link, quick)).resolves.toEqual({
      kind: 'admitted',
    });
    await expect(admission.admitDesktopW5Host(link, quick)).resolves.toEqual({
      kind: 'admitted',
    });
    const startEstimateMs: unknown = expect.any(Number);
    expect(members()).toEqual([
      { version: 1, pid: process.pid, startEstimateMs, hostKind: 'electron' },
    ]);
    expect(existsSync(join(link, 'runtime', 'hosts'))).toBe(true);
  });

  it('creates a missing data root before registering', async () => {
    const fresh = join(base, 'fresh', 'data');
    await expect(admission.admitDesktopW5Host(fresh, quick)).resolves.toEqual({
      kind: 'admitted',
    });
    expect(members(fresh)).toHaveLength(1);
  });

  it('retries briefly, then refuses while maintenance holds the root', async () => {
    holdMaintenance();
    let checks = 0;
    const counted = {
      retryDelaysMs: [1, 1],
      inspect: (pid: number): Promise<PlatformProcessInspection> => {
        checks += 1;
        return inspect(pid);
      },
    };
    await expect(
      admission.admitDesktopW5Host(link, counted),
    ).resolves.toMatchObject({
      kind: 'refused',
      message: 'Data maintenance is running. Try again when it finishes.',
    });
    // One check per attempt: the first and both retries.
    expect(checks).toBe(3);
    expect(members()).toEqual([]);
    // The outcome is final for the process; later calls share it.
    owner = { state: 'absent' };
    await expect(
      admission.admitDesktopW5Host(link, quick),
    ).resolves.toMatchObject({
      kind: 'refused',
      message: 'Data maintenance is running. Try again when it finishes.',
    });
    expect(members()).toEqual([]);
  });

  it('refuses while the maintenance owner is unprovable', async () => {
    holdMaintenance();
    owner = { state: 'unverifiable', reason: 'fixture' };
    await expect(
      admission.admitDesktopW5Host(root, quick),
    ).resolves.toMatchObject({
      kind: 'refused',
      message: 'Data maintenance is running. Try again when it finishes.',
    });
    expect(members()).toEqual([]);
  });

  it('admits once the maintenance owner is proven departed', async () => {
    holdMaintenance();
    owner = { state: 'absent' };
    await expect(admission.admitDesktopW5Host(root, quick)).resolves.toEqual({
      kind: 'admitted',
    });
    expect(members()).toHaveLength(1);
    // The departed record stays until the next maintenance replaces it.
    expect(existsSync(join(root, 'runtime', 'w5-maintenance.json'))).toBe(true);
  });

  it('does not admit writers when registration fails without write access', async () => {
    if (process.getuid?.() === 0) return;
    chmodSync(root, 0o500);
    try {
      const startup = await admission.admitDesktopW5Host(root, quick);
      expect(startup).toMatchObject({
        kind: 'failed',
        error: { reason: 'runtime-unavailable' },
      });
      expect(warn).toHaveBeenCalledWith('W5 host registration failed.', {
        reason: 'runtime-unavailable',
        code: 'EACCES',
        writers: 'refused',
      });
    } finally {
      chmodSync(root, 0o700);
    }
    expect(members()).toEqual([]);
  });

  it('refuses when registration fails while a maintenance record exists', async () => {
    if (process.getuid?.() === 0) return;
    holdMaintenance();
    const record = join(root, 'runtime', 'w5-maintenance.json');
    // Unreadable: the cohort reports runtime-unavailable, not maintenance-held.
    chmodSync(record, 0o000);
    try {
      await expect(
        admission.admitDesktopW5Host(root, quick),
      ).resolves.toMatchObject({
        kind: 'refused',
        message: 'Data maintenance is running. Try again when it finishes.',
        error: {
          reason: 'maintenance-held',
          underlying: { reason: 'runtime-unavailable' },
        },
      });
    } finally {
      chmodSync(record, 0o600);
    }
    expect(members()).toEqual([]);
  });
});

posix('the default commit-log host gate', () => {
  it('refuses when startup never registered', async () => {
    await expect(admission.desktopW5HostAdmission(root)).rejects.toMatchObject({
      reason: 'unregistered-writer',
    });
    expect(members()).toEqual([]);
  });

  it('waits for startup registration that is still in flight', async () => {
    const startup = admission.admitDesktopW5Host(root, quick);
    const gate = admission.desktopW5HostAdmission(root).then(() => members());
    await expect(gate).resolves.toHaveLength(1);
    await expect(startup).resolves.toEqual({ kind: 'admitted' });
  });

  it('retries registration on each pass after a transient failure', async () => {
    const full = Object.assign(new Error('fixture: disk full'), {
      code: 'ENOSPC',
      syscall: 'open',
    });
    const writeFile = jest
      .spyOn(fs, 'writeFile')
      .mockRejectedValueOnce(full)
      .mockRejectedValueOnce(full);
    try {
      await expect(
        admission.admitDesktopW5Host(root, quick),
      ).resolves.toMatchObject({ kind: 'failed' });
      // Writers refuse until a retry registers, then admission proceeds.
      await expect(
        admission.desktopW5HostAdmission(root),
      ).rejects.toMatchObject({ reason: 'runtime-unavailable' });
      expect(members()).toEqual([]);
      await expect(admission.desktopW5HostAdmission(root)).resolves.toBe(
        undefined,
      );
      expect(members()).toEqual([
        expect.objectContaining({ pid: process.pid, hostKind: 'electron' }),
      ]);
    } finally {
      writeFile.mockRestore();
    }
  });

  it('shares a startup refusal', async () => {
    holdMaintenance();
    await admission.admitDesktopW5Host(root, quick);
    await expect(admission.desktopW5HostAdmission(root)).rejects.toMatchObject({
      reason: 'maintenance-held',
    });
  });

  it('joins another root the host writes, without a second member for its own', async () => {
    const other = join(base, 'other');
    await admission.admitDesktopW5Host(link, quick);
    await admission.desktopW5HostAdmission(root);
    await admission.desktopW5HostAdmission(other);
    expect(members()).toHaveLength(1);
    expect(members(other)).toEqual([
      expect.objectContaining({ pid: process.pid, hostKind: 'electron' }),
    ]);
  });
});

// Each failure kind that admits writers unregistered also stops maintenance
// on that same root; maintenance loads in its own module registry, like the
// separate process it runs in.
posix('registration failures maintenance cannot run beside', () => {
  async function maintenanceOutcome(): Promise<unknown> {
    let maintenance: typeof MaintenanceModule | undefined;
    let hosts: typeof HostModule | undefined;
    jest.isolateModules(() => {
      maintenance =
        jest.requireActual<typeof MaintenanceModule>('../w5-maintenance');
      hosts = jest.requireActual<typeof HostModule>(
        '../../w5-commit-log/commit-log-host',
      );
    });
    if (!maintenance || !hosts) throw new Error('maintenance did not load');
    const host = new hosts.W5CommitLogHost({
      dbPath: join(root, 'w5', 'commit-log.sqlite'),
      root: join(root, 'workspaces'),
      workerEntry: join(__dirname, '../../w5-commit-log/commit-log-worker.ts'),
    });
    const platform = hostPlatformServices(
      createPlatformEndpointServices(hostPlatformOperatingSystem()),
    );
    try {
      await maintenance.runW5Maintenance(
        { host, dataRoot: root, platform },
        { source: 'offline_maintenance', mode: 'diagnose' },
      );
      return 'diagnosed';
    } catch (error) {
      return error;
    } finally {
      expect(host.workersStarted).toBe(0);
      await host.shutdown();
    }
  }

  async function expectAdmittedUnregistered(reason: string): Promise<void> {
    await expect(admission.admitDesktopW5Host(root, quick)).resolves.toEqual({
      kind: 'unregistered',
      reason,
    });
    await expect(admission.desktopW5HostAdmission(root)).resolves.toBe(
      undefined,
    );
    expect(warn).toHaveBeenCalledWith(
      'W5 host registration failed.',
      expect.objectContaining({
        writers: `admitted unregistered (${reason})`,
      }),
    );
    expect(existsSync(join(root, 'runtime', 'w5-maintenance.json'))).toBe(
      false,
    );
  }

  it('a linked runtime folder', async () => {
    const elsewhere = join(base, 'elsewhere');
    mkdirSync(elsewhere, { mode: 0o700 });
    symlinkSync(elsewhere, join(root, 'runtime'));
    await expectAdmittedUnregistered('runtime-not-private');
    expect(readdirSync(elsewhere)).toEqual([]);
    await expect(maintenanceOutcome()).resolves.toMatchObject({
      name: 'W5MaintenanceRefusedError',
      reason: 'runtime-unavailable',
    });
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  it('a runtime folder that cannot be made private', async () => {
    mkdirSync(join(root, 'runtime'));
    chmodSync(join(root, 'runtime'), 0o755);
    const chmod = jest
      .spyOn(fs, 'chmod')
      .mockRejectedValue(
        Object.assign(new Error('fixture: not permitted'), { code: 'EPERM' }),
      );
    try {
      await expectAdmittedUnregistered('runtime-not-private');
      await expect(maintenanceOutcome()).resolves.toMatchObject({
        name: 'W5MaintenanceRefusedError',
        reason: 'runtime-unavailable',
      });
    } finally {
      chmod.mockRestore();
    }
  });

  it('a filesystem without hard links', async () => {
    const link = jest.spyOn(fs, 'link').mockRejectedValue(
      Object.assign(new Error('fixture: no hard links'), {
        code: 'ENOTSUP',
        syscall: 'link',
      }),
    );
    try {
      await expectAdmittedUnregistered('no-hard-links');
      const outcome = await maintenanceOutcome();
      // Maintenance's own exclusive publications need link() too.
      expect(outcome).toMatchObject({
        code: 'ENOTSUP',
        message: 'fixture: no hard links',
      });
      expect(members()).toEqual([]);
      expect(existsSync(join(root, 'runtime', 'w5-maintenance.json'))).toBe(
        false,
      );
      expect(existsSync(join(root, 'runtime', 'startup-claim.json'))).toBe(
        false,
      );
    } finally {
      link.mockRestore();
    }
  });
});

// Q4: registration is a no-op on Windows, where maintenance refuses instead.
(process.platform === 'win32' ? describe : describe.skip)('win32', () => {
  it('admits without a member file, and the gate opens', async () => {
    holdMaintenance();
    await expect(admission.admitDesktopW5Host(root, quick)).resolves.toEqual({
      kind: 'admitted',
    });
    await expect(admission.desktopW5HostAdmission(root)).resolves.toBe(
      undefined,
    );
    expect(existsSync(join(root, 'runtime', 'hosts'))).toBe(false);
  });
});

posix('root registration', () => {
  it('is idempotent and kept for the rest of the process', async () => {
    await admission.registerDesktopW5Root(link, quick);
    await admission.registerDesktopW5Root(root, quick);
    expect(members()).toHaveLength(1);
  });

  it('refuses maintenance-held for a held root', async () => {
    holdMaintenance();
    await expect(
      admission.registerDesktopW5Root(root, quick),
    ).resolves.toMatchObject({
      kind: 'refused',
      error: { name: 'W5HostCohortRefusedError', reason: 'maintenance-held' },
    });
  });
});
