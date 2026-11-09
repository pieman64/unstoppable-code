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

import { observeStoragePathSync } from './storage-path-observation';

import { dataDirectoryOverride } from './build-identity';

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

/** Trusted build identity is independent of launch-time environment hints. */
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
  const canonicalHome = observeStoragePathSync(home).canonicalPath;
  const dataRoot = join(canonicalHome, names[identity.build]);
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

/** Canonical secure storage follows the selected data root, never a sibling. */
export function resolveSecureDataDir(options: {
  readonly dataRoot: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
}): ResolvedCanopySecureDataDir {
  const secureOverride = dataDirectoryOverride(
    options.environment,
    'CANOPY_SECURE_DATA_DIR',
  );
  const dataOverride = dataDirectoryOverride(
    options.environment,
    'CANOPY_DATA_DIR',
  );
  if (secureOverride)
    return { path: resolve(secureOverride), source: 'override' };
  const primary = join(
    resolve(dataOverride ?? options.dataRoot),
    'secure-storage',
  );
  return {
    path: primary,
    source: dataOverride
      ? 'override'
      : existsSync(primary)
        ? 'primary'
        : 'fresh',
  };
}

/** Build-owned ciphertext sources only; foreign siblings remain explicit recovery material. */
export function resolveLegacyPatPaths(options: {
  readonly dataRoot: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
}): readonly string[] {
  const current = resolveSecureDataDir(options).path;
  const dataRoot = resolve(
    dataDirectoryOverride(options.environment, 'CANOPY_DATA_DIR') ??
      options.dataRoot,
  );
  return [current, join(dataRoot, 'secure')].map((directory) =>
    join(directory, 'github-pat.enc'),
  );
}
