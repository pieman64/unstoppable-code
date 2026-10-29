import * as os from 'node:os';
import * as path from 'node:path';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { BRAND } from '@canopy/brand/current';
import type {
  CanopyRuntimeMode,
  CanopySecureStorageMode,
  ResolvedCanopyDataDir,
  ResolvedCanopySecureDataDir,
} from '@canopy/protocol/brand';

declare const __CANOPY_RELEASE_FLAVOR__: string | undefined;

function isElectronRuntime(): boolean {
  return (
    process.defaultApp === true || typeof process.versions.electron === 'string'
  );
}

function getElectronRuntimeMode(): CanopyRuntimeMode | null {
  if (!isElectronRuntime()) {
    return null;
  }

  const execPath = process.execPath.toLowerCase();
  const isDefaultElectronBinary =
    execPath.endsWith(`${path.sep}electron`) ||
    execPath.endsWith(`${path.sep}electron.exe`);

  if (process.defaultApp === true || isDefaultElectronBinary) {
    return 'dev';
  }

  return 'prod';
}

function isTsxRuntime(): boolean {
  return process.execArgv.some((arg) => /(?:^|[\\/])tsx(?:[\\/]|$)/.test(arg));
}

export function getCanopyRuntimeMode(): CanopyRuntimeMode {
  if (
    typeof __CANOPY_RELEASE_FLAVOR__ !== 'undefined' &&
    __CANOPY_RELEASE_FLAVOR__ === 'rc'
  ) {
    return 'rc';
  }

  const electronMode = getElectronRuntimeMode();
  if (electronMode) {
    return electronMode;
  }

  if (process.env.CANOPY_ENV === 'development') {
    return 'dev';
  }
  if (process.env.CANOPY_ENV === 'production') {
    return 'prod';
  }
  if (process.env.NODE_ENV === 'development') {
    return 'dev';
  }
  if (process.env.NODE_ENV === 'production') {
    return 'prod';
  }
  if (isTsxRuntime()) {
    return 'dev';
  }

  return 'prod';
}

export function getCanopySecureStorageMode(): CanopySecureStorageMode {
  if (typeof __CANOPY_RELEASE_FLAVOR__ !== 'undefined') {
    if (__CANOPY_RELEASE_FLAVOR__ === 'internal') {
      return 'internal';
    }
    if (__CANOPY_RELEASE_FLAVOR__ === 'rc') {
      return 'rc';
    }
  }
  return getCanopyRuntimeMode();
}

let resolvedDataDir: ResolvedCanopyDataDir | null = null;
let resolvedDataDirCacheKey: string | null = null;
let resolvedSecureDataDir: ResolvedCanopySecureDataDir | null = null;
let resolvedSecureDataDirCacheKey: string | null = null;

const brandDataDirNames: Record<CanopyRuntimeMode, string[]> =
  BRAND.storage.dataDirNames;
const brandSecureDataDirNames: Record<CanopySecureStorageMode, string> =
  BRAND.storage.secureDataDirNames;

export function getBrandDataDirCandidates(
  mode: CanopyRuntimeMode = getCanopyRuntimeMode(),
): string[] {
  const modes: CanopyRuntimeMode[] = mode === 'rc' ? ['rc', 'prod'] : [mode];
  const candidates = modes.flatMap((candidateMode) =>
    brandDataDirNames[candidateMode].map((name) =>
      path.join(os.homedir(), name),
    ),
  );
  return Array.from(new Set(candidates));
}

export function getPrimaryBrandDataDir(
  mode: CanopyRuntimeMode = getCanopyRuntimeMode(),
): string {
  return getBrandDataDirCandidates(mode)[0];
}

export function getBrandSecureDataDir(
  mode: CanopySecureStorageMode = getCanopySecureStorageMode(),
): string {
  return path.join(os.homedir(), brandSecureDataDirNames[mode]);
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
 */
function candidateHasInstallData(candidate: string): boolean {
  if (existsSync(path.join(candidate, DATA_DIR_ADOPTION_MARKER_FILENAME))) {
    return true;
  }

  // App-managed chat workspaces (App Advisor, plan-explore) are scaffolded
  // only when the user opens those surfaces — never by a plain boot — so
  // their content protects an install even when no user workspace (and thus
  // no workspace index) was ever created.
  if (appManagedWorkspacesHaveContent(candidate)) {
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
      return autoProvisionedWorkspaceHasContent(candidate, id);
    });
  } catch {
    return false;
  }
}

function appManagedWorkspacesHaveContent(candidate: string): boolean {
  try {
    return readdirSync(path.join(candidate, 'app-workspaces')).length > 0;
  } catch {
    return false;
  }
}

function autoProvisionedWorkspaceHasContent(
  candidate: string,
  workspaceId: string,
): boolean {
  const workspaceDir = path.join(candidate, 'workspaces', workspaceId);
  for (const contentDir of ['chats', 'chat-history']) {
    try {
      if (readdirSync(path.join(workspaceDir, contentDir)).length > 0) {
        return true;
      }
    } catch {
      // Missing directory — no content there.
    }
  }
  return false;
}

export function getResolvedCanopyDataDir(
  mode: CanopyRuntimeMode = getCanopyRuntimeMode(),
): ResolvedCanopyDataDir {
  const override = process.env.CANOPY_DATA_DIR?.trim();
  const cacheKey = `${mode}:${override ?? ''}`;
  if (resolvedDataDir && resolvedDataDirCacheKey === cacheKey) {
    return resolvedDataDir;
  }

  if (override) {
    const allCandidates = getBrandDataDirCandidates(mode);
    resolvedDataDirCacheKey = cacheKey;
    resolvedDataDir = {
      path: path.resolve(override),
      source: 'override',
      allCandidates,
    };
    return resolvedDataDir;
  }

  const allCandidates = getBrandDataDirCandidates(mode);
  // Prefer a candidate holding real install data over one that merely exists:
  // stray writes (e.g. a cache file, CAN-2271) can create a skeleton primary
  // directory that must not hijack an install living in a fallback directory.
  const existing =
    allCandidates.find(candidateHasInstallData) ??
    allCandidates.find((candidate) => existsSync(candidate));
  const primary = allCandidates[0];
  resolvedDataDirCacheKey = cacheKey;
  resolvedDataDir = existing
    ? {
        path: existing,
        source: existing === primary ? 'primary' : 'fallback',
        allCandidates,
      }
    : {
        path: primary,
        source: 'fresh',
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

function getLegacyEnvironmentConfigDataDir(): string {
  return getResolvedCanopyDataDir().path;
}

export function getResolvedCanopySecureDataDir(
  mode: CanopySecureStorageMode = getCanopySecureStorageMode(),
): ResolvedCanopySecureDataDir {
  const secureOverride = process.env.CANOPY_SECURE_DATA_DIR?.trim();
  const dataOverride = process.env.CANOPY_DATA_DIR?.trim();
  const cacheKey = `${mode}:${secureOverride ?? ''}:${dataOverride ?? ''}`;
  if (resolvedSecureDataDir && resolvedSecureDataDirCacheKey === cacheKey) {
    return resolvedSecureDataDir;
  }

  if (secureOverride) {
    resolvedSecureDataDirCacheKey = cacheKey;
    resolvedSecureDataDir = {
      path: path.resolve(secureOverride),
      source: 'override',
    };
    return resolvedSecureDataDir;
  }

  if (dataOverride) {
    resolvedSecureDataDirCacheKey = cacheKey;
    resolvedSecureDataDir = {
      path: `${path.resolve(dataOverride)}-secure`,
      source: 'override',
    };
    return resolvedSecureDataDir;
  }

  const primary = getBrandSecureDataDir(mode);
  resolvedSecureDataDirCacheKey = cacheKey;
  resolvedSecureDataDir = {
    path: primary,
    source: existsSync(primary) ? 'primary' : 'fresh',
  };
  return resolvedSecureDataDir;
}

/**
 * Former production secure root consulted once by an internal build when its
 * isolated destination is absent. Explicit overrides intentionally disable
 * this implicit home-directory migration.
 */
export function getInternalLegacySharedSecureDataDir(): string | null {
  if (
    getCanopySecureStorageMode() !== 'internal' ||
    process.env.CANOPY_SECURE_DATA_DIR?.trim() ||
    process.env.CANOPY_DATA_DIR?.trim()
  ) {
    return null;
  }
  return getBrandSecureDataDir('prod');
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
