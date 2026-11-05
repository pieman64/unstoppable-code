import { spawn } from 'node:child_process';
// A real Worker owns the commit log behind the daemon authority and framed port.
// Synthetic ownership rows exercise the pre-cut flow without flipping the repository.
import {
  chmodSync,
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
import { runW5RecoveryLaunch } from '../w5-recovery-launch';

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
      allowReservationRelease: false,
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
      allowReservationRelease: false,
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
