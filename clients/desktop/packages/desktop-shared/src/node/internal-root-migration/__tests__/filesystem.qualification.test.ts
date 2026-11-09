import fs from 'node:fs/promises';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, win32 } from 'node:path';
import * as platform from '@canopy/core-platform/host-platform';
import canopy from '../../../../../../brands/canopy/brand.json';
import unstoppableCode from '../../../../../../brands/unstoppable-code/brand.json';
import {
  migrateInternalRoot,
  InternalRootMigrationRefused,
  type InternalRootIdentity,
  type InternalRootJournal,
  type InternalRootMigrationWorker,
  type InternalRootRepairContext,
  type InternalRootRepairs,
} from '@canopy/core-runtime/node/internal-root-migration';
import {
  gitBacklinkText,
  isWithin,
  movedOwnedPath,
  prepareRelocationGit,
  relocationTransition,
  repairRelocationGit,
  type RelocationGitPlan,
} from '@canopy/core-runtime/node/relocation';
import { createInternalRootMigrationWorker } from '..';
import { createInternalRootRepairs } from '@canopy/core-runtime/node/internal-root-repairs';
import {
  buildInternalRoot,
  internalRootIdentity,
  internalRootStaging,
  isWithinInternalRoot,
  publishInternalRoot,
  validateExternalRootFiles,
  validateInternalRootStaging,
} from '../filesystem';
import {
  createPrivateMigrationDirectory,
  internalRootFilesystemHost,
  migrationNodeIdentity,
  type InternalRootFilesystemHost,
} from '../filesystem-host';

jest.setTimeout(30_000);
const execute = promisify(execFile);
const windows = process.platform === 'win32';
const linux = process.platform === 'linux';
const windowsTest = windows ? test : test.skip;
const linuxTest = linux ? test : test.skip;
const linuxGroups = linux ? (process.getgroups?.() ?? []) : [];
const supplementaryGroup = linuxGroups.find(
  (gid) => gid !== process.getegid?.(),
);
const linuxSecondGroupTest =
  linux && supplementaryGroup !== undefined ? test : test.skip;
const posixTest = windows ? test.skip : test;
const copyTest = windows || linux ? test : test.skip;
const darwinTest = process.platform === 'darwin' ? test : test.skip;
let ownedChildPath =
  windows || linux
    ? resolve(
        '.cache/native-owned-child',
        `${process.platform}-${process.arch}`,
        'core-owned-child.node',
      )
    : undefined;
let nativeBuild: string | undefined;
beforeAll(() => {
  if (!linux) return;
  nativeBuild = mkdtempSync(join(tmpdir(), 'migration-native-'));
  ownedChildPath = join(nativeBuild, 'core-owned-child.node');
  execFileSync(
    process.execPath,
    [resolve('scripts/build-owned-child.mjs'), '--out', ownedChildPath],
    { stdio: 'pipe' },
  );
}, 60_000);
afterAll(() => {
  if (nativeBuild) rmSync(nativeBuild, { recursive: true, force: true });
});
let home: string;
let environment: { HOME: string | undefined; USERPROFILE: string | undefined };
let identity: InternalRootIdentity;
let host: InternalRootFilesystemHost;
let worker: InternalRootMigrationWorker;
const apply = { apply: true, declareInternal: true };
const repairs: InternalRootRepairs = {
  prepare: () => Promise.resolve({ kind: 'ready', externalFiles: [] }),
  repair: () => Promise.resolve({ kind: 'ok' }),
  verify: () => Promise.resolve({ kind: 'ok' }),
  qualifyPublished: () => Promise.resolve({ kind: 'ok' }),
};
const git = async (cwd: string, args: readonly string[]): Promise<string> =>
  (
    await execute('git', ['--no-optional-locks', ...args], {
      cwd,
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: windows ? 'NUL' : '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_OPTIONAL_LOCKS: '0',
        GIT_AUTHOR_NAME: 'Migration fixture',
        GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
        GIT_COMMITTER_NAME: 'Migration fixture',
        GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
      },
    })
  ).stdout;

beforeEach(async () => {
  home = await fs.realpath(
    await fs.mkdtemp(join(await fs.realpath(tmpdir()), 'migration-')),
  );
  environment = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
  };
  process.env.HOME = process.env.USERPROFILE = home;
  host = internalRootFilesystemHost(ownedChildPath);
  identity = internalRootIdentity(home, canopy);
  await createPrivateMigrationDirectory(identity.source, host);
  await fs.writeFile(
    join(identity.source, 'opaque data α'),
    Buffer.from([0, 255, 3, 0]),
    { mode: 0o600 },
  );
  await fs.writeFile(join(identity.source, 'empty'), '', { mode: 0o600 });
  // Explicit host/test seams do not enable the installed bootstrap or W5 recovery.
  worker = createInternalRootMigrationWorker({
    ownedChildPath,
    recoverW5: () => Promise.resolve(),
    proveCold: () => Promise.resolve(),
  });
});
afterEach(async () => {
  jest.restoreAllMocks();
  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await fs.rm(home, { recursive: true, force: true });
});
const run = (
  effects: InternalRootMigrationWorker = worker,
  port = repairs,
): ReturnType<typeof migrateInternalRoot> =>
  migrateInternalRoot(effects, identity, apply, port);

async function journal(): Promise<InternalRootJournal> {
  const value = await worker.readJournal(identity);
  if (!value) throw new Error('Expected a durable transaction');
  return value;
}
async function assertSource(): Promise<void> {
  expect(await fs.readFile(join(identity.source, 'opaque data α'))).toEqual(
    Buffer.from([0, 255, 3, 0]),
  );
  expect(await fs.readFile(join(identity.source, 'empty'), 'utf8')).toBe('');
}

test.each([canopy, unstoppableCode])(
  'constructs and publishes the %s root without linking or removing the predecessor',
  async (brand) => {
    if (brand.id !== canopy.id) {
      await fs.rm(identity.source, { recursive: true });
      identity = internalRootIdentity(home, brand);
      await createPrivateMigrationDirectory(identity.source, host);
      await fs.writeFile(
        join(identity.source, 'opaque data α'),
        Buffer.from([0, 255, 3, 0]),
        { mode: 0o600 },
      );
      await fs.writeFile(join(identity.source, 'empty'), '', { mode: 0o600 });
    }
    const before = await worker.inventory(identity);
    expect((await run()).kind).toBe('complete');
    await assertSource();
    expect(await worker.inventory(identity)).toMatchObject({
      sourceIdentity: before.sourceIdentity,
      fingerprint: before.fingerprint,
    });
    expect(await worker.inventory(identity, true)).toMatchObject({
      fingerprint: before.fingerprint,
    });
    const from = await fs.lstat(join(identity.source, 'opaque data α'));
    const to = await fs.lstat(join(identity.destination, 'opaque data α'));
    expect(to.ino).not.toBe(from.ino);
    expect(to.nlink).toBe(1);
    expect(await journal()).toMatchObject({
      version: 7,
      phase: 'complete',
      secureRelocation: 'complete',
      publicationIdentity: await migrationNodeIdentity(
        identity.destination,
        await fs.lstat(identity.destination),
      ),
    });
    await expect(fs.lstat(internalRootStaging(identity))).rejects.toMatchObject(
      { code: 'ENOENT' },
    );
    expect((await fs.readdir(home)).sort()).toEqual(
      [
        `.${brand.id}`,
        `.${brand.id}-internal`,
        `.${brand.id}-internal-migration`,
      ].sort(),
    );
  },
);

test('constructs an empty root without inventing application state', async () => {
  await fs.rm(join(identity.source, 'opaque data α'));
  await fs.rm(join(identity.source, 'empty'));
  expect((await run()).kind).toBe('complete');
  expect(await fs.readdir(identity.destination)).toEqual([]);
});

test('the uncomposed worker never admits apply', async () => {
  const installed = createInternalRootMigrationWorker({
    recoverW5: () => {
      throw new Error('must not recover');
    },
  });
  await expect(
    migrateInternalRoot(installed, identity, apply),
  ).rejects.toBeDefined();
  expect(await fs.readdir(home)).toEqual([`.${canopy.id}`]);
  await assertSource();
});

test.each([
  'exposure',
  'before-publication',
  'after-publication',
  'completion',
])(
  'resumes interruption at %s without repeating published repair',
  async (stage) => {
    let stopped = false;
    const fault: InternalRootMigrationWorker = {
      ...worker,
      exposeStaging: async (value) => {
        await worker.exposeStaging(value);
        if (stage === 'exposure' && !stopped) {
          stopped = true;
          throw new Error('interrupted');
        }
      },
      publish: async (value) => {
        if (stage === 'before-publication' && !stopped) {
          stopped = true;
          throw new Error('interrupted');
        }
        await worker.publish(value);
        if (stage === 'after-publication' && !stopped) {
          stopped = true;
          throw new Error('interrupted');
        }
      },
      saveJournal: async (value) => {
        if (value.phase === 'complete' && stage === 'completion' && !stopped) {
          stopped = true;
          throw new Error('interrupted');
        }
        await worker.saveJournal(value);
      },
    };
    await expect(run(fault)).rejects.toThrow('interrupted');
    expect((await journal()).phase).toBe(
      stage === 'exposure' ? 'building' : 'publishing',
    );
    const repair = jest.fn((value: InternalRootRepairContext) =>
      repairs.repair(value),
    );
    const qualifyPublished = jest.fn((value: InternalRootRepairContext) =>
      repairs.qualifyPublished(value),
    );
    expect(
      (await run(worker, { ...repairs, repair, qualifyPublished })).kind,
    ).toBe('complete');
    expect(repair).toHaveBeenCalledTimes(stage === 'exposure' ? 1 : 0);
    expect(qualifyPublished).toHaveBeenCalledTimes(1);
    await assertSource();
  },
);

copyTest(
  'journals private construction before copying and resumes a partial copy',
  async () => {
    let stopped = false;
    const originalCopy = fs.copyFile;
    const faultHost: InternalRootFilesystemHost = host.windows
      ? {
          windows: {
            ...host.windows,
            copy: (from, to) => {
              host.windows?.copy(from, to);
              if (!stopped) {
                stopped = true;
                throw new Error('copy interrupted');
              }
            },
          },
        }
      : host;
    if (linux)
      jest.spyOn(fs, 'copyFile').mockImplementation(async (...args) => {
        await originalCopy(...args);
        if (!stopped) {
          stopped = true;
          throw new Error('copy interrupted');
        }
      });
    await expect(
      run({
        ...worker,
        build: (value) => buildInternalRoot(value, undefined, faultHost),
      }),
    ).rejects.toThrow('copy interrupted');
    const prior = await journal();
    expect(prior.phase).toBe('building');
    const stat = await fs.lstat(join(identity.coordination, 'staging'));
    expect(prior.stagingIdentity).toBe(
      await migrationNodeIdentity(join(identity.coordination, 'staging'), stat),
    );
    jest.restoreAllMocks();
    expect((await run()).kind).toBe('complete');
    await assertSource();
  },
);

test.each([4, 5, 8, 999])(
  'refuses journal version %s without touching either root',
  async (version) => {
    await run();
    const path = join(identity.coordination, 'journal.json');
    await fs.writeFile(path, JSON.stringify({ ...(await journal()), version }));
    await expect(worker.readJournal(identity)).rejects.toMatchObject({
      reason: 'journal-unsupported',
    });
    await assertSource();
    expect(await fs.readFile(join(identity.destination, 'empty'), 'utf8')).toBe(
      '',
    );
  },
);

test('reads v6 secure-pending completion and upgrades it to v7 without republishing', async () => {
  await run();
  const completed = await journal();
  await worker.saveJournal({
    ...completed,
    version: 6,
    secureRelocation: 'pending',
  });
  expect(await journal()).toMatchObject({
    version: 6,
    phase: 'complete',
    secureRelocation: 'pending',
    publicationIdentity: completed.publicationIdentity,
  });
  const publish = jest.fn((...args: Parameters<typeof worker.publish>) =>
    worker.publish(...args),
  );
  expect(await run({ ...worker, publish })).toMatchObject({
    kind: 'complete',
    journal: {
      version: 7,
      phase: 'complete',
      secureRelocation: 'complete',
      publicationIdentity: completed.publicationIdentity,
    },
  });
  expect(publish).not.toHaveBeenCalled();
  expect(await journal()).toMatchObject({
    version: 7,
    secureRelocation: 'complete',
    publicationIdentity: completed.publicationIdentity,
  });
  await assertSource();
});

test.each([
  { version: 6, phase: 'complete' },
  { version: 6, phase: 'building' },
  { version: 7, phase: 'building' },
])(
  'refuses secure completion in journal v$version phase $phase without touching either root',
  async ({ version, phase }) => {
    await run();
    const completed = await journal();
    await fs.writeFile(
      join(identity.coordination, 'journal.json'),
      JSON.stringify({ ...completed, version, phase }),
    );
    await expect(worker.readJournal(identity)).rejects.toMatchObject({
      reason: 'journal-unsupported',
    });
    await assertSource();
    expect(await fs.readFile(join(identity.destination, 'empty'), 'utf8')).toBe(
      '',
    );
  },
);

test.each(['staging', 'destination'])(
  'refuses a replaced %s tree rather than discarding it',
  async (target) => {
    await expect(
      run({
        ...worker,
        publish: async (value) => {
          if (target === 'destination') await worker.publish(value);
          throw new Error('interrupted');
        },
      }),
    ).rejects.toThrow('interrupted');
    const path =
      target === 'destination'
        ? identity.destination
        : internalRootStaging(identity);
    await fs.rename(path, join(home, 'retained-original'));
    await createPrivateMigrationDirectory(path, host);
    await fs.writeFile(join(path, 'independent'), 'retain', { mode: 0o600 });
    await expect(run()).rejects.toMatchObject({ reason: 'destination-exists' });
    expect(await fs.readFile(join(path, 'independent'), 'utf8')).toBe('retain');
    await assertSource();
  },
);

test('persists lossless high-sequence identities and refuses a rounded-alias staging replacement', async () => {
  await run();
  const staging = internalRootStaging(identity);
  await createPrivateMigrationDirectory(staging, host);
  const numeric = await fs.lstat(staging);
  const exact = await fs.lstat(staging, { bigint: true });
  const replaced = await fs.lstat(staging, { bigint: true });
  const first = 1n << 54n;
  const replacement = first + 1n;
  expect(Number(first)).toBe(Number(replacement));
  numeric.ino = Number(first);
  exact.ino = first;
  replaced.ino = replacement;
  const recorded: InternalRootJournal = {
    ...(await journal()),
    phase: 'building',
    secureRelocation: 'pending',
    stagingIdentity: `${exact.dev}:${first}`,
  };
  await worker.saveJournal(recorded);
  expect((await journal()).stagingIdentity).toBe(`${exact.dev}:${first}`);
  // Inject the NTFS sequence-number boundary even on a fresh native volume.
  jest.spyOn(platform, 'hostOperatingSystem').mockReturnValue('win32');
  const stats = jest.spyOn(fs, 'lstat');
  stats.mockResolvedValueOnce(exact);
  expect(await migrationNodeIdentity(staging, numeric)).toBe(
    `${exact.dev}:${first}`,
  );
  stats.mockResolvedValueOnce(replaced);
  expect(await migrationNodeIdentity(staging, numeric)).toBe(
    `${exact.dev}:${replacement}`,
  );
  stats.mockResolvedValueOnce(numeric);
  stats.mockResolvedValueOnce(replaced);
  await expect(
    validateInternalRootStaging(identity, recorded, host),
  ).rejects.toMatchObject({
    reason: 'destination-exists',
  });
});

test('classification and external journal validation use the same component membership', async () => {
  const internal = join(identity.source, 'empty');
  const outside = `${identity.source}-other`;
  await fs.writeFile(outside, 'gitdir: example\r\n', { mode: 0o600 });
  // Windows external metadata must itself inherit a private ACL, not the home ACL.
  if (windows) {
    await fs.rm(outside);
    await createPrivateMigrationDirectory(outside, host);
    await fs.writeFile(join(outside, 'gitdir'), 'gitdir: example\r\n');
  }
  const external = windows ? join(outside, 'gitdir') : outside;
  expect(isWithinInternalRoot(identity.source, internal)).toBe(
    isWithin(identity.source, internal),
  );
  expect(isWithinInternalRoot(identity.source, internal)).toBe(true);
  expect(isWithinInternalRoot(identity.source, external)).toBe(false);
  await expect(
    validateExternalRootFiles(identity, [internal], host),
  ).rejects.toMatchObject({ reason: 'unsupported-layout' });
  await expect(
    validateExternalRootFiles(identity, [external], host),
  ).resolves.toBeUndefined();
  await run();
  const completed = await journal();
  for (const path of [internal, external]) {
    await worker.saveJournal({
      ...completed,
      externalFiles: [path],
      externalSnapshots: [
        {
          path,
          mode: 0o600,
          preimage: '0'.repeat(64),
          postimage: '1'.repeat(64),
        },
      ],
    });
    if (path === internal)
      await expect(worker.readJournal(identity)).rejects.toMatchObject({
        reason: 'journal-unsupported',
      });
    else
      expect((await worker.readJournal(identity))?.externalFiles).toEqual([
        external,
      ]);
  }
});

posixTest(
  'copies symbolic link text and read-only file metadata without following or chmodding the source',
  async () => {
    await fs.chmod(join(identity.source, 'opaque data α'), 0o400);
    await fs.symlink('../outside-unread', join(identity.source, 'link'));
    await run();
    expect(await fs.readlink(join(identity.destination, 'link'))).toBe(
      '../outside-unread',
    );
    expect(
      (await fs.lstat(join(identity.source, 'opaque data α'))).mode & 0o777,
    ).toBe(0o400);
    expect(
      (await fs.lstat(join(identity.destination, 'opaque data α'))).mode &
        0o777,
    ).toBe(0o400);
  },
);

windowsTest(
  'refuses junctions and long paths without following them',
  async () => {
    const external = join(home, 'external');
    await createPrivateMigrationDirectory(external, host);
    await fs.writeFile(join(external, 'retain'), 'outside');
    const link = join(identity.source, 'junction');
    await fs.symlink(external, link, 'junction');
    await expect(worker.inventory(identity)).rejects.toBeDefined();
    await fs.rm(link);
    const long = join(identity.source, 'x'.repeat(235));
    await fs.mkdir(long);
    await expect(worker.inventory(identity)).rejects.toBeDefined();
    expect(await fs.readFile(join(external, 'retain'), 'utf8')).toBe('outside');
  },
);

windowsTest.each(['empty', join('nested', '.git')])(
  'preserves readonly %s on both roots and refuses active write holders without source changes',
  async (relative) => {
    const path = join(identity.source, relative);
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.writeFile(path, '');
    await fs.chmod(path, 0o400);
    try {
      const native = host.windows;
      if (!native) throw new Error('Missing Windows filesystem');
      const original = native.inspect(path);
      expect(original.attributes & 1).toBe(1);
      await expect(run()).resolves.toMatchObject({ kind: 'complete' });
      expect(native.inspect(path)).toEqual(original);
      expect(
        native.inspect(join(identity.destination, relative)).attributes,
      ).toBe(original.attributes);
      expect(await fs.readFile(path)).toEqual(
        await fs.readFile(join(identity.destination, relative)),
      );
    } finally {
      await fs.chmod(path, 0o600);
    }
    const held = await fs.open(path, 'r+');
    try {
      await expect(worker.inventory(identity)).rejects.toBeDefined();
    } finally {
      await held.close();
    }
    await assertSource();
  },
);

windowsTest.each(['mtime', 'size', 'security', 'identity'])(
  'readonly seal refuses a copy-flush receipt invalidated by %s',
  async (change) => {
    const file = join(identity.source, 'readonly');
    await fs.writeFile(file, 'immutable fixture');
    await fs.chmod(file, 0o400);
    const port: InternalRootRepairs = {
      ...repairs,
      repair: async (context) => {
        const target = join(context.workingRoot, 'readonly');
        if (change === 'mtime') await fs.utimes(target, 0, 1);
        if (change === 'size') {
          await fs.chmod(target, 0o600);
          await fs.writeFile(target, 'changed-size');
          await fs.chmod(target, 0o400);
        }
        if (change === 'security')
          await execute('icacls.exe', [target, '/grant', '*S-1-5-18:R']);
        if (change === 'identity') {
          await fs.rename(target, `${target}.retained`);
          await fs.copyFile(file, target);
          await fs.chmod(target, 0o400);
        }
        return { kind: 'ok' };
      },
    };
    await expect(run(worker, port)).rejects.toMatchObject({
      reason: 'recovery-required',
    });
    expect((await journal()).phase).toBe('building');
    expect(await fs.readFile(file, 'utf8')).toBe('immutable fixture');
    expect((host.windows?.inspect(file).attributes ?? 0) & 1).toBe(1);
    // A retry discards only journaled staging, mints new receipts and seals.
    await expect(run()).resolves.toMatchObject({ kind: 'complete' });
  },
);

windowsTest(
  'fresh process refuses readonly sealing without receipts, retries by rebuilding, and resumes an already durable publication seal',
  async () => {
    const file = join(identity.source, 'readonly');
    await fs.writeFile(file, 'retained source');
    await fs.chmod(file, 0o400);
    const seal = worker.seal.bind(worker);
    worker.seal = (): ReturnType<InternalRootMigrationWorker['seal']> =>
      Promise.reject(new Error('before seal interruption'));
    await expect(run()).rejects.toThrow('before seal interruption');
    const current = await journal();
    const script = `
    const fs = require('node:fs');
    const { createWindowsMigrationFilesystem } = require(${JSON.stringify(resolve('packages/core-platform/src/internal-migration-filesystem.ts'))});
    const { sealInternalRoot } = require(${JSON.stringify(resolve('packages/desktop-shared/src/node/internal-root-migration/filesystem.ts'))});
    const journal = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
    sealInternalRoot(journal, journal.stagingIdentity, { windows: createWindowsMigrationFilesystem(process.argv[2]) }).then(
      () => { console.error('unexpected readonly seal'); process.exitCode = 3; },
      error => { if (error.reason !== 'recovery-required' || !error.message.includes('copy-flush receipt')) { console.error(error); process.exitCode = 4; } else console.log(error.reason); }
    );
  `;
    const result = await execute(process.execPath, [
      '--require',
      'tsx/cjs',
      '-e',
      script,
      join(identity.coordination, 'journal.json'),
      ownedChildPath ?? '',
    ]);
    expect(result.stdout.trim()).toBe('recovery-required');
    expect((await journal()).stagingIdentity).toBe(current.stagingIdentity);
    worker.seal = seal;
    const publish = worker.publish.bind(worker);
    worker.publish = async (value): Promise<void> => {
      await publish(value);
      throw new Error('after durable seal interruption');
    };
    await expect(run()).rejects.toThrow('after durable seal interruption');
    expect((await journal()).phase).toBe('publishing');
    const restarted = createInternalRootMigrationWorker({
      ownedChildPath,
      recoverW5: () => Promise.resolve(),
      proveCold: () => Promise.resolve(),
    });
    restarted.seal = (): ReturnType<InternalRootMigrationWorker['seal']> =>
      Promise.reject(new Error('must reuse durable seal'));
    await expect(run(restarted)).resolves.toMatchObject({ kind: 'complete' });
    expect((host.windows?.inspect(file).attributes ?? 0) & 1).toBe(1);
    expect(await fs.readFile(file, 'utf8')).toBe('retained source');
  },
);

windowsTest.each(['replaced-root', 'junction'])(
  'recorded readonly cleanup refuses %s without clearing source or external attributes',
  async (change) => {
    const native = host.windows;
    if (!native) throw new Error('Missing Windows filesystem');
    const staging = join(home, 'recorded-construction');
    await createPrivateMigrationDirectory(staging, host);
    const recorded = await migrationNodeIdentity(
      staging,
      await fs.lstat(staging),
    );
    const source = join(identity.source, 'readonly');
    await fs.writeFile(source, 'source');
    await fs.chmod(source, 0o400);
    if (change === 'replaced-root') {
      await fs.rename(staging, `${staging}.retained`);
      await createPrivateMigrationDirectory(staging, host);
      native.copy(source, join(staging, 'readonly'));
    } else {
      await fs.symlink(identity.source, join(staging, 'junction'), 'junction');
    }
    expect(() => native.removeRecordedTree(staging, recorded)).toThrow(
      change === 'replaced-root'
        ? 'remove-recorded-identity'
        : 'attributes-or-case',
    );
    expect(native.inspect(source).attributes & 1).toBe(1);
    expect(await fs.readFile(source, 'utf8')).toBe('source');
    if (change === 'replaced-root')
      expect(native.inspect(join(staging, 'readonly')).attributes & 1).toBe(1);
  },
);

windowsTest.each(
  ['file', 'directory', 'root directory'].flatMap((kind) =>
    [false, true].map((existingJournal) => ({ kind, existingJournal })),
  ),
)(
  'refuses named data streams on a $kind before construction (existing journal: $existingJournal)',
  async ({ kind, existingJournal }) => {
    const path =
      kind === 'root directory'
        ? identity.source
        : join(identity.source, kind === 'file' ? 'empty' : 'stream-directory');
    if (kind === 'directory') await createPrivateMigrationDirectory(path, host);
    if (existingJournal)
      await expect(
        run({
          ...worker,
          build: () => Promise.reject(new Error('before construction')),
        }),
      ).rejects.toThrow('before construction');
    const journalPath = join(identity.coordination, 'journal.json');
    const savedJournal = existingJournal
      ? await fs.readFile(journalPath)
      : null;
    const stream = `${path}:ads`;
    await fs.writeFile(stream, 'retain stream');
    const before = await fs.lstat(path, { bigint: true });
    const homeBefore = (await fs.readdir(home)).sort();
    const sourceBefore = (await fs.readdir(identity.source)).sort();
    const build = jest.fn((journal: InternalRootJournal) =>
      worker.build(journal),
    );
    const stage = kind === 'file' ? 'file-streams' : 'directory-streams';
    const inventory = worker.inventory(identity);
    await expect(inventory).rejects.toBeInstanceOf(
      InternalRootMigrationRefused,
    );
    await expect(inventory).rejects.toMatchObject({
      reason: 'unsupported-layout',
    });
    await expect(inventory).rejects.toHaveProperty(
      'recovery',
      expect.stringContaining(stage),
    );
    const migration = run({ ...worker, build });
    await expect(migration).rejects.toMatchObject({
      reason: 'unsupported-layout',
    });
    await expect(migration).rejects.toHaveProperty(
      'recovery',
      expect.stringContaining(stage),
    );
    expect(build).not.toHaveBeenCalled();
    expect(await fs.readFile(stream, 'utf8')).toBe('retain stream');
    expect(await fs.lstat(path, { bigint: true })).toMatchObject({
      dev: before.dev,
      ino: before.ino,
      mode: before.mode,
      mtimeNs: before.mtimeNs,
      ctimeNs: before.ctimeNs,
    });
    expect((await fs.readdir(home)).sort()).toEqual(homeBefore);
    expect((await fs.readdir(identity.source)).sort()).toEqual(sourceBefore);
    await assertSource();
    if (savedJournal)
      expect(await fs.readFile(journalPath)).toEqual(savedJournal);
    else
      await expect(fs.lstat(journalPath)).rejects.toMatchObject({
        code: 'ENOENT',
      });
    for (const absent of [
      identity.destination,
      internalRootStaging(identity),
      join(identity.coordination, 'staging'),
    ])
      await expect(fs.lstat(absent)).rejects.toMatchObject({ code: 'ENOENT' });
  },
);

windowsTest(
  'refuses foreign ACL grants and proves new coordination privacy through the platform verifier',
  async () => {
    const release = await worker.coordinate(identity);
    await release();
    const { createPlatformEndpointServices, hostPlatformServices } =
      await import('@canopy/core-platform');
    expect(
      (
        await hostPlatformServices(
          createPlatformEndpointServices('win32'),
        ).secureFiles.permissions({
          path: identity.coordination,
          kind: 'directory',
          mode: 'owner-only',
          action: 'verify',
        })
      ).state,
    ).toBe('private');
    const file = join(identity.source, 'empty');
    await execute('icacls.exe', [file, '/grant', '*S-1-1-0:R']);
    try {
      await expect(worker.inventory(identity)).rejects.toBeDefined();
    } finally {
      await execute('icacls.exe', [file, '/remove:g', '*S-1-1-0']);
    }
  },
);

windowsTest(
  'publishes a private hidden/readonly backlink copy without changing the preimage attributes',
  async () => {
    const native = host.windows;
    if (!native) throw new Error('Missing Windows filesystem host');
    const path = join(identity.source, '.git-backlink');
    const temp = join(identity.source, '.replacement');
    await fs.writeFile(path, 'long preimage\n', { mode: 0o600 });
    await execute('attrib.exe', ['+R', '+H', path]);
    const before = native.inspect(path);
    native.copy(path, temp);
    await fs.chmod(temp, 0o600);
    const file = await fs.open(temp, 'r+');
    try {
      await file.writeFile('new\n');
      await file.truncate(4);
      await file.sync();
    } finally {
      await file.close();
    }
    native.finish(path, temp);
    expect(native.inspect(path)).toEqual(before);
    expect(native.hasReadonlyCopyFlush(temp)).toBe(true);
    native.replace(temp, path);
    const after = native.inspect(path);
    expect(after.attributes).toBe(before.attributes);
    expect(after.security).toBe(before.security);
    expect(after.ino).not.toBe(before.ino);
    expect(native.hasReadonlyCopyFlush(path)).toBe(true);
    expect(native.read(path).toString('utf8')).toBe('new\n');
    await expect(fs.lstat(temp)).rejects.toMatchObject({ code: 'ENOENT' });
  },
);

windowsTest(
  'uses Git slash spelling and preserves cross-drive relative-target semantics',
  () => {
    const text = gitBacklinkText(
      'C:\\Users\\owner\\.brand-internal\\checkout',
      'D:\\repositories\\common.git',
      false,
    );
    expect(text).toBe('D:/repositories/common.git');
    expect(
      win32.resolve('C:\\Users\\owner\\.brand-internal\\checkout', text),
    ).toBe('D:\\repositories\\common.git');
    expect(
      isWithinInternalRoot(
        'C:\\Users\\Owner\\.brand',
        'c:/users/owner/.brand/checkout/.git',
      ),
    ).toBe(true);
    expect(
      isWithinInternalRoot(
        'C:\\Users\\Owner\\.brand',
        'C:\\Users\\Owner\\.brand-other',
      ),
    ).toBe(false);
  },
);

test('moves real linked Git checkouts using final identities and restores exact external preimages on rebuild', async () => {
  const common = join(home, 'external repository α');
  await createPrivateMigrationDirectory(common, host);
  await git(common, ['init']);
  if (windows) await git(common, ['config', 'core.autocrlf', 'true']);
  await fs.writeFile(join(common, 'tracked'), 'base\n');
  await git(common, ['add', 'tracked']);
  await git(common, ['commit', '-m', 'fixture']);
  const managed = join(identity.source, 'managed checkout');
  await git(common, ['worktree', 'add', '-b', 'managed', managed]);
  const secondManaged = join(identity.source, 'managed second');
  await git(common, ['worktree', 'add', '-b', 'second', secondManaged]);
  if (windows) {
    const native = host.windows;
    if (!native) throw new Error('Missing Windows filesystem host');
    for (const checkout of [managed, secondManaged]) {
      // Git's hidden bit is not FILE_ATTRIBUTE_READONLY; do not chmod it away.
      const { attributes } = native.inspect(join(checkout, '.git'));
      expect(attributes & 1).toBe(0);
      expect(attributes & 2).toBe(2);
    }
    await expect(worker.inventory(identity)).resolves.toBeDefined();
  }
  await fs.writeFile(join(managed, 'tracked'), 'dirty\n');
  await fs.writeFile(join(managed, 'untracked α'), 'untracked\n');
  const transition = relocationTransition({
    version: 1,
    installationId: randomUUID(),
    brandId: identity.brandId,
    from: { authorityId: 'a'.repeat(64), canonicalDataRoot: identity.source },
    to: {
      authorityId: 'b'.repeat(64),
      canonicalDataRoot: identity.destination,
    },
  });
  const plan = await prepareRelocationGit(
    git,
    [common, managed, secondManaged],
    { portableFilesystem: process.platform !== 'darwin' },
  );
  // CRLF/absolute and relative backlink images remain exact recovery preimages.
  for (const image of plan.backlinks) {
    const value = await fs.readFile(image.path, 'utf8');
    const file = await fs.open(image.path, 'r+');
    try {
      const bytes = Buffer.from(value.replace(/\r?\n$/, '\r\n'));
      await file.writeFile(bytes);
      await file.truncate(bytes.length);
    } finally {
      await file.close();
    }
  }
  let frozen: RelocationGitPlan = await prepareRelocationGit(
    git,
    [common, managed, secondManaged],
    { portableFilesystem: process.platform !== 'darwin' },
  );
  const externalFiles = frozen.backlinks
    .map((row) => row.path)
    .filter((path) => !isWithinInternalRoot(identity.source, path));
  const preimages = await Promise.all(
    externalFiles.map((path) => fs.readFile(path)),
  );
  const native = host.windows;
  const externalMetadata = native
    ? externalFiles.map((path) => {
        const { attributes, security } = native.inspect(path);
        return { attributes, security };
      })
    : [];
  const port: InternalRootRepairs = {
    prepare: async (context) => {
      frozen = await prepareRelocationGit(
        git,
        [common, managed, secondManaged],
        { portableFilesystem: process.platform !== 'darwin' },
      );
      const unexpected = (): Promise<never> =>
        Promise.reject(new Error('Preparation must be read only'));
      const prepared = await createInternalRootRepairs({
        freeze: () =>
          Promise.resolve({
            transition: {
              ...transition,
              installationId: context.transactionId,
            },
            gitPlan: frozen,
            ownedPaths: [],
            workspaces: [],
          }),
        admit: unexpected,
        recordAuthority: unexpected,
        repairMetadata: unexpected,
        verify: unexpected,
      }).prepare(context);
      expect(prepared).toMatchObject({ kind: 'ready', externalFiles });
      return prepared;
    },
    repair: async (context) => {
      await repairRelocationGit(transition, frozen, context.workingRoot);
      return { kind: 'ok' };
    },
    verify: async (context) => {
      await repairRelocationGit(transition, frozen, context.workingRoot);
      return { kind: 'ok' };
    },
    qualifyPublished: async () => {
      const actual = await prepareRelocationGit(
        git,
        [
          common,
          movedOwnedPath(transition, managed),
          movedOwnedPath(transition, secondManaged),
        ],
        { portableFilesystem: process.platform !== 'darwin' },
      );
      expect(
        actual.checkouts.map(({ head, branch, status }) => ({
          head,
          branch,
          status,
        })),
      ).toEqual(
        frozen.checkouts.map(({ head, branch, status }) => ({
          head,
          branch,
          status,
        })),
      );
      for (const image of actual.backlinks)
        expect(image.contents).not.toContain('.migration-staging');
      if (windows && host.windows)
        for (const checkout of actual.checkouts.filter(
          (row) => row.path !== common,
        ))
          expect(
            host.windows.inspect(join(checkout.path, '.git')).attributes & 2,
          ).toBe(2);
      return { kind: 'ok' };
    },
  };
  expect((await run(worker, port)).kind).toBe('complete');
  await assertSource();
  if (native)
    expect(
      externalFiles.map((path) => {
        const { attributes, security } = native.inspect(path);
        return { attributes, security };
      }),
    ).toEqual(externalMetadata);
  const postimages = await Promise.all(
    externalFiles.map((path) => fs.readFile(path)),
  );
  const changed = externalFiles
    .map((_, index) => index)
    .filter(
      (index) =>
        !preimages[index]?.equals(postimages[index] ?? Buffer.alloc(0)),
    );
  const first = changed[0];
  const second = changed[1];
  if (first === undefined || second === undefined)
    throw new Error('Expected two changed external backlinks');
  const firstPath = externalFiles[first];
  const firstPreimage = preimages[first];
  if (!firstPath || !firstPreimage)
    throw new Error('Missing external preimage');
  const fault: InternalRootMigrationWorker = {
    ...worker,
    restoreExternal: async () => {
      const file = await fs.open(firstPath, 'r+');
      try {
        await file.writeFile(firstPreimage);
        await file.truncate(firstPreimage.length);
      } finally {
        await file.close();
      }
      throw new Error('restore interrupted');
    },
  };
  await expect(
    migrateInternalRoot(fault, identity, { ...apply, rebuild: true }, port),
  ).rejects.toThrow('restore interrupted');
  expect(await fs.readFile(firstPath)).toEqual(firstPreimage);
  const secondPath = externalFiles[second];
  if (!secondPath) throw new Error('Missing second backlink');
  expect(await fs.readFile(secondPath)).toEqual(postimages[second]);
  expect((await journal()).phase).toBe('restoring-external');
  expect(
    (
      await migrateInternalRoot(
        worker,
        identity,
        { ...apply, rebuild: true },
        port,
      )
    ).kind,
  ).toBe('complete');
});

test('refuses source hardlinks before construction without removing either link', async () => {
  const original = join(identity.source, 'empty');
  const alias = join(identity.source, 'alias');
  await fs.link(original, alias);
  await expect(run()).rejects.toBeDefined();
  expect((await fs.lstat(original)).nlink).toBe(2);
  expect((await fs.lstat(alias)).nlink).toBe(2);
});

copyTest(
  'refuses unknown and replaced private construction roots',
  async () => {
    await expect(
      run({
        ...worker,
        build: async () => {
          await createPrivateMigrationDirectory(
            join(identity.coordination, 'staging'),
            host,
          );
          throw new Error('before construction identity');
        },
      }),
    ).rejects.toThrow('before construction identity');
    const privateRoot = join(identity.coordination, 'staging');
    await fs.writeFile(join(privateRoot, 'independent'), 'retain', {
      mode: 0o600,
    });
    await expect(run()).rejects.toMatchObject({ reason: 'unsupported-layout' });
    expect(await fs.readFile(join(privateRoot, 'independent'), 'utf8')).toBe(
      'retain',
    );
    const value = await journal();
    const stat = await fs.lstat(privateRoot);
    await worker.saveJournal({
      ...value,
      stagingIdentity: await migrationNodeIdentity(privateRoot, stat),
    });
    await fs.rename(privateRoot, join(identity.coordination, 'retained'));
    await createPrivateMigrationDirectory(privateRoot, host);
    await fs.writeFile(join(privateRoot, 'replacement'), 'retain', {
      mode: 0o600,
    });
    await expect(run()).rejects.toMatchObject({ reason: 'unsupported-layout' });
    expect(await fs.readFile(join(privateRoot, 'replacement'), 'utf8')).toBe(
      'retain',
    );
  },
);

test.each([
  'core.worktree',
  'extensions.worktreeConfig',
  'submodules',
  'alternates',
  'separate-git-dir',
])(
  'portable preparation explicitly refuses unsupported %s layout',
  async (layout) => {
    const checkout = join(home, 'layout');
    await createPrivateMigrationDirectory(checkout, host);
    if (layout === 'separate-git-dir')
      await git(checkout, [
        'init',
        '--separate-git-dir',
        join(home, 'separate'),
      ]);
    else await git(checkout, ['init']);
    await fs.writeFile(join(checkout, 'tracked'), 'base');
    await git(checkout, ['add', 'tracked']);
    await git(checkout, ['commit', '-m', 'fixture']);
    if (layout === 'core.worktree')
      await git(checkout, ['config', 'core.worktree', checkout]);
    if (layout === 'extensions.worktreeConfig')
      await git(checkout, ['config', 'extensions.worktreeConfig', 'true']);
    if (layout === 'submodules')
      await fs.writeFile(join(checkout, '.gitmodules'), '');
    if (layout === 'alternates')
      await fs.writeFile(
        join(checkout, '.git', 'objects', 'info', 'alternates'),
        join(checkout, '.git', 'objects') + '\n',
      );
    await expect(
      prepareRelocationGit(git, [checkout], { portableFilesystem: true }),
    ).rejects.toMatchObject({ name: 'RelocationRefusedError' });
  },
);

darwinTest(
  'retains Darwin refusal of noncanonical Git listing evidence',
  async () => {
    const checkout = join(home, 'repository');
    await fs.mkdir(checkout);
    await git(checkout, ['init']);
    await fs.writeFile(join(checkout, 'tracked'), 'base');
    await git(checkout, ['add', 'tracked']);
    await git(checkout, ['commit', '-m', 'fixture']);
    const aliasListing = async (
      cwd: string,
      args: readonly string[],
    ): Promise<string> => {
      const result = await git(cwd, args);
      return args[0] === 'worktree'
        ? result.replace(
            `worktree ${checkout}\0`,
            `worktree ${home}/./repository\0`,
          )
        : result;
    };
    await expect(
      prepareRelocationGit(aliasListing, [checkout]),
    ).rejects.toMatchObject({
      reason: 'unreadable-git-checkout',
    });
  },
);

windowsTest(
  'refuses drive-relative, rooted-only and device-namespace Git backlink evidence',
  async () => {
    const staging = internalRootStaging(identity);
    await createPrivateMigrationDirectory(staging, host);
    const transition = relocationTransition({
      version: 1,
      installationId: randomUUID(),
      brandId: identity.brandId,
      from: { authorityId: 'a'.repeat(64), canonicalDataRoot: identity.source },
      to: {
        authorityId: 'b'.repeat(64),
        canonicalDataRoot: identity.destination,
      },
    });
    for (const text of ['C:relative', '\\rooted', '\\\\?\\C:\\device']) {
      await expect(
        repairRelocationGit(
          transition,
          {
            checkouts: [],
            backlinks: [
              {
                path: join(identity.source, 'gitdir'),
                contents: text + '\r\n',
              },
            ],
          },
          staging,
        ),
      ).rejects.toMatchObject({ reason: 'noncanonical-git-backlink' });
    }
  },
);

linuxSecondGroupTest(
  'preserves root/child/symlink GIDs and child special modes without following links (requires Linux with a second group)',
  async () => {
    if (supplementaryGroup === undefined) return;
    const external = join(home, 'external');
    await fs.writeFile(external, 'unchanged', { mode: 0o600 });
    const externalBefore = await fs.lstat(external);
    const link = join(identity.source, 'link');
    await fs.symlink(external, link);
    const directory = join(identity.source, 'setgid');
    await fs.mkdir(directory, { mode: 0o700 });
    expect((await fs.lstat(home)).gid).not.toBe(supplementaryGroup);
    const names = ['', 'setgid', 'opaque data α', 'empty', 'link'];
    for (const name of names)
      await fs.lchown(join(identity.source, name), -1, supplementaryGroup);
    await fs.chmod(identity.source, 0o700);
    await fs.chmod(directory, 0o2700);
    await fs.chmod(join(identity.source, 'opaque data α'), 0o6700);
    expect((await fs.lstat(identity.source)).mode & 0o7777).toBe(0o700);
    expect((await fs.lstat(directory)).mode & 0o7777).toBe(0o2700);
    expect(
      (await fs.lstat(join(identity.source, 'opaque data α'))).mode & 0o7777,
    ).toBe(0o6700);
    const before = await worker.inventory(identity);
    expect((await run()).kind).toBe('complete');
    for (const name of names) {
      const from = await fs.lstat(join(identity.source, name));
      const to = await fs.lstat(join(identity.destination, name));
      expect(to).toMatchObject({
        uid: from.uid,
        gid: supplementaryGroup,
        mode: from.mode,
      });
    }
    for (const [name, mode] of [
      ['', 0o700],
      ['setgid', 0o2700],
      ['opaque data α', 0o6700],
    ] satisfies [string, number][])
      expect(
        (await fs.lstat(join(identity.destination, name))).mode & 0o7777,
      ).toBe(mode);
    expect(await fs.readlink(join(identity.destination, 'link'))).toBe(
      external,
    );
    expect(await fs.lstat(external)).toMatchObject({
      gid: externalBefore.gid,
      uid: externalBefore.uid,
      ctimeMs: externalBefore.ctimeMs,
    });
    expect((await worker.inventory(identity)).fingerprint).toBe(
      before.fingerprint,
    );
    expect((await worker.inventory(identity, true)).fingerprint).toBe(
      before.fingerprint,
    );
    await assertSource();
  },
);

linuxSecondGroupTest(
  'preserves setgid inheritance different from staging (requires Linux with a second group)',
  async () => {
    if (supplementaryGroup === undefined) return;
    const directory = join(identity.source, 'setgid');
    await fs.mkdir(directory, { mode: 0o700 });
    await fs.chown(directory, -1, supplementaryGroup);
    await fs.chmod(directory, 0o2700);
    await fs.writeFile(join(directory, 'child'), '', { mode: 0o600 });
    const defaultGroup = (await fs.lstat(home)).gid;
    expect(defaultGroup).not.toBe(supplementaryGroup);
    expect((await fs.lstat(join(directory, 'child'))).gid).toBe(
      supplementaryGroup,
    );
    const before = await worker.inventory(identity);
    expect((await run()).kind).toBe('complete');
    expect(await fs.lstat(join(identity.destination, 'setgid'))).toMatchObject({
      gid: supplementaryGroup,
      mode: (await fs.lstat(directory)).mode,
    });
    expect(
      (await fs.lstat(join(identity.destination, 'setgid'))).mode & 0o7777,
    ).toBe(0o2700);
    expect(
      (await fs.lstat(join(identity.destination, 'setgid', 'child'))).gid,
    ).toBe(supplementaryGroup);
    expect((await worker.inventory(identity)).fingerprint).toBe(
      before.fingerprint,
    );
    expect((await worker.inventory(identity, true)).fingerprint).toBe(
      before.fingerprint,
    );
  },
);

linuxSecondGroupTest.each([false, true])(
  'refuses lost membership before construction (existing journal: %s; requires Linux with a second group)',
  async (existingJournal) => {
    if (supplementaryGroup === undefined) return;
    // A non-root fixture cannot assign a foreign GID; simulate membership revocation.
    if (process.geteuid?.() === 0)
      throw new Error('Run Linux group qualification as a non-root user');
    await fs.chown(join(identity.source, 'empty'), -1, supplementaryGroup);
    const before = await worker.inventory(identity);
    const build = jest.fn(() =>
      Promise.reject(new Error('before construction')),
    );
    if (existingJournal)
      await expect(run({ ...worker, build })).rejects.toThrow(
        'before construction',
      );
    const journalPath = join(identity.coordination, 'journal.json');
    const savedJournal = existingJournal
      ? await fs.readFile(journalPath)
      : null;
    const homeBefore = (await fs.readdir(home)).sort();
    build.mockClear();
    jest
      .spyOn(process, 'getgroups')
      .mockReturnValue(linuxGroups.filter((gid) => gid !== supplementaryGroup));
    for (const apply of [false, true])
      await expect(
        migrateInternalRoot(
          { ...worker, build },
          identity,
          { apply, declareInternal: true },
          repairs,
        ),
      ).rejects.toMatchObject({ reason: 'unsupported-layout' });
    expect(build).not.toHaveBeenCalled();
    expect((await fs.readdir(home)).sort()).toEqual(homeBefore);
    if (savedJournal)
      expect(await fs.readFile(journalPath)).toEqual(savedJournal);
    await expect(fs.lstat(identity.destination)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(
      fs.lstat(join(identity.coordination, 'staging')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    jest.restoreAllMocks();
    expect((await worker.inventory(identity)).fingerprint).toBe(
      before.fingerprint,
    );
    await assertSource();
  },
);

linuxTest(
  'admits the effective GID even when it is absent from supplementary groups',
  async () => {
    const effectiveGroup = process.getegid?.();
    if (effectiveGroup === undefined) throw new Error('Effective GID required');
    await fs.symlink('empty', join(identity.source, 'link'));
    for (const name of ['', 'opaque data α', 'empty', 'link'])
      await fs.lchown(join(identity.source, name), -1, effectiveGroup);
    const before = await worker.inventory(identity);
    jest.spyOn(process, 'getgroups').mockReturnValue([]);
    expect((await run()).kind).toBe('complete');
    for (const name of ['', 'opaque data α', 'empty', 'link'])
      expect((await fs.lstat(join(identity.destination, name))).gid).toBe(
        effectiveGroup,
      );
    expect((await worker.inventory(identity)).fingerprint).toBe(
      before.fingerprint,
    );
    expect((await worker.inventory(identity, true)).fingerprint).toBe(
      before.fingerprint,
    );
    await assertSource();
  },
);

linuxTest.each(['directory', 'nested directory', 'file', 'symlink'])(
  'retains recoverable construction on %s group assignment EPERM',
  async (kind) => {
    await fs.symlink('empty', join(identity.source, 'link'));
    if (kind === 'nested directory') {
      await fs.mkdir(join(identity.source, 'nested'), { mode: 0o700 });
      await fs.writeFile(join(identity.source, 'nested', 'child'), 'retain');
    }
    const before = await worker.inventory(identity);
    const denied = Object.assign(new Error('group assignment denied'), {
      code: 'EPERM',
    });
    const assign = jest.fn(() => Promise.reject(denied));
    if (kind === 'symlink') jest.spyOn(fs, 'lchown').mockImplementation(assign);
    else {
      const original = fs.open;
      jest.spyOn(fs, 'open').mockImplementation(async (...args) => {
        const handle = await original(...args);
        const stat = await handle.stat();
        if (
          kind === 'directory' || kind === 'nested directory'
            ? stat.isDirectory()
            : stat.isFile()
        )
          jest.spyOn(handle, 'chown').mockImplementation(assign);
        return handle;
      });
    }
    await expect(run()).rejects.toMatchObject({ reason: 'unsupported-layout' });
    if (kind === 'symlink')
      expect(assign).toHaveBeenCalledWith(
        expect.stringContaining('/proc/self/fd/'),
        -1,
        expect.any(Number),
      );
    else expect(assign).toHaveBeenCalledWith(-1, expect.any(Number));
    const pending = await journal();
    expect(pending.phase).toBe('building');
    const staging = join(identity.coordination, 'staging');
    expect(await migrationNodeIdentity(staging, await fs.lstat(staging))).toBe(
      pending.stagingIdentity,
    );
    await expect(fs.lstat(identity.destination)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    jest.restoreAllMocks();
    expect((await worker.inventory(identity)).fingerprint).toBe(
      before.fingerprint,
    );
    await assertSource();
    expect((await run()).kind).toBe('complete');
  },
);

linuxTest.each(['exposure', 'publication'])(
  'refuses Linux %s without the native addon, preserving both trees and the journal',
  async (stage) => {
    const stop = (): Promise<void> =>
      Promise.reject(new Error('before-directory-move'));
    await expect(
      run({
        ...worker,
        exposeStaging: (value) =>
          stage === 'exposure' ? stop() : worker.exposeStaging(value),
        publish: (value) =>
          stage === 'publication' ? stop() : worker.publish(value),
      }),
    ).rejects.toThrow('before-directory-move');
    const pending = await journal();
    expect(pending.phase).toBe(
      stage === 'exposure' ? 'building' : 'publishing',
    );
    const journalPath = join(identity.coordination, 'journal.json');
    const savedJournal = await fs.readFile(journalPath);
    const staging =
      stage === 'exposure'
        ? join(identity.coordination, 'staging')
        : internalRootStaging(identity);
    const stagedIdentity = await fs.lstat(staging);
    const sourceInventory = await worker.inventory(identity);
    const withoutNative = createInternalRootMigrationWorker({
      recoverW5: () => Promise.resolve(),
      proveCold: () => Promise.resolve(),
    });
    await expect(
      stage === 'exposure'
        ? withoutNative.exposeStaging(pending)
        : withoutNative.publish(pending),
    ).rejects.toMatchObject({ reason: 'unsupported-layout' });
    expect(await fs.readFile(journalPath)).toEqual(savedJournal);
    expect(await fs.lstat(staging)).toMatchObject({
      dev: stagedIdentity.dev,
      ino: stagedIdentity.ino,
    });
    for (const name of ['opaque data α', 'empty'])
      expect(await fs.readFile(join(staging, name))).toEqual(
        await fs.readFile(join(identity.source, name)),
      );
    await assertSource();
    expect(await worker.inventory(identity)).toMatchObject({
      sourceIdentity: sourceInventory.sourceIdentity,
      fingerprint: sourceInventory.fingerprint,
    });
    await expect(fs.lstat(identity.destination)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect((await run()).kind).toBe('complete');
  },
);

(linux ? test : test.skip)(
  'never replaces an independent empty destination created at the publication syscall',
  async () => {
    let competed = false;
    const renameNoReplace = host.renameNoReplace;
    if (!renameNoReplace)
      throw new Error('Native no-replace publisher required');
    const raceHost: InternalRootFilesystemHost = {
      renameNoReplace: (from, to, expected) => {
        if (to === identity.destination) {
          mkdirSync(to, { mode: 0o700 });
          competed = true;
        }
        renameNoReplace(from, to, expected);
      },
    };
    await expect(
      run({
        ...worker,
        publish: (value) => publishInternalRoot(value, raceHost),
      }),
    ).rejects.toMatchObject({ reason: 'destination-exists' });
    expect(competed).toBe(true);
    const independent = await fs.lstat(identity.destination);
    expect(await fs.readdir(identity.destination)).toEqual([]);
    expect((await journal()).phase).toBe('publishing');
    await expect(run()).rejects.toMatchObject({ reason: 'destination-exists' });
    expect((await fs.lstat(identity.destination)).ino).toBe(independent.ino);
    expect((await fs.lstat(internalRootStaging(identity))).isDirectory()).toBe(
      true,
    );
    await assertSource();
  },
);

(linux ? test : test.skip)(
  'anchors Linux destination writes when the construction pathname becomes a source symlink',
  async () => {
    const original = fs.copyFile;
    let swapped = false;
    const before = await worker.inventory(identity);
    jest.spyOn(fs, 'copyFile').mockImplementation(async (...args) => {
      await original(...args);
      if (!swapped) {
        swapped = true;
        const path = join(identity.coordination, 'staging');
        await fs.rename(
          path,
          join(identity.coordination, 'retained-construction'),
        );
        await fs.symlink(identity.source, path);
      }
    });
    await expect(run()).rejects.toBeDefined();
    jest.restoreAllMocks();
    expect((await worker.inventory(identity)).fingerprint).toBe(
      before.fingerprint,
    );
    await assertSource();
    expect(await fs.readlink(join(identity.coordination, 'staging'))).toBe(
      identity.source,
    );
  },
);
