import {
  CancellationToken,
  newError,
  type GithubOptions,
} from 'builder-util-runtime';
import type { CustomPublishOptions, UpdateInfo } from 'builder-util-runtime';
import type { RequestOptions, OutgoingHttpHeaders } from 'node:http';
import path from 'node:path';
import { URL } from 'node:url';
import {
  getBrandUpdateChannelFilename as getBrandUpdateChannelFilenameForPlatform,
  getBrandUpdateChannelName,
} from '@canopy/protocol/brand';
import type { AppUpdater } from 'electron-updater';
import type { ResolvedUpdateFileInfo } from 'electron-updater/out/types';
import { BaseGitHubProvider } from 'electron-updater/out/providers/GitHubProvider';
import {
  getFileList,
  parseUpdateInfo,
  type ProviderPlatform,
  type ProviderRuntimeOptions,
} from 'electron-updater/out/providers/Provider';

type GitHubRequestOptions = RequestOptions & {
  redirect?: 'manual';
};

interface GitHubReleaseAsset {
  name: string;
  url: string;
}

interface GitHubReleaseInfo {
  html_url?: string;
  name?: string;
  tag_name?: string;
  prerelease?: boolean;
  published_at?: string;
  assets: GitHubReleaseAsset[];
}

interface BrandedPrivateGitHubUpdateInfo extends UpdateInfo {
  assets: GitHubReleaseAsset[];
}

export interface BrandedPrivateGitHubOptions extends CustomPublishOptions {
  owner?: string | null;
  repo?: string | null;
  host?: string | null;
  protocol?: 'https' | 'http' | null;
  token: string;
  channel: string;
  releaseFlavor?: 'internal' | 'rc';
  targetReleaseTag?: string;
}

type UpdaterLike = Pick<AppUpdater, 'allowPrerelease'>;

export { getBrandUpdateChannelName };

export function getBrandUpdateChannelFilename(
  channel: string,
  platform: ProviderPlatform,
  arch = process.arch,
): string {
  return getBrandUpdateChannelFilenameForPlatform(channel, platform, arch);
}

function requireText(value: string | null | undefined, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Missing GitHub update provider ${field}.`);
  }
  return value;
}

function decodeName(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function candidateAssetNames(updateFileUrl: string): Set<string> {
  const base = path.posix.basename(updateFileUrl);
  const decoded = decodeName(base);
  return new Set([
    base,
    decoded,
    base.replace(/ /g, '-'),
    decoded.replace(/ /g, '-'),
  ]);
}

function findReleaseAsset(
  assets: readonly GitHubReleaseAsset[],
  updateFileUrl: string,
): GitHubReleaseAsset | null {
  const candidates = candidateAssetNames(updateFileUrl);
  return (
    assets.find((asset) => {
      const normalizedAssetNames = candidateAssetNames(asset.name);
      for (const candidate of Array.from(candidates)) {
        if (normalizedAssetNames.has(candidate)) {
          return true;
        }
      }
      return false;
    }) ?? null
  );
}

function getObjectProperty(value: object, propertyName: string): unknown {
  return Reflect.get(value, propertyName);
}

function isNonNullObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}

function isPrereleaseRelease(
  value: unknown,
): value is GitHubReleaseInfo & { prerelease: true } {
  return (
    isNonNullObject(value) && getObjectProperty(value, 'prerelease') === true
  );
}

function isGitHubReleaseAsset(value: unknown): value is GitHubReleaseAsset {
  return (
    isNonNullObject(value) &&
    typeof getObjectProperty(value, 'name') === 'string' &&
    typeof getObjectProperty(value, 'url') === 'string'
  );
}

function isGitHubReleaseInfo(value: unknown): value is GitHubReleaseInfo {
  if (!isNonNullObject(value)) {
    return false;
  }
  const assets = getObjectProperty(value, 'assets');
  return Array.isArray(assets) && assets.every(isGitHubReleaseAsset);
}

type InternalReleaseVersion = {
  counter: number;
};

type RcReleaseVersion = {
  major: number;
  minor: number;
  patch: number;
  counter: number;
};

function parseInternalReleaseVersion(
  releaseInfo: GitHubReleaseInfo,
): InternalReleaseVersion | null {
  const candidates = [releaseInfo.tag_name, releaseInfo.name].filter(
    (value): value is string => typeof value === 'string',
  );
  for (const candidate of candidates) {
    const currentMatch = /^internal-([1-9]\d*)$/i.exec(candidate);
    if (currentMatch) {
      return {
        counter: Number(currentMatch[1]),
      };
    }

    const legacyMatch = /^internal-v\d+\.\d+\.\d+-([1-9]\d*)-[0-9a-z]+$/i.exec(
      candidate,
    );
    if (legacyMatch) {
      return {
        counter: Number(legacyMatch[1]),
      };
    }
  }
  return null;
}

function compareInternalReleaseVersions(
  a: InternalReleaseVersion | null,
  b: InternalReleaseVersion | null,
): number {
  if (a && !b) return 1;
  if (!a && b) return -1;
  if (!a || !b) return 0;
  return a.counter - b.counter;
}

function parseRcReleaseVersion(
  releaseInfo: GitHubReleaseInfo,
): RcReleaseVersion | null {
  const candidates = [releaseInfo.tag_name, releaseInfo.name].filter(
    (value): value is string => typeof value === 'string',
  );
  for (const candidate of candidates) {
    const match =
      /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-rc\.([1-9]\d*)$/i.exec(
        candidate,
      );
    if (match) {
      return {
        major: Number(match[1]),
        minor: Number(match[2]),
        patch: Number(match[3]),
        counter: Number(match[4]),
      };
    }
  }
  return null;
}

function compareRcReleaseVersions(
  a: RcReleaseVersion | null,
  b: RcReleaseVersion | null,
): number {
  if (a && !b) return 1;
  if (!a && b) return -1;
  if (!a || !b) return 0;
  return (
    a.major - b.major ||
    a.minor - b.minor ||
    a.patch - b.patch ||
    a.counter - b.counter
  );
}

function selectLatestPrerelease(
  releases: GitHubReleaseInfo[],
  releaseFlavor: 'internal' | 'rc',
  channelFile: string,
): GitHubReleaseInfo | null {
  const prereleases = releases
    .filter(isPrereleaseRelease)
    .filter((release) =>
      release.assets.some((asset) => asset.name === channelFile),
    )
    .filter((release) =>
      releaseFlavor === 'rc'
        ? parseRcReleaseVersion(release) !== null
        : parseInternalReleaseVersion(release) !== null,
    );
  if (prereleases.length === 0) {
    return null;
  }

  return prereleases.reduce((best, current) => {
    const comparison =
      releaseFlavor === 'rc'
        ? compareRcReleaseVersions(
            parseRcReleaseVersion(current),
            parseRcReleaseVersion(best),
          )
        : compareInternalReleaseVersions(
            parseInternalReleaseVersion(current),
            parseInternalReleaseVersion(best),
          );
    return comparison > 0 ? current : best;
  });
}

function isStrictInternalRelease(releaseInfo: GitHubReleaseInfo): boolean {
  return [releaseInfo.tag_name, releaseInfo.name].some(
    (value) => typeof value === 'string' && /^internal-[1-9]\d*$/i.test(value),
  );
}

function isStrictRcRelease(releaseInfo: GitHubReleaseInfo): boolean {
  return parseRcReleaseVersion(releaseInfo) !== null;
}

function isTargetReleaseForFlavor(
  releaseInfo: GitHubReleaseInfo,
  releaseFlavor: 'internal' | 'rc',
): boolean {
  if (!isPrereleaseRelease(releaseInfo)) {
    return false;
  }
  return releaseFlavor === 'rc'
    ? isStrictRcRelease(releaseInfo)
    : isStrictInternalRelease(releaseInfo);
}

function selectLatestStableRelease(
  releases: GitHubReleaseInfo[],
): GitHubReleaseInfo | null {
  return releases.find((release) => release.prerelease !== true) ?? null;
}

export class BrandedPrivateGitHubProvider extends BaseGitHubProvider<BrandedPrivateGitHubUpdateInfo> {
  private readonly owner: string;
  private readonly repo: string;
  private readonly token: string;
  private readonly channel: string;
  private readonly releaseFlavor: 'internal' | 'rc';
  private readonly targetReleaseTag: string | null;
  private readonly platform: ProviderPlatform;
  private readonly updater: UpdaterLike;

  constructor(
    options: BrandedPrivateGitHubOptions,
    updater: UpdaterLike,
    runtimeOptions: ProviderRuntimeOptions,
  ) {
    super(
      { ...options, provider: 'github' } satisfies GithubOptions,
      'api.github.com',
      {
        ...runtimeOptions,
        isUseMultipleRangeRequest: false,
      },
    );
    this.owner = requireText(options.owner, 'owner');
    this.repo = requireText(options.repo, 'repo');
    this.token = requireText(options.token, 'token');
    this.channel = requireText(options.channel, 'channel');
    this.releaseFlavor = options.releaseFlavor === 'rc' ? 'rc' : 'internal';
    this.targetReleaseTag =
      typeof options.targetReleaseTag === 'string' &&
      options.targetReleaseTag.trim().length > 0
        ? options.targetReleaseTag.trim()
        : null;
    this.platform = runtimeOptions.platform;
    this.updater = updater;
  }

  protected override createRequestOptions(
    url: URL,
    headers?: OutgoingHttpHeaders | null,
  ): RequestOptions {
    const result: GitHubRequestOptions = super.createRequestOptions(
      url,
      headers,
    );
    result.redirect = 'manual';
    return result;
  }

  override async getLatestVersion(): Promise<BrandedPrivateGitHubUpdateInfo> {
    const cancellationToken = new CancellationToken();
    const channelFile = getBrandUpdateChannelFilename(
      this.channel,
      this.platform,
    );
    const releaseInfo = await this.getLatestVersionInfo(
      cancellationToken,
      channelFile,
    );
    const asset = releaseInfo.assets.find(
      (entry) => entry.name === channelFile,
    );

    if (!asset) {
      throw newError(
        `Cannot find expected update metadata asset ${channelFile} in the latest release.`,
        'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND',
      );
    }

    const url = new URL(asset.url);
    let updateInfo: UpdateInfo;
    try {
      updateInfo = parseUpdateInfo(
        await this.httpRequest(
          url,
          this.configureHeaders('application/octet-stream'),
          cancellationToken,
        ),
        channelFile,
        url,
      );
    } catch {
      throw newError(
        `Cannot read expected update metadata asset ${channelFile} from the latest release.`,
        'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND',
      );
    }

    return {
      ...updateInfo,
      assets: releaseInfo.assets,
    };
  }

  override get fileExtraDownloadHeaders(): OutgoingHttpHeaders {
    return this.configureHeaders('application/octet-stream');
  }

  override resolveFiles(
    updateInfo: BrandedPrivateGitHubUpdateInfo,
  ): ResolvedUpdateFileInfo[] {
    return getFileList(updateInfo).map((fileInfo) => {
      const asset = findReleaseAsset(updateInfo.assets, fileInfo.url);
      if (!asset) {
        throw newError(
          `Cannot find brand update asset "${path.posix.basename(
            fileInfo.url,
          )}" in the latest release assets.`,
          'ERR_UPDATER_ASSET_NOT_FOUND',
        );
      }

      return {
        url: new URL(asset.url),
        info: fileInfo,
      };
    });
  }

  private configureHeaders(accept: string): OutgoingHttpHeaders {
    return {
      accept,
      authorization: `token ${this.token}`,
    };
  }

  private async getLatestVersionInfo(
    cancellationToken: CancellationToken,
    channelFile: string,
  ): Promise<GitHubReleaseInfo> {
    if (this.targetReleaseTag) {
      return this.getTargetVersionInfo(cancellationToken);
    }

    let basePath = this.basePath;
    if (!this.updater.allowPrerelease) {
      basePath = `${basePath}/latest`;
    }

    const url = new URL(basePath, this.baseUrl);
    let parsed: unknown;
    try {
      parsed = JSON.parse(
        (await this.httpRequest(
          url,
          this.configureHeaders('application/vnd.github.v3+json'),
          cancellationToken,
        )) ?? 'null',
      );
    } catch {
      throw newError(
        'Unable to find the latest update release on GitHub. Please ensure a production release exists.',
        'ERR_UPDATER_LATEST_VERSION_NOT_FOUND',
      );
    }

    let releaseInfo: unknown;
    if (Array.isArray(parsed)) {
      const releases = parsed.filter(isGitHubReleaseInfo);
      releaseInfo = this.updater.allowPrerelease
        ? selectLatestPrerelease(releases, this.releaseFlavor, channelFile)
        : selectLatestStableRelease(releases);
    } else {
      releaseInfo = parsed;
    }

    if (!isGitHubReleaseInfo(releaseInfo)) {
      throw newError(
        this.updater.allowPrerelease
          ? 'Unable to find the latest prerelease update on GitHub. The release response did not include any prereleases with assets.'
          : 'Unable to find the latest update release on GitHub. The release response did not include assets.',
        'ERR_UPDATER_LATEST_VERSION_NOT_FOUND',
      );
    }

    return releaseInfo;
  }

  private async getTargetVersionInfo(
    cancellationToken: CancellationToken,
  ): Promise<GitHubReleaseInfo> {
    const url = new URL(
      `${this.basePath}/tags/${encodeURIComponent(this.targetReleaseTag ?? '')}`,
      this.baseUrl,
    );
    let parsed: unknown;
    try {
      parsed = JSON.parse(
        (await this.httpRequest(
          url,
          this.configureHeaders('application/vnd.github.v3+json'),
          cancellationToken,
        )) ?? 'null',
      );
    } catch {
      throw newError(
        `Unable to find the targeted update release ${this.targetReleaseTag} on GitHub.`,
        'ERR_UPDATER_TARGET_VERSION_NOT_FOUND',
      );
    }

    if (
      !isGitHubReleaseInfo(parsed) ||
      !isTargetReleaseForFlavor(parsed, this.releaseFlavor)
    ) {
      throw newError(
        `Targeted update release ${this.targetReleaseTag} is not a valid ${this.releaseFlavor} release.`,
        'ERR_UPDATER_TARGET_VERSION_NOT_FOUND',
      );
    }

    return parsed;
  }

  private get basePath(): string {
    return this.computeGithubBasePath(
      `/repos/${this.owner}/${this.repo}/releases`,
    );
  }
}
