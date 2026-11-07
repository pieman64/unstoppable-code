import { basename, dirname, resolve } from 'node:path';
import type {
  STORAGE_OWNERSHIP,
  StorageWriterPrincipal,
} from '@canopy/core-runtime/storage';
import {
  registeredCanopyDataRootResolver,
  registeredCanopySecureRootResolver,
} from './canopy-data-root-registration';

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
  ['migrations.last-good.json', 'startup_migrations'],
  ['pipeline-plugin-preferences.json', 'pipeline_plugin_preferences'],
  ['pipeline-local-metadata.json', 'pipeline_local_metadata'],
]);
const PREFERENCES_BACKUP = /^preferences\.backup-.+\.json$/;
const MIGRATIONS_DAMAGED = /^migrations\.damaged-.+\.json$/;
const PIPELINE_PREFERENCES_DAMAGED =
  /^pipeline-plugin-preferences\.json\.damaged-.+$/;
const PIPELINE_DEFINITION_FILE =
  /^(?:index\.json|index\.json\.damaged-\d+|[a-z0-9_-]+\.yaml|\.project-share-links\.json)$/;
const VAULT_DATABASE_FILE = /^vault\.sqlite(?:-wal|-shm)?$/;
const GITHUB_CREDENTIAL_FENCE_FILE = 'github-pat-fence.json';
const NATIVE_ARTIFACT_FILES = new Set([
  'owner.json',
  'core-secret-protection.node',
]);
const APPROVALS_FILE = 'approvals.json';
const APPROVALS_ROOTS = ['workspaces', 'app-workspaces'];

// macOS and Windows data roots are case-insensitive.
const fold = (path: string): string => resolve(path).toLowerCase();

function isNativeArtifactPath(
  target: string,
  dataRoot: string | null,
): boolean {
  const parent = dirname(target);
  const root =
    dataRoot === null ? null : fold(resolve(dataRoot, 'native-artifacts'));
  const isRoot = (candidate: string): boolean =>
    root === null
      ? basename(candidate).toLowerCase() === 'native-artifacts'
      : fold(candidate) === root;
  return (
    isRoot(target) ||
    isRoot(parent) ||
    (NATIVE_ARTIFACT_FILES.has(basename(target).toLowerCase()) &&
      isRoot(dirname(parent)))
  );
}

function dataRootFile(name: string): AdmittedStorageNamespace | undefined {
  return (
    DATA_ROOT_FILES.get(name) ??
    (PREFERENCES_BACKUP.test(name)
      ? 'preferences'
      : MIGRATIONS_DAMAGED.test(name)
        ? 'startup_migrations'
        : PIPELINE_PREFERENCES_DAMAGED.test(name)
          ? 'pipeline_plugin_preferences'
          : undefined)
  );
}

/** Whether `targetPath` has a curated row's file name; no data root needed. */
export function isAdmittedStorageCandidate(targetPath: string): boolean {
  const target = resolve(targetPath);
  const name = basename(target).toLowerCase();
  return (
    dataRootFile(name) !== undefined ||
    name === APPROVALS_FILE ||
    name === GITHUB_CREDENTIAL_FENCE_FILE ||
    isNativeArtifactPath(target, null) ||
    name === 'vault' ||
    (basename(dirname(target)).toLowerCase() === 'vault' &&
      VAULT_DATABASE_FILE.test(name)) ||
    name === 'pipelines' ||
    (basename(dirname(target)).toLowerCase() === 'pipelines' &&
      PIPELINE_DEFINITION_FILE.test(name))
  );
}

/**
 * The curated row `targetPath` belongs to under the data or secure root.
 * A `null` root matches the rows' shapes under any folder. A path that
 * reaches the row through a symbolic link is not seen.
 */
export function admittedStorageRowForPath(
  targetPath: string,
  dataRoot: string | null,
  secureDataRoot?: string | null,
): AdmittedStorageNamespace | undefined {
  const target = resolve(targetPath);
  const name = basename(target).toLowerCase();
  const parent = fold(dirname(target));
  const secureRoot =
    secureDataRoot === undefined && dataRoot === null ? null : secureDataRoot;
  if (isNativeArtifactPath(target, dataRoot))
    return 'daemon_native_artifact_snapshots';
  if (
    secureRoot !== undefined &&
    name === GITHUB_CREDENTIAL_FENCE_FILE &&
    (secureRoot === null || parent === fold(secureRoot))
  )
    return 'daemon_github_credential_fence';
  if (
    secureRoot !== undefined &&
    ((name === 'vault' &&
      (secureRoot === null || parent === fold(secureRoot))) ||
      (VAULT_DATABASE_FILE.test(name) &&
        (secureRoot === null
          ? basename(parent) === 'vault'
          : parent === fold(resolve(secureRoot, 'vault')))))
  )
    return 'daemon_vault_store';
  if (
    (name === 'pipelines' &&
      (dataRoot === null || parent === fold(dataRoot))) ||
    (PIPELINE_DEFINITION_FILE.test(name) &&
      (dataRoot === null
        ? basename(parent) === 'pipelines'
        : parent === fold(resolve(dataRoot, 'pipelines'))))
  )
    return 'pipeline_definitions';
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
interface StorageRoots {
  readonly dataRoot: () => string;
  readonly secureRoot?: () => string;
}
let dataRootResolver: Promise<StorageRoots> | undefined;

function isModuleNotFound(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    error.code === 'ERR_MODULE_NOT_FOUND'
  );
}

async function loadDataRootResolver(): Promise<StorageRoots> {
  try {
    const paths = await import('../../canopy-paths');
    return {
      dataRoot: paths.getCanopyDataDir,
      secureRoot: paths.getCanopySecureDataDir,
    };
  } catch (error) {
    const registered = registeredCanopyDataRootResolver();
    if (registered === undefined || !isModuleNotFound(error)) throw error;
    return {
      dataRoot: registered,
      secureRoot: registeredCanopySecureRootResolver(),
    };
  }
}

/** {@link admittedStorageRowForPath} under the resolved Canopy storage roots. */
export async function admittedStorageRowForWrite(
  targetPath: string,
): Promise<AdmittedStorageNamespace | undefined> {
  if (!isAdmittedStorageCandidate(targetPath)) return undefined;
  const loading = (dataRootResolver ??= loadDataRootResolver());
  let roots: StorageRoots;
  try {
    roots = await loading;
  } catch (error) {
    // Refuses this write; a later one retries once canopy-paths registers.
    if (dataRootResolver === loading) dataRootResolver = undefined;
    throw error;
  }
  return admittedStorageRowForPath(
    targetPath,
    roots.dataRoot(),
    roots.secureRoot?.(),
  );
}
