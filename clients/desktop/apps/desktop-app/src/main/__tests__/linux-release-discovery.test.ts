import { BRAND } from '@canopy/brand/current';
import {
  verifiedLinuxMetadata,
  verifiedLinuxRelease,
  readLinuxReleaseJson,
  readLinuxReleaseText,
} from '../updater/linux-release-discovery';

const base = 'https://releases.unstoppable.ai';
const checksum = Buffer.alloc(64).toString('base64');
const name = `${BRAND.release.artifactPrefix}-1.2.0-linux-amd64.deb`;
const arm64Name = `${BRAND.release.artifactPrefix}-1.2.0-linux-arm64.deb`;
const file = { url: name, sha512: checksum };
const arm64File = { url: arm64Name, sha512: checksum };
const metadata = { version: '1.2.0', files: [file] };

type Architecture = 'x64' | 'arm64';
const HOSTS: Architecture[] = ['x64', 'arm64'];

describe('trusted Linux metadata contract', () => {
  it.each([
    'http://releases.unstoppable.ai',
    '',
    'not a URL',
    'https://user:pass@releases.unstoppable.ai',
    'https://releases.unstoppable.ai/?override=true',
  ])('rejects unsafe baked origins: %s', (origin) => {
    expect(verifiedLinuxMetadata(metadata, origin, 'x64')).toBeNull();
  });
  it('constructs the immutable official brand artifact URL and exposes SHA512', () => {
    expect(verifiedLinuxMetadata(metadata, base, 'x64')).toEqual({
      version: '1.2.0',
      architecture: 'x64',
      url: `${base}/desktop/${BRAND.release.artifactPrefix}/1.2.0/${name}`,
      checksum: '0'.repeat(128),
      algorithm: 'SHA-512',
    });
  });
  it('constructs the arm64 artifact URL for an arm64 package', () => {
    expect(
      verifiedLinuxMetadata({ ...metadata, files: [arm64File] }, base, 'arm64'),
    ).toEqual({
      version: '1.2.0',
      architecture: 'arm64',
      url: `${base}/desktop/${BRAND.release.artifactPrefix}/1.2.0/${arm64Name}`,
      checksum: '0'.repeat(128),
      algorithm: 'SHA-512',
    });
  });
  describe.each(HOSTS)('selects only the %s package', (host) => {
    const own = host === 'x64' ? name : arm64Name;
    it('from metadata listing both architectures', () => {
      expect(
        verifiedLinuxMetadata(
          { ...metadata, files: [file, arm64File] },
          base,
          host,
        ),
      ).toMatchObject({
        architecture: host,
        url: `${base}/desktop/${BRAND.release.artifactPrefix}/1.2.0/${own}`,
      });
    });
    it('from metadata listing only that architecture', () => {
      expect(
        verifiedLinuxMetadata(
          { ...metadata, files: [host === 'x64' ? file : arm64File] },
          base,
          host,
        ),
      ).toMatchObject({ architecture: host });
    });
    it('never from metadata listing only the other architecture', () => {
      expect(
        verifiedLinuxMetadata(
          { ...metadata, files: [host === 'x64' ? arm64File : file] },
          base,
          host,
        ),
      ).toBeNull();
    });
    it('never from metadata listing neither architecture', () => {
      expect(
        verifiedLinuxMetadata(
          {
            ...metadata,
            files: [
              {
                ...file,
                url: `${BRAND.release.artifactPrefix}-1.2.0.AppImage`,
              },
            ],
          },
          base,
          host,
        ),
      ).toBeNull();
    });
  });
  it.each([
    '',
    'hash',
    'a'.repeat(128),
    `${'B'.repeat(86)}==`,
    Buffer.alloc(32).toString('base64'),
  ])('refuses invalid SHA512 encoding: %s', (sha512) => {
    expect(
      verifiedLinuxMetadata(
        { ...metadata, files: [{ ...file, sha512 }] },
        base,
        'x64',
      ),
    ).toBeNull();
  });
  it.each([
    'other-1.2.0-linux-amd64.deb',
    `${BRAND.release.artifactPrefix}-1.2.1-linux-amd64.deb`,
    `${BRAND.release.artifactPrefix}-1.2.0-linux-arm64.deb`,
    `${BRAND.release.artifactPrefix}-1.2.0.AppImage`,
    `https://attacker.test/${name}`,
    `../${name}`,
    `${base}/desktop/${BRAND.release.artifactPrefix}/1.1.0/${name}`,
  ])('refuses wrong brand/version/package/origin: %s', (url) => {
    expect(
      verifiedLinuxMetadata(
        { ...metadata, files: [{ ...file, url }] },
        base,
        'x64',
      ),
    ).toBeNull();
  });
  it.each(['01.2.0', '1.2.0-rc.1', '1.2', 'v1.2.0', '1.2.0+anything'])(
    'refuses nonstable identities: %s',
    (version) => {
      expect(
        verifiedLinuxMetadata({ ...metadata, version }, base, 'x64'),
      ).toBeNull();
    },
  );
  it('refuses duplicate qualifying packages', () => {
    expect(
      verifiedLinuxMetadata({ ...metadata, files: [file, file] }, base, 'x64'),
    ).toBeNull();
  });
  it('accepts the exact published immutable URL, not an arbitrary fallback', () => {
    expect(
      verifiedLinuxMetadata(
        {
          ...metadata,
          files: [
            {
              ...file,
              url: `${base}/desktop/${BRAND.release.artifactPrefix}/1.2.0/${name}`,
            },
          ],
        },
        base,
        'x64',
      )?.url,
    ).toBe(`${base}/desktop/${BRAND.release.artifactPrefix}/1.2.0/${name}`);
  });
  it('bounds response bodies before parsing', async () => {
    await expect(
      readLinuxReleaseText(new Response('a'.repeat(1024 * 1024 + 1))),
    ).rejects.toThrow(/too large/);
  });
  it.each([
    { payload: 'release' as const, limit: 1024 * 1024 },
    { payload: 'release-list' as const, limit: 16 * 1024 * 1024 },
  ])(
    'enforces the exact byte boundary for $payload JSON',
    async ({ payload, limit }) => {
      const value = 'x'.repeat(limit - 2);
      await expect(
        readLinuxReleaseJson(new Response(JSON.stringify(value)), payload),
      ).resolves.toBe(value);
      await expect(
        readLinuxReleaseJson(
          new Response(JSON.stringify(`${value}x`)),
          payload,
        ),
      ).rejects.toThrow('Linux update metadata is too large.');
    },
  );
  it('counts UTF-8 bytes and cancels an oversized single-release stream', async () => {
    const cancel = jest.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller): void {
        controller.enqueue(new TextEncoder().encode('é'.repeat(512 * 1024)));
        controller.enqueue(new TextEncoder().encode('é'));
      },
      cancel,
    });
    await expect(readLinuxReleaseJson(new Response(stream))).rejects.toThrow(
      'Linux update metadata is too large.',
    );
    expect(cancel).toHaveBeenCalledTimes(1);
  });
  it('refuses unavailable metadata without reading package bytes', async () => {
    await expect(
      readLinuxReleaseText(new Response('missing', { status: 404 })),
    ).rejects.toThrow(/unavailable/);
  });
});

interface ReleaseFixture {
  draft: boolean;
  prerelease: boolean;
  tag_name: string;
  assets: Array<{ name: string; digest: string; browser_download_url: string }>;
}

function stampedAsset(
  tag: string,
  flavor: 'internal' | 'rc',
  architecture: Architecture,
): ReleaseFixture['assets'][number] {
  const version =
    flavor === 'internal' ? `9999.0.0-internal.${tag.slice(9)}` : tag.slice(1);
  const name = `desktop--${BRAND.id}--${version}--${flavor}--linux-${architecture}--${'b'.repeat(40)}.deb`;
  return {
    name,
    digest: `sha256:${'a'.repeat(64)}`,
    browser_download_url: `https://github.com/unstoppabledomains/canopy/releases/download/${tag}/${name}`,
  };
}

function legacyAsset(
  tag: string,
  flavor: 'internal' | 'rc',
  architecture: Architecture,
): ReleaseFixture['assets'][number] {
  const debArch = architecture === 'x64' ? 'amd64' : 'arm64';
  const name =
    flavor === 'internal'
      ? `${BRAND.release.artifactPrefix}-internal-linux-${debArch}.deb`
      : `${BRAND.release.artifactPrefix}-${tag.slice(1)}-linux-${debArch}.deb`;
  return {
    name,
    digest: `sha256:${'c'.repeat(64)}`,
    browser_download_url: `https://github.com/unstoppabledomains/canopy/releases/download/${tag}/${name}`,
  };
}

function releaseFixture(
  tag: string,
  flavor: 'internal' | 'rc',
  architectures: Architecture[] = ['x64'],
): ReleaseFixture {
  return {
    draft: false,
    prerelease: true,
    tag_name: tag,
    assets: architectures.map((architecture) =>
      stampedAsset(tag, flavor, architecture),
    ),
  };
}

describe('official targeted Linux releases', () => {
  it('accepts the actual generated internal artifact name, with digest bound to the exact tag', () => {
    const release = releaseFixture('internal-123', 'internal');
    const name = `${BRAND.release.artifactPrefix}-internal-linux-amd64.deb`;
    release.assets = release.assets.map((asset) => ({
      ...asset,
      name,
      browser_download_url: `https://github.com/unstoppabledomains/canopy/releases/download/internal-123/${name}`,
    }));
    expect(verifiedLinuxRelease(release, 'internal', 'x64')).toMatchObject({
      version: 'internal-123',
      architecture: 'x64',
      checksum: 'a'.repeat(64),
      url: 'https://github.com/unstoppabledomains/canopy/releases/tag/internal-123',
    });
  });
  it.each(['9999.0.0-internal.123', '9999.0.0-internal.124', '1.2.0'])(
    'rejects an invented versioned legacy internal name: %s',
    (version) => {
      const release = releaseFixture('internal-123', 'internal');
      const name = `${BRAND.release.artifactPrefix}-${version}-linux-amd64.deb`;
      release.assets = release.assets.map((asset) => ({
        ...asset,
        name,
        browser_download_url: `https://github.com/unstoppabledomains/canopy/releases/download/internal-123/${name}`,
      }));
      expect(verifiedLinuxRelease(release, 'internal', 'x64')).toBeNull();
    },
  );
  it.each([
    { tag: 'internal-123', flavor: 'internal' as const },
    { tag: 'v1.2.0-rc.3', flavor: 'rc' as const },
  ])(
    'keeps the exact $flavor version, digest and fixed tag permalink',
    ({ tag, flavor }) => {
      expect(
        verifiedLinuxRelease(releaseFixture(tag, flavor), flavor, 'x64'),
      ).toMatchObject({
        algorithm: 'SHA-256',
        architecture: 'x64',
        checksum: 'a'.repeat(64),
        url: `https://github.com/unstoppabledomains/canopy/releases/tag/${tag}`,
      });
    },
  );
  describe.each([
    { tag: 'internal-123', flavor: 'internal' as const },
    { tag: 'v1.2.0-rc.3', flavor: 'rc' as const },
  ])('$flavor release package selection by architecture', ({ tag, flavor }) => {
    describe.each(HOSTS)('on an installed %s package', (host) => {
      const other: Architecture = host === 'x64' ? 'arm64' : 'x64';
      it('selects its own stamped package when both are published', () => {
        const release = releaseFixture(tag, flavor, ['x64', 'arm64']);
        expect(verifiedLinuxRelease(release, flavor, host)).toMatchObject({
          architecture: host,
          checksum: 'a'.repeat(64),
        });
      });
      it('selects its own legacy package when both are published', () => {
        const release = {
          ...releaseFixture(tag, flavor, []),
          assets: [
            legacyAsset(tag, flavor, 'x64'),
            legacyAsset(tag, flavor, 'arm64'),
          ],
        };
        expect(verifiedLinuxRelease(release, flavor, host)).toMatchObject({
          architecture: host,
          checksum: 'c'.repeat(64),
        });
      });
      it('selects its own package when only that architecture is published', () => {
        expect(
          verifiedLinuxRelease(
            releaseFixture(tag, flavor, [host]),
            flavor,
            host,
          ),
        ).toMatchObject({ architecture: host });
      });
      it('never offers the other architecture when only it is published', () => {
        expect(
          verifiedLinuxRelease(
            releaseFixture(tag, flavor, [other]),
            flavor,
            host,
          ),
        ).toBeNull();
        expect(
          verifiedLinuxRelease(
            {
              ...releaseFixture(tag, flavor, []),
              assets: [legacyAsset(tag, flavor, other)],
            },
            flavor,
            host,
          ),
        ).toBeNull();
      });
      it('reports nothing when neither architecture is published', () => {
        expect(
          verifiedLinuxRelease(releaseFixture(tag, flavor, []), flavor, host),
        ).toBeNull();
      });
      it('refuses an ambiguous stamped plus legacy pair for the same architecture', () => {
        const release = releaseFixture(tag, flavor, [host]);
        release.assets.push(legacyAsset(tag, flavor, host));
        expect(verifiedLinuxRelease(release, flavor, host)).toBeNull();
      });
    });
  });
  it.each([
    { draft: true },
    { prerelease: false },
    { tag_name: 'internal-0123' },
    { assets: [] },
  ])('fails closed on unavailable/unpublished identity: %j', (change) => {
    expect(
      verifiedLinuxRelease(
        { ...releaseFixture('internal-123', 'internal'), ...change },
        'internal',
        'x64',
      ),
    ).toBeNull();
  });
  it('never substitutes the wrong channel', () => {
    expect(
      verifiedLinuxRelease(
        releaseFixture('internal-123', 'internal'),
        'rc',
        'x64',
      ),
    ).toBeNull();
  });
  it.each([
    'sha256:short',
    `sha512:${'a'.repeat(64)}`,
    `sha256:${'A'.repeat(64)}`,
    '',
  ])('refuses malformed or wrong-algorithm digests: %s', (digest) => {
    const release = releaseFixture('internal-123', 'internal');
    release.assets = release.assets.map((asset) => ({ ...asset, digest }));
    expect(verifiedLinuxRelease(release, 'internal', 'x64')).toBeNull();
  });
  it.each([
    'brand',
    'version',
    'channel',
    'architecture',
    'short-sha',
    'omitted',
    'foreign-url',
  ])('refuses mismatched targeted asset %s', (change) => {
    const release = releaseFixture('internal-123', 'internal');
    release.assets = release.assets.map((asset) => {
      const name =
        change === 'brand'
          ? asset.name.replace(`desktop--${BRAND.id}--`, 'desktop--other--')
          : change === 'version'
            ? asset.name.replace('internal.123', 'internal.124')
            : change === 'channel'
              ? asset.name.replace('--internal--', '--rc--')
              : change === 'architecture'
                ? asset.name.replace('--linux-x64--', '--linux-arm64--')
                : change === 'short-sha'
                  ? asset.name.replace('b'.repeat(40), 'b'.repeat(8))
                  : change === 'omitted'
                    ? asset.name.replace('.deb', '--cli-omitted.deb')
                    : asset.name;
      return {
        ...asset,
        name,
        browser_download_url:
          change === 'foreign-url'
            ? `https://attacker.test/${name}`
            : `https://github.com/unstoppabledomains/canopy/releases/download/internal-123/${name}`,
      };
    });
    expect(verifiedLinuxRelease(release, 'internal', 'x64')).toBeNull();
  });
  it('refuses ambiguous multiple qualifying packages', () => {
    const release = releaseFixture('internal-123', 'internal');
    release.assets = [...release.assets, ...release.assets];
    expect(verifiedLinuxRelease(release, 'internal', 'x64')).toBeNull();
  });
});
