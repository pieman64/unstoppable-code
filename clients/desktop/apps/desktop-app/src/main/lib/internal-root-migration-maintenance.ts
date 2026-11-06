import { join } from 'node:path';
import { readdir, realpath } from 'node:fs/promises';
import {
  InternalRootMigrationRefused,
  type InternalRootColdRecovery,
} from '@canopy/core-runtime/node/internal-root-migration';
import {
  statIfPresent,
  privateDirectory,
} from '@canopy/desktop-shared/node/internal-root-migration/filesystem';
import { createW5RecoveryMaintenanceContext } from './w5-recovery-maintenance';
import { runW5Maintenance, W5MaintenanceRefusedError } from './w5-maintenance';

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
 * commits/reservations, non-untracked file issues, lifecycle artifacts or log issues.
 * unsupported-layout refuses nonprivate source permissions; investigate ownership
 * rather than blindly repairing permissions.
 * Recovery: preserve the ORIGINAL root and journal; use teammate-assisted offline
 * W5 diagnosis there, then retry migration while cold. Never rerun uncertain effects.
 */
export async function settleInternalRootW5(
  source: string,
  workerEntry: string,
  qualification: InternalRootColdRecovery,
): Promise<'settled' | 'nothing-to-settle'> {
  await qualification.assertHeld();
  if (
    qualification.identity.source !== source ||
    (await realpath(source)) !== source
  )
    throw new InternalRootMigrationRefused(
      'recovery-required',
      'Source is not the qualified canonical original root. Preserve both roots and request offline diagnosis.',
    );
  await privateDirectory(source);
  const w5 = join(source, 'w5');
  for (const path of [w5, join(source, 'workspaces')]) {
    const stat = await statIfPresent(path);
    if (stat && (!stat.isDirectory() || (await realpath(path)) !== path))
      throw new InternalRootMigrationRefused(
        'recovery-required',
        'Aliased or unsupported W5 state requires offline diagnosis at the original root.',
      );
  }
  const logPath = join(w5, 'commit-log.sqlite');
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const path = `${logPath}${suffix}`;
    const stat = await statIfPresent(path);
    if (
      stat &&
      (!stat.isFile() ||
        stat.nlink !== 1 ||
        stat.uid !== process.getuid?.() ||
        (await realpath(path)) !== path)
    )
      throw new InternalRootMigrationRefused(
        'recovery-required',
        'Aliased or unsupported W5 log/SQLite sidecar. Preserve the original root and obtain offline W5 diagnosis before retrying.',
      );
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
    const worker = await statIfPresent(workerEntry);
    if (!worker?.isFile() || (await realpath(workerEntry)) !== workerEntry)
      throw new InternalRootMigrationRefused(
        'recovery-required',
        'Compiled W5 worker unavailable. Build it with pnpm run dev:core-daemon before retrying at the original root.',
      );
    await qualification.assertHeld();
    const result = await runW5Maintenance(
      createW5RecoveryMaintenanceContext(source, {
        workerEntry,
        admission: qualification.assertHeld,
      }),
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
    throw new InternalRootMigrationRefused(
      'recovery-required',
      error instanceof W5MaintenanceRefusedError
        ? `W5 source maintenance refused (${error.reason}). Preserve the original root and run W5 offline diagnosis there.`
        : 'W5 source recovery failed or exclusion was unavailable. Preserve the original root and run W5 offline diagnosis there.',
    );
  }
}
