// The pinned CLIProxyAPI release this device runs in "This device" mode
// (CAN-4023). The pin lives in the root package.json `cliproxyapi` entry and
// is injected at build time; see docs/planning/2026-10-14-account-proxy-local.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type {
  ManagedRuntimeArchiveFormat,
  ManagedRuntimeArtifact,
} from '../lib/managed-runtime-installer';

export interface AccountProxyRuntimeArtifact extends ManagedRuntimeArtifact {
  readonly archive: ManagedRuntimeArchiveFormat;
}

interface AccountProxyRuntimeConfig {
  version: string;
  artifacts: Record<string, Omit<AccountProxyRuntimeArtifact, 'version'>>;
}

declare const __CANOPY_CLIPROXYAPI__: AccountProxyRuntimeConfig | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRuntimeConfig(value: unknown): value is AccountProxyRuntimeConfig {
  if (
    !isRecord(value) ||
    typeof value.version !== 'string' ||
    !/^\d+\.\d+\.\d+$/.test(value.version) ||
    !isRecord(value.artifacts)
  )
    return false;
  return Object.values(value.artifacts).every(
    (artifact) =>
      isRecord(artifact) &&
      typeof artifact.url === 'string' &&
      (artifact.archive === 'tgz' || artifact.archive === 'zip') &&
      typeof artifact.integrity === 'string' &&
      typeof artifact.archiveBytes === 'number' &&
      typeof artifact.executableSha256 === 'string',
  );
}

function config(): AccountProxyRuntimeConfig {
  if (
    typeof __CANOPY_CLIPROXYAPI__ !== 'undefined' &&
    isRuntimeConfig(__CANOPY_CLIPROXYAPI__)
  )
    return __CANOPY_CLIPROXYAPI__;
  // Direct tsx development fallback; packaged builds inject only this entry.
  const manifest: unknown = JSON.parse(
    readFileSync(resolve(__dirname, '../../../../../package.json'), 'utf8'),
  );
  const entry = isRecord(manifest) ? manifest.cliproxyapi : undefined;
  if (!isRuntimeConfig(entry))
    throw new Error('Account proxy runtime metadata is missing.');
  return entry;
}

let metadata: AccountProxyRuntimeConfig | null = null;

/** The release for this platform, or undefined where none is published. */
export function getAccountProxyRuntimeArtifact(
  platform: string,
  arch: string,
): AccountProxyRuntimeArtifact | undefined {
  metadata ??= config();
  const artifact = metadata.artifacts[`${platform}-${arch}`];
  return artifact ? { version: metadata.version, ...artifact } : undefined;
}

/** The executable name inside the release archive and on disk. */
export function accountProxyExecutableName(
  platform: string,
): 'cli-proxy-api' | 'cli-proxy-api.exe' {
  return platform === 'win32' ? 'cli-proxy-api.exe' : 'cli-proxy-api';
}
