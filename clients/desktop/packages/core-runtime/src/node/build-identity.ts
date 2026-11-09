// Keep protocol imports type-only: Playwright discovery uses a CommonJS loader.
import type { BrandBuildIdentity } from '@canopy/protocol/brand';

declare const __CANOPY_COMPILED_RUNTIME__: boolean | undefined;
declare const __CANOPY_BUILD_IDENTITY__: BrandBuildIdentity | undefined;
declare const __CANOPY_TEST_DATA_OVERRIDES__: boolean | undefined;

/** Bundlers mark compiled execution separately so an omitted identity fails closed. */
function bundledBuildIdentity(): BrandBuildIdentity | undefined {
  if (typeof __CANOPY_BUILD_IDENTITY__ === 'undefined') {
    if (
      typeof __CANOPY_COMPILED_RUNTIME__ !== 'undefined' &&
      __CANOPY_COMPILED_RUNTIME__
    ) {
      throw new Error(
        'Compiled build identity unavailable. Rebuild this runtime.',
      );
    }
    return undefined;
  }
  const { brandId, build } = __CANOPY_BUILD_IDENTITY__;
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(brandId)) {
    throw new Error('Invalid compiled brand identity.');
  }
  if (!['stable', 'internal', 'rc', 'dev'].includes(build)) {
    throw new Error('Invalid compiled product build.');
  }
  return Object.freeze({ brandId, build });
}

export function compiledBuildIdentity(
  sourceBrandId: string,
): BrandBuildIdentity {
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(sourceBrandId)) {
    throw new Error('Invalid compiled brand identity.');
  }
  const identity =
    bundledBuildIdentity() ??
    Object.freeze({ brandId: sourceBrandId, build: 'dev' });
  if (identity.brandId !== sourceBrandId) {
    throw new Error('Compiled brand identity mismatch.');
  }
  return identity;
}

/** Source, dev and compiled test hosts may propagate launcher roots without an explicit override. */
export function isDevelopmentOrTestBuild(): boolean {
  const identity = bundledBuildIdentity();
  return (
    identity === undefined ||
    identity.build === 'dev' ||
    (typeof __CANOPY_TEST_DATA_OVERRIDES__ !== 'undefined' &&
      __CANOPY_TEST_DATA_OVERRIDES__)
  );
}

export function dataDirectoryOverride(
  environment: Readonly<Record<string, string | undefined>>,
  name: 'CANOPY_DATA_DIR' | 'CANOPY_SECURE_DATA_DIR',
): string | undefined {
  // Overrides bypass default routing, not compiled-identity validation.
  bundledBuildIdentity();
  const value = environment[name]?.trim();
  if (!value) return undefined;
  return value;
}

export function hasDataDirectoryOverride(
  environment: Readonly<Record<string, string | undefined>>,
): boolean {
  return Boolean(
    dataDirectoryOverride(environment, 'CANOPY_DATA_DIR') ||
    dataDirectoryOverride(environment, 'CANOPY_SECURE_DATA_DIR'),
  );
}
