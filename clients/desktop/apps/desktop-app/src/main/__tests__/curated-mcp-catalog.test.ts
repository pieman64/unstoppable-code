import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type * as CanopyCloudClient from '../canopy-cloud/client';

let mockCatalogPath = '';
const mockCloudRequest = jest.fn<Promise<unknown>, unknown[]>();
const mockPublicRequest = jest.fn<Promise<unknown>, unknown[]>();

jest.mock('../lib/paths', () => ({
  getCuratedMcpCatalogFilePath: (): string => mockCatalogPath,
}));
jest.mock('../canopy-cloud/client', () => ({
  ...jest.requireActual<typeof CanopyCloudClient>('../canopy-cloud/client'),
  requestCanopyCloudJson: mockCloudRequest,
  requestCanopyCloudPublicJson: mockPublicRequest,
}));

import { CanopyCloudClientError } from '../canopy-cloud/client';

import {
  CURATED_CATALOG_MAX_AGE_MS,
  listCuratedMcpServers,
  normalizeCuratedCatalogResponse,
  readCachedCuratedMcpDesktopOnlyKeys,
  readCachedCuratedMcpServers,
  refreshCuratedMcpServers,
  resolveCuratedMcpCatalogForSync,
} from '../mcp/curated-catalog';

interface CatalogTestResponse extends Record<string, unknown> {
  version: number;
  servers: unknown[];
}

function response(
  overrides: Record<string, unknown> = {},
): CatalogTestResponse {
  return {
    version: 1,
    servers: [
      {
        key: ' github ',
        name: ' GitHub ',
        shortDescription: ' Source control ',
        url: 'https://mcp.example.test',
        transport: 'http',
        oauthHints: {
          usePkce: true,
          callbackPort: 3118,
          clientSecret: 'must-not-survive',
        },
        requiredConfigFields: [{ kind: 'oauth-client-id' }],
        urlOptions: [{ url: 'https://eu.example.test/mcp', label: 'Europe' }],
        setupInstructions: 'Choose the account region.',
        categories: ['development'],
        popular: true,
        sortOrder: 1,
        updatedAt: '2026-07-14T00:00:00.000Z',
      },
    ],
    ...overrides,
  };
}

describe('curated MCP catalog cache', () => {
  let tempDir = '';

  beforeEach(async () => {
    jest.resetAllMocks();
    tempDir = await mkdtemp(join(tmpdir(), 'curated-mcp-catalog-'));
    mockCatalogPath = join(tempDir, 'mcp-servers', 'curated-catalog.json');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('reads a missing or stale recommendation cache without fetching', async () => {
    expect(await readCachedCuratedMcpServers()).toBeNull();
    expect(mockCloudRequest).not.toHaveBeenCalled();
    await mkdir(dirname(mockCatalogPath), { recursive: true });
    await writeFile(
      mockCatalogPath,
      JSON.stringify({
        ...normalizeCuratedCatalogResponse(response()),
        fetchedAt: '2020-01-01T00:00:00Z',
      }),
    );
    expect(await readCachedCuratedMcpServers()).toMatchObject({
      servers: [{ key: 'github' }],
    });
    expect(mockCloudRequest).not.toHaveBeenCalled();
  });

  it('preserves providerConnector so a hub-ticked connector reaches the UI', () => {
    // `normalizeServer` rebuilds each entry field by field, so a field it does
    // not name is dropped silently. `providerConnector` is set in the hub and
    // is the only source of which connectors are advertised — dropping it here
    // makes the hub setting a no-op with nothing to see in any log.
    const normalized = normalizeCuratedCatalogResponse(
      response({
        servers: [
          {
            key: 'gmail-gmailmcp',
            name: 'Gmail',
            shortDescription: 'Read and send mail',
            url: 'https://gmailmcp.googleapis.com/mcp/v1',
            transport: 'http',
            categories: ['productivity'],
            popular: false,
            sortOrder: 0,
            updatedAt: '2026-08-27T00:00:00.000Z',
            providerConnector: {
              providers: ['claude', 'codex'],
              claudeConnectorName: 'Gmail',
            },
          },
        ],
      }),
    );
    expect(normalized?.servers[0]?.providerConnector).toEqual({
      providers: ['claude', 'codex'],
      claudeConnectorName: 'Gmail',
    });
  });

  it('preserves availability so a desktop-only server keeps its add route (REG-3035)', () => {
    const server = {
      key: 'canva',
      name: 'Canva',
      shortDescription: 'Design with Canva',
      url: 'https://mcp.canva.com/mcp',
      transport: 'http',
      categories: ['design'],
      popular: false,
      sortOrder: 0,
      updatedAt: '2026-10-02T00:00:00.000Z',
    };
    const normalized = normalizeCuratedCatalogResponse(
      response({
        servers: [
          { ...server, availability: 'desktop' },
          { ...server, key: 'canva-everywhere' },
        ],
      }),
    );
    expect(normalized?.servers[0]?.availability).toBe('desktop');
    expect(normalized?.servers[1]).not.toHaveProperty('availability');
  });

  it('reads desktop-only keys from a cache of any age without a cloud request (REG-3035)', async () => {
    const server = {
      key: 'github',
      name: 'GitHub',
      shortDescription: 'Source control',
      url: 'https://mcp.example.test',
      transport: 'http',
      oauthHints: { usePkce: true },
      categories: [],
      popular: false,
      sortOrder: 0,
      updatedAt: '2020-01-01T00:00:00.000Z',
    };
    await expect(readCachedCuratedMcpDesktopOnlyKeys()).resolves.toEqual(
      new Set(),
    );
    await mkdir(dirname(mockCatalogPath), { recursive: true });
    await writeFile(
      mockCatalogPath,
      JSON.stringify({
        version: 1,
        fetchedAt: '2020-01-01T00:00:00.000Z',
        servers: [
          { ...server, key: 'canva', availability: 'desktop' },
          {
            ...server,
            key: 'gmail',
            oauthHints: undefined,
            providerConnector: { providers: ['claude'] },
          },
          server,
        ],
      }),
      'utf8',
    );
    await expect(readCachedCuratedMcpDesktopOnlyKeys()).resolves.toEqual(
      new Set(['canva', 'gmail']),
    );
    expect(mockCloudRequest).not.toHaveBeenCalled();
  });

  it('normalizes valid responses and keeps OAuth hints secret-free', () => {
    const normalized = normalizeCuratedCatalogResponse(response());
    expect(normalized?.servers[0]).toMatchObject({
      key: 'github',
      name: 'GitHub',
      shortDescription: 'Source control',
      oauthHints: { usePkce: true, callbackPort: 3118 },
      requiredConfigFields: [{ kind: 'oauth-client-id' }],
      setupInstructions: 'Choose the account region.',
    });
    expect(normalized?.servers[0].oauthHints).not.toHaveProperty(
      'clientSecret',
    );
    expect(
      normalizeCuratedCatalogResponse({ version: 2, servers: [] }),
    ).toBeNull();
    expect(
      normalizeCuratedCatalogResponse({ version: 1, servers: 'bad' }),
    ).toBeNull();
  });

  it('serves a fresh normalized cache without a cloud request', async () => {
    await mkdir(dirname(mockCatalogPath), { recursive: true });
    await writeFile(
      mockCatalogPath,
      JSON.stringify({
        version: 1,
        fetchedAt: '2026-07-14T12:00:00.000Z',
        servers: response().servers,
      }),
      'utf8',
    );
    const result = await listCuratedMcpServers(
      new Date(1725 + Date.parse('2026-07-14T12:00:00.000Z')),
    );
    expect(result.servers[0]?.key).toBe('github');
    expect(mockCloudRequest).not.toHaveBeenCalled();
  });

  it('refreshes stale caches and persists the normalized response', async () => {
    await mkdir(dirname(mockCatalogPath), { recursive: true });
    const now = new Date('2026-07-14T12:00:00.000Z');
    await writeFile(
      mockCatalogPath,
      JSON.stringify({
        version: 1,
        fetchedAt: new Date(
          now.getTime() - CURATED_CATALOG_MAX_AGE_MS - 1,
        ).toISOString(),
        servers: [],
      }),
      'utf8',
    );
    mockCloudRequest.mockResolvedValue(response());

    const result = await listCuratedMcpServers(now);
    expect(result.servers[0]?.key).toBe('github');
    expect(mockCloudRequest).toHaveBeenCalledWith(
      expect.stringContaining('/mcp-servers/curated'),
    );
    const cache: unknown = JSON.parse(await readFile(mockCatalogPath, 'utf8'));
    expect(
      typeof cache === 'object' &&
        cache !== null &&
        'fetchedAt' in cache &&
        cache.fetchedAt,
    ).toBe(now.toISOString());
  });

  it('silently returns empty on corrupt/auth/network failure', async () => {
    mockCloudRequest.mockRejectedValue(new Error('missing api key'));
    await writeFile(mockCatalogPath, '{corrupt', 'utf8').catch(async () => {
      await mkdir(dirname(mockCatalogPath), { recursive: true });
      await writeFile(mockCatalogPath, '{corrupt', 'utf8');
    });
    await expect(refreshCuratedMcpServers()).resolves.toEqual({
      version: 1,
      servers: [],
    });
  });

  it('displays an expired cache when its refresh fails', async () => {
    const now = new Date('2026-07-14T12:00:00.000Z');
    await mkdir(dirname(mockCatalogPath), { recursive: true });
    await writeFile(
      mockCatalogPath,
      JSON.stringify({
        version: 1,
        fetchedAt: new Date(
          now.getTime() - CURATED_CATALOG_MAX_AGE_MS - 1,
        ).toISOString(),
        servers: response().servers,
      }),
      'utf8',
    );
    mockCloudRequest.mockRejectedValue(new Error('network unavailable'));

    await expect(listCuratedMcpServers(now)).resolves.toEqual(
      normalizeCuratedCatalogResponse(response()),
    );
  });

  it('uses anonymous transport only when the API key is missing', async () => {
    mockCloudRequest.mockRejectedValue(
      new CanopyCloudClientError('missing-api-key', 'Signed out'),
    );
    mockPublicRequest.mockResolvedValue(response());
    await expect(refreshCuratedMcpServers()).resolves.toEqual(
      normalizeCuratedCatalogResponse(response()),
    );
    expect(mockCloudRequest).toHaveBeenCalledTimes(1);
    expect(mockPublicRequest).toHaveBeenCalledWith(
      '/api/v1/mcp-servers/curated',
    );
    expect(mockCloudRequest.mock.invocationCallOrder[0]).toBeLessThan(
      mockPublicRequest.mock.invocationCallOrder[0],
    );
    const cached: unknown = JSON.parse(await readFile(mockCatalogPath, 'utf8'));
    expect(cached).toMatchObject({ servers: [{ key: 'github' }] });
  });

  it.each([
    'http-error',
    'network-error',
    'invalid-response',
    'cloud-not-configured',
  ] as const)('does not fall back publicly on %s', async (code) => {
    mockCloudRequest.mockRejectedValue(
      new CanopyCloudClientError(code, 'Unavailable', 401),
    );
    await expect(refreshCuratedMcpServers()).resolves.toEqual({
      version: 1,
      servers: [],
    });
    expect(mockPublicRequest).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'retains stale data and freshness metadata after failed refresh (signed out: %s)',
    async (signedOut) => {
      const now = new Date('2026-07-14T12:00:00.000Z');
      mockCloudRequest.mockResolvedValue(response());
      await refreshCuratedMcpServers(
        new Date(now.getTime() - CURATED_CATALOG_MAX_AGE_MS - 1),
      );
      const original = await readFile(mockCatalogPath, 'utf8');
      mockCloudRequest.mockRejectedValue(
        signedOut
          ? new CanopyCloudClientError('missing-api-key', 'Signed out')
          : new Error('Offline'),
      );
      mockPublicRequest.mockRejectedValue(new Error('Offline'));
      for (const read of [listCuratedMcpServers, refreshCuratedMcpServers]) {
        await expect(read(now)).resolves.toEqual(
          normalizeCuratedCatalogResponse(response()),
        );
        expect(await readFile(mockCatalogPath, 'utf8')).toBe(original);
      }
      await expect(resolveCuratedMcpCatalogForSync(now)).resolves.toEqual({
        status: 'unavailable',
      });
      expect(await readFile(mockCatalogPath, 'utf8')).toBe(original);
    },
  );

  it.each([false, true])(
    'keeps the last valid cache after malformed data (signed out: %s)',
    async (signedOut) => {
      const now = new Date('2026-07-14T12:00:00.000Z');
      mockCloudRequest.mockResolvedValue(response());
      await refreshCuratedMcpServers(
        new Date(now.getTime() - CURATED_CATALOG_MAX_AGE_MS - 1),
      );
      const original = await readFile(mockCatalogPath, 'utf8');
      const malformed = { version: 1, servers: [{ key: 'invalid' }] };
      if (signedOut) {
        mockCloudRequest.mockRejectedValue(
          new CanopyCloudClientError('missing-api-key', 'Signed out'),
        );
        mockPublicRequest.mockResolvedValue(malformed);
      } else mockCloudRequest.mockResolvedValue(malformed);
      await expect(refreshCuratedMcpServers(now)).resolves.toEqual(
        normalizeCuratedCatalogResponse(response()),
      );
      await expect(resolveCuratedMcpCatalogForSync(now)).resolves.toEqual({
        status: 'unavailable',
      });
      expect(await readFile(mockCatalogPath, 'utf8')).toBe(original);
    },
  );

  it('forces a refresh even with a fresh cache, and accepts an empty public catalog', async () => {
    const now = new Date('2026-07-14T12:00:00.000Z');
    mockCloudRequest.mockResolvedValue(response());
    await refreshCuratedMcpServers(now);
    mockCloudRequest.mockRejectedValue(
      new CanopyCloudClientError('missing-api-key', 'Signed out'),
    );
    mockPublicRequest.mockResolvedValue({ version: 1, servers: [] });
    await expect(listCuratedMcpServers(now)).resolves.toEqual(
      normalizeCuratedCatalogResponse(response()),
    );
    expect(mockPublicRequest).not.toHaveBeenCalled();
    const later = new Date(now.getTime() + 1000);
    await expect(refreshCuratedMcpServers(later)).resolves.toEqual({
      version: 1,
      servers: [],
    });
    expect(JSON.parse(await readFile(mockCatalogPath, 'utf8'))).toEqual({
      version: 1,
      servers: [],
      fetchedAt: later.toISOString(),
    });
    await expect(resolveCuratedMcpCatalogForSync(later)).resolves.toEqual({
      status: 'verified',
      catalog: { version: 1, servers: [] },
    });
  });

  it.each([null, '{corrupt'])(
    'returns empty for a missing or corrupt cache after refresh failure: %s',
    async (cached) => {
      if (cached !== null) {
        await mkdir(dirname(mockCatalogPath), { recursive: true });
        await writeFile(mockCatalogPath, cached, 'utf8');
      }
      mockCloudRequest.mockRejectedValue(
        new CanopyCloudClientError('missing-api-key', 'Signed out'),
      );
      mockPublicRequest.mockRejectedValue(new Error('Offline'));
      for (const read of [listCuratedMcpServers, refreshCuratedMcpServers]) {
        await expect(read()).resolves.toEqual({ version: 1, servers: [] });
      }
      await expect(resolveCuratedMcpCatalogForSync()).resolves.toEqual({
        status: 'unavailable',
      });
    },
  );

  it('does not anonymously retry an untyped error with a matching code', async () => {
    mockCloudRequest.mockRejectedValue(
      Object.assign(new Error('Missing'), { code: 'missing-api-key' }),
    );
    await refreshCuratedMcpServers();
    expect(mockPublicRequest).not.toHaveBeenCalled();
  });

  it.each(['key', 'name'])(
    'does not turn a malformed blank %s into an authoritative empty catalog',
    async (field) => {
      const now = new Date('2026-07-14T12:00:00.000Z');
      mockCloudRequest.mockResolvedValue(response());
      await refreshCuratedMcpServers(
        new Date(now.getTime() - CURATED_CATALOG_MAX_AGE_MS - 1),
      );
      const original = await readFile(mockCatalogPath, 'utf8');
      const valid = normalizeCuratedCatalogResponse(response());
      if (!valid) throw new Error('Invalid test fixture');
      const malformed = response({
        servers: valid.servers.map((server) => ({ ...server, [field]: '   ' })),
      });
      mockCloudRequest.mockResolvedValue(malformed);
      await expect(refreshCuratedMcpServers(now)).resolves.toEqual(valid);
      expect(await readFile(mockCatalogPath, 'utf8')).toBe(original);
      await expect(resolveCuratedMcpCatalogForSync(now)).resolves.toEqual({
        status: 'unavailable',
      });
    },
  );

  it('distinguishes a verified empty catalog from an unavailable refresh', async () => {
    mockCloudRequest.mockResolvedValue({ version: 1, servers: [] });
    await expect(resolveCuratedMcpCatalogForSync()).resolves.toEqual({
      status: 'verified',
      catalog: { version: 1, servers: [] },
    });

    mockCloudRequest.mockRejectedValue(new Error('network unavailable'));
    await rm(mockCatalogPath, { force: true });
    await expect(resolveCuratedMcpCatalogForSync()).resolves.toEqual({
      status: 'unavailable',
    });
  });
});

it('preserves optional Try it prompts through MCP cache normalization', () => {
  const input = response();
  input.servers[0] = {
    ...(input.servers[0] as Record<string, unknown>),
    tryNowPrompt: 'Find my issues.',
  };
  expect(normalizeCuratedCatalogResponse(input)?.servers[0]).toHaveProperty(
    'tryNowPrompt',
    'Find my issues.',
  );
  expect(
    normalizeCuratedCatalogResponse(response())?.servers[0],
  ).not.toHaveProperty('tryNowPrompt');
});
