import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  W5CommitLog,
  W5_COMMIT_LOG_SCHEMA_VERSION,
  fingerprintW5File,
} from '@canopy/desktop-shared/node/w5-commit-log';
import type * as TsxWorkerThreads from '../../ledger/__tests__/fixtures/tsx-worker-threads';

jest.mock('node:worker_threads', () =>
  jest
    .requireActual<
      typeof TsxWorkerThreads
    >('../../ledger/__tests__/fixtures/tsx-worker-threads')
    .createTsxWorkerThreads(),
);
import type * as AtomicFile from '@canopy/desktop-shared/node/lib/atomic-file';

// Spy on the shared, platform-aware directory sync the capture must use.
jest.mock('@canopy/desktop-shared/node/lib/atomic-file', () => {
  const actual = jest.requireActual<typeof AtomicFile>(
    '@canopy/desktop-shared/node/lib/atomic-file',
  );
  return { ...actual, syncDirectory: jest.fn(actual.syncDirectory) };
});
import { syncDirectory } from '@canopy/desktop-shared/node/lib/atomic-file';
import { W5CommitLogHost } from '../../w5-commit-log/commit-log-host';
import {
  captureW5Backup,
  verifyW5Backup,
  restoreW5Backup,
  requireVerifiedW5Backup,
  __createW5ExclusiveMaintenanceForTests,
  type W5BackupContext,
  type W5RestoreRequest,
} from '../w5-backup';

jest.setTimeout(60_000);
let dir: string;
let root: string;
let dbPath: string;
let host: W5CommitLogHost;
let context: W5BackupContext;
let original: Map<string, string>;
function newHost(): W5CommitLogHost {
  return new W5CommitLogHost({
    dbPath,
    root,
    workerEntry: join(__dirname, '../../w5-commit-log/commit-log-worker.ts'),
  });
}
function put(path: string, contents: string): void {
  mkdirSync(join(root, path, '..'), { recursive: true });
  writeFileSync(join(root, path), contents);
}
function request(
  backupPath: string,
  unreadableOverride?: string,
): W5RestoreRequest {
  return {
    source: 'offline_maintenance',
    backupPath,
    exclusive: __createW5ExclusiveMaintenanceForTests(dir),
    unreadableOverride,
  };
}
function state(): Map<string, string> {
  return new Map(
    Array.from(original.keys(), (path) => [
      path,
      readFileSync(join(root, path), 'utf8'),
    ]),
  );
}
async function assertRefusedUnchanged(
  backup: string,
  reason: string,
  resource: string,
): Promise<void> {
  const before = state();
  const position = await host.snapshot();
  await expect(restoreW5Backup(context, request(backup))).rejects.toMatchObject(
    { reason, resource },
  );
  expect(state()).toEqual(before);
  expect(await host.snapshot()).toEqual(position);
}
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'w5-backup-'));
  root = join(dir, 'workspaces');
  dbPath = join(dir, 'w5', 'commit-log.sqlite');
  mkdirSync(root);
  original = new Map([
    [
      'index.json',
      '{ "version": 1, "workspaces": [{"id":"alpha","type":"single-repo","name":"Alpha","color":"#fff"},{"id":"beta","type":"cowork","name":"Beta","color":"#fff"}], "unknown": [1,2] }\n',
    ],
    [
      'index.json.bak',
      '{"version":1,"workspaces":[{"id":"alpha","type":"single-repo","name":"Alpha","color":"#fff"}],"old":true}\n',
    ],
    [
      'alpha/workspace.json',
      '{"version":1,"type":"single-repo","repos":[],"unknown":{"a":true}}\n',
    ],
    [
      'alpha/worktrees.json',
      '{"version":1,"worktrees":[{"id":"first","branchName":"main","createdAt":"2026-10-14T00:00:00Z","unknown":[7]}]}\n',
    ],
    ['beta/workspace.json', '{"version":1,"type":"cowork","unknown":"é 🦜"}\n'],
    ['orphan/workspace.json', '{"version":1,"type":"cowork","orphan":true}\n'],
  ]);
  for (const [path, contents] of Array.from(original)) put(path, contents);
  host = newHost();
  context = { host, dataRoot: dir };
  await host.commit({
    operation: 'fixture.initial',
    advance: [
      { kind: 'workspaces' },
      { kind: 'workspace', workspaceId: 'alpha' },
      { kind: 'workspace', workspaceId: 'beta' },
      { kind: 'worktrees', workspaceId: 'alpha' },
      { kind: 'worktree', workspaceId: 'alpha', worktreeId: 'first' },
    ],
    files: [],
    outcome: null,
  });
});
afterEach(async () => {
  jest.restoreAllMocks();
  await host.shutdown();
  rmSync(dir, { recursive: true, force: true });
});

test('capture syncs its folders through the shared platform-aware helper', async () => {
  jest.mocked(syncDirectory).mockClear();
  await captureW5Backup(context);
  expect(jest.mocked(syncDirectory)).toHaveBeenCalledWith(
    expect.stringContaining(join('w5', 'backups')),
  );
});

test('capture verifies bytes, parsed semantics, all resources and C3 namespaces; rollout checks freshness', async () => {
  const backup = await captureW5Backup(context);
  const record = await verifyW5Backup(context, backup);
  expect(record.namespaces.map((namespace) => namespace.namespaceId)).toEqual([
    'workspace_index',
    'workspace_manifest',
    'worktree_list',
  ]);
  expect(record.position.commitId).toBe(1);
  expect(record.position.schemaVersion).toBe(W5_COMMIT_LOG_SCHEMA_VERSION);
  expect(
    record.files.find((file) => file.path === 'alpha/worktrees.json')
      ?.revisions,
  ).toEqual({ 'worktrees:alpha': 1, 'worktree:alpha/first': 1 });
  expect(
    record.files.find((file) => file.path === 'beta/worktrees.json'),
  ).toMatchObject({ sha256: null, byteLength: 0, schemaVersion: 'none' });
  for (const [path, raw] of Array.from(original)) {
    const bytes = readFileSync(join(dir, backup, 'files', path));
    expect(bytes).toEqual(Buffer.from(raw));
    expect(JSON.parse(bytes.toString('utf8'))).toEqual(JSON.parse(raw));
  }
  await expect(requireVerifiedW5Backup(context, backup, 1)).resolves.toEqual(
    record,
  );
  await expect(
    requireVerifiedW5Backup(context, backup, 2),
  ).rejects.toMatchObject({ reason: 'incomplete-backup' });
  put('alpha/workspace.json', '{"version":1,"changed":true}');
  await expect(
    requireVerifiedW5Backup(context, backup, 1),
  ).rejects.toMatchObject({ reason: 'source-changed' });
});

test('a committed write during every capture attempt exhausts retries without any verified record', async () => {
  const snapshot = host.snapshot.bind(host);
  let calls = 0;
  jest.spyOn(host, 'snapshot').mockImplementation(async () => {
    calls += 1;
    if (calls % 2 === 0)
      await host.commit({
        operation: 'fixture.concurrent',
        advance: [{ kind: 'workspace', workspaceId: 'alpha' }],
        files: [],
        outcome: null,
      });
    return snapshot();
  });
  await expect(captureW5Backup(context)).rejects.toMatchObject({
    reason: 'source-changed',
  });
  const backups = readdirSync(join(dir, 'w5/backups'));
  expect(backups).toHaveLength(3);
  for (const backup of backups)
    await expect(
      verifyW5Backup(context, `w5/backups/${backup}`),
    ).rejects.toMatchObject({ reason: 'incomplete-backup' });
});

test('an out-of-log byte change during capture also cannot produce a verified record', async () => {
  const snapshot = host.snapshot.bind(host);
  let calls = 0;
  jest.spyOn(host, 'snapshot').mockImplementation(() => {
    calls += 1;
    if (calls % 2 === 0)
      put('alpha/workspace.json', JSON.stringify({ version: 1, calls }));
    return snapshot();
  });
  await expect(captureW5Backup(context)).rejects.toMatchObject({
    reason: 'source-changed',
  });
});

test.each(['alpha/workspace.json', 'alpha/worktrees.json', 'index.json.bak'])(
  'unreadable source %s refuses capture without empty defaults',
  async (path) => {
    put(path, '{truncated');
    await expect(captureW5Backup(context)).rejects.toMatchObject({
      reason: 'source-unreadable',
      resource: path,
    });
    expect(readFileSync(join(root, path), 'utf8')).toBe('{truncated');
  },
);

test('I/O failure and missing indexed manifest name the source; optional absences stay absent', async () => {
  rmSync(join(root, 'alpha/workspace.json'));
  mkdirSync(join(root, 'alpha/workspace.json'));
  await expect(captureW5Backup(context)).rejects.toMatchObject({
    reason: 'source-unreadable',
    resource: 'alpha/workspace.json',
  });
  rmSync(join(root, 'alpha/workspace.json'), { recursive: true });
  await expect(captureW5Backup(context)).rejects.toMatchObject({
    reason: 'missing-source',
    resource: 'alpha/workspace.json',
  });
});

test('corrupt file, incomplete inventory, mismatched C3 evidence and missing record refuse verification', async () => {
  const backup = await captureW5Backup(context);
  const recordPath = join(dir, backup, 'record.json');
  const recordBytes = readFileSync(recordPath);
  const filePath = join(dir, backup, 'files/alpha/workspace.json');
  const fileBytes = readFileSync(filePath);
  writeFileSync(filePath, '{"version":1,"corrupt":true}');
  await expect(verifyW5Backup(context, backup)).rejects.toMatchObject({
    reason: 'corrupt-backup',
    resource: 'alpha/workspace.json',
  });
  writeFileSync(filePath, fileBytes);
  const record = await verifyW5Backup(context, backup);
  writeFileSync(
    recordPath,
    JSON.stringify({
      ...record,
      files: record.files.filter(
        (file) => file.path !== 'alpha/workspace.json',
      ),
    }),
  );
  await expect(verifyW5Backup(context, backup)).rejects.toMatchObject({
    reason: 'corrupt-backup',
  });
  writeFileSync(
    recordPath,
    JSON.stringify({
      ...record,
      namespaces: record.namespaces.map((namespace) => ({
        ...namespace,
        sourceRevision: '999',
      })),
    }),
  );
  await expect(verifyW5Backup(context, backup)).rejects.toMatchObject({
    reason: 'corrupt-backup',
  });
  writeFileSync(recordPath, recordBytes);
  rmSync(recordPath);
  await expect(verifyW5Backup(context, backup)).rejects.toMatchObject({
    reason: 'incomplete-backup',
  });
});

test('newer edits, tombstones and newly created resources refuse restore and preserve all current bytes', async () => {
  const backup = await captureW5Backup(context);
  await host.commit({
    operation: 'fixture.newer',
    advance: [{ kind: 'workspace', workspaceId: 'alpha' }],
    files: [
      {
        path: join(root, 'alpha/workspace.json'),
        contents: '{"version":1,"newer":true}',
        previousFingerprint: fingerprintW5File(
          original.get('alpha/workspace.json') ?? null,
        ),
      },
    ],
    outcome: null,
  });
  await assertRefusedUnchanged(backup, 'newer-writes', 'workspace:alpha');
  const recent = await captureW5Backup(context);
  await host.commit({
    operation: 'fixture.deleted-row',
    advance: [
      { kind: 'worktree', workspaceId: 'alpha', worktreeId: 'deleted' },
    ],
    files: [],
    outcome: null,
  });
  await assertRefusedUnchanged(
    recent,
    'newer-writes',
    'worktree:alpha/deleted',
  );
});

test('schema downgrade and unreadable current file refusals preserve bytes and commit position', async () => {
  const backup = await captureW5Backup(context);
  put('alpha/workspace.json', '{"version":2,"newSchema":true}');
  await assertRefusedUnchanged(
    backup,
    'schema-downgrade',
    'alpha/workspace.json',
  );
  await expect(
    restoreW5Backup(context, request(backup, 'operator approval')),
  ).rejects.toMatchObject({ reason: 'schema-downgrade' });
  put('alpha/workspace.json', '{broken');
  await assertRefusedUnchanged(
    backup,
    'source-unreadable',
    'alpha/workspace.json',
  );
});

test('successful restore uses one multi-file commit, advances revisions, and preserves explicit corrupt-state evidence', async () => {
  const backup = await captureW5Backup(context);
  for (const [path] of Array.from(original))
    put(
      path,
      path === 'alpha/workspace.json'
        ? '{broken'
        : '{"version":1,"workspaces":[],"worktrees":[],"damaged":true}',
    );
  const before = await host.snapshot();
  const commit = await restoreW5Backup(
    context,
    request(backup, 'CAN-3796 fixture recovery approved'),
  );
  expect(commit).toBe(before.commitId + 1);
  expect(state()).toEqual(original);
  const after = await host.snapshot();
  expect(after.revisions['workspace:alpha']).toBe(2);
  expect(after.revisions['worktree:alpha/first']).toBe(2);
  await host.shutdown();
  const db = new DatabaseSync(dbPath);
  expect(
    db
      .prepare('SELECT count(*) AS n FROM w5_commit_files WHERE commit_id = ?')
      .get(commit)?.n,
  ).toBe(8);
  const outcome = db
    .prepare('SELECT outcome_json FROM w5_commits WHERE commit_id = ?')
    .get(commit)?.outcome_json;
  expect(typeof outcome).toBe('string');
  if (typeof outcome !== 'string') throw new Error('missing outcome');
  const audit: unknown = JSON.parse(outcome);
  expect(audit).toMatchObject({
    overrides: [
      {
        path: 'alpha/workspace.json',
        reason: 'CAN-3796 fixture recovery approved',
        sha256: fingerprintW5File('{broken'),
      },
    ],
  });
  const evidenceDirs = readdirSync(join(dir, 'w5/restore-evidence'));
  expect(
    readFileSync(
      join(dir, 'w5/restore-evidence', evidenceDirs[0], 'alpha/workspace.json'),
      'utf8',
    ),
  ).toBe('{broken');
  db.close();
  host = newHost();
  context = { host, dataRoot: dir };
  await host.snapshot();
  expect(state()).toEqual(original);
  await assertRefusedUnchanged(backup, 'newer-writes', 'workspace:alpha');
});

test('interrupted capture leaves no verified record after restart', async () => {
  const realRename = fs.rename;
  jest.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    if (String(to).endsWith('record.json'))
      throw new Error('fixture interruption');
    return realRename(from, to);
  });
  await expect(captureW5Backup(context)).rejects.toThrow(
    'fixture interruption',
  );
  jest.restoreAllMocks();
  await host.shutdown();
  host = newHost();
  context = { host, dataRoot: dir };
  for (const id of readdirSync(join(dir, 'w5/backups')))
    await expect(
      verifyW5Backup(context, `w5/backups/${id}`),
    ).rejects.toMatchObject({ reason: 'incomplete-backup' });
  expect(state()).toEqual(original);
});

test('restart completes all files of an interrupted durable restore without another commit', async () => {
  const backup = await captureW5Backup(context);
  const record = await verifyW5Backup(context, backup);
  await host.shutdown();
  const log = W5CommitLog.open(dbPath);
  const damaged = '{"version":1,"workspaces":[],"worktrees":[],"damaged":true}';
  for (const [path] of Array.from(original)) put(path, damaged);
  const decision = log.commit({
    operation: 'w5.backup.restore',
    advance: [{ kind: 'workspaces' }],
    files: record.files.map((file) => ({
      path: join(root, file.path),
      contents: original.get(file.path) ?? null,
      previousFingerprint: original.has(file.path)
        ? fingerprintW5File(damaged)
        : null,
    })),
    outcome: { backupPath: backup },
  });
  // Simulate interruption after just the first of the decision's files landed.
  put('index.json', original.get('index.json') ?? '');
  log.close();
  host = newHost();
  context = { host, dataRoot: dir };
  expect((await host.recoveryReport()).recoveryRequired).toEqual([]);
  expect(state()).toEqual(original);
  expect((await host.snapshot()).commitId).toBe(decision.commitId);
});

test('restore requires the root-bound test-only exclusive capability and refuses extra metadata', async () => {
  const backup = await captureW5Backup(context);
  const before = state();
  await expect(
    restoreW5Backup(context, {
      source: 'offline_maintenance',
      backupPath: backup,
      exclusive: { kind: 'w5-exclusive-maintenance' },
    }),
  ).rejects.toMatchObject({ reason: 'exclusive-required' });
  expect(state()).toEqual(before);
  put('new/workspace.json', '{"version":1}');
  await assertRefusedUnchanged(backup, 'newer-writes', 'new/workspace.json');
});

test('symlinked recovery storage is refused before capture or restore writes', async () => {
  const backup = await captureW5Backup(context);
  const before = state();
  rmSync(join(dir, 'w5/backups'), { recursive: true });
  mkdirSync(join(dir, 'redirected'));
  symlinkSync(join(dir, 'redirected'), join(dir, 'w5/backups'));
  await expect(captureW5Backup(context)).rejects.toMatchObject({
    reason: 'source-unreadable',
  });
  await expect(restoreW5Backup(context, request(backup))).rejects.toMatchObject(
    { reason: 'source-unreadable' },
  );
  expect(readdirSync(join(dir, 'redirected'))).toEqual([]);
  expect(state()).toEqual(before);
});

test('recorded absence cannot remove a file created outside the log after capture', async () => {
  const backup = await captureW5Backup(context);
  const current = '{"version":1,"worktrees":[],"unlogged":true}';
  put('beta/worktrees.json', current);
  await assertRefusedUnchanged(backup, 'newer-writes', 'beta/worktrees.json');
  expect(readFileSync(join(root, 'beta/worktrees.json'), 'utf8')).toBe(current);
});

test('capture refuses missing index and code list rather than inventing empty state', async () => {
  rmSync(join(root, 'alpha/worktrees.json'));
  await expect(captureW5Backup(context)).rejects.toMatchObject({
    reason: 'missing-source',
    resource: 'alpha/worktrees.json',
  });
  rmSync(join(root, 'index.json'));
  await expect(captureW5Backup(context)).rejects.toMatchObject({
    reason: 'missing-source',
    resource: 'index.json',
  });
});

test('a newer write admitted while restore is preparing is refused at the worker decision', async () => {
  const backup = await captureW5Backup(context);
  const commit = host.commit.bind(host);
  const next = '{"version":1,"concurrent":true}';
  jest.spyOn(host, 'commit').mockImplementationOnce(async (restore) => {
    await commit({
      operation: 'fixture.racing-restore',
      advance: [{ kind: 'workspace', workspaceId: 'alpha' }],
      files: [
        {
          path: join(root, 'alpha/workspace.json'),
          contents: next,
          previousFingerprint: fingerprintW5File(
            original.get('alpha/workspace.json') ?? null,
          ),
        },
      ],
      outcome: null,
    });
    return commit(restore);
  });
  await expect(restoreW5Backup(context, request(backup))).rejects.toMatchObject(
    { reason: 'newer-writes', resource: 'workspace:alpha' },
  );
  expect(readFileSync(join(root, 'alpha/workspace.json'), 'utf8')).toBe(next);
  for (const [path, raw] of Array.from(original))
    if (path !== 'alpha/workspace.json')
      expect(readFileSync(join(root, path), 'utf8')).toBe(raw);
  expect((await host.snapshot()).commitId).toBe(2);
});
