import type {
  PlatformSecretProtectionUnavailableReason,
  BrandReleaseFlavor,
} from '@canopy/core-runtime';
import { isCanonicalWindowsSid } from '../local-authority';

/** Trusted compiled identity only (V-3/V-6); never protocol or environment inputs. */
export interface SecretProtectionOptions {
  readonly os: string;
  readonly nativePath: string;
  readonly brandId: string;
  /** Optional host application identity validation for the Windows candidate. */
  readonly applicationId?: string;
  /** Required on Windows; independently observed by the host and checked against TokenUser. */
  readonly windowsPrincipalSid?: string;
  readonly build: BrandReleaseFlavor | 'dev';
  /** Derived from canonical data root, brand and principal by local-authority. */
  readonly authorityId: string | undefined;
}

export interface KeychainNamespace {
  readonly service: string;
  readonly authorityId: string;
}

interface SecretProtectionPolicy<Namespace> {
  readonly enabled: boolean;
  readonly unavailable: PlatformSecretProtectionUnavailableReason;
  readonly namespace: Namespace;
}

export function resolveSecretProtectionPolicy(
  options: SecretProtectionOptions,
): SecretProtectionPolicy<KeychainNamespace> {
  const { os, brandId, build, authorityId } = options;
  if (
    (brandId !== 'canopy' && brandId !== 'unstoppable-code') ||
    (build !== 'stable' &&
      build !== 'internal' &&
      build !== 'rc' &&
      build !== 'dev')
  )
    throw new TypeError('Invalid key-slot identity.');
  if (
    authorityId !== undefined &&
    (typeof authorityId !== 'string' ||
      authorityId.length !== 64 ||
      !/^[a-f0-9]{64}$/.test(authorityId))
  )
    throw new TypeError('Invalid key-slot authority.');
  const unavailable =
    authorityId === undefined
      ? 'authority_unavailable'
      : os !== 'darwin' && os !== 'linux'
        ? 'no_backend'
        : 'backend_failed';
  return {
    enabled: (os === 'darwin' || os === 'linux') && authorityId !== undefined,
    unavailable,
    namespace: {
      service: `${brandId}.${build}.vault`,
      authorityId: authorityId ?? '',
    },
  };
}

export function keychainAccount(
  namespace: KeychainNamespace,
  name: string,
): string {
  return `${namespace.service}/${namespace.authorityId}/${name}`;
}

export interface CredentialNamespace {
  readonly prefix: string;
  readonly principalSid: string;
}

export function resolveWindowsSecretProtectionPolicy(
  options: SecretProtectionOptions,
): SecretProtectionPolicy<CredentialNamespace> {
  const applicationId =
    options.applicationId === undefined
      ? options.brandId
      : options.applicationId;
  if (
    typeof applicationId !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9.-]{0,253}$/.test(applicationId)
  )
    throw new TypeError('Invalid key-slot identity.');
  if (
    options.authorityId !== undefined &&
    (typeof options.authorityId !== 'string' ||
      !/^[a-f0-9]{64}$/.test(options.authorityId))
  )
    throw new TypeError('Invalid key-slot authority.');
  if (
    options.windowsPrincipalSid !== undefined &&
    (typeof options.windowsPrincipalSid !== 'string' ||
      !isCanonicalWindowsSid(options.windowsPrincipalSid))
  )
    throw new TypeError('Invalid key-slot principal.');
  const brand = options.brandId;
  const build = options.build;
  if (brand !== undefined && brand !== 'canopy' && brand !== 'unstoppable-code')
    throw new TypeError('Invalid key-slot brand.');
  if (
    build !== undefined &&
    !['stable', 'internal', 'rc', 'dev'].includes(build)
  )
    throw new TypeError('Invalid key-slot build.');
  const unavailable = !options.authorityId
    ? 'authority_unavailable'
    : options.os !== 'win32'
      ? 'no_backend'
      : !options.authorityId || !options.windowsPrincipalSid || !brand || !build
        ? 'authority_unavailable'
        : 'backend_failed';
  return {
    enabled: unavailable === 'backend_failed',
    unavailable,
    namespace: {
      prefix: `canopy.vault.v1/${brand ?? ''}/${build ?? ''}/${options.authorityId ?? ''}/`,
      principalSid: options.windowsPrincipalSid ?? '',
    },
  };
}
