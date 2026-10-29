import { readFile } from 'node:fs/promises';
import { getAutomationsFilePath } from '../lib/paths';
import { hasMigrationRun, markMigrationRun } from '../lib/migrations';
import {
  getAutomationRunArchive,
  isAutomationRunArchiveRecord,
} from './run-archive';

const MIGRATION_KEY = 'automation_run_archive';

export async function migrateAutomationRunArchive(): Promise<void> {
  if (await hasMigrationRun(MIGRATION_KEY)) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(getAutomationsFilePath(), 'utf8'));
  } catch (error) {
    if (
      error instanceof SyntaxError ||
      (typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'ENOENT')
    ) {
      await markMigrationRun(MIGRATION_KEY);
      return;
    }
    throw error;
  }
  const recentRuns =
    typeof parsed === 'object' &&
    parsed !== null &&
    'recentRuns' in parsed &&
    Array.isArray(parsed.recentRuns)
      ? parsed.recentRuns
      : [];
  const archive = getAutomationRunArchive();
  for (const value of recentRuns) {
    if (!isAutomationRunArchiveRecord(value)) continue;
    await archive.appendRun(value);
  }
  await markMigrationRun(MIGRATION_KEY);
}
