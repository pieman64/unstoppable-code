import { basename, dirname, resolve } from 'node:path';
import type {
  STORAGE_OWNERSHIP,
  StorageWriterPrincipal,
} from '@canopy/core-runtime/storage';
import { registeredCanopyDataRootResolver } from './canopy-data-root-registration';

type OwnershipRow = (typeof STORAGE_OWNERSHIP)[number];

/** The storage rows whose `admittedWriters` the shared writer enforces. */
export type AdmittedStorageNamespace = Extract<
  OwnershipRow,
  { readonly admittedWriters: readonly string[] }
>['id'];

/** A write by an admitted module, abbreviated as in the manifest. */
export interface AdmittedWriterTarget {
  readonly namespace: AdmittedStorageNamespace;
  readonly writer: StorageWriterPrincipal;
  readonly module: string;
}

// Mirrors the rows' patterns in storage-ownership.yaml; a test compares them.
const DATA_ROOT_FILES: ReadonlyMap<string, AdmittedStorageNamespace> = new Map([
  ['preferences.json', 'preferences'],
  ['preferences.last-good.json', 'preferences'],
  ['preferences.generation.json', 'preferences'],
  ['migrations.json', 'startup_migrations'],
]);
const PREFERENCES_BACKUP = /^preferences\.backup-.+\.json$/;
const APPROVALS_FILE = 'approvals.json';
const APPROVALS_ROOTS = ['workspaces', 'app-workspaces'];

// macOS and Windows data roots are case-insensitive.
const fold = (path: string): string => resolve(path).toLowerCase();

function dataRootFile(name: string): AdmittedStorageNamespace | undefined {
  return (
    DATA_ROOT_FILES.get(name) ??
    (PREFERENCES_BACKUP.test(name) ? 'preferences' : undefined)
  );
}

/** Whether `targetPath` has a curated row's file name; no data root needed. */
export function isAdmittedStorageCandidate(targetPath: string): boolean {
  const name = basename(targetPath).toLowerCase();
  return dataRootFile(name) !== undefined || name === APPROVALS_FILE;
}

/**
 * The curated row `targetPath` belongs to under `dataRoot`, or undefined.
 * A `null` root matches the rows' shapes under any folder. A path that
 * reaches the row through a symbolic link is not seen.
 */
export function admittedStorageRowForPath(
  targetPath: string,
  dataRoot: string | null,
): AdmittedStorageNamespace | undefined {
  const name = basename(targetPath).toLowerCase();
  const parent = fold(dirname(targetPath));
  const rootFile = dataRootFile(name);
  if (rootFile !== undefined)
    return dataRoot === null || parent === fold(dataRoot)
      ? rootFile
      : undefined;
  if (name !== APPROVALS_FILE) return undefined;
  const container = dirname(parent);
  const matches =
    dataRoot === null
      ? APPROVALS_ROOTS.includes(basename(container))
      : APPROVALS_ROOTS.some(
          (folder) => container === fold(resolve(dataRoot, folder)),
        );
  return matches ? 'workspace_approvals' : undefined;
}

// Loaded on the first candidate write: many suites mock canopy-paths with
// factories that cannot run while atomic-file loads.
let dataRootResolver: Promise<() => string> | undefined;

function isModuleNotFound(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    error.code === 'ERR_MODULE_NOT_FOUND'
  );
}

async function loadDataRootResolver(): Promise<() => string> {
  try {
    const paths = await import('../../canopy-paths');
    return paths.getCanopyDataDir;
  } catch (error) {
    const registered = registeredCanopyDataRootResolver();
    if (registered === undefined || !isModuleNotFound(error)) throw error;
    return registered;
  }
}

/** {@link admittedStorageRowForPath} under the resolved Canopy data root. */
export async function admittedStorageRowForWrite(
  targetPath: string,
): Promise<AdmittedStorageNamespace | undefined> {
  if (!isAdmittedStorageCandidate(targetPath)) return undefined;
  const loading = (dataRootResolver ??= loadDataRootResolver());
  let resolveDataRoot: () => string;
  try {
    resolveDataRoot = await loading;
  } catch (error) {
    // Refuses this write; a later one retries once canopy-paths registers.
    if (dataRootResolver === loading) dataRootResolver = undefined;
    throw error;
  }
  return admittedStorageRowForPath(targetPath, resolveDataRoot());
}
