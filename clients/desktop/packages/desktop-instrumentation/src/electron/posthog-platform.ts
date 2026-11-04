/** Facts only Electron can report. The host supplies them because this package
 * has no Electron dependency. */
export interface PostHogHostPlatform {
  osVersion: string;
  cpuArchitecture: string;
}

export interface PostHogPlatformProperties {
  $os?: string;
  $os_version?: string;
  cpu_architecture?: string;
}

/** The names posthog-js reports, so `$os` splits window and background events
 * the same way. */
const POSTHOG_OS_NAMES: Partial<Record<NodeJS.Platform, string>> = {
  darwin: 'Mac OS X',
  linux: 'Linux',
  win32: 'Windows',
};

/** A fourth numeric part would match the sanitizer's IPv4 pattern and redact
 * the version; kernel build suffixes only add cardinality. */
function readOsVersion(value: string): string | undefined {
  return /^\d+(?:\.\d+){0,2}/.exec(value)?.[0];
}

export function readPostHogPlatformProperties(
  getHostPlatform?: () => PostHogHostPlatform,
): PostHogPlatformProperties {
  const osName = POSTHOG_OS_NAMES[process.platform];
  const properties: PostHogPlatformProperties =
    osName === undefined ? {} : { $os: osName };
  if (!getHostPlatform) return properties;
  try {
    const { osVersion, cpuArchitecture } = getHostPlatform();
    const version = readOsVersion(osVersion);
    return {
      ...properties,
      ...(version === undefined ? {} : { $os_version: version }),
      cpu_architecture: cpuArchitecture,
    };
  } catch {
    return properties;
  }
}
