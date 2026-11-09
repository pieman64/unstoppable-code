import { join } from 'node:path';
import { readdir, realpath } from 'node:fs/promises';
import {
  InternalRootMigrationRefused,
  type InternalRootColdRecovery,
} from '@canopy/core-runtime/node/internal-root-migration';
import {
  statIfPresent,
  privateDirectory,
  flush,
} from '@canopy/desktop-shared/node/internal-root-migration/filesystem';
import { hostOperatingSystem } from '@canopy/core-platform/host-platform';
import {
  internalRootFilesystemHost,
  createPrivateMigrationDirectory,
  observeMigrationNode,
} from '@canopy/desktop-shared/node/internal-root-migration/filesystem-host';
import { createW5RecoveryMaintenanceContext } from './w5-recovery-maintenance';
import { runW5Maintenance, W5MaintenanceRefusedError } from './w5-maintenance';

function diagnosticField(error: unknown, field: string): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  try {
    const value: unknown = Reflect.get(error, field);
    return typeof value === 'string' ? value : undefined;
  } catch {
    return undefined;
  }
}

function recoveryDiagnostic(error: unknown): string {
  // Node/Jest errors can cross realms; read validated fields, not instanceof Error.
  const message =
    typeof error === 'string' ? error : diagnosticField(error, 'message');
  const limit = 1024;
  const text = message
    ?.slice(0, limit)
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const fields: string[] = [];
  for (const key of ['code', 'stage']) {
    const value = diagnosticField(error, key);
    if (value && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/.test(value))
      fields.push(`${key} ${value}`);
  }
  return `${text || 'Unknown failure'}${message && message.length > limit ? '…' : ''}${fields.length ? ` (${fields.join(', ')})` : ''}`;
}

/**
 * Transaction-qualified pre-Cut-B source recovery (no UI/flip gate or destination startup).
 * Preconditions: migration coordination and targeted cold proof are held by the
 * worker-issued qualification; source is the canonical private original root;
 * workerEntry is dist/core-daemon/w5-commit-log-worker.js built by
 * pnpm run dev:core-daemon, or its matching packaged equivalent.
 * Qualification is rechecked before/after recovery and at W5 worker admission,
 * and revoked before migration coordination releases;
 * W5 retains startup/lifetime/endpoint, cohort and recovery-writer exclusion.
 * Outcomes: settled, or nothing-to-settle for a preferences-only root without a log.
 * Refusals: recovery-required for lost qualification, aliased W5/workspaces,
 * history without a log, aliased/nonregular/foreign/linked log or SQLite sidecars,
 * missing worker, W5 exclusion/recovery failures, remaining
 * commits/reservations, non-untracked W5-owned file issues, lifecycle artifacts or log issues.
 * unsupported-layout refuses nonprivate source permissions; investigate ownership
 * rather than blindly repairing permissions.
 * Recovery: preserve the ORIGINAL root and journal; use teammate-assisted offline
 * W5 diagnosis there, then retry migration while cold. Never rerun uncertain effects.
 */
export async function settleInternalRootW5(
  source: string,
  workerEntry: string,
  qualification: InternalRootColdRecovery,
  options: {
    readonly ownedChildPath?: string;
    readonly windowsProcessPath?: string;
  } = {},
): Promise<'settled' | 'nothing-to-settle'> {
  await qualification.assertHeld();
  const windows = hostOperatingSystem() === 'win32';
  if (
    windows &&
    (!qualification.assertCold ||
      !options.windowsProcessPath ||
      !options.ownedChildPath)
  )
    throw new InternalRootMigrationRefused(
      'recovery-required',
      'Windows offline migration requires native cold qualification and trusted custody/process helpers.',
    );
  const host = internalRootFilesystemHost(options.ownedChildPath);
  if (
    qualification.identity.source !== source ||
    (await realpath(source)) !== source
  )
    throw new InternalRootMigrationRefused(
      'recovery-required',
      'Source is not the qualified canonical original root. Preserve both roots and request offline diagnosis.',
    );
  await privateDirectory(source, host);
  const w5 = join(source, 'w5');
  for (const path of [w5, join(source, 'workspaces')]) {
    const stat = await statIfPresent(path);
    if (stat && (!stat.isDirectory() || (await realpath(path)) !== path))
      throw new InternalRootMigrationRefused(
        'recovery-required',
        'Aliased or unsupported W5 state requires offline diagnosis at the original root.',
      );
    if (windows && stat) await privateDirectory(path, host);
  }
  const logPath = join(w5, 'commit-log.sqlite');
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const path = `${logPath}${suffix}`;
    const stat = await statIfPresent(path);
    if (
      stat &&
      (!stat.isFile() ||
        stat.nlink !== 1 ||
        (!windows && stat.uid !== process.getuid?.()) ||
        (await realpath(path)) !== path)
    )
      throw new InternalRootMigrationRefused(
        'recovery-required',
        'Aliased or unsupported W5 log/SQLite sidecar. Preserve the original root and obtain offline W5 diagnosis before retrying.',
      );
    if (stat) await observeMigrationNode(path, stat, host);
  }
  if (!(await statIfPresent(logPath))) {
    if ((await statIfPresent(w5)) && (await readdir(w5)).length)
      throw new InternalRootMigrationRefused(
        'recovery-required',
        'W5 history exists without its log. Retain the original root and use W5 offline diagnosis.',
      );
    await qualification.assertHeld();
    return 'nothing-to-settle'; // No worker or W5 writes for preferences-only roots.
  }
  try {
    // Pre-Cut-A roots may contain W5 history but no daemon runtime yet. This is
    // W5 settlement infrastructure, created only under B's cold qualification.
    await qualification.assertHeld();
    const runtime = join(source, 'runtime');
    if (!(await statIfPresent(runtime))) {
      await createPrivateMigrationDirectory(runtime, host);
    }
    await privateDirectory(runtime, host);
    await flush(runtime);
    await flush(source);
    const worker = await statIfPresent(workerEntry);
    if (!worker?.isFile() || (await realpath(workerEntry)) !== workerEntry)
      throw new InternalRootMigrationRefused(
        'recovery-required',
        'Compiled W5 worker unavailable. Build it with pnpm run dev:core-daemon before retrying at the original root.',
      );
    await qualification.assertHeld();
    const result = await runW5Maintenance(
      {
        ...createW5RecoveryMaintenanceContext(source, {
          workerEntry,
          admission: qualification.assertHeld,
          windowsProcessPath: options.windowsProcessPath,
          confinementAddon: options.ownedChildPath,
          ...(qualification.assertCold
            ? {
                offlineMigration: async (): Promise<void> => {
                  await qualification.assertHeld();
                  if (!qualification.assertCold)
                    throw new Error('Missing native cold qualification');
                  await qualification.assertCold();
                },
              }
            : {}),
        }),
        diagnosisScope: 'w5-owned',
      },
      { source: 'offline_maintenance', mode: 'reopen' },
    );
    if (result.mode !== 'reopen') throw new Error('Unexpected recovery result');
    const diagnosis = result.diagnosis;
    // Legacy documents may predate W5 capture; untracked alone is not corruption.
    const fileIssues = diagnosis.files.filter(
      (issue) => issue.reason !== 'untracked-file',
    );
    if (
      diagnosis.logIssue ||
      diagnosis.commits.length ||
      diagnosis.reservations.length ||
      fileIssues.length ||
      diagnosis.destructiveJournalArtifactCount !== 0
    )
      throw new InternalRootMigrationRefused(
        'recovery-required',
        `W5 remains unresolved: commits ${diagnosis.commits.map((row) => row.commitId).join(',') || 'none'}, reservations ${diagnosis.reservations.length}, file issues ${fileIssues.length}, lifecycle artifacts ${diagnosis.destructiveJournalArtifactCount ?? 'unknown'}, log ${diagnosis.logIssue ?? 'readable'}. Use offline W5 recovery at the ORIGINAL root; never replay uncertain effects.`,
      );
    await qualification.assertHeld();
    return 'settled';
  } catch (error) {
    if (error instanceof InternalRootMigrationRefused) throw error;
    // Offline diagnosis needs the actual failure; exclusion still refuses closed.
    const detail =
      error instanceof W5MaintenanceRefusedError
        ? `W5 source maintenance refused (${error.reason})${error.operationError === undefined ? '' : `: ${recoveryDiagnostic(error.operationError)}`}`
        : `W5 source recovery failed or exclusion was unavailable: ${recoveryDiagnostic(error)}`;
    throw Object.assign(
      new InternalRootMigrationRefused(
        'recovery-required',
        `${detail}. Preserve the original root and run W5 offline diagnosis there.`,
      ),
      { cause: error },
    );
  }
}
