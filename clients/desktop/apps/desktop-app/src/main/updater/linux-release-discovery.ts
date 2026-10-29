import { BRAND } from '@canopy/brand/current';
import type { UpdateReleaseFlavor } from '@canopy/desktop-shared/types';
import type { LinuxPackageArchitecture } from './linux-manual-update';

export interface VerifiedLinuxRelease {
  version: string;
  architecture: LinuxPackageArchitecture;
  checksum: string;
  algorithm: 'SHA-512' | 'SHA-256';
  url: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** electron-builder names Debian packages with dpkg architecture words. */
function debianArchitecture(architecture: LinuxPackageArchitecture): string {
  return architecture === 'x64' ? 'amd64' : 'arm64';
}

/** Use the established baked CDN contract; never invent a missing release. */
export function verifiedLinuxMetadata(
  value: unknown,
  baseUrl: string,
  architecture: LinuxPackageArchitecture,
): VerifiedLinuxRelease | null {
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return null;
  }
  if (
    base.protocol !== 'https:' ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  )
    return null;
  if (
    !record(value) ||
    typeof value.version !== 'string' ||
    !STABLE_VERSION.test(value.version) ||
    !Array.isArray(value.files)
  )
    return null;
  const version = value.version;
  const name = `${BRAND.release.artifactPrefix}-${version}-linux-${debianArchitecture(architecture)}.deb`;
  const url = `${baseUrl.replace(/\/+$/, '')}/desktop/${BRAND.release.artifactPrefix}/${version}/${encodeURIComponent(name)}`;
  const files = value.files.filter(
    (file: unknown) =>
      record(file) &&
      (file.url === name || file.url === url) &&
      typeof file.sha512 === 'string' &&
      /^[A-Za-z0-9+/]{86}==$/.test(file.sha512),
  );
  if (files.length !== 1) return null;
  const file: unknown = files[0];
  if (
    !record(file) ||
    typeof file.sha512 !== 'string' ||
    Buffer.from(file.sha512, 'base64').toString('base64') !== file.sha512
  )
    return null;
  return {
    version,
    architecture,
    url,
    checksum: Buffer.from(file.sha512, 'base64').toString('hex'),
    algorithm: 'SHA-512',
  };
}

/** Internal/RC retain the existing fixed repository + authenticated API policy. */
export function verifiedLinuxRelease(
  value: unknown,
  flavor: UpdateReleaseFlavor,
  architecture: LinuxPackageArchitecture,
): VerifiedLinuxRelease | null {
  if (
    flavor === 'stable' ||
    !record(value) ||
    value.draft !== false ||
    value.prerelease !== true ||
    typeof value.tag_name !== 'string' ||
    !Array.isArray(value.assets)
  )
    return null;
  const tag = value.tag_name;
  if (
    !(flavor === 'rc'
      ? /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-rc\.[1-9]\d*$/.test(tag)
      : /^internal-[1-9]\d*$/.test(tag))
  )
    return null;
  const version = tag.replace(/^v/, '');
  const assetVersion =
    flavor === 'internal'
      ? `9999.0.0-internal.${tag.slice('internal-'.length)}`
      : version;
  const legacyName =
    flavor === 'internal'
      ? `${BRAND.release.artifactPrefix}-internal-linux-${debianArchitecture(architecture)}.deb`
      : `${BRAND.release.artifactPrefix}-${assetVersion}-linux-${debianArchitecture(architecture)}.deb`;
  const stampedPrefix = `desktop--${BRAND.id}--${assetVersion}--${flavor}--linux-${architecture}--`;
  const validName = (name: string): boolean =>
    name === legacyName ||
    (name.startsWith(stampedPrefix) &&
      /^[a-f0-9]{40}\.deb$/.test(name.slice(stampedPrefix.length)));
  const matches: VerifiedLinuxRelease[] = [];
  for (const asset of value.assets) {
    if (
      !record(asset) ||
      typeof asset.name !== 'string' ||
      !validName(asset.name) ||
      typeof asset.digest !== 'string' ||
      !/^sha256:[a-f0-9]{64}$/.test(asset.digest) ||
      typeof asset.browser_download_url !== 'string'
    )
      continue;
    const expected = `https://github.com/unstoppabledomains/canopy/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(asset.name)}`;
    if (asset.browser_download_url !== expected) continue;
    matches.push({
      version,
      architecture,
      checksum: asset.digest.slice(7),
      algorithm: 'SHA-256',
      url: `https://github.com/unstoppabledomains/canopy/releases/tag/${encodeURIComponent(tag)}`,
    });
  }
  return matches.length === 1 ? matches[0] : null;
}

/** Bound metadata memory and duration; no package payload is ever requested. */
export async function readLinuxReleaseJson(
  response: Response,
  payload: 'release' | 'release-list' = 'release',
): Promise<unknown> {
  return JSON.parse(
    await readLinuxReleaseBody(
      response,
      payload === 'release-list' ? 16 * 1024 * 1024 : 1024 * 1024,
    ),
  );
}

export async function readLinuxReleaseText(
  response: Response,
): Promise<string> {
  return readLinuxReleaseBody(response, 1024 * 1024);
}

async function readLinuxReleaseBody(
  response: Response,
  maxBytes: number,
): Promise<string> {
  if (!response.ok || !response.body)
    throw new Error('Linux update metadata is unavailable.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes)
        throw new Error('Linux update metadata is too large.');
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    await reader.cancel();
  }
}
