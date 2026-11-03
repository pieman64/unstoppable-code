// GB12 (CAN-5543): the flip launch's pre-spawn step over a real in-process
// commit log host in a temporary data root.
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canopyDaemonRefusal } from '@canopy/core-client/node';
import type * as TsxWorkerThreads from '../../ledger/__tests__/fixtures/tsx-worker-threads';
import type * as Paths from '../paths';
import type { W5CommitLogHost as Host } from '../../w5-commit-log/commit-log-host';

jest.mock('node:worker_threads', () =>
  jest
    .requireActual<
      typeof TsxWorkerThreads
    >('../../ledger/__tests__/fixtures/tsx-worker-threads')
    .createTsxWorkerThreads(),
);
const mockRoot: { dataDir: string; host: Host | undefined; shutDown: boolean } =
  { dataDir: '', host: undefined, shutDown: false };
jest.mock('../paths', () => ({
  ...jest.requireActual<typeof Paths>('../paths'),
  getDataDir: (): string => mockRoot.dataDir,
  getWorkspacesRootDir: (): string => `${mockRoot.dataDir}/workspaces`,
  getW5FlipBackupMarkerPath: (): string =>
    `${mockRoot.dataDir}/w5/flip-backup.json`,
}));
jest.mock('../../w5-commit-log/commit-log-host', () => ({
  ...jest.requireActual<object>('../../w5-commit-log/commit-log-host'),
  getW5CommitLogHost: (): Host | undefined => mockRoot.host,
  shutdownW5CommitLogHost: (): Promise<void> => {
    mockRoot.shutDown = true;
    return mockRoot.host?.shutdown() ?? Promise.resolve();
  },
  isW5CommitLogHostShutDown: (): boolean => mockRoot.shutDown,
  runningW5CommitLogWorkers: (): number =>
    mockRoot.host?.runningWorkerCount ?? 0,
}));

import { W5CommitLogHost } from '../../w5-commit-log/commit-log-host';
import {
  deferW5FlipBackup,
  prepareW5FlipSpawn,
  readW5FlipBackupMarker,
  requireW5FlipSpawnPrepared,
  stopInProcessW5Host,
  w5FlipStepFailure,
} from '../w5-flip-backup';

jest.setTimeout(60_000);

let base: string;
let others: W5CommitLogHost[] = [];

function hostAt(dataDir: string): W5CommitLogHost {
  return new W5CommitLogHost({
    dbPath: join(dataDir, 'w5', 'commit-log.sqlite'),
    root: join(dataDir, 'workspaces'),
    workerEntry: join(__dirname, '../../w5-commit-log/commit-log-worker.ts'),
  });
}

/** A data root at `dataDir` whose app host is the one the step uses. */
function useRoot(dataDir: string): W5CommitLogHost {
  mockRoot.dataDir = dataDir;
  if (mockRoot.host) others.push(mockRoot.host);
  const host = hostAt(dataDir);
  mockRoot.host = host;
  mockRoot.shutDown = false;
  return host;
}

function seed(dataDir: string): void {
  const root = join(dataDir, 'workspaces');
  mkdirSync(join(root, 'alpha'), { recursive: true });
  writeFileSync(
    join(root, 'index.json'),
    '{"version":1,"workspaces":[{"id":"alpha","type":"single-repo","name":"Alpha","color":"#fff"}]}\n',
  );
  writeFileSync(
    join(root, 'alpha', 'workspace.json'),
    '{"version":1,"type":"single-repo","repos":[]}\n',
  );
  writeFileSync(
    join(root, 'alpha', 'worktrees.json'),
    '{"version":1,"worktrees":[]}\n',
  );
}

const backups = (dataDir: string): string[] => {
  try {
    return readdirSync(join(dataDir, 'w5', 'backups'));
  } catch {
    return [];
  }
};

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'w5-flip-')));
  others = [];
});
afterEach(async () => {
  jest.restoreAllMocks();
  await mockRoot.host?.shutdown();
  for (const other of others) await other.shutdown();
  mockRoot.host = undefined;
  rmSync(base, { recursive: true, force: true });
});

test('captures one verified backup, records it last, then stops the in-process log; a later spawn only stops it', async () => {
  const dataDir = join(base, 'data');
  seed(dataDir);
  const host = useRoot(dataDir);
  await host.commit({
    operation: 'fixture.initial',
    advance: [{ kind: 'workspaces' }],
    files: [],
    outcome: null,
  });
  // First in this file: no step has run in this process yet, so Windows,
  // which has no claimed spawn, may not launch.
  let unprepared: unknown;
  try {
    requireW5FlipSpawnPrepared();
  } catch (error) {
    unprepared = error;
  }
  expect(w5FlipStepFailure(unprepared)).toEqual({
    failure: 'backup_refused',
    detail: 'spawn-unprepared',
  });
  await prepareW5FlipSpawn('2.5.0');
  expect(() => requireW5FlipSpawnPrepared()).not.toThrow();
  const marker = await readW5FlipBackupMarker();
  expect(marker).toMatchObject({
    version: 1,
    state: 'captured',
    commitId: 1,
    buildVersion: '2.5.0',
    capture: 'before-flip',
  });
  const [id] = backups(dataDir);
  expect(marker).toMatchObject({ backup: `w5/backups/${id}` });
  expect(
    readFileSync(
      join(dataDir, 'w5', 'backups', `${id}`, 'record.json'),
      'utf8',
    ),
  ).toContain('"commitId": 1');
  expect(host.runningWorkerCount).toBe(0);
  // Shut down for good: a later capture could not run in process.
  await expect(host.snapshot()).rejects.toThrow();

  // Every later flip spawn runs the step again; only the backup is once.
  await prepareW5FlipSpawn('2.6.0');
  expect(backups(dataDir)).toHaveLength(1);
  expect(await readW5FlipBackupMarker()).toEqual(marker);
});

test('a fresh root records empty-root and proceeds', async () => {
  const dataDir = join(base, 'fresh');
  mkdirSync(dataDir);
  useRoot(dataDir);
  await prepareW5FlipSpawn('2.5.0');
  expect(await readW5FlipBackupMarker()).toMatchObject({
    state: 'captured',
    backup: 'empty-root',
    commitId: 0,
    capture: 'before-flip',
  });
});

test.each<[string, (dataDir: string) => void, string]>([
  [
    'a missing index with workspace folders',
    (dataDir): void => {
      mkdirSync(join(dataDir, 'workspaces', 'alpha'), { recursive: true });
    },
    'missing-source',
  ],
  [
    'an unreadable index',
    (dataDir): void => {
      seed(dataDir);
      writeFileSync(join(dataDir, 'workspaces', 'index.json'), '{not json');
    },
    'source-unreadable',
  ],
])('fails closed on %s, writing no marker', async (_, arrange, detail) => {
  const dataDir = join(base, 'data');
  mkdirSync(dataDir);
  arrange(dataDir);
  const host = useRoot(dataDir);
  const error: unknown = await prepareW5FlipSpawn('2.5.0').then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(w5FlipStepFailure(error)).toEqual({
    failure: 'backup_refused',
    detail,
  });
  expect(await readW5FlipBackupMarker()).toBeNull();
  // Not stopped: nothing spawns, and the next launch retries.
  await expect(host.snapshot()).resolves.toMatchObject({ commitId: 0 });
});

test('a peer holding the log refuses writer_held; the later capture is labeled after the flip (Q1(a))', async () => {
  const dataDir = join(base, 'data');
  seed(dataDir);
  const peer = hostAt(dataDir);
  others.push(peer);
  await peer.snapshot();
  useRoot(dataDir);
  const error: unknown = await prepareW5FlipSpawn('2.5.0').then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(canopyDaemonRefusal(error)).toBe('writer_held');
  expect(backups(dataDir)).toEqual([]);
  expect(await readW5FlipBackupMarker()).toMatchObject({
    state: 'deferred',
  });
  // The peer lets go; the next launch captures.
  await peer.shutdown();
  useRoot(dataDir);
  await prepareW5FlipSpawn('2.5.0');
  expect(await readW5FlipBackupMarker()).toMatchObject({
    state: 'captured',
    capture: 'captured-after-flip',
  });
});

test('a symlinked data root is canonicalized for the backup (Q6(a))', async () => {
  const real = join(base, 'real');
  seed(real);
  const link = join(base, 'link');
  symlinkSync(real, link);
  useRoot(link);
  await prepareW5FlipSpawn('2.5.0');
  expect(await readW5FlipBackupMarker()).toMatchObject({ state: 'captured' });
  expect(backups(real)).toHaveLength(1);
});

test('a respawn after this process stopped its log refuses where no daemon served W5', async () => {
  const dataDir = join(base, 'data');
  seed(dataDir);
  useRoot(dataDir);
  // Before any test defers: the step module keeps whether a daemon served W5
  // in this process. A degraded handoff stopped the log; a later spawn may not
  // skip the backup.
  await stopInProcessW5Host();
  const error: unknown = await prepareW5FlipSpawn('2.5.0').then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(w5FlipStepFailure(error)).toEqual({
    failure: 'backup_refused',
    detail: 'host-stopped',
  });
  expect(await readW5FlipBackupMarker()).toBeNull();
});

test('a deferred or unreadable marker labels the later capture captured-after-flip', async () => {
  const dataDir = join(base, 'data');
  seed(dataDir);
  useRoot(dataDir);
  // A daemon (here a peer host) holds the log, so nothing is captured now.
  const daemon = hostAt(dataDir);
  others.push(daemon);
  await daemon.snapshot();
  await deferW5FlipBackup('2.5.0');
  expect(await readW5FlipBackupMarker()).toMatchObject({
    state: 'deferred',
    buildVersion: '2.5.0',
  });
  // Only an absent marker is deferred; a later build keeps the first.
  await deferW5FlipBackup('2.6.0');
  expect(await readW5FlipBackupMarker()).toMatchObject({
    buildVersion: '2.5.0',
  });
  // It idles out; the next launch spawns ours and captures.
  await daemon.shutdown();
  await prepareW5FlipSpawn('2.6.0');
  expect(await readW5FlipBackupMarker()).toMatchObject({
    state: 'captured',
    capture: 'captured-after-flip',
    buildVersion: '2.6.0',
  });

  writeFileSync(join(dataDir, 'w5', 'flip-backup.json'), '{"version":2}');
  expect(await readW5FlipBackupMarker()).toMatchObject({ state: 'deferred' });
});

test('a respawn after this process stopped its log skips the capture where a daemon served W5', async () => {
  const dataDir = join(base, 'data');
  seed(dataDir);
  useRoot(dataDir);
  const daemon = hostAt(dataDir);
  await daemon.snapshot();
  // The attach path: deferred, then the in-process log stopped.
  await deferW5FlipBackup('2.5.0');
  await stopInProcessW5Host();
  // That daemon crashes; the lease's reconnect spawns another.
  await daemon.shutdown();
  await prepareW5FlipSpawn('2.5.0');
  expect(backups(dataDir)).toEqual([]);
  expect(await readW5FlipBackupMarker()).toMatchObject({
    state: 'deferred',
  });
});

test('a worker that does not stop fails the step, so nothing spawns', async () => {
  const dataDir = join(base, 'fresh');
  mkdirSync(dataDir);
  const host = useRoot(dataDir);
  jest.spyOn(host, 'runningWorkerCount', 'get').mockReturnValue(1);
  const error: unknown = await prepareW5FlipSpawn('2.5.0').then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(w5FlipStepFailure(error)).toEqual({
    failure: 'in_process_host_running',
  });
});
