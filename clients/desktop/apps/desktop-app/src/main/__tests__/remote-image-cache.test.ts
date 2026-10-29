const mockDnsLookup = jest.fn<
  Promise<Array<{ address: string; family: number }>>,
  unknown[]
>();
const mockPinnedHttpGet = jest.fn<Promise<Response>, unknown[]>();

jest.mock('node:dns/promises', () => ({
  lookup: (
    ...args: unknown[]
  ): Promise<Array<{ address: string; family: number }>> =>
    mockDnsLookup(...args),
}));
jest.mock('../mcp/pinned-http-fetch', () => ({
  fetchPinnedHttpGetResponse: (...args: unknown[]): Promise<Response> =>
    mockPinnedHttpGet(...args),
}));

import {
  MAX_CACHE_ENTRIES,
  resolveRemoteImageDataUrl,
} from '../mcp/remote-image-cache';

describe('remote image cache', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns a raster data URL after validating and pinning DNS', async () => {
    mockDnsLookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
    mockPinnedHttpGet.mockResolvedValue(
      new Response(new Uint8Array([137, 80, 78, 71]), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      }),
    );

    await expect(
      resolveRemoteImageDataUrl('https://cdn.example.test/logo.png'),
    ).resolves.toBe('data:image/png;base64,iVBORw==');
    expect(mockPinnedHttpGet).toHaveBeenCalledWith(
      new URL('https://cdn.example.test/logo.png'),
      [{ address: '8.8.8.8', family: 4 }],
      expect.any(Object),
      expect.any(AbortSignal),
    );
  });

  it.each(['127.0.0.1', '169.254.169.254', '192.168.1.10'])(
    'rejects non-public address %s without fetching',
    async (address) => {
      mockDnsLookup.mockResolvedValue([{ address, family: 4 }]);

      await expect(
        resolveRemoteImageDataUrl(`https://${address}/logo.png`),
      ).resolves.toBeNull();
      expect(mockPinnedHttpGet).not.toHaveBeenCalled();
    },
  );

  it('validates every redirect target before following it', async () => {
    mockDnsLookup
      .mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }])
      .mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }]);
    mockPinnedHttpGet.mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: 'http://127.0.0.1/admin' },
      }),
    );

    await expect(
      resolveRemoteImageDataUrl('https://redirect.example.test/logo.png'),
    ).resolves.toBeNull();
    expect(mockPinnedHttpGet).toHaveBeenCalledTimes(1);
  });

  it('rejects SVG and oversized raster responses', async () => {
    mockDnsLookup.mockResolvedValue([{ address: '8.8.4.4', family: 4 }]);
    mockPinnedHttpGet
      .mockResolvedValueOnce(
        new Response('<svg/>', {
          headers: { 'content-type': 'image/svg+xml' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(new Uint8Array(1024 * 1024 + 1), {
          headers: { 'content-type': 'image/png' },
        }),
      );

    await expect(
      resolveRemoteImageDataUrl('https://cdn.example.test/logo.svg'),
    ).resolves.toBeNull();
    await expect(
      resolveRemoteImageDataUrl('https://cdn.example.test/huge.png'),
    ).resolves.toBeNull();
  });

  describe('eviction', () => {
    /** Serve every URL a valid 1x1 PNG so only cache behaviour is under test. */
    function servePng(): void {
      mockDnsLookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
      mockPinnedHttpGet.mockImplementation(() =>
        Promise.resolve(
          new Response(new Uint8Array([137, 80, 78, 71]), {
            status: 200,
            headers: { 'content-type': 'image/png' },
          }),
        ),
      );
    }

    const url = (index: number): string =>
      `https://cdn.evict.test/logo-${String(index)}.png`;

    it('serves a repeated URL from cache without refetching', async () => {
      servePng();
      await resolveRemoteImageDataUrl('https://cdn.repeat.test/a.png');
      await resolveRemoteImageDataUrl('https://cdn.repeat.test/a.png');

      expect(mockPinnedHttpGet).toHaveBeenCalledTimes(1);
    });

    it('holds the whole marketplace avatar set without evicting', async () => {
      // Per-plugin publisher avatars pushed the working set to ~181 distinct
      // owners; the cap existed for the curated MCP catalog's few dozen.
      servePng();
      for (let index = 0; index < 200; index += 1) {
        await resolveRemoteImageDataUrl(url(index));
      }
      mockPinnedHttpGet.mockClear();

      await resolveRemoteImageDataUrl(url(0));

      expect(MAX_CACHE_ENTRIES).toBeGreaterThanOrEqual(200);
      expect(mockPinnedHttpGet).not.toHaveBeenCalled();
    });

    it('evicts the least recently USED entry, not the oldest inserted', async () => {
      servePng();
      for (let index = 0; index < MAX_CACHE_ENTRIES; index += 1) {
        await resolveRemoteImageDataUrl(url(index));
      }
      // Touch the oldest-inserted entry so it becomes the most recently used.
      await resolveRemoteImageDataUrl(url(0));
      // Overflow by one: under FIFO this drops url(0) despite the fresh hit.
      await resolveRemoteImageDataUrl(url(MAX_CACHE_ENTRIES));
      mockPinnedHttpGet.mockClear();

      await resolveRemoteImageDataUrl(url(0));
      expect(mockPinnedHttpGet).not.toHaveBeenCalled();

      await resolveRemoteImageDataUrl(url(1));
      expect(mockPinnedHttpGet).toHaveBeenCalledTimes(1);
    });
  });
});
