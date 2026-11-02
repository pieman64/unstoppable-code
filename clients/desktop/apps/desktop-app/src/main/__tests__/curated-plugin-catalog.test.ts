import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

let mockCatalogPath = '';
const mockCloudRequest = jest.fn<Promise<unknown>, unknown[]>();

jest.mock('../lib/paths', () => ({
  getCuratedPluginsCatalogFilePath: (): string => mockCatalogPath,
}));
jest.mock('../canopy-cloud/client', () => ({
  get requestCanopyCloudJson(): typeof mockCloudRequest {
    return mockCloudRequest;
  },
}));

import {
  CURATED_PLUGIN_CATALOG_MAX_AGE_MS,
  fetchCuratedPluginContent,
  fetchCuratedPluginsForSync,
  listCuratedPlugins,
  normalizeCuratedPluginCatalogResponse,
} from '../plugins/curated-plugin-catalog';

interface CatalogTestResponse extends Record<string, unknown> {
  version: number;
  plugins: unknown[];
}

function pluginEntry(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    key: ' review-buddy ',
    name: ' Review Buddy ',
    shortDescription: ' Reviews your PRs ',
    longDescription: 'A longer description.',
    logoUrl: 'https://example.test/logo.png',
    version: '1.0.0',
    authorName: 'Canopy',
    authorUrl: 'https://example.test',
    docsUrl: 'https://example.test/docs',
    categories: ['productivity'],
    popular: true,
    recommended: true,
    sortOrder: 1,
    contentHash: 'sha256:plugin',
    mcpServers: ['github'],
    skills: [
      {
        key: ' pr-review ',
        name: ' PR Review ',
        contentHash: 'sha256:skill',
        files: [
          { path: 'SKILL.md', sha256: 'sha256:file', size: 42 },
          {
            path: 'references/api.md',
            sha256: 'sha256:file2',
            size: 10,
          },
        ],
      },
    ],
    updatedAt: '2026-07-14T00:00:00.000Z',
    ...overrides,
  };
}

function response(
  overrides: Record<string, unknown> = {},
): CatalogTestResponse {
  return {
    version: 1,
    plugins: [pluginEntry()],
    ...overrides,
  };
}

describe('curated plugin catalog cache', () => {
  let tempDir = '';

  beforeEach(async () => {
    jest.clearAllMocks();
    tempDir = await mkdtemp(join(tmpdir(), 'curated-plugin-catalog-'));
    mockCatalogPath = join(tempDir, 'curated-plugins', 'catalog.json');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('normalizeCuratedPluginCatalogResponse', () => {
    it('normalizes valid responses, trimming and deep-copying fields', () => {
      // Capture the exact input array references (not a fresh pluginEntry()
      // call, which would produce new arrays regardless of whether the
      // implementation copies) so the not.toBe assertions below actually
      // regress-test the copy behavior.
      const entry = pluginEntry();
      const originalCategories = entry.categories;
      const originalMcpServers = entry.mcpServers;

      const normalized = normalizeCuratedPluginCatalogResponse(
        response({ plugins: [entry] }),
      );
      expect(normalized?.plugins[0]).toMatchObject({
        key: 'review-buddy',
        name: 'Review Buddy',
        shortDescription: 'Reviews your PRs',
      });
      expect(normalized?.plugins[0]?.categories).toEqual(['productivity']);
      expect(normalized?.plugins[0]?.recommended).toBe(true);
      expect(normalized?.plugins[0]?.categories).not.toBe(originalCategories);
      expect(normalized?.plugins[0]?.mcpServers).toEqual(['github']);
      expect(normalized?.plugins[0]?.mcpServers).not.toBe(originalMcpServers);
      expect(normalized?.plugins[0]?.skills[0]).toMatchObject({
        key: 'pr-review',
        name: 'PR Review',
      });
      expect(normalized?.plugins[0]?.skills[0]?.files).toHaveLength(2);
    });

    it('rejects a mismatched API version', () => {
      expect(
        normalizeCuratedPluginCatalogResponse({ version: 2, plugins: [] }),
      ).toBeNull();
    });

    it('rejects malformed entries at the guard level', () => {
      expect(
        normalizeCuratedPluginCatalogResponse({
          version: 1,
          plugins: 'bad',
        }),
      ).toBeNull();
    });

    it('rejects a non-object payload', () => {
      expect(normalizeCuratedPluginCatalogResponse('nope')).toBeNull();
      expect(normalizeCuratedPluginCatalogResponse(null)).toBeNull();
      expect(normalizeCuratedPluginCatalogResponse(undefined)).toBeNull();
    });

    it('rejects the whole response when a plugin key/name is empty after trimming', () => {
      const normalized = normalizeCuratedPluginCatalogResponse(
        response({
          plugins: [
            pluginEntry({ key: '   ', name: 'Has A Name' }),
            pluginEntry({ key: 'has-a-key', name: '   ' }),
            pluginEntry(),
          ],
        }),
      );
      expect(normalized).toBeNull();
    });

    it('rejects the whole response when a skill key is empty after trimming', () => {
      const normalized = normalizeCuratedPluginCatalogResponse(
        response({
          plugins: [
            pluginEntry({
              skills: [
                {
                  key: '   ',
                  name: 'Nameless',
                  contentHash: 'sha256:skill',
                  files: [{ path: 'SKILL.md', sha256: 'x', size: 1 }],
                },
              ],
            }),
          ],
        }),
      );
      expect(normalized).toBeNull();
    });

    it('rejects the whole response when a file path fails isCuratedSkillFilePath (guard-level rejection)', () => {
      // isCuratedSkillFileManifestEntry already enforces isCuratedSkillFilePath
      // structurally, so a bad path fails isCuratedPluginListResponse's
      // Array.every() before normalizeCuratedPluginCatalogResponse's own
      // per-file isCuratedSkillFilePath check (defense-in-depth) ever runs.
      const normalized = normalizeCuratedPluginCatalogResponse(
        response({
          plugins: [
            pluginEntry({
              skills: [
                {
                  key: 'pr-review',
                  name: 'PR Review',
                  contentHash: 'sha256:skill',
                  files: [
                    { path: 'SKILL.md', sha256: 'x', size: 1 },
                    { path: '../escape.md', sha256: 'y', size: 2 },
                  ],
                },
              ],
            }),
          ],
        }),
      );
      expect(normalized).toBeNull();
    });
  });

  describe('listCuratedPlugins', () => {
    it('serves a fresh normalized cache without a cloud request', async () => {
      await mkdir(dirname(mockCatalogPath), { recursive: true });
      await writeFile(
        mockCatalogPath,
        JSON.stringify({
          cacheSchemaVersion: 1,
          apiVersion: 1,
          fetchedAt: '2026-07-14T12:00:00.000Z',
          plugins: response().plugins,
        }),
        'utf8',
      );
      const result = await listCuratedPlugins(
        new Date(1725 + Date.parse('2026-07-14T12:00:00.000Z')),
      );
      expect(result.plugins[0]?.key).toBe('review-buddy');
      expect(mockCloudRequest).not.toHaveBeenCalled();
    });

    it('refreshes stale caches and persists the normalized response', async () => {
      await mkdir(dirname(mockCatalogPath), { recursive: true });
      const now = new Date('2026-07-14T12:00:00.000Z');
      await writeFile(
        mockCatalogPath,
        JSON.stringify({
          cacheSchemaVersion: 1,
          apiVersion: 1,
          fetchedAt: new Date(
            now.getTime() - CURATED_PLUGIN_CATALOG_MAX_AGE_MS - 1,
          ).toISOString(),
          plugins: [],
        }),
        'utf8',
      );
      mockCloudRequest.mockResolvedValue(response());

      const result = await listCuratedPlugins(now);
      expect(result.plugins[0]?.key).toBe('review-buddy');
      expect(mockCloudRequest).toHaveBeenCalledWith(
        expect.stringContaining('/plugins/curated'),
      );
      const cache: unknown = JSON.parse(
        await readFile(mockCatalogPath, 'utf8'),
      );
      expect(
        typeof cache === 'object' &&
          cache !== null &&
          'fetchedAt' in cache &&
          cache.fetchedAt,
      ).toBe(now.toISOString());
    });

    it('returns an empty catalog (not the stale cache) when refresh fails', async () => {
      const now = new Date('2026-07-14T12:00:00.000Z');
      await mkdir(dirname(mockCatalogPath), { recursive: true });
      await writeFile(
        mockCatalogPath,
        JSON.stringify({
          cacheSchemaVersion: 1,
          apiVersion: 1,
          fetchedAt: new Date(
            now.getTime() - CURATED_PLUGIN_CATALOG_MAX_AGE_MS - 1,
          ).toISOString(),
          plugins: response().plugins,
        }),
        'utf8',
      );
      mockCloudRequest.mockRejectedValue(new Error('network unavailable'));

      await expect(listCuratedPlugins(now)).resolves.toEqual({
        version: 1,
        plugins: [],
      });
    });

    it('treats a corrupt cache file as absent and fetches instead', async () => {
      await mkdir(dirname(mockCatalogPath), { recursive: true });
      await writeFile(mockCatalogPath, '{corrupt', 'utf8');
      mockCloudRequest.mockResolvedValue(response());

      const result = await listCuratedPlugins(
        new Date('2026-07-14T12:00:00.000Z'),
      );
      expect(result.plugins[0]?.key).toBe('review-buddy');
      expect(mockCloudRequest).toHaveBeenCalled();
    });
  });

  describe('fetchCuratedPluginsForSync', () => {
    it('always fetches live (ignores a fresh cache) and writes it', async () => {
      await mkdir(dirname(mockCatalogPath), { recursive: true });
      const now = new Date('2026-07-14T12:00:00.000Z');
      await writeFile(
        mockCatalogPath,
        JSON.stringify({
          cacheSchemaVersion: 1,
          apiVersion: 1,
          fetchedAt: now.toISOString(),
          plugins: [],
        }),
        'utf8',
      );
      mockCloudRequest.mockResolvedValue(response());

      const result = await fetchCuratedPluginsForSync(now);
      expect(mockCloudRequest).toHaveBeenCalledWith(
        expect.stringContaining('/plugins/curated'),
      );
      expect(result?.plugins[0]?.key).toBe('review-buddy');
      const cache: unknown = JSON.parse(
        await readFile(mockCatalogPath, 'utf8'),
      );
      expect(
        typeof cache === 'object' &&
          cache !== null &&
          'plugins' in cache &&
          Array.isArray(cache.plugins) &&
          cache.plugins.length,
      ).toBe(1);
    });

    it('returns null and leaves the cache untouched on a network error', async () => {
      await mkdir(dirname(mockCatalogPath), { recursive: true });
      const existing = {
        cacheSchemaVersion: 1,
        apiVersion: 1,
        fetchedAt: '2026-07-14T12:00:00.000Z',
        plugins: response().plugins,
      };
      await writeFile(mockCatalogPath, JSON.stringify(existing), 'utf8');
      mockCloudRequest.mockRejectedValue(new Error('network unavailable'));

      const result = await fetchCuratedPluginsForSync(
        new Date('2026-07-14T13:00:00.000Z'),
      );
      expect(result).toBeNull();
      const cache: unknown = JSON.parse(
        await readFile(mockCatalogPath, 'utf8'),
      );
      expect(cache).toEqual(existing);
    });

    it('validates cache schema and API versions independently', async () => {
      await mkdir(dirname(mockCatalogPath), { recursive: true });
      await writeFile(
        mockCatalogPath,
        JSON.stringify({
          cacheSchemaVersion: 1,
          apiVersion: 2,
          fetchedAt: '2026-07-14T12:00:00.000Z',
          plugins: response().plugins,
        }),
        'utf8',
      );
      mockCloudRequest.mockResolvedValue(response());

      await listCuratedPlugins(new Date('2026-07-14T12:00:01.000Z'));

      expect(mockCloudRequest).toHaveBeenCalled();
    });

    it('returns null when the payload fails the guard', async () => {
      mockCloudRequest.mockResolvedValue({ version: 1, plugins: 'bad' });
      await expect(fetchCuratedPluginsForSync()).resolves.toBeNull();
    });

    it('returns null on an API version mismatch', async () => {
      mockCloudRequest.mockResolvedValue(response({ version: 2 }));
      await expect(fetchCuratedPluginsForSync()).resolves.toBeNull();
    });
  });

  describe('fetchCuratedPluginContent', () => {
    it('returns the payload on success', async () => {
      const content = {
        version: 1,
        key: 'review-buddy',
        contentHash: 'sha256:plugin',
        skills: [
          {
            key: 'pr-review',
            contentHash: 'sha256:skill',
            files: [
              {
                path: 'SKILL.md',
                sha256: 'sha256:file',
                size: 42,
                content: '# PR Review',
              },
            ],
          },
        ],
      };
      mockCloudRequest.mockResolvedValue(content);
      await expect(fetchCuratedPluginContent('review-buddy')).resolves.toEqual(
        content,
      );
      expect(mockCloudRequest).toHaveBeenCalledWith(
        expect.stringContaining('/plugins/curated/review-buddy/content'),
      );
    });

    it('returns null when the payload fails the guard', async () => {
      mockCloudRequest.mockResolvedValue({ version: 1, key: 'x' });
      await expect(
        fetchCuratedPluginContent('review-buddy'),
      ).resolves.toBeNull();
    });

    it('returns null on a network error', async () => {
      mockCloudRequest.mockRejectedValue(new Error('offline'));
      await expect(
        fetchCuratedPluginContent('review-buddy'),
      ).resolves.toBeNull();
    });

    it('URL-encodes the plugin key', async () => {
      mockCloudRequest.mockResolvedValue({
        version: 1,
        key: 'a/b',
        contentHash: 'sha256:plugin',
        skills: [],
      });
      await fetchCuratedPluginContent('a/b');
      expect(mockCloudRequest).toHaveBeenCalledWith(
        expect.stringContaining('/plugins/curated/a%2Fb/content'),
      );
    });
  });
});

it('preserves Try it prompts while normalizing a cached catalog response', () => {
  const result = normalizeCuratedPluginCatalogResponse(
    response({
      plugins: [pluginEntry({ tryNowPrompt: 'Review this change.' })],
    }),
  );
  expect(result?.plugins[0]).toHaveProperty(
    'tryNowPrompt',
    'Review this change.',
  );
  expect(result?.plugins[0].contentHash).toBe('sha256:plugin');
});
