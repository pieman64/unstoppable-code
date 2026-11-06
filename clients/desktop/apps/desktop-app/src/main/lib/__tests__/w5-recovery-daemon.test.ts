import { spawn } from 'node:child_process';
// A real Worker owns the commit log behind the daemon authority and framed port.
// Synthetic ownership rows exercise the pre-cut flow without flipping the repository.
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as Storage from '@canopy/core-runtime/storage';
import * as electron from 'electron';
import * as maintenanceModule from '../w5-maintenance';
import type * as Workers from '../../ledger/__tests__/fixtures/tsx-worker-threads';
jest.mock('node:worker_threads', () =>
  jest
    .requireActual<
      typeof Workers
    >('../../ledger/__tests__/fixtures/tsx-worker-threads')
    .createTsxWorkerThreads(),
);
jest.mock('@canopy/core-runtime/storage', () => {
  const actual = jest.requireActual<typeof Storage>(
    '@canopy/core-runtime/storage',
  );
  return {
    ...actual,
    STORAGE_OWNERSHIP: actual.STORAGE_OWNERSHIP.map((row) =>
      ['workspace_index', 'workspace_manifest', 'worktree_list'].includes(
        row.id,
      )
        ? { ...row, transitionOwner: 'daemon', currentWriters: [] }
        : row,
    ),
  };
});
import { fingerprintW5File } from '@canopy/desktop-shared/node/w5-commit-log';
import { startW5DaemonRecordHarness } from '@canopy/desktop-shared/node/w5-routed-writes/__tests__/fixtures/w5-daemon-record-harness';
import { createDaemonW5Host } from '../../../../../core-daemon/src/w5-host';
import { createW5RecoveryMaintenanceContext } from '../w5-recovery-maintenance';
import { runW5Maintenance } from '../w5-maintenance';
import { recoveryActions, runW5RecoveryLaunch } from '../w5-recovery-launch';
import {
  isW5RecoveryAvailable,
  isW5RecoveryEntryEnabled,
  isW5ReservationReleaseQualified,
} from '../w5-recovery-gates';
import { isW5DaemonFlipCompiled } from '../w5-flip-gate';
import { runDesktopW5RecoveryLaunch } from '../w5-recovery-desktop';
import {
  writeW5RecoveryRequest,
  w5RecoveryRequestPath,
  w5RecoveryResultPath,
} from '../w5-recovery-request';
import { W5_RESOLVABLE_RESERVATION_OPERATIONS } from '../w5-maintenance-decisions';
import type { W5Diagnosis } from '../w5-maintenance-diagnosis';

jest.setTimeout(60_000);
const posix = process.platform === 'win32' ? test.skip : test;
const workerEntry = join(__dirname, '../../w5-commit-log/commit-log-worker.ts');
let root: string;
let data: string;
let maintenanceFailures: unknown[];
beforeEach(() => {
  maintenanceFailures = [];
  data = realpathSync(mkdtempSync(join(tmpdir(), 'rx-')));
  root = join(data, 'workspaces');
  mkdirSync(root, { mode: 0o700 });
  mkdirSync(join(data, 'runtime'), { mode: 0o700 });
  writeFileSync(join(root, 'index.json'), '{"version":1,"workspaces":[]}');
});
afterEach(() => rmSync(data, { recursive: true, force: true }));

async function maintenance(
  request: Parameters<typeof runW5Maintenance>[1],
): ReturnType<typeof runW5Maintenance> {
  try {
    return await runW5Maintenance(
      createW5RecoveryMaintenanceContext(data, { workerEntry }),
      request,
    );
  } catch (error) {
    maintenanceFailures.push(
      error instanceof Error
        ? {
            name: error.name,
            message: error.message,
            reason: 'reason' in error ? error.reason : undefined,
            stack: error.stack,
          }
        : error,
    );
    throw error;
  }
}
async function expectDaemonWriteResumes(): Promise<void> {
  const daemon = createDaemonW5Host({
    canonicalDataRoot: data,
    workerEntry,
    admission: () => Promise.resolve(),
  });
  const harness = await startW5DaemonRecordHarness({ host: daemon.port });
  try {
    await daemon.open();
    const client = await harness.connect();
    const before = readFileSync(join(root, 'index.json'), 'utf8');
    const next = before.replace(/}$/, ',"recovered":true}');
    await expect(
      client.instruction('core.workspaceRecords.commit', {
        operation: 'core.workspace.update',
        advance: [{ kind: 'workspaces' }],
        files: [
          {
            target: { kind: 'index' },
            contents: next,
            previousFingerprint: fingerprintW5File(before),
          },
        ],
        outcome: null,
      }),
    ).resolves.toMatchObject({ status: 'applied' });
    expect(readFileSync(join(root, 'index.json'), 'utf8')).toBe(next);
  } finally {
    await harness.close();
    await daemon.stop();
  }
}

async function crashReservedDaemon(): Promise<void> {
  const child = spawn(
    process.execPath,
    [
      '--require',
      'tsx/cjs',
      join(__dirname, 'fixtures/w5-recovery-daemon-child.ts'),
      data,
      workerEntry,
    ],
    { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] },
  );
  let stderr = '';
  let stdout = '';
  const closed = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) =>
    child.once('close', (code, signal) => resolve({ code, signal })),
  );
  child.stderr.on('data', (bytes: Buffer) => {
    stderr += bytes.toString();
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () =>
          reject(
            new Error(`Daemon reservation did not become durable: ${stderr}`),
          ),
        30_000,
      );
      const done = (error?: Error): void => {
        clearTimeout(timeout);
        if (error) reject(error);
        else resolve();
      };
      child.once('error', (error) => done(error));
      child.once('exit', (code, signal) =>
        done(
          new Error(
            `Daemon fixture exited before crash: ${code ?? signal}; ${stderr}`,
          ),
        ),
      );
      child.stdout.on('data', (bytes: Buffer) => {
        stdout += bytes.toString();
        if (stdout.includes('"reserved":"crashed"')) done();
      });
    });
    expect(child.kill('SIGKILL')).toBe(true);
    expect(await closed).toEqual({ code: null, signal: 'SIGKILL' });
  } finally {
    if (child.exitCode === null && child.signalCode === null)
      child.kill('SIGKILL');
    await closed;
  }
}

posix(
  'crash reservation → exclusive reopen → resolve → the daemon accepts a write',
  async () => {
    await crashReservedDaemon();
    const outcome = await runW5RecoveryLaunch({
      waitForRelease: () => Promise.resolve(),
      maintenance,
      choose: () =>
        Promise.resolve([
          { kind: 'resolve-reservation', reservationId: 'crashed' },
        ]),
      record: () => Promise.resolve(),
      allowReservationRelease: true,
    });
    expect({ outcome, maintenanceFailures }).toMatchObject({
      outcome: { state: 'complete' },
      maintenanceFailures: [],
    });
    await expectDaemonWriteResumes();
  },
);

posix(
  'the production history gate withholds every reservation class and rejects a forged release',
  async () => {
    expect(isW5ReservationReleaseQualified()).toBe(false);
    await crashReservedDaemon();
    const calls: string[] = [];
    const outcome = await runW5RecoveryLaunch({
      waitForRelease: () => Promise.resolve(),
      maintenance: (request) => {
        calls.push(request.mode);
        return maintenance(request);
      },
      choose: (diagnosis) => {
        expect(diagnosis.reservations).toEqual([
          expect.objectContaining({
            reservationId: 'crashed',
            state: 'recovery-required',
          }),
        ]);
        // A name cannot prove whether a reservation predates registration/#5615.
        const allClasses: W5Diagnosis = {
          ...diagnosis,
          reservations: [
            ...W5_RESOLVABLE_RESERVATION_OPERATIONS,
            'core.workspace.create',
            'unknown.operation',
          ].map((operation, index) => ({
            reservationId: String(index),
            operation,
            state: 'recovery-required',
            diagnostics: '{}',
          })),
        };
        expect(
          recoveryActions(allClasses, isW5ReservationReleaseQualified()),
        ).toEqual([]);
        expect(
          recoveryActions(diagnosis, isW5ReservationReleaseQualified()),
        ).toEqual([]);
        return Promise.resolve([
          { kind: 'resolve-reservation', reservationId: 'crashed' },
        ]);
      },
      record: () => Promise.resolve(),
      allowReservationRelease: isW5ReservationReleaseQualified(),
    });
    expect(outcome).toMatchObject({
      state: 'refused',
      reason: 'operation-excluded',
    });
    expect(calls).toEqual(['reopen']);
    const retained = await maintenance({
      source: 'offline_maintenance',
      mode: 'diagnose',
    });
    if (retained.mode !== 'diagnose') throw new Error('Expected diagnosis');
    expect(retained.diagnosis.reservations).toEqual([
      expect.objectContaining({
        reservationId: 'crashed',
        state: 'recovery-required',
      }),
    ]);
  },
);

posix.each([
  { keyed: false, decision: 'retry-commit' as const },
  { keyed: true, decision: 'retry-commit' as const },
  { keyed: false, decision: 'abandon-commit' as const },
])(
  'saved commit $decision (keyed=$keyed), with the real history gate',
  async ({ keyed, decision }) => {
    const workspaceId = 'retry-target';
    const directory = join(root, workspaceId);
    const path = join(directory, 'workspace.json');
    const before = '{"version":1,"name":"Before"}';
    const after = '{"version":1,"name":"After"}';
    mkdirSync(directory, { mode: 0o700 });
    writeFileSync(path, before);
    const receipt = {
      caller: 'can-5760',
      operation: 'core.workspace.update',
      idempotencyKey: 'saved',
      fingerprint: 'saved-parameters',
    };
    const daemon = createDaemonW5Host({
      canonicalDataRoot: data,
      workerEntry,
      admission: () => Promise.resolve(),
    });
    const harness = await startW5DaemonRecordHarness({ host: daemon.port });
    let commitId: number;
    try {
      await daemon.open();
      const client = await harness.connect();
      chmodSync(directory, 0o500);
      const committed = await client.instruction(
        'core.workspaceRecords.commit',
        {
          operation: 'core.workspace.update',
          ...(keyed ? { receipt } : {}),
          advance: [{ kind: 'workspace', workspaceId }],
          files: [
            {
              target: { kind: 'manifest', workspaceId },
              contents: after,
              previousFingerprint: fingerprintW5File(before),
            },
          ],
          outcome: { saved: true },
        },
      );
      expect(committed.status).toBe('recovery-required');
      commitId = committed.commitId;
    } finally {
      chmodSync(directory, 0o700);
      await harness.close();
      await daemon.stop();
    }
    // Independent terminal evidence must survive an otherwise successful decision.
    const journals = join(data, 'w5/destructive-lifecycles');
    mkdirSync(journals, { recursive: true });
    writeFileSync(join(journals, `${'a'.repeat(64)}.json`), '{}');
    const recorded = jest.fn(() => Promise.resolve());
    if (keyed) {
      const forbidden = await runW5RecoveryLaunch({
        waitForRelease: () => Promise.resolve(),
        maintenance,
        choose: () => Promise.resolve([{ kind: 'abandon-commit', commitId }]),
        record: () => Promise.resolve(),
        allowReservationRelease: isW5ReservationReleaseQualified(),
      });
      expect(forbidden).toMatchObject({
        state: 'refused',
        reason: 'operation-excluded',
      });
      expect(readFileSync(path, 'utf8')).toBe(before);
    }
    const outcome = await runW5RecoveryLaunch({
      waitForRelease: () => Promise.resolve(),
      maintenance,
      choose: (diagnosis) => {
        const actions = recoveryActions(
          diagnosis,
          isW5ReservationReleaseQualified(),
        );
        expect(actions).toEqual(
          keyed
            ? [{ kind: 'retry-commit', commitId }]
            : [
                { kind: 'retry-commit', commitId },
                { kind: 'abandon-commit', commitId },
              ],
        );
        return Promise.resolve([{ kind: decision, commitId }]);
      },
      record: recorded,
      allowReservationRelease: isW5ReservationReleaseQualified(),
    });
    expect(recorded).toHaveBeenCalledWith(
      outcome,
      expect.objectContaining({
        commits: [],
        destructiveJournalArtifactCount: 1,
      }),
      expect.any(Array),
    );
    expect(outcome.entries).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'journals' })]),
    );
    expect(readFileSync(path, 'utf8')).toBe(
      decision === 'retry-commit' ? after : before,
    );
    expect(readFileSync(join(journals, `${'a'.repeat(64)}.json`), 'utf8')).toBe(
      '{}',
    );
    await expectDaemonWriteResumes();
    {
      const resumed = createDaemonW5Host({
        canonicalDataRoot: data,
        workerEntry,
        admission: () => Promise.resolve(),
      });
      const resumedHarness = await startW5DaemonRecordHarness({
        host: resumed.port,
      });
      try {
        await resumed.open();
        const client = await resumedHarness.connect();
        // An index write alone does not qualify the manifest that was repaired.
        const current = decision === 'retry-commit' ? after : before;
        const next = current.replace(/}$/, ',"subsequent":true}');
        await expect(
          client.instruction('core.workspaceRecords.commit', {
            operation: 'core.workspace.update',
            advance: [{ kind: 'workspace', workspaceId }],
            files: [
              {
                target: { kind: 'manifest', workspaceId },
                contents: next,
                previousFingerprint: fingerprintW5File(current),
              },
            ],
            outcome: null,
          }),
        ).resolves.toMatchObject({ status: 'applied' });
        expect(readFileSync(path, 'utf8')).toBe(next);
        if (keyed) {
          await expect(
            client.query('core.workspaceRecords.receipt.lookup', { receipt }),
          ).resolves.toMatchObject({
            status: 'replay',
            commitId,
            outcome: { saved: true },
          });
          // Replay the instruction, not just its lookup, after a newer write.
          await expect(
            client.instruction('core.workspaceRecords.commit', {
              operation: 'core.workspace.update',
              receipt,
              advance: [{ kind: 'workspace', workspaceId }],
              files: [
                {
                  target: { kind: 'manifest', workspaceId },
                  contents: after,
                  previousFingerprint: fingerprintW5File(before),
                },
              ],
              outcome: { saved: true },
            }),
          ).resolves.toMatchObject({
            status: 'replayed',
            commitId,
            outcome: { saved: true },
          });
          expect(readFileSync(path, 'utf8')).toBe(next);
        }
      } finally {
        await resumedHarness.close();
        await resumed.stop();
      }
    }
  },
);

posix.each([
  'legacy',
  'workspace_index',
  'workspace_manifest',
  'worktree_list',
])(
  'exposure-on with %s ownership consumes retained intent once without maintenance or a window',
  async (legacyNamespace) => {
    const compiled = jest.requireActual<typeof Storage>(
      '@canopy/core-runtime/storage',
    );
    const exposed = jest.requireMock<{
      STORAGE_OWNERSHIP: readonly Storage.StorageOwnershipRow[];
    }>('@canopy/core-runtime/storage');
    const ownership = jest.replaceProperty(
      exposed,
      'STORAGE_OWNERSHIP',
      legacyNamespace === 'legacy'
        ? compiled.STORAGE_OWNERSHIP
        : exposed.STORAGE_OWNERSHIP.map((row) =>
            row.id === legacyNamespace
              ? (compiled.STORAGE_OWNERSHIP.find(
                  (actual) => actual.id === row.id,
                ) ?? row)
              : row,
          ),
    );
    const window = jest.spyOn(electron, 'BrowserWindow');
    const writer = jest.spyOn(maintenanceModule, 'runW5Maintenance');
    const shown = jest.spyOn(electron.dialog, 'showMessageBox');
    try {
      expect(isW5RecoveryEntryEnabled()).toBe(true);
      expect(isW5DaemonFlipCompiled()).toBe(false);
      expect(isW5RecoveryAvailable()).toBe(false);
      // No-request startup remains a no-op even before ownership is handed over.
      expect(await runDesktopW5RecoveryLaunch(data)).toBe(true);
      expect(shown).not.toHaveBeenCalled();
      await writeW5RecoveryRequest(data);
      expect(await runDesktopW5RecoveryLaunch(data)).toBe(true);
      expect(existsSync(w5RecoveryRequestPath(data))).toBe(false);
      expect(
        JSON.parse(readFileSync(w5RecoveryResultPath(data), 'utf8')),
      ).toMatchObject({
        status: {
          state: 'refused',
          canRecover: false,
          reason: 'exposure-gated',
          entries: [],
        },
      });
      expect(window).not.toHaveBeenCalled();
      expect(writer).not.toHaveBeenCalled();
      expect(shown).toHaveBeenCalledTimes(1);
      expect(await runDesktopW5RecoveryLaunch(data)).toBe(true);
      expect(shown).toHaveBeenCalledTimes(1);
      const now = Date.now();
      for (const bytes of [
        '',
        '{',
        JSON.stringify({ version: 2, createdAt: now }),
        JSON.stringify({ version: 1, createdAt: 0 }),
        JSON.stringify({ version: 1, createdAt: now, unexpected: true }),
        JSON.stringify({
          version: 1,
          createdAt: now - 24 * 60 * 60 * 1000 - 1000,
        }),
        JSON.stringify({ version: 1, createdAt: now + 60_000 }),
      ]) {
        writeFileSync(w5RecoveryRequestPath(data), bytes, { mode: 0o600 });
        expect(await runDesktopW5RecoveryLaunch(data)).toBe(true);
        expect(existsSync(w5RecoveryRequestPath(data))).toBe(false);
        expect(
          JSON.parse(readFileSync(w5RecoveryResultPath(data), 'utf8')),
        ).toMatchObject({
          status: { state: 'refused', reason: 'invalid-request' },
        });
      }
      expect(window).not.toHaveBeenCalled();
      expect(writer).not.toHaveBeenCalled();
    } finally {
      jest.restoreAllMocks();
      ownership.restore();
    }
  },
);

posix(
  'a stuck unkeyed index commit can be abandoned without overwriting foreign bytes, then daemon writes resume',
  async () => {
    const daemon = createDaemonW5Host({
      canonicalDataRoot: data,
      workerEntry,
      admission: () => Promise.resolve(),
    });
    const workspaceId = 'partial-apply';
    const directory = join(root, workspaceId);
    const manifestPath = join(directory, 'workspace.json');
    const manifest = '{"version":1,"name":"Before"}';
    const before = JSON.stringify({
      version: 1,
      workspaces: [
        { id: workspaceId, name: 'Before', color: 'blue', type: 'cowork' },
      ],
    });
    const pending = before.replace(/}$/, ',"pending":true}');
    const foreign = before.replace(/}$/, ',"foreign":true}');
    mkdirSync(directory, { mode: 0o700 });
    writeFileSync(manifestPath, manifest);
    writeFileSync(join(root, 'index.json'), before);
    const harness = await startW5DaemonRecordHarness({ host: daemon.port });
    let commitId: number;
    try {
      await daemon.open();
      const client = await harness.connect();
      // Reads pass, but atomic replacement cannot create a manifest temp file.
      // The real worker applies the index first (path order), then records EACCES.
      chmodSync(directory, 0o500);
      const commit = await client.instruction('core.workspaceRecords.commit', {
        operation: 'core.workspace.update',
        advance: [{ kind: 'workspaces' }, { kind: 'workspace', workspaceId }],
        files: [
          {
            target: { kind: 'index' },
            contents: pending,
            previousFingerprint: fingerprintW5File(before),
          },
          {
            target: { kind: 'manifest', workspaceId },
            contents: '{"version":1,"name":"After"}',
            previousFingerprint: fingerprintW5File(manifest),
          },
        ],
        outcome: null,
      });
      expect(commit.status).toBe('recovery-required');
      commitId = commit.commitId;
      expect(readFileSync(join(root, 'index.json'), 'utf8')).toBe(pending);
      expect(readFileSync(manifestPath, 'utf8')).toBe(manifest);
      await expect(
        client.instruction('core.workspaceRecords.commit', {
          operation: 'core.workspace.update',
          advance: [{ kind: 'workspaces' }],
          files: [
            {
              target: { kind: 'index' },
              contents: before,
              previousFingerprint: fingerprintW5File(pending),
            },
          ],
          outcome: null,
        }),
      ).rejects.toMatchObject({
        payload: { code: 'core.workspaceRecords.unappliedChange' },
      });
    } finally {
      chmodSync(directory, 0o700);
      try {
        await harness.close();
      } finally {
        await daemon.stop();
      }
    }
    // A retained raw writer can change the applied index while the daemon is down.
    writeFileSync(join(root, 'index.json'), foreign);
    const retried = await runW5RecoveryLaunch({
      waitForRelease: () => Promise.resolve(),
      maintenance,
      choose: (diagnosis) => {
        expect(diagnosis.commits).toEqual([
          expect.objectContaining({ commitId, state: 'recovery-required' }),
        ]);
        const evidence: unknown = JSON.parse(
          diagnosis.commits[0]?.diagnostics ?? 'null',
        );
        expect(evidence).toMatchObject({
          written: [join(root, 'index.json')],
        });
        if (
          typeof evidence !== 'object' ||
          evidence === null ||
          !('error' in evidence) ||
          typeof evidence.error !== 'string'
        ) {
          throw new Error('Expected recovery diagnostics with a string error');
        }
        expect(evidence.error).toContain('EACCES');
        return Promise.resolve([{ kind: 'retry-commit', commitId }]);
      },
      record: () => Promise.resolve(),
      allowReservationRelease: isW5ReservationReleaseQualified(),
    });
    expect({ retried, maintenanceFailures }).toMatchObject({
      retried: { state: 'blocked', reason: 'recovery-required' },
      maintenanceFailures: [],
    });
    expect(readFileSync(join(root, 'index.json'), 'utf8')).toBe(foreign);
    const outcome = await runW5RecoveryLaunch({
      waitForRelease: () => Promise.resolve(),
      maintenance,
      choose: () => Promise.resolve([{ kind: 'abandon-commit', commitId }]),
      record: () => Promise.resolve(),
      allowReservationRelease: isW5ReservationReleaseQualified(),
    });
    expect({ outcome, maintenanceFailures }).toMatchObject({
      outcome: { state: 'complete' },
      maintenanceFailures: [],
    });
    expect(readFileSync(join(root, 'index.json'), 'utf8')).toBe(foreign);
    expect(readFileSync(manifestPath, 'utf8')).toBe(manifest);
    await expectDaemonWriteResumes();
  },
);
