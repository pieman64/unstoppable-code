/** Build-owned trust anchor. Adjacent payload receipts never supply expectations. */
export const NATIVE_CATALOG_PREFIX = 'CANOPY_NATIVE_CATALOG_V1:';
export const NATIVE_CATALOG_SUFFIX = ':END_NATIVE_CATALOG';
export const NATIVE_VAULT_FILE = 'core-secret-protection.node';
export const NATIVE_VAULT_MEMBER = 'vault-key-slots';
export const NATIVE_DEPENDENCY_POLICIES = Object.freeze({
  darwin: 'darwin-system-frameworks-v1',
  win32: 'win32-system-static-crt-v1',
  linux: 'linux-libsecret-gio-v1',
});

export interface NativeArtifactCatalog {
  readonly schema: 1;
  readonly generation: string;
  readonly brandId: 'canopy' | 'unstoppable-code';
  readonly build: 'stable' | 'internal' | 'rc' | 'dev';
  readonly version: string;
  readonly buildId: string;
  readonly member: {
    readonly id: 'vault-key-slots';
    readonly filename: 'core-secret-protection.node';
    readonly platform: 'darwin' | 'win32' | 'linux';
    readonly architectures: readonly string[];
    readonly compatibility: 'node-api-8-product-v1';
    readonly dependencyPolicy: string;
  } & (
    | {
        readonly state: 'absent';
        readonly reason: 'development-toolchain-unavailable';
      }
    | {
        readonly state: 'present';
        readonly byteLength: number;
        readonly sha256: string;
      }
  );
}

export function isNativeArtifactCatalog(
  value: unknown,
): value is NativeArtifactCatalog {
  if (typeof value !== 'object' || value === null) return false;
  const fields = Object.getOwnPropertyDescriptors(value);
  const get = (key: string): unknown => fields[key]?.value;
  const member: unknown = get('member');
  if (typeof member !== 'object' || member === null) return false;
  const properties = Object.getOwnPropertyDescriptors(member);
  const field = (key: string): unknown => properties[key]?.value;
  const platform = field('platform');
  const architectures = field('architectures');
  const generation = get('generation');
  const version = get('version');
  const buildId = get('buildId');
  const digest = field('sha256');
  const size = field('byteLength');
  return (
    get('schema') === 1 &&
    typeof generation === 'string' &&
    /^[a-zA-Z0-9-]{1,128}$/.test(generation) &&
    (get('brandId') === 'canopy' || get('brandId') === 'unstoppable-code') &&
    ['stable', 'internal', 'rc', 'dev'].includes(String(get('build'))) &&
    typeof version === 'string' &&
    version.length > 0 &&
    version.length <= 128 &&
    typeof buildId === 'string' &&
    buildId.length <= 128 &&
    field('id') === NATIVE_VAULT_MEMBER &&
    field('filename') === NATIVE_VAULT_FILE &&
    (platform === 'darwin' || platform === 'win32' || platform === 'linux') &&
    field('dependencyPolicy') === NATIVE_DEPENDENCY_POLICIES[platform] &&
    field('compatibility') === 'node-api-8-product-v1' &&
    Array.isArray(architectures) &&
    JSON.stringify(architectures) ===
      JSON.stringify(
        platform === 'darwin'
          ? ['arm64', 'x64']
          : platform === 'win32'
            ? ['x64']
            : architectures,
      ) &&
    architectures.length > 0 &&
    (platform === 'darwin'
      ? architectures.length === 2
      : architectures.length === 1) &&
    architectures.every(
      (arch: unknown) => arch === 'x64' || arch === 'arm64',
    ) &&
    (field('state') === 'absent'
      ? field('reason') === 'development-toolchain-unavailable'
      : field('state') === 'present' &&
        typeof size === 'number' &&
        Number.isSafeInteger(size) &&
        size > 0 &&
        size <= 32 * 1024 * 1024 &&
        typeof digest === 'string' &&
        /^[a-f0-9]{64}$/.test(digest))
  );
}

declare const __CANOPY_NATIVE_ARTIFACT_CATALOG__: string | undefined;

export function compiledNativeArtifactCatalog():
  | NativeArtifactCatalog
  | undefined {
  if (typeof __CANOPY_NATIVE_ARTIFACT_CATALOG__ !== 'string') return undefined;
  const encoded = __CANOPY_NATIVE_ARTIFACT_CATALOG__;
  if (
    !encoded.startsWith(NATIVE_CATALOG_PREFIX) ||
    !encoded.endsWith(NATIVE_CATALOG_SUFFIX)
  )
    return undefined;
  try {
    const value: unknown = JSON.parse(
      Buffer.from(
        encoded.slice(
          NATIVE_CATALOG_PREFIX.length,
          -NATIVE_CATALOG_SUFFIX.length,
        ),
        'base64',
      ).toString('utf8'),
    );
    return isNativeArtifactCatalog(value) ? value : undefined;
  } catch {
    return undefined;
  }
}
