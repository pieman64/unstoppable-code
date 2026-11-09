/** Offline operator entry; ordinary startup only prints this command, never runs it. */
import { homedir } from 'node:os';
import { lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { hostOperatingSystem } from '../../../packages/core-platform/src/host-platform';
import { windowsPrincipalObserver } from '../../../packages/core-platform/src';
import { internalRootFilesystemHost } from '../../../packages/desktop-shared/src/node/internal-root-migration/filesystem-host';
import { createFreshInternalRoot } from '../../../packages/desktop-shared/src/node/internal-root-migration/fresh-start';
import { canonicalStoragePath } from '../../../packages/core-platform/src/build-storage-startup';
import { parseInternalRootMigrationOptions } from '../../../packages/desktop-shared/src/node/internal-root-migration/operator-options';
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

import { createInternalRootRelocationRepairs } from '../../../packages/desktop-shared/src/node/internal-root-migration/repairs';
import { desktopW5Durability } from '../../../packages/desktop-shared/src/node/w5-commit-log/durability';

async function main(): Promise<void> {
  const options = parseInternalRootMigrationOptions(process.argv.slice(2));
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
    recoverW5: async (source, qualification): Promise<void> => {
      const { settleInternalRootW5 } =
        await import('../src/main/lib/internal-root-migration-maintenance');
      await settleInternalRootW5(
        source,
        resolve('dist/core-daemon/w5-commit-log-worker.js'),
        qualification,
        { ownedChildPath, windowsProcessPath },
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
  const result = await migrateInternalRoot(
    worker,
    identity,
    {
      apply: options.apply,
      declareInternal: options.declareInternal,
      rebuild: options.rebuild,
    },
    createInternalRootRelocationRepairs({
      durability: desktopW5Durability,
      windowsPrincipal,
      ownedChildPath,
      filesystemHost,
    }),
  );
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
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
