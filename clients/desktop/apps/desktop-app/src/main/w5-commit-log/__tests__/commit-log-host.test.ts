import type { WorkspaceCreationDiagnostics } from '@canopy/desktop-shared/node/w5-commit-log/reservation-diagnostics';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as TsxWorkerThreads from '../../ledger/__tests__/fixtures/tsx-worker-threads';
import {
  W5CommitLog,
  W5CommitLogError,
  W5CommitRefusedError,
  fingerprintW5File,
  recoverW5CommitLog,
  type W5CommitRequest,
} from '@canopy/desktop-shared/node/w5-commit-log';

jest.mock('node:worker_threads', () =>
  jest
    .requireActual<
      typeof TsxWorkerThreads
    >('../../ledger/__tests__/fixtures/tsx-worker-threads')
    .createTsxWorkerThreads(),
);

const mockPaths = {
  dbPath: '/nonexistent/w5-host-test/commit-log.sqlite',
  root: '/nonexistent/w5-host-test/workspaces',
};

jest.mock('../../lib/paths', () => ({
  getW5CommitLogPath: (): string => mockPaths.dbPath,
  getWorkspacesRootDir: (): string => mockPaths.root,
}));

import {
  W5CommitLogHost,
  W5CommitLogHostError,
  getW5CommitLogHost,
  shutdownW5CommitLogHost,
  type W5CommitLogHostOptions,
} from '../commit-log-host';

jest.setTimeout(60_000);

const WORKER_ENTRY = join(__dirname, '..', 'commit-log-worker.ts');
const SCRIPTED_ENTRY = join(__dirname, 'fixtures', 'scripted-worker.ts');
const WORKSPACES = { kind: 'workspaces' } as const;

let dir: string;
let root: string;
let dbPath: string;
let indexPath: string;
const hosts: W5CommitLogHost[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'w5-host-'));
  root = join(dir, 'workspaces');
  mkdirSync(root);
  dbPath = join(dir, 'w5', 'commit-log.sqlite');
  indexPath = join(root, 'index.json');
});

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.shutdown()));
  rmSync(dir, { recursive: true, force: true });
});

function createHost(
  options: Partial<W5CommitLogHostOptions> = {},
): W5CommitLogHost {
  const host = new W5CommitLogHost({
    dbPath,
    root,
    workerEntry: WORKER_ENTRY,
    ...options,
  });
  hosts.push(host);
  return host;
}

function scriptedHost(
  script: string,
  options: Partial<W5CommitLogHostOptions> = {},
): W5CommitLogHost {
  return createHost({ workerEntry: SCRIPTED_ENTRY, root: script, ...options });
}

function indexChange(
  contents: string,
  previous: string | null,
): W5CommitRequest {
  return {
    operation: 'internal.repository.write',
    advance: [WORKSPACES],
    files: [
      {
        path: indexPath,
        contents,
        previousFingerprint: fingerprintW5File(previous),
      },
    ],
    outcome: null,
  };
}

/** The host failure a call settled with, or `resolved`. */
async function failureOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'resolved';
  } catch (error) {
    return error instanceof W5CommitLogHostError ? error.reason : 'other';
  }
}

describe('W5 commit log host (CAN-3805)', () => {
  it('starts no worker until the first call, then commits and writes the file', async () => {
    const host = createHost();
    expect(host.workersStarted).toBe(0);
    expect(existsSync(dbPath)).toBe(false);

    await expect(host.commit(indexChange('v1', null))).resolves.toMatchObject({
      status: 'applied',
      revisions: { workspaces: 1 },
    });
    expect(readFileSync(indexPath, 'utf8')).toBe('v1');
    await expect(host.revision(WORKSPACES)).resolves.toBe(1);
    expect(host.workersStarted).toBe(1);
  });

  it('creates a missing data root before the first commit writes into it', async () => {
    const freshRoot = join(dir, 'fresh', 'workspaces');
    const freshIndex = join(freshRoot, 'index.json');
    const host = createHost({ root: freshRoot });

    await expect(
      host.commit({
        ...indexChange('v1', null),
        files: [
          { path: freshIndex, contents: 'v1', previousFingerprint: null },
        ],
      }),
    ).resolves.toMatchObject({ status: 'applied' });
    expect(readFileSync(freshIndex, 'utf8')).toBe('v1');
  });

  it('finishes a change an earlier process committed before it answers anything', async () => {
    // A worker that committed and stopped before writing the file, then a
    // retry of the same keyed request against the next worker.
    const keyed: W5CommitRequest = {
      ...indexChange('v1', null),
      receipt: {
        caller: 'portal:1',
        operation: 'core.workspace.create',
        idempotencyKey: 'k1',
        fingerprint: 'f1',
      },
      outcome: { workspaceId: 'alpha' },
    };
    const log = W5CommitLog.open(dbPath);
    const committed = log.commit(keyed);
    log.close();
    expect(existsSync(indexPath)).toBe(false);

    const host = createHost();
    await expect(host.recoveryReport()).resolves.toEqual({
      applied: [committed.commitId],
      recoveryRequired: [],
      interruptedReservations: 0,
    });
    expect(readFileSync(indexPath, 'utf8')).toBe('v1');
    await expect(host.commit(keyed)).resolves.toEqual({
      status: 'replayed',
      commitId: committed.commitId,
      outcome: { workspaceId: 'alpha' },
    });
    await expect(host.revision(WORKSPACES)).resolves.toBe(1);
  });

  it("replays a keyed request and carries refusals as the commit log's own errors", async () => {
    const host = createHost();
    const keyed: W5CommitRequest = {
      ...indexChange('v1', null),
      receipt: {
        caller: 'portal:1',
        operation: 'core.workspace.create',
        idempotencyKey: 'k1',
        fingerprint: 'f1',
      },
      outcome: { workspaceId: 'alpha' },
    };
    await expect(host.commit(keyed)).resolves.toMatchObject({
      status: 'applied',
    });
    await expect(host.commit(keyed)).resolves.toMatchObject({
      status: 'replayed',
      outcome: { workspaceId: 'alpha' },
    });

    const stale = host.commit({
      ...indexChange('v2', 'v1'),
      expectedRevisions: [{ resource: WORKSPACES, revision: 0 }],
    });
    await expect(stale).rejects.toBeInstanceOf(W5CommitRefusedError);
    await expect(stale).rejects.toMatchObject({ reason: 'revision-conflict' });
    expect(readFileSync(indexPath, 'utf8')).toBe('v1');
  });

  it('carries an expired replay through the real worker and host without another commit', async () => {
    const keyed: W5CommitRequest = {
      ...indexChange('v1', null),
      receipt: {
        caller: 'portal:1',
        operation: 'core.workspace.create',
        idempotencyKey: 'expired',
        fingerprint: 'f1',
      },
      outcome: { workspaceId: 'alpha' },
    };
    const log = W5CommitLog.open(dbPath, {
      clock: () => Date.parse('2020-01-01T00:00:00.000Z'),
    });
    let commitId: number;
    try {
      commitId = log.commit(keyed).commitId;
      await recoverW5CommitLog(log, { root });
    } finally {
      log.close();
    }
    rmSync(indexPath);
    const host = createHost();
    await expect(host.commit(keyed)).resolves.toEqual({
      status: 'replay-expired',
      commitId,
    });
    await expect(host.revision(WORKSPACES)).resolves.toBe(1);
    expect(existsSync(indexPath)).toBe(false);
  });

  it('reports a change it could not write as awaiting recovery and keeps the file', async () => {
    writeFileSync(indexPath, 'edited elsewhere');
    const host = createHost();

    await expect(host.commit(indexChange('v2', 'v1'))).resolves.toMatchObject({
      status: 'recovery-required',
      apply: {
        conflicts: [
          {
            path: indexPath,
            expected: fingerprintW5File('v1'),
            actual: fingerprintW5File('edited elsewhere'),
          },
        ],
        written: [],
      },
    });
    expect(readFileSync(indexPath, 'utf8')).toBe('edited elsewhere');
  });

  it('reports a log another connection holds, and opens it once released', async () => {
    const host = createHost();
    const holder = W5CommitLog.open(dbPath);
    try {
      const refused = host.revision(WORKSPACES);
      await expect(refused).rejects.toBeInstanceOf(W5CommitLogError);
      await expect(refused).rejects.toMatchObject({
        code: 'WRITER_UNAVAILABLE',
      });
    } finally {
      holder.close();
    }
    await expect(host.revision(WORKSPACES)).resolves.toBe(0);
    expect(host.workersStarted).toBe(2);
  });

  it('rejects a request the worker cannot read and keeps the worker', async () => {
    const host = createHost();
    const malformed = host.commit({
      ...indexChange('v1', null),
      expectedRevisions: [{ resource: WORKSPACES, revision: 1.5 }],
    });
    await expect(malformed).rejects.toBeInstanceOf(W5CommitLogHostError);
    await expect(malformed).rejects.toMatchObject({ reason: 'malformed' });

    await expect(host.revision(WORKSPACES)).resolves.toBe(0);
    expect(existsSync(indexPath)).toBe(false);
    expect(host.workersStarted).toBe(1);
  });

  it('refuses a request that cannot be sent and keeps the worker', async () => {
    const host = createHost();
    await expect(host.revision(WORKSPACES)).resolves.toBe(0);

    const unclonable = host.commit({
      ...indexChange('v1', null),
      outcome: (): undefined => undefined,
    });
    await expect(unclonable).rejects.toMatchObject({ reason: 'malformed' });

    await expect(host.revision(WORKSPACES)).resolves.toBe(0);
    expect(existsSync(indexPath)).toBe(false);
    expect(host.workersStarted).toBe(1);
  });

  it('treats a call lost in flight as outcome unknown and the calls behind it as never sent', async () => {
    const host = scriptedHost('exit-on-request');
    await expect(
      Promise.all([
        failureOf(host.revision(WORKSPACES)),
        failureOf(host.revision(WORKSPACES)),
      ]),
    ).resolves.toEqual(['outcome-unknown', 'unavailable']);
  });

  // Recovery by the replacement is covered with the real worker above.
  it('retires a worker that failed unexpectedly and starts a fresh one', async () => {
    const host = scriptedHost('failed');
    await expect(host.revision(WORKSPACES)).rejects.toMatchObject({
      reason: 'outcome-unknown',
    });
    await expect(host.revision(WORKSPACES)).rejects.toMatchObject({
      reason: 'outcome-unknown',
    });
    expect(host.workersStarted).toBe(2);
  });

  it('starts no replacement while a stopped worker is still blocked', async () => {
    const host = scriptedHost('blocked', { requestTimeoutMs: 200 });
    await expect(host.revision(WORKSPACES)).rejects.toMatchObject({
      reason: 'outcome-unknown',
    });
    // The first worker is still in its native call, and may hold the lock.
    await expect(host.revision(WORKSPACES)).rejects.toMatchObject({
      reason: 'unavailable',
    });
    expect(host.workersStarted).toBe(1);
  });

  it('treats a request the worker never answers as outcome unknown', async () => {
    const host = scriptedHost('silent', { requestTimeoutMs: 200 });
    await expect(host.revision(WORKSPACES)).rejects.toMatchObject({
      reason: 'outcome-unknown',
    });
  });

  it('treats a result of the wrong shape as outcome unknown', async () => {
    const host = scriptedHost('unexpected-result');
    await expect(host.revision(WORKSPACES)).rejects.toMatchObject({
      reason: 'outcome-unknown',
    });
  });

  it('gives up on a worker that never starts without sending anything', async () => {
    const host = scriptedHost('never-ready', { startupTimeoutMs: 200 });
    await expect(host.revision(WORKSPACES)).rejects.toMatchObject({
      reason: 'unavailable',
    });
  });

  it('refuses calls beyond its queue bound', async () => {
    const host = createHost({ maxQueuedCalls: 1 });
    const first = host.revision(WORKSPACES);
    await expect(host.revision(WORKSPACES)).rejects.toMatchObject({
      reason: 'unavailable',
    });
    await expect(first).resolves.toBe(0);
  });

  it('refuses calls after shutdown and releases the log', async () => {
    const host = createHost();
    await expect(host.revision(WORKSPACES)).resolves.toBe(0);
    await host.shutdown();

    await expect(host.revision(WORKSPACES)).rejects.toMatchObject({
      reason: 'unavailable',
    });
    W5CommitLog.open(dbPath).close();
    expect(host.workersStarted).toBe(1);
  });

  it("starts nothing for the app's host until a call, and refuses calls after quit", async () => {
    mockPaths.dbPath = dbPath;
    mockPaths.root = root;
    const host = getW5CommitLogHost();
    expect(getW5CommitLogHost()).toBe(host);
    expect(host.workersStarted).toBe(0);
    expect(existsSync(dbPath)).toBe(false);

    await shutdownW5CommitLogHost();
    await expect(host.revision(WORKSPACES)).rejects.toMatchObject({
      reason: 'unavailable',
    });
    expect(host.workersStarted).toBe(0);
    expect(existsSync(dbPath)).toBe(false);
  });

  it('loads in main without node:sqlite, which only the worker opens', () => {
    jest.isolateModules(() => {
      jest.doMock('node:sqlite', () => {
        throw new Error('node:sqlite was loaded in main');
      });
      expect((): void => {
        jest.requireActual<unknown>('../commit-log-host');
      }).not.toThrow();
    });
  });
});

it('retains the latest live reservation diagnostics in the launch recovery report', async () => {
  const diagnostics: WorkspaceCreationDiagnostics = {
    kind: 'local-workspace-create',
    workspaceId: 'alpha',
    ownedPaths: ['/owned/alpha'],
    phase: 'before-canonical-commit',
  };
  const host = createHost();
  await host.reserve({
    reservationId: 'progress',
    operation: 'core.workspace.create',
    diagnostics,
  });
  const latest = {
    ...diagnostics,
    ownedPaths: ['/owned/alpha', '/owned/member'],
  };
  await host.updateReservationDiagnostics('progress', latest);
  expect((await host.recoveryReport()).reservations).toMatchObject([
    { reservationId: 'progress', state: 'reserved', diagnostics: latest },
  ]);
  await host.shutdown();
  const restarted = createHost();
  const report = await restarted.recoveryReport();
  expect(report.recoveryRequiredReservations).toContain('progress');
  expect(report.reservations).toMatchObject([
    {
      reservationId: 'progress',
      state: 'recovery-required',
      diagnostics: latest,
    },
  ]);
  await expect(
    restarted.updateReservationDiagnostics('progress', latest),
  ).rejects.toBeInstanceOf(W5CommitRefusedError);
});
