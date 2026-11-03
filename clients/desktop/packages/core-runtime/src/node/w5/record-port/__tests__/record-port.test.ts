// W6g (CAN-5498): the W5 record port's wire carries targets only, and each
// side projects them onto its own root.
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import type * as Storage from '../../../../storage';
jest.mock('../../../../storage', () => {
  const actual = jest.requireActual<typeof Storage>('../../../../storage');
  const rows: Storage.StorageOwnershipRow[] = [...actual.STORAGE_OWNERSHIP];
  return {
    ...actual,
    STORAGE_OWNERSHIP: rows,
    setDaemonOwnedForTest: (ids: readonly string[]): void => {
      actual.STORAGE_OWNERSHIP.forEach((row, index) => {
        rows[index] = ids.includes(row.id)
          ? { ...row, transitionOwner: 'daemon', currentWriters: [] }
          : row;
      });
    },
  };
});
const { setDaemonOwnedForTest } = jest.requireMock<{
  setDaemonOwnedForTest: (ids: readonly string[]) => void;
}>('../../../../storage');

import type {
  CanopyCallerDescriptor,
  CoreWorkspaceRecordsCommitParams,
} from '@canopy/protocol/canopy-core';
import { CanopyOperationError } from '../../../../runtime/errors';
import { StorageWriteRefusedError } from '../../../../storage';
import type { W5CaptureResult } from '../../commit-log/capture-contract';
import type {
  W5CommitRequest,
  W5ReceiptLookup,
  W5Resource,
} from '../../commit-log/commit-log';
import type { WorkspaceCreationDiagnostics } from '../../commit-log/reservation-diagnostics';
import {
  W5CommitLogError,
  W5CommitRefusedError,
} from '../../commit-log/errors';
import type { W5CommitOutcome } from '../../commit-log/worker-contract';
import {
  W5FileWriteRefusedError,
  type W5CommitLogHostPort,
} from '../../commit-log-file-store';
import type { W5FileRead } from '../../file-store';
import { createW5RecordAuthority } from '../authority';
import {
  w5RecordTargetFor,
  w5UnnameableRecordFor,
  type W5RecordPortTransport,
} from '../contract';
import { createW5RecordHostPort } from '../host-port';

const ELECTRON = '/electron/data/workspaces';
const DAEMON = '/daemon/data/workspaces';
const fingerprint = (raw: string): string =>
  createHash('sha256').update(raw, 'utf8').digest('hex');

const EMPTY_CAPTURE: W5CaptureResult = {
  files: [],
  discovery: 'not-requested',
  log: {
    commitId: 0,
    retainedCommits: 0,
    unresolvedCommits: 0,
    schemaVersion: 2,
    revisions: {},
    files: [],
    chains: [],
    resourceRevisionEligibility: 'unproven',
  },
};

const unused = (): Promise<never> => Promise.reject(new Error('unused'));

function daemonHost(): W5CommitLogHostPort & {
  commits: W5CommitRequest[];
  commit: jest.Mock<Promise<W5CommitOutcome>, [W5CommitRequest]>;
  capture: jest.Mock<Promise<W5CaptureResult>, [unknown]>;
  lookupReceipt: jest.Mock<Promise<W5ReceiptLookup>, [unknown]>;
  reserve: jest.Mock<Promise<void>, [unknown]>;
  updateReservationDiagnostics: jest.Mock<Promise<void>, [string, unknown]>;
  releaseReservation: jest.Mock<Promise<void>, [string]>;
  markReservationRecoveryRequired: jest.Mock<Promise<void>, [string, unknown]>;
} {
  const commits: W5CommitRequest[] = [];
  return {
    root: DAEMON,
    commits,
    commit: jest.fn((request: W5CommitRequest) => {
      commits.push(request);
      return Promise.resolve<W5CommitOutcome>({
        status: 'applied',
        commitId: commits.length,
        revisions: { 'worktrees:a': commits.length },
      });
    }),
    capture: jest.fn<Promise<W5CaptureResult>, [unknown]>(() =>
      Promise.resolve(EMPTY_CAPTURE),
    ),
    recoveryReport: () =>
      Promise.resolve({
        applied: [1],
        recoveryRequired: [2],
        recoveryRequiredDetails: [
          {
            commitId: 2,
            conflictCount: 1,
            writtenFileCount: 0,
            unexpectedFailure: false,
          },
        ],
        interruptedReservations: 0,
        recoveryRequiredReservations: ['reservation-1'],
        reservations: [
          {
            reservationId: 'reservation-1',
            operation: 'core.workspace.create',
            state: 'recovery-required',
            // Built by Electron's store, as every reservation is.
            diagnostics: { ownedPaths: [`${ELECTRON}/a`] },
          },
        ],
      }),
    lookupReceipt: jest.fn<Promise<W5ReceiptLookup>, [unknown]>(() =>
      Promise.resolve({ status: 'none' }),
    ),
    reserve: jest.fn<Promise<void>, [unknown]>(() => Promise.resolve()),
    updateReservationDiagnostics: jest.fn<Promise<void>, [string, unknown]>(
      () => Promise.resolve(),
    ),
    releaseReservation: jest.fn<Promise<void>, [string]>(() =>
      Promise.resolve(),
    ),
    markReservationRecoveryRequired: jest.fn<Promise<void>, [string, unknown]>(
      () => Promise.resolve(),
    ),
    revision: unused,
  };
}

const CALLER: CanopyCallerDescriptor = {
  principalId: 'local-user',
  clientInstanceId: 'electron-main',
  authorityId: 'a',
  interfaceKind: 'desktop',
  grants: [],
};

class WireError extends Error {
  constructor(readonly payload: unknown) {
    super('wire error');
  }
}

/** Both ends joined by JSON, recording every request and error body. */
function connect(
  host: W5CommitLogHostPort,
  readFile: (path: string) => Promise<W5FileRead> = () =>
    Promise.resolve({ state: 'absent' }),
): {
  transport: W5RecordPortTransport & { commit: jest.Mock };
  wire: string[];
} {
  const authority = createW5RecordAuthority({ host, readFile });
  const wire: string[] = [];
  const cross = async <T>(body: unknown, run: () => Promise<T>): Promise<T> => {
    wire.push(JSON.stringify(body));
    try {
      const result = await run();
      wire.push(JSON.stringify(result));
      return result;
    } catch (error) {
      if (!(error instanceof CanopyOperationError)) throw error;
      wire.push(JSON.stringify(error.payload));
      throw new WireError(JSON.parse(JSON.stringify(error.payload)));
    }
  };
  return {
    wire,
    transport: {
      capture: (request) => cross(request, () => authority.capture(request)),
      recovery: () => cross({}, () => authority.recovery()),
      commit: jest.fn((request: CoreWorkspaceRecordsCommitParams) =>
        cross(request, () => authority.commit(CALLER, request)),
      ),
      lookupReceipt: (receipt) =>
        cross({ receipt }, () => authority.lookupReceipt(receipt)),
      listReservations: () => cross({}, () => authority.listReservations()),
      reserve: (params) => cross(params, () => authority.reserve(params)),
      updateReservationDiagnostics: (params) =>
        cross(params, () =>
          authority.updateReservationDiagnostics(
            params.reservationId,
            params.diagnostics,
          ),
        ),
      releaseReservation: (reservationId) =>
        cross({ reservationId }, () =>
          authority.releaseReservation(reservationId),
        ),
      markReservationRecoveryRequired: (params) =>
        cross(params, () =>
          authority.markReservationRecoveryRequired(
            params.reservationId,
            params.diagnostics,
          ),
        ),
    },
  };
}

/** A wire body with each opaque diagnostics string blanked. */
function withoutOpaqueDiagnostics(body: string | undefined): string {
  if (body === undefined) return '';
  return JSON.stringify(JSON.parse(body), (key, value: unknown) =>
    key === 'diagnostics' && typeof value === 'string' ? '' : value,
  );
}

function listChange(
  path: string,
  previous: string | null = null,
): W5CommitRequest {
  return {
    operation: 'w5.worktree_list.write',
    advance: [{ kind: 'worktrees', workspaceId: 'a' }],
    files: [
      {
        path,
        contents: '{"version":1,"worktrees":[]}',
        previousFingerprint: previous === null ? null : fingerprint(previous),
      },
    ],
    outcome: null,
  };
}

beforeEach(() =>
  setDaemonOwnedForTest([
    'workspace_index',
    'workspace_manifest',
    'worktree_list',
  ]),
);
afterEach(() => setDaemonOwnedForTest([]));

describe('targets', () => {
  it.each([
    [`${ELECTRON}/index.json`, { kind: 'index' }],
    [`${ELECTRON}/index.json.bak`, { kind: 'index-backup' }],
    [`${ELECTRON}/a/workspace.json`, { kind: 'manifest', workspaceId: 'a' }],
    [`${ELECTRON}/a/worktrees.json`, { kind: 'worktrees', workspaceId: 'a' }],
  ])('names %s', (path, target) => {
    expect(w5RecordTargetFor(ELECTRON, path)).toEqual(target);
  });

  it.each([
    `${ELECTRON}/a/../index.json`,
    `${ELECTRON}/a/b/worktrees.json`,
    `${ELECTRON}/a/settings.json`,
    `${ELECTRON}/aux/worktrees.json`,
    `${ELECTRON}`,
    '/elsewhere/index.json',
    `${ELECTRON}-other/index.json`,
  ])('refuses %s', (path) => {
    expect(w5RecordTargetFor(ELECTRON, path)).toBeUndefined();
  });

  // CAN-5531: the workspace files a target cannot name, told apart from foreign paths.
  it.each([
    [
      `${ELECTRON}/a.b/worktrees.json`,
      { kind: 'worktrees', workspaceId: 'a.b' },
    ],
    [
      `${ELECTRON}/aux/workspace.json`,
      { kind: 'manifest', workspaceId: 'aux' },
    ],
    [
      `${ELECTRON}/${'w'.repeat(129)}/worktrees.json`,
      { kind: 'worktrees', workspaceId: 'w'.repeat(129) },
    ],
  ])('names %s as a workspace the capture cannot name', (path, file) => {
    expect(w5UnnameableRecordFor(ELECTRON, path)).toEqual(file);
  });

  it.each([
    `${ELECTRON}/a/worktrees.json`,
    `${ELECTRON}/index.json`,
    `${ELECTRON}/a.b/settings.json`,
    `${ELECTRON}/a.b/c/worktrees.json`,
    `${ELECTRON}/../workspace.json`,
    '/electron/data/workspace.json',
    `${ELECTRON}/./worktrees.json`,
    '/elsewhere/a.b/worktrees.json',
    `${ELECTRON}-other/a.b/worktrees.json`,
    `${ELECTRON}`,
  ])('does not call %s an unnameable workspace file', (path) => {
    expect(w5UnnameableRecordFor(ELECTRON, path)).toBeUndefined();
  });
});

describe('the host port', () => {
  it('sends only targets and receives no host path, in either direction', async () => {
    const host = daemonHost();
    const { transport, wire } = connect(host);
    const port = createW5RecordHostPort({ root: ELECTRON, transport });

    await expect(
      port.commit(listChange(`${ELECTRON}/a/worktrees.json`)),
    ).resolves.toEqual({
      status: 'applied',
      commitId: 1,
      revisions: { 'worktrees:a': 1 },
    });
    await port.recoveryReport();
    await port.capture({
      files: [{ kind: 'index' }],
      discoverWorkspaces: true,
    });

    // The authority projected the target onto its own root.
    expect(host.commits.map((request) => request.files[0]?.path)).toEqual([
      `${DAEMON}/a/worktrees.json`,
    ]);
    // Reservation diagnostics are the host's opaque text (DQ-7 reading (i)).
    expect(wire.join('')).toContain('"diagnostics":"');
    for (const body of wire.map(withoutOpaqueDiagnostics)) {
      expect(body).not.toContain('/electron');
      expect(body).not.toContain('/daemon');
    }
  });

  it('refuses a foreign path before sending anything', async () => {
    const { transport } = connect(daemonHost());
    const port = createW5RecordHostPort({ root: ELECTRON, transport });
    for (const path of [
      '/elsewhere/a/worktrees.json',
      `${ELECTRON}/a/../index.json`,
      `${ELECTRON}/a/settings.json`,
    ])
      await expect(port.commit(listChange(path))).rejects.toMatchObject({
        payload: { kind: 'invalid_argument' },
      });
    expect(transport.commit).not.toHaveBeenCalled();
  });

  it('refuses to advance, expect or read a revision it could not read back, before sending', async () => {
    const { transport, wire } = connect(daemonHost());
    const port = createW5RecordHostPort({ root: ELECTRON, transport });
    const unavailable = { payload: { kind: 'capability_unavailable' } };
    const unnameable: W5Resource[] = [
      ...['w'.repeat(129), 'a.b', 'aux'].flatMap(
        (workspaceId): W5Resource[] => [
          { kind: 'workspace', workspaceId },
          { kind: 'worktrees', workspaceId },
          { kind: 'worktree', workspaceId, worktreeId: 'one' },
        ],
      ),
      // The log's UTF-8 key would not match this one on read.
      { kind: 'worktree', workspaceId: 'a', worktreeId: '\uD800x' },
      { kind: 'worktree', workspaceId: 'a', worktreeId: 't'.repeat(257) },
    ];
    for (const resource of unnameable) {
      await expect(
        port.commit({
          operation: 'w6g.test.unnameable',
          advance: [resource],
          files: [],
          outcome: null,
        }),
      ).rejects.toMatchObject(unavailable);
      await expect(
        port.commit({
          ...listChange(`${ELECTRON}/a/worktrees.json`),
          expectedRevisions: [{ resource, revision: 0 }],
        }),
      ).rejects.toMatchObject(unavailable);
      await expect(port.revision(resource)).rejects.toMatchObject(unavailable);
    }
    expect(wire).toEqual([]);
  });

  it('meters each workspace it cannot name, by operation, and nothing else', async () => {
    const { transport } = connect(daemonHost());
    const unserved: unknown[] = [];
    const port = createW5RecordHostPort({
      root: ELECTRON,
      transport,
      onUnserved: (event) => unserved.push(event),
    });
    const resource: W5Resource = { kind: 'worktrees', workspaceId: 'a.b' };
    await expect(
      port.commit({
        operation: 'w6g.test.unnameable',
        advance: [resource],
        files: [],
        outcome: null,
      }),
    ).rejects.toMatchObject({ payload: { kind: 'capability_unavailable' } });
    await expect(port.revision(resource)).rejects.toMatchObject({
      payload: { kind: 'capability_unavailable' },
    });
    // An unnameable worktree id is refused, but is not the workspace-id class.
    await expect(
      port.revision({
        kind: 'worktree',
        workspaceId: 'a',
        worktreeId: '\uD800',
      }),
    ).rejects.toMatchObject({ payload: { kind: 'capability_unavailable' } });
    await port.commit(listChange(`${ELECTRON}/a/worktrees.json`));
    expect(unserved).toEqual([
      { operation: 'w6g.test.unnameable', reason: 'unsupported-id' },
      { operation: 'core.workspaceRecords.capture', reason: 'unsupported-id' },
    ]);
  });

  it('reads revisions from the captured evidence, and refuses a workspace the capture cannot name', async () => {
    const host = daemonHost();
    host.capture.mockResolvedValue({
      ...EMPTY_CAPTURE,
      files: [{ kind: 'worktrees', workspaceId: 'a', state: 'absent' }],
      log: {
        ...EMPTY_CAPTURE.log,
        revisions: { 'worktrees:a': 4, 'worktree:a/one': 7 },
        chains: [
          {
            file: { kind: 'worktrees', workspaceId: 'a' },
            decisions: 0,
            startsAbsent: false,
            discontinuities: 0,
          },
        ],
      },
    });
    const port = createW5RecordHostPort({
      root: ELECTRON,
      transport: connect(host).transport,
    });
    await expect(
      port.revision({ kind: 'worktree', workspaceId: 'a', worktreeId: 'one' }),
    ).resolves.toBe(7);
    await expect(
      port.revision({ kind: 'worktree', workspaceId: 'a', worktreeId: 'two' }),
    ).resolves.toBe(0);
    await expect(
      port.revision({ kind: 'worktrees', workspaceId: 'aux' }),
    ).rejects.toMatchObject({ payload: { kind: 'capability_unavailable' } });
  });

  it('reports recovery with reservation records read on their own, diagnostics as the host built them', async () => {
    const { transport, wire } = connect(daemonHost());
    const port = createW5RecordHostPort({ root: ELECTRON, transport });
    await expect(port.recoveryReport()).resolves.toEqual({
      applied: [1],
      recoveryRequired: [2],
      recoveryRequiredDetails: [
        {
          commitId: 2,
          conflictCount: 1,
          writtenFileCount: 0,
          unexpectedFailure: false,
        },
      ],
      interruptedReservations: 0,
      recoveryRequiredReservations: ['reservation-1'],
      reservations: [
        {
          reservationId: 'reservation-1',
          operation: 'core.workspace.create',
          state: 'recovery-required',
          diagnostics: { ownedPaths: [`${ELECTRON}/a`] },
        },
      ],
    });
    // recovery.get still carries no diagnostics; the list carries them as
    // one opaque string, never a structured path field.
    const [, recovery, , list] = wire;
    expect(recovery).not.toContain('ownedPaths');
    expect(JSON.parse(list ?? '')).toEqual({
      reservations: [
        {
          reservationId: 'reservation-1',
          operation: 'core.workspace.create',
          state: 'recovery-required',
          diagnostics: JSON.stringify({ ownedPaths: [`${ELECTRON}/a`] }),
        },
      ],
    });
  });
});

describe('keyed calls (CAN-5506)', () => {
  const RECEIPT = {
    caller: 'desktop-host:test',
    operation: 'core.worktree.update',
    idempotencyKey: 'key',
    fingerprint: 'f'.repeat(64),
  };
  const keyedChange = (): W5CommitRequest => ({
    ...listChange(`${ELECTRON}/a/worktrees.json`),
    receipt: RECEIPT,
    reservationId: 'reservation-1',
    outcome: { label: 'Edited' },
  });

  it('sends a keyed commit with its receipt and reservation, and returns a replay unchanged', async () => {
    const host = daemonHost();
    const { transport } = connect(host);
    const port = createW5RecordHostPort({ root: ELECTRON, transport });
    await expect(port.commit(keyedChange())).resolves.toMatchObject({
      status: 'applied',
    });
    expect(host.commits[0]).toMatchObject({
      operation: 'w5.worktree_list.write',
      receipt: RECEIPT,
      reservationId: 'reservation-1',
      outcome: { label: 'Edited' },
      files: [{ path: `${DAEMON}/a/worktrees.json` }],
    });
    host.commit.mockResolvedValueOnce({
      status: 'replayed',
      commitId: 1,
      outcome: { label: 'Edited' },
    });
    await expect(port.commit(keyedChange())).resolves.toEqual({
      status: 'replayed',
      commitId: 1,
      outcome: { label: 'Edited' },
    });
    host.commit.mockResolvedValueOnce({
      status: 'replay-expired',
      commitId: 1,
    });
    await expect(port.commit(keyedChange())).resolves.toEqual({
      status: 'replay-expired',
      commitId: 1,
    });
  });

  it('accepts a keyed commit that names no record, which records only its receipt', async () => {
    const host = daemonHost();
    const { transport } = connect(host);
    const port = createW5RecordHostPort({ root: ELECTRON, transport });
    await expect(
      port.commit({
        operation: 'core.worktree.update',
        receipt: RECEIPT,
        advance: [],
        files: [],
        outcome: null,
      }),
    ).resolves.toMatchObject({ status: 'applied' });
    expect(host.commits[0]).toMatchObject({ receipt: RECEIPT, files: [] });
  });

  it('legacy W5 rows refuse every keyed write before the host sees it, so the daemon writes nothing', async () => {
    const host = daemonHost();
    const { transport, wire } = connect(host);
    const port = createW5RecordHostPort({ root: ELECTRON, transport });
    setDaemonOwnedForTest([]);
    const writes: (() => Promise<unknown>)[] = [
      () =>
        port.commit({
          operation: 'core.worktree.update',
          receipt: RECEIPT,
          advance: [],
          files: [],
          outcome: null,
        }),
      () =>
        port.commit({
          operation: 'core.workspace.create',
          reservationId: 'reservation-1',
          advance: [],
          files: [],
          outcome: null,
        }),
      () =>
        port.reserve({
          reservationId: 'reservation-1',
          operation: RECEIPT.operation,
          receipt: RECEIPT,
        }),
      () =>
        port.updateReservationDiagnostics('reservation-1', {
          kind: 'local-workspace-create',
          workspaceId: 'a',
          ownedPaths: [],
          phase: 'before-canonical-commit',
        }),
      () => port.releaseReservation('reservation-1'),
      () =>
        port.markReservationRecoveryRequired('reservation-1', {
          operation: RECEIPT.operation,
          errorName: 'Error',
        }),
    ];
    for (const write of writes)
      await expect(write()).rejects.toMatchObject({
        name: 'StorageWriteRefusedError',
        writer: 'daemon',
        reason: 'unlisted_writer',
      });
    expect(host.commit).not.toHaveBeenCalled();
    expect(host.reserve).not.toHaveBeenCalled();
    expect(host.updateReservationDiagnostics).not.toHaveBeenCalled();
    expect(host.releaseReservation).not.toHaveBeenCalled();
    expect(host.markReservationRecoveryRequired).not.toHaveBeenCalled();
    expect(
      wire.filter((body) =>
        body.includes('core.workspaceRecords.writeRefused'),
      ),
    ).toHaveLength(writes.length);
    // Reads write nothing, so they stay available, as capture does.
    await expect(port.lookupReceipt(RECEIPT)).resolves.toEqual({
      status: 'none',
    });
    await expect(port.recoveryReport()).resolves.toMatchObject({
      applied: [1],
    });
  });

  it.each<[string, W5ReceiptLookup, unknown]>([
    ['none', { status: 'none' }, { status: 'none' }],
    ['key-reused', { status: 'key-reused' }, { status: 'key-reused' }],
    [
      'replay',
      { status: 'replay', commitId: 4, outcome: { id: 'one' } },
      { status: 'replay', commitId: 4, outcome: { id: 'one' } },
    ],
    [
      'replay-expired',
      { status: 'replay-expired', commitId: 4 },
      { status: 'replay-expired', commitId: 4 },
    ],
    [
      'in-progress',
      { status: 'in-progress', reservationId: 'r' },
      { status: 'in-progress', reservationId: 'r' },
    ],
    [
      'recovery-required',
      {
        status: 'recovery-required',
        reservationId: 'r',
        diagnostics: { ownedPaths: [`${ELECTRON}/a`] },
      },
      {
        status: 'recovery-required',
        reservationId: 'r',
        diagnostics: { ownedPaths: [`${ELECTRON}/a`] },
      },
    ],
  ])(
    'looks up a %s receipt as the in-process host reports it',
    async (_name, lookup, expected) => {
      const host = daemonHost();
      host.lookupReceipt.mockResolvedValue(lookup);
      const { transport } = connect(host);
      const port = createW5RecordHostPort({ root: ELECTRON, transport });
      await expect(port.lookupReceipt(RECEIPT)).resolves.toEqual(expected);
      expect(host.lookupReceipt).toHaveBeenCalledWith(RECEIPT);
    },
  );

  it('projects the authority’s own apply diagnostics in a receipt lookup to counts', async () => {
    const host = daemonHost();
    host.lookupReceipt.mockResolvedValue({
      status: 'commit-recovery-required',
      commitId: 9,
      diagnostics: {
        status: 'recovery-required',
        conflicts: [{ path: `${DAEMON}/a/worktrees.json` }],
        written: [`${DAEMON}/index.json`, `${DAEMON}/a/workspace.json`],
        error: 'EIO',
      },
    });
    const { transport, wire } = connect(host);
    const port = createW5RecordHostPort({ root: ELECTRON, transport });
    await expect(port.lookupReceipt(RECEIPT)).resolves.toEqual({
      status: 'commit-recovery-required',
      commitId: 9,
      diagnostics: {
        conflictCount: 1,
        writtenFileCount: 2,
        unexpectedFailure: true,
      },
    });
    expect(wire.join('')).not.toContain('/daemon');
  });

  it('replays a saved outcome from another realm, as a worker thread clones it', async () => {
    const host = daemonHost();
    const outcome: unknown = runInNewContext('({ worktree: { id: "one" } })');
    host.lookupReceipt.mockResolvedValue({
      status: 'replay',
      commitId: 4,
      outcome,
    });
    host.commit.mockResolvedValue({ status: 'replayed', commitId: 4, outcome });
    const port = createW5RecordHostPort({
      root: ELECTRON,
      transport: connect(host).transport,
    });
    await expect(port.lookupReceipt(RECEIPT)).resolves.toEqual({
      status: 'replay',
      commitId: 4,
      outcome: { worktree: { id: 'one' } },
    });
    await expect(port.commit(keyedChange())).resolves.toEqual({
      status: 'replayed',
      commitId: 4,
      outcome: { worktree: { id: 'one' } },
    });
  });

  it('sends an outcome as the JSON the log stores, dropping absent fields', async () => {
    const host = daemonHost();
    const port = createW5RecordHostPort({
      root: ELECTRON,
      transport: connect(host).transport,
    });
    await port.commit({
      ...keyedChange(),
      outcome: { status: 'created', repair: undefined },
    });
    expect(host.commits[0]?.outcome).toStrictEqual({ status: 'created' });
  });

  it('refuses a saved outcome that is not portable as capability_unavailable', async () => {
    const host = daemonHost();
    host.lookupReceipt.mockResolvedValue({
      status: 'replay',
      commitId: 4,
      outcome: { big: 'x'.repeat(40_000) },
    });
    const port = createW5RecordHostPort({
      root: ELECTRON,
      transport: connect(host).transport,
    });
    await expect(port.lookupReceipt(RECEIPT)).rejects.toMatchObject({
      payload: { kind: 'capability_unavailable' },
    });
  });

  it('sends reservation diagnostics as the opaque text the host built, which the authority parses and stores without resolving a path', async () => {
    const host = daemonHost();
    const { transport, wire } = connect(host);
    const port = createW5RecordHostPort({ root: ELECTRON, transport });
    const created: WorkspaceCreationDiagnostics = {
      kind: 'local-workspace-create',
      workspaceId: 'new',
      ownedPaths: [`${ELECTRON}/new`, '/Users/someone/repos/new'],
      phase: 'before-canonical-commit',
    };
    await port.reserve({
      reservationId: 'r1',
      operation: 'core.workspace.create',
      diagnostics: created,
    });
    await port.reserve({
      reservationId: 'r2',
      operation: RECEIPT.operation,
      receipt: RECEIPT,
    });
    const updated: WorkspaceCreationDiagnostics = {
      ...created,
      phase: 'remote-clone',
      repositories: [
        {
          id: 'source',
          role: 'source',
          status: 'started',
          action: 'clone',
          owned: true,
          path: '/Users/someone/repos/new',
        },
      ],
    };
    await port.updateReservationDiagnostics('r1', updated);
    await port.releaseReservation('r2');
    await port.markReservationRecoveryRequired('r1', {
      operation: 'core.workspace.create',
      errorName: 'GitError',
      errorCode: 'ENOENT',
    });
    expect(host.reserve.mock.calls).toEqual([
      [
        {
          reservationId: 'r1',
          operation: 'core.workspace.create',
          diagnostics: created,
        },
      ],
      [{ reservationId: 'r2', operation: RECEIPT.operation, receipt: RECEIPT }],
    ]);
    expect(host.updateReservationDiagnostics).toHaveBeenCalledWith(
      'r1',
      updated,
    );
    expect(host.releaseReservation).toHaveBeenCalledWith('r2');
    expect(host.markReservationRecoveryRequired).toHaveBeenCalledWith('r1', {
      operation: 'core.workspace.create',
      errorName: 'GitError',
      errorCode: 'ENOENT',
    });
    // The only paths on the wire are inside the opaque diagnostics text.
    expect(JSON.parse(wire[0] ?? '')).toEqual({
      reservationId: 'r1',
      operation: 'core.workspace.create',
      diagnostics: JSON.stringify(created),
    });
    for (const body of wire.map(withoutOpaqueDiagnostics))
      expect(body).not.toMatch(/\/(electron|daemon|Users)\//);
  });

  it('refuses diagnostics the log would not store with the log’s own refusal', async () => {
    const host = daemonHost();
    const port = createW5RecordHostPort({
      root: ELECTRON,
      transport: connect(host).transport,
    });
    const error: unknown = await port
      .updateReservationDiagnostics('r1', {
        kind: 'local-workspace-create',
        workspaceId: '',
        ownedPaths: [],
        phase: 'before-canonical-commit',
      })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(W5CommitRefusedError);
    expect(error).toMatchObject({ reason: 'invalid-state' });
    expect(host.updateReservationDiagnostics).not.toHaveBeenCalled();
  });

  it.each<[string, W5CommitRefusedError]>([
    [
      'key-reused',
      new W5CommitRefusedError('key-reused', 'taken', { reservationId: 'r' }),
    ],
    [
      'in-progress',
      new W5CommitRefusedError('in-progress', 'busy', { reservationId: 'r' }),
    ],
    [
      'outcome-expired',
      new W5CommitRefusedError('outcome-expired', 'old', { commitId: 2 }),
    ],
    [
      'unknown-reservation',
      new W5CommitRefusedError('unknown-reservation', 'gone', {
        reservationId: 'r',
      }),
    ],
    [
      'recovery-required',
      new W5CommitRefusedError('recovery-required', 'stuck', {
        reservationId: 'r',
      }),
    ],
    [
      'invalid-state',
      new W5CommitRefusedError('invalid-state', 'wrong', {
        reservationId: 'r',
        expected: 'reserved',
        actual: 'missing',
      }),
    ],
  ])(
    'rebuilds a %s refusal with its reason and details',
    async (_name, refusal) => {
      const host = daemonHost();
      host.commit.mockRejectedValue(refusal);
      host.reserve.mockRejectedValue(refusal);
      host.releaseReservation.mockRejectedValue(refusal);
      const port = createW5RecordHostPort({
        root: ELECTRON,
        transport: connect(host).transport,
      });
      for (const call of [
        (): Promise<unknown> => port.commit(keyedChange()),
        (): Promise<unknown> =>
          port.reserve({ reservationId: 'r', operation: 'o' }),
        (): Promise<unknown> => port.releaseReservation('r'),
      ]) {
        const error: unknown = await call().catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(W5CommitRefusedError);
        expect(error).toMatchObject({ reason: refusal.reason });
        expect(error instanceof W5CommitRefusedError && error.details).toEqual(
          refusal.details,
        );
      }
    },
  );

  it('refuses a reservation list over one frame with a typed refusal', async () => {
    const host = daemonHost();
    const report = await host.recoveryReport();
    host.recoveryReport = (): Promise<typeof report> =>
      Promise.resolve({
        ...report,
        reservations: Array.from({ length: 200 }, (_, index) => ({
          reservationId: `r${index}`,
          operation: 'core.workspace.create',
          state: 'reserved' as const,
          diagnostics: { pad: 'x'.repeat(48 * 1024) },
        })),
      });
    const port = createW5RecordHostPort({
      root: ELECTRON,
      transport: connect(host).transport,
    });
    await expect(port.recoveryReport()).rejects.toMatchObject({
      reason: 'invalid-state',
    });
  });

  it('never retries a lost keyed response: the thrown failure surfaces once', async () => {
    const host = daemonHost();
    const { transport } = connect(host);
    const lost = new Error('connection closed');
    transport.commit.mockRejectedValueOnce(lost);
    const port = createW5RecordHostPort({ root: ELECTRON, transport });
    await expect(port.commit(keyedChange())).rejects.toBe(lost);
    expect(transport.commit).toHaveBeenCalledTimes(1);
  });

  // Its own decision changed the file the retry still names by its old
  // fingerprint.
  const changedFile = (): Promise<W5FileRead> =>
    Promise.resolve({ state: 'present', raw: 'written by the first attempt' });

  it.each<[string, W5ReceiptLookup, W5CommitOutcome]>([
    [
      'replay',
      { status: 'replay', commitId: 1, outcome: { label: 'Edited' } },
      { status: 'replayed', commitId: 1, outcome: { label: 'Edited' } },
    ],
    [
      'replay-expired',
      { status: 'replay-expired', commitId: 1 },
      { status: 'replay-expired', commitId: 1 },
    ],
  ])(
    'a decided keyed commit (%s) overrides its preflight conflict, so a retry with its original fingerprint replays from the log',
    async (_name, lookup, replay) => {
      const host = daemonHost();
      host.lookupReceipt.mockResolvedValue(lookup);
      host.commit.mockResolvedValue(replay);
      const port = createW5RecordHostPort({
        root: ELECTRON,
        transport: connect(host, changedFile).transport,
      });
      await expect(port.commit(keyedChange())).resolves.toEqual(replay);
      expect(host.lookupReceipt).toHaveBeenCalledWith(RECEIPT);
      // The log, not the lookup, gives the replay.
      expect(host.commit).toHaveBeenCalledTimes(1);
    },
  );

  it.each<[string, W5ReceiptLookup]>([
    ['none', { status: 'none' }],
    ['key-reused', { status: 'key-reused' }],
    ['in-progress', { status: 'in-progress', reservationId: 'reservation-1' }],
    [
      'commit-recovery-required',
      { status: 'commit-recovery-required', commitId: 1, diagnostics: {} },
    ],
    [
      'recovery-required',
      {
        status: 'recovery-required',
        reservationId: 'reservation-1',
        diagnostics: null,
      },
    ],
  ])(
    'a keyed commit not yet decided (%s) keeps the preflight: a changed file is a conflict before any decision',
    async (_name, lookup) => {
      const host = daemonHost();
      host.lookupReceipt.mockResolvedValue(lookup);
      const port = createW5RecordHostPort({
        root: ELECTRON,
        transport: connect(host, changedFile).transport,
      });
      await expect(port.commit(keyedChange())).rejects.toBeInstanceOf(
        W5FileWriteRefusedError,
      );
      expect(host.commit).not.toHaveBeenCalled();
    },
  );

  it('only a keyed preflight conflict looks up a receipt: current files go straight to the log', async () => {
    const host = daemonHost();
    const port = createW5RecordHostPort({
      root: ELECTRON,
      transport: connect(host).transport,
    });
    await port.commit(keyedChange());
    await port.commit(listChange(`${ELECTRON}/a/worktrees.json`));
    expect(host.lookupReceipt).not.toHaveBeenCalled();
    expect(host.commit).toHaveBeenCalledTimes(2);
  });

  it('an unkeyed commit with a changed file is a conflict without a receipt lookup', async () => {
    const host = daemonHost();
    const port = createW5RecordHostPort({
      root: ELECTRON,
      transport: connect(host, changedFile).transport,
    });
    await expect(
      port.commit(listChange(`${ELECTRON}/a/worktrees.json`)),
    ).rejects.toBeInstanceOf(W5FileWriteRefusedError);
    expect(host.lookupReceipt).not.toHaveBeenCalled();
    expect(host.commit).not.toHaveBeenCalled();
  });
});

describe('refusals cross as typed codes and come back with this host’s paths', () => {
  async function refusal(
    host: W5CommitLogHostPort,
    readFile?: (path: string) => Promise<W5FileRead>,
  ): Promise<{ error: unknown; wire: string[] }> {
    const { transport, wire } = connect(host, readFile);
    const conflicts: unknown[] = [];
    const port = createW5RecordHostPort({
      root: ELECTRON,
      transport,
      onConflict: (event) => conflicts.push(event),
    });
    const error: unknown = await port
      .commit(listChange(`${ELECTRON}/a/worktrees.json`))
      .catch((caught: unknown) => caught);
    return { error, wire: [...wire, JSON.stringify(conflicts)] };
  }

  it('a changed file is a pre-decision fingerprint conflict on this host’s path', async () => {
    const host = daemonHost();
    const { error, wire } = await refusal(host, () =>
      Promise.resolve({ state: 'present', raw: 'someone else' }),
    );
    expect(error).toBeInstanceOf(W5FileWriteRefusedError);
    expect(error).toMatchObject({ path: `${ELECTRON}/a/worktrees.json` });
    expect(host.commit).not.toHaveBeenCalled();
    expect(wire.join('')).toContain(
      'core.workspaceRecords.fingerprintConflict',
    );
    expect(wire.join('')).not.toContain('/daemon');
    expect(wire.at(-1)).toBe(
      JSON.stringify([
        { operation: 'w5.worktree_list.write', kind: 'fingerprint' },
      ]),
    );
  });

  it('an unapplied change names this host’s path, never the daemon’s', async () => {
    const host = daemonHost();
    host.commit.mockRejectedValue(
      new W5CommitRefusedError('unapplied-change', 'pending', {
        path: `${DAEMON}/a/worktrees.json`,
        commitId: 3,
      }),
    );
    const { error, wire } = await refusal(host);
    expect(error).toBeInstanceOf(W5CommitRefusedError);
    expect(error).toMatchObject({
      reason: 'unapplied-change',
      details: { path: `${ELECTRON}/a/worktrees.json`, commitId: 3 },
    });
    expect(wire.join('')).not.toContain('/daemon');
  });

  it('a revision conflict keeps its resource and counts', async () => {
    const host = daemonHost();
    host.commit.mockRejectedValue(
      new W5CommitRefusedError('revision-conflict', 'moved', {
        resource: 'worktrees:a',
        expected: 1,
        actual: 2,
      }),
    );
    await expect(refusal(host)).resolves.toMatchObject({
      error: {
        reason: 'revision-conflict',
        details: { resource: 'worktrees:a', expected: 1, actual: 2 },
      },
    });
  });

  it('a recovery-required decision is returned, with no file detail on the wire', async () => {
    const host = daemonHost();
    host.commit.mockResolvedValue({
      status: 'recovery-required',
      commitId: 9,
      revisions: {},
      apply: {
        status: 'recovery-required',
        conflicts: [
          { path: `${DAEMON}/a/worktrees.json`, expected: 'x', actual: 'y' },
        ],
        written: [],
      },
    });
    const { transport, wire } = connect(host);
    const port = createW5RecordHostPort({ root: ELECTRON, transport });
    await expect(
      port.commit(listChange(`${ELECTRON}/a/worktrees.json`)),
    ).resolves.toMatchObject({ status: 'recovery-required', commitId: 9 });
    expect(wire.join('')).toContain('"conflictCount":1');
    expect(wire.join('')).not.toContain('/daemon');
  });

  it('the authority finishes a retired worker’s recovery before its preflight, so a decided change is a conflict, not E9', async () => {
    const path = `${DAEMON}/a/worktrees.json`;
    const disk = new Map<string, string>([[path, 'old']]);
    let pending: string | undefined;
    const host = daemonHost();
    // A worker that decided a change, then failed before applying it: its
    // replacement applies it at launch recovery, before answering anything.
    host.commit.mockImplementationOnce((request) => {
      host.commits.push(request);
      pending = request.files[0]?.contents ?? undefined;
      return Promise.reject(new Error('The W5 commit log stopped'));
    });
    const report = await host.recoveryReport();
    host.recoveryReport = (): Promise<typeof report> => {
      if (pending !== undefined) disk.set(path, pending);
      pending = undefined;
      return Promise.resolve(report);
    };
    const { transport } = connect(host, (filePath) => {
      const raw = disk.get(filePath);
      return Promise.resolve(
        raw === undefined ? { state: 'absent' } : { state: 'present', raw },
      );
    });
    const port = createW5RecordHostPort({ root: ELECTRON, transport });

    await expect(
      port.commit(listChange(`${ELECTRON}/a/worktrees.json`, 'old')),
    ).rejects.toMatchObject({ payload: { kind: 'internal' } });
    // A second writer read `old` before the first failed.
    await expect(
      port.commit(listChange(`${ELECTRON}/a/worktrees.json`, 'old')),
    ).rejects.toBeInstanceOf(W5FileWriteRefusedError);
    expect(host.commit).toHaveBeenCalledTimes(1);
  });

  it('the authority checks ownership as daemon: legacy rows refuse before any decision', async () => {
    setDaemonOwnedForTest([]);
    const host = daemonHost();
    const { error } = await refusal(host);
    expect(error).toBeInstanceOf(StorageWriteRefusedError);
    expect(error).toMatchObject({
      namespaceId: 'worktree_list',
      writer: 'daemon',
      reason: 'unlisted_writer',
    });
    expect(host.commit).not.toHaveBeenCalled();
  });

  it('legacy rows refuse a fileless commit by the records its revisions name', async () => {
    setDaemonOwnedForTest([]);
    const host = daemonHost();
    const authority = createW5RecordAuthority({ host });
    const fileless = { operation: 'o', files: [], outcome: null };
    for (const [params, namespaceId] of [
      [{ ...fileless, advance: [{ kind: 'workspaces' }] }, 'workspace_index'],
      [
        {
          ...fileless,
          advance: [],
          expectedRevisions: [
            { resource: { kind: 'workspace', workspaceId: 'a' }, revision: 1 },
          ],
        },
        'workspace_manifest',
      ],
      [
        {
          ...fileless,
          advance: [{ kind: 'worktree', workspaceId: 'a', worktreeId: 'one' }],
        },
        'worktree_list',
      ],
    ] satisfies [CoreWorkspaceRecordsCommitParams, string][])
      await expect(authority.commit(CALLER, params)).rejects.toMatchObject({
        payload: {
          code: 'core.workspaceRecords.writeRefused',
          details: { namespaceId, reason: 'unlisted_writer' },
        },
      });
    // Nothing named: refused before any decision, whoever owns the records.
    setDaemonOwnedForTest([
      'workspace_index',
      'workspace_manifest',
      'worktree_list',
    ]);
    await expect(
      authority.commit(CALLER, { ...fileless, advance: [] }),
    ).rejects.toMatchObject({ payload: { kind: 'invalid_argument' } });
    expect(host.commit).not.toHaveBeenCalled();
  });

  it('a log failure keeps its code', async () => {
    const host = daemonHost();
    host.commit.mockRejectedValue(
      new W5CommitLogError('WRITER_UNAVAILABLE', 'held'),
    );
    await expect(refusal(host)).resolves.toMatchObject({
      error: { name: 'W5CommitLogError', code: 'WRITER_UNAVAILABLE' },
    });
  });

  it('an unexpected failure is uncertain: an internal error with fixed text', async () => {
    const host = daemonHost();
    host.commit.mockRejectedValue(
      new Error(`EIO writing ${DAEMON}/a/worktrees.json`),
    );
    const { error, wire } = await refusal(host);
    expect(error).toBeInstanceOf(WireError);
    expect(error).toMatchObject({ payload: { kind: 'internal' } });
    expect(wire.join('')).not.toContain('/daemon');
  });

  it('a capture refusal keeps its reason, so the host can read live', async () => {
    const host = daemonHost();
    host.capture.mockRejectedValue(
      new W5CommitRefusedError('invalid-state', 'gone', {
        capture: 'root-unavailable',
        code: 'ENOENT',
      }),
    );
    const unserved: unknown[] = [];
    const port = createW5RecordHostPort({
      root: ELECTRON,
      transport: connect(host).transport,
      onUnserved: (event) => unserved.push(event),
    });
    await expect(
      port.capture({ files: [], discoverWorkspaces: true }),
    ).rejects.toMatchObject({
      reason: 'invalid-state',
      details: { capture: 'root-unavailable' },
    });
    // Only the two capture classes the record port cannot serve are metered.
    expect(unserved).toEqual([]);
  });

  it('meters an over-limit revision read, not a capture whose host reads its files one at a time, and keeps the typed refusal', async () => {
    const host = daemonHost();
    host.capture.mockRejectedValue(
      new W5CommitRefusedError(
        'invalid-state',
        'The W5 capture exceeds its limits.',
        { capture: 'limit-exceeded' },
      ),
    );
    const unserved: unknown[] = [];
    const port = createW5RecordHostPort({
      root: ELECTRON,
      transport: connect(host).transport,
      onUnserved: (event) => unserved.push(event),
    });
    const refused = {
      reason: 'invalid-state',
      details: { capture: 'limit-exceeded' },
    };
    await expect(
      port.capture({
        files: [{ kind: 'worktrees', workspaceId: 'a' }],
        discoverWorkspaces: false,
      }),
    ).rejects.toMatchObject(refused);
    await expect(
      port.revision({ kind: 'worktrees', workspaceId: 'a' }),
    ).rejects.toMatchObject(refused);
    expect(unserved).toEqual([
      { operation: 'core.workspaceRecords.capture', reason: 'limit-exceeded' },
    ]);
  });

  it('a capture over one frame is refused as over its limits', async () => {
    const host = daemonHost();
    const big = Buffer.alloc(6 * 1024 * 1024, 'a').toString('base64');
    host.capture.mockResolvedValue({
      ...EMPTY_CAPTURE,
      files: [{ kind: 'index', state: 'present', base64: big }],
      log: {
        ...EMPTY_CAPTURE.log,
        chains: [
          {
            file: { kind: 'index' },
            decisions: 0,
            startsAbsent: false,
            discontinuities: 0,
          },
        ],
      },
    });
    const port = createW5RecordHostPort({
      root: ELECTRON,
      transport: connect(host).transport,
    });
    await expect(
      port.capture({ files: [{ kind: 'index' }], discoverWorkspaces: false }),
    ).rejects.toMatchObject({
      reason: 'invalid-state',
      details: { capture: 'limit-exceeded' },
    });
  });
});

it('round trips null record contents through core.workspaceRecords.commit without leaking host paths', async () => {
  const electronRoot = resolve('electron', 'data', 'workspaces');
  const daemonRoot = resolve('daemon', 'data', 'workspaces');
  const host = { ...daemonHost(), root: daemonRoot };
  const { transport, wire } = connect(host, () =>
    Promise.resolve({ state: 'present', raw: '{}' }),
  );
  const port = createW5RecordHostPort({ root: electronRoot, transport });
  const { createW5CommitLogFileStore } =
    await import('../../commit-log-file-store');
  const store = createW5CommitLogFileStore({
    getHost: () => port,
    readFile: () => Promise.resolve({ state: 'present', raw: '{}' }),
    warn: () => {},
    admit: (_targets, work) => work(),
    admitWrite: (_target, work) => work(),
  });
  await store.withCommit(
    { operation: 'w5.workspace_records.remove' },
    async () => {
      await store.remove(
        join(electronRoot, 'a', 'workspace.json'),
        { namespace: 'workspace_manifest', writer: 'daemon' },
        {
          operation: 'w5.workspace_manifest.remove',
          advance: [{ kind: 'workspace', workspaceId: 'a' }],
          previousRaw: '{}',
        },
      );
      await store.remove(
        join(electronRoot, 'a', 'worktrees.json'),
        { namespace: 'worktree_list', writer: 'daemon' },
        {
          operation: 'w5.worktree_list.remove',
          advance: [{ kind: 'worktrees', workspaceId: 'a' }],
          previousRaw: '{}',
        },
      );
    },
  );
  expect(host.commits).toHaveLength(1);
  expect(transport.commit).toHaveBeenCalledTimes(1);
  expect(host.commits[0]?.files).toEqual([
    {
      path: join(daemonRoot, 'a', 'workspace.json'),
      contents: null,
      previousFingerprint: fingerprint('{}'),
    },
    {
      path: join(daemonRoot, 'a', 'worktrees.json'),
      contents: null,
      previousFingerprint: fingerprint('{}'),
    },
  ]);
  const commitTraffic = wire.slice(-2).join('');
  expect(commitTraffic).toContain('"contents":null');
  expect(commitTraffic).not.toContain(
    JSON.stringify(electronRoot).slice(1, -1),
  );
  expect(commitTraffic).not.toContain(JSON.stringify(daemonRoot).slice(1, -1));
});
