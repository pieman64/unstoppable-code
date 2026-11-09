import { createFreshInternalRoot } from '@canopy/desktop-shared/node/internal-root-migration/fresh-start';
import { parseInternalRootMigrationOptions } from '@canopy/desktop-shared/node/internal-root-migration/operator-options';
import { defineComposedMigrationCases } from './fixtures/composed-internal-root-migration';
import {
  chmod,
  cp,
  lstat,
  lutimes,
  utimes,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  rename,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as authorityHost from '@canopy/core-platform';
import * as storageObservation from '@canopy/core-platform/storage-path-observation';
import { createServer } from 'node:net';
import {
  listW5HostPeers,
  inspectW5MaintenanceOwner,
} from '@canopy/desktop-shared/node/w5-host-cohort';
import {
  encodeMemberRecord,
  encodeMaintenanceRecord,
} from '@canopy/desktop-shared/node/w5-host-cohort/records';
import { tmpdir } from 'node:os';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import {
  createPlatformEndpointServices,
  hostPlatformServices,
} from '@canopy/core-platform';
import { DatabaseSync } from 'node:sqlite';
import { LedgerRepository } from '@canopy/desktop-shared/node/ledger';
import { dirname, join, relative, resolve } from 'node:path';
import canopy from '../../../../../../brands/canopy/brand.json';
import unstoppableCode from '../../../../../../brands/unstoppable-code/brand.json';
import {
  migrateInternalRoot,
  InternalRootMigrationRefused,
  type InternalRootRepairs,
  type InternalRootMigrationWorker,
  type InternalRootIdentity,
  type InternalRootColdRecovery,
  type InternalRootRepairContext,
} from '@canopy/core-runtime/node/internal-root-migration';
import {
  createInternalRootMigrationWorker,
  internalRootIdentity,
  readInternalRootJournal,
} from '@canopy/desktop-shared/node/internal-root-migration';
import {
  assertInternalRootColdProcesses,
  assertInternalRootColdOpenFiles,
  assertInternalRootDaemonStopped,
} from '@canopy/desktop-shared/node/internal-root-migration';
import {
  W5CommitLog,
  fingerprintW5File,
} from '@canopy/core-runtime/node/w5/commit-log';
import {
  internalRootFilesystemHost,
  createPrivateMigrationDirectory,
  migrationNodeIdentity,
} from '@canopy/desktop-shared/node/internal-root-migration/filesystem-host';
import {
  prepareRelocationGit,
  repairRelocationGit,
  relocationTransition,
  gitBacklinkText,
} from '@canopy/core-runtime/node/relocation';
import { assertInternalRootNativeDaemonStopped } from '@canopy/desktop-shared/node/internal-root-migration/native-cold';
import { createInternalRootRelocationRepairs } from '@canopy/desktop-shared/node/internal-root-migration/repairs';
import { desktopW5Durability } from '@canopy/desktop-shared/node/w5-commit-log/durability';
import { assertHostBuildStorageStartup } from '@canopy/core-platform/build-storage-startup';
import { settleInternalRootW5 } from '../internal-root-migration-maintenance';
import { W5MaintenanceRefusedError } from '../w5-maintenance';
import { diagnoseW5State } from '../w5-maintenance-diagnosis';
import type * as Workers from '../../ledger/__tests__/fixtures/tsx-worker-threads';
jest.mock('node:worker_threads', () =>
  jest
    .requireActual<
      typeof Workers
    >('../../ledger/__tests__/fixtures/tsx-worker-threads')
    .createTsxWorkerThreads(),
);
jest.setTimeout(60_000);
import {
  cloneInternalRoot,
  statIfPresent,
} from '@canopy/desktop-shared/node/internal-root-migration/filesystem';

// POSIX fixture clone only; Darwin production requires APFS clonefile.
// Windows always uses native construction instead of this seam.
async function portableClone(
  source: string,
  destination: string,
): Promise<void> {
  if (process.platform === 'win32')
    throw new Error('POSIX clone fixture cannot replace Windows construction.');
  await cp(source, destination, {
    recursive: true,
    preserveTimestamps: true,
    verbatimSymlinks: true,
    filter: async (path) => !(await lstat(path)).isSocket(),
  });
  async function times(from: string, to: string): Promise<void> {
    const stat = await lstat(from);
    if (stat.isSocket()) return;
    if (stat.isDirectory())
      for (const name of await readdir(from))
        await times(join(from, name), join(to, name));
    if (stat.isSymbolicLink())
      await lutimes(to, stat.atimeMs / 1000, stat.mtimeMs / 1000);
    else await utimes(to, stat.atimeMs / 1000, stat.mtimeMs / 1000);
  }
  await times(source, destination);
}

// C's working-root.ts refuses both nested staging and the final destination.
function assertCWorkingRoot(context: InternalRootRepairContext): void {
  expect(context.workingRoot).not.toBe(context.identity.destination);
  expect(dirname(context.workingRoot)).toBe(
    dirname(context.identity.destination),
  );
}

// Cold proof and repair policy are fixtures; Windows custody, construction,
// coordination and publication use the native B2-2 host (no clone substitute).
const windows = process.platform === 'win32';
const fileSymlinkFixture = windows ? test.skip : test;
const unixEndpointFixture = windows ? test.skip : test;
const apfsCloneFixture = windows ? test.skip : test;
describe('offline operator option admission', () => {
  test.each([
    ['--skip-migration', '--source-dir=/selected'],
    ['--skip-migration', '--apply'],
    ['--skip-migration', '--inventory'],
    ['--skip-migration', '--declare-internal'],
    ['--skip-migration', '--rebuild'],
    ['--source-dir='],
    ['--source-dir=/one', '--source-dir=/two'],
    ['--apply', '--apply'],
  ])('refuses conflicting or ambiguous options %j', (...args) => {
    expect(() =>
      parseInternalRootMigrationOptions(['--brand=canopy', ...args]),
    ).toThrow('Usage:');
  });
});
describe('offline filesystem transaction (fixture cold proof)', () => {
  let home: string;
  let temporaryHome: string;
  let identity: InternalRootIdentity;
  let worker: InternalRootMigrationWorker;
  let recover: jest.Mock<Promise<void>, [string]>;
  let repairs: InternalRootRepairs;
  const apply = { apply: true, declareInternal: true };
  let filesystemOptions: {
    ownedChildPath?: string;
    cloneTree?: typeof portableClone;
  } = windows
    ? {
        ownedChildPath: resolve(
          '.cache/native-owned-child',
          `win32-${process.arch}`,
          'core-owned-child.node',
        ),
      }
    : { cloneTree: portableClone };
  let host: ReturnType<typeof internalRootFilesystemHost>;
  function nativeRepairOptions(): {
    filesystemHost: ReturnType<typeof internalRootFilesystemHost>;
    windowsPrincipal: (() => Promise<string>) | undefined;
  } {
    return {
      filesystemHost: host,
      windowsPrincipal: windows
        ? authorityHost.windowsPrincipalObserver(
            resolve('.cache/bin/win32-x64/canopy-process-identity.exe'),
          )
        : undefined,
    };
  }
  const readFixtureJournal = (
    selected: InternalRootIdentity,
  ): ReturnType<typeof readInternalRootJournal> =>
    readInternalRootJournal(selected, host);
  // Synthetic cold callback only; custody, process identity and the W5 writer are native.
  async function fixtureW5(
    root: string,
    entry: string,
    qualification: InternalRootColdRecovery,
  ): ReturnType<typeof settleInternalRootW5> {
    return settleInternalRootW5(
      root,
      entry,
      windows
        ? { ...qualification, assertCold: qualification.assertHeld }
        : qualification,
      {
        ownedChildPath: filesystemOptions.ownedChildPath,
        windowsProcessPath: resolve(
          '.cache/bin/win32-x64/canopy-process-identity.exe',
        ),
      },
    );
  }
  async function assertPrivate(
    path: string,
    kind: 'file' | 'directory',
    mode: number,
  ): Promise<void> {
    if (windows) {
      expect(
        (
          await hostPlatformServices(
            createPlatformEndpointServices('win32'),
          ).secureFiles.permissions({
            path,
            kind,
            mode: 'owner-only',
            action: 'verify',
          })
        ).state,
      ).toBe('private');
      expect(host.windows?.inspect(path).security).toBeTruthy();
    } else expect((await lstat(path)).mode & 0o7777).toBe(mode);
  }
  let nativeBuild: string | undefined;
  beforeAll(() => {
    if (process.platform !== 'linux') return;
    nativeBuild = mkdtempSync(join(tmpdir(), 'migration-native-'));
    const ownedChildPath = join(nativeBuild, 'core-owned-child.node');
    execFileSync(
      process.execPath,
      [resolve('scripts/build-owned-child.mjs'), '--out', ownedChildPath],
      { stdio: 'pipe' },
    );
    filesystemOptions = { ...filesystemOptions, ownedChildPath };
  }, 60_000);
  afterAll(() => {
    if (nativeBuild) rmSync(nativeBuild, { recursive: true, force: true });
  });
  let environment: {
    HOME: string | undefined;
    USERPROFILE: string | undefined;
  };
  beforeEach(async () => {
    const temporary = await realpath(tmpdir());
    // Include the longest predecessor and the endpoint's temporary bind name.
    const endpoint = join(
      temporary,
      'ir-XXXXXX',
      '.unstoppable-code',
      'runtime',
      '.000000000000',
    );
    const parent =
      windows || Buffer.byteLength(endpoint) <= 103
        ? temporary
        : await realpath('/tmp');
    temporaryHome = await realpath(await mkdtemp(join(parent, 'ir-')));
    host = internalRootFilesystemHost(filesystemOptions.ownedChildPath);
    home = windows ? join(temporaryHome, 'private') : temporaryHome;
    if (windows) await createPrivateMigrationDirectory(home, host);
    environment = {
      HOME: process.env.HOME,
      USERPROFILE: process.env.USERPROFILE,
    };
    process.env.HOME = process.env.USERPROFILE = home;
    identity = internalRootIdentity(home, canopy);
    recover = jest.fn<Promise<void>, [string]>(() => Promise.resolve());
    worker = createInternalRootMigrationWorker({
      filesystemHost: host,
      ...filesystemOptions,
      recoverW5: recover,
      proveCold: () => Promise.resolve(),
    });
    repairs = {
      prepare: (): ReturnType<InternalRootRepairs['prepare']> =>
        Promise.resolve({ kind: 'ready', externalFiles: [] }),
      repair: (context): ReturnType<InternalRootRepairs['repair']> => {
        assertCWorkingRoot(context);
        return Promise.resolve({ kind: 'ok' });
      },
      verify: (context): ReturnType<InternalRootRepairs['verify']> => {
        assertCWorkingRoot(context);
        return Promise.resolve({ kind: 'ok' });
      },
      qualifyPublished: (
        context,
      ): ReturnType<InternalRootRepairs['qualifyPublished']> => {
        expect(context.workingRoot).toBe(context.identity.destination);
        return Promise.resolve({ kind: 'ok' });
      },
    };
  });
  afterEach(async () => {
    for (const [key, value] of Object.entries(environment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(temporaryHome, { recursive: true, force: true });
  });
  async function source(): Promise<void> {
    await createPrivateMigrationDirectory(identity.source, host);
    await writeFile(
      join(identity.source, 'preferences.json'),
      '{"theme":"dark"}',
      { mode: 0o600 },
    );
  }
  test.each([canopy, unstoppableCode])(
    'migrates only the explicitly selected $id source and admits its recorded publication',
    async (brand) => {
      const sourceHome = home;
      home = join(home, 'new-home');
      await createPrivateMigrationDirectory(home, host);
      process.env.HOME = process.env.USERPROFILE = home;
      const ordinary = internalRootIdentity(home, brand);
      await createPrivateMigrationDirectory(ordinary.source, host);
      await writeFile(join(ordinary.source, 'unrelated'), 'leave stable alone');
      const imports = join(sourceHome, 'imports');
      await createPrivateMigrationDirectory(imports, host);
      const selected = join(imports, 'old internal data');
      const options = parseInternalRootMigrationOptions([
        `--brand=${brand.id}`,
        '--apply',
        '--declare-internal',
        `--source-dir=${selected}`,
      ]);
      identity = internalRootIdentity(home, brand, options.sourceDirectory);
      await source();
      const before = await readFile(join(identity.source, 'preferences.json'));
      expect(
        await migrateInternalRoot(
          worker,
          identity,
          { apply: false, declareInternal: true },
          repairs,
        ),
      ).toMatchObject({
        kind: 'inventory',
        identity: { source: selected },
        journal: null,
      });
      expect(await statIfPresent(identity.coordination)).toBeNull();
      expect(await run()).toMatchObject({
        kind: 'complete',
        journal: {
          version: 7,
          identity: { source: selected },
          secureRelocation: 'complete',
        },
      });
      expect(
        await readFile(join(identity.destination, 'preferences.json')),
      ).toEqual(before);
      expect(await readFile(join(identity.source, 'preferences.json'))).toEqual(
        before,
      );
      expect(await readFile(join(ordinary.source, 'unrelated'), 'utf8')).toBe(
        'leave stable alone',
      );
      expect(startup).not.toThrow();
      const journalPath = join(identity.coordination, 'journal.json');
      const completed = await readFile(journalPath, 'utf8');
      const journal: unknown = JSON.parse(completed);
      if (
        typeof journal !== 'object' ||
        journal === null ||
        !('identity' in journal) ||
        typeof journal.identity !== 'object' ||
        journal.identity === null
      )
        throw new Error('Expected a journal with an identity');
      await writeFile(
        journalPath,
        JSON.stringify({
          ...journal,
          identity: { ...journal.identity, source: 'relative-source' },
        }),
      );
      expect(startup).toThrow('unsupported');
      await writeFile(journalPath, completed);
      // Completion binds destination, not a later retained-source observation.
      await rm(selected, { recursive: true });
      await writeFile(selected, 'unrelated replacement');
      expect(startup).not.toThrow();
      await expect(readFixtureJournal(ordinary)).rejects.toMatchObject({
        reason: 'journal-unsupported',
      });
    },
  );
  test('the default source never guesses another brand or build', async () => {
    identity = internalRootIdentity(home, unstoppableCode);
    for (const name of [
      '.canopy',
      '.canopy-internal',
      '.unstoppable-code-rc',
    ]) {
      await createPrivateMigrationDirectory(join(home, name), host);
      await writeFile(join(home, name, 'keep'), 'not selected');
    }
    await expect(run()).rejects.toMatchObject({ reason: 'source-missing' });
    expect(startup).not.toThrow();
    for (const name of ['.canopy', '.canopy-internal', '.unstoppable-code-rc'])
      expect(await readFile(join(home, name, 'keep'), 'utf8')).toBe(
        'not selected',
      );
    expect(await statIfPresent(identity.destination)).toBeNull();
  });
  test('explicit source refuses missing paths and overlapping maintenance trees', async () => {
    const ordinary = identity;
    for (const invalid of [
      '',
      'relative-source',
      home,
      ordinary.destination,
      join(ordinary.destination, 'child'),
      ordinary.coordination,
      ordinary.historicalSecure,
      `${ordinary.destination}.migration-staging`,
      join(home, '.canopy-internal-startup.json'),
    ])
      expect(() => internalRootIdentity(home, canopy, invalid)).toThrow();
    identity = internalRootIdentity(home, canopy, join(home, 'missing-custom'));
    await expect(run()).rejects.toMatchObject({ reason: 'source-missing' });
    expect(await statIfPresent(identity.destination)).toBeNull();
    expect(await statIfPresent(identity.coordination)).toBeNull();
  });
  test('explicit source refuses aliases and public roots without repairing them', async () => {
    await source();
    const original = identity.source;
    const alias = join(home, 'custom-alias');
    await symlink(original, alias, windows ? 'junction' : 'dir');
    identity = internalRootIdentity(home, canopy, alias);
    await expect(run()).rejects.toMatchObject({ reason: 'unsupported-layout' });
    expect(await statIfPresent(identity.destination)).toBeNull();
    if (!windows) {
      await chmod(original, 0o755);
      identity = internalRootIdentity(home, canopy, original);
      await expect(run()).rejects.toMatchObject({
        reason: 'unsupported-layout',
      });
      expect((await lstat(original)).mode & 0o777).toBe(0o755);
    }
  });
  test('an interrupted explicit-source transaction cannot resume with another source', async () => {
    const ordinary = identity;
    identity = internalRootIdentity(home, canopy, join(home, 'selected'));
    await source();
    const save = worker.saveJournal.bind(worker);
    worker.saveJournal = async (journal): Promise<void> => {
      await save(journal);
      throw new Error('fixture interruption');
    };
    await expect(run()).rejects.toThrow('fixture interruption');
    const before = await readFile(join(identity.coordination, 'journal.json'));
    expect(startup).toThrow('incomplete');
    expect(startup).toThrow('--source-dir');
    await expect(
      migrateInternalRoot(worker, ordinary, apply, repairs),
    ).rejects.toMatchObject({ reason: 'journal-unsupported' });
    expect(await readFile(join(identity.coordination, 'journal.json'))).toEqual(
      before,
    );
    worker.saveJournal = save;
    expect(await run()).toMatchObject({ kind: 'complete' });
    expect(startup).not.toThrow();
  });
  test('an explicit source on another volume refuses before W5 or destination creation', async () => {
    identity = internalRootIdentity(home, canopy, join(home, 'selected'));
    await source();
    const original = storageObservation.observeStoragePathSync;
    const observation = jest
      .spyOn(storageObservation, 'observeStoragePathSync')
      .mockImplementation((path) => {
        const observed = original(path);
        if (path === identity.source && observed.stat)
          Object.defineProperty(observed.stat, 'dev', {
            value: observed.stat.dev + 1,
          });
        return observed;
      });
    try {
      await expect(run()).rejects.toMatchObject({
        reason: 'unsupported-layout',
      });
      expect(recover).not.toHaveBeenCalled();
      expect(await statIfPresent(identity.destination)).toBeNull();
      expect(await statIfPresent(identity.coordination)).toBeNull();
    } finally {
      observation.mockRestore();
    }
  });
  async function freshStart(): Promise<void> {
    await createFreshInternalRoot({
      identity,
      worker,
      ownedChildPath: filesystemOptions.ownedChildPath,
      windowsPrincipal: windows
        ? authorityHost.windowsPrincipalObserver(
            resolve('.cache/bin/win32-x64/canopy-process-identity.exe'),
          )
        : undefined,
    });
  }
  function startup(): void {
    assertHostBuildStorageStartup({
      home,
      identity: { brandId: identity.brandId, build: 'internal' },
    });
  }
  it.each([canopy, unstoppableCode])(
    '$id explicit empty-internal choice never inventories the unrelated predecessor and admits subsequent writes',
    async (brand) => {
      identity = internalRootIdentity(home, brand);
      await source();
      const prior = await lstat(identity.source, { bigint: true });
      const bytes = await readFile(join(identity.source, 'preferences.json'));
      const inventory = jest
        .spyOn(worker, 'inventory')
        .mockRejectedValue(
          new Error('Fresh start must never inventory the predecessor'),
        );
      await freshStart();
      expect(inventory).not.toHaveBeenCalled();
      expect(recover).not.toHaveBeenCalled();
      expect(await readdir(identity.destination)).toEqual([]);
      expect(startup).not.toThrow();
      await writeFile(
        join(identity.destination, 'new-payload'),
        'ordinary write',
      );
      expect(startup).not.toThrow();
      expect(await readFile(join(identity.source, 'preferences.json'))).toEqual(
        bytes,
      );
      const after = await lstat(identity.source, { bigint: true });
      expect([after.dev, after.ino, after.mtimeNs, after.ctimeNs]).toEqual([
        prior.dev,
        prior.ino,
        prior.mtimeNs,
        prior.ctimeNs,
      ]);
      expect(
        await statIfPresent(join(identity.coordination, 'journal.json')),
      ).toBeNull();
      await expect(freshStart()).rejects.toMatchObject({
        reason: 'recovery-required',
      });
      inventory.mockRestore();
    },
  );
  it('empty-internal startup choice does not inspect a predecessor that is not even a directory', async () => {
    await writeFile(identity.source, 'unrelated file', { mode: 0o600 });
    await freshStart();
    expect(startup).not.toThrow();
    expect(await readFile(identity.source, 'utf8')).toBe('unrelated file');
  });
  it.each([
    'populated',
    'staging',
    'journal',
    'cold-refusal',
    'cold-under-lock',
  ] as const)(
    'fresh start refuses %s without authorizing startup',
    async (fault) => {
      await source();
      if (fault === 'populated') {
        await createPrivateMigrationDirectory(identity.destination, host);
        await writeFile(join(identity.destination, 'keep'), 'do not replace');
      }
      if (fault === 'staging')
        await createPrivateMigrationDirectory(
          worker.stagingRoot(identity),
          host,
        );
      if (fault === 'journal') {
        const release = await worker.coordinate(identity);
        await release();
        await writeFile(
          join(identity.coordination, 'journal.json'),
          '{"version":999}',
          { mode: 0o600 },
        );
      }
      const cold = jest.spyOn(worker, 'proveCold');
      if (fault === 'cold-refusal')
        cold.mockRejectedValue(new Error('cold refusal'));
      if (fault === 'cold-under-lock')
        cold
          .mockResolvedValueOnce(undefined)
          .mockRejectedValue(new Error('cold refusal'));
      await expect(freshStart()).rejects.toThrow();
      expect(
        await statIfPresent(
          join(home, `.${identity.brandId}-internal-startup.json`),
        ),
      ).toBeNull();
      if (fault === 'populated')
        expect(await readFile(join(identity.destination, 'keep'), 'utf8')).toBe(
          'do not replace',
        );
      expect(
        await readFile(join(identity.source, 'preferences.json'), 'utf8'),
      ).toBe('{"theme":"dark"}');
      cold.mockRestore();
    },
  );
  it('fresh start refuses a nonprivate destination without changing its permissions', async () => {
    await source();
    await createPrivateMigrationDirectory(identity.destination, host);
    if (windows)
      await promisify(execFile)('icacls.exe', [
        identity.destination,
        '/grant',
        '*S-1-1-0:R',
      ]);
    else await chmod(identity.destination, 0o755);
    try {
      await expect(freshStart()).rejects.toThrow();
      expect(
        await statIfPresent(
          join(home, `.${identity.brandId}-internal-startup.json`),
        ),
      ).toBeNull();
      if (!windows)
        expect((await lstat(identity.destination)).mode & 0o777).toBe(0o755);
    } finally {
      if (windows)
        await promisify(execFile)('icacls.exe', [
          identity.destination,
          '/remove:g',
          '*S-1-1-0',
        ]);
    }
  });
  it('fresh-start record publication never replaces a concurrently created choice', async () => {
    await source();
    const path = join(home, `.${identity.brandId}-internal-startup.json`);
    const proof = jest.spyOn(worker, 'proveCold');
    proof.mockResolvedValueOnce(undefined).mockImplementationOnce(async () => {
      await writeFile(path, 'retain this competing choice', { mode: 0o600 });
    });
    await expect(freshStart()).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readFile(path, 'utf8')).toBe('retain this competing choice');
    expect(await readdir(identity.destination)).toEqual([]);
    expect(startup).toThrow();
    proof.mockRestore();
  });
  it.each(['brandId', 'principal', 'publicationIdentity'] as const)(
    'fresh-start evidence refuses altered %s',
    async (field) => {
      await source();
      await freshStart();
      const path = join(home, `.${identity.brandId}-internal-startup.json`);
      const record: unknown = JSON.parse(await readFile(path, 'utf8'));
      if (typeof record !== 'object' || record === null)
        throw new Error('Expected a fresh-start record');
      await writeFile(path, JSON.stringify({ ...record, [field]: 'foreign' }));
      expect(startup).toThrow();
    },
  );
  it('fresh start refuses a completed migration without superseding its journal', async () => {
    await source();
    const completed = await run();
    expect(completed.kind).toBe('complete');
    const before = await readFile(join(identity.coordination, 'journal.json'));
    await expect(freshStart()).rejects.toMatchObject({
      reason: 'recovery-required',
    });
    expect(await readFile(join(identity.coordination, 'journal.json'))).toEqual(
      before,
    );
    expect(startup).not.toThrow();
  });
  it('fresh-start evidence cannot override interrupted migration evidence or a replaced publication', async () => {
    await source();
    await freshStart();
    await rename(identity.destination, `${identity.destination}.retained`);
    await createPrivateMigrationDirectory(identity.destination, host);
    expect(startup).toThrow();
    await rm(identity.destination, { recursive: true });
    await rename(`${identity.destination}.retained`, identity.destination);
    expect(startup).not.toThrow();
    await writeFile(
      join(identity.coordination, 'journal.json'),
      '{"version":999}',
      { mode: 0o600 },
    );
    expect(startup).toThrow();
  });
  async function run(): ReturnType<typeof migrateInternalRoot> {
    return migrateInternalRoot(worker, identity, apply, repairs);
  }

  async function expectPublishedRefusal(): Promise<void> {
    try {
      await run();
    } catch (error) {
      if (!(error instanceof InternalRootMigrationRefused)) throw error;
      expect(error.reason).toBe('repair-refused');
      expect(error.recovery).toContain('published but unqualified');
      return;
    }
    throw new Error('Expected published-root qualification to refuse.');
  }

  test.each([canopy, unstoppableCode])(
    'uses the injected Windows principal throughout $id repair admission and publication',
    async (brand) => {
      identity = internalRootIdentity(home, brand);
      await source();
      const sid = 'S-1-5-21-1-2-3-1001';
      const principal = jest.fn(() => Promise.resolve(sid));
      const getuid = jest.fn(() => undefined);
      // Exercise SID authority on the native fixture filesystem, not native Windows custody.
      const authorityObservation = jest
        .spyOn(authorityHost, 'hostLocalAuthorityObservation')
        .mockImplementation((windowsPrincipal) => ({
          platform: 'win32',
          getuid,
          windowsPrincipal,
        }));
      try {
        const context: InternalRootRepairContext = {
          identity,
          transactionId: '00000000-0000-0000-0000-000000000000',
          inventory: await worker.inventory(identity),
          workingRoot: `${identity.destination}.migration-staging`,
          externalFiles: [],
        };
        for (const windowsPrincipal of [
          undefined,
          (): Promise<string> => Promise.resolve('not-a-sid'),
          (): Promise<string> =>
            Promise.reject(new Error('TokenUser unavailable')),
        ]) {
          await expect(
            createInternalRootRelocationRepairs({
              filesystemHost: host,
              durability: desktopW5Durability,
              windowsPrincipal,
            }).prepare(context),
          ).rejects.toMatchObject({ code: 'principal_unavailable' });
          await expect(lstat(identity.destination)).rejects.toMatchObject({
            code: 'ENOENT',
          });
        }
        repairs = createInternalRootRelocationRepairs({
          filesystemHost: host,
          durability: desktopW5Durability,
          windowsPrincipal: principal,
        });
        expect(await run()).toMatchObject({ kind: 'complete' });
        expect(principal.mock.calls.length).toBeGreaterThanOrEqual(3);
        expect(getuid).not.toHaveBeenCalled();
        const recorded: unknown = JSON.parse(
          await readFile(
            join(identity.destination, 'internal-root-authority.json'),
            'utf8',
          ),
        );
        const journal = await readFixtureJournal(identity);
        if (!journal) throw new Error('Missing completed journal');
        const expected: Record<string, unknown> = {
          version: 1,
          brandId: brand.id,
          installationId: journal.transactionId,
        };
        for (const [key, root] of [
          ['from', identity.source],
          ['to', identity.destination],
        ] as const) {
          const authorityId = createHash('sha256')
            .update(
              JSON.stringify([
                'canopy.local-authority',
                1,
                brand.id,
                root,
                ['windows-sid', sid],
              ]),
            )
            .digest('hex');
          expected[key] = { authorityId, canonicalDataRoot: root };
        }
        expect(recorded).toEqual(expected);
      } finally {
        authorityObservation.mockRestore();
      }
    },
  );

  test.each([canopy, unstoppableCode])(
    'keeps $id secure conflicts pending and resumes accepted v6 pending evidence',
    async (brand) => {
      identity = internalRootIdentity(home, brand);
      await source();
      const workspace = join(identity.source, 'workspaces', 'cowork');
      const folder = join(workspace, 'home');
      await mkdir(folder, { recursive: true, mode: 0o700 });
      await writeFile(
        join(identity.source, 'workspaces', 'index.json'),
        JSON.stringify({
          version: 1,
          workspaces: [
            { id: 'cowork', name: 'Cowork', color: 'blue', type: 'cowork' },
          ],
        }),
      );
      await writeFile(
        join(workspace, 'workspace.json'),
        JSON.stringify({ version: 1, id: 'cowork', folderPath: folder }),
      );
      await mkdir(identity.historicalSecure, { mode: 0o700 });
      await writeFile(join(identity.historicalSecure, 'own'), 'opaque-own');
      repairs = createInternalRootRelocationRepairs({
        ...nativeRepairOptions(),
        durability: desktopW5Durability,
      });
      const save = worker.saveJournal.bind(worker);
      worker.saveJournal = async (journal): Promise<void> => {
        await save(journal);
        if (
          journal.phase === 'complete' &&
          journal.secureRelocation === 'pending'
        ) {
          await mkdir(join(identity.destination, 'secure-storage'), {
            mode: 0o700,
          });
          await writeFile(
            join(identity.destination, 'secure-storage', 'independent'),
            'keep',
          );
        }
      };
      await expect(run()).rejects.toMatchObject({
        reason: 'secure-relocation-conflict',
      });
      expect(
        await readFile(join(identity.historicalSecure, 'own'), 'utf8'),
      ).toBe('opaque-own');
      expect(
        await readFile(
          join(identity.destination, 'secure-storage', 'independent'),
          'utf8',
        ),
      ).toBe('keep');
      expect(() =>
        assertHostBuildStorageStartup({
          home,
          identity: { brandId: brand.id, build: 'internal' },
        }),
      ).toThrow('incomplete');
      worker.saveJournal = save;
      if (brand.id === 'unstoppable-code') {
        await expect(
          migrateInternalRoot(
            worker,
            identity,
            { ...apply, declareInternal: false },
            repairs,
          ),
        ).rejects.toMatchObject({ reason: 'ownership-required' });
      }
      await rename(
        join(identity.destination, 'secure-storage'),
        join(home, 'explicitly-preserved-secure-conflict'),
      );
      const journal = await readFixtureJournal(identity);
      if (!journal) throw new Error('Missing pending journal');
      await save({ ...journal, version: 6 });
      expect((await readFixtureJournal(identity))?.secureRelocation).toBe(
        'pending',
      );
      await expect(run()).resolves.toMatchObject({
        kind: 'complete',
        journal: { version: 7, secureRelocation: 'complete' },
      });
      expect(
        await readFile(
          join(identity.destination, 'secure-storage', 'own'),
          'utf8',
        ),
      ).toBe('opaque-own');
      expect(
        await readFile(
          join(home, 'explicitly-preserved-secure-conflict', 'independent'),
          'utf8',
        ),
      ).toBe('keep');
      expect(
        JSON.parse(
          await readFile(
            join(
              identity.destination,
              'workspaces',
              'cowork',
              'workspace.json',
            ),
            'utf8',
          ),
        ),
      ).toMatchObject({
        folderPath: join(identity.destination, 'workspaces', 'cowork', 'home'),
      });
    },
  );

  test('oversized frozen evidence never replaces the last readable journal', async () => {
    await source();
    await run();
    const journal = await readFixtureJournal(identity);
    if (!journal) throw new Error('Missing journal');
    const path = join(identity.coordination, 'journal.json');
    const before = await readFile(path, 'utf8');
    await expect(
      worker.saveJournal({
        ...journal,
        externalFiles: [`/${'x'.repeat(17 * 1024 * 1024)}`],
      }),
    ).rejects.toMatchObject({ reason: 'unsupported-layout' });
    expect(await readFile(path, 'utf8')).toBe(before);
    expect(await readFixtureJournal(identity)).toEqual(journal);
  });

  test.each([canopy, unstoppableCode])(
    'published $id operator inventory resolves canonical and symlinked HOME or refuses a missing addon without writes',
    async (brand) => {
      identity = internalRootIdentity(home, brand);
      await source();
      const before = await worker.inventory(identity);
      // The published entry uses the repository addon, not the isolated Linux build above.
      const missingAddon =
        (windows || process.platform === 'linux') &&
        !existsSync(
          resolve(
            '.cache/native-owned-child',
            `${process.platform}-${process.arch}`,
            'core-owned-child.node',
          ),
        );
      for (const linked of [false, true]) {
        const environmentHome = linked ? join(home, 'home-alias') : home;
        if (linked) await symlink(home, environmentHome, 'dir');
        const environment: NodeJS.ProcessEnv = {
          ...process.env,
          HOME: environmentHome,
          USERPROFILE: environmentHome,
        };
        delete environment.NODE_OPTIONS;
        const execute = promisify(execFile);
        const execution = execute(
          process.execPath,
          [
            '--import',
            'tsx',
            join(__dirname, '../../../../scripts/internal-root-migration.ts'),
            `--brand=${brand.id}`,
            '--inventory',
            ...(brand.id === 'unstoppable-code' ? ['--declare-internal'] : []),
          ],
          { env: environment, timeout: 45_000, maxBuffer: 8 * 1024 * 1024 },
        );
        if (missingAddon) {
          const error: unknown = await execution.then(
            () => {
              throw new Error(
                'Expected an operator process refusal, but the command succeeded.',
              );
            },
            (error: unknown) => error,
          );
          // Node's process errors can come from outside Jest's Error realm.
          if (
            typeof error !== 'object' ||
            error === null ||
            !('code' in error) ||
            !('stdout' in error) ||
            !('stderr' in error) ||
            typeof error.stderr !== 'string'
          )
            throw new Error(
              'Operator process rejection lacked code, stdout or string stderr.',
              { cause: error },
            );
          expect(error.code).toBe(1);
          expect(error.stdout).toBe('');
          expect(error.stderr).toContain(
            `${JSON.stringify({
              kind: 'refused',
              reason: 'invalid-request-or-runtime',
              recovery: 'Owned child processes are unavailable on this host.',
            })}\n`,
          );
        } else {
          const result = await execution;
          expect(JSON.parse(result.stdout)).toMatchObject({
            kind: 'inventory',
            identity,
            journal: null,
          });
        }
        expect(await worker.inventory(identity)).toEqual(before);
        if (linked) await rm(environmentHome);
      }
      expect(await readdir(home)).toEqual([`.${brand.id}`]);
    },
  );

  test.each([canopy, unstoppableCode])(
    'composes real C repairs and pre-Cut-B recovery for $id across durable staging, publication and secure interruption windows',
    async (brand) => {
      identity = internalRootIdentity(home, brand);
      await source();
      const execute = promisify(execFile);
      const git = async (cwd: string, ...args: string[]): Promise<string> =>
        (
          await execute(
            'git',
            [
              '--no-optional-locks',
              '-c',
              'core.hooksPath=/dev/null',
              '-c',
              'commit.gpgsign=false',
              ...args,
            ],
            {
              cwd,
              env: {
                ...process.env,
                HOME: home,
                USERPROFILE: home,
                GIT_CONFIG_NOSYSTEM: '1',
                GIT_CONFIG_GLOBAL: '/dev/null',
              },
            },
          )
        ).stdout;
      const repository = async (path: string): Promise<void> => {
        await mkdir(path, { recursive: true, mode: 0o700 });
        await git(path, 'init', '-b', 'main');
        await writeFile(join(path, 'tracked'), 'committed\n');
        await git(path, 'add', 'tracked');
        await git(
          path,
          '-c',
          'user.name=Fixture',
          '-c',
          'user.email=fixture@example.invalid',
          'commit',
          '-m',
          'Fixture',
        );
      };
      const managed = join(identity.source, 'repos', 'managed');
      const linked = join(
        identity.source,
        'workspaces',
        'fixture',
        'worktrees',
        'managed',
      );
      const external = join(home, 'external');
      const outside = join(home, 'outside-linked');
      const externalLinked = join(
        identity.source,
        'workspaces',
        'fixture',
        'worktrees',
        'external',
      );
      await repository(managed);
      await repository(external);
      await git(managed, 'worktree', 'add', '-b', 'feature', linked);
      await git(managed, 'worktree', 'add', '-b', 'outside', outside);
      await git(external, 'worktree', 'add', '-b', 'inside', externalLinked);
      for (const path of [managed, linked, outside, external, externalLinked]) {
        await writeFile(join(path, 'tracked'), 'dirty\n');
        await writeFile(join(path, 'untracked'), 'untracked\n');
      }
      const metadata = join(identity.source, 'workspaces', 'fixture');
      await mkdir(metadata, { recursive: true, mode: 0o700 });
      const nonW5 = new Map<string, Buffer>();
      for (const directory of [
        'archived-containers',
        'attachments',
        'chat-archives',
        'chat-journals',
        'chat-storage-manifests',
        'chat-storage-v2',
        'chats',
        'cost',
        'detected-plans',
        'lane-recovery',
        'memory',
        'notes',
        'perf-baselines',
        'script-runs',
        'summaries',
        'worktree-data',
      ]) {
        await mkdir(join(metadata, directory), { mode: 0o700 });
        nonW5.set(
          join(directory, 'opaque'),
          Buffer.from(`${directory}\0retained\n`),
        );
      }
      nonW5.set('script-actions.json', Buffer.from('{"scripts":[]}'));
      nonW5.set('sidebar-item-groups.json', Buffer.from('{"groups":[]}'));
      for (const [path, bytes] of nonW5)
        await writeFile(join(metadata, path), bytes, { mode: 0o600 });
      expect(() =>
        assertHostBuildStorageStartup({
          home,
          identity: { brandId: brand.id, build: 'internal' },
        }),
      ).toThrow('--apply');
      const index = join(identity.source, 'workspaces', 'index.json');
      const before = JSON.stringify({
        version: 1,
        workspaces: [
          { id: 'fixture', name: 'Fixture', type: 'multi-repo', color: 'blue' },
        ],
      });
      const after = before.replace('"Fixture"', '"Settled source"');
      await writeFile(index, before);
      await writeFile(
        join(metadata, 'workspace.json'),
        JSON.stringify({
          version: 1,
          id: 'fixture',
          repos: [
            { id: 'managed', repoPath: managed },
            { id: 'external', repoPath: external },
          ],
          extension: { untouched: identity.source },
        }),
      );
      await writeFile(
        join(metadata, 'worktrees.json'),
        JSON.stringify({
          version: 1,
          worktrees: [
            {
              id: 'feature',
              branchName: 'feature',
              createdAt: '2026-11-06T00:00:00.000Z',
              creation: {
                checkouts: [{ repositoryPath: managed, checkoutPath: linked }],
              },
            },
          ],
        }),
      );
      await mkdir(join(identity.source, 'w5'), { mode: 0o700 });
      const log = W5CommitLog.open(
        join(identity.source, 'w5', 'commit-log.sqlite'),
      );
      const receipt = {
        caller: 'fixture',
        operation: 'core.workspace.update',
        idempotencyKey: 'release-skip',
        fingerprint: 'frozen-source-request',
      };
      try {
        log.commit({
          operation: 'core.workspace.update',
          receipt,
          advance: [{ kind: 'workspaces' }],
          files: [
            {
              path: index,
              contents: after,
              previousFingerprint: fingerprintW5File(before),
            },
          ],
          outcome: { saved: true },
        });
      } finally {
        log.close();
      }
      await mkdir(join(identity.source, 'account-proxy-local', 'auths'), {
        recursive: true,
        mode: 0o700,
      });
      await writeFile(
        join(identity.source, 'account-proxy-local', 'auths', 'opaque'),
        'account-bytes',
      );
      await writeFile(
        join(identity.source, 'account-proxy-local', 'config.yaml'),
        'stale',
      );
      await mkdir(join(identity.historicalSecure, 'vault'), {
        recursive: true,
        mode: 0o700,
      });
      const opaque = Buffer.from([0, 255, 2, 42]);
      await writeFile(
        join(identity.historicalSecure, 'vault', 'vault.sqlite'),
        opaque,
        { mode: 0o600 },
      );
      const secureInode = (
        await lstat(join(identity.historicalSecure, 'vault', 'vault.sqlite'))
      ).ino;
      // Ordinary diagnosis retains its full artifact census; only internal-root
      // settlement scopes admission to W5's documents and log/journal evidence.
      const diagnosis = await diagnoseW5State(identity.source);
      expect(diagnosis.files).toEqual(
        expect.arrayContaining(
          [
            'archived-containers',
            'attachments',
            'chat-archives',
            'chat-journals',
            'chat-storage-manifests',
            'chat-storage-v2',
            'chats',
            'cost',
            'detected-plans',
            'lane-recovery',
            'memory',
            'notes',
            'perf-baselines',
            'script-runs',
            'summaries',
            'worktree-data',
            'worktrees',
            'script-actions.json',
            'sidebar-item-groups.json',
          ].map((name) => ({
            path: `fixture/${name}`,
            reason: 'unknown-artifact',
          })),
        ),
      );
      let settlements = 0;
      const newWorker = (): InternalRootMigrationWorker =>
        createInternalRootMigrationWorker({
          filesystemHost: host,
          ...filesystemOptions,
          proveCold: () => Promise.resolve(),
          recoverW5: async (root, qualification) => {
            settlements++;
            await fixtureW5(
              root,
              join(__dirname, '../../w5-commit-log/commit-log-worker.ts'),
              qualification,
            );
          },
        });
      worker = newWorker();
      let durabilityWrites = 0;
      repairs = createInternalRootRelocationRepairs({
        ...nativeRepairOptions(),
        durability: {
          ...desktopW5Durability,
          writeFileDurably: async (path, contents): Promise<void> => {
            durabilityWrites++;
            await desktopW5Durability.writeFileDurably(path, contents);
            throw new Error('interrupted after durable owner image');
          },
        },
      });
      const sourceOwner = await readFile(
        join(metadata, 'workspace.json'),
        'utf8',
      );
      await expect(run()).rejects.toThrow(
        'Relocation W5 decision requires recovery',
      );
      expect(durabilityWrites).toBeGreaterThan(0);
      expect(await readFixtureJournal(identity)).toMatchObject({
        phase: 'building',
        secureRelocation: 'pending',
        repairPlan: { transition: { brandId: brand.id } },
      });
      await expect(lstat(identity.destination)).rejects.toMatchObject({
        code: 'ENOENT',
      });
      expect(await readFile(join(metadata, 'workspace.json'), 'utf8')).toBe(
        sourceOwner,
      );
      expect(
        await readFile(
          join(identity.historicalSecure, 'vault', 'vault.sqlite'),
        ),
      ).toEqual(opaque);
      // Restart discards partial staging and reapplies frozen C evidence, without
      // capturing changed Git backlinks or repeating source W5 settlement.
      worker = newWorker();
      repairs = createInternalRootRelocationRepairs({
        ...nativeRepairOptions(),
        durability: desktopW5Durability,
      });
      const publish = worker.publish.bind(worker);
      worker.publish = async (journal): Promise<void> => {
        await publish(journal);
        await git(
          external,
          'symbolic-ref',
          'HEAD',
          'refs/heads/qualification-drift',
        );
      };
      await expect(run()).rejects.toThrow('published-git-state-changed');
      expect(await readFixtureJournal(identity)).toMatchObject({
        phase: 'publishing',
        secureRelocation: 'pending',
      });
      expect(() =>
        assertHostBuildStorageStartup({
          home,
          identity: { brandId: brand.id, build: 'internal' },
        }),
      ).toThrow('incomplete');
      expect(
        await readFile(
          join(identity.historicalSecure, 'vault', 'vault.sqlite'),
        ),
      ).toEqual(opaque);
      await git(external, 'symbolic-ref', 'HEAD', 'refs/heads/main');
      worker = newWorker();
      repairs = createInternalRootRelocationRepairs({
        ...nativeRepairOptions(),
        durability: desktopW5Durability,
      });
      const save = worker.saveJournal.bind(worker);
      worker.saveJournal = async (journal): Promise<void> => {
        await save(journal);
        if (
          journal.phase === 'complete' &&
          journal.secureRelocation === 'pending'
        )
          throw new Error('root complete interruption');
      };
      await expect(run()).rejects.toThrow('root complete interruption');
      expect((await readFixtureJournal(identity))?.secureRelocation).toBe(
        'pending',
      );
      for (const build of ['internal', 'stable'] as const)
        expect(() =>
          assertHostBuildStorageStartup({
            home,
            identity: { brandId: brand.id, build },
          }),
        ).toThrow('--apply');
      // The retained source is no longer authoritative, even before secure resume.
      await writeFile(
        join(identity.source, 'preferences.json'),
        'recreated old installation',
      );
      worker = newWorker();
      const move = worker.relocateSecure.bind(worker);
      worker.relocateSecure = async (journal): Promise<void> => {
        await move(journal);
        throw new Error('secure rename interruption');
      };
      await expect(run()).rejects.toThrow('secure rename interruption');
      expect((await readFixtureJournal(identity))?.secureRelocation).toBe(
        'pending',
      );
      await expect(lstat(identity.historicalSecure)).rejects.toMatchObject({
        code: 'ENOENT',
      });
      worker = newWorker();
      // A new adapter instance must reopen the plan from B's journal, not memory.
      repairs = createInternalRootRelocationRepairs({
        ...nativeRepairOptions(),
        durability: desktopW5Durability,
      });
      expect(await run()).toMatchObject({
        kind: 'complete',
        journal: { version: 7, secureRelocation: 'complete' },
      });
      expect(settlements).toBe(1);
      expect(() =>
        assertHostBuildStorageStartup({
          home,
          identity: { brandId: brand.id, build: 'internal' },
        }),
      ).not.toThrow();
      for (const [path, bytes] of nonW5) {
        expect(
          await readFile(
            join(identity.destination, 'workspaces', 'fixture', path),
          ),
        ).toEqual(bytes);
        expect(await readFile(join(metadata, path))).toEqual(bytes);
        await assertPrivate(
          join(identity.destination, 'workspaces', 'fixture', path),
          'file',
          0o600,
        );
      }
      const nested = join(
        identity.destination,
        'secure-storage',
        'vault',
        'vault.sqlite',
      );
      expect(await readFile(nested)).toEqual(opaque);
      expect((await lstat(nested)).ino).toBe(secureInode);
      expect(
        await readFile(
          join(identity.destination, 'workspaces', 'index.json'),
          'utf8',
        ),
      ).toBe(after);
      expect(
        JSON.parse(
          await readFile(
            join(
              identity.destination,
              'workspaces',
              'fixture',
              'workspace.json',
            ),
            'utf8',
          ),
        ),
      ).toMatchObject({
        repos: [
          { repoPath: join(identity.destination, 'repos', 'managed') },
          { repoPath: external },
        ],
        extension: { untouched: identity.source },
      });
      expect(
        JSON.parse(
          await readFile(
            join(
              identity.destination,
              'workspaces',
              'fixture',
              'worktrees.json',
            ),
            'utf8',
          ),
        ),
      ).toMatchObject({
        worktrees: [
          {
            creation: {
              checkouts: [
                {
                  repositoryPath: join(
                    identity.destination,
                    'repos',
                    'managed',
                  ),
                  checkoutPath: join(
                    identity.destination,
                    'workspaces',
                    'fixture',
                    'worktrees',
                    'managed',
                  ),
                },
              ],
            },
          },
        ],
      });
      for (const path of [
        join(identity.destination, 'repos', 'managed'),
        join(
          identity.destination,
          'workspaces',
          'fixture',
          'worktrees',
          'managed',
        ),
        external,
        outside,
        join(
          identity.destination,
          'workspaces',
          'fixture',
          'worktrees',
          'external',
        ),
      ]) {
        expect(
          await git(
            path,
            'status',
            '--porcelain=v1',
            '-z',
            '--untracked-files=all',
          ),
        ).toBe(' M tracked\0?? untracked\0');
      }
      expect(
        await readFile(
          join(identity.destination, 'account-proxy-local', 'auths', 'opaque'),
          'utf8',
        ),
      ).toBe('account-bytes');
      expect(
        await statIfPresent(
          join(identity.destination, 'account-proxy-local', 'config.yaml'),
        ),
      ).toBeNull();
      const movedLog = W5CommitLog.open(
        join(identity.destination, 'w5', 'commit-log.sqlite'),
      );
      try {
        expect(
          movedLog.lookupReceipt(receipt, receipt.fingerprint),
        ).toMatchObject({ status: 'replay', outcome: { saved: true } });
        expect(movedLog.listPendingCommits()).toEqual([]);
      } finally {
        movedLog.close();
      }
      await expect(
        migrateInternalRoot(
          worker,
          identity,
          { ...apply, rebuild: true },
          repairs,
        ),
      ).rejects.toMatchObject({ reason: 'source-changed' });
      // Completion stays authoritative if the predecessor is deleted/recreated.
      await rm(identity.source, { recursive: true });
      await mkdir(identity.source, { mode: 0o700 });
      await writeFile(join(identity.source, 'foreign'), 'new installation');
      expect(() =>
        assertHostBuildStorageStartup({
          home,
          identity: { brandId: brand.id, build: 'internal' },
        }),
      ).not.toThrow();
      expect(
        await readFile(join(identity.destination, 'preferences.json'), 'utf8'),
      ).toBe('{"theme":"dark"}');
    },
  );

  test.each([canopy, unstoppableCode])(
    'clones only the $id internal predecessor, preserving the source and requiring explicit rebuild',
    async (brand) => {
      identity = internalRootIdentity(home, brand);
      await source();
      await createPrivateMigrationDirectory(identity.historicalSecure, host);
      const opaque = Buffer.from([0, 255, 42, 22]);
      const readonly = join(identity.source, 'readonly-opaque');
      await writeFile(readonly, opaque);
      await chmod(readonly, 0o400);
      const readonlyBefore = await lstat(readonly);
      const nativeReadonly = host.windows?.inspect(readonly);
      await writeFile(join(identity.historicalSecure, 'opaque'), opaque);
      const before = await worker.inventory(identity);
      expect(
        await migrateInternalRoot(
          worker,
          identity,
          { ...apply, apply: false },
          repairs,
        ),
      ).toMatchObject({
        kind: 'inventory',
        internalDeclaration: true,
        inventory: { files: 2 },
        coldProof: { kind: 'ready' },
      });
      expect(await readdir(home)).toHaveLength(2); // Inventory creates neither lock nor journal.
      const result = await run();
      expect(result.kind).toBe('complete');
      expect(await readFile(readonly)).toEqual(opaque);
      expect(
        await readFile(join(identity.destination, 'readonly-opaque')),
      ).toEqual(opaque);
      if (nativeReadonly) {
        const native = host.windows;
        if (!native) throw new Error('Missing Windows filesystem');
        expect(nativeReadonly.attributes & 1).toBe(1);
        expect(native.inspect(readonly)).toEqual(nativeReadonly);
        expect(
          native.inspect(join(identity.destination, 'readonly-opaque'))
            .attributes,
        ).toBe(nativeReadonly.attributes);
      } else {
        expect((await lstat(readonly)).mode & 0o777).toBe(0o400);
        expect(
          (await lstat(join(identity.destination, 'readonly-opaque'))).mode &
            0o777,
        ).toBe(0o400);
      }
      expect((await lstat(readonly)).mtimeMs).toBe(readonlyBefore.mtimeMs);
      if (result.kind !== 'complete') throw new Error('Expected completion');
      const stableWarning = `Do not start ${brand.displayName} stable until you have checked the new installation and deleted ${identity.source}, because stable uses that folder.`;
      if (brand.id === 'unstoppable-code')
        expect(result.recovery).toContain(stableWarning);
      else
        expect(result.recovery).not.toContain(
          'because stable uses that folder',
        );
      expect(await statIfPresent(identity.source)).not.toBeNull();
      expect((await worker.inventory(identity)).sourceIdentity).toBe(
        before.sourceIdentity,
      );
      expect((await worker.inventory(identity)).fingerprint).toBe(
        before.fingerprint,
      );
      expect(
        (await worker.inventory(identity, true)).destinationIdentity,
      ).not.toBe(before.sourceIdentity);
      expect(
        await readFile(join(identity.destination, 'preferences.json'), 'utf8'),
      ).toBe('{"theme":"dark"}');
      expect(
        await readFile(join(identity.destination, 'secure-storage', 'opaque')),
      ).toEqual(opaque);
      const journal = await readFixtureJournal(identity);
      expect(journal).toMatchObject({
        phase: 'complete',
        internalDeclaration: true,
        secureRelocation: 'complete',
      });
      if (!journal) throw new Error('Missing journal');
      expect(await readdir(identity.coordination)).not.toContain(
        'recovery-tree',
      );
      await expect(run()).rejects.toMatchObject({ reason: 'already-complete' });
      await expect(
        migrateInternalRoot(
          worker,
          identity,
          { ...apply, rebuild: true },
          repairs,
        ),
      ).rejects.toMatchObject({ reason: 'recovery-required' });
      // Explicit operator recovery removes secure state from the rebuild candidate.
      await rename(
        join(identity.destination, 'secure-storage'),
        identity.historicalSecure,
      );
      await writeFile(
        join(identity.destination, 'preferences.json'),
        'new-build-change',
      );
      await expect(
        migrateInternalRoot(
          worker,
          identity,
          { ...apply, rebuild: true },
          repairs,
        ),
      ).resolves.toMatchObject({ kind: 'complete' });
      expect(
        await readFile(join(identity.destination, 'preferences.json'), 'utf8'),
      ).toBe('{"theme":"dark"}');
      expect(recover).toHaveBeenCalledTimes(1);
    },
  );

  test.each([canopy, unstoppableCode])(
    'qualifies published $id Git state, resumes refusal and rebuilds against the modeled C contract',
    async (brand) => {
      identity = internalRootIdentity(home, brand);
      await source();
      const execute = promisify(execFile);
      async function git(cwd: string, ...args: string[]): Promise<string> {
        const result = await execute(
          'git',
          [
            '--no-optional-locks',
            '-C',
            cwd,
            '-c',
            `core.hooksPath=${windows ? 'NUL' : '/dev/null'}`,
            '-c',
            'commit.gpgsign=false',
            '-c',
            'user.name=Migration fixture',
            '-c',
            'user.email=fixture@example.invalid',
            ...args,
          ],
          {
            cwd,
            env: {
              ...process.env,
              HOME: home,
              GIT_CONFIG_GLOBAL: windows ? 'NUL' : '/dev/null',
              GIT_CONFIG_NOSYSTEM: '1',
            },
          },
        );
        return result.stdout;
      }
      async function seedRepo(path: string): Promise<void> {
        await mkdir(path, { recursive: true, mode: 0o700 });
        await git(path, 'init', '-b', 'main');
        await writeFile(join(path, 'tracked.txt'), 'committed fixture\n');
        await git(path, 'add', 'tracked.txt');
        await git(path, 'commit', '-m', 'Fixture initial state');
      }
      const managed = join(identity.source, 'repos', 'managed');
      const linked = join(identity.source, 'worktrees', 'managed');
      const external = join(home, 'external');
      const externalLinked = join(identity.source, 'worktrees', 'external');
      await seedRepo(managed);
      await seedRepo(external);
      await git(managed, 'worktree', 'add', '-b', 'development', linked);
      await git(
        external,
        'worktree',
        'add',
        '-b',
        'external-development',
        externalLinked,
      );
      for (const path of [managed, linked, externalLinked]) {
        await writeFile(join(path, 'tracked.txt'), 'dirty fixture\n');
        await writeFile(join(path, 'untracked.txt'), 'untracked fixture\n');
      }
      async function observeGit(path: string): Promise<{
        path: string;
        commonDirectory: string;
        head: string;
        branch: string;
        status: string;
      }> {
        return {
          path,
          commonDirectory: resolve(
            (
              await git(
                path,
                'rev-parse',
                '--path-format=absolute',
                '--git-common-dir',
              )
            ).trimEnd(),
          ),
          head: (await git(path, 'rev-parse', 'HEAD')).trimEnd(),
          branch: (
            await git(path, 'rev-parse', '--symbolic-full-name', 'HEAD')
          ).trimEnd(),
          status: await git(
            path,
            'status',
            '--porcelain=v1',
            '-z',
            '--untracked-files=all',
          ),
        };
      }
      async function indexEvidence(paths: readonly string[]): Promise<unknown> {
        return Promise.all(
          paths.map(async (checkout) => {
            const path = (
              await git(
                checkout,
                'rev-parse',
                '--path-format=absolute',
                '--git-path',
                'index',
              )
            ).trimEnd();
            const stat = await lstat(path);
            return {
              path,
              contents: await readFile(path),
              mtimeMs: stat.mtimeMs,
              ctimeMs: stat.ctimeMs,
              siblings: await readdir(dirname(path)),
            };
          }),
        );
      }
      const readonlyGitObjects: {
        path: string;
        bytes: Buffer;
        attributes: number;
      }[] = [];
      if (host.windows) {
        const objects = join(managed, '.git', 'objects');
        for (const fanout of await readdir(objects)) {
          if (!/^[a-f0-9]{2}$/.test(fanout)) continue;
          for (const name of await readdir(join(objects, fanout))) {
            const path = join(objects, fanout, name);
            const { attributes } = host.windows.inspect(path);
            expect(attributes & 1).toBe(1);
            readonlyGitObjects.push({
              path,
              bytes: await readFile(path),
              attributes,
            });
          }
        }
        expect(readonlyGitObjects.length).toBeGreaterThan(0);
      }
      const frozenGitPlans = new Map<
        string,
        readonly Awaited<ReturnType<typeof observeGit>>[]
      >();
      const repairGitPlans = new Map<
        string,
        Awaited<ReturnType<typeof prepareRelocationGit>>
      >();
      const transition = relocationTransition({
        version: 1,
        installationId: 'fixture',
        brandId: identity.brandId,
        from: {
          authorityId: 'a'.repeat(64),
          canonicalDataRoot: identity.source,
        },
        to: {
          authorityId: 'b'.repeat(64),
          canonicalDataRoot: identity.destination,
        },
      });
      const externalBacklink = join(
        external,
        '.git',
        'worktrees',
        'external',
        'gitdir',
      );
      const externalPreimage = await readFile(externalBacklink);
      await mkdir(join(identity.source, 'ledger'), { mode: 0o700 });
      const ledger = LedgerRepository.open({
        databasePath: join(identity.source, 'ledger', 'ledger.sqlite'),
      });
      const authorityId = ledger.authorityId;
      const binding = {
        authorityId,
        container: {
          kind: 'code_worktree',
          workspaceId: 'fixture',
          worktreeId: 'managed',
        },
        containerCreatedAt: '2026-11-05T00:00:00.000Z',
        accountId: null,
      } satisfies Parameters<typeof ledger.bindScope>[0];
      try {
        ledger.bindScope(binding);
      } finally {
        ledger.close();
      }
      const ledgerPreimage = await readFile(
        join(identity.source, 'ledger', 'ledger.sqlite'),
      );
      const runtime = join(identity.source, 'runtime');
      const metadata = join(identity.source, 'workspaces', 'fixture');
      const proxy = join(identity.source, 'account-proxy-local');
      for (const path of [
        runtime,
        metadata,
        join(identity.source, 'w5'),
        join(proxy, 'auths'),
        identity.historicalSecure,
      ])
        await mkdir(path, { recursive: true, mode: 0o700 });
      await writeFile(
        join(identity.source, 'build-storage-owner.json'),
        JSON.stringify({ version: 1, brandId: brand.id, build: 'internal' }),
      );
      const index = join(identity.source, 'workspaces', 'index.json');
      const before = JSON.stringify({
        version: 1,
        workspaces: [
          {
            id: 'fixture',
            name: 'Migration fixture',
            color: 'blue',
            type: 'multi-repo',
          },
        ],
      });
      const after = before.replace(/}$/, ',"settled":true}');
      await writeFile(index, before);
      await writeFile(
        join(metadata, 'workspace.json'),
        JSON.stringify({
          version: 1,
          id: 'fixture',
          name: 'Migration fixture',
          type: 'multi-repo',
          repositories: [
            { id: 'managed', path: managed },
            { id: 'external', path: external },
          ],
        }),
      );
      await writeFile(
        join(metadata, 'worktrees.json'),
        JSON.stringify({
          version: 1,
          worktrees: [
            {
              id: 'managed',
              branchName: 'development',
              createdAt: binding.containerCreatedAt,
              path: linked,
            },
          ],
        }),
      );
      const opaque = Buffer.from([0, 255, 11, 88, 0, 42]);
      await writeFile(join(identity.historicalSecure, 'opaque-vault'), opaque, {
        mode: 0o600,
      });
      await writeFile(join(proxy, 'auths', 'opaque-account'), opaque, {
        mode: 0o600,
      });
      await writeFile(
        join(proxy, 'config.yaml'),
        `auth-dir: ${proxy}/auths\n`,
        { mode: 0o600 },
      );
      await writeFile(
        join(proxy, 'process.json'),
        '{"pid":2147483647,"state":"stopped"}',
      );
      await writeFile(
        join(runtime, 'managed-child.json'),
        '{"pid":2147483647,"state":"stopped"}',
      );
      const receipt = {
        caller: authorityId,
        operation: 'core.workspace.update',
        idempotencyKey: 'pending-source-change',
        fingerprint: 'qualified-source-parameters',
      };
      const log = W5CommitLog.open(
        join(identity.source, 'w5', 'commit-log.sqlite'),
      );
      try {
        log.commit({
          operation: 'core.workspace.update',
          receipt,
          advance: [{ kind: 'workspaces' }],
          files: [
            {
              path: index,
              contents: after,
              previousFingerprint: fingerprintW5File(before),
            },
          ],
          outcome: { saved: true },
        });
      } finally {
        log.close();
      }
      worker = createInternalRootMigrationWorker({
        ...filesystemOptions,
        recoverW5: async (root, qualification): Promise<void> => {
          expect(root).toBe(identity.source);
          expect(await statIfPresent(identity.destination)).toBeNull();
          await fixtureW5(
            root,
            join(__dirname, '../../w5-commit-log/commit-log-worker.ts'),
            qualification,
          );
          expect(await readFile(index, 'utf8')).toBe(after);
        },
        proveCold: () => Promise.resolve(),
      });
      const original = await worker.inventory(identity);
      await expect(
        migrateInternalRoot(
          worker,
          identity,
          { ...apply, apply: false },
          repairs,
        ),
      ).resolves.toMatchObject({
        kind: 'inventory',
        inventory: {
          historicalSecure: true,
          sourceIdentity: original.sourceIdentity,
        },
      });
      expect(await statIfPresent(identity.coordination)).toBeNull();
      expect(await readFile(index, 'utf8')).toBe(before);
      // Test-only qualified paths, NOT the general CAN-5785 repair implementation.
      repairs = {
        prepare: async (
          context,
        ): ReturnType<InternalRootRepairs['prepare']> => {
          // C observes an absent destination and inventories Git from the old root.
          if (await statIfPresent(identity.destination))
            return { kind: 'refused', recovery: 'existing destination' };
          const paths = [managed, linked, external, externalLinked];
          for (const checkout of paths) {
            const records = (
              await git(checkout, 'worktree', 'list', '--porcelain', '-z')
            ).split('\0\0');
            // C git.ts observe() requires this exact checkout before its
            // complete-common-repository membership check can run.
            const entry = records
              .map((record) => record.split('\0'))
              .find((fields) =>
                fields.some(
                  (field) =>
                    field.startsWith('worktree ') &&
                    resolve(field.slice(9)) === checkout,
                ),
              );
            const head = entry
              ?.find((field) => field.startsWith('HEAD '))
              ?.slice(5);
            const branch = entry?.includes('detached')
              ? 'HEAD'
              : entry?.find((field) => field.startsWith('branch '))?.slice(7);
            if (
              !head ||
              !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(head) ||
              !branch
            )
              return { kind: 'refused', recovery: 'unreadable-git-checkout' };
            for (const record of records) {
              if (record.split('\0').includes('bare')) continue;
              for (const field of record.split('\0'))
                if (
                  field.startsWith('worktree ') &&
                  !paths.includes(resolve(field.slice(9)))
                )
                  return {
                    kind: 'refused',
                    recovery: 'uninventoried-git-checkout',
                  };
            }
          }
          if (!(await readFile(externalBacklink)).equals(externalPreimage))
            return { kind: 'refused', recovery: 'changed backlink' };
          frozenGitPlans.set(
            context.transactionId,
            await Promise.all(paths.map(observeGit)),
          );
          repairGitPlans.set(
            context.transactionId,
            await prepareRelocationGit(
              (cwd, args) => git(cwd, ...args),
              paths,
              { portableFilesystem: process.platform !== 'darwin' },
            ),
          );
          return { kind: 'ready', externalFiles: [externalBacklink] };
        },
        repair: async (context): ReturnType<InternalRootRepairs['repair']> => {
          assertCWorkingRoot(context);
          const plan = repairGitPlans.get(context.transactionId);
          if (!plan)
            return {
              kind: 'refused',
              recovery: 'Missing frozen Git repair plan.',
            };
          if (host.windows) {
            for (const source of [linked, externalLinked]) {
              const sourceAttributes = host.windows.inspect(
                join(source, '.git'),
              ).attributes;
              const copiedAttributes = host.windows.inspect(
                join(
                  context.workingRoot,
                  relative(identity.source, source),
                  '.git',
                ),
              ).attributes;
              expect(sourceAttributes & 1).toBe(0);
              expect(sourceAttributes & 2).toBe(2);
              expect(copiedAttributes).toBe(sourceAttributes);
            }
          }
          // Git's hidden .git cannot be opened with CREATE_ALWAYS on Windows.
          // Exercise the real attribute-preserving repair, not a writeFile model.
          await repairRelocationGit(transition, plan, context.workingRoot);
          await writeFile(
            join(context.workingRoot, 'account-proxy-local', 'config.yaml'),
            `auth-dir: ${identity.destination}/account-proxy-local/auths\n`,
            { mode: 0o600 },
          );
          await rm(
            join(context.workingRoot, 'account-proxy-local', 'process.json'),
          );
          await rm(join(context.workingRoot, 'runtime', 'managed-child.json'));
          return { kind: 'ok' };
        },
        verify: async (context): ReturnType<InternalRootRepairs['verify']> => {
          assertCWorkingRoot(context);
          expect(await statIfPresent(identity.destination)).toBeNull();
          expect(
            await readFile(
              join(context.workingRoot, 'worktrees', 'managed', '.git'),
              'utf8',
            ),
          ).toBe(
            `gitdir: ${gitBacklinkText(identity.destination, join(identity.destination, 'repos/managed/.git/worktrees/managed'), true)}\n`,
          );
          expect(await readFile(externalBacklink, 'utf8')).toBe(
            `${gitBacklinkText(identity.destination, join(identity.destination, 'worktrees/external/.git'), true)}\n`,
          );
          return { kind: 'ok' };
        },
        qualifyPublished: async (
          context,
        ): ReturnType<InternalRootRepairs['qualifyPublished']> => {
          expect(context.workingRoot).toBe(identity.destination);
          expect(await statIfPresent(worker.stagingRoot(identity))).toBeNull();
          expect((await readFixtureJournal(identity))?.phase).toBe(
            'publishing',
          );
          const plan = frozenGitPlans.get(context.transactionId);
          if (!plan)
            return { kind: 'refused', recovery: 'Missing frozen Git plan.' };
          const project = (path: string): string =>
            path.replace(identity.source, identity.destination);
          const expected = plan.map((checkout) => ({
            ...checkout,
            path: project(checkout.path),
            commonDirectory: project(checkout.commonDirectory),
          }));
          const paths = expected.map((checkout) => checkout.path);
          const indexes = await indexEvidence(paths);
          const before = await worker.inventory(identity, true);
          const actual = await Promise.all(
            expected.map((checkout) => observeGit(checkout.path)),
          );
          expect((await worker.inventory(identity, true)).fingerprint).toBe(
            before.fingerprint,
          );
          expect(await indexEvidence(paths)).toEqual(indexes);
          return JSON.stringify(actual) === JSON.stringify(expected)
            ? { kind: 'ok' }
            : {
                kind: 'refused',
                recovery: 'Published Git state differs from the frozen plan.',
              };
        },
      };
      const verifyPublished = async (): Promise<void> => {
        const movedPaths = [managed, linked, externalLinked].map((path) =>
          path.replace(identity.source, identity.destination),
        );
        expect(
          await git(external, 'worktree', 'list', '--porcelain'),
        ).toContain(
          join(identity.destination, 'worktrees/external').replaceAll(
            '\\',
            '/',
          ),
        );
        expect(
          await git(movedPaths[0] ?? '', 'worktree', 'list', '--porcelain'),
        ).not.toContain(identity.source.replaceAll('\\', '/') + '/');
      };
      const prepare = jest.spyOn(repairs, 'prepare');
      const repair = jest.spyOn(repairs, 'repair');
      const qualify = jest.spyOn(repairs, 'qualifyPublished');
      const publish = worker.publish.bind(worker);
      const externalHeadPath = join(external, '.git', 'HEAD');
      const externalHead = await readFile(externalHeadPath);
      worker.publish = async (journal): Promise<void> => {
        await publish(journal);
        // An external checkout can drift without changing B's root/backlink seal.
        await writeFile(
          externalHeadPath,
          'ref: refs/heads/external-development\n',
        );
      };
      await expectPublishedRefusal();
      expect((await readFixtureJournal(identity))?.phase).toBe('publishing');
      expect(await statIfPresent(identity.destination)).not.toBeNull();
      expect(await statIfPresent(worker.stagingRoot(identity))).toBeNull();
      worker.publish = publish;
      await expectPublishedRefusal();
      expect((await readFixtureJournal(identity))?.phase).toBe('publishing');
      expect(qualify).toHaveBeenCalledTimes(2);
      await writeFile(externalHeadPath, externalHead);
      const result = await run();
      expect(qualify).toHaveBeenCalledTimes(3);
      expect(prepare).toHaveBeenCalledTimes(1);
      expect(repair).toHaveBeenCalledTimes(1);
      expect(result.kind).toBe('complete');
      expect(await statIfPresent(identity.source)).not.toBeNull();
      expect((await worker.inventory(identity)).sourceIdentity).toBe(
        original.sourceIdentity,
      );
      const journal = await readFixtureJournal(identity);
      if (!journal) throw new Error('Missing qualification journal');
      expect(journal).toMatchObject({
        phase: 'complete',
        secureRelocation: 'complete',
      });
      expect((await worker.inventory(identity)).fingerprint).toBe(
        journal.settledFingerprint,
      );
      expect(journal.externalFiles).toEqual([externalBacklink]);
      const preimageNames = (await readdir(identity.coordination)).filter(
        (name) => name.endsWith('.preimage'),
      );
      expect(preimageNames).toHaveLength(1);
      for (const name of preimageNames) {
        const path = join(identity.coordination, name);
        await assertPrivate(path, 'file', 0o600);
        expect(await readFile(path)).toEqual(externalPreimage);
      }
      expect(await readFile(externalBacklink)).not.toEqual(externalPreimage);
      await verifyPublished();
      for (const object of readonlyGitObjects) {
        expect(await readFile(object.path)).toEqual(object.bytes);
        expect(host.windows?.inspect(object.path).attributes).toBe(
          object.attributes,
        );
        const copied = object.path.replace(
          identity.source,
          identity.destination,
        );
        expect(await readFile(copied)).toEqual(object.bytes);
        expect(host.windows?.inspect(copied).attributes).toBe(
          object.attributes,
        );
      }
      const preparationContext = {
        identity,
        transactionId: journal.transactionId,
        inventory: journal.inventory,
        workingRoot: worker.stagingRoot(identity),
        externalFiles: journal.externalFiles,
      };
      await expect(repairs.prepare(preparationContext)).resolves.toMatchObject({
        kind: 'refused',
        recovery: 'existing destination',
      });
      const temporarilyHidden = `${identity.destination}.fixture-probe`;
      await rename(identity.destination, temporarilyHidden);
      try {
        // Removing only the destination does not repair old-root Git inventory.
        await expect(
          repairs.prepare(preparationContext),
        ).resolves.toMatchObject({
          kind: 'refused',
        });
      } finally {
        await rename(temporarilyHidden, identity.destination);
      }
      await expect(
        migrateInternalRoot(
          worker,
          identity,
          { ...apply, rebuild: true },
          repairs,
        ),
      ).rejects.toMatchObject({ reason: 'recovery-required' });
      await rename(
        join(identity.destination, 'secure-storage'),
        identity.historicalSecure,
      );
      await expect(
        migrateInternalRoot(
          worker,
          identity,
          { ...apply, rebuild: true },
          repairs,
        ),
      ).resolves.toMatchObject({ kind: 'complete' });
      expect(qualify).toHaveBeenCalledTimes(4);
      await verifyPublished();
      expect((await worker.inventory(identity)).fingerprint).toBe(
        journal.settledFingerprint,
      );
      expect(await readFile(externalBacklink, 'utf8')).toBe(
        `${gitBacklinkText(identity.destination, join(identity.destination, 'worktrees/external/.git'), true)}\n`,
      );
      expect(
        await readFile(
          join(identity.destination, 'workspaces', 'index.json'),
          'utf8',
        ),
      ).toBe(after);
      expect(
        await readFile(join(identity.destination, 'ledger', 'ledger.sqlite')),
      ).toEqual(ledgerPreimage);
      const movedLedger = LedgerRepository.open({
        databasePath: join(identity.destination, 'ledger', 'ledger.sqlite'),
      });
      try {
        expect(movedLedger.authorityId).toBe(authorityId);
        expect(movedLedger.findScope(binding)?.scope.authorityId).toBe(
          authorityId,
        );
      } finally {
        movedLedger.close();
      }
      const settled = W5CommitLog.open(
        join(identity.destination, 'w5', 'commit-log.sqlite'),
      );
      try {
        expect(settled.listPendingCommits()).toEqual([]);
        expect(
          settled.lookupReceipt(receipt, receipt.fingerprint),
        ).toMatchObject({ status: 'replay', outcome: { saved: true } });
      } finally {
        settled.close();
      }
      const historical = new DatabaseSync(
        join(identity.destination, 'w5', 'commit-log.sqlite'),
        { readOnly: true },
      );
      try {
        expect(
          historical
            .prepare(
              'SELECT path, previous_fingerprint, new_fingerprint FROM w5_commit_files',
            )
            .all(),
        ).toEqual([
          {
            path: index,
            previous_fingerprint: fingerprintW5File(before),
            new_fingerprint: fingerprintW5File(after),
          },
        ]);
      } finally {
        historical.close();
      }
      expect(
        await readFile(
          join(identity.destination, 'secure-storage', 'opaque-vault'),
        ),
      ).toEqual(opaque);
      expect(
        await statIfPresent(join(identity.destination, 'secure-storage')),
      ).not.toBeNull();
      expect(
        await readFile(
          join(
            identity.destination,
            'account-proxy-local',
            'auths',
            'opaque-account',
          ),
        ),
      ).toEqual(opaque);
      expect(
        await readFile(
          join(identity.destination, 'account-proxy-local', 'config.yaml'),
          'utf8',
        ),
      ).toContain(identity.destination);
      expect(
        await statIfPresent(
          join(identity.destination, 'account-proxy-local', 'process.json'),
        ),
      ).toBeNull();
      expect(
        await statIfPresent(
          join(identity.destination, 'runtime', 'managed-child.json'),
        ),
      ).toBeNull();
    },
  );

  test('an existing empty predecessor clones without inventing W5 state', async () => {
    await createPrivateMigrationDirectory(identity.source, host);
    const original = await worker.inventory(identity);
    await expect(run()).resolves.toMatchObject({ kind: 'complete' });
    expect(await readdir(identity.source)).toEqual([]);
    expect(await readdir(identity.destination)).toEqual([]);
    expect((await worker.inventory(identity)).fingerprint).toBe(
      original.fingerprint,
    );
  });

  test('the repository script cannot mutate before CAN-5785 is installed', async () => {
    await source();
    await expect(
      migrateInternalRoot(worker, identity, apply),
    ).rejects.toMatchObject({ reason: 'repair-unavailable' });
    expect(await readdir(home)).toEqual(['.canopy']);
  });

  test('inventory reports live writers and apply refuses them before the unavailable repair port without creating coordination', async () => {
    await source();
    const proveCold = jest.fn<Promise<void>, []>(() =>
      Promise.reject(
        new InternalRootMigrationRefused(
          'writer-active',
          'A managed child remains active.',
        ),
      ),
    );
    worker = { ...worker, proveCold };
    await expect(
      migrateInternalRoot(worker, identity, {
        apply: false,
        declareInternal: false,
      }),
    ).resolves.toMatchObject({
      kind: 'inventory',
      inventory: { files: 1 },
      coldProof: {
        kind: 'refused',
        reason: 'writer-active',
        recovery: 'A managed child remains active.',
      },
    });
    await expect(
      migrateInternalRoot(worker, identity, apply),
    ).rejects.toMatchObject({ reason: 'writer-active' });
    expect(proveCold).toHaveBeenCalledTimes(2);
    expect(await readdir(home)).toEqual(['.canopy']);
    expect(recover).not.toHaveBeenCalled();
  });

  test('requires the explicit UC declaration and rejects contradictory stable or nested secure ownership', async () => {
    identity = internalRootIdentity(home, unstoppableCode);
    await source();
    await expect(
      migrateInternalRoot(
        worker,
        identity,
        { apply: false, declareInternal: false },
        repairs,
      ),
    ).resolves.toMatchObject({ kind: 'inventory', internalDeclaration: false });
    await expect(
      migrateInternalRoot(
        worker,
        identity,
        { apply: true, declareInternal: false },
        repairs,
      ),
    ).rejects.toMatchObject({ reason: 'ownership-required' });
    await mkdir(join(identity.source, 'secure-storage'), { mode: 0o700 });
    await expect(run()).rejects.toMatchObject({ reason: 'stable-owned' });
    await rm(join(identity.source, 'secure-storage'), { recursive: true });
    await writeFile(
      join(identity.source, 'build-storage-owner.json'),
      JSON.stringify({
        version: 1,
        brandId: 'unstoppable-code',
        build: 'stable',
      }),
    );
    await expect(run()).rejects.toMatchObject({ reason: 'stable-owned' });
    expect(await statIfPresent(identity.coordination)).toBeNull();
  });

  test('a resumed UC transaction still refuses newly discovered nested secure ownership', async () => {
    identity = internalRootIdentity(home, unstoppableCode);
    await source();
    recover.mockRejectedValueOnce(new Error('interrupted source recovery'));
    await expect(run()).rejects.toThrow('interrupted source recovery');
    await mkdir(join(identity.source, 'secure-storage'), { mode: 0o700 });
    await expect(run()).rejects.toMatchObject({ reason: 'stable-owned' });
    expect(recover).toHaveBeenCalledTimes(1);
    expect(await statIfPresent(identity.destination)).toBeNull();
  });

  test('empty and secure-only sources never create a synthetic predecessor', async () => {
    await expect(run()).rejects.toMatchObject({ reason: 'source-missing' });
    await createPrivateMigrationDirectory(identity.historicalSecure, host);
    await expect(run()).rejects.toMatchObject({ reason: 'source-missing' });
    expect(await statIfPresent(identity.coordination)).toBeNull();
  });

  test('does not overwrite an independent destination or follow an alias', async () => {
    await source();
    await createPrivateMigrationDirectory(identity.destination, host);
    await expect(run()).rejects.toMatchObject({ reason: 'destination-exists' });
    await rm(identity.destination, { recursive: true });
    await symlink(
      identity.source,
      identity.destination,
      windows ? 'junction' : 'dir',
    );
    await expect(run()).rejects.toMatchObject({ reason: 'unsupported-layout' });
  });

  test.each([
    {},
    { version: 2 },
    { version: 3 },
    { version: 4 },
    { version: 5 },
    { version: 8 },
    { version: 1, phase: 'invented' },
  ])('refuses unknown journals without altering either tree', async (raw) => {
    await source();
    await createPrivateMigrationDirectory(identity.coordination, host);
    const path = join(identity.coordination, 'journal.json');
    await writeFile(path, JSON.stringify(raw), { mode: 0o600 });
    const before = await readdir(identity.coordination);
    await expect(
      migrateInternalRoot(
        worker,
        identity,
        { ...apply, apply: false },
        repairs,
      ),
    ).rejects.toMatchObject({ reason: 'journal-unsupported' });
    expect(await readdir(identity.coordination)).toEqual(before);
  });

  test('refuses an otherwise valid completed v5 journal for inventory, apply and rebuild', async () => {
    await source();
    await run();
    const journal = await readFixtureJournal(identity);
    if (!journal) throw new Error('Missing completed journal');
    const path = join(identity.coordination, 'journal.json');
    const legacy = JSON.stringify({ ...journal, version: 5 });
    await writeFile(path, legacy, { mode: 0o600 });
    const original = await worker.inventory(identity);
    const destination = await worker.inventory(identity, true);
    const prepare = jest.spyOn(repairs, 'prepare');
    const qualify = jest.spyOn(repairs, 'qualifyPublished');
    for (const options of [
      { ...apply, apply: false },
      apply,
      { ...apply, rebuild: true },
    ]) {
      await expect(
        migrateInternalRoot(worker, identity, options, repairs),
      ).rejects.toMatchObject({ reason: 'journal-unsupported' });
      expect(await readFile(path, 'utf8')).toBe(legacy);
      expect(await worker.inventory(identity)).toEqual(original);
      expect(await worker.inventory(identity, true)).toEqual(destination);
    }
    expect(prepare).not.toHaveBeenCalled();
    expect(qualify).not.toHaveBeenCalled();
  });

  test('concurrent invocations cannot share the non-moving SQLite exclusion', async () => {
    await source();
    const release = await worker.coordinate(identity);
    try {
      await expect(worker.coordinate(identity)).rejects.toMatchObject({
        reason: 'coordination-held',
      });
    } finally {
      await release();
    }
    const again = await worker.coordinate(identity);
    await again();
  });

  test('preparation cannot reuse a journal changed within the same transaction while acquiring coordination', async () => {
    await source();
    await run();
    const coordinate = worker.coordinate.bind(worker);
    const save = worker.saveJournal.bind(worker);
    worker = {
      ...worker,
      coordinate: async (
        selected,
      ): ReturnType<InternalRootMigrationWorker['coordinate']> => {
        const release = await coordinate(selected);
        try {
          const journal = await readFixtureJournal(selected);
          if (!journal) throw new Error('Missing journal');
          await save({
            ...journal,
            internalDeclaration: !journal.internalDeclaration,
          });
          return release;
        } catch (error) {
          await release();
          throw error;
        }
      },
    };
    await expect(
      migrateInternalRoot(
        worker,
        identity,
        { ...apply, rebuild: true },
        repairs,
      ),
    ).rejects.toMatchObject({ reason: 'source-changed' });
  });

  test.each([false, true])(
    'cold recovery qualification is revoked on callback exit (failure=%s), with no preferences-only worker',
    async (fail) => {
      await source();
      const qualifications: InternalRootColdRecovery[] = [];
      worker = createInternalRootMigrationWorker({
        ...filesystemOptions,
        proveCold: () => Promise.resolve(),
        recoverW5: async (root, qualification): Promise<void> => {
          qualifications.push(qualification);
          await expect(qualification.assertHeld()).resolves.toBeUndefined();
          await expect(
            fixtureW5(root, 'no-worker-needed', qualification),
          ).resolves.toBe('nothing-to-settle');
          if (fail) throw new Error('recovery interrupted');
        },
      });
      const recover = worker.recoverW5.bind(worker);
      worker.recoverW5 = async (journal): Promise<void> => {
        try {
          await recover(journal);
        } finally {
          // Still prepared and coordinated: only the recovery callback has ended.
          expect((await worker.readJournal(identity))?.phase).toBe('prepared');
          const qualification = qualifications[0];
          expect(qualification).toBeDefined();
          await expect(qualification?.assertHeld()).rejects.toMatchObject({
            reason: 'recovery-required',
          });
        }
      };
      if (fail) await expect(run()).rejects.toThrow('recovery interrupted');
      else await run();
      const qualification = qualifications[0];
      if (!qualification) throw new Error('No qualification');
      await expect(qualification.assertHeld()).rejects.toMatchObject({
        reason: 'recovery-required',
      });
      await expect(
        fixtureW5(identity.source, 'must-not-start', qualification),
      ).rejects.toMatchObject({ reason: 'recovery-required' });
      expect(await statIfPresent(join(identity.source, 'runtime'))).toBeNull();
    },
  );

  test.each(['cold-refusal', 'cold-exception', 'journal', 'recovery'])(
    'coordination closes after a held-transaction %s failure',
    async (failure) => {
      await source();
      const original = await worker.inventory(identity);
      const interrupted = new Error(`interrupted ${failure}`);
      let held = false;
      const coordinate = worker.coordinate.bind(worker);
      const saveJournal = worker.saveJournal.bind(worker);
      worker = {
        ...worker,
        coordinate: async (
          selected,
        ): ReturnType<InternalRootMigrationWorker['coordinate']> => {
          const release = await coordinate(selected);
          held = true;
          return async (): Promise<void> => {
            await release();
            held = false;
          };
        },
        proveCold: (): Promise<void> => {
          if (!held) return Promise.resolve();
          if (failure === 'cold-refusal')
            return Promise.reject(
              new InternalRootMigrationRefused(
                'cold-proof-unavailable',
                'incomplete fixture inspection',
              ),
            );
          if (failure === 'cold-exception') return Promise.reject(interrupted);
          return Promise.resolve();
        },
        saveJournal: async (journal): Promise<void> => {
          if (failure === 'journal') throw interrupted;
          await saveJournal(journal);
        },
        recoverW5: (): Promise<void> => Promise.reject(interrupted),
      };
      await expect(run()).rejects.toThrow(
        failure === 'cold-refusal'
          ? 'incomplete fixture inspection'
          : interrupted.message,
      );
      expect(held).toBe(false);
      const release = await coordinate(identity);
      await release();
      expect(
        await statIfPresent(
          join(identity.coordination, 'coordination.sqlite-journal'),
        ),
      ).toBeNull();
      expect((await worker.inventory(identity)).fingerprint).toBe(
        original.fingerprint,
      );
      expect(await statIfPresent(identity.destination)).toBeNull();
    },
  );

  test('repair verification refusal never publishes the staged destination', async () => {
    await source();
    const original = await worker.inventory(identity);
    repairs.verify = (): ReturnType<InternalRootRepairs['verify']> =>
      Promise.resolve({
        kind: 'refused',
        recovery: 'Verify projection before publication.',
      });
    await expect(run()).rejects.toMatchObject({ reason: 'repair-refused' });
    expect(await statIfPresent(identity.destination)).toBeNull();
    expect((await worker.inventory(identity)).fingerprint).toBe(
      original.fingerprint,
    );
  });

  test('explicit rebuild resumes a crash after discarding the recorded destination', async () => {
    await source();
    await run();
    const discard = worker.discardDestination.bind(worker);
    let interrupted = false;
    worker.discardDestination = async (journal): Promise<void> => {
      await discard(journal);
      if (!interrupted) {
        interrupted = true;
        throw new Error('rebuild interrupted');
      }
    };
    await expect(
      migrateInternalRoot(
        worker,
        identity,
        { ...apply, rebuild: true },
        repairs,
      ),
    ).rejects.toThrow('rebuild interrupted');
    expect((await readFixtureJournal(identity))?.phase).toBe('rebuilding');
    expect(await statIfPresent(identity.destination)).toBeNull();
    await expect(run()).resolves.toMatchObject({ kind: 'complete' });
    expect(recover).toHaveBeenCalledTimes(1);
  });

  test('rebuild never discards secure storage delivered by a later phase', async () => {
    await source();
    await run();
    const secure = join(identity.destination, 'secure-storage');
    await mkdir(secure, { mode: 0o700 });
    const opaque = Buffer.from([0, 255, 19]);
    await writeFile(join(secure, 'opaque'), opaque);
    await expect(
      migrateInternalRoot(
        worker,
        identity,
        { ...apply, rebuild: true },
        repairs,
      ),
    ).rejects.toMatchObject({ reason: 'recovery-required' });
    expect(await readFile(join(secure, 'opaque'))).toEqual(opaque);
  });

  test('rebuild refuses to discard a substituted destination', async () => {
    await source();
    await run();
    // Keep the old inode alive to avoid filesystem inode reuse in this test.
    await rename(identity.destination, join(home, 'quarantined'));
    await createPrivateMigrationDirectory(identity.destination, host);
    await writeFile(join(identity.destination, 'independent'), 'keep');
    await expect(
      migrateInternalRoot(
        worker,
        identity,
        { ...apply, rebuild: true },
        repairs,
      ),
    ).rejects.toMatchObject({ reason: 'destination-exists' });
    expect(
      await readFile(join(identity.destination, 'independent'), 'utf8'),
    ).toBe('keep');
  });

  test('cold proof refuses before journal publication', async () => {
    await source();
    worker = {
      ...worker,
      proveCold: (): Promise<void> => Promise.reject(new Error('live child')),
    };
    await expect(run()).rejects.toThrow('live child');
    expect(
      await statIfPresent(join(identity.coordination, 'journal.json')),
    ).toBeNull();
    expect(recover).not.toHaveBeenCalled();
  });

  test('recovers committed images at the original root before creating destination staging', async () => {
    await source();
    recover.mockImplementation(async (root) => {
      expect(root).toBe(identity.source);
      expect(await statIfPresent(identity.destination)).toBeNull();
      const journal = await readFixtureJournal(identity);
      expect(journal?.phase).toBe('prepared');
      expect(await statIfPresent(worker.stagingRoot(identity))).toBeNull();
      await writeFile(join(root, 'preferences.json'), '{"recovered":true}');
    });
    await run();
    expect(
      await readFile(join(identity.destination, 'preferences.json'), 'utf8'),
    ).toBe('{"recovered":true}');
  });

  test('unresolved W5 state leaves the source intact without creating a destination', async () => {
    await source();
    recover.mockRejectedValue(new Error('unresolved reservation'));
    await expect(run()).rejects.toThrow('unresolved reservation');
    expect(await statIfPresent(identity.destination)).toBeNull();
    expect((await readFixtureJournal(identity))?.phase).toBe('prepared');
    expect(
      await statIfPresent(join(identity.coordination, 'recovery-tree')),
    ).toBeNull();
  });

  test.each(['before-rename', 'after-rename', 'repair', 'publication'])(
    'resumes %s interruption by rebuilding staging or recognizing publication, never repeating settled W5',
    async (point) => {
      await source();
      const publish = worker.publish.bind(worker);
      const save = worker.saveJournal.bind(worker);
      const qualify = jest.spyOn(repairs, 'qualifyPublished');
      let failed = false;
      worker = {
        ...worker,
        publish: async (journal): Promise<void> => {
          if (point === 'before-rename' && !failed) {
            failed = true;
            throw new Error('power loss');
          }
          await publish(journal);
          if (point === 'after-rename' && !failed) {
            failed = true;
            throw new Error('power loss');
          }
        },
        saveJournal: async (journal): Promise<void> => {
          if (
            point === 'publication' &&
            journal.phase === 'complete' &&
            !failed
          ) {
            failed = true;
            throw new Error('power loss');
          }
          await save(journal);
        },
      };
      repairs.repair = (): ReturnType<InternalRootRepairs['repair']> => {
        if (point === 'repair' && !failed) {
          failed = true;
          return Promise.reject(new Error('power loss'));
        }
        return Promise.resolve({ kind: 'ok' });
      };
      await expect(run()).rejects.toThrow('power loss');
      await expect(run()).resolves.toMatchObject({ kind: 'complete' });
      expect(qualify).toHaveBeenCalledTimes(point === 'publication' ? 2 : 1);
      expect(recover).toHaveBeenCalledTimes(1);
      expect(await statIfPresent(identity.source)).not.toBeNull();
    },
  );

  test.each([false, true])(
    'completion-save interruption preserves the durable outcome (saved=%s)',
    async (saved) => {
      await source();
      const save = worker.saveJournal.bind(worker);
      const prepare = jest.spyOn(repairs, 'prepare');
      const repair = jest.spyOn(repairs, 'repair');
      const qualify = jest.spyOn(repairs, 'qualifyPublished');
      worker.saveJournal = async (journal): Promise<void> => {
        if (journal.phase === 'complete') {
          if (saved) await save(journal);
          throw new Error('completion-save power loss');
        }
        await save(journal);
      };
      await expect(run()).rejects.toThrow('completion-save power loss');
      expect((await readFixtureJournal(identity))?.phase).toBe(
        saved ? 'complete' : 'publishing',
      );
      expect(qualify).toHaveBeenCalledTimes(1);
      worker.saveJournal = save;
      // A durable root completion still has pending secure work; resume it.
      await expect(run()).resolves.toMatchObject({
        kind: 'complete',
        journal: { secureRelocation: 'complete' },
      });
      await expect(run()).rejects.toMatchObject({ reason: 'already-complete' });
      expect(qualify).toHaveBeenCalledTimes(2);
      expect(prepare).toHaveBeenCalledTimes(1);
      expect(repair).toHaveBeenCalledTimes(1);
      expect((await readFixtureJournal(identity))?.phase).toBe('complete');
      expect(recover).toHaveBeenCalledTimes(1);
    },
  );

  test('publication resume preserves a newly populated independent destination', async () => {
    await source();
    const publish = worker.publish.bind(worker);
    worker.publish = (): Promise<void> =>
      Promise.reject(new Error('interrupted before rename'));
    await expect(run()).rejects.toThrow('interrupted before rename');
    worker.publish = publish;
    await createPrivateMigrationDirectory(identity.destination, host);
    await writeFile(join(identity.destination, 'independent'), 'preserve');
    await expect(run()).rejects.toMatchObject({ reason: 'destination-exists' });
    expect(
      await readFile(join(identity.destination, 'independent'), 'utf8'),
    ).toBe('preserve');
    expect((await readFixtureJournal(identity))?.phase).toBe('publishing');
  });

  test.each(['before-rename', 'after-rename'])(
    'publication resume refuses changed sealed data (Windows readonly bit before rename) %s',
    async (point) => {
      await source();
      const publish = worker.publish.bind(worker);
      const qualify = jest.spyOn(repairs, 'qualifyPublished');
      worker.publish = async (journal): Promise<void> => {
        if (point === 'after-rename') await publish(journal);
        throw new Error('publication interrupted');
      };
      await expect(run()).rejects.toThrow('publication interrupted');
      worker.publish = publish;
      const root =
        point === 'after-rename'
          ? identity.destination
          : worker.stagingRoot(identity);
      if (windows && point === 'before-rename')
        await chmod(join(root, 'preferences.json'), 0o400);
      else await writeFile(join(root, 'preferences.json'), 'unverified change');
      await expect(run()).rejects.toMatchObject({ reason: 'source-changed' });
      expect(qualify).not.toHaveBeenCalled();
      expect((await readFixtureJournal(identity))?.phase).toBe('publishing');
      expect(
        await readFile(join(identity.source, 'preferences.json'), 'utf8'),
      ).toBe('{"theme":"dark"}');
    },
  );

  test.each(['refused', 'thrown'])(
    'published qualification %s failure remains recoverable and never completes',
    async (failure) => {
      await source();
      const attempts = jest.fn(repairs.qualifyPublished.bind(repairs));
      repairs.qualifyPublished = async (
        context,
      ): ReturnType<InternalRootRepairs['qualifyPublished']> => {
        await attempts(context);
        if (failure === 'thrown')
          throw new Error('Git qualification unavailable');
        return { kind: 'refused', recovery: 'Git qualification unavailable' };
      };
      for (let attempt = 0; attempt < 2; attempt++) {
        await expectPublishedRefusal();
        expect((await readFixtureJournal(identity))?.phase).toBe('publishing');
        expect(await statIfPresent(identity.destination)).not.toBeNull();
      }
      expect(attempts).toHaveBeenCalledTimes(2);
      repairs.qualifyPublished = attempts;
      await expect(run()).resolves.toMatchObject({ kind: 'complete' });
      expect(attempts).toHaveBeenCalledTimes(3);
      expect(recover).toHaveBeenCalledTimes(1);
    },
  );

  test.each(['before-rename', 'after-rename'])(
    'publication resume rechecks external projections and physical root %s',
    async (point) => {
      await source();
      const external = join(home, 'gitdir');
      await writeFile(external, 'original backlink');
      repairs.prepare = (): ReturnType<InternalRootRepairs['prepare']> =>
        Promise.resolve({ kind: 'ready', externalFiles: [external] });
      repairs.repair = async (): ReturnType<InternalRootRepairs['repair']> => {
        await writeFile(external, identity.destination);
        return { kind: 'ok' };
      };
      repairs.verify = async (
        context,
      ): ReturnType<InternalRootRepairs['verify']> => {
        if ((await readFile(external, 'utf8')) !== identity.destination)
          return {
            kind: 'refused',
            recovery: 'External backlink changed; retain evidence.',
          };
        expect(
          await readFile(join(context.workingRoot, 'preferences.json'), 'utf8'),
        ).toBe('{"theme":"dark"}');
        return { kind: 'ok' };
      };
      const publish = worker.publish.bind(worker);
      worker.publish = async (journal): Promise<void> => {
        if (point === 'after-rename') await publish(journal);
        throw new Error('publication interrupted');
      };
      await expect(run()).rejects.toThrow('publication interrupted');
      worker.publish = publish;
      await writeFile(external, 'independent backlink');
      await expect(run()).rejects.toMatchObject({
        reason:
          point === 'after-rename' ? 'recovery-required' : 'repair-refused',
      });
      expect(await readFile(external, 'utf8')).toBe('independent backlink');
      await writeFile(external, identity.destination);
      await expect(run()).resolves.toMatchObject({ kind: 'complete' });
      expect(recover).toHaveBeenCalledTimes(1);
    },
  );

  test('rebuild resumes deletion privately without exposing a half-deleted destination', async () => {
    await source();
    await run();
    const discard = worker.discardDestination.bind(worker);
    worker.discardDestination = async (): Promise<void> => {
      const discarded = join(identity.coordination, 'discarding');
      await rename(identity.destination, discarded);
      await rm(join(discarded, 'preferences.json'));
      throw new Error('interrupted deletion');
    };
    await expect(
      migrateInternalRoot(
        worker,
        identity,
        { ...apply, rebuild: true },
        repairs,
      ),
    ).rejects.toThrow('interrupted deletion');
    expect(await statIfPresent(identity.destination)).toBeNull();
    expect((await readFixtureJournal(identity))?.phase).toBe('rebuilding');
    worker.discardDestination = discard;
    await expect(run()).resolves.toMatchObject({ kind: 'complete' });
    expect(
      await statIfPresent(join(identity.coordination, 'discarding')),
    ).toBeNull();
    expect(
      await readFile(join(identity.destination, 'preferences.json'), 'utf8'),
    ).toBe('{"theme":"dark"}');
  });

  // Windows file symlinks require developer mode/SeCreateSymbolicLinkPrivilege;
  // directory reparse refusal executes below using an unprivileged junction.
  fileSymlinkFixture.each(['', '-wal', '-shm', '-journal'])(
    'POSIX file-symlink W5 sidecar %s refuses before worker admission (Windows needs symlink privilege)',
    async (suffix) => {
      await source();
      await mkdir(join(identity.source, 'w5'), { mode: 0o700 });
      const outside = join(home, 'outside.sqlite');
      await writeFile(outside, 'external log must not be opened');
      await symlink(
        outside,
        join(identity.source, 'w5', `commit-log.sqlite${suffix}`),
      );
      worker = createInternalRootMigrationWorker({
        ...filesystemOptions,
        proveCold: () => Promise.resolve(),
        recoverW5: async (root, qualification): Promise<void> => {
          await fixtureW5(root, 'missing-worker', qualification);
        },
      });
      await expect(run()).rejects.toThrow(
        'Aliased or unsupported W5 log/SQLite sidecar',
      );
      expect(await readFile(outside, 'utf8')).toBe(
        'external log must not be opened',
      );
      expect(await statIfPresent(identity.destination)).toBeNull();
      expect((await readFixtureJournal(identity))?.phase).toBe('prepared');
    },
  );

  test('rebuild never adopts a recreated predecessor', async () => {
    await source();
    await run();
    await rm(identity.source, { recursive: true });
    await source();
    await expect(
      migrateInternalRoot(
        worker,
        identity,
        { ...apply, rebuild: true },
        repairs,
      ),
    ).rejects.toMatchObject({ reason: 'source-changed' });
    expect(
      await readFile(join(identity.source, 'preferences.json'), 'utf8'),
    ).toBe('{"theme":"dark"}');
  });

  test('rebuild refuses a changed source and preserves the completed destination', async () => {
    await source();
    await run();
    const destination = await migrationNodeIdentity(
      identity.destination,
      await lstat(identity.destination),
    );
    await writeFile(
      join(identity.source, 'preferences.json'),
      'changed source',
    );
    await expect(
      migrateInternalRoot(
        worker,
        identity,
        { ...apply, rebuild: true },
        repairs,
      ),
    ).rejects.toMatchObject({ reason: 'source-changed' });
    expect(
      await migrationNodeIdentity(
        identity.destination,
        await lstat(identity.destination),
      ),
    ).toBe(destination);
  });

  test('insecure or aliased roots require manual qualification', async () => {
    await source();
    if (windows) {
      await promisify(execFile)('icacls.exe', [
        identity.source,
        '/grant',
        '*S-1-1-0:R',
      ]);
      try {
        await expect(run()).rejects.toThrow('private-dacl');
      } finally {
        await promisify(execFile)('icacls.exe', [
          identity.source,
          '/remove:g',
          '*S-1-1-0',
        ]);
      }
    } else {
      await chmod(identity.source, 0o755);
      await expect(run()).rejects.toMatchObject({
        reason: 'unsupported-layout',
      });
    }
  });

  const coldFailure = new Error('Native proof-start budget exhausted: fixture');
  const directoryFailure = {
    message: 'Directory flush failed: denied\n\u001b[31m',
    code: 'EACCES',
    stage: 'flush',
  };
  const typedFailure = new InternalRootMigrationRefused(
    'writer-active',
    'Fixture writer remains; stop it before recovery.',
  );
  test.each([
    {
      timing: 'before-claim',
      failure: coldFailure,
      detail: coldFailure.message,
    },
    {
      timing: 'published-record',
      failure: coldFailure,
      detail: coldFailure.message,
    },
    {
      timing: 'before-claim',
      failure: directoryFailure,
      detail: 'Directory flush failed: denied [31m (code EACCES, stage flush)',
    },
    {
      timing: 'before-claim',
      failure: new W5MaintenanceRefusedError(
        'release-uncertain',
        directoryFailure,
      ),
      detail:
        'W5 source maintenance refused (release-uncertain): Directory flush failed: denied [31m (code EACCES, stage flush)',
    },
    {
      timing: 'before-claim',
      failure: typedFailure,
      detail: typedFailure.recovery,
    },
    {
      timing: 'before-claim',
      failure: { message: 'Foreign realm failure', code: 5, stage: {} },
      detail: 'Foreign realm failure',
    },
    {
      timing: 'before-claim',
      failure: {
        message: 'Bad tokens',
        code: 'EIO\nspoof',
        stage: 'a'.repeat(65),
      },
      detail: 'Bad tokens',
    },
    {
      timing: 'before-claim',
      failure: new Error(
        `Queue deadline\r\n\u0000\u0085\u202e${'x'.repeat(2000)}`,
      ),
      detail: 'Queue deadline',
    },
    { timing: 'before-claim', failure: null, detail: 'Unknown failure' },
    { timing: 'before-claim', failure: '', detail: 'Unknown failure' },
    {
      timing: 'before-claim',
      failure: 'Worker deadline expired',
      detail: 'Worker deadline expired',
    },
    {
      timing: 'before-claim',
      failure: Object.defineProperty({}, 'message', {
        get() {
          throw new Error('Diagnostic getter failed');
        },
      }),
      detail: 'Unknown failure',
    },
  ])(
    'retains W5 refusal evidence at $timing: $detail',
    async ({ timing, failure, detail }) => {
      await source();
      for (const name of ['runtime', 'workspaces', 'w5'])
        await createPrivateMigrationDirectory(
          join(identity.source, name),
          host,
        );
      const logPath = join(identity.source, 'w5/commit-log.sqlite');
      const log = W5CommitLog.open(logPath);
      try {
        log.reserve({
          reservationId: 'uncertain',
          operation: 'core.worktree.create',
          diagnostics: { note: 'Never replay this reservation' },
        });
      } finally {
        log.close();
      }
      const recordPath = join(identity.source, 'runtime/w5-maintenance.json');
      const claimPath = join(identity.source, 'runtime/startup-claim.json');
      let observed: { record: boolean; claim: boolean } | undefined;
      const rejectCold = jest
        .fn<Promise<void>, []>()
        .mockRejectedValue(failure);
      worker = createInternalRootMigrationWorker({
        filesystemHost: host,
        ...filesystemOptions,
        proveCold: () => Promise.resolve(),
        recoverW5: async (root, qualification): Promise<void> => {
          await settleInternalRootW5(
            root,
            join(__dirname, '../../w5-commit-log/commit-log-worker.ts'),
            {
              ...qualification,
              assertCold: async (): Promise<void> => {
                await qualification.assertHeld();
                const record = (await statIfPresent(recordPath)) !== null;
                const claim = (await statIfPresent(claimPath)) !== null;
                if (timing === 'before-claim' || record) {
                  observed = { record, claim };
                  return rejectCold();
                }
              },
            },
            {
              ownedChildPath: filesystemOptions.ownedChildPath,
              windowsProcessPath: resolve(
                '.cache/bin/win32-x64/canopy-process-identity.exe',
              ),
            },
          );
        },
      });
      let refusal: unknown;
      try {
        await run();
      } catch (error) {
        refusal = error;
      }
      expect(refusal).toBeInstanceOf(InternalRootMigrationRefused);
      if (!(refusal instanceof InternalRootMigrationRefused))
        throw new Error('Expected migration refusal');
      expect(refusal.recovery).toContain(detail);
      if (failure === typedFailure) {
        expect(refusal).toBe(typedFailure);
      } else {
        expect(refusal.reason).toBe('recovery-required');
        expect('cause' in refusal && refusal.cause).toBe(failure);
        expect(refusal.recovery).toContain(
          'Preserve the original root and run W5 offline diagnosis there.',
        );
        expect(refusal.recovery.length).toBeLessThan(1400);
        expect(refusal.recovery).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
      }
      if (detail === 'Bad tokens') {
        expect(refusal.recovery).not.toContain('code ');
        expect(refusal.recovery).not.toContain('stage ');
      }
      expect(observed).toEqual({
        record: timing === 'published-record',
        claim: timing === 'published-record',
      });
      expect(await statIfPresent(identity.destination)).toBeNull();
      expect((await readFixtureJournal(identity))?.phase).toBe('prepared');
      expect(await statIfPresent(recordPath)).toBeNull();
      expect(await statIfPresent(claimPath)).toBeNull();
      const retained = W5CommitLog.open(logPath);
      try {
        expect(
          retained.listReservations().map((row) => row.reservationId),
        ).toEqual(['uncertain']);
      } finally {
        retained.close();
      }
    },
  );

  test.each([
    'settled',
    'reservation',
    'legacy-untracked',
    'lifecycle',
    'corrupt-record',
    'commit-conflict',
    'workspace-root-artifact',
    'w5-artifact',
  ])('uses actual W5 recovery at source for %s state', async (state) => {
    await source();
    await mkdir(join(identity.source, 'runtime'), { mode: 0o700 });
    await mkdir(join(identity.source, 'workspaces'), { mode: 0o700 });
    await mkdir(join(identity.source, 'w5'), { mode: 0o700 });
    const index = join(identity.source, 'workspaces', 'index.json');
    const before = '{"version":1,"workspaces":[]}';
    const after = '{"version":1,"workspaces":[],"settled":true}';
    await writeFile(index, before, { mode: 0o600 });
    const log = W5CommitLog.open(
      join(identity.source, 'w5', 'commit-log.sqlite'),
    );
    try {
      if (state !== 'legacy-untracked')
        log.commit({
          operation: 'core.workspace.update',
          advance: [{ kind: 'workspaces' }],
          files: [
            {
              path: index,
              contents: after,
              previousFingerprint: fingerprintW5File(before),
            },
          ],
          outcome: { saved: true },
        });
      if (state === 'reservation')
        log.reserve({
          reservationId: 'uncertain',
          operation: 'core.worktree.create',
          diagnostics: { note: 'Never repeat an uncertain effect' },
        });
    } finally {
      log.close();
    }
    if (state === 'lifecycle') {
      const journals = join(identity.source, 'w5', 'destructive-lifecycles');
      await mkdir(journals, { mode: 0o700 });
      await writeFile(join(journals, `${'a'.repeat(64)}.json`), '{}', {
        mode: 0o600,
      });
    }
    if (state === 'corrupt-record') {
      const workspace = join(identity.source, 'workspaces', 'broken');
      await mkdir(workspace, { mode: 0o700 });
      await writeFile(join(workspace, 'workspace.json'), 'not-json', {
        mode: 0o600,
      });
    }
    if (state === 'workspace-root-artifact')
      await writeFile(
        join(identity.source, 'workspaces', 'unexpected'),
        'keep',
      );
    if (state === 'w5-artifact')
      await writeFile(join(identity.source, 'w5', 'unexpected'), 'keep');
    const conflict = '{"version":1,"workspaces":[],"manual-change":true}';
    if (state === 'commit-conflict') await writeFile(index, conflict);
    const entry = join(__dirname, '../../w5-commit-log/commit-log-worker.ts');
    worker = createInternalRootMigrationWorker({
      filesystemHost: host,
      ...filesystemOptions,
      recoverW5: async (root, qualification): Promise<void> => {
        await fixtureW5(root, entry, qualification);
      },
      proveCold: () => Promise.resolve(),
    });
    if (
      state === 'reservation' ||
      state === 'lifecycle' ||
      state === 'corrupt-record' ||
      state === 'commit-conflict' ||
      state === 'workspace-root-artifact' ||
      state === 'w5-artifact'
    ) {
      const migration = run();
      await expect(migration).rejects.toMatchObject({
        reason: 'recovery-required',
      });
      await expect(migration).rejects.toThrow('W5 remains unresolved:');
      expect(await statIfPresent(identity.destination)).toBeNull();
      expect(await readFile(index, 'utf8')).toBe(
        state === 'commit-conflict' ? conflict : after,
      );
      expect((await readFixtureJournal(identity))?.phase).toBe('prepared');
    } else {
      await expect(run()).resolves.toMatchObject({ kind: 'complete' });
      expect(
        await readFile(
          join(identity.destination, 'workspaces', 'index.json'),
          'utf8',
        ),
      ).toBe(state === 'legacy-untracked' ? before : after);
    }
  });

  unixEndpointFixture(
    'POSIX overlong root reaches its W5 endpoint through the private socket alias (CAN-5694)',
    async () => {
      const longHome = join(home, 'x'.repeat(110));
      await mkdir(longHome, { mode: 0o700 });
      identity = internalRootIdentity(longHome, canopy);
      await source();
      for (const name of ['runtime', 'workspaces', 'w5'])
        await mkdir(join(identity.source, name), { mode: 0o700 });
      const index = join(identity.source, 'workspaces', 'index.json');
      await writeFile(index, '{"version":1,"workspaces":[]}');
      W5CommitLog.open(
        join(identity.source, 'w5', 'commit-log.sqlite'),
      ).close();
      worker = createInternalRootMigrationWorker({
        ...filesystemOptions,
        proveCold: () => Promise.resolve(),
        recoverW5: async (root, qualification): Promise<void> => {
          await fixtureW5(
            root,
            join(__dirname, '../../w5-commit-log/commit-log-worker.ts'),
            qualification,
          );
        },
      });
      // Too long for `runtime/core.sock`: an alias under the user's temporary root.
      const endpoints = createPlatformEndpointServices(
        process.platform === 'darwin' ? 'darwin' : 'linux',
      );
      if (endpoints.semantics !== 'filesystem-socket')
        throw new Error('Wrong family');
      const { alias } = endpoints.address({
        dataRoot: identity.source,
        endpointName: 'core',
      });
      expect(alias).toBeDefined();
      try {
        await expect(run()).resolves.toMatchObject({ kind: 'complete' });
        expect(await statIfPresent(identity.destination)).not.toBeNull();
      } finally {
        if (alias) await rm(alias.link, { force: true });
      }
    },
  );

  test.each([0, 1024 * 1024, 1024 * 1024 + 1])(
    'qualifies external preimage byte boundary %i',
    async (size) => {
      await source();
      const external = join(home, 'gitdir');
      const preimage = Buffer.alloc(size, '.');
      await writeFile(external, preimage, { mode: 0o600 });
      repairs.prepare = async (): ReturnType<
        InternalRootRepairs['prepare']
      > => {
        expect(await readFile(external)).toEqual(preimage);
        return { kind: 'ready', externalFiles: [external] };
      };
      repairs.repair = async (): ReturnType<InternalRootRepairs['repair']> => {
        await writeFile(external, identity.destination);
        return { kind: 'ok' };
      };
      if (size > 1024 * 1024) {
        await expect(run()).rejects.toMatchObject({
          reason: 'unsupported-layout',
        });
        expect(await statIfPresent(identity.coordination)).toBeNull();
        expect(recover).not.toHaveBeenCalled();
        return;
      }
      await expect(run()).resolves.toMatchObject({ kind: 'complete' });
      await expect(
        migrateInternalRoot(
          worker,
          identity,
          { ...apply, rebuild: true },
          repairs,
        ),
      ).resolves.toMatchObject({ kind: 'complete' });
      expect(await readFile(external, 'utf8')).toBe(identity.destination);
    },
  );

  test.each(['first-preimage', 'all-preimages', 'postimages'])(
    'resumes interruption after %s without losing the original external bytes',
    async (point) => {
      await source();
      const files = [join(home, 'first-gitdir'), join(home, 'second-gitdir')];
      for (const file of files) await writeFile(file, identity.source);
      repairs.prepare = async (): ReturnType<
        InternalRootRepairs['prepare']
      > => {
        if (await statIfPresent(identity.destination))
          return { kind: 'refused', recovery: 'existing destination' };
        for (const file of files)
          if ((await readFile(file, 'utf8')) !== identity.source)
            return { kind: 'refused', recovery: 'changed backlink' };
        return { kind: 'ready', externalFiles: files };
      };
      repairs.repair = async (): ReturnType<InternalRootRepairs['repair']> => {
        for (const file of files) await writeFile(file, identity.destination);
        return { kind: 'ok' };
      };
      const capture = worker.captureExternal.bind(worker);
      const seal = worker.sealExternal.bind(worker);
      let failed = false;
      worker = {
        ...worker,
        captureExternal: async (
          journal,
        ): ReturnType<InternalRootMigrationWorker['captureExternal']> => {
          const entries = await capture(
            point === 'first-preimage' && !failed
              ? { ...journal, externalFiles: files.slice(0, 1) }
              : journal,
          );
          if (point !== 'postimages' && !failed) {
            failed = true;
            throw new Error('external evidence power loss');
          }
          return entries;
        },
        sealExternal: async (
          journal,
        ): ReturnType<InternalRootMigrationWorker['sealExternal']> => {
          const entries = await seal(journal);
          if (point === 'postimages' && !failed) {
            failed = true;
            throw new Error('external evidence power loss');
          }
          return entries;
        },
      };
      await expect(run()).rejects.toThrow('external evidence power loss');
      await expect(run()).resolves.toMatchObject({ kind: 'complete' });
      const backups = (await readdir(identity.coordination)).filter((name) =>
        name.endsWith('.preimage'),
      );
      expect(backups).toHaveLength(2);
      await assertPrivate(identity.coordination, 'directory', 0o700);
      for (const backup of backups) {
        await assertPrivate(join(identity.coordination, backup), 'file', 0o600);
        expect(
          await readFile(join(identity.coordination, backup), 'utf8'),
        ).toBe(identity.source);
      }
      await expect(
        migrateInternalRoot(
          worker,
          identity,
          { ...apply, rebuild: true },
          repairs,
        ),
      ).resolves.toMatchObject({ kind: 'complete' });
      for (const file of files)
        expect(await readFile(file, 'utf8')).toBe(identity.destination);
      expect(recover).toHaveBeenCalledTimes(1);
    },
  );

  test.each([
    'before-intent',
    'restore-intent',
    'first-backlink',
    'all-backlinks',
    'discard-intent',
    'discard-renamed',
    'discarded',
    'source-settled',
    'prepare',
    'repaired',
    'sealed',
    'published',
  ])(
    'completed rebuild resumes interruption at %s without recapturing repaired backlinks',
    async (point) => {
      await source();
      const files = [join(home, 'first-gitdir'), join(home, 'second-gitdir')];
      for (const file of files)
        await writeFile(file, identity.source, { mode: 0o644 });
      const native = host.windows;
      const metadata = native
        ? files.map((file) => {
            const { attributes, security } = native.inspect(file);
            return { attributes, security };
          })
        : [];
      let prepareCalls = 0;
      let rebuilding = false;
      let failed = false;
      const interrupt = (): never => {
        failed = true;
        throw new Error('rebuild power loss');
      };
      const qualifyPublished = repairs.qualifyPublished.bind(repairs);
      repairs = {
        qualifyPublished,
        prepare: async (): ReturnType<InternalRootRepairs['prepare']> => {
          // Models C's authority observer and old-root Git backlink inventory.
          if (await statIfPresent(identity.destination))
            return { kind: 'refused', recovery: 'existing destination' };
          for (const file of files)
            if ((await readFile(file, 'utf8')) !== identity.source)
              return { kind: 'refused', recovery: 'changed backlink' };
          if (rebuilding && point === 'prepare' && !failed) interrupt();
          prepareCalls++;
          return { kind: 'ready', externalFiles: files };
        },
        repair: async (context): ReturnType<InternalRootRepairs['repair']> => {
          assertCWorkingRoot(context);
          for (const file of files) await writeFile(file, identity.destination);
          if (rebuilding && point === 'repaired' && !failed) interrupt();
          return { kind: 'ok' };
        },
        verify: async (context): ReturnType<InternalRootRepairs['verify']> => {
          assertCWorkingRoot(context);
          for (const file of files)
            expect(await readFile(file, 'utf8')).toBe(identity.destination);
          return { kind: 'ok' };
        },
      };
      await run();
      const settled = await worker.inventory(identity);
      const save = worker.saveJournal.bind(worker);
      const restore = worker.restoreExternal.bind(worker);
      const discard = worker.discardDestination.bind(worker);
      const publish = worker.publish.bind(worker);
      rebuilding = true;
      worker = {
        ...worker,
        saveJournal: async (journal): Promise<void> => {
          if (
            !failed &&
            point === 'before-intent' &&
            journal.phase === 'restoring-external'
          )
            interrupt();
          if (
            !failed &&
            point === 'all-backlinks' &&
            journal.phase === 'rebuilding'
          )
            interrupt();
          await save(journal);
          if (
            !failed &&
            ((point === 'restore-intent' &&
              journal.phase === 'restoring-external') ||
              (point === 'discard-intent' && journal.phase === 'rebuilding') ||
              (point === 'source-settled' &&
                journal.phase === 'source-settled') ||
              (point === 'sealed' && journal.phase === 'publishing'))
          )
            interrupt();
        },
        publish: async (journal): Promise<void> => {
          await publish(journal);
          if (point === 'published' && !failed) interrupt();
        },
        restoreExternal: async (journal): Promise<void> => {
          if (point === 'first-backlink' && !failed) {
            await restore({
              ...journal,
              externalFiles: files.slice(0, 1),
              externalSnapshots: journal.externalSnapshots?.slice(0, 1),
            });
            interrupt();
          }
          await restore(journal);
        },
        discardDestination: async (journal): Promise<void> => {
          if (point === 'discard-renamed' && !failed) {
            await rename(
              identity.destination,
              join(identity.coordination, 'discarding'),
            );
            interrupt();
          }
          await discard(journal);
          if (point === 'discarded' && !failed) interrupt();
        },
      };
      await expect(
        migrateInternalRoot(
          worker,
          identity,
          { ...apply, rebuild: true },
          repairs,
        ),
      ).rejects.toThrow('rebuild power loss');
      await expect(
        migrateInternalRoot(
          worker,
          identity,
          { ...apply, rebuild: true },
          repairs,
        ),
      ).resolves.toMatchObject({ kind: 'complete' });
      expect(prepareCalls).toBe(2);
      for (const file of files) {
        expect(await readFile(file, 'utf8')).toBe(identity.destination);
        if (host.windows) {
          const { attributes, security } = host.windows.inspect(file);
          expect({ attributes, security }).toEqual(
            metadata[files.indexOf(file)],
          );
        } else expect((await lstat(file)).mode & 0o777).toBe(0o644);
      }
      expect((await worker.inventory(identity)).fingerprint).toBe(
        settled.fingerprint,
      );
      expect((await worker.inventory(identity)).sourceIdentity).toBe(
        settled.sourceIdentity,
      );
      expect(recover).toHaveBeenCalledTimes(1);
    },
  );

  test.each([
    'edited-backlink',
    windows ? 'changed-readonly-attribute' : 'changed-mode',
    'missing-preimage',
    'corrupt-preimage',
  ])(
    'completed rebuild refuses %s without changing either backlink or discarding the destination',
    async (change) => {
      await source();
      const files = [join(home, 'first-gitdir'), join(home, 'second-gitdir')];
      for (const file of files)
        await writeFile(file, identity.source, { mode: 0o600 });
      repairs.prepare = (): ReturnType<InternalRootRepairs['prepare']> =>
        Promise.resolve({
          kind: 'ready',
          externalFiles: files,
        });
      repairs.repair = async (): ReturnType<InternalRootRepairs['repair']> => {
        for (const file of files) await writeFile(file, identity.destination);
        return { kind: 'ok' };
      };
      await run();
      const destination = await migrationNodeIdentity(
        identity.destination,
        await lstat(identity.destination),
      );
      const second = files[1];
      if (!second) throw new Error('Missing fixture backlink');
      if (change === 'edited-backlink')
        await writeFile(second, 'operator edit');
      if (change === 'changed-mode') await chmod(second, 0o644);
      if (change === 'changed-readonly-attribute') await chmod(second, 0o400);
      if (change === 'missing-preimage' || change === 'corrupt-preimage') {
        const backup = (await readdir(identity.coordination)).find((name) =>
          name.endsWith('.preimage'),
        );
        if (!backup) throw new Error('Missing preimage fixture');
        if (change === 'missing-preimage')
          await rm(join(identity.coordination, backup));
        else await writeFile(join(identity.coordination, backup), 'corrupt');
      }
      const before = await Promise.all(files.map((file) => readFile(file)));
      const rebuild = migrateInternalRoot(
        worker,
        identity,
        { ...apply, rebuild: true },
        repairs,
      );
      // Readonly is admitted for observation, not authorization to rewrite an
      // external postimage whose recorded mode no longer matches.
      await expect(rebuild).rejects.toMatchObject({
        reason: 'recovery-required',
      });
      expect(await Promise.all(files.map((file) => readFile(file)))).toEqual(
        before,
      );
      expect(
        await migrationNodeIdentity(
          identity.destination,
          await lstat(identity.destination),
        ),
      ).toBe(destination);
      expect((await readFixtureJournal(identity))?.phase).toBe('complete');
      if (change === 'changed-readonly-attribute') await chmod(second, 0o600);
    },
  );

  test('restore resume refuses a backlink edited after another file was restored', async () => {
    await source();
    const files = [join(home, 'first-gitdir'), join(home, 'second-gitdir')];
    for (const file of files) await writeFile(file, identity.source);
    repairs.prepare = (): ReturnType<InternalRootRepairs['prepare']> =>
      Promise.resolve({
        kind: 'ready',
        externalFiles: files,
      });
    repairs.repair = async (): ReturnType<InternalRootRepairs['repair']> => {
      for (const file of files) await writeFile(file, identity.destination);
      return { kind: 'ok' };
    };
    await run();
    const restore = worker.restoreExternal.bind(worker);
    worker.restoreExternal = async (journal): Promise<void> => {
      await restore({
        ...journal,
        externalFiles: files.slice(0, 1),
        externalSnapshots: journal.externalSnapshots?.slice(0, 1),
      });
      throw new Error('partial restore');
    };
    await expect(
      migrateInternalRoot(
        worker,
        identity,
        { ...apply, rebuild: true },
        repairs,
      ),
    ).rejects.toThrow('partial restore');
    worker.restoreExternal = restore;
    const second = files[1];
    if (!second) throw new Error('Missing fixture backlink');
    await writeFile(second, 'operator edit after interruption');
    const before = await Promise.all(files.map((file) => readFile(file)));
    const destination = await migrationNodeIdentity(
      identity.destination,
      await lstat(identity.destination),
    );
    await expect(run()).rejects.toMatchObject({ reason: 'recovery-required' });
    expect(await Promise.all(files.map((file) => readFile(file)))).toEqual(
      before,
    );
    expect(
      await migrationNodeIdentity(
        identity.destination,
        await lstat(identity.destination),
      ),
    ).toBe(destination);
    expect((await readFixtureJournal(identity))?.phase).toBe(
      'restoring-external',
    );
  });

  test.each([4, 5, 8])(
    'v%i completion is refused rather than adopting old or unknown qualification evidence',
    async (version) => {
      await source();
      await run();
      const journal = await readFixtureJournal(identity);
      if (!journal) throw new Error('Missing journal');
      await writeFile(
        join(identity.coordination, 'journal.json'),
        JSON.stringify({ ...journal, version }),
      );
      const recovery: unknown = expect.stringContaining('including v4');
      await expect(
        migrateInternalRoot(
          worker,
          identity,
          { ...apply, rebuild: true },
          repairs,
        ),
      ).rejects.toMatchObject({ reason: 'journal-unsupported', recovery });
      expect(await statIfPresent(identity.destination)).not.toBeNull();
    },
  );

  test('rebuild resume refuses a user edit after restore intent completed, before destination discard', async () => {
    await source();
    const external = join(home, 'gitdir');
    await writeFile(external, identity.source);
    repairs.prepare = (): ReturnType<InternalRootRepairs['prepare']> =>
      Promise.resolve({ kind: 'ready', externalFiles: [external] });
    repairs.repair = async (): ReturnType<InternalRootRepairs['repair']> => {
      await writeFile(external, identity.destination);
      return { kind: 'ok' };
    };
    await run();
    const save = worker.saveJournal.bind(worker);
    worker.saveJournal = async (journal): Promise<void> => {
      await save(journal);
      if (journal.phase === 'rebuilding') throw new Error('restore finished');
    };
    await expect(
      migrateInternalRoot(
        worker,
        identity,
        { ...apply, rebuild: true },
        repairs,
      ),
    ).rejects.toThrow('restore finished');
    worker.saveJournal = save;
    await writeFile(external, 'operator edit after restore');
    const destination = await migrationNodeIdentity(
      identity.destination,
      await lstat(identity.destination),
    );
    await expect(run()).rejects.toMatchObject({ reason: 'recovery-required' });
    expect(
      await migrationNodeIdentity(
        identity.destination,
        await lstat(identity.destination),
      ),
    ).toBe(destination);
    expect(await readFile(external, 'utf8')).toBe(
      'operator edit after restore',
    );
  });

  test('v6 journals refuse a changed sibling staging path', async () => {
    await source();
    await run();
    const journal = await readFixtureJournal(identity);
    if (!journal) throw new Error('Missing journal');
    await writeFile(
      join(identity.coordination, 'journal.json'),
      JSON.stringify({
        ...journal,
        stagingRoot: join(identity.coordination, 'staging'),
      }),
    );
    await expect(run()).rejects.toMatchObject({
      reason: 'journal-unsupported',
    });
    expect(await statIfPresent(identity.destination)).not.toBeNull();
  });

  test('the default port refuses a completed rebuild before restoring external files', async () => {
    await source();
    const external = join(home, 'gitdir');
    await writeFile(external, identity.source);
    repairs.prepare = (): ReturnType<InternalRootRepairs['prepare']> =>
      Promise.resolve({
        kind: 'ready',
        externalFiles: [external],
      });
    repairs.repair = async (): ReturnType<InternalRootRepairs['repair']> => {
      await writeFile(external, identity.destination);
      return { kind: 'ok' };
    };
    await run();
    const before = await readFixtureJournal(identity);
    await expect(
      migrateInternalRoot(worker, identity, { ...apply, rebuild: true }),
    ).rejects.toMatchObject({ reason: 'repair-unavailable' });
    expect(await readFixtureJournal(identity)).toEqual(before);
    expect(await readFile(external, 'utf8')).toBe(identity.destination);
    expect(await statIfPresent(identity.destination)).not.toBeNull();
  });

  test('external repair membership is journaled before effects and partial repair can be retried', async () => {
    await source();
    const git = join(home, 'external', '.git', 'worktrees', 'managed');
    await mkdir(git, { recursive: true, mode: 0o700 });
    const metadata = join(git, 'gitdir');
    await writeFile(metadata, `${identity.source}/managed/.git`, {
      mode: 0o644,
    });
    const original = await worker.inventory(identity);
    repairs.prepare = (): ReturnType<InternalRootRepairs['prepare']> =>
      Promise.resolve({ kind: 'ready', externalFiles: [metadata] });
    repairs.repair = async (
      context,
    ): ReturnType<InternalRootRepairs['repair']> => {
      expect(context.externalFiles).toEqual([metadata]);
      expect((await readFixtureJournal(identity))?.externalFiles).toEqual([
        metadata,
      ]);
      expect(await statIfPresent(identity.destination)).toBeNull();
      await writeFile(join(context.workingRoot, 'partial'), 'discard on retry');
      await writeFile(metadata, `${identity.destination}/managed/.git`);
      return {
        kind: 'refused',
        recovery: 'Simulated partial repair; retry migration.',
      };
    };
    await expect(run()).rejects.toMatchObject({ reason: 'repair-refused' });
    expect((await readFixtureJournal(identity))?.phase).toBe('building');
    expect((await worker.inventory(identity)).fingerprint).toBe(
      original.fingerprint,
    );
    repairs.repair = (): ReturnType<InternalRootRepairs['repair']> =>
      Promise.resolve({ kind: 'ok' });
    await expect(run()).resolves.toMatchObject({ kind: 'complete' });
    expect(
      await statIfPresent(join(identity.destination, 'partial')),
    ).toBeNull();
    expect(recover).toHaveBeenCalledTimes(1);
  });

  test('unsupported external paths refuse before source recovery', async () => {
    await source();
    repairs.prepare = (): ReturnType<InternalRootRepairs['prepare']> =>
      Promise.resolve({
        kind: 'ready',
        externalFiles: [join(identity.source, 'preferences.json')],
      });
    await expect(run()).rejects.toMatchObject({ reason: 'unsupported-layout' });
    expect(recover).not.toHaveBeenCalled();
  });

  test('duplicate external membership cannot be resumed', async () => {
    await source();
    await run();
    const journal = await readFixtureJournal(identity);
    if (!journal) throw new Error('Missing journal');
    await worker.saveJournal({
      ...journal,
      externalFiles: ['/external/.git/gitdir', '/external/.git/gitdir'],
    });
    await expect(run()).rejects.toMatchObject({
      reason: 'journal-unsupported',
    });
  });

  test('metadata inventory scales with sparse bytes and catches same-size edits by mtime', async () => {
    await source();
    const file = join(identity.source, 'preferences.json');
    const before = await worker.inventory(identity);
    const stat = await lstat(file);
    await utimes(file, stat.atime, new Date(stat.mtimeMs + 10_000));
    expect((await worker.inventory(identity)).fingerprint).not.toBe(
      before.fingerprint,
    );
    expect(before).toMatchObject({ files: 1, bytes: 16 });
  });

  test('small critical W5 records retain byte verification even with preserved metadata', async () => {
    await source();
    await mkdir(join(identity.source, 'w5'), { mode: 0o700 });
    const file = join(identity.source, 'w5', 'receipt.json');
    await writeFile(file, 'before');
    const original = await lstat(file);
    const before = await worker.inventory(identity);
    await writeFile(file, 'after!');
    await utimes(file, original.atimeMs / 1000, original.mtimeMs / 1000);
    expect((await worker.inventory(identity)).fingerprint).not.toBe(
      before.fingerprint,
    );
  });

  test('a source change (Windows readonly attribute) before staging exposure refuses before publication', async () => {
    await source();
    worker = createInternalRootMigrationWorker({
      filesystemHost: host,
      ...filesystemOptions,
      recoverW5: recover,
      proveCold: () => Promise.resolve(),
      ...(windows
        ? {}
        : {
            cloneTree: async (from, to): Promise<void> => {
              await portableClone(from, to);
              await writeFile(join(from, 'new-file'), 'change');
            },
          }),
    });
    if (windows) {
      const build = worker.build.bind(worker);
      worker.build = async (journal): Promise<string> => {
        const inode = await build(journal);
        await chmod(join(identity.source, 'preferences.json'), 0o400);
        return inode;
      };
    }
    await expect(run()).rejects.toMatchObject({ reason: 'source-changed' });
    expect(recover).toHaveBeenCalledTimes(1);
    expect(await statIfPresent(identity.source)).not.toBeNull();
  });

  test('an interrupted staging clone is discarded and rebuilt from the intact source', async () => {
    await source();
    let attempts = 0;
    worker = createInternalRootMigrationWorker({
      filesystemHost: host,
      ...filesystemOptions,
      recoverW5: recover,
      proveCold: () => Promise.resolve(),
      ...(windows
        ? {}
        : {
            cloneTree: async (from, to): Promise<void> => {
              await portableClone(from, to);
              attempts++;
              if (attempts === 1) {
                await writeFile(join(to, 'partial'), 'incomplete');
                throw new Error('interrupted clone');
              }
            },
          }),
    });
    if (windows) {
      const build = worker.build.bind(worker);
      worker.build = async (journal): Promise<string> => {
        const inode = await build(journal);
        attempts++;
        if (attempts === 1) {
          await writeFile(
            join(identity.coordination, 'staging', 'partial'),
            'incomplete',
          );
          throw new Error('interrupted clone');
        }
        return inode;
      };
    }
    await expect(run()).rejects.toThrow('interrupted clone');
    expect((await readFixtureJournal(identity))?.phase).toBe('building');
    expect(await statIfPresent(identity.destination)).toBeNull();
    expect((await run()).kind).toBe('complete');
    expect(
      await statIfPresent(join(identity.destination, 'partial')),
    ).toBeNull();
    expect(recover).toHaveBeenCalledTimes(1);
    expect(attempts).toBe(2);
  });

  test.each(['unknown', 'substituted'])(
    'refuses %s sibling staging without adopting or deleting it',
    async (kind) => {
      await source();
      const staging = worker.stagingRoot(identity);
      if (kind === 'substituted') {
        repairs.repair = (): ReturnType<InternalRootRepairs['repair']> =>
          Promise.reject(new Error('repair interruption'));
        await expect(run()).rejects.toThrow('repair interruption');
        await rename(staging, join(home, 'preserved-staging'));
      }
      await mkdir(staging, { mode: 0o700 });
      await writeFile(join(staging, 'independent'), 'keep');
      await expect(run()).rejects.toMatchObject({
        reason: 'destination-exists',
      });
      expect(await readFile(join(staging, 'independent'), 'utf8')).toBe('keep');
      if (kind === 'unknown') {
        expect(recover).not.toHaveBeenCalled();
        expect(await statIfPresent(identity.coordination)).toBeNull();
      }
    },
  );

  test.each(['cloned', 'journaled', 'exposed', 'returned-to-private'])(
    'resumes sibling staging interruption at %s from a fresh worker',
    async (point) => {
      await source();
      const build = worker.build.bind(worker);
      const expose = worker.exposeStaging.bind(worker);
      const save = worker.saveJournal.bind(worker);
      let failed = false;
      worker = {
        ...worker,
        build: async (journal): Promise<string> => {
          if (
            point === 'returned-to-private' &&
            !failed &&
            (await statIfPresent(worker.stagingRoot(identity)))
          ) {
            await rename(
              worker.stagingRoot(identity),
              join(identity.coordination, 'staging'),
            );
            failed = true;
            throw new Error('staging power loss');
          }
          const inode = await build(journal);
          if (point === 'cloned' && !failed) {
            failed = true;
            throw new Error('staging power loss');
          }
          return inode;
        },
        saveJournal: async (journal): Promise<void> => {
          await save(journal);
          if (
            point === 'journaled' &&
            !failed &&
            journal.phase === 'building' &&
            journal.stagingIdentity
          ) {
            failed = true;
            throw new Error('staging power loss');
          }
        },
        exposeStaging: async (journal): Promise<void> => {
          await expose(journal);
          if (point === 'exposed' && !failed) {
            failed = true;
            throw new Error('staging power loss');
          }
        },
      };
      if (point === 'returned-to-private') {
        repairs.repair = (): ReturnType<InternalRootRepairs['repair']> =>
          Promise.reject(new Error('repair interruption'));
        await expect(run()).rejects.toThrow('repair interruption');
      }
      await expect(run()).rejects.toThrow('staging power loss');
      worker = createInternalRootMigrationWorker({
        ...filesystemOptions,
        recoverW5: recover,
        proveCold: () => Promise.resolve(),
      });
      repairs.prepare = (): ReturnType<InternalRootRepairs['prepare']> =>
        Promise.reject(
          new Error('Fresh prepare on partial staging is forbidden'),
        );
      repairs.repair = (context): ReturnType<InternalRootRepairs['repair']> => {
        assertCWorkingRoot(context);
        return Promise.resolve({ kind: 'ok' });
      };
      await expect(run()).resolves.toMatchObject({ kind: 'complete' });
      expect(await statIfPresent(worker.stagingRoot(identity))).toBeNull();
      expect(recover).toHaveBeenCalledTimes(1);
    },
  );

  test('publication after rename completes from B seals without calling C on the destination', async () => {
    await source();
    const publish = worker.publish.bind(worker);
    worker.publish = async (journal): Promise<void> => {
      await publish(journal);
      throw new Error('completion interrupted');
    };
    await expect(run()).rejects.toThrow('completion interrupted');
    worker.publish = publish;
    repairs.verify = (): ReturnType<InternalRootRepairs['verify']> =>
      Promise.reject(new Error('C must not verify the final destination'));
    await expect(run()).resolves.toMatchObject({ kind: 'complete' });
  });

  apfsCloneFixture(
    'POSIX clone failure is actionable (Windows uses native construction, never APFS clone)',
    async () => {
      await source();
      worker = createInternalRootMigrationWorker({
        ...filesystemOptions,
        recoverW5: recover,
        proveCold: () => Promise.resolve(),
        cloneTree: (): Promise<void> =>
          Promise.reject(
            new InternalRootMigrationRefused(
              'clone-unavailable',
              'APFS required',
            ),
          ),
      });
      await expect(run()).rejects.toMatchObject({
        reason: 'clone-unavailable',
      });
      expect(await statIfPresent(identity.source)).not.toBeNull();
      expect(recover).toHaveBeenCalledTimes(1);
      if (process.platform !== 'darwin')
        await expect(
          cloneInternalRoot(identity.source, join(home, 'clone')),
        ).rejects.toMatchObject({ reason: 'clone-unavailable' });
    },
  );

  test('read-only cohort and maintenance preflight reject live owners but admit departed records', async () => {
    await source();
    const runtime = join(identity.source, 'runtime');
    await mkdir(join(runtime, 'hosts'), { recursive: true, mode: 0o700 });
    const now = Math.floor(Date.now() / 1000);
    const inspect = jest.fn(() =>
      Promise.resolve({
        state: 'running' as const,
        pid: 200,
        startIdentity: `darwin:v1:200:${now}`,
      }),
    );
    const secureFiles = windows
      ? hostPlatformServices(createPlatformEndpointServices('win32'))
          .secureFiles
      : {
          permissions: jest.fn(() =>
            Promise.resolve({ state: 'private' as const }),
          ),
        };
    const options = { dataRoot: identity.source, inspect, secureFiles };
    await writeFile(
      join(runtime, 'hosts', '12345678-1234-4234-8234-123456789abc.json'),
      encodeMemberRecord({
        pid: 200,
        startEstimateMs: now * 1000,
        hostKind: 'cli',
      }),
    );
    expect(await listW5HostPeers(options)).toEqual(['cli']);
    await writeFile(
      join(runtime, 'w5-maintenance.json'),
      encodeMaintenanceRecord({
        pid: 200,
        startIdentity: `darwin:v1:200:${now}`,
        token: '12345678-1234-4234-8234-123456789abc',
      }),
    );
    expect(await inspectW5MaintenanceOwner(options)).toBe(true);
    const departed = {
      ...options,
      inspect: (): Promise<{ state: 'absent' }> =>
        Promise.resolve({ state: 'absent' }),
    };
    expect(await inspectW5MaintenanceOwner(departed)).toBe(false);
    expect(await listW5HostPeers(departed)).toEqual([]);
  });

  test('a reachable daemon socket refuses without changing the tree', async () => {
    await source();
    await mkdir(join(identity.source, 'runtime'), { mode: 0o700 });
    const server = createServer((socket) => socket.destroy());
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      const endpoint = windows
        ? createPlatformEndpointServices('win32').address({
            dataRoot: identity.source,
            endpointName: 'core',
          })
        : undefined;
      server.listen(
        endpoint?.kind === 'named-pipe'
          ? endpoint.path
          : join(identity.source, 'runtime', 'core.sock'),
        resolve,
      );
    });
    const assertStopped = windows
      ? (root: string): Promise<void> =>
          assertInternalRootNativeDaemonStopped(root, 'win32')
      : assertInternalRootDaemonStopped;
    try {
      await expect(assertStopped(identity.source)).rejects.toThrow(
        'writer-active',
      );
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
    await expect(assertStopped(identity.source)).resolves.toBeUndefined();
  });

  test('an aliased W5 directory never reaches the recovery writer', async () => {
    await source();
    const outside = join(home, 'outside-w5');
    await mkdir(outside, { mode: 0o700 });
    await symlink(
      outside,
      join(identity.source, 'w5'),
      windows ? 'junction' : 'dir',
    );
    const migration = migrateInternalRoot(
      createInternalRootMigrationWorker({
        ...filesystemOptions,
        proveCold: () => Promise.resolve(),
        recoverW5: async (root, qualification): Promise<void> => {
          await fixtureW5(root, 'unused-worker', qualification);
        },
      }),
      identity,
      apply,
      repairs,
    );
    if (windows) await expect(migration).rejects.toThrow('attributes-or-case');
    else
      await expect(migration).rejects.toMatchObject({
        reason: 'recovery-required',
      });
    expect(await readdir(outside)).toEqual([]);
  });
});

test('targeted process proof admits unrelated jobs but refuses both brands and helpers even in ancestry', () => {
  const brands = [canopy, unstoppableCode];
  const session = '100 90 /path/to/node\n90 1 /bin/zsh\n';
  for (const executable of [
    '/usr/bin/python3',
    '/usr/libexec/git-core/git',
    '/usr/sbin/periodic',
    '/bin/ps',
  ])
    expect(() =>
      assertInternalRootColdProcesses(
        `${session}50 1 ${executable}`,
        100,
        90,
        brands,
      ),
    ).not.toThrow();
  for (const brand of brands) {
    for (const executable of [
      brand.cliName,
      `${brand.cliName}d`,
      brand.displayName,
      `${brand.displayName} (Internal)`,
      `${brand.displayName} Helper (Renderer)`,
      `/Applications/${brand.displayName} (Internal).app/Contents/Frameworks/Electron Framework.framework/Helpers/chrome_crashpad_handler`,
    ])
      expect(() =>
        assertInternalRootColdProcesses(
          `100 90 /path/to/node\n90 1 ${executable}`,
          100,
          90,
          brands,
        ),
      ).toThrow('writer-active');
  }
  expect(() =>
    assertInternalRootColdProcesses('unreadable', 100, 90, brands),
  ).toThrow();
  expect(() =>
    assertInternalRootColdProcesses('90 1 /bin/zsh', 100, 90, brands),
  ).toThrow('Incomplete');
});

// lsof is Darwin-only; native Windows handles are qualified by the composed matrix.
const lsofParserFixture = windows ? test.skip : test;
lsofParserFixture(
  'POSIX lsof parser fixture: single-pass open-file proof covers cwd, files, coordination and external Git without prefix collisions',
  () => {
    const roots = [
      '/example/source',
      '/example/destination',
      '/example/secure',
      '/example/coordination',
      '/example/repo/.git',
    ];
    const self = 'p100\0fcwd\0n/elsewhere\0\n';
    for (const root of roots)
      for (const fd of ['cwd', '3'])
        expect(() =>
          assertInternalRootColdOpenFiles(
            `${self}p200\0f${fd}\0n${root}/entry\0`,
            '',
            roots,
            new Set([100]),
          ),
        ).toThrow('writer-active');
    expect(
      assertInternalRootColdOpenFiles(
        `${self}p200\0fcwd\0n/example/source-other\0`,
        '',
        roots,
        new Set([100]),
      ),
    ).toBeUndefined();
    expect(
      assertInternalRootColdOpenFiles(
        `${self}p101\0f3\0n/example/source/file\0`,
        '',
        roots,
        new Set([100, 101]),
      ),
    ).toBeUndefined();
    expect(
      assertInternalRootColdOpenFiles(
        self,
        "lsof: WARNING: can't stat() apfs file system /unrelated-volume\n      Output information may be incomplete.\n",
        roots,
        new Set([100]),
      ),
    ).toBeUndefined();
    for (const warning of [
      'permission denied',
      "lsof: WARNING: can't stat() apfs file system /example/source\n      Output information may be incomplete.\n",
    ])
      expect(() =>
        assertInternalRootColdOpenFiles(self, warning, roots, new Set([100])),
      ).toThrow();
    expect(() =>
      assertInternalRootColdOpenFiles('', '', roots, new Set([100])),
    ).toThrow('Incomplete');
  },
);

// Permission failures in unrelated macOS system trees must not block migration.
lsofParserFixture.each(['EACCES', 'EPERM'])(
  'POSIX lsof cold proof projects %s paths through the deepest accessible ancestor',
  async (code) => {
    const home = await mkdtemp(join(tmpdir(), 'cold-open-files-'));
    const root = join(home, 'affected');
    const outside = join(home, 'outside');
    const alias = join(home, 'alias');
    const self = 'p100\0fcwd\0n/elsewhere\0\n';
    const observe = storageObservation.observeStoragePathSync;
    try {
      await mkdir(root);
      await mkdir(outside);
      await symlink(root, alias);
      const roots = [observe(root).canonicalPath];
      for (const ancestor of [outside, alias]) {
        const denied = join(ancestor, 'protected');
        const path = join(denied, 'nested', 'events.allowlist');
        const observation = jest
          .spyOn(storageObservation, 'observeStoragePathSync')
          .mockImplementation((candidate) => {
            if (candidate === denied || candidate.startsWith(`${denied}/`))
              throw Object.assign(new Error('Injected permission denial'), {
                code,
              });
            return observe(candidate);
          });
        try {
          for (const kind of ['open-file', 'skipped-mount']) {
            const check = (): void =>
              assertInternalRootColdOpenFiles(
                kind === 'open-file' ? `${self}p200\0f3\0n${path}\0` : self,
                kind === 'skipped-mount'
                  ? `lsof: WARNING: can't stat() apfs file system ${path}\n      Output information may be incomplete.\n`
                  : '',
                roots,
                new Set([100]),
              );
            if (ancestor === alias) expect(check).toThrow('writer-active');
            else expect(check).not.toThrow();
            expect(observation).toHaveBeenCalledWith(ancestor);
          }
        } finally {
          observation.mockRestore();
        }
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
);

lsofParserFixture.each(['EIO', 'ENOENT', 'ELOOP'])(
  'POSIX lsof cold proof retains non-permission observation failure %s',
  (code) => {
    const failure = Object.assign(new Error('Injected observation failure'), {
      code,
    });
    const observation = jest
      .spyOn(storageObservation, 'observeStoragePathSync')
      .mockImplementation(() => {
        throw failure;
      });
    try {
      for (const kind of ['open-file', 'skipped-mount']) {
        observation.mockClear();
        expect(() =>
          assertInternalRootColdOpenFiles(
            kind === 'open-file'
              ? 'p100\0n/elsewhere\0p200\0f3\0n/unrelated/file\0'
              : 'p100\0n/elsewhere\0',
            kind === 'skipped-mount'
              ? "lsof: WARNING: can't stat() apfs file system /unrelated/file\n"
              : '',
            ['/example/source'],
            new Set([100]),
          ),
        ).toThrow(failure);
        expect(observation).toHaveBeenCalledTimes(1);
      }
    } finally {
      observation.mockRestore();
    }
  },
);

// Native filesystem/W5/Git outcomes in CI; whole-host admission is manual evidence.
defineComposedMigrationCases({ wholeHost: false });
