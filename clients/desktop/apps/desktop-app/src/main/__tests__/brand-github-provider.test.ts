import type { OutgoingHttpHeaders, RequestOptions } from 'node:http';
import {
  BrandedPrivateGitHubProvider,
  getBrandUpdateChannelFilename,
  getBrandUpdateChannelName,
} from '../updater/brand-github-provider';

function requestPath(options: RequestOptions): string {
  return String(options.path ?? '');
}

function isOutgoingHttpHeaders(
  headers: RequestOptions['headers'],
): headers is OutgoingHttpHeaders {
  return headers !== undefined && !Array.isArray(headers);
}

function createProvider(
  request: jest.Mock<Promise<string | null>, [RequestOptions]>,
  allowPrerelease = false,
  releaseFlavor: 'internal' | 'rc' = 'internal',
  targetReleaseTag?: string,
  platform: 'darwin' | 'win32' = 'darwin',
): BrandedPrivateGitHubProvider {
  return new BrandedPrivateGitHubProvider(
    {
      provider: 'custom',
      owner: 'example-org',
      repo: 'example-repo',
      token: 'ghp_test_token_123',
      channel: 'somebrand',
      releaseFlavor,
      targetReleaseTag,
    },
    { allowPrerelease },
    {
      platform,
      isUseMultipleRangeRequest: true,
      executor: { request } as never,
    },
  );
}

describe('branded private GitHub updater provider', () => {
  it('keeps the default brand on the legacy updater channel', () => {
    expect(
      getBrandUpdateChannelName({
        id: 'canopy',
        release: { enabled: ['stable'], artifactPrefix: 'canopy' },
      }),
    ).toBe('latest');
  });

  it('uses the release artifact prefix as the branded updater channel', () => {
    expect(
      getBrandUpdateChannelName({
        id: 'somebrand',
        release: { enabled: ['stable'], artifactPrefix: 'somebrand' },
      }),
    ).toBe('somebrand');
  });

  it('maps updater channel files by platform', () => {
    expect(getBrandUpdateChannelFilename('somebrand', 'darwin')).toBe(
      'somebrand-mac.yml',
    );
    expect(getBrandUpdateChannelFilename('somebrand', 'win32')).toBe(
      'somebrand.yml',
    );
    expect(getBrandUpdateChannelFilename('somebrand', 'linux', 'x64')).toBe(
      'somebrand-linux.yml',
    );
    expect(getBrandUpdateChannelFilename('somebrand', 'linux', 'arm64')).toBe(
      'somebrand-linux-arm64.yml',
    );
  });

  it('requests and resolves assets from the branded channel file', async () => {
    const release = {
      name: 'v2.0.0',
      html_url: 'https://github.com/example-org/example-repo/releases/v2.0.0',
      assets: [
        {
          name: 'latest-mac.yml',
          url: 'https://api.github.com/repos/example-org/example-repo/releases/assets/1',
        },
        {
          name: 'somebrand-mac.yml',
          url: 'https://api.github.com/repos/example-org/example-repo/releases/assets/2',
        },
        {
          name: 'SomeBrand-2.0.0-mac.zip',
          url: 'https://api.github.com/repos/example-org/example-repo/releases/assets/3',
        },
      ],
    };
    const request = jest.fn(
      (options: RequestOptions): Promise<string | null> => {
        if (requestPath(options).endsWith('/releases/latest')) {
          return Promise.resolve(JSON.stringify(release));
        }
        if (requestPath(options).endsWith('/releases/assets/2')) {
          return Promise.resolve(
            [
              'version: 2.0.0',
              'files:',
              '  - url: SomeBrand-2.0.0-mac.zip',
              '    sha512: test-checksum',
              '    size: 123',
              'path: SomeBrand-2.0.0-mac.zip',
              'sha512: test-checksum',
              'releaseDate: "2026-05-01T00:00:00.000Z"',
            ].join('\n'),
          );
        }
        throw new Error(`Unexpected request path: ${requestPath(options)}`);
      },
    );
    const provider = createProvider(request);

    const updateInfo = await provider.getLatestVersion();
    const files = provider.resolveFiles(updateInfo);

    expect(updateInfo.version).toBe('2.0.0');
    expect(files[0]?.url.href).toBe(
      'https://api.github.com/repos/example-org/example-repo/releases/assets/3',
    );
    expect(
      request.mock.calls.some(
        ([options]) =>
          isOutgoingHttpHeaders(options.headers) &&
          options.headers.authorization === 'token ghp_test_token_123',
      ),
    ).toBe(true);
  });

  it('selects the newest internal prerelease by counter tag', async () => {
    const releases = [
      {
        tag_name: 'internal-124',
        name: 'internal-124',
        prerelease: true,
        assets: [
          {
            name: 'somebrand-mac.yml',
            url: 'https://api.github.com/repos/example-org/example-repo/releases/assets/old',
          },
        ],
      },
      {
        tag_name: 'internal-126',
        name: 'internal-126',
        prerelease: true,
        assets: [
          {
            name: 'somebrand-mac.yml',
            url: 'https://api.github.com/repos/example-org/example-repo/releases/assets/new',
          },
          {
            name: 'SomeBrand-internal-mac.zip',
            url: 'https://api.github.com/repos/example-org/example-repo/releases/assets/new-zip',
          },
        ],
      },
      {
        tag_name: 'v0.25.2',
        name: 'v0.25.2',
        prerelease: false,
        assets: [],
      },
    ];
    const request = jest.fn(
      (options: RequestOptions): Promise<string | null> => {
        if (requestPath(options).endsWith('/releases')) {
          return Promise.resolve(JSON.stringify(releases));
        }
        if (requestPath(options).endsWith('/releases/assets/new')) {
          return Promise.resolve(
            [
              'version: 9999.0.0-internal.126',
              'files:',
              '  - url: SomeBrand-internal-mac.zip',
              '    sha512: test-checksum',
              '    size: 123',
              'path: SomeBrand-internal-mac.zip',
              'sha512: test-checksum',
              'releaseDate: "2026-05-01T00:00:00.000Z"',
            ].join('\n'),
          );
        }
        throw new Error(`Unexpected request path: ${requestPath(options)}`);
      },
    );
    const provider = createProvider(request, true);

    const updateInfo = await provider.getLatestVersion();

    expect(updateInfo.version).toBe('9999.0.0-internal.126');
    expect(
      request.mock.calls.some(([options]) =>
        requestPath(options).endsWith('/releases/assets/old'),
      ),
    ).toBe(false);
  });

  it('requests an exact targeted internal release tag', async () => {
    const request = jest.fn(
      (options: RequestOptions): Promise<string | null> => {
        if (requestPath(options).endsWith('/releases/tags/internal-124')) {
          return Promise.resolve(
            JSON.stringify({
              tag_name: 'internal-124',
              name: 'internal-124',
              prerelease: true,
              assets: [
                {
                  name: 'somebrand-mac.yml',
                  url: 'https://api.github.com/repos/example-org/example-repo/releases/assets/target',
                },
                {
                  name: 'SomeBrand-internal-mac.zip',
                  url: 'https://api.github.com/repos/example-org/example-repo/releases/assets/target-zip',
                },
              ],
            }),
          );
        }
        if (requestPath(options).endsWith('/releases/assets/target')) {
          return Promise.resolve(
            [
              'version: 9999.0.0-internal.124',
              'files:',
              '  - url: SomeBrand-internal-mac.zip',
              '    sha512: test-checksum',
              '    size: 123',
              'path: SomeBrand-internal-mac.zip',
              'sha512: test-checksum',
              'releaseDate: "2026-05-01T00:00:00.000Z"',
            ].join('\n'),
          );
        }
        throw new Error(`Unexpected request path: ${requestPath(options)}`);
      },
    );
    const provider = createProvider(request, true, 'internal', 'internal-124');

    const updateInfo = await provider.getLatestVersion();

    expect(updateInfo.version).toBe('9999.0.0-internal.124');
    expect(
      request.mock.calls.some(([options]) =>
        requestPath(options).endsWith('/releases'),
      ),
    ).toBe(false);
  });

  it('rejects legacy internal tags for targeted updates', async () => {
    const request = jest.fn(
      (options: RequestOptions): Promise<string | null> => {
        if (
          requestPath(options).endsWith(
            '/releases/tags/internal-v0.25.2-124-def5678',
          )
        ) {
          return Promise.resolve(
            JSON.stringify({
              tag_name: 'internal-v0.25.2-124-def5678',
              name: 'internal-v0.25.2-124-def5678',
              prerelease: true,
              assets: [
                {
                  name: 'somebrand-mac.yml',
                  url: 'https://api.github.com/repos/example-org/example-repo/releases/assets/legacy',
                },
              ],
            }),
          );
        }
        throw new Error(`Unexpected request path: ${requestPath(options)}`);
      },
    );
    const provider = createProvider(
      request,
      true,
      'internal',
      'internal-v0.25.2-124-def5678',
    );

    await expect(provider.getLatestVersion()).rejects.toThrow(
      'not a valid internal release',
    );
  });

  it('keeps legacy internal prerelease tags eligible for updater migration', async () => {
    const releases = [
      {
        tag_name: 'internal-v0.25.2-124-def5678',
        name: 'internal-v0.25.2-124-def5678',
        prerelease: true,
        assets: [
          {
            name: 'somebrand-mac.yml',
            url: 'https://api.github.com/repos/example-org/example-repo/releases/assets/old',
          },
        ],
      },
      {
        tag_name: 'internal-126',
        name: 'internal-126',
        prerelease: true,
        assets: [
          {
            name: 'somebrand-mac.yml',
            url: 'https://api.github.com/repos/example-org/example-repo/releases/assets/new',
          },
        ],
      },
    ];
    const request = jest.fn(
      (options: RequestOptions): Promise<string | null> => {
        if (requestPath(options).endsWith('/releases')) {
          return Promise.resolve(JSON.stringify(releases));
        }
        if (requestPath(options).endsWith('/releases/assets/new')) {
          return Promise.resolve(
            [
              'version: 9999.0.0-internal.126',
              'files:',
              '  - url: SomeBrand-internal-mac.zip',
              '    sha512: test-checksum',
              '    size: 123',
              'path: SomeBrand-internal-mac.zip',
              'sha512: test-checksum',
              'releaseDate: "2026-05-01T00:00:00.000Z"',
            ].join('\n'),
          );
        }
        throw new Error(`Unexpected request path: ${requestPath(options)}`);
      },
    );
    const provider = createProvider(request, true);

    const updateInfo = await provider.getLatestVersion();

    expect(updateInfo.version).toBe('9999.0.0-internal.126');
  });

  it('selects the newest rc prerelease by stable version and rc counter', async () => {
    const releases = [
      {
        tag_name: 'internal-200',
        name: 'internal-200',
        prerelease: true,
        assets: [
          {
            name: 'somebrand-mac.yml',
            url: 'https://api.github.com/repos/example-org/example-repo/releases/assets/internal',
          },
        ],
      },
      {
        tag_name: 'v1.4.0-rc.1',
        name: 'v1.4.0-rc.1',
        prerelease: true,
        assets: [
          {
            name: 'somebrand-mac.yml',
            url: 'https://api.github.com/repos/example-org/example-repo/releases/assets/old',
          },
        ],
      },
      {
        tag_name: 'v1.4.0-rc.2',
        name: 'v1.4.0-rc.2',
        prerelease: true,
        assets: [
          {
            name: 'somebrand-mac.yml',
            url: 'https://api.github.com/repos/example-org/example-repo/releases/assets/new',
          },
          {
            name: 'SomeBrand-1.4.0-rc.2-mac.zip',
            url: 'https://api.github.com/repos/example-org/example-repo/releases/assets/new-zip',
          },
        ],
      },
      {
        tag_name: 'v1.3.9-rc.9',
        name: 'v1.3.9-rc.9',
        prerelease: true,
        assets: [
          {
            name: 'somebrand-mac.yml',
            url: 'https://api.github.com/repos/example-org/example-repo/releases/assets/older-base',
          },
        ],
      },
    ];
    const request = jest.fn(
      (options: RequestOptions): Promise<string | null> => {
        if (requestPath(options).endsWith('/releases')) {
          return Promise.resolve(JSON.stringify(releases));
        }
        if (requestPath(options).endsWith('/releases/assets/new')) {
          return Promise.resolve(
            [
              'version: 1.4.0-rc.2',
              'files:',
              '  - url: SomeBrand-1.4.0-rc.2-mac.zip',
              '    sha512: test-checksum',
              '    size: 123',
              'path: SomeBrand-1.4.0-rc.2-mac.zip',
              'sha512: test-checksum',
              'releaseDate: "2026-05-01T00:00:00.000Z"',
            ].join('\n'),
          );
        }
        throw new Error(`Unexpected request path: ${requestPath(options)}`);
      },
    );
    const provider = createProvider(request, true, 'rc');

    const updateInfo = await provider.getLatestVersion();

    expect(updateInfo.version).toBe('1.4.0-rc.2');
    expect(
      request.mock.calls.some(([options]) =>
        requestPath(options).endsWith('/releases/assets/internal'),
      ),
    ).toBe(false);
  });

  it.each([
    {
      platform: 'darwin',
      channelFile: 'somebrand-mac.yml',
      otherChannel: 'somebrand.yml',
    },
    {
      platform: 'win32',
      channelFile: 'somebrand.yml',
      otherChannel: 'somebrand-mac.yml',
    },
  ] as const)(
    'selects the newest RC built for $platform when newer RCs omit its channel',
    async ({ platform, channelFile, otherChannel }) => {
      const releases = [
        {
          tag_name: 'v1.4.0-rc.3',
          prerelease: true,
          assets: [
            {
              name: otherChannel,
              url: 'https://api.github.com/releases/assets/other',
            },
          ],
        },
        {
          tag_name: 'v1.4.0-rc.1',
          prerelease: true,
          assets: [
            {
              name: channelFile,
              url: 'https://api.github.com/releases/assets/older',
            },
          ],
        },
        {
          tag_name: 'v1.4.0-rc.2',
          prerelease: true,
          assets: [
            {
              name: channelFile,
              url: 'https://api.github.com/releases/assets/selected',
            },
          ],
        },
      ];
      const request = jest.fn(
        (options: RequestOptions): Promise<string | null> => {
          if (requestPath(options).endsWith('/releases')) {
            return Promise.resolve(JSON.stringify(releases));
          }
          if (requestPath(options).endsWith('/releases/assets/selected')) {
            return Promise.resolve(
              'version: 1.4.0-rc.2\npath: SomeBrand.zip\nsha512: test-checksum',
            );
          }
          throw new Error(`Unexpected request path: ${requestPath(options)}`);
        },
      );
      const provider = createProvider(request, true, 'rc', undefined, platform);

      await expect(provider.getLatestVersion()).resolves.toMatchObject({
        version: '1.4.0-rc.2',
      });
    },
  );

  it('fails when no RC contains the branded platform channel instead of using another flavor', async () => {
    const request = jest.fn<Promise<string | null>, [RequestOptions]>(
      (): Promise<string | null> =>
        Promise.resolve(
          JSON.stringify([
            {
              tag_name: 'v1.4.0-rc.2',
              prerelease: true,
              assets: [
                {
                  name: 'somebrand.yml',
                  url: 'https://api.github.com/releases/assets/windows',
                },
              ],
            },
            {
              tag_name: 'v1.4.0',
              prerelease: false,
              assets: [
                {
                  name: 'somebrand-mac.yml',
                  url: 'https://api.github.com/releases/assets/stable',
                },
              ],
            },
            {
              tag_name: 'internal-200',
              prerelease: true,
              assets: [
                {
                  name: 'somebrand-mac.yml',
                  url: 'https://api.github.com/releases/assets/internal',
                },
              ],
            },
          ]),
        ),
    );
    const provider = createProvider(request, true, 'rc');

    await expect(provider.getLatestVersion()).rejects.toMatchObject({
      code: 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND',
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('does not fall back to a stable release when prerelease updates are allowed', async () => {
    const request = jest.fn(
      (options: RequestOptions): Promise<string | null> => {
        if (requestPath(options).endsWith('/releases')) {
          return Promise.resolve(
            JSON.stringify([
              {
                tag_name: 'v0.25.2',
                name: 'v0.25.2',
                prerelease: false,
                assets: [
                  {
                    name: 'latest-mac.yml',
                    url: 'https://api.github.com/repos/example-org/example-repo/releases/assets/stable',
                  },
                ],
              },
            ]),
          );
        }
        throw new Error(`Unexpected request path: ${requestPath(options)}`);
      },
    );
    const provider = createProvider(request, true);

    await expect(provider.getLatestVersion()).rejects.toThrow(
      'latest prerelease update',
    );
    expect(
      request.mock.calls.some(([options]) =>
        requestPath(options).endsWith('/releases/assets/stable'),
      ),
    ).toBe(false);
  });

  it('selects the latest stable release from an array response when prereleases are disabled', async () => {
    const request = jest.fn(
      (options: RequestOptions): Promise<string | null> => {
        if (requestPath(options).endsWith('/releases/latest')) {
          return Promise.resolve(
            JSON.stringify([
              {
                tag_name: 'internal-127',
                name: 'internal-127',
                prerelease: true,
                assets: [
                  {
                    name: 'somebrand-mac.yml',
                    url: 'https://api.github.com/repos/example-org/example-repo/releases/assets/prerelease',
                  },
                ],
              },
              {
                tag_name: 'v2.0.0',
                name: 'v2.0.0',
                prerelease: false,
                assets: [
                  {
                    name: 'somebrand-mac.yml',
                    url: 'https://api.github.com/repos/example-org/example-repo/releases/assets/stable',
                  },
                  {
                    name: 'SomeBrand-2.0.0-mac.zip',
                    url: 'https://api.github.com/repos/example-org/example-repo/releases/assets/stable-zip',
                  },
                ],
              },
            ]),
          );
        }
        if (requestPath(options).endsWith('/releases/assets/stable')) {
          return Promise.resolve(
            [
              'version: 2.0.0',
              'files:',
              '  - url: SomeBrand-2.0.0-mac.zip',
              '    sha512: test-checksum',
              '    size: 123',
              'path: SomeBrand-2.0.0-mac.zip',
              'sha512: test-checksum',
              'releaseDate: "2026-05-01T00:00:00.000Z"',
            ].join('\n'),
          );
        }
        throw new Error(`Unexpected request path: ${requestPath(options)}`);
      },
    );
    const provider = createProvider(request);

    const updateInfo = await provider.getLatestVersion();

    expect(updateInfo.version).toBe('2.0.0');
    expect(
      request.mock.calls.some(([options]) =>
        requestPath(options).endsWith('/releases/assets/prerelease'),
      ),
    ).toBe(false);
  });

  it('fails clearly when the release is missing the branded channel file', async () => {
    const request = jest.fn<Promise<string | null>, [RequestOptions]>(
      (): Promise<string | null> =>
        Promise.resolve(
          JSON.stringify({
            name: 'v2.0.0',
            assets: [
              {
                name: 'latest-mac.yml',
                url: 'https://api.github.com/repos/example-org/example-repo/releases/assets/1',
              },
            ],
          }),
        ),
    );
    const provider = createProvider(request);

    await expect(provider.getLatestVersion()).rejects.toThrow(
      'somebrand-mac.yml',
    );
  });
});
