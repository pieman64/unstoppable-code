import type { WorkspaceCreationDiagnostics } from '@canopy/desktop-shared/node/w5-commit-log/reservation-diagnostics';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  W5CommitLog,
  fingerprintW5File,
  type W5CommitRequest,
} from '@canopy/desktop-shared/node/w5-commit-log';
import { W5CommitLogRequestHandler } from '../commit-log-worker-requests';

const RECOVERY = {
  applied: [],
  recoveryRequired: [],
  interruptedReservations: 0,
};

let dir: string;
let root: string;
let indexPath: string;
let log: W5CommitLog;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'w5-worker-requests-'));
  root = join(dir, 'workspaces');
  mkdirSync(root);
  indexPath = join(root, 'index.json');
  log = W5CommitLog.open(join(dir, 'commit-log.sqlite'));
});

afterEach(() => {
  log.close();
  rmSync(dir, { recursive: true, force: true });
});

function handler(): W5CommitLogRequestHandler {
  return new W5CommitLogRequestHandler(
    log,
    { dbPath: join(dir, 'commit-log.sqlite'), root },
    RECOVERY,
  );
}

function indexChange(
  contents: string,
  previous: string | null,
): W5CommitRequest {
  return {
    operation: 'internal.repository.write',
    advance: [{ kind: 'workspaces' }],
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

function keyedChange(): W5CommitRequest {
  return {
    ...indexChange('v1', null),
    receipt: {
      caller: 'portal:1',
      operation: 'core.workspace.create',
      idempotencyKey: 'k1',
      fingerprint: 'f1',
    },
    outcome: { workspaceId: 'alpha' },
  };
}

describe('W5 commit log worker requests (CAN-3805)', () => {
  // A call that failed after its commit was durable left these commits
  // unwritten in a worker that kept serving.
  it('writes a commit an earlier call left unwritten before it replays its key', async () => {
    log.commit(keyedChange());
    expect(existsSync(indexPath)).toBe(false);

    await expect(
      handler().run({ id: 1, method: 'commit', args: [keyedChange()] }),
    ).resolves.toMatchObject({
      status: 'replayed',
      outcome: { workspaceId: 'alpha' },
    });
    expect(readFileSync(indexPath, 'utf8')).toBe('v1');
    expect(log.listPendingCommits()).toEqual([]);
  });

  it('writes a commit an earlier call left unwritten before it commits over it', async () => {
    log.commit(indexChange('v1', null));

    await expect(
      handler().run({
        id: 1,
        method: 'commit',
        args: [indexChange('v2', 'v1')],
      }),
    ).resolves.toMatchObject({ status: 'applied' });
    expect(readFileSync(indexPath, 'utf8')).toBe('v2');
    expect(log.listPendingCommits()).toEqual([]);
  });
});

it('updates live diagnostics and reports the latest validated facts without completing the reservation', async () => {
  const diagnostics: WorkspaceCreationDiagnostics = {
    kind: 'local-workspace-create',
    workspaceId: 'alpha',
    ownedPaths: ['/owned/alpha'],
    phase: 'before-canonical-commit',
  };
  log.reserve({
    reservationId: 'progress',
    operation: 'core.workspace.create',
    diagnostics,
  });
  const latest = {
    ...diagnostics,
    ownedPaths: ['/owned/alpha', '/owned/member'],
  };
  await expect(
    handler().run({
      id: 1,
      method: 'updateReservationDiagnostics',
      args: ['progress', { ...latest, message: 'must not persist' }],
    }),
  ).resolves.toBeNull();
  await expect(
    handler().run({ id: 2, method: 'recoveryReport', args: [] }),
  ).resolves.toMatchObject({
    reservations: [
      { reservationId: 'progress', state: 'reserved', diagnostics: latest },
    ],
  });
  await expect(
    handler().run({
      id: 3,
      method: 'updateReservationDiagnostics',
      args: [
        'progress',
        {
          ...latest,
          repositories: [
            {
              role: 'source',
              id: 'source',
              owned: false,
              status: 'completed',
              path: '/external',
            },
          ],
        },
      ],
    }),
  ).rejects.toThrow();
  log.markInterruptedReservations();
  await expect(
    handler().run({
      id: 4,
      method: 'updateReservationDiagnostics',
      args: ['progress', latest],
    }),
  ).rejects.toMatchObject({ reason: 'invalid-state' });
});
