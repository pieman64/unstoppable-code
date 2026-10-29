import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { getMigrationsFilePath } from './paths';
import { isErrnoException, isRecord } from './type-guards';

const MIGRATION_STATE_VERSION = 1;

type MigrationState = { version: typeof MIGRATION_STATE_VERSION } & Record<
  string,
  unknown
>;

function normalizeMigrationState(value: unknown): MigrationState {
  if (!isRecord(value)) {
    return { version: MIGRATION_STATE_VERSION };
  }
  if ('version' in value && value.version !== MIGRATION_STATE_VERSION) {
    return { version: MIGRATION_STATE_VERSION };
  }
  return { version: MIGRATION_STATE_VERSION, ...value };
}

export async function readMigrationState(): Promise<MigrationState> {
  try {
    const raw = await readFile(getMigrationsFilePath(), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    return normalizeMigrationState(parsed);
  } catch (error) {
    if (
      (isErrnoException(error) && error.code === 'ENOENT') ||
      error instanceof SyntaxError
    ) {
      return { version: MIGRATION_STATE_VERSION };
    }
    throw error;
  }
}

export async function hasMigrationRun(migrationKey: string): Promise<boolean> {
  if (migrationKey === 'version') {
    return false;
  }
  const state = await readMigrationState();
  return state[migrationKey] === true;
}

export async function markMigrationRun(migrationKey: string): Promise<void> {
  const filePath = getMigrationsFilePath();
  const state = await readMigrationState();
  if (state[migrationKey] === true) {
    return;
  }
  const markers: Record<string, unknown> = { ...state };
  delete markers.version;
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(
    filePath,
    `${JSON.stringify(
      { version: MIGRATION_STATE_VERSION, ...markers, [migrationKey]: true },
      null,
      2,
    )}\n`,
    'utf8',
  );
}
