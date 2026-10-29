import type {
  PlatformEndpointSemantics,
  PlatformEndpointServices,
  PlatformOperatingSystem,
  PlatformServices,
  PlatformSupportTier,
} from '@canopy/core-runtime';
import { createPlatformPathServices } from './paths';
import { createSecureFileServices } from './secure-files';
import { windowsProcessObserver } from './supervision/windows-process';
import { createSupervisionServices } from './supervision';

interface HostPolicy {
  readonly tier: PlatformSupportTier;
  readonly endpointSemantics: PlatformEndpointSemantics;
}

// Families are supplied by composition for every supported host.
const HOST_POLICIES: Readonly<Record<PlatformOperatingSystem, HostPolicy>> = {
  darwin: { tier: 'primary', endpointSemantics: 'filesystem-socket' },
  win32: { tier: 'primary', endpointSemantics: 'first-instance-pipe' },
  linux: { tier: 'primary', endpointSemantics: 'filesystem-socket' },
};

export type PlatformServicesErrorCode =
  | 'unsupported_platform'
  | 'endpoint_semantics_mismatch';

export class PlatformServicesError extends Error {
  override readonly name = 'PlatformServicesError';
  readonly code: PlatformServicesErrorCode;

  constructor(code: PlatformServicesErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

function isPlatformOperatingSystem(
  platform: string,
): platform is PlatformOperatingSystem {
  return platform === 'darwin' || platform === 'win32' || platform === 'linux';
}

/** Composes services for `platform`; fails closed on an unknown platform or mismatched endpoint semantics. */
export function createPlatformServices(
  platform: string,
  endpoints: PlatformEndpointServices,
  host: { readonly windowsProcessPath?: string } = {},
): PlatformServices {
  if (!isPlatformOperatingSystem(platform)) {
    throw new PlatformServicesError(
      'unsupported_platform',
      `No platform services for host platform "${platform}".`,
    );
  }
  const policy = HOST_POLICIES[platform];
  if (endpoints.semantics !== policy.endpointSemantics) {
    throw new PlatformServicesError(
      'endpoint_semantics_mismatch',
      `${platform} requires ${policy.endpointSemantics} endpoints.`,
    );
  }
  return Object.freeze({
    os: platform,
    tier: policy.tier,
    endpoints,
    secureFiles: createSecureFileServices(platform),
    paths: createPlatformPathServices(platform),
    supervision: createSupervisionServices(
      platform,
      platform === 'win32' && host.windowsProcessPath
        ? { windowsProcess: windowsProcessObserver(host.windowsProcessPath) }
        : {},
    ),
  });
}

/**
 * The single host-platform read (platform boundary check). Callers outside
 * this package branch on the result instead of reading `process.platform`;
 * an unsupported host fails closed.
 */
export function hostPlatformOperatingSystem(): PlatformOperatingSystem {
  const platform: string = process.platform;
  if (!isPlatformOperatingSystem(platform)) {
    throw new PlatformServicesError(
      'unsupported_platform',
      `No platform services for host platform "${platform}".`,
    );
  }
  return platform;
}

/** Composes services for the host platform. */
export function hostPlatformServices(
  endpoints: PlatformEndpointServices,
  host: { readonly windowsProcessPath?: string } = {},
): PlatformServices {
  return createPlatformServices(hostPlatformOperatingSystem(), endpoints, host);
}
