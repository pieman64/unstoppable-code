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
import { mkdtempSync, rmSync } from 'node:fs';
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
import { DatabaseSync } from 'node:sqlite';
import { LedgerRepository } from '@canopy/desktop-shared/node/ledger';
import { dirname, join, resolve } from 'node:path';
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
import { settleInternalRootW5 } from '../internal-root-migration-maintenance';
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

// Portable golden-only strategy: production must never use a byte-copy fallback.
async function portableClone(
  source: string,
  destination: string,
): Promise<void> {
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

// The maintenance filesystem adapter is POSIX-only; Windows fails closed.
const posixFilesystem = process.platform === 'win32' ? describe.skip : describe;
posixFilesystem('offline filesystem transaction', () => {
  let home: string;
  let identity: InternalRootIdentity;
  let worker: InternalRootMigrationWorker;
  let recover: jest.Mock<Promise<void>, [string]>;
  let repairs: InternalRootRepairs;
  const apply = { apply: true, declareInternal: true };
  let filesystemOptions: { ownedChildPath?: string } = {};
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
    filesystemOptions = { ownedChildPath };
  }, 60_000);
  afterAll(() => {
    if (nativeBuild) rmSync(nativeBuild, { recursive: true, force: true });
  });
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
      Buffer.byteLength(endpoint) <= 103 ? temporary : await realpath('/tmp');
    home = await mkdtemp(join(parent, 'ir-'));
    identity = internalRootIdentity(home, canopy);
    recover = jest.fn<Promise<void>, [string]>(() => Promise.resolve());
    worker = createInternalRootMigrationWorker({
      ...filesystemOptions,
      recoverW5: recover,
      cloneTree: portableClone,
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
  afterEach(async () => rm(home, { recursive: true, force: true }));
  async function source(): Promise<void> {
    await mkdir(identity.source, { mode: 0o700 });
    await writeFile(
      join(identity.source, 'preferences.json'),
      '{"theme":"dark"}',
      { mode: 0o600 },
    );
  }
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
    'clones only the $id internal predecessor, preserving the source and requiring explicit rebuild',
    async (brand) => {
      identity = internalRootIdentity(home, brand);
      await source();
      await mkdir(identity.historicalSecure, { mode: 0o700 });
      const opaque = Buffer.from([0, 255, 42, 22]);
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
        inventory: { files: 1 },
        coldProof: { kind: 'ready' },
      });
      expect(await readdir(home)).toHaveLength(2); // Inventory creates neither lock nor journal.
      const result = await run();
      expect(result.kind).toBe('complete');
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
      expect(await readFile(join(identity.historicalSecure, 'opaque'))).toEqual(
        opaque,
      );
      const journal = await readInternalRootJournal(identity);
      expect(journal).toMatchObject({
        phase: 'complete',
        internalDeclaration: true,
        secureRelocation: 'pending',
      });
      if (!journal) throw new Error('Missing journal');
      expect(await readdir(identity.coordination)).not.toContain(
        'recovery-tree',
      );
      await expect(run()).rejects.toMatchObject({ reason: 'already-complete' });
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
            'core.hooksPath=/dev/null',
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
              GIT_CONFIG_GLOBAL: '/dev/null',
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
          commonDirectory: (
            await git(
              path,
              'rev-parse',
              '--path-format=absolute',
              '--git-common-dir',
            )
          ).trimEnd(),
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
      const frozenGitPlans = new Map<
        string,
        readonly Awaited<ReturnType<typeof observeGit>>[]
      >();
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
        cloneTree: portableClone,
        recoverW5: async (root, qualification): Promise<void> => {
          expect(root).toBe(identity.source);
          expect(await statIfPresent(identity.destination)).toBeNull();
          await settleInternalRootW5(
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
              .find((fields) => fields.includes(`worktree ${checkout}`));
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
                  !paths.includes(field.slice(9))
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
          return { kind: 'ready', externalFiles: [externalBacklink] };
        },
        repair: async (context): ReturnType<InternalRootRepairs['repair']> => {
          assertCWorkingRoot(context);
          const movedManaged = join(context.workingRoot, 'repos', 'managed');
          const movedLinked = join(context.workingRoot, 'worktrees', 'managed');
          await writeFile(
            join(movedLinked, '.git'),
            `gitdir: ${identity.destination}/repos/managed/.git/worktrees/managed\n`,
          );
          await writeFile(
            join(movedManaged, '.git', 'worktrees', 'managed', 'gitdir'),
            `${identity.destination}/worktrees/managed/.git\n`,
          );
          await writeFile(
            externalBacklink,
            `${identity.destination}/worktrees/external/.git\n`,
          );
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
            `gitdir: ${identity.destination}/repos/managed/.git/worktrees/managed\n`,
          );
          expect(await readFile(externalBacklink, 'utf8')).toBe(
            `${identity.destination}/worktrees/external/.git\n`,
          );
          return { kind: 'ok' };
        },
        qualifyPublished: async (
          context,
        ): ReturnType<InternalRootRepairs['qualifyPublished']> => {
          expect(context.workingRoot).toBe(identity.destination);
          expect(await statIfPresent(worker.stagingRoot(identity))).toBeNull();
          expect((await readInternalRootJournal(identity))?.phase).toBe(
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
        ).toContain(`${identity.destination}/worktrees/external`);
        expect(
          await git(movedPaths[0] ?? '', 'worktree', 'list', '--porcelain'),
        ).not.toContain(identity.source + '/');
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
      expect((await readInternalRootJournal(identity))?.phase).toBe(
        'publishing',
      );
      expect(await statIfPresent(identity.destination)).not.toBeNull();
      expect(await statIfPresent(worker.stagingRoot(identity))).toBeNull();
      worker.publish = publish;
      await expectPublishedRefusal();
      expect((await readInternalRootJournal(identity))?.phase).toBe(
        'publishing',
      );
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
      const journal = await readInternalRootJournal(identity);
      if (!journal) throw new Error('Missing qualification journal');
      expect(journal).toMatchObject({
        phase: 'complete',
        secureRelocation: 'pending',
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
        expect((await lstat(path)).mode & 0o7777).toBe(0o600);
        expect(await readFile(path)).toEqual(externalPreimage);
      }
      expect(await readFile(externalBacklink)).not.toEqual(externalPreimage);
      await verifyPublished();
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
      ).resolves.toMatchObject({ kind: 'complete' });
      expect(qualify).toHaveBeenCalledTimes(4);
      await verifyPublished();
      expect((await worker.inventory(identity)).fingerprint).toBe(
        journal.settledFingerprint,
      );
      expect(await readFile(externalBacklink, 'utf8')).toBe(
        `${identity.destination}/worktrees/external/.git\n`,
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
        await readFile(join(identity.historicalSecure, 'opaque-vault')),
      ).toEqual(opaque);
      expect(
        await statIfPresent(join(identity.destination, 'secure-storage')),
      ).toBeNull();
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
    await mkdir(identity.source, { mode: 0o700 });
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
    await mkdir(identity.historicalSecure, { mode: 0o700 });
    await expect(run()).rejects.toMatchObject({ reason: 'source-missing' });
    expect(await statIfPresent(identity.coordination)).toBeNull();
  });

  test('does not overwrite an independent destination or follow an alias', async () => {
    await source();
    await mkdir(identity.destination, { mode: 0o700 });
    await expect(run()).rejects.toMatchObject({ reason: 'destination-exists' });
    await rm(identity.destination, { recursive: true });
    await symlink(identity.source, identity.destination);
    await expect(run()).rejects.toMatchObject({ reason: 'unsupported-layout' });
  });

  test.each([
    {},
    { version: 2 },
    { version: 3 },
    { version: 4 },
    { version: 5 },
    { version: 7 },
    { version: 1, phase: 'invented' },
  ])('refuses unknown journals without altering either tree', async (raw) => {
    await source();
    await mkdir(identity.coordination, { mode: 0o700 });
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
    const journal = await readInternalRootJournal(identity);
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
          const journal = await readInternalRootJournal(selected);
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

  test('cold recovery qualification is revoked after the transaction and preferences-only roots need no worker', async () => {
    await source();
    const qualifications: InternalRootColdRecovery[] = [];
    worker = createInternalRootMigrationWorker({
      ...filesystemOptions,
      cloneTree: portableClone,
      proveCold: () => Promise.resolve(),
      recoverW5: async (root, qualification): Promise<void> => {
        qualifications.push(qualification);
        await expect(qualification.assertHeld()).resolves.toBeUndefined();
        await expect(
          settleInternalRootW5(root, 'no-worker-needed', qualification),
        ).resolves.toBe('nothing-to-settle');
      },
    });
    await run();
    const qualification = qualifications[0];
    if (!qualification) throw new Error('No qualification');
    await expect(qualification.assertHeld()).rejects.toMatchObject({
      reason: 'recovery-required',
    });
    await expect(
      settleInternalRootW5(identity.source, 'must-not-start', qualification),
    ).rejects.toMatchObject({ reason: 'recovery-required' });
    expect(await statIfPresent(join(identity.source, 'runtime'))).toBeNull();
  });

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
    expect((await readInternalRootJournal(identity))?.phase).toBe('rebuilding');
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
    await mkdir(identity.destination, { mode: 0o700 });
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
      const journal = await readInternalRootJournal(identity);
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
    expect((await readInternalRootJournal(identity))?.phase).toBe('prepared');
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
      expect((await readInternalRootJournal(identity))?.phase).toBe(
        saved ? 'complete' : 'publishing',
      );
      expect(qualify).toHaveBeenCalledTimes(1);
      worker.saveJournal = save;
      if (saved)
        await expect(run()).rejects.toMatchObject({
          reason: 'already-complete',
        });
      else await expect(run()).resolves.toMatchObject({ kind: 'complete' });
      expect(qualify).toHaveBeenCalledTimes(saved ? 1 : 2);
      expect(prepare).toHaveBeenCalledTimes(1);
      expect(repair).toHaveBeenCalledTimes(1);
      expect((await readInternalRootJournal(identity))?.phase).toBe('complete');
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
    await mkdir(identity.destination, { mode: 0o700 });
    await writeFile(join(identity.destination, 'independent'), 'preserve');
    await expect(run()).rejects.toMatchObject({ reason: 'destination-exists' });
    expect(
      await readFile(join(identity.destination, 'independent'), 'utf8'),
    ).toBe('preserve');
    expect((await readInternalRootJournal(identity))?.phase).toBe('publishing');
  });

  test.each(['before-rename', 'after-rename'])(
    'publication resume refuses changed sealed data %s',
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
      await writeFile(join(root, 'preferences.json'), 'unverified change');
      await expect(run()).rejects.toMatchObject({ reason: 'source-changed' });
      expect(qualify).not.toHaveBeenCalled();
      expect((await readInternalRootJournal(identity))?.phase).toBe(
        'publishing',
      );
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
        expect((await readInternalRootJournal(identity))?.phase).toBe(
          'publishing',
        );
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
    expect((await readInternalRootJournal(identity))?.phase).toBe('rebuilding');
    worker.discardDestination = discard;
    await expect(run()).resolves.toMatchObject({ kind: 'complete' });
    expect(
      await statIfPresent(join(identity.coordination, 'discarding')),
    ).toBeNull();
    expect(
      await readFile(join(identity.destination, 'preferences.json'), 'utf8'),
    ).toBe('{"theme":"dark"}');
  });

  test.each(['', '-wal', '-shm', '-journal'])(
    'cold W5 recovery refuses an aliased log sidecar %s before worker admission',
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
        cloneTree: portableClone,
        proveCold: () => Promise.resolve(),
        recoverW5: async (root, qualification): Promise<void> => {
          await settleInternalRootW5(root, 'missing-worker', qualification);
        },
      });
      await expect(run()).rejects.toThrow(
        'Aliased or unsupported W5 log/SQLite sidecar',
      );
      expect(await readFile(outside, 'utf8')).toBe(
        'external log must not be opened',
      );
      expect(await statIfPresent(identity.destination)).toBeNull();
      expect((await readInternalRootJournal(identity))?.phase).toBe('prepared');
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
    const destination = await lstat(identity.destination);
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
    expect((await lstat(identity.destination)).ino).toBe(destination.ino);
  });

  test('insecure or aliased roots require manual qualification', async () => {
    await source();
    await chmod(identity.source, 0o755);
    await expect(run()).rejects.toMatchObject({ reason: 'unsupported-layout' });
  });

  test.each([
    'settled',
    'reservation',
    'legacy-untracked',
    'lifecycle',
    'corrupt-record',
    'commit-conflict',
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
    const conflict = '{"version":1,"workspaces":[],"manual-change":true}';
    if (state === 'commit-conflict') await writeFile(index, conflict);
    const entry = join(__dirname, '../../w5-commit-log/commit-log-worker.ts');
    worker = createInternalRootMigrationWorker({
      ...filesystemOptions,
      cloneTree: portableClone,
      recoverW5: async (root, qualification): Promise<void> => {
        await settleInternalRootW5(root, entry, qualification);
      },
      proveCold: () => Promise.resolve(),
    });
    if (
      state === 'reservation' ||
      state === 'lifecycle' ||
      state === 'corrupt-record' ||
      state === 'commit-conflict'
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
      expect((await readInternalRootJournal(identity))?.phase).toBe('prepared');
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

  test('overlong native W5 endpoints refuse with the maintenance recovery result before a worker starts', async () => {
    const longHome = join(home, 'x'.repeat(110));
    await mkdir(longHome, { mode: 0o700 });
    identity = internalRootIdentity(longHome, canopy);
    await source();
    for (const name of ['runtime', 'workspaces', 'w5'])
      await mkdir(join(identity.source, name), { mode: 0o700 });
    const index = join(identity.source, 'workspaces', 'index.json');
    const before = '{"version":1,"workspaces":[]}';
    await writeFile(index, before);
    W5CommitLog.open(join(identity.source, 'w5', 'commit-log.sqlite')).close();
    worker = createInternalRootMigrationWorker({
      ...filesystemOptions,
      cloneTree: portableClone,
      proveCold: () => Promise.resolve(),
      recoverW5: async (root, qualification): Promise<void> => {
        await settleInternalRootW5(
          root,
          join(__dirname, '../../w5-commit-log/commit-log-worker.ts'),
          qualification,
        );
      },
    });
    const recovery = run();
    await expect(recovery).rejects.toMatchObject({
      reason: 'recovery-required',
    });
    await expect(recovery).rejects.toThrow(
      'W5 source maintenance refused (runtime-unavailable)',
    );
    expect(await readFile(index, 'utf8')).toBe(before);
    expect(await statIfPresent(identity.destination)).toBeNull();
  });

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
      expect((await lstat(identity.coordination)).mode & 0o777).toBe(0o700);
      for (const backup of backups) {
        expect(
          (await lstat(join(identity.coordination, backup))).mode & 0o777,
        ).toBe(0o600);
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
        expect((await lstat(file)).mode & 0o777).toBe(0o644);
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
    'changed-mode',
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
      const destination = await lstat(identity.destination);
      const second = files[1];
      if (!second) throw new Error('Missing fixture backlink');
      if (change === 'edited-backlink')
        await writeFile(second, 'operator edit');
      if (change === 'changed-mode') await chmod(second, 0o644);
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
      await expect(
        migrateInternalRoot(
          worker,
          identity,
          { ...apply, rebuild: true },
          repairs,
        ),
      ).rejects.toMatchObject({ reason: 'recovery-required' });
      expect(await Promise.all(files.map((file) => readFile(file)))).toEqual(
        before,
      );
      expect((await lstat(identity.destination)).ino).toBe(destination.ino);
      expect((await readInternalRootJournal(identity))?.phase).toBe('complete');
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
    const destination = await lstat(identity.destination);
    await expect(run()).rejects.toMatchObject({ reason: 'recovery-required' });
    expect(await Promise.all(files.map((file) => readFile(file)))).toEqual(
      before,
    );
    expect((await lstat(identity.destination)).ino).toBe(destination.ino);
    expect((await readInternalRootJournal(identity))?.phase).toBe(
      'restoring-external',
    );
  });

  test.each([4, 5, 7])(
    'v%i completion is refused rather than adopting old or unknown qualification evidence',
    async (version) => {
      await source();
      await run();
      const journal = await readInternalRootJournal(identity);
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
    const destination = await lstat(identity.destination);
    await expect(run()).rejects.toMatchObject({ reason: 'recovery-required' });
    expect((await lstat(identity.destination)).ino).toBe(destination.ino);
    expect(await readFile(external, 'utf8')).toBe(
      'operator edit after restore',
    );
  });

  test('v6 journals refuse a changed sibling staging path', async () => {
    await source();
    await run();
    const journal = await readInternalRootJournal(identity);
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
    const before = await readInternalRootJournal(identity);
    await expect(
      migrateInternalRoot(worker, identity, { ...apply, rebuild: true }),
    ).rejects.toMatchObject({ reason: 'repair-unavailable' });
    expect(await readInternalRootJournal(identity)).toEqual(before);
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
      expect((await readInternalRootJournal(identity))?.externalFiles).toEqual([
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
    expect((await readInternalRootJournal(identity))?.phase).toBe('building');
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
    const journal = await readInternalRootJournal(identity);
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

  test('a source change during clone refuses before publication', async () => {
    await source();
    worker = createInternalRootMigrationWorker({
      ...filesystemOptions,
      recoverW5: recover,
      proveCold: () => Promise.resolve(),
      cloneTree: async (from, to): Promise<void> => {
        await portableClone(from, to);
        await writeFile(join(from, 'new-file'), 'change');
      },
    });
    await expect(run()).rejects.toMatchObject({ reason: 'source-changed' });
    expect(recover).toHaveBeenCalledTimes(1);
    expect(await statIfPresent(identity.source)).not.toBeNull();
  });

  test('an interrupted staging clone is discarded and rebuilt from the intact source', async () => {
    await source();
    let attempts = 0;
    worker = createInternalRootMigrationWorker({
      ...filesystemOptions,
      recoverW5: recover,
      proveCold: () => Promise.resolve(),
      cloneTree: async (from, to): Promise<void> => {
        await portableClone(from, to);
        attempts++;
        if (attempts === 1) {
          await writeFile(join(to, 'partial'), 'incomplete');
          throw new Error('interrupted clone');
        }
      },
    });
    await expect(run()).rejects.toThrow('interrupted clone');
    expect((await readInternalRootJournal(identity))?.phase).toBe('building');
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
        cloneTree: portableClone,
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

  test('clone failure is actionable, leaves settled source and never publishes', async () => {
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
    await expect(run()).rejects.toMatchObject({ reason: 'clone-unavailable' });
    expect(await statIfPresent(identity.source)).not.toBeNull();
    expect(recover).toHaveBeenCalledTimes(1);
    if (process.platform !== 'darwin')
      await expect(
        cloneInternalRoot(identity.source, join(home, 'clone')),
      ).rejects.toMatchObject({ reason: 'clone-unavailable' });
  });

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
    const secureFiles = {
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
      server.listen(join(identity.source, 'runtime', 'core.sock'), resolve);
    });
    try {
      await expect(
        assertInternalRootDaemonStopped(identity.source),
      ).rejects.toThrow('writer-active');
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
    await expect(
      assertInternalRootDaemonStopped(identity.source),
    ).resolves.toBeUndefined();
  });

  test('an aliased W5 directory never reaches the recovery writer', async () => {
    await source();
    const outside = join(home, 'outside-w5');
    await mkdir(outside, { mode: 0o700 });
    await symlink(outside, join(identity.source, 'w5'));
    await expect(
      migrateInternalRoot(
        createInternalRootMigrationWorker({
          ...filesystemOptions,
          cloneTree: portableClone,
          proveCold: () => Promise.resolve(),
          recoverW5: async (root, qualification): Promise<void> => {
            await settleInternalRootW5(root, 'unused-worker', qualification);
          },
        }),
        identity,
        apply,
        repairs,
      ),
    ).rejects.toMatchObject({ reason: 'recovery-required' });
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

(process.platform === 'win32' ? test.skip : test)(
  'single-pass open-file proof covers cwd, files, coordination and external Git without prefix collisions',
  async () => {
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
        await expect(
          assertInternalRootColdOpenFiles(
            `${self}p200\0f${fd}\0n${root}/entry\0`,
            '',
            roots,
            new Set([100]),
          ),
        ).rejects.toThrow('writer-active');
    await expect(
      assertInternalRootColdOpenFiles(
        `${self}p200\0fcwd\0n/example/source-other\0`,
        '',
        roots,
        new Set([100]),
      ),
    ).resolves.toBeUndefined();
    await expect(
      assertInternalRootColdOpenFiles(
        `${self}p101\0f3\0n/example/source/file\0`,
        '',
        roots,
        new Set([100, 101]),
      ),
    ).resolves.toBeUndefined();
    await expect(
      assertInternalRootColdOpenFiles(
        self,
        "lsof: WARNING: can't stat() apfs file system /unrelated-volume\n      Output information may be incomplete.\n",
        roots,
        new Set([100]),
      ),
    ).resolves.toBeUndefined();
    for (const warning of [
      'permission denied',
      "lsof: WARNING: can't stat() apfs file system /example/source\n      Output information may be incomplete.\n",
    ])
      await expect(
        assertInternalRootColdOpenFiles(self, warning, roots, new Set([100])),
      ).rejects.toThrow();
    await expect(
      assertInternalRootColdOpenFiles('', '', roots, new Set([100])),
    ).rejects.toThrow('Incomplete');
  },
);
