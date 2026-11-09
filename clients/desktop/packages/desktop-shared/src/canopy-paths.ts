import { observeStoragePathSync } from '@canopy/core-runtime/node/storage-path-observation';
import type * as buildStorageStartup from '@canopy/core-platform/build-storage-startup';
import * as os from 'node:os';
import * as path from 'node:path';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { types } from 'node:util';
import {
  resolveSecureDataDir,
  resolveBuildStoragePaths,
  type BuildStoragePaths,
} from '@canopy/core-runtime/node/secure-data-dir';
import { BRAND } from '@canopy/brand/current';
import {
  compiledBuildIdentity,
  dataDirectoryOverride,
} from '@canopy/core-runtime/node/build-identity';
import type {
  BrandBuildIdentity,
  CanopyRuntimeMode,
  CanopySecureStorageMode,
  ResolvedCanopyDataDir,
  ResolvedCanopySecureDataDir,
} from '@canopy/protocol/brand';
import {
  registerCanopyDataRootResolver,
  registerCanopySecureRootResolver,
} from '@canopy/execution-engine/node/lib/canopy-data-root-registration';

const buildIdentity = compiledBuildIdentity(BRAND.id);

type BuildStorageStartup = Pick<
  typeof buildStorageStartup,
  'assertHostBuildStorageStartup' | 'assertOwnedStorageDirectory'
>;

function isBuildStorageStartup(value: unknown): value is BuildStorageStartup {
  return (
    typeof value === 'object' &&
    value !== null &&
    'assertHostBuildStorageStartup' in value &&
    typeof value.assertHostBuildStorageStartup === 'function' &&
    'assertOwnedStorageDirectory' in value &&
    typeof value.assertOwnedStorageDirectory === 'function'
  );
}

function loadBuildStorageStartup(): BuildStorageStartup {
  // Importing paths during Playwright discovery must not preload the platform
  // graph through tsx-CJS while specs load that same graph as native ESM.
  // Electron's workspace CommonJS transform and SEA's esbuild bundle this call.
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- Admission must stay synchronous and lazy for source consumers.
  const startup: unknown = require('@canopy/core-platform/build-storage-startup');
  if (!isBuildStorageStartup(startup))
    throw new Error('Build storage startup adapter is unavailable.');
  return startup;
}

function canonicalStoragePath(value: string): string {
  return observeStoragePathSync(value).canonicalPath;
}

export function getCanopyBuildIdentity(): BrandBuildIdentity {
  return buildIdentity;
}

/** The build-owned root; explicit overrides are resolved separately. */
export function getCanopyBuildStoragePaths(): BuildStoragePaths {
  return resolveBuildStoragePaths({
    home: canonicalStoragePath(os.homedir()),
    brand: BRAND,
    identity: getCanopyBuildIdentity(),
  });
}

export function getCanopyRuntimeMode(): CanopyRuntimeMode {
  const build = getCanopyBuildIdentity().build;
  return build === 'stable' || build === 'internal' ? 'prod' : build;
}

export function getCanopySecureStorageMode(): CanopySecureStorageMode {
  const build = getCanopyBuildIdentity().build;
  return build === 'stable' ? 'prod' : build;
}

let resolvedDataDir: ResolvedCanopyDataDir | null = null;
let resolvedDataDirCacheKey: string | null = null;
let resolvedSecureDataDir: ResolvedCanopySecureDataDir | null = null;
let resolvedSecureDataDirCacheKey: string | null = null;

export function getBrandDataDirCandidates(): string[] {
  return [getCanopyBuildStoragePaths().dataRoot];
}

/** Discovery exclusions, never routing candidates: retained roots stay app-owned. */
export function getBrandOwnedDataDirRoots(): string[] {
  const home = canonicalStoragePath(os.homedir());
  const builds = ['stable', 'internal', 'rc', 'dev'] as const;
  return Array.from(
    new Set([
      ...builds.map(
        (build) =>
          resolveBuildStoragePaths({
            home,
            brand: BRAND,
            identity: { brandId: BRAND.id, build },
          }).dataRoot,
      ),
      ...Object.values(BRAND.storage.dataDirNames)
        .flat()
        .map((name) => path.join(home, name)),
      // Historical peers also gained an isolated internal root at this cutover.
      ...BRAND.storage.dataDirNames.prod.map((name) =>
        path.join(home, `${name}-internal`),
      ),
    ]),
  );
}

export function getPrimaryBrandDataDir(): string {
  return getCanopyBuildStoragePaths().dataRoot;
}

export function getBrandSecureDataDir(): string {
  return getCanopyBuildStoragePaths().secureDataRoot;
}

/**
 * Marker file written into a data directory root only by the explicit
 * Settings switch-to-primary flow. Its presence records a deliberate user
 * adoption of that directory, which no automatic startup path can produce.
 */
export const DATA_DIR_ADOPTION_MARKER_FILENAME = 'data-dir-adopted.json';

/**
 * The one workspace-index entry the app creates without user action: the
 * always-present default cowork workspace, auto-provisioned on the first
 * cowork listing of a boot. Must stay equal to `DEFAULT_COWORK_WORKSPACE_ID`
 * in `types.ts` (kept as a literal here so this low-level path module does
 * not import the full types barrel; a parity test enforces the alignment).
 */
export const DATA_DIR_AUTO_PROVISIONED_WORKSPACE_ID = 'cowork-default';
const DATA_DIR_AUTO_PROVISIONED_ORG_WORKSPACE_ID_PATTERN =
  /^cowork-org-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function isAutoProvisionedWorkspaceId(id: string): boolean {
  return (
    id === DATA_DIR_AUTO_PROVISIONED_WORKSPACE_ID ||
    DATA_DIR_AUTO_PROVISIONED_ORG_WORKSPACE_ID_PATTERN.test(id)
  );
}

/**
 * A candidate directory counts as a real install only on evidence no
 * automatic code path can fabricate (CAN-2271): the explicit adoption
 * marker written by the Settings switch-to-primary flow, app-managed chat
 * workspace content (created only when the user opens those surfaces), or a
 * workspace index holding at least one entry beyond the auto-provisioned
 * default cowork workspace. Boot side effects — `migrations.json`, caches, and the
 * auto-provisioned cowork index entry an *accidental* boot on a stray
 * skeleton leaves behind — must not count, or a hijacked skeleton primary
 * would stay legitimized after its first bad launch. A primary selected
 * through the historical bare-mkdir switch flow (no marker, zero
 * user-created workspaces) is on-disk indistinguishable from such a skeleton
 * and intentionally resolves to the data-bearing fallback; the Settings
 * fallback notice re-offers the switch, which now writes the marker.
 *
 * PostHog launch analytics request strict reads to distinguish missing data
 * from failed probes. Data-directory resolution keeps permissive reads.
 */
export function hasCanopyInstallData(
  candidate: string,
  options: { throwOnReadError?: boolean } = {},
): boolean {
  const throwOnReadError = options.throwOnReadError === true;
  const markerPath = path.join(candidate, DATA_DIR_ADOPTION_MARKER_FILENAME);
  if (throwOnReadError) {
    try {
      statSync(markerPath);
      return true;
    } catch (error) {
      handleInstallDataReadError(error, throwOnReadError);
    }
  } else if (existsSync(markerPath)) {
    return true;
  }

  // App-managed chat workspaces (App Advisor, plan-explore) are scaffolded
  // only when the user opens those surfaces — never by a plain boot — so
  // their content protects an install even when no user workspace (and thus
  // no workspace index) was ever created.
  if (appManagedWorkspacesHaveContent(candidate, throwOnReadError)) {
    return true;
  }

  try {
    const raw = readFileSync(
      path.join(candidate, 'workspaces', 'index.json'),
      'utf8',
    );
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) {
      return false;
    }
    const workspaces: unknown =
      'workspaces' in parsed ? parsed.workspaces : undefined;
    if (!Array.isArray(workspaces)) {
      return false;
    }
    return workspaces.some((entry: unknown) => {
      if (typeof entry !== 'object' || entry === null) {
        return false;
      }
      const id: unknown = 'id' in entry ? entry.id : undefined;
      if (typeof id !== 'string') {
        return false;
      }
      if (!isAutoProvisionedWorkspaceId(id)) {
        return true;
      }
      // The auto-provisioned default cowork workspace itself only counts
      // when it holds persisted content. Auto-provisioning scaffolds empty
      // directories; chat/work-entry files are written solely by real usage,
      // so a cowork-only install (all data under the default workspace) is
      // still protected from a stray skeleton candidate.
      return autoProvisionedWorkspaceHasContent(
        candidate,
        id,
        throwOnReadError,
      );
    });
  } catch (error) {
    handleInstallDataReadError(error, throwOnReadError);
    return false;
  }
}

function handleInstallDataReadError(
  error: unknown,
  throwOnReadError: boolean,
): void {
  if (!throwOnReadError) return;
  if (
    types.isNativeError(error) &&
    'code' in error &&
    error.code === 'ENOENT'
  ) {
    return;
  }
  throw types.isNativeError(error)
    ? error
    : new Error('Cannot read install data');
}

function appManagedWorkspacesHaveContent(
  candidate: string,
  throwOnReadError: boolean,
): boolean {
  try {
    return readdirSync(path.join(candidate, 'app-workspaces')).length > 0;
  } catch (error) {
    handleInstallDataReadError(error, throwOnReadError);
    return false;
  }
}

function autoProvisionedWorkspaceHasContent(
  candidate: string,
  workspaceId: string,
  throwOnReadError: boolean,
): boolean {
  const workspaceDir = path.join(candidate, 'workspaces', workspaceId);
  for (const contentDir of ['chats', 'chat-history']) {
    try {
      if (readdirSync(path.join(workspaceDir, contentDir)).length > 0) {
        return true;
      }
    } catch (error) {
      handleInstallDataReadError(error, throwOnReadError);
      // Missing directory — no content there.
    }
  }
  return false;
}

export function getResolvedCanopyDataDir(
  mode: CanopyRuntimeMode = getCanopyRuntimeMode(),
): ResolvedCanopyDataDir {
  const override = dataDirectoryOverride(process.env, 'CANOPY_DATA_DIR');
  const secureOverride = dataDirectoryOverride(
    process.env,
    'CANOPY_SECURE_DATA_DIR',
  );
  const cacheKey = `${mode}:${override ?? ''}:${secureOverride ?? ''}`;
  if (resolvedDataDir && resolvedDataDirCacheKey === cacheKey) {
    return resolvedDataDir;
  }

  // Admission precedes the first root resolution, not each in-session lookup.
  if (!override && !secureOverride)
    loadBuildStorageStartup().assertHostBuildStorageStartup({
      home: canonicalStoragePath(os.homedir()),
      identity: getCanopyBuildIdentity(),
    });

  if (override) {
    const allCandidates = getBrandDataDirCandidates();
    resolvedDataDirCacheKey = cacheKey;
    resolvedDataDir = {
      path: path.resolve(override),
      source: 'override',
      allCandidates,
    };
    return resolvedDataDir;
  }

  const allCandidates = getBrandDataDirCandidates();
  const primary = allCandidates[0];
  const { assertOwnedStorageDirectory } = loadBuildStorageStartup();
  const observation = assertOwnedStorageDirectory(primary);
  assertOwnedStorageDirectory(path.join(primary, 'secure-storage'));
  resolvedDataDirCacheKey = cacheKey;
  resolvedDataDir = {
    path: primary,
    source: observation.kind !== 'missing' ? 'primary' : 'fresh',
    allCandidates,
  };
  return resolvedDataDir;
}

export function resetResolvedCanopyDataDirCache(): void {
  resolvedDataDir = null;
  resolvedDataDirCacheKey = null;
  resolvedSecureDataDir = null;
  resolvedSecureDataDirCacheKey = null;
}

export const resetResolvedCanopyDataDirForTests =
  resetResolvedCanopyDataDirCache;

export function getCanopyDataDir(): string {
  return getResolvedCanopyDataDir().path;
}

registerCanopyDataRootResolver(getCanopyDataDir);
registerCanopySecureRootResolver(getCanopySecureDataDir);

function getLegacyEnvironmentConfigDataDir(): string {
  return getResolvedCanopyDataDir().path;
}

export function getResolvedCanopySecureDataDir(
  mode: CanopySecureStorageMode = getCanopySecureStorageMode(),
): ResolvedCanopySecureDataDir {
  const secureOverride = dataDirectoryOverride(
    process.env,
    'CANOPY_SECURE_DATA_DIR',
  );
  const dataOverride = dataDirectoryOverride(process.env, 'CANOPY_DATA_DIR');
  const cacheKey = `${mode}:${secureOverride ?? ''}:${dataOverride ?? ''}`;
  if (resolvedSecureDataDir && resolvedSecureDataDirCacheKey === cacheKey) {
    return resolvedSecureDataDir;
  }

  resolvedSecureDataDir = resolveSecureDataDir({
    dataRoot: getCanopyDataDir(),
    environment: process.env,
  });
  resolvedSecureDataDirCacheKey = cacheKey;
  return resolvedSecureDataDir;
}

/** Foreign sibling stores are retained solely for explicit recovery (V-4). */
export function getInternalLegacySharedSecureDataDir(): string | null {
  return null;
}

export function getCanopySecureDataDir(): string {
  return getResolvedCanopySecureDataDir().path;
}

export function getCanopyCacheDir(): string {
  return path.join(getCanopyDataDir(), '.cache');
}

/**
 * Shared desktop/CLI cache for the version-1 AI Gateway model catalog.
 *
 * This must follow the resolved data directory, never the unresolved brand
 * primary: writing into the primary while the install lives in a fallback
 * directory creates a skeleton primary that used to hijack resolution on the
 * next launch (CAN-2271). Desktop and CLI resolve the same directory for
 * their current runtime, so the cache stays shared.
 */
export function getAiGatewayModelCatalogCacheFilePath(): string {
  return path.join(getCanopyCacheDir(), 'model-catalog', 'ai-gateway-v1.json');
}

/** Shared, brand-scoped desktop/SEA CLI model-to-harness override file. */
export function getModelHarnessOverridesFilePath(): string {
  return path.join(getCanopyDataDir(), 'model-harness-overrides.json');
}

/**
 * Legacy on-disk file storing user-configured environment variables that
 * `getEnhancedEnv()` injects into spawned subprocesses. Lives next to
 * `preferences.json` under the Canopy data dir so it is reachable from both
 * the main process and builtin-action subprocesses without traversing the
 * Electron app layout.
 *
 * Retained so the Environments-page migration codepath can read and remove
 * the old file after persisting its contents into the new
 * {@link getEnvironmentConfigFilePath} layout.
 */
export function getUserEnvironmentFilePath(): string {
  return path.join(getCanopyDataDir(), 'user-environment.json');
}

/**
 * Previous location for the version-2 Environments config before encrypted
 * values moved into the brand secure data dir. This follows the resolved data
 * directory so fallback-directory users keep their non-secret environment tree
 * and assignment metadata during migration. Other legacy secret files stay on
 * the primary brand data directory path so they never migrate from another
 * brand's fallback data directory.
 */
export function getLegacyEnvironmentConfigFilePath(): string {
  return path.join(getLegacyEnvironmentConfigDataDir(), 'environments.json');
}

/**
 * On-disk file storing the Environments page configuration: the environment
 * tree, the global per-runtime assignment triple, per-workspace overrides,
 * and encrypted variable values. Replaces the legacy
 * {@link getUserEnvironmentFilePath} and lives in the brand secure data dir
 * because it may contain `safeStorage` ciphertext.
 */
export function getEnvironmentConfigFilePath(): string {
  return path.join(getCanopySecureDataDir(), 'environments.json');
}

export function getInternalLegacySharedEnvironmentConfigFilePath():
  | string
  | null {
  const legacyDir = getInternalLegacySharedSecureDataDir();
  return legacyDir ? path.join(legacyDir, 'environments.json') : null;
}
