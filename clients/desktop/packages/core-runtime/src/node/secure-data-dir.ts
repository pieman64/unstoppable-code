import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type {
  BrandBuildIdentity,
  BrandCore,
  ProductBuild,
  CanopyRuntimeMode,
  CanopySecureStorageMode,
  ResolvedCanopySecureDataDir,
} from '@canopy/protocol/brand';

import { testDataDirectoryOverride } from './build-identity';

export type BrandSecureDirectoryNames = Readonly<
  Record<CanopySecureStorageMode, string>
>;

export function secureStorageMode(
  releaseFlavor: string | undefined,
  runtimeMode: CanopyRuntimeMode,
): CanopySecureStorageMode {
  return releaseFlavor === 'internal' || releaseFlavor === 'rc'
    ? releaseFlavor
    : runtimeMode;
}

export function brandSecureDataDir(
  home: string,
  names: BrandSecureDirectoryNames,
  mode: CanopySecureStorageMode,
): string {
  return join(home, names[mode]);
}

export interface BuildStoragePaths {
  readonly dataRoot: string;
  readonly secureDataRoot: string;
}

/** Final layout projection only. Startup keeps resolveSecureDataDir until CAN-5786. */
export function resolveBuildStoragePaths(options: {
  readonly home: string;
  readonly brand: Pick<BrandCore, 'id' | 'storage'>;
  readonly identity: BrandBuildIdentity;
}): BuildStoragePaths {
  const { home, brand, identity } = options;
  if (identity.brandId !== brand.id)
    throw new Error('Build storage brand mismatch.');
  const names: Readonly<Record<ProductBuild, string>> = brand.storage
    .buildDataDirNames ?? {
    stable: brand.storage.dataDirNames.prod[0],
    internal: `${brand.storage.dataDirNames.prod[0]}-internal`,
    rc: brand.storage.dataDirNames.rc[0],
    dev: brand.storage.dataDirNames.dev[0],
  };
  const dataRoot = join(home, names[identity.build]);
  return { dataRoot, secureDataRoot: join(dataRoot, 'secure-storage') };
}

/** Historical sibling location, for migration discovery without environment overrides. */
export function historicalSecureDataDir(
  home: string,
  names: BrandSecureDirectoryNames,
  build: ProductBuild,
): string {
  return brandSecureDataDir(home, names, build === 'stable' ? 'prod' : build);
}

/** Retained ordinary routing; nesting activates with the migration in CAN-5786. */
export function resolveSecureDataDir(options: {
  readonly home: string;
  readonly names: BrandSecureDirectoryNames;
  readonly mode: CanopySecureStorageMode;
  readonly environment: Readonly<Record<string, string | undefined>>;
}): ResolvedCanopySecureDataDir {
  const secureOverride = testDataDirectoryOverride(
    options.environment,
    'CANOPY_SECURE_DATA_DIR',
  );
  const dataOverride = testDataDirectoryOverride(
    options.environment,
    'CANOPY_DATA_DIR',
  );
  if (secureOverride)
    return { path: resolve(secureOverride), source: 'override' };
  if (dataOverride)
    return { path: `${resolve(dataOverride)}-secure`, source: 'override' };
  const primary = brandSecureDataDir(options.home, options.names, options.mode);
  return { path: primary, source: existsSync(primary) ? 'primary' : 'fresh' };
}

/** Legacy PAT lookup order shared by the daemon fence and host migration readers. */
export function resolveLegacyPatPaths(options: {
  readonly home: string;
  readonly names: BrandSecureDirectoryNames;
  readonly dataDirNames: Readonly<Record<CanopyRuntimeMode, readonly string[]>>;
  readonly mode: CanopySecureStorageMode;
  readonly runtimeMode: CanopyRuntimeMode;
  readonly environment: Readonly<Record<string, string | undefined>>;
}): readonly string[] {
  const current = resolveSecureDataDir(options).path;
  const override = testDataDirectoryOverride(
    options.environment,
    'CANOPY_DATA_DIR',
  );
  const primary = options.dataDirNames[options.runtimeMode][0];
  if (!primary) throw new Error('Legacy data directory unavailable.');
  const legacy = join(
    override ? resolve(override) : join(options.home, primary),
    'secure',
  );
  const shared =
    options.mode === 'internal' &&
    !testDataDirectoryOverride(options.environment, 'CANOPY_SECURE_DATA_DIR') &&
    !override
      ? brandSecureDataDir(options.home, options.names, 'prod')
      : null;
  return [current, ...(shared ? [shared] : []), legacy].map((directory) =>
    join(directory, 'github-pat.enc'),
  );
}
