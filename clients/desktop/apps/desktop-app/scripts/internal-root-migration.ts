/** Offline operator entry; ordinary startup only prints this command, never runs it. */
import { homedir } from 'node:os';
import { lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { hostOperatingSystem } from '../../../packages/core-platform/src/host-platform';
import { windowsPrincipalObserver } from '../../../packages/core-platform/src';
import { internalRootFilesystemHost } from '../../../packages/desktop-shared/src/node/internal-root-migration/filesystem-host';
import { createFreshInternalRoot } from '../../../packages/desktop-shared/src/node/internal-root-migration/fresh-start';
import { canonicalStoragePath } from '../../../packages/core-platform/src/build-storage-startup';
import {
  parseInternalRootMigrationOptions,
  selectInternalRootArchiveAbandonments,
} from '../../../packages/desktop-shared/src/node/internal-root-migration/operator-options';
import canopy from '../../../brands/canopy/brand.json';
import unstoppableCode from '../../../brands/unstoppable-code/brand.json';
import {
  migrateInternalRoot,
  InternalRootMigrationRefused,
} from '../../../packages/core-runtime/src/node/internal-root-migration';
import {
  createInternalRootMigrationWorker,
  internalRootIdentity,
} from '../../../packages/desktop-shared/src/node/internal-root-migration';

import {
  createInternalRootRelocationRepairs,
  reportInternalRootCleanup,
} from '../../../packages/desktop-shared/src/node/internal-root-migration/repairs';
import {
  formatInternalRootCleanupReport,
  type InternalRootCleanupReport,
} from '../../../packages/desktop-shared/src/node/internal-root-migration/cleanup-candidates';
import { assertAbandonedArchivesMatch } from '../../../packages/desktop-shared/src/node/internal-root-migration/lifecycle-policy';
import { inspectDestructiveJournals } from '../../../packages/desktop-shared/src/node/w5-destructive-journal';
import { desktopW5Durability } from '../../../packages/desktop-shared/src/node/w5-commit-log/durability';

function phase<Args extends unknown[], Result>(
  name: string,
  operation: (...args: Args) => Result,
): (...args: Args) => Result {
  return (...args: Args): Result => {
    process.stderr.write(`Migration: ${name}\n`);
    return operation(...args);
  };
}

async function main(): Promise<void> {
  const options = parseInternalRootMigrationOptions(process.argv.slice(2));
  let abandonArchives = options.abandonArchives;
  const brand = options.brandId === 'canopy' ? canopy : unstoppableCode;
  // Only explicit source selection; ordinary startup never guesses a predecessor.
  const identity = internalRootIdentity(
    canonicalStoragePath(homedir()),
    brand,
    options.sourceDirectory,
  );
  const os = hostOperatingSystem();
  const ownedChildPath =
    os === 'win32' || os === 'linux'
      ? resolve(
          '.cache/native-owned-child',
          `${os}-${process.arch}`,
          'core-owned-child.node',
        )
      : undefined;
  const windowsProcessPath = resolve(
    '.cache/bin/win32-x64/canopy-process-identity.exe',
  );
  const windowsPrincipal =
    os === 'win32' ? windowsPrincipalObserver(windowsProcessPath) : undefined;
  const filesystemHost = internalRootFilesystemHost(ownedChildPath);
  const worker = createInternalRootMigrationWorker({
    filesystemHost,
    ownedChildPath,
    ...(os === 'win32' || os === 'linux'
      ? { nativeColdHost: { kind: 'repository', root: resolve('.') } as const }
      : {}),
    executableBrands: [canopy, unstoppableCode],
    diagnose: async (source): Promise<readonly string[]> => {
      process.stderr.write('Migration: W5 diagnosis\n');
      const { diagnoseInternalRootW5 } =
        await import('../src/main/lib/internal-root-migration-inventory');
      return diagnoseInternalRootW5(source, abandonArchives);
    },
    recoverW5: async (source, qualification): Promise<void> => {
      const { settleInternalRootW5 } =
        await import('../src/main/lib/internal-root-migration-maintenance');
      await settleInternalRootW5(
        source,
        resolve('dist/core-daemon/w5-commit-log-worker.js'),
        qualification,
        { ownedChildPath, windowsProcessPath, abandonArchives },
      );
    },
  });
  if (options.skipMigration) {
    await createFreshInternalRoot({
      identity,
      worker,
      ownedChildPath,
      windowsPrincipal,
    });
    process.stdout.write(
      `${JSON.stringify({ kind: 'fresh-internal', destination: identity.destination })}\n`,
    );
    return;
  }
  const disposition = join(
    identity.destination,
    '..',
    `.${identity.brandId}-internal-startup.json`,
  );
  try {
    await lstat(disposition);
    throw new InternalRootMigrationRefused(
      'destination-exists',
      'An explicit fresh-start choice exists. Retain it and the internal folder; do not migrate over this installation.',
    );
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
      throw error;
  }
  const prior = await worker.readJournal(identity);
  const frozenAbandonments = [
    ...new Set(
      prior?.repairPlan?.lifecycleJournals?.flatMap((entry) =>
        entry.abandoned
          ? [`${entry.abandoned.workspaceId}/${entry.abandoned.worktreeId}`]
          : [],
      ) ?? [],
    ),
  ];
  abandonArchives = selectInternalRootArchiveAbandonments(
    options.abandonArchives,
    prior?.repairPlan ? frozenAbandonments : undefined,
  );
  if (options.abandonArchives.length)
    assertAbandonedArchivesMatch(
      (await inspectDestructiveJournals(identity.source)).records,
      options.abandonArchives,
    );
  const repairs = createInternalRootRelocationRepairs({
    abandonArchives,
    durability: desktopW5Durability,
    windowsPrincipal,
    ownedChildPath,
    filesystemHost,
  });
  const result = await migrateInternalRoot(
    {
      ...worker,
      inventory: phase('Walking source', worker.inventory),
      proveCold: phase('Cold proof', worker.proveCold),
      recoverW5: phase('W5 recovery', worker.recoverW5),
      build: phase('Building destination', worker.build),
      seal: phase('Sealing destination', worker.seal),
      publish: phase('Publishing destination', worker.publish),
      relocateSecure: phase('Secure relocation', worker.relocateSecure),
    },
    identity,
    {
      apply: options.apply,
      declareInternal: options.declareInternal,
      rebuild: options.rebuild,
    },
    {
      ...repairs,
      prepare: phase('Git checks', repairs.prepare),
      ...(repairs.inspect
        ? { inspect: phase('Git checks', repairs.inspect) }
        : {}),
    },
  );
  let cleanupCandidates: InternalRootCleanupReport | null = null;
  let cleanupReportError: string | undefined;
  try {
    process.stderr.write('Migration: Cleanup report\n');
    cleanupCandidates = await reportInternalRootCleanup(
      identity,
      result.kind === 'complete' || result.journal?.phase === 'complete',
      filesystemHost,
      result.kind === 'inventory'
        ? result.inventory.bytes
        : result.journal.inventory.bytes,
      abandonArchives,
    );
    process.stderr.write(formatInternalRootCleanupReport(cleanupCandidates));
  } catch (error: unknown) {
    // Reporting failure cannot turn a durably completed migration into a refusal.
    cleanupReportError = `Migration returned ${result.kind}, but cleanup reporting failed: ${error instanceof Error ? error.message : 'Unknown report failure'}. Retain both roots and the journal; reporting did not roll back migration. Resolve the report issue and run --inventory, not --rebuild, to refresh the report. Removal is your choice; no cleanup candidates were changed.`;
    process.stderr.write(`Cleanup candidates\n${cleanupReportError}\n`);
    process.exitCode = 1;
  }
  process.stdout.write(
    `${JSON.stringify({ ...result, cleanupCandidates, ...(cleanupReportError ? { cleanupReportError } : {}) }, null, 2)}\n`,
  );
}

void main().catch((error: unknown): void => {
  const result =
    error instanceof InternalRootMigrationRefused
      ? { kind: 'refused', reason: error.reason, recovery: error.recovery }
      : {
          kind: 'refused',
          reason: 'invalid-request-or-runtime',
          recovery:
            error instanceof Error
              ? error.message
              : 'Unknown failure; retain both roots and the journal.',
        };
  process.stderr.write(`${JSON.stringify(result)}\n`);
  process.exitCode = 1;
});
