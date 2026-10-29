import { BRAND } from '@canopy/brand/current';

let cachedCanopyCloudBaseUrl: string | null = null;
const CLOUD_DISPLAY_NAME = `${BRAND.displayName} Cloud`;

export type CanopyCloudConfigErrorCode =
  | 'base-url-not-configured'
  | 'api-key-required';

export class CanopyCloudConfigError extends Error {
  constructor(
    readonly code: CanopyCloudConfigErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CanopyCloudConfigError';
  }
}

function getBuildTimeBaseUrl(): string {
  return typeof __CANOPY_CLOUD_BASE_URL__ === 'string'
    ? __CANOPY_CLOUD_BASE_URL__
    : '';
}

/**
 * E2E-only runtime override for the cloud base URL. The Playwright portal
 * suite boots a real web server on a per-run port, so the E2E build must be
 * able to re-point Canopy Cloud at launch time. Gated on the build-time
 * `__CANOPY_E2E__` constant so production builds dead-code-eliminate the
 * branch and never honor the env var (enforced by check:no-e2e-seams).
 */
function getE2eRuntimeBaseUrlOverride(): string {
  if (__CANOPY_E2E__) {
    return process.env.CANOPY_E2E_CLOUD_BASE_URL ?? '';
  }
  return '';
}

function isLocalhostHostname(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === '[::1]'
  );
}

export function normalizeCanopyCloudBaseUrl(input: string): string {
  const trimmed = String(input).trim();
  return trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed;
}

export function assertCanopyCloudBaseUrlProtocol(baseUrl: string): void {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(baseUrl);
  } catch {
    throw new Error(`${CLOUD_DISPLAY_NAME} base URL must be a valid URL.`);
  }

  if (parsedUrl.protocol === 'https:') {
    return;
  }

  if (
    parsedUrl.protocol === 'http:' &&
    isLocalhostHostname(parsedUrl.hostname)
  ) {
    return;
  }

  throw new Error(
    `${CLOUD_DISPLAY_NAME} base URL must use https:// unless it points to localhost.`,
  );
}

export function resetCanopyCloudBaseUrlCacheForTest(): void {
  cachedCanopyCloudBaseUrl = null;
}

export function getCanopyCloudBaseUrl(): string {
  if (cachedCanopyCloudBaseUrl !== null) {
    return cachedCanopyCloudBaseUrl;
  }

  const normalized = normalizeCanopyCloudBaseUrl(
    getE2eRuntimeBaseUrlOverride() || getBuildTimeBaseUrl(),
  );
  if (!normalized) {
    throw new CanopyCloudConfigError(
      'base-url-not-configured',
      `${CLOUD_DISPLAY_NAME} base URL is not configured.`,
    );
  }

  assertCanopyCloudBaseUrlProtocol(normalized);
  cachedCanopyCloudBaseUrl = normalized;
  return cachedCanopyCloudBaseUrl;
}
