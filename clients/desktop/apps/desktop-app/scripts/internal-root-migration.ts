/** Repo-only bootstrap; CAN-5786 publishes/activates the operator entry. */
import { homedir } from 'node:os';
import { resolve } from 'node:path';
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

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const allowed = [
    '--brand=canopy',
    '--brand=unstoppable-code',
    '--apply',
    '--declare-internal',
    '--inventory',
    '--rebuild',
  ];
  if (
    args.some((arg) => !allowed.includes(arg)) ||
    args.filter((arg) => arg.startsWith('--brand=')).length !== 1 ||
    (args.includes('--apply') && args.includes('--inventory')) ||
    (args.includes('--rebuild') && !args.includes('--apply'))
  )
    throw new Error(
      'Usage: node --import tsx apps/desktop-app/scripts/internal-root-migration.ts --brand=canopy|unstoppable-code [--inventory | --apply] [--declare-internal] [--rebuild]',
    );
  const brand = args.includes('--brand=canopy') ? canopy : unstoppableCode;
  // Only trusted manifests; no caller-supplied data-root or fallback selection.
  const identity = internalRootIdentity(homedir(), brand);
  const worker = createInternalRootMigrationWorker({
    executableBrands: [canopy, unstoppableCode],
    recoverW5: async (source, qualification): Promise<void> => {
      const { settleInternalRootW5 } =
        await import('../src/main/lib/internal-root-migration-maintenance');
      await settleInternalRootW5(
        source,
        resolve('dist/core-daemon/w5-commit-log-worker.js'),
        qualification,
      );
    },
  });
  const result = await migrateInternalRoot(worker, identity, {
    apply: args.includes('--apply'),
    declareInternal: args.includes('--declare-internal'),
    rebuild: args.includes('--rebuild'),
  });
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
