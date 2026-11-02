import type { WorkspaceCreationDiagnostics } from '@canopy/desktop-shared/node/w5-commit-log/reservation-diagnostics';
import * as hostPlatform from '@canopy/core-platform/host-platform';
import {
  existsSync,
  promises as fs,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  W5CommitLog,
  W5CommitRefusedError,
  fingerprintW5File,
  type W5CommitRequest,
} from '@canopy/desktop-shared/node/w5-commit-log';
import {
  isDesktopW5CommitLogWorkerData,
  isW5CommitLogStartupMessage,
} from '../commit-log-worker-contract';
import {
  MALFORMED_REQUEST_MESSAGE,
  W5CommitLogRequestHandler,
} from '../commit-log-worker-requests';

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

function handler(confinementAddon?: string): W5CommitLogRequestHandler {
  return new W5CommitLogRequestHandler(
    log,
    {
      dbPath: join(dir, 'commit-log.sqlite'),
      root,
      ...(confinementAddon !== undefined && { confinementAddon }),
    },
    RECOVERY,
  );
}

const MISSING_ADDON = 'C:\\missing\\cli\\core-owned-child.node';

it('starts only from worker data whose confinement addon and capture root are absent or paths', () => {
  const data = { dbPath: '/log.sqlite', root: '/workspaces' };
  for (const valid of [
    data,
    { ...data, confinementAddon: undefined },
    { ...data, confinementAddon: MISSING_ADDON },
    { ...data, captureRoot: undefined },
    { ...data, captureRoot: '/private/workspaces' },
  ])
    expect(isDesktopW5CommitLogWorkerData(valid)).toBe(true);
  for (const invalid of [
    { ...data, confinementAddon: 1 },
    { ...data, confinementAddon: null },
    { root: '/workspaces', confinementAddon: MISSING_ADDON },
    { ...data, captureRoot: '' },
    { ...data, captureRoot: null },
  ])
    expect(isDesktopW5CommitLogWorkerData(invalid)).toBe(false);
  for (const valid of [
    { type: 'ready' },
    { type: 'ready', captureRoot: '/private/workspaces' },
  ])
    expect(isW5CommitLogStartupMessage(valid)).toBe(true);
  for (const invalid of [
    { type: 'ready', captureRoot: '' },
    { type: 'ready', captureRoot: 1 },
  ])
    expect(isW5CommitLogStartupMessage(invalid)).toBe(false);
});

it.each([
  ['win32 without an addon', 'win32', undefined, 'confinement-unavailable'],
  [
    'win32 whose addon does not load',
    'win32',
    MISSING_ADDON,
    'confinement-unavailable',
  ],
  ['an unsupported host', null, MISSING_ADDON, 'unsupported-platform'],
] as const)(
  'composes the trusted platform refusal for %s without capture filesystem access',
  async (_name, platform, addon, refusal) => {
    const operatingSystem = jest
      .spyOn(hostPlatform, 'hostOperatingSystem')
      .mockReturnValue(platform);
    const dlopen = jest.spyOn(process, 'dlopen');
    const opened = jest.spyOn(fs, 'open');
    const resolved = jest.spyOn(fs, 'realpath');
    const evidence = jest.spyOn(log, 'captureEvidence');
    try {
      const worker = handler(addon);
      expect(operatingSystem).toHaveBeenCalledTimes(1);
      // The addon loads on the first capture, not when the worker starts.
      expect(dlopen).not.toHaveBeenCalled();
      for (const id of [1, 2])
        await expect(
          worker.run({
            id,
            method: 'capture',
            args: [{ files: [{ kind: 'index' }], discoverWorkspaces: true }],
          }),
        ).rejects.toMatchObject({
          reason: 'invalid-state',
          details: { capture: refusal },
        });
      // The trusted host's addon, tried once.
      expect(dlopen.mock.calls.map(([, file]) => file)).toEqual(
        platform === 'win32' && addon ? [addon] : [],
      );
      expect(opened).not.toHaveBeenCalled();
      expect(resolved).not.toHaveBeenCalled();
      expect(evidence).not.toHaveBeenCalled();
      await expect(
        worker.run({
          id: 3,
          method: 'revision',
          args: [{ kind: 'workspaces' }],
        }),
      ).resolves.toBe(0);
    } finally {
      operatingSystem.mockRestore();
      dlopen.mockRestore();
      opened.mockRestore();
      resolved.mockRestore();
      evidence.mockRestore();
    }
  },
);

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

describe('W5 commit log recovery requests (RX1)', () => {
  const RECEIPT = {
    caller: 'portal:1',
    operation: 'core.workspace.create',
    idempotencyKey: 'k1',
    fingerprint: 'f1',
  };

  /** A keyed commit left awaiting recovery because its file changed out of band. */
  async function wedgedCommit(): Promise<number> {
    writeFileSync(indexPath, 'foreign');
    const outcome = await handler().run({
      id: 1,
      method: 'commit',
      args: [
        {
          ...indexChange('v1', 'v0'),
          receipt: RECEIPT,
          outcome: { workspaceId: 'alpha' },
        },
      ],
    });
    expect(outcome).toMatchObject({ status: 'recovery-required' });
    const [commitId] = log.listRecoveryRequiredCommitIds();
    if (commitId === undefined) throw new Error('No commit awaits recovery');
    return commitId;
  }

  it.each([
    ['resolveRecovery', []],
    ['resolveRecovery', ['']],
    ['resolveRecovery', [1]],
    ['resolveRecovery', [null]],
    ['resolveRecovery', ['held', 'extra']],
    ['retryRecoveryRequiredCommit', []],
    ['retryRecoveryRequiredCommit', ['1']],
    ['retryRecoveryRequiredCommit', [0]],
    ['retryRecoveryRequiredCommit', [-1]],
    ['retryRecoveryRequiredCommit', [1.5]],
    ['retryRecoveryRequiredCommit', [Number.NaN]],
    ['retryRecoveryRequiredCommit', [2 ** 53]],
    ['retryRecoveryRequiredCommit', [1, 2]],
    ['abandonRecoveryRequiredCommit', []],
    ['abandonRecoveryRequiredCommit', ['1']],
    ['abandonRecoveryRequiredCommit', [0]],
    ['abandonRecoveryRequiredCommit', [1.5]],
    ['abandonRecoveryRequiredCommit', [1, 2]],
  ] as const)(
    'rejects %s with arguments %j as malformed',
    async (method, args) => {
      log.reserve({
        reservationId: 'held',
        operation: 'core.workspace.create',
        diagnostics: undefined,
      });
      log.markInterruptedReservations();
      const commitId = await wedgedCommit();
      expect(commitId).toBe(1);

      await expect(
        handler().run({ id: 2, method, args }),
      ).rejects.toMatchObject({
        name: 'W5CommitLogRequestError',
        message: MALFORMED_REQUEST_MESSAGE,
      });
      expect(log.listReservations()).toHaveLength(1);
      expect(log.listRecoveryRequiredCommitIds()).toEqual([commitId]);
      expect(readFileSync(indexPath, 'utf8')).toBe('foreign');
    },
  );

  it('passes invalid-state through for a reservation or commit in the wrong state', async () => {
    log.reserve({
      reservationId: 'live',
      operation: 'core.workspace.create',
      diagnostics: undefined,
    });
    const applied = await handler().run({
      id: 1,
      method: 'commit',
      args: [indexChange('v1', null)],
    });
    expect(applied).toMatchObject({ status: 'applied', commitId: 1 });

    const cases = [
      [
        'resolveRecovery',
        'live',
        {
          reservationId: 'live',
          expected: 'recovery-required',
          actual: 'reserved',
        },
      ],
      [
        'resolveRecovery',
        'missing',
        {
          reservationId: 'missing',
          expected: 'recovery-required',
          actual: 'missing',
        },
      ],
      [
        'retryRecoveryRequiredCommit',
        1,
        { commitId: 1, expected: 'recovery-required', actual: 'applied' },
      ],
      [
        'retryRecoveryRequiredCommit',
        9,
        { commitId: 9, expected: 'recovery-required', actual: 'missing' },
      ],
      [
        'abandonRecoveryRequiredCommit',
        1,
        { commitId: 1, expected: 'recovery-required', actual: 'applied' },
      ],
      [
        'abandonRecoveryRequiredCommit',
        9,
        { commitId: 9, expected: 'recovery-required', actual: 'missing' },
      ],
    ] as const;
    for (const [method, arg, details] of cases) {
      const refused = handler().run({ id: 2, method, args: [arg] });
      await expect(refused).rejects.toBeInstanceOf(W5CommitRefusedError);
      await expect(refused).rejects.toMatchObject({
        reason: 'invalid-state',
        details,
      });
    }
    expect(log.listReservations()).toMatchObject([
      { reservationId: 'live', state: 'reserved' },
    ]);
    expect(readFileSync(indexPath, 'utf8')).toBe('v1');
  });

  it('resolves a reservation awaiting recovery so its key runs again', async () => {
    log.reserve({
      reservationId: 'held',
      operation: RECEIPT.operation,
      receipt: RECEIPT,
      diagnostics: undefined,
    });
    log.markInterruptedReservations();

    await expect(
      handler().run({ id: 1, method: 'resolveRecovery', args: ['held'] }),
    ).resolves.toBeNull();
    expect(log.listReservations()).toEqual([]);
    expect(log.lookupReceipt(RECEIPT, RECEIPT.fingerprint)).toEqual({
      status: 'none',
    });
  });

  it('retries a commit without a restore and reports it still awaiting recovery', async () => {
    const commitId = await wedgedCommit();

    await expect(
      handler().run({
        id: 2,
        method: 'retryRecoveryRequiredCommit',
        args: [commitId],
      }),
    ).resolves.toEqual({
      status: 'recovery-required',
      commitId,
      apply: {
        status: 'recovery-required',
        conflicts: [
          {
            path: indexPath,
            expected: fingerprintW5File('v0'),
            actual: fingerprintW5File('foreign'),
          },
        ],
        written: [],
      },
    });
    expect(readFileSync(indexPath, 'utf8')).toBe('foreign');
    expect(log.listRecoveryRequiredCommitIds()).toEqual([commitId]);
    expect(log.listPendingCommits()).toEqual([]);
  });

  it('retries a commit after an exact restore and applies it in the same request', async () => {
    const commitId = await wedgedCommit();
    writeFileSync(indexPath, 'v0');

    await expect(
      handler().run({
        id: 2,
        method: 'retryRecoveryRequiredCommit',
        args: [commitId],
      }),
    ).resolves.toEqual({ status: 'applied', commitId });
    expect(readFileSync(indexPath, 'utf8')).toBe('v1');
    expect(log.listRecoveryRequiredCommitIds()).toEqual([]);
    expect(log.listPendingCommits()).toEqual([]);
    expect(log.lookupReceipt(RECEIPT, RECEIPT.fingerprint)).toMatchObject({
      status: 'replay',
      commitId,
    });
  });

  it('abandons a commit: its receipt goes, its revision advance and the file stay', async () => {
    const commitId = await wedgedCommit();
    expect(log.revision({ kind: 'workspaces' })).toBe(1);

    await expect(
      handler().run({
        id: 2,
        method: 'abandonRecoveryRequiredCommit',
        args: [commitId],
      }),
    ).resolves.toBeNull();
    expect(log.lookupReceipt(RECEIPT, RECEIPT.fingerprint)).toEqual({
      status: 'none',
    });
    expect(log.listRecoveryRequiredCommitIds()).toEqual([]);
    expect(log.revision({ kind: 'workspaces' })).toBe(1);
    expect(readFileSync(indexPath, 'utf8')).toBe('foreign');
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
