import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  existsSync,
  symlinkSync,
} from 'node:fs';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:net';
import {
  W5CommitLog,
  applyW5Commit,
  fingerprintW5File,
  type W5CommitRequest,
  type W5PendingCommit,
} from '@canopy/desktop-shared/node/w5-commit-log';
import {
  createCanopyStartupClaimPort,
  type CanopyStartupProcessInspection,
  type CanopyStartupClaimPort,
} from '@canopy/core-transport/node';
import {
  hostPlatformServices,
  createPlatformEndpointServices,
  hostPlatformOperatingSystem,
} from '@canopy/core-platform';
import type {
  PlatformProcessInspection,
  PlatformServices,
} from '@canopy/core-runtime';
import type * as TsxWorkerThreads from '../../ledger/__tests__/fixtures/tsx-worker-threads';

jest.mock('node:worker_threads', () =>
  jest
    .requireActual<
      typeof TsxWorkerThreads
    >('../../ledger/__tests__/fixtures/tsx-worker-threads')
    .createTsxWorkerThreads(),
);
import type * as W5BackupModule from '../w5-backup';
import type {
  W5MaintenanceDecision,
  W5MaintenanceResult,
  W5MaintenanceRequest,
} from '../w5-maintenance';
import {
  W5CommitLogHost,
  W5CommitLogHostError,
} from '../../w5-commit-log/commit-log-host';
import {
  captureW5Backup,
  restoreW5Backup,
  type W5ExclusiveMaintenance,
} from '../w5-backup';
import {
  runW5Maintenance,
  W5MaintenanceDecisionError,
  W5MaintenanceRefusedError,
  type W5MaintenanceContext,
} from '../w5-maintenance';
import { W5_RESOLVABLE_RESERVATION_OPERATIONS } from '../w5-maintenance-decisions';
import { diagnoseW5State, type W5Diagnosis } from '../w5-maintenance-diagnosis';

jest.setTimeout(60_000);
// win32 refuses maintenance (CAN-3797 Q4a); only the refusal and the
// diagnosis scan run there.
const posix = process.platform === 'win32' ? test.skip : test;
let dir: string;
let root: string;
let dbPath: string;
let host: W5CommitLogHost;
let context: W5MaintenanceContext;
let other: CanopyStartupProcessInspection;
const otherOwner = { pid: 101, startIdentity: 'fixture-old-start' };
// Host cohort members (CAN-3797) by PID; others answer as `other`.
let memberInspections: Map<number, PlatformProcessInspection>;
const MEMBER_START_SECONDS = 1_790_000_000;
function putMember(
  pid: number,
  inspection?: PlatformProcessInspection,
): string {
  const name = `${String(pid).padStart(8, '0')}-0000-4000-8000-000000000000.json`;
  mkdirSync(join(dir, 'runtime/hosts'), { recursive: true, mode: 0o700 });
  writeFileSync(
    join(dir, 'runtime/hosts', name),
    JSON.stringify({
      version: 1,
      pid,
      startEstimateMs: MEMBER_START_SECONDS * 1000 + 400,
      hostKind: 'cli',
    }),
  );
  memberInspections.set(
    pid,
    inspection ?? {
      state: 'running',
      startIdentity: `darwin:v1:${pid}:${MEMBER_START_SECONDS}`,
    },
  );
  return join(dir, 'runtime/hosts', name);
}
const cohortRecord = (): string => join(dir, 'runtime/w5-maintenance.json');
const initial = new Map([
  [
    'index.json',
    '{ "version": 1, "workspaces": [{"id":"alpha","type":"single-repo","name":"Alpha","color":"#fff"},{"id":"beta","type":"cowork","name":"Beta","color":"#fff"}], "unknown": [1,2] }\n',
  ],
  ['index.json.bak', '{"version":1,"workspaces":[]}\n'],
  [
    'alpha/workspace.json',
    '{"version":1,"type":"single-repo","repos":[],"unknown":{"a":true}}\n',
  ],
  [
    'alpha/worktrees.json',
    '{"version":1,"worktrees":[{"id":"first","branchName":"main","createdAt":"2026-10-14T00:00:00Z","unknown":[7]}]}\n',
  ],
  ['beta/workspace.json', '{"version":1,"type":"cowork","unknown":"é 🦜"}\n'],
]);
function pendingCommit(log: W5CommitLog, id: number): W5PendingCommit {
  const pending = log.listPendingCommits().find((item) => item.commitId === id);
  if (!pending) throw new Error('missing fixture commit');
  return pending;
}
function put(path: string, bytes: string): void {
  mkdirSync(join(root, path, '..'), { recursive: true });
  writeFileSync(join(root, path), bytes);
}
function state(): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  function visit(path: string): void {
    for (const entry of readdirSync(join(dir, path), { withFileTypes: true })) {
      const next = join(path, entry.name);
      if (entry.isDirectory()) visit(next);
      else files.set(next, readFileSync(join(dir, next)));
    }
  }
  visit('workspaces');
  visit('w5');
  return files;
}
function claims(owner = otherOwner): CanopyStartupClaimPort {
  return createCanopyStartupClaimPort({
    dataRoot: dir,
    owner,
    inspectProcess: (pid) =>
      Promise.resolve(
        pid === process.pid
          ? { kind: 'alive', startIdentity: 'fixture-self-start' }
          : other,
      ),
  });
}
async function acquireOther(): Promise<object> {
  const result = await claims().tryAcquire();
  if (result.kind !== 'acquired') throw new Error('fixture acquisition failed');
  return result.handle;
}
async function diagnose(): Promise<W5MaintenanceResult> {
  return runW5Maintenance(context, {
    source: 'offline_maintenance',
    mode: 'diagnose',
  });
}
// The scan maintenance runs under its exclusion; win32 runs it directly.
async function diagnosis(): Promise<W5Diagnosis> {
  if (process.platform === 'win32') return diagnoseW5State(dir);
  const result = await diagnose();
  if (result.mode !== 'diagnose') throw new Error('Expected diagnosis');
  return result.diagnosis;
}
async function backup(): Promise<string> {
  const path = await captureW5Backup(context);
  await host.shutdown();
  host = new W5CommitLogHost({
    dbPath,
    root,
    workerEntry: join(__dirname, '../../w5-commit-log/commit-log-worker.ts'),
  });
  context = { ...context, host };
  return path;
}
function released(): void {
  expect(existsSync(cohortRecord())).toBe(false);
  expect(existsSync(join(dir, 'runtime/startup-claim.json'))).toBe(false);
  expect(existsSync(join(dir, 'runtime/startup-claim.guard'))).toBe(false);
}
beforeEach(async () => {
  // Canonical: maintenance requires realpath(dataRoot) === dataRoot, and
  // macOS's tmpdir is under the /var symlink.
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'w5-maintenance-')));
  root = join(dir, 'workspaces');
  dbPath = join(dir, 'w5/commit-log.sqlite');
  mkdirSync(join(dir, 'runtime'), { mode: 0o700 });
  for (const [path, bytes] of Array.from(initial)) put(path, bytes);
  const log = W5CommitLog.open(dbPath);
  const commit = log.commit({
    operation: 'fixture.initial',
    advance: [
      { kind: 'workspaces' },
      { kind: 'workspace', workspaceId: 'alpha' },
    ],
    files: Array.from(initial, ([path, contents]) => ({
      path: join(root, path),
      contents,
      previousFingerprint: null,
    })),
    outcome: null,
  });
  await applyW5Commit(log, pendingCommit(log, commit.commitId), { root });
  log.close();
  host = new W5CommitLogHost({
    dbPath,
    root,
    workerEntry: join(__dirname, '../../w5-commit-log/commit-log-worker.ts'),
  });
  const os = hostPlatformOperatingSystem();
  const platform = hostPlatformServices(createPlatformEndpointServices(os));
  const supervision: PlatformServices['supervision'] = {
    ...platform.supervision,
    inspectProcess: ({ pid }) => {
      if (pid === process.pid)
        return Promise.resolve({
          state: 'running',
          startIdentity: 'fixture-self-start',
        });
      const member = memberInspections.get(pid);
      if (member) return Promise.resolve(member);
      if (other.kind === 'alive')
        return Promise.resolve({
          state: 'running',
          startIdentity: other.startIdentity,
        });
      if (other.kind === 'dead') return Promise.resolve({ state: 'absent' });
      return Promise.resolve({
        state: 'unverifiable',
        reason: 'fixture identity unavailable',
      });
    },
  };
  context = { host, dataRoot: dir, platform: { ...platform, supervision } };
  other = { kind: 'alive', startIdentity: otherOwner.startIdentity };
  memberInspections = new Map();
});
afterEach(async () => {
  jest.restoreAllMocks();
  await host.shutdown();
  rmSync(dir, { recursive: true, force: true });
});

posix.each(['alive', 'unknown'] as const)(
  'refuses a %s holder before W5 writes or worker startup, even without discovery',
  async (kind) => {
    await acquireOther();
    other =
      kind === 'alive'
        ? { kind, startIdentity: otherOwner.startIdentity }
        : { kind };
    const before = state();
    const record = readFileSync(join(dir, 'runtime/startup-claim.json'));
    await expect(diagnose()).rejects.toMatchObject({
      reason: kind === 'alive' ? 'claim-held' : 'claim-ambiguous',
    });
    expect(state()).toEqual(before);
    expect(readFileSync(join(dir, 'runtime/startup-claim.json'))).toEqual(
      record,
    );
    expect(host.workersStarted).toBe(0);
  },
);

posix.each([
  { kind: 'dead' },
  { kind: 'alive', startIdentity: 'fixture-reused-pid' },
] satisfies CanopyStartupProcessInspection[])(
  'recovers a proven departed holder (%j) and fences old handoff',
  async (inspection) => {
    const old = await acquireOther();
    other = inspection;
    const before = state();
    const result = await diagnose();
    expect(result).toMatchObject({
      mode: 'diagnose',
      diagnosis: { files: [], logIssue: null, commits: [], reservations: [] },
    });
    expect(state()).toEqual(before);
    released();
    await expect(claims().adopt(old)).resolves.toEqual({ kind: 'ambiguous' });
  },
);

posix(
  'keeps the claim when a writer worker has not confirmed its exit',
  async () => {
    // A worker that started during maintenance and outlived the bounded
    // shutdown wait.
    jest
      .spyOn(host, 'workersStarted', 'get')
      .mockReturnValueOnce(0)
      .mockReturnValue(1);
    const shutdown = jest.spyOn(host, 'shutdown').mockResolvedValue();
    const running = jest
      .spyOn(host, 'runningWorkerCount', 'get')
      .mockReturnValue(1);
    await expect(diagnose()).rejects.toMatchObject({
      reason: 'writer-exit-unconfirmed',
    });
    expect(shutdown).toHaveBeenCalled();
    expect(existsSync(cohortRecord())).toBe(true);
    expect(existsSync(join(dir, 'runtime/startup-claim.json'))).toBe(true);
    jest.restoreAllMocks();
    running.mockRestore();
  },
);

test('reports corrupt, missing and unknown files plus log mismatches without changing bytes', async () => {
  put('alpha/workspace.json', '{broken');
  put('alpha/surprise.txt', 'keep me');
  put('mystery.bin', 'unknown');
  writeFileSync(join(dir, 'w5/unknown.bin'), 'retain');
  rmSync(join(root, 'alpha/worktrees.json'));
  const before = state();
  const result = await diagnosis();
  for (const issue of [
    { path: 'alpha/workspace.json', reason: 'corrupt-file' },
    { path: 'alpha/workspace.json', reason: 'log-mismatch' },
    { path: 'alpha/worktrees.json', reason: 'missing-file' },
    { path: 'alpha/surprise.txt', reason: 'unknown-artifact' },
    { path: 'mystery.bin', reason: 'unknown-artifact' },
    { path: 'w5/unknown.bin', reason: 'unknown-artifact' },
  ])
    expect(result.files).toContainEqual(issue);
  expect(state()).toEqual(before);
  expect(host.workersStarted).toBe(0);
  released();
});

test('recognizes destructive lifecycle journals without a false unknown-artifact issue', async () => {
  const journals = join(dir, 'w5/destructive-lifecycles');
  mkdirSync(journals);
  writeFileSync(join(journals, `${'a'.repeat(64)}.json`), '{not parsed');
  writeFileSync(
    join(journals, '12345678-1234-4234-8234-123456789abc.json'),
    '{"state":"completed"}',
  );
  const before = state();
  const read = jest.spyOn(fs, 'readFile');
  const result = await diagnosis();
  expect(result.files).toEqual([]);
  expect(result.destructiveJournalArtifactCount).toBe(2);
  expect(
    read.mock.calls.filter(
      ([path]) =>
        (typeof path === 'string' || Buffer.isBuffer(path)) &&
        path.toString().startsWith(journals),
    ),
  ).toEqual([]);
  expect(state()).toEqual(before);
  expect(host.workersStarted).toBe(0);
  released();
});

test.each([
  'ABCDEFAB-1234-4234-ABCD-123456789ABC',
  'AbCdEfAb-1234-4234-aBcD-123456789aBc',
  '00000000-0000-0000-0000-000000000000',
  'ffffffff-ffff-ffff-ffff-ffffffffffff',
])('recognizes schema-valid retained UUID %s', async (id) => {
  const journals = join(dir, 'w5/destructive-lifecycles');
  mkdirSync(journals);
  for (const name of [
    id,
    'a'.repeat(64),
    '12345678-1234-4234-8234-123456789abc',
  ])
    writeFileSync(join(journals, `${name}.json`), '{not parsed');
  const before = state();
  const read = jest.spyOn(fs, 'readFile');
  const result = await diagnosis();
  expect(result.files).toEqual([]);
  expect(result.destructiveJournalArtifactCount).toBe(3);
  expect(
    read.mock.calls.filter(
      ([path]) =>
        (typeof path === 'string' || Buffer.isBuffer(path)) &&
        path.toString().startsWith(journals),
    ),
  ).toEqual([]);
  expect(state()).toEqual(before);
  expect(host.workersStarted).toBe(0);
  released();
});

test.each([
  '-'.repeat(36),
  'a'.repeat(36),
  '1234567-81234-4234-8234-123456789abc',
  '12345678-1234-0234-8234-123456789abc',
  '12345678-1234-9234-8234-123456789abc',
  '12345678-1234-f234-8234-123456789abc',
  '12345678-1234-4234-1234-123456789abc',
  '12345678-1234-4234-7234-123456789abc',
  '12345678-1234-4234-c234-123456789abc',
  'FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF',
  'fFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF',
])('reports malformed retained journal name %s as unknown', async (name) => {
  const journals = join(dir, 'w5/destructive-lifecycles');
  mkdirSync(journals);
  for (const id of [
    name,
    'a'.repeat(64),
    '12345678-1234-4234-8234-123456789abc',
  ])
    writeFileSync(join(journals, `${id}.json`), '{not parsed');
  const before = state();
  const read = jest.spyOn(fs, 'readFile');
  const result = await diagnosis();
  expect(result.files).toEqual([
    {
      path: `w5/destructive-lifecycles/${name}.json`,
      reason: 'unknown-artifact',
    },
  ]);
  expect(result.destructiveJournalArtifactCount).toBe(2);
  expect(
    read.mock.calls.filter(
      ([path]) =>
        (typeof path === 'string' || Buffer.isBuffer(path)) &&
        path.toString().startsWith(journals),
    ),
  ).toEqual([]);
  expect(state()).toEqual(before);
  expect(host.workersStarted).toBe(0);
  released();
});

test.each(['absent', 'empty'] as const)(
  'reports zero destructive journal artifacts for an %s directory',
  async (kind) => {
    if (kind === 'empty') mkdirSync(join(dir, 'w5/destructive-lifecycles'));
    const before = state();
    await expect(diagnosis()).resolves.toMatchObject({
      destructiveJournalArtifactCount: 0,
      files: [],
      logIssue: null,
    });
    expect(state()).toEqual(before);
    released();
  },
);

test.each(['missing', 'incompatible', 'corrupt'] as const)(
  'counts destructive journal artifacts independently of a %s SQLite log',
  async (kind) => {
    const journals = join(dir, 'w5/destructive-lifecycles');
    mkdirSync(journals);
    writeFileSync(join(journals, `${'b'.repeat(64)}.json`), '');
    writeFileSync(
      join(journals, '12345678-1234-4234-8234-123456789abc.json'),
      '{malformed',
    );
    if (kind === 'missing') rmSync(dbPath);
    else if (kind === 'corrupt') writeFileSync(dbPath, 'not SQLite');
    else {
      const db = new DatabaseSync(dbPath);
      db.exec("UPDATE w5_meta SET value = '999' WHERE key = 'schema_version'");
      db.close();
    }
    const before = state();
    await expect(diagnosis()).resolves.toMatchObject({
      destructiveJournalArtifactCount: 2,
      files: [],
      logIssue: kind === 'incompatible' ? 'incompatible-schema' : 'unavailable',
    });
    expect(state()).toEqual(before);
    expect(host.workersStarted).toBe(0);
    released();
  },
);

test('reports unexpected journal entries without following links or recursing', async () => {
  const journals = join(dir, 'w5/destructive-lifecycles');
  mkdirSync(journals);
  const valid = `${'a'.repeat(64)}.json`;
  writeFileSync(join(journals, valid), 'count only');
  const unexpected = [
    'notes.txt',
    `${'a'.repeat(63)}.json`,
    `${'a'.repeat(65)}.json`,
    `${'E'.repeat(64)}.json`,
    `${'b'.repeat(64)}.json.tmp`,
    `${'c'.repeat(64)}.json`,
    `${'d'.repeat(64)}.json`,
    '12345678-1234-1234-1234-123456789ab.json',
    '12345678-1234-1234-1234-123456789abcd.json',
  ];
  for (const name of unexpected.slice(0, 5))
    writeFileSync(join(journals, name), 'retain');
  mkdirSync(join(journals, unexpected[5]));
  writeFileSync(join(journals, unexpected[5], valid), 'do not recurse');
  symlinkSync(join(journals, valid), join(journals, unexpected[6]));
  for (const name of unexpected.slice(7))
    writeFileSync(join(journals, name), 'retain');
  const before = state();
  const result = await diagnosis();
  expect(result.destructiveJournalArtifactCount).toBe(1);
  expect(result.logIssue).toBeNull();
  expect(result.files).toEqual(
    unexpected
      .map((name) => ({
        path: `w5/destructive-lifecycles/${name}`,
        reason: 'unknown-artifact',
      }))
      .sort((a, b) => a.path.localeCompare(b.path)),
  );
  expect(state()).toEqual(before);
  released();
});

test.each(['file', 'symlink', 'dangling-symlink'] as const)(
  'does not treat a %s as the destructive journal directory',
  async (kind) => {
    const journals = join(dir, 'w5/destructive-lifecycles');
    const target = join(dir, 'retained-journals');
    if (kind === 'file') writeFileSync(journals, 'retain');
    else {
      if (kind === 'symlink') {
        mkdirSync(target);
        writeFileSync(join(target, `${'a'.repeat(64)}.json`), 'do not follow');
      }
      symlinkSync(target, journals, 'junction');
    }
    const scan = jest.spyOn(fs, 'readdir');
    await expect(diagnosis()).resolves.toMatchObject({
      destructiveJournalArtifactCount: null,
      logIssue: null,
      files: [
        { path: 'w5/destructive-lifecycles', reason: 'unknown-artifact' },
      ],
    });
    expect(
      scan.mock.calls.some(([path]) => path === journals || path === target),
    ).toBe(false);
    released();
  },
);

test('surfaces an unreadable journal directory without hiding SQLite diagnostics', async () => {
  const journals = join(dir, 'w5/destructive-lifecycles');
  mkdirSync(journals);
  const readdir = fs.readdir;
  jest.spyOn(fs, 'readdir').mockImplementation((path, options) => {
    if (path === journals)
      return Promise.reject(
        Object.assign(new Error('unreadable'), { code: 'EACCES' }),
      );
    return readdir(path, options);
  });
  await expect(diagnosis()).resolves.toMatchObject({
    destructiveJournalArtifactCount: null,
    logIssue: null,
    files: [{ path: 'w5/destructive-lifecycles', reason: 'corrupt-file' }],
  });
  released();
});

test('surfaces uninspectable journal metadata without hiding SQLite diagnostics', async () => {
  const journals = join(dir, 'w5/destructive-lifecycles');
  mkdirSync(journals);
  writeFileSync(join(journals, `${'a'.repeat(64)}.json`), 'retain');
  const before = state();
  const lstat = fs.lstat;
  jest.spyOn(fs, 'lstat').mockImplementation((path, options) => {
    if (path === journals)
      return Promise.reject(
        Object.assign(new Error('uninspectable'), { code: 'EACCES' }),
      );
    return lstat(path, options);
  });
  const scan = jest.spyOn(fs, 'readdir');
  await expect(diagnosis()).resolves.toMatchObject({
    destructiveJournalArtifactCount: null,
    logIssue: null,
    files: [{ path: 'w5/destructive-lifecycles', reason: 'corrupt-file' }],
  });
  expect(scan.mock.calls.some(([path]) => path === journals)).toBe(false);
  expect(state()).toEqual(before);
  expect(host.workersStarted).toBe(0);
  released();
});

function interruptCommitAndReservation(): number {
  const log = W5CommitLog.open(dbPath);
  const pending = log.commit({
    operation: 'fixture.interrupted',
    advance: [],
    files: [],
    outcome: null,
  });
  log.markCommitRecoveryRequired(pending.commitId, { reason: 'fixture' });
  log.reserve({
    reservationId: 'interrupted-clone',
    operation: 'clone',
    diagnostics: { preserve: true },
  });
  log.close();
  return pending.commitId;
}

test('reports pending commits and uncertain reservations without recovering or compensating them', async () => {
  const commitId = interruptCommitAndReservation();
  const before = state();
  await expect(diagnosis()).resolves.toMatchObject({
    commits: [
      {
        commitId,
        operation: 'fixture.interrupted',
        state: 'recovery-required',
        diagnostics: '{"reason":"fixture"}',
        receiptOperations: [],
      },
    ],
    reservations: [
      {
        reservationId: 'interrupted-clone',
        operation: 'clone',
        state: 'reserved',
        diagnostics: '{"preserve":true}',
      },
    ],
  });
  expect(state()).toEqual(before);
  released();
});

posix(
  'restore refuses while a commit is pending recovery, without changing W5 files',
  async () => {
    const path = await backup();
    interruptCommitAndReservation();
    const before = state();
    await expect(
      runW5Maintenance(context, {
        source: 'offline_maintenance',
        mode: 'restore',
        backupPath: path,
      }),
    ).rejects.toMatchObject({ reason: 'recovery-required' });
    expect(state()).toEqual(before);
    released();
  },
);

posix(
  'restores a verified backup while the claim blocks start, then revokes admission and releases',
  async () => {
    const path = await backup();
    put('alpha/workspace.json', '{broken');
    put('alpha/unknown.txt', 'retain');
    let retained: W5ExclusiveMaintenance | undefined;
    const commit = host.commit.bind(host);
    jest.spyOn(host, 'commit').mockImplementationOnce(async (request) => {
      await expect(claims().tryAcquire()).resolves.toEqual({ kind: 'held' });
      return commit(request);
    });
    // Observe the real entrypoint's capability only to prove it cannot escape.
    const backupModule =
      jest.requireActual<typeof W5BackupModule>('../w5-backup');
    const restore = backupModule.restoreW5Backup;
    jest
      .spyOn(backupModule, 'restoreW5Backup')
      .mockImplementation(async (ctx, request) => {
        retained = request.exclusive;
        return restore(ctx, request);
      });
    await expect(
      runW5Maintenance(context, {
        source: 'offline_maintenance',
        mode: 'restore',
        backupPath: path,
        unreadableOverride: 'fixture operator recovery',
      }),
    ).resolves.toMatchObject({ mode: 'restore', commitId: 2 });
    for (const [file, bytes] of Array.from(initial))
      expect(readFileSync(join(root, file), 'utf8')).toBe(bytes);
    expect(readFileSync(join(root, 'alpha/unknown.txt'), 'utf8')).toBe(
      'retain',
    );
    released();
    if (!retained) throw new Error('missing observed admission');
    await expect(
      restoreW5Backup(context, {
        source: 'offline_maintenance',
        backupPath: path,
        exclusive: retained,
      }),
    ).rejects.toMatchObject({ reason: 'exclusive-required' });
  },
);

posix.each(['newer-writes', 'schema-downgrade', 'corrupt-backup'] as const)(
  'restore refuses %s with files unchanged and releases on failure',
  async (reason) => {
    const path = await backup();
    if (reason === 'newer-writes') {
      const log = W5CommitLog.open(dbPath);
      const next = '{"version":1,"newer":true}';
      const decision = log.commit({
        operation: 'fixture.newer',
        advance: [{ kind: 'workspace', workspaceId: 'alpha' }],
        files: [
          {
            path: join(root, 'alpha/workspace.json'),
            contents: next,
            previousFingerprint: fingerprintW5File(
              initial.get('alpha/workspace.json') ?? null,
            ),
          },
        ],
        outcome: null,
      });
      await applyW5Commit(log, pendingCommit(log, decision.commitId), { root });
      log.close();
    } else if (reason === 'schema-downgrade')
      put('alpha/workspace.json', '{"version":2}');
    else
      writeFileSync(join(dir, path, 'files/alpha/workspace.json'), '{broken');
    const before = state();
    await expect(
      runW5Maintenance(context, {
        source: 'offline_maintenance',
        mode: 'restore',
        backupPath: path,
      }),
    ).rejects.toMatchObject({ reason });
    expect(state()).toEqual(before);
    released();
  },
);

posix(
  'restart recovers an interrupted maintenance lineage that never released',
  async () => {
    const abandoned = await acquireOther();
    other = { kind: 'dead' };
    await diagnose();
    released();
    expect(await claims().release(abandoned)).toBe('not_owner');
    await diagnose();
    released();
  },
);

posix(
  'live endpoint refuses even when the claim and descriptor are absent',
  async () => {
    const endpoint = context.platform.endpoints.address({
      dataRoot: dir,
      endpointName: 'core',
    });
    const server = createServer((socket) => socket.destroy());
    await new Promise<void>((resolve) => server.listen(endpoint.path, resolve));
    const before = state();
    try {
      await expect(diagnose()).rejects.toMatchObject({
        reason: 'endpoint-unavailable',
      });
      expect(state()).toEqual(before);
      released();
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
);

posix(
  'unprovable self identity and interrupted acquisition refuse before W5 writes',
  async () => {
    const before = state();
    const platform = {
      ...context.platform,
      supervision: {
        ...context.platform.supervision,
        inspectProcess: (): Promise<{
          state: 'unverifiable';
          reason: string;
        }> =>
          Promise.resolve({
            state: 'unverifiable',
            reason: 'fixture identity unavailable',
          }),
      },
    };
    await expect(
      runW5Maintenance(
        { ...context, platform },
        { source: 'offline_maintenance', mode: 'diagnose' },
      ),
    ).rejects.toMatchObject({ reason: 'identity-unprovable' });
    const abort = new AbortController();
    abort.abort(new Error('fixture interruption'));
    await expect(
      runW5Maintenance(
        context,
        { source: 'offline_maintenance', mode: 'diagnose' },
        abort.signal,
      ),
    ).rejects.toThrow('fixture interruption');
    expect(state()).toEqual(before);
    released();
  },
);

test('missing and incompatible logs are diagnosed, never initialized or migrated', async () => {
  const db = new DatabaseSync(dbPath);
  db.prepare(
    "UPDATE w5_meta SET value = '999' WHERE key = 'schema_version'",
  ).run();
  db.close();
  const before = state();
  await expect(diagnosis()).resolves.toMatchObject({
    logIssue: 'incompatible-schema',
  });
  expect(state()).toEqual(before);
  rmSync(dbPath);
  await expect(diagnosis()).resolves.toMatchObject({
    logIssue: 'unavailable',
  });
  expect(existsSync(dbPath)).toBe(false);
  released();
});

// Request validation precedes the win32 refusal, so this runs everywhere.
test('invalid requests refuse without changing W5 files', async () => {
  const before = state();
  const request: W5MaintenanceRequest = {
    source: 'offline_maintenance',
    mode: 'diagnose',
  };
  Object.defineProperty(request, 'source', { value: 'untrusted' });
  await expect(runW5Maintenance(context, request)).rejects.toMatchObject({
    reason: 'invalid-request',
  });
  expect(state()).toEqual(before);
  expect(readdirSync(join(dir, 'runtime'))).toEqual([]);
});

posix('non-private runtime refuses without changing W5 files', async () => {
  const before = state();
  rmSync(join(dir, 'runtime'), { recursive: true });
  await expect(diagnose()).rejects.toMatchObject({
    reason: 'runtime-unavailable',
  });
  expect(state()).toEqual(before);
  released();
});

posix(
  'an already-started writer host is refused before maintenance takes the claim',
  async () => {
    await host.snapshot();
    const before = state();
    await expect(diagnose()).rejects.toMatchObject({ reason: 'writer-active' });
    expect(state()).toEqual(before);
    released();
  },
);

posix(
  'loss of provable claim identity refuses before inspection or restore',
  async () => {
    const before = state();
    const inspect = context.platform.supervision.inspectProcess.bind(
      context.platform.supervision,
    );
    let calls = 0;
    jest
      .spyOn(context.platform.supervision, 'inspectProcess')
      .mockImplementation((request) => {
        calls += 1;
        return calls === 1
          ? inspect(request)
          : Promise.resolve({
              state: 'unverifiable',
              reason: 'fixture identity unavailable',
            });
      });
    await expect(diagnose()).rejects.toMatchObject({ reason: 'claim-lost' });
    expect(state()).toEqual(before);
    released();
  },
);

posix(
  'uncertain release retains the interrupted lineage for proven-departed restart recovery',
  async () => {
    const before = state();
    const unlink = fs.unlink;
    jest.spyOn(fs, 'unlink').mockImplementation((path) => {
      if (String(path).endsWith('startup-claim.json'))
        return Promise.reject(new Error('fixture interruption before release'));
      return unlink(path);
    });
    await expect(diagnose()).rejects.toMatchObject({
      reason: 'release-uncertain',
    });
    expect(state()).toEqual(before);
    expect(existsSync(join(dir, 'runtime/startup-claim.json'))).toBe(true);
    jest.restoreAllMocks();
    // Process-start identity changes on restart. The PID may be reused.
    const inspect = context.platform.supervision.inspectProcess.bind(
      context.platform.supervision,
    );
    context = {
      ...context,
      platform: {
        ...context.platform,
        supervision: {
          ...context.platform.supervision,
          inspectProcess: (
            request,
          ): ReturnType<PlatformServices['supervision']['inspectProcess']> =>
            request.pid === process.pid
              ? Promise.resolve({
                  state: 'running',
                  startIdentity: 'fixture-restart-start',
                })
              : inspect(request),
        },
      },
    };
    await diagnose();
    released();
  },
);

posix.each(['live', 'unknown', 'dead'] as const)(
  'descriptor with %s identity is checked even when its endpoint is absent',
  async (ownerState) => {
    const address = context.platform.endpoints.address({
      dataRoot: dir,
      endpointName: 'core',
    });
    writeFileSync(
      join(dir, 'runtime/core.json'),
      JSON.stringify({
        version: 1,
        pid: otherOwner.pid,
        startIdentity: otherOwner.startIdentity,
        buildVersion: 'fixture',
        protocolRange: { min: 1, max: 1 },
        tokenRef: join(dir, 'runtime/core-fixture.token'),
        endpoint: { kind: 'socket', path: address.path },
      }),
      { mode: 0o600 },
    );
    const descriptor = readFileSync(join(dir, 'runtime/core.json'));
    other =
      ownerState === 'live'
        ? { kind: 'alive', startIdentity: otherOwner.startIdentity }
        : { kind: ownerState };
    const before = state();
    if (ownerState === 'dead') await diagnose();
    else
      await expect(diagnose()).rejects.toMatchObject({
        reason: 'identity-unprovable',
      });
    expect(state()).toEqual(before);
    expect(readFileSync(join(dir, 'runtime/core.json'))).toEqual(descriptor);
    released();
  },
);

posix(
  'an ambiguous endpoint retains recovered bind evidence and both refusal diagnostics',
  async () => {
    const abandoned = await acquireOther();
    expect(await claims().markEndpointBind(abandoned)).toBe(true);
    other = { kind: 'dead' };
    const address = context.platform.endpoints.address({
      dataRoot: dir,
      endpointName: 'core',
    });
    writeFileSync(address.path, 'unrecognized endpoint artifact');
    const before = state();
    await expect(diagnose()).rejects.toMatchObject({
      reason: 'release-uncertain',
      operationError: { reason: 'endpoint-unavailable' },
    });
    expect(state()).toEqual(before);
    expect(readFileSync(address.path, 'utf8')).toBe(
      'unrecognized endpoint artifact',
    );
    const record: unknown = JSON.parse(
      readFileSync(join(dir, 'runtime/startup-claim.json'), 'utf8'),
    );
    expect(record).toMatchObject({ endpointBound: true });
  },
);

describe('host cohort (CAN-3797)', () => {
  posix.each([
    ['live', undefined],
    ['unknown', { state: 'unverifiable', reason: 'fixture' }],
  ] satisfies [string, PlatformProcessInspection | undefined][])(
    'a %s registered host refuses before W5 writes, withdrawing the record and the claim',
    async (_, inspection) => {
      const member = putMember(4242, inspection);
      const before = state();
      await expect(diagnose()).rejects.toMatchObject({ reason: 'host-active' });
      expect(state()).toEqual(before);
      expect(existsSync(member)).toBe(true);
      expect(host.workersStarted).toBe(0);
      released();
    },
  );

  posix.each([
    ['exited', { state: 'absent' }],
    [
      'PID-reused',
      { state: 'running', startIdentity: 'darwin:v1:4242:1700000000' },
    ],
  ] satisfies [string, PlatformProcessInspection][])(
    'prunes an %s host and proceeds',
    async (_, inspection) => {
      const member = putMember(4242, inspection);
      await expect(diagnose()).resolves.toMatchObject({ mode: 'diagnose' });
      expect(existsSync(member)).toBe(false);
      released();
    },
  );

  posix(
    'checks the cohort only after the endpoint and descriptor',
    async () => {
      const member = putMember(4242);
      const endpoint = context.platform.endpoints.address({
        dataRoot: dir,
        endpointName: 'core',
      });
      writeFileSync(endpoint.path, 'unrecognized endpoint artifact');
      await expect(diagnose()).rejects.toMatchObject({
        reason: 'endpoint-unavailable',
      });
      expect(existsSync(member)).toBe(true);
      released();
    },
  );

  posix(
    'replaces the record a crashed maintenance left and releases it',
    async () => {
      writeFileSync(
        cohortRecord(),
        JSON.stringify({
          version: 1,
          pid: otherOwner.pid,
          startIdentity: otherOwner.startIdentity,
          token: '12345678-1234-4234-8234-123456789abc',
        }),
      );
      other = { kind: 'dead' };
      await diagnose();
      released();
    },
  );

  posix(
    'refuses while an earlier maintenance record is unprovable',
    async () => {
      writeFileSync(cohortRecord(), '{"version":1,"pid":');
      await expect(diagnose()).rejects.toMatchObject({
        reason: 'cohort-ambiguous',
      });
      expect(readFileSync(cohortRecord(), 'utf8')).toBe('{"version":1,"pid":');
      expect(existsSync(join(dir, 'runtime/startup-claim.json'))).toBe(false);
    },
  );

  posix(
    'restore refuses once the record no longer names this maintenance',
    async () => {
      const path = await backup();
      put('alpha/workspace.json', '{broken');
      const backupModule =
        jest.requireActual<typeof W5BackupModule>('../w5-backup');
      const restore = backupModule.restoreW5Backup;
      jest
        .spyOn(backupModule, 'restoreW5Backup')
        .mockImplementation(async (ctx, request) => {
          writeFileSync(
            cohortRecord(),
            JSON.stringify({
              version: 1,
              pid: process.pid,
              startIdentity: 'fixture-self-start',
              token: '12345678-1234-4234-8234-123456789abc',
            }),
          );
          return restore(ctx, request);
        });
      const before = state();
      await expect(
        runW5Maintenance(context, {
          source: 'offline_maintenance',
          mode: 'restore',
          backupPath: path,
        }),
      ).rejects.toMatchObject({ reason: 'exclusive-required' });
      expect(state()).toEqual(before);
      // The foreign token stays; the claim is still released.
      expect(existsSync(cohortRecord())).toBe(true);
      expect(existsSync(join(dir, 'runtime/startup-claim.json'))).toBe(false);
    },
  );

  // Electron continues unregistered where its registration fails for any
  // reason but maintenance (w5-host-admission.ts), so maintenance must refuse
  // those roots too.
  posix(
    'refuses a linked runtime folder, where no host can register',
    async () => {
      const elsewhere = realpathSync(
        mkdtempSync(join(tmpdir(), 'w5-runtime-')),
      );
      try {
        rmSync(join(dir, 'runtime'), { recursive: true });
        symlinkSync(elsewhere, join(dir, 'runtime'));
        const before = state();
        await expect(diagnose()).rejects.toMatchObject({
          reason: 'runtime-unavailable',
        });
        expect(state()).toEqual(before);
        expect(readdirSync(elsewhere)).toEqual([]);
        expect(host.workersStarted).toBe(0);
      } finally {
        rmSync(elsewhere, { recursive: true, force: true });
      }
    },
  );

  posix('refuses where hard links fail, before any W5 write', async () => {
    jest
      .spyOn(fs, 'link')
      .mockRejectedValue(
        Object.assign(new Error('fixture: no hard links'), { code: 'ENOTSUP' }),
      );
    const before = state();
    await expect(diagnose()).rejects.toThrow();
    expect(state()).toEqual(before);
    expect(existsSync(cohortRecord())).toBe(false);
    expect(host.workersStarted).toBe(0);
  });

  posix('an uncertain record removal keeps the claim', async () => {
    const unlink = fs.unlink;
    jest.spyOn(fs, 'unlink').mockImplementation((path) => {
      if (String(path).endsWith('w5-maintenance.json'))
        return Promise.reject(new Error('fixture interruption'));
      return unlink(path);
    });
    await expect(diagnose()).rejects.toMatchObject({
      reason: 'release-uncertain',
    });
    expect(existsSync(cohortRecord())).toBe(true);
    expect(existsSync(join(dir, 'runtime/startup-claim.json'))).toBe(true);
  });

  // Runs natively on win32; elsewhere it simulates win32.
  test.each([
    { source: 'offline_maintenance', mode: 'diagnose' },
    {
      source: 'offline_maintenance',
      mode: 'restore',
      backupPath: 'w5-backups/never-read',
    },
    {
      source: 'offline_maintenance',
      mode: 'resolve',
      decisions: [{ kind: 'abandon-commit', commitId: 1 }],
    },
  ] satisfies W5MaintenanceRequest[])(
    'refuses $mode on win32 before touching W5 files, the claim or the cohort',
    async (request) => {
      const before = state();
      const platform = Object.getOwnPropertyDescriptor(process, 'platform');
      Object.defineProperty(process, 'platform', { value: 'win32' });
      try {
        await expect(runW5Maintenance(context, request)).rejects.toMatchObject({
          reason: 'platform-unsupported',
        });
      } finally {
        if (platform) Object.defineProperty(process, 'platform', platform);
      }
      expect(state()).toEqual(before);
      expect(readdirSync(join(dir, 'runtime'))).toEqual([]);
      expect(host.workersStarted).toBe(0);
    },
  );
});

describe('resolve decisions (RX2)', () => {
  const MANIFEST = 'alpha/workspace.json';
  const ORIGINAL = initial.get(MANIFEST) ?? '';
  const NEXT = '{"version":1,"type":"single-repo","repos":[],"renamed":true}\n';
  const FOREIGN = '{"version":1,"type":"single-repo","repos":[],"foreign":1}\n';
  const ALPHA = { kind: 'workspace', workspaceId: 'alpha' } as const;
  // A 1D operation's keyed receipt (`core.workspace.update`).
  const RECEIPT = {
    caller: 'desktop-host:workspace-metadata',
    operation: 'core.workspace.update',
    idempotencyKey: 'rx2-key',
    fingerprint: 'rx2-fingerprint',
  };
  const manifest = (): string => readFileSync(join(root, MANIFEST), 'utf8');

  function manifestChange(
    contents: string,
    previous: string | null,
  ): W5CommitRequest {
    return {
      operation: RECEIPT.operation,
      advance: [ALPHA],
      files: [
        {
          path: join(root, MANIFEST),
          contents,
          previousFingerprint: fingerprintW5File(previous),
        },
      ],
      outcome: { workspaceId: 'alpha' },
    };
  }

  /** A commit whose file changed out of band before it applied, keyed by default. */
  async function wedgedCommit(
    operation = RECEIPT.operation,
    keyed = true,
  ): Promise<number> {
    const log = W5CommitLog.open(dbPath);
    try {
      const decision = log.commit({
        ...manifestChange(NEXT, ORIGINAL),
        operation,
        ...(keyed ? { receipt: { ...RECEIPT, operation } } : {}),
      });
      put(MANIFEST, FOREIGN);
      await expect(
        applyW5Commit(log, pendingCommit(log, decision.commitId), { root }),
      ).resolves.toMatchObject({ status: 'recovery-required' });
      return decision.commitId;
    } finally {
      log.close();
    }
  }

  /** Keyed by its ID for a 1D operation; `interrupted` as after a crash. */
  function reservation(
    reservationId: string,
    operation: string,
    interrupted = true,
  ): void {
    const log = W5CommitLog.open(dbPath);
    log.reserve({
      reservationId,
      operation,
      receipt:
        operation === RECEIPT.operation
          ? { ...RECEIPT, idempotencyKey: reservationId }
          : undefined,
      diagnostics: { fixture: true },
    });
    if (interrupted) log.markInterruptedReservations();
    log.close();
  }

  function resolveWith(
    decisions: readonly W5MaintenanceDecision[],
    signal?: AbortSignal,
  ): Promise<W5MaintenanceResult> {
    return runW5Maintenance(
      context,
      { source: 'offline_maintenance', mode: 'resolve', decisions },
      signal,
    );
  }

  function restoreFrom(backupPath: string): Promise<W5MaintenanceResult> {
    return runW5Maintenance(context, {
      source: 'offline_maintenance',
      mode: 'restore',
      backupPath,
    });
  }

  /** Maintenance shuts its cold host down; later writers need a new one. */
  function reopen(): W5CommitLogHost {
    host = new W5CommitLogHost({
      dbPath,
      root,
      workerEntry: join(__dirname, '../../w5-commit-log/commit-log-worker.ts'),
    });
    context = { ...context, host };
    return host;
  }

  async function failureOf(promise: Promise<unknown>): Promise<unknown> {
    try {
      await promise;
    } catch (error) {
      return error;
    }
    throw new Error('Expected a failure');
  }

  // Request validation precedes the win32 refusal, so this runs everywhere.
  test.each([
    ['no decisions', undefined],
    ['an empty list', []],
    ['a non-list', 'abandon'],
    ['a null decision', [null]],
    ['an unknown kind', [{ kind: 'rollback', commitId: 2 }]],
    [
      'an empty reservation ID',
      [{ kind: 'resolve-reservation', reservationId: '' }],
    ],
    ['a zero commit ID', [{ kind: 'retry-commit', commitId: 0 }]],
    ['a fractional commit ID', [{ kind: 'abandon-commit', commitId: 1.5 }]],
    ['a string commit ID', [{ kind: 'abandon-commit', commitId: '2' }]],
    [
      'an extra field',
      [{ kind: 'resolve-reservation', reservationId: 'a', commitId: 2 }],
    ],
    [
      'one target twice',
      [
        { kind: 'retry-commit', commitId: 2 },
        { kind: 'abandon-commit', commitId: 2 },
      ],
    ],
    [
      'inherited fields',
      [Object.create({ kind: 'retry-commit', commitId: 2 })],
    ],
    ['a list as a decision', [['retry-commit', 2]]],
    [
      'a throwing field',
      [
        Object.defineProperty({ commitId: 2 }, 'kind', {
          enumerable: true,
          get: () => {
            throw new Error('fixture getter');
          },
        }),
      ],
    ],
  ])('refuses %s as invalid-request before the claim', async (_, value) => {
    const before = state();
    const request: W5MaintenanceRequest = {
      source: 'offline_maintenance',
      mode: 'resolve',
      decisions: [{ kind: 'abandon-commit', commitId: 2 }],
    };
    Object.defineProperty(request, 'decisions', { value });
    await expect(runW5Maintenance(context, request)).rejects.toMatchObject({
      reason: 'invalid-request',
    });
    expect(state()).toEqual(before);
    expect(readdirSync(join(dir, 'runtime'))).toEqual([]);
    expect(host.workersStarted).toBe(0);
  });

  posix(
    'abandon keeps the files and revisions, so an old expected revision refuses and later writes apply',
    async () => {
      const commitId = await wedgedCommit();
      await expect(
        resolveWith([{ kind: 'abandon-commit', commitId }]),
      ).resolves.toMatchObject({
        mode: 'resolve',
        results: [
          {
            decision: { kind: 'abandon-commit', commitId },
            status: 'abandoned',
          },
        ],
        diagnosis: {
          logIssue: null,
          commits: [],
          reservations: [],
          // The kept foreign bytes differ from the last applied decision.
          files: [{ path: MANIFEST, reason: 'log-mismatch' }],
        },
      });
      expect(manifest()).toBe(FOREIGN);
      expect(host.runningWorkerCount).toBe(0);
      released();

      const writer = reopen();
      await expect(writer.lookupReceipt(RECEIPT)).resolves.toEqual({
        status: 'none',
      });
      await expect(writer.revision(ALPHA)).resolves.toBe(2);
      await expect(
        writer.commit({
          ...manifestChange(NEXT, FOREIGN),
          expectedRevisions: [{ resource: ALPHA, revision: 1 }],
        }),
      ).rejects.toMatchObject({ reason: 'revision-conflict' });
      expect(manifest()).toBe(FOREIGN);
      await expect(
        writer.commit({
          ...manifestChange(NEXT, FOREIGN),
          receipt: RECEIPT,
          expectedRevisions: [{ resource: ALPHA, revision: 2 }],
        }),
      ).resolves.toMatchObject({
        status: 'applied',
        revisions: { 'workspace:alpha': 3 },
      });
      expect(manifest()).toBe(NEXT);
    },
  );

  posix(
    'retry stays recovery-required until an exact restore, then applies once',
    async () => {
      const commitId = await wedgedCommit();
      const retry = [{ kind: 'retry-commit', commitId }] as const;
      await expect(resolveWith(retry)).resolves.toMatchObject({
        results: [{ status: 'recovery-required' }],
        diagnosis: {
          commits: [
            {
              commitId,
              operation: RECEIPT.operation,
              state: 'recovery-required',
            },
          ],
        },
      });
      expect(manifest()).toBe(FOREIGN);
      released();

      put(MANIFEST, ORIGINAL);
      reopen();
      await expect(resolveWith(retry)).resolves.toMatchObject({
        results: [{ status: 'applied' }],
        diagnosis: { files: [], commits: [], reservations: [] },
      });
      expect(manifest()).toBe(NEXT);
      released();
      const writer = reopen();
      await expect(
        writer.commit({ ...manifestChange(NEXT, ORIGINAL), receipt: RECEIPT }),
      ).resolves.toEqual({
        status: 'replayed',
        commitId,
        outcome: { workspaceId: 'alpha' },
      });
      await expect(writer.revision(ALPHA)).resolves.toBe(2);
      expect(manifest()).toBe(NEXT);
    },
  );

  posix.each(['applies once', 'refuses after an intervening write'] as const)(
    'a resolved interrupted 1D reservation %s',
    async (path) => {
      reservation('x6b', RECEIPT.operation);
      const receipt = { ...RECEIPT, idempotencyKey: 'x6b' };
      const keyed: W5CommitRequest = {
        ...manifestChange(NEXT, ORIGINAL),
        receipt,
        expectedRevisions: [{ resource: ALPHA, revision: 1 }],
      };
      const blocked = new W5CommitLogHost({
        dbPath,
        root,
        workerEntry: join(
          __dirname,
          '../../w5-commit-log/commit-log-worker.ts',
        ),
      });
      try {
        await expect(blocked.commit(keyed)).rejects.toMatchObject({
          reason: 'recovery-required',
        });
      } finally {
        await blocked.shutdown();
      }
      await expect(
        resolveWith([{ kind: 'resolve-reservation', reservationId: 'x6b' }]),
      ).resolves.toMatchObject({
        results: [{ status: 'resolved' }],
        diagnosis: { files: [], commits: [], reservations: [] },
      });
      // Resolution neither applies nor compensates anything.
      expect(manifest()).toBe(ORIGINAL);
      released();

      const writer = reopen();
      await expect(writer.revision(ALPHA)).resolves.toBe(1);
      if (path === 'refuses after an intervening write') {
        const other =
          '{"version":1,"type":"single-repo","repos":[],"other":true}\n';
        await expect(
          writer.commit(manifestChange(other, ORIGINAL)),
        ).resolves.toMatchObject({ status: 'applied' });
        await expect(writer.commit(keyed)).rejects.toMatchObject({
          reason: 'revision-conflict',
        });
        expect(manifest()).toBe(other);
        await expect(writer.lookupReceipt(receipt)).resolves.toEqual({
          status: 'none',
        });
        await expect(writer.revision(ALPHA)).resolves.toBe(2);
        return;
      }
      const applied = await writer.commit(keyed);
      expect(applied).toMatchObject({
        status: 'applied',
        revisions: { 'workspace:alpha': 2 },
      });
      await expect(writer.commit(keyed)).resolves.toEqual({
        status: 'replayed',
        commitId: applied.commitId,
        outcome: { workspaceId: 'alpha' },
      });
      expect(manifest()).toBe(NEXT);
      await expect(writer.revision(ALPHA)).resolves.toBe(2);
    },
  );

  posix.each([
    'core.workspace.create',
    'core.worktree.create',
    'core.workspace.delete',
    'core.worktree.delete',
    'core.worktree.archive',
    'core.worktree.branch.rename',
    'core.workspace.composition.split',
    'core.sharedContainer.fork',
    'clone',
  ])(
    'a %s reservation refuses operation-excluded and keeps restore blocked',
    async (operation) => {
      const backupPath = await backup();
      reservation('lifecycle', operation);
      const before = state();
      await expect(
        resolveWith([
          { kind: 'resolve-reservation', reservationId: 'lifecycle' },
        ]),
      ).rejects.toMatchObject({ reason: 'operation-excluded', decision: 0 });
      expect(state()).toEqual(before);
      expect(host.workersStarted).toBe(0);
      released();
      await expect(restoreFrom(backupPath)).rejects.toMatchObject({
        reason: 'recovery-required',
      });
      expect(state()).toEqual(before);
    },
  );

  posix('refuses every decision when one is excluded', async () => {
    const commitId = await wedgedCommit();
    reservation('lifecycle', 'core.workspace.create');
    const before = state();
    await expect(
      resolveWith([
        { kind: 'abandon-commit', commitId },
        { kind: 'resolve-reservation', reservationId: 'lifecycle' },
      ]),
    ).rejects.toMatchObject({ reason: 'operation-excluded', decision: 1 });
    expect(state()).toEqual(before);
    expect(host.workersStarted).toBe(0);
    released();
  });

  // A24-L(b): abandoning drops the receipt, so the key would rerun the
  // lifecycle's Git and file effects.
  posix.each([
    'core.workspace.create',
    'core.worktree.archive',
    'core.workspace.composition.split',
    'core.workspace.composition.combine',
  ])(
    'abandoning a keyed %s commit refuses operation-excluded and keeps its key and restore blocked',
    async (operation) => {
      const backupPath = await backup();
      const commitId = await wedgedCommit(operation);
      const receipt = { ...RECEIPT, operation };
      await expect(diagnosis()).resolves.toMatchObject({
        commits: [
          {
            commitId,
            operation,
            state: 'recovery-required',
            receiptOperations: [operation],
          },
        ],
      });
      const before = state();
      await expect(
        resolveWith([{ kind: 'abandon-commit', commitId }]),
      ).rejects.toMatchObject({ reason: 'operation-excluded', decision: 0 });
      expect(state()).toEqual(before);
      expect(host.workersStarted).toBe(0);
      released();
      await expect(restoreFrom(backupPath)).rejects.toMatchObject({
        reason: 'recovery-required',
      });
      expect(state()).toEqual(before);
      released();

      const writer = reopen();
      await expect(writer.lookupReceipt(receipt)).resolves.toMatchObject({
        status: 'commit-recovery-required',
        commitId,
      });
      await expect(writer.revision(ALPHA)).resolves.toBe(2);
      expect(manifest()).toBe(FOREIGN);
    },
  );

  // The receipt's own operation is checked too, not only the commit's.
  posix.each([
    ['a lifecycle commit', 'core.worktree.create', 'core.worktree.create'],
    [
      'a 1D commit holding a lifecycle receipt',
      RECEIPT.operation,
      'core.worktree.create',
    ],
  ])(
    'refuses a list abandoning a 1D commit and %s, changing nothing',
    async (_, operation, receiptOperation) => {
      const first = await wedgedCommit();
      // Another file: a pending commit blocks later commits to its own.
      const BETA = 'beta/workspace.json';
      const log = W5CommitLog.open(dbPath);
      let second: number;
      try {
        second = log.commit({
          operation,
          advance: [{ kind: 'workspace', workspaceId: 'beta' }],
          files: [
            {
              path: join(root, BETA),
              contents: FOREIGN,
              previousFingerprint: fingerprintW5File(initial.get(BETA) ?? ''),
            },
          ],
          outcome: null,
          receipt: { ...RECEIPT, operation: receiptOperation },
        }).commitId;
        put(BETA, NEXT);
        await expect(
          applyW5Commit(log, pendingCommit(log, second), { root }),
        ).resolves.toMatchObject({ status: 'recovery-required' });
      } finally {
        log.close();
      }
      await expect(diagnosis()).resolves.toMatchObject({
        commits: [
          { commitId: first, receiptOperations: [RECEIPT.operation] },
          {
            commitId: second,
            operation,
            receiptOperations: [receiptOperation],
          },
        ],
      });
      const before = state();
      await expect(
        resolveWith([
          { kind: 'abandon-commit', commitId: first },
          { kind: 'abandon-commit', commitId: second },
        ]),
      ).rejects.toMatchObject({ reason: 'operation-excluded', decision: 1 });
      expect(state()).toEqual(before);
      expect(host.workersStarted).toBe(0);
      released();
    },
  );

  // Retry keeps the receipt and only rewrites the commit's W5 files.
  posix('a keyed lifecycle commit may retry, keeping its key', async () => {
    const operation = 'core.workspace.create';
    const commitId = await wedgedCommit(operation);
    put(MANIFEST, ORIGINAL);
    await expect(
      resolveWith([{ kind: 'retry-commit', commitId }]),
    ).resolves.toMatchObject({
      results: [{ status: 'applied' }],
      diagnosis: { files: [], commits: [], reservations: [] },
    });
    expect(manifest()).toBe(NEXT);
    released();
    const writer = reopen();
    await expect(
      writer.commit({
        ...manifestChange(NEXT, ORIGINAL),
        operation,
        receipt: { ...RECEIPT, operation },
      }),
    ).resolves.toEqual({
      status: 'replayed',
      commitId,
      outcome: { workspaceId: 'alpha' },
    });
    await expect(writer.revision(ALPHA)).resolves.toBe(2);
  });

  // E9u: an unkeyed commit holds no key, so abandoning it releases nothing.
  posix.each(['core.workspace.update', 'internal.repository.write'])(
    'an unkeyed %s commit is abandonable',
    async (operation) => {
      const commitId = await wedgedCommit(operation, false);
      await expect(diagnosis()).resolves.toMatchObject({
        commits: [{ commitId, operation, receiptOperations: [] }],
      });
      await expect(
        resolveWith([{ kind: 'abandon-commit', commitId }]),
      ).resolves.toMatchObject({
        results: [{ status: 'abandoned' }],
        diagnosis: { commits: [], reservations: [] },
      });
      expect(manifest()).toBe(FOREIGN);
      released();
      const writer = reopen();
      await expect(writer.revision(ALPHA)).resolves.toBe(2);
      await expect(
        writer.commit({
          ...manifestChange(NEXT, FOREIGN),
          expectedRevisions: [{ resource: ALPHA, revision: 2 }],
        }),
      ).resolves.toMatchObject({ status: 'applied' });
      expect(manifest()).toBe(NEXT);
    },
  );

  posix.each(['reservation', 'commit'] as const)(
    'a pending %s refuses launch-recovery-pending before a writer starts',
    async (pending) => {
      const commitId = await wedgedCommit();
      if (pending === 'reservation')
        reservation('live', RECEIPT.operation, false);
      else {
        const log = W5CommitLog.open(dbPath);
        log.commit({
          operation: 'fixture.unapplied',
          advance: [],
          files: [],
          outcome: null,
        });
        log.close();
      }
      const before = state();
      await expect(
        resolveWith(
          pending === 'reservation'
            ? [{ kind: 'resolve-reservation', reservationId: 'live' }]
            : [{ kind: 'abandon-commit', commitId }],
        ),
      ).rejects.toMatchObject({ reason: 'launch-recovery-pending' });
      expect(state()).toEqual(before);
      expect(host.workersStarted).toBe(0);
      released();
    },
  );

  posix.each([
    [
      'an absent reservation',
      [{ kind: 'resolve-reservation', reservationId: 'missing' }],
      0,
    ],
    [
      'an applied commit',
      [
        { kind: 'abandon-commit', commitId: 2 },
        { kind: 'retry-commit', commitId: 1 },
      ],
      1,
    ],
    ['an absent commit', [{ kind: 'retry-commit', commitId: 99 }], 0],
  ] satisfies [string, W5MaintenanceDecision[], number][])(
    '%s refuses invalid-state',
    async (_, decisions, decision) => {
      expect(await wedgedCommit()).toBe(2);
      const before = state();
      await expect(resolveWith(decisions)).rejects.toMatchObject({
        reason: 'invalid-state',
        decision,
      });
      expect(state()).toEqual(before);
      expect(host.workersStarted).toBe(0);
      released();
    },
  );

  posix('an incompatible log refuses log-unavailable', async () => {
    const commitId = await wedgedCommit();
    const db = new DatabaseSync(dbPath);
    db.exec("UPDATE w5_meta SET value = '999' WHERE key = 'schema_version'");
    db.close();
    const before = state();
    await expect(
      resolveWith([{ kind: 'abandon-commit', commitId }]),
    ).rejects.toMatchObject({ reason: 'log-unavailable' });
    expect(state()).toEqual(before);
    expect(host.workersStarted).toBe(0);
    released();
  });

  posix(
    'a held claim or a live host refuses before a writer starts',
    async () => {
      const commitId = await wedgedCommit();
      const decisions = [{ kind: 'abandon-commit', commitId }] as const;
      const before = state();
      const holder = await acquireOther();
      await expect(resolveWith(decisions)).rejects.toMatchObject({
        reason: 'claim-held',
      });
      expect(await claims().release(holder)).toBe('released');
      putMember(4242);
      await expect(resolveWith(decisions)).rejects.toMatchObject({
        reason: 'host-active',
      });
      expect(state()).toEqual(before);
      expect(host.workersStarted).toBe(0);
      released();
    },
  );

  posix(
    'restore stays blocked until a required 1D reservation is resolved',
    async () => {
      const backupPath = await backup();
      reservation('x6b', RECEIPT.operation);
      await expect(restoreFrom(backupPath)).rejects.toMatchObject({
        reason: 'recovery-required',
      });
      await expect(
        resolveWith([{ kind: 'resolve-reservation', reservationId: 'x6b' }]),
      ).resolves.toMatchObject({ results: [{ status: 'resolved' }] });
      reopen();
      await expect(restoreFrom(backupPath)).resolves.toEqual({
        mode: 'restore',
        commitId: 2,
      });
      released();
    },
  );

  posix.each(['a host failure', 'an interruption'] as const)(
    'stops at %s, reporting the decisions that took effect',
    async (kind) => {
      const commitId = await wedgedCommit();
      reservation('x6b', RECEIPT.operation);
      const abort = new AbortController();
      const cause =
        kind === 'a host failure'
          ? new W5CommitLogHostError('outcome-unknown', 'fixture')
          : new Error('fixture interruption');
      if (kind === 'a host failure')
        jest
          .spyOn(host, 'abandonRecoveryRequiredCommit')
          .mockRejectedValueOnce(cause);
      else {
        const resolveRecovery = host.resolveRecovery.bind(host);
        jest
          .spyOn(host, 'resolveRecovery')
          .mockImplementation(async (reservationId) => {
            await resolveRecovery(reservationId);
            abort.abort(cause);
          });
      }
      const error = await failureOf(
        resolveWith(
          [
            { kind: 'resolve-reservation', reservationId: 'x6b' },
            { kind: 'abandon-commit', commitId },
          ],
          abort.signal,
        ),
      );
      expect(error).toBeInstanceOf(W5MaintenanceDecisionError);
      expect(error).toMatchObject({
        results: [
          {
            decision: { kind: 'resolve-reservation', reservationId: 'x6b' },
            status: 'resolved',
          },
        ],
        failure: cause,
      });
      const after = {
        reservations: [],
        commits: [{ commitId, state: 'recovery-required' }],
      };
      // A failed request's outcome may be unknown, so it diagnoses again;
      // an abort does not.
      if (kind === 'a host failure')
        expect(error).toMatchObject({ diagnosis: after });
      else expect(error).toHaveProperty('diagnosis', undefined);
      expect(host.runningWorkerCount).toBe(0);
      released();
      jest.restoreAllMocks();
      reopen();
      await expect(diagnosis()).resolves.toMatchObject(after);
    },
  );

  posix(
    'reports claim loss between decisions with the results that took effect',
    async () => {
      const commitId = await wedgedCommit();
      reservation('x6b', RECEIPT.operation);
      const resolveRecovery = host.resolveRecovery.bind(host);
      jest
        .spyOn(host, 'resolveRecovery')
        .mockImplementation(async (reservationId) => {
          await resolveRecovery(reservationId);
          rmSync(cohortRecord());
        });
      const abandon = jest.spyOn(host, 'abandonRecoveryRequiredCommit');
      const error = await failureOf(
        resolveWith([
          { kind: 'resolve-reservation', reservationId: 'x6b' },
          { kind: 'abandon-commit', commitId },
        ]),
      );
      const stopped =
        error instanceof W5MaintenanceDecisionError
          ? error
          : error instanceof W5MaintenanceRefusedError
            ? error.operationError
            : undefined;
      expect(stopped).toBeInstanceOf(W5MaintenanceDecisionError);
      expect(stopped).toMatchObject({
        results: [{ status: 'resolved' }],
        failure: { reason: 'claim-lost' },
        diagnosis: undefined,
      });
      expect(abandon).not.toHaveBeenCalled();
      expect(host.runningWorkerCount).toBe(0);
    },
  );

  posix(
    'keeps the claim when the writer has not confirmed its exit after the decisions',
    async () => {
      const commitId = await wedgedCommit();
      jest.spyOn(host, 'runningWorkerCount', 'get').mockReturnValue(1);
      const error = await failureOf(
        resolveWith([{ kind: 'abandon-commit', commitId }]),
      );
      expect(error).toBeInstanceOf(W5MaintenanceDecisionError);
      expect(error).toMatchObject({
        results: [{ status: 'abandoned' }],
        failure: { reason: 'writer-exit-unconfirmed' },
      });
      expect(existsSync(cohortRecord())).toBe(true);
      expect(existsSync(join(dir, 'runtime/startup-claim.json'))).toBe(true);
    },
  );

  posix(
    'reports a stopped decision and an unconfirmed writer exit together, keeping the claim',
    async () => {
      const commitId = await wedgedCommit();
      reservation('x6b', RECEIPT.operation);
      const cause = new W5CommitLogHostError('outcome-unknown', 'fixture');
      jest
        .spyOn(host, 'retryRecoveryRequiredCommit')
        .mockRejectedValueOnce(cause);
      // The real first request starts the worker; its exit stays unconfirmed.
      jest.spyOn(host, 'runningWorkerCount', 'get').mockReturnValue(1);
      const error = await failureOf(
        resolveWith([
          { kind: 'resolve-reservation', reservationId: 'x6b' },
          { kind: 'retry-commit', commitId },
        ]),
      );
      expect(error).toBeInstanceOf(W5MaintenanceDecisionError);
      expect(error).toMatchObject({
        results: [{ status: 'resolved' }],
        failure: {
          errors: [cause, { reason: 'writer-exit-unconfirmed' }],
        },
        diagnosis: undefined,
      });
      expect(existsSync(cohortRecord())).toBe(true);
      expect(existsSync(join(dir, 'runtime/startup-claim.json'))).toBe(true);
    },
  );

  // A24-L: an operation name is the only proof a reservation took no effect.
  test('resolves exactly the one-decision boundaries in production source', () => {
    const repository = resolve(__dirname, '../../../../../..');
    const roots = [
      'apps/desktop-app/src',
      'apps/desktop-cli/src',
      ...readdirSync(join(repository, 'packages')).map(
        (name) => `packages/${name}/src`,
      ),
    ];
    const sources = roots.flatMap((root) => {
      let names: string[];
      try {
        names = readdirSync(join(repository, root), { recursive: true }).map(
          String,
        );
      } catch {
        return [];
      }
      return names
        .map((name) =>
          relative(repository, join(repository, root, name)).replaceAll(
            '\\',
            '/',
          ),
        )
        .filter(
          (path) =>
            /\.[cm]?tsx?$/.test(path) &&
            !/(?:^|\/)(?:__tests__|__mocks__|tests|fixtures)\//.test(path) &&
            !/\.(?:test|spec)\.[cm]?tsx?$/.test(path),
        );
    });
    const runner =
      /(?<!function\s+)\bcreateW5SingleDecisionOperation\s*(?:<[^>]*>)?\s*\(/;
    const sites = sources.filter((path) =>
      runner.test(readFileSync(join(repository, path), 'utf8')),
    );
    expect(sites).toContain('apps/desktop-app/src/main/lib/worktree-update.ts');
    const otherKeyed = /\brun(?:W5BoundaryOperation|KeyedW5Operation)\s*[<(]/;
    const literals = (text: string): string[] =>
      (text.match(/'core\.[\w.]+'/g) ?? []).map((literal) =>
        literal.slice(1, -1),
      );
    const operations = new Set<string>();
    const mixed: string[] = [];
    for (const path of sites) {
      const text = readFileSync(join(repository, path), 'utf8');
      // A file mixing 1D and other keyed runners would hide which name is 1D.
      if (otherKeyed.test(text)) mixed.push(path);
      for (const operation of literals(text)) operations.add(operation);
    }
    expect(mixed).toEqual([]);
    expect([...operations].sort()).toEqual(
      [...W5_RESOLVABLE_RESERVATION_OPERATIONS].sort(),
    );
    // A lifecycle or 2D runner reusing a 1D name would make its reservations
    // resolvable.
    const lifecycleSites = sources.filter((path) =>
      otherKeyed.test(readFileSync(join(repository, path), 'utf8')),
    );
    expect(lifecycleSites).toContain(
      'apps/desktop-app/src/main/lib/worktree-archive.ts',
    );
    expect(
      lifecycleSites.flatMap((path) =>
        literals(readFileSync(join(repository, path), 'utf8'))
          .filter((name) => W5_RESOLVABLE_RESERVATION_OPERATIONS.has(name))
          .map((name) => `${path}: ${name}`),
      ),
    ).toEqual([]);
  });
});
