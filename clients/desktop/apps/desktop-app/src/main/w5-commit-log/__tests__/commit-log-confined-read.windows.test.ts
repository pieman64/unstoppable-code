import { execFile } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type * as TsxWorkerThreads from '../../ledger/__tests__/fixtures/tsx-worker-threads';
import { windowsW5ConfinedFileReader } from '@canopy/core-platform/w5-confined-read';
import type { W5ConfinedFileReader } from '@canopy/core-runtime/node/w5/commit-log/worker-contract';
import { W5CommitRefusedError } from '@canopy/desktop-shared/node/w5-commit-log';
import { W5CommitLogHost } from '../commit-log-host';
import { selectW5ConfinementAddon } from '../confinement-addon';

// Windows evidence (CAN-5202) that the confined reader works where the app
// loads it: inside the W5 commit-log worker thread, through the real worker
// entry and its loader, in a process whose main thread loaded the same addon
// first, as `electron-daemon-host.ts` does. Off Windows nothing runs. The
// addon is CANOPY_OWNED_CHILD_ADDON, else the dev location the host selects
// (`pnpm run build:owned-child`), else built for this run.

jest.mock('node:worker_threads', () =>
  jest
    .requireActual<
      typeof TsxWorkerThreads
    >('../../ledger/__tests__/fixtures/tsx-worker-threads')
    .createTsxWorkerThreads(),
);
jest.mock('../../lib/paths', () => ({
  getW5CommitLogPath: (): string => '/unused',
  getWorkspacesRootDir: (): string => '/unused',
}));

const windowsDescribe = process.platform === 'win32' ? describe : describe.skip;
const REPOSITORY = path.resolve(__dirname, '../../../../../..');
const NATIVE = path.join(REPOSITORY, '.cache', 'native-owned-child');
const BUILD = path.join(REPOSITORY, 'scripts', 'build-owned-child.mjs');
const WORKER_ENTRY = path.join(__dirname, '..', 'commit-log-worker.ts');
const ADDON_FILE = 'core-owned-child.node';
const SECRET = Buffer.from('outside secret').toString('base64');
const run = promisify(execFile);

let dir = '';
let root = '';
let addon = '';
let mainThread: W5ConfinedFileReader;
const hosts: W5CommitLogHost[] = [];

function evidence(name: string, detail: unknown): void {
  process.stderr.write(
    `[confined-read evidence] ${name}: ${JSON.stringify(detail)}\n`,
  );
}

/** The main thread's load, or null when the addon lacks the confined read. */
const loadOnMainThread = (file: string): W5ConfinedFileReader | null =>
  existsSync(file) ? windowsW5ConfinedFileReader('win32', file)() : null;

async function resolveAddon(): Promise<{ file: string; source: string }> {
  const configured = process.env.CANOPY_OWNED_CHILD_ADDON;
  const candidates: [string, string | undefined][] = [
    [
      'CANOPY_OWNED_CHILD_ADDON',
      configured && path.resolve(REPOSITORY, configured),
    ],
    [
      'dev selection',
      selectW5ConfinementAddon({
        os: 'win32',
        runtimeMode: 'dev',
        arch: process.arch,
        resourcesPath: undefined,
        sourceDirectory: NATIVE,
      }),
    ],
  ];
  for (const [source, file] of candidates)
    if (file !== undefined && loadOnMainThread(file)) return { file, source };
  // Loaded addons stay mapped on Windows, so they live outside `dir`.
  const file = path.join(NATIVE, `w5-host-${process.pid}`, ADDON_FILE);
  mkdirSync(path.dirname(file), { recursive: true });
  await run(process.execPath, [BUILD, '--out', file], {
    cwd: REPOSITORY,
    windowsHide: true,
    timeout: 540_000,
    maxBuffer: 1 << 24,
  });
  return { file, source: 'built' };
}

// Each host has its own log: a live worker holds its log's exclusive writer
// lock, so a second host on the same file fails with WRITER_UNAVAILABLE.
function host(confinementAddon: string, trusted = root): W5CommitLogHost {
  const created = new W5CommitLogHost({
    dbPath: path.join(dir, 'w5', `commit-log-${hosts.length}.sqlite`),
    root: trusted,
    workerEntry: WORKER_ENTRY,
    confinementAddon,
  });
  hosts.push(created);
  return created;
}

/** Stops the host's running worker, as a crash does; the next call starts another. */
async function retireWorker(created: W5CommitLogHost): Promise<void> {
  const worker: unknown = Reflect.get(
    Object(Reflect.get(created, 'session')),
    'worker',
  );
  const terminate: unknown = Reflect.get(Object(worker), 'terminate');
  if (typeof terminate !== 'function') throw new Error('No running worker');
  await Reflect.apply(terminate, worker, []);
}

/** Each captured file as `kind[/workspace]:state-or-reason`. */
function outcomes(files: readonly unknown[]): string[] {
  return files.map((file) => {
    const get = (key: string): string => String(Reflect.get(Object(file), key));
    const workspace: unknown = Reflect.get(Object(file), 'workspaceId');
    const name =
      typeof workspace === 'string'
        ? `${get('kind')}/${workspace}`
        : get('kind');
    return `${name}:${get('state') === 'unreadable' ? get('reason') : get('state')}`;
  });
}

const EXPECTED = [
  'index:present',
  'manifest/alpha:present',
  'worktrees/alpha:absent',
  // `beta` is a junction to the outside directory.
  'manifest/beta:unsafe-path',
  'worktrees/beta:unsafe-path',
];

windowsDescribe(
  'Windows confined capture in the W5 commit-log worker (CAN-5202)',
  () => {
    beforeAll(async () => {
      const resolved = await resolveAddon();
      addon = resolved.file;
      const loaded = loadOnMainThread(addon);
      if (!loaded)
        throw new Error(`readConfinedFile did not load from ${addon}`);
      mainThread = loaded;
      evidence('worker suite', { node: process.version, ...resolved });
    }, 600_000);

    beforeEach(() => {
      dir = mkdtempSync(path.join(realpathSync.native(tmpdir()), 'w5-worker-'));
      root = path.join(dir, 'workspaces');
      const outside = path.join(dir, 'outside');
      mkdirSync(path.join(root, 'alpha'), { recursive: true });
      mkdirSync(outside);
      writeFileSync(
        path.join(root, 'index.json'),
        '{"workspaces":[{"id":"alpha"},{"id":"beta"}]}',
      );
      writeFileSync(path.join(root, 'alpha', 'workspace.json'), 'inside');
      writeFileSync(path.join(outside, 'workspace.json'), 'outside secret');
      writeFileSync(path.join(outside, 'worktrees.json'), 'outside secret');
      symlinkSync(outside, path.join(root, 'beta'), 'junction');
    });

    afterEach(async () => {
      await Promise.all(hosts.splice(0).map((created) => created.shutdown()));
      rmSync(dir, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    });

    it('reads in root and refuses a junction inside the worker, beside the main thread load', async () => {
      const before = await mainThread.read(root, ['index.json'], 1024);
      expect(before.state).toBe('present');
      const capture = await host(addon).capture({
        files: [],
        discoverWorkspaces: true,
      });
      expect(capture.discovery).toBe('complete');
      expect(outcomes(capture.files)).toEqual(EXPECTED);
      expect(capture.files[1]).toMatchObject({
        base64: Buffer.from('inside').toString('base64'),
      });
      expect(JSON.stringify(capture)).not.toContain(SECRET);
      // The main thread's load still serves reads beside the worker's.
      expect(
        await mainThread.read(root, ['alpha', 'workspace.json'], 1024),
      ).toEqual({
        state: 'present',
        bytes: Buffer.from('inside'),
      });
      expect(
        await mainThread.read(root, ['beta', 'workspace.json'], 1024),
      ).toEqual({ state: 'unreadable', reason: 'unsafe-path' });
    });

    it('loads again in a restarted worker and from another copy of the addon', async () => {
      const first = host(addon);
      expect(
        outcomes(
          (await first.capture({ files: [], discoverWorkspaces: true })).files,
        ),
      ).toEqual(EXPECTED);
      // A retired worker's environment unloads; its replacement loads again.
      await first.shutdown();
      const restarted = host(addon);
      expect(
        outcomes(
          (await restarted.capture({ files: [], discoverWorkspaces: true }))
            .files,
        ),
      ).toEqual(EXPECTED);
      await restarted.shutdown();
      // A dev main thread and worker may name different files of one build.
      const copy = path.join(NATIVE, `w5-host-copy-${process.pid}`, ADDON_FILE);
      mkdirSync(path.dirname(copy), { recursive: true });
      if (!existsSync(copy)) copyFileSync(addon, copy);
      expect(
        outcomes(
          (await host(copy).capture({ files: [], discoverWorkspaces: true }))
            .files,
        ),
      ).toEqual(EXPECTED);
    });

    /** The capture's typed refusal, or what else it settled with. */
    async function refusalOf(created: W5CommitLogHost): Promise<unknown> {
      const error: unknown = await created
        .capture({ files: [], discoverWorkspaces: true })
        .then(
          () => 'captured',
          (failure: unknown) => failure,
        );
      return error instanceof W5CommitRefusedError
        ? error.details.capture
        : `${error instanceof Error ? error.name : String(error)}:${String(
            Reflect.get(Object(error), 'code'),
          )}`;
    }

    it('captures a root reached through a junction anchored at start, and fails closed once it is retargeted', async () => {
      const alias = path.join(dir, 'alias');
      symlinkSync(root, alias, 'junction');
      const created = host(addon, alias);
      const first = await created.capture({
        files: [],
        discoverWorkspaces: true,
      });
      expect(outcomes(first.files)).toEqual(EXPECTED);
      expect(created.captureRoot).toBe(realpathSync.native(root));
      // The ancestor swap: the alias now names the outside directory.
      rmdirSync(alias);
      symlinkSync(path.join(dir, 'outside'), alias, 'junction');
      writeFileSync(path.join(dir, 'outside', 'index.json'), 'outside secret');
      for (let attempt = 0; attempt < 2; attempt++)
        expect(await refusalOf(created)).toBe('root-changed');
      expect(created.workersStarted).toBe(1);
      // A replacement worker keeps the pinned anchor instead of resolving the
      // swapped root again.
      await retireWorker(created);
      expect(await refusalOf(created)).toBe('root-changed');
      expect(created.workersStarted).toBe(2);
      expect(created.captureRoot).toBe(realpathSync.native(root));
      // Swapped back, the anchored root captures again.
      rmdirSync(alias);
      symlinkSync(root, alias, 'junction');
      const restored = await created.capture({
        files: [],
        discoverWorkspaces: true,
      });
      expect(outcomes(restored.files)).toEqual(EXPECTED);
      expect(JSON.stringify(restored)).not.toContain(SECRET);
    });

    it('refuses capture in the worker without an addon that loads', async () => {
      expect(await refusalOf(host(path.join(dir, 'missing', ADDON_FILE)))).toBe(
        'confinement-unavailable',
      );
    });
  },
);
