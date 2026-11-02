import { dirname, join } from 'node:path';

/** Where recovery moves aside a preferences file it could not load. */
export function createPreferencesBackupPath(
  filePath: string,
  timestamp: string,
): string {
  const safeTimestamp = timestamp.replace(/[:.]/g, '-');
  return join(dirname(filePath), `preferences.backup-${safeTimestamp}.json`);
}

/** A file-rule glob naming every backup {@link createPreferencesBackupPath} creates. */
export function preferencesBackupPathPattern(filePath: string): string {
  return createPreferencesBackupPath(filePath, '*');
}

/** The copy of the last cleanly loaded preferences, which recovery restores. */
export function createPreferencesLastGoodPath(filePath: string): string {
  return join(dirname(filePath), 'preferences.last-good.json');
}

/**
 * The latest generation a save began installing, written before the primary
 * is replaced, so recovery can tell whether last-good is current.
 */
export function createPreferencesGenerationPath(filePath: string): string {
  return join(dirname(filePath), 'preferences.generation.json');
}
