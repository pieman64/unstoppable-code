import { basename, dirname, join } from 'node:path';

/** The copy of the last written ledger, which recovery restores. */
export function createMigrationsLastGoodPath(filePath: string): string {
  return join(dirname(filePath), 'migrations.last-good.json');
}

/** Where recovery keeps an unreadable ledger's bytes before restoring. */
export function createMigrationsDamagedPath(
  filePath: string,
  stamp: string,
): string {
  return join(dirname(filePath), `migrations.damaged-${stamp}.json`);
}

export function migrationsDamagedPathPattern(filePath: string): string {
  return createMigrationsDamagedPath(filePath, '*');
}

export function isMigrationsDamagedFileName(name: string): boolean {
  return /^migrations\.damaged-.+\.json$/.test(basename(name));
}
