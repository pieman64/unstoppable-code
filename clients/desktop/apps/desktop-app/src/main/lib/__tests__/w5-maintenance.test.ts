import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:net';
import {
  W5CommitLog,
  applyW5Commit,
  fingerprintW5File,
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
import type { PlatformServices } from '@canopy/core-runtime';
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
  W5MaintenanceResult,
  W5MaintenanceRequest,
} from '../w5-maintenance';
import { W5CommitLogHost } from '../../w5-commit-log/commit-log-host';
import {
  captureW5Backup,
  restoreW5Backup,
  type W5ExclusiveMaintenance,
} from '../w5-backup';
import { runW5Maintenance, type W5MaintenanceContext } from '../w5-maintenance';

jest.setTimeout(60_000);
let dir: string;
let root: string;
let dbPath: string;
let host: W5CommitLogHost;
let context: W5MaintenanceContext;
let other: CanopyStartupProcessInspection;
const otherOwner = { pid: 101, startIdentity: 'fixture-old-start' };
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
      if (other.kind === 'alive')
        return Promise.resolve({
          state: 'running',
          startIdentity: other.startIdentity,
        });
      return Promise.resolve({
        state: other.kind === 'dead' ? 'absent' : 'unverifiable',
      });
    },
  };
  context = { host, dataRoot: dir, platform: { ...platform, supervision } };
  other = { kind: 'alive', startIdentity: otherOwner.startIdentity };
});
afterEach(async () => {
  jest.restoreAllMocks();
  await host.shutdown();
  rmSync(dir, { recursive: true, force: true });
});

test.each(['alive', 'unknown'] as const)(
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

test.each([
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

test('keeps the claim when a writer worker has not confirmed its exit', async () => {
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
  expect(existsSync(join(dir, 'runtime/startup-claim.json'))).toBe(true);
  jest.restoreAllMocks();
  running.mockRestore();
});

test('reports corrupt, missing and unknown files plus log mismatches without changing bytes', async () => {
  put('alpha/workspace.json', '{broken');
  put('alpha/surprise.txt', 'keep me');
  put('mystery.bin', 'unknown');
  writeFileSync(join(dir, 'w5/unknown.bin'), 'retain');
  rmSync(join(root, 'alpha/worktrees.json'));
  const before = state();
  const result = await diagnose();
  if (result.mode !== 'diagnose') throw new Error('Expected diagnosis');
  for (const issue of [
    { path: 'alpha/workspace.json', reason: 'corrupt-file' },
    { path: 'alpha/workspace.json', reason: 'log-mismatch' },
    { path: 'alpha/worktrees.json', reason: 'missing-file' },
    { path: 'alpha/surprise.txt', reason: 'unknown-artifact' },
    { path: 'mystery.bin', reason: 'unknown-artifact' },
    { path: 'w5/unknown.bin', reason: 'unknown-artifact' },
  ])
    expect(result.diagnosis.files).toContainEqual(issue);
  expect(state()).toEqual(before);
  expect(host.workersStarted).toBe(0);
  released();
});

test('reports pending commits and uncertain reservations without recovering or compensating them; restore refuses', async () => {
  const path = await backup();
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
  const before = state();
  await expect(diagnose()).resolves.toMatchObject({
    diagnosis: {
      commits: [
        {
          commitId: pending.commitId,
          state: 'recovery-required',
          diagnostics: '{"reason":"fixture"}',
        },
      ],
      reservations: [
        {
          reservationId: 'interrupted-clone',
          state: 'reserved',
          diagnostics: '{"preserve":true}',
        },
      ],
    },
  });
  await expect(
    runW5Maintenance(context, {
      source: 'offline_maintenance',
      mode: 'restore',
      backupPath: path,
    }),
  ).rejects.toMatchObject({ reason: 'recovery-required' });
  expect(state()).toEqual(before);
  released();
});

test('restores a verified backup while the claim blocks start, then revokes admission and releases', async () => {
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
  expect(readFileSync(join(root, 'alpha/unknown.txt'), 'utf8')).toBe('retain');
  released();
  if (!retained) throw new Error('missing observed admission');
  await expect(
    restoreW5Backup(context, {
      source: 'offline_maintenance',
      backupPath: path,
      exclusive: retained,
    }),
  ).rejects.toMatchObject({ reason: 'exclusive-required' });
});

test.each(['newer-writes', 'schema-downgrade', 'corrupt-backup'] as const)(
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

test('restart recovers an interrupted maintenance lineage that never released', async () => {
  const abandoned = await acquireOther();
  other = { kind: 'dead' };
  await diagnose();
  released();
  expect(await claims().release(abandoned)).toBe('not_owner');
  await diagnose();
  released();
});

test('live endpoint refuses even when the claim and descriptor are absent', async () => {
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
});

test('unprovable self identity and interrupted acquisition refuse before W5 writes', async () => {
  const before = state();
  const platform = {
    ...context.platform,
    supervision: {
      ...context.platform.supervision,
      inspectProcess: (): Promise<{ state: 'unverifiable' }> =>
        Promise.resolve({ state: 'unverifiable' }),
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
});

test('missing and incompatible logs are diagnosed, never initialized or migrated', async () => {
  const db = new DatabaseSync(dbPath);
  db.prepare(
    "UPDATE w5_meta SET value = '999' WHERE key = 'schema_version'",
  ).run();
  db.close();
  const before = state();
  await expect(diagnose()).resolves.toMatchObject({
    diagnosis: { logIssue: 'incompatible-schema' },
  });
  expect(state()).toEqual(before);
  rmSync(dbPath);
  await expect(diagnose()).resolves.toMatchObject({
    diagnosis: { logIssue: 'unavailable' },
  });
  expect(existsSync(dbPath)).toBe(false);
  released();
});

test('invalid requests and non-private runtime refuse without changing W5 files', async () => {
  const before = state();
  const request: W5MaintenanceRequest = {
    source: 'offline_maintenance',
    mode: 'diagnose',
  };
  Object.defineProperty(request, 'source', { value: 'untrusted' });
  await expect(runW5Maintenance(context, request)).rejects.toMatchObject({
    reason: 'invalid-request',
  });
  rmSync(join(dir, 'runtime'), { recursive: true });
  await expect(diagnose()).rejects.toMatchObject({
    reason: 'runtime-unavailable',
  });
  expect(state()).toEqual(before);
  released();
});

test('an already-started writer host is refused before maintenance takes the claim', async () => {
  await host.snapshot();
  const before = state();
  await expect(diagnose()).rejects.toMatchObject({ reason: 'writer-active' });
  expect(state()).toEqual(before);
  released();
});

test('loss of provable claim identity refuses before inspection or restore', async () => {
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
        : Promise.resolve({ state: 'unverifiable' });
    });
  await expect(diagnose()).rejects.toMatchObject({ reason: 'claim-lost' });
  expect(state()).toEqual(before);
  released();
});

test('uncertain release retains the interrupted lineage for proven-departed restart recovery', async () => {
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
});

test.each(['live', 'unknown', 'dead'] as const)(
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

test('an ambiguous endpoint retains recovered bind evidence and both refusal diagnostics', async () => {
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
});
