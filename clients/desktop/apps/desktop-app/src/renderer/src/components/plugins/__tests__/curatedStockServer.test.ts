/**
 * @jest-environment jsdom
 */
import type { CuratedMcpServerEntry } from '@canopy/protocol/mcp-catalog';
import type { McpServerDataView } from '@canopy/desktop-shared/types/mcp-servers';
import {
  matchesStockCuratedServer,
  stockCuratedServerData,
} from '../curatedStockServer';

const granola: CuratedMcpServerEntry = {
  key: 'granola',
  name: 'Granola',
  shortDescription: 'Meeting notes',
  url: 'https://mcp.granola.example/mcp',
  transport: 'http',
  categories: [],
  popular: false,
  sortOrder: 0,
  updatedAt: '2026-10-01T00:00:00.000Z',
  oauthHints: { scopes: ['read'], usePkce: true },
};

function stock(entry: CuratedMcpServerEntry = granola): McpServerDataView {
  const result = stockCuratedServerData(entry, {
    now: '2026-09-01T00:00:00.000Z',
    configId: 'granola-config',
  });
  if ('error' in result) throw new Error(result.error);
  return {
    ...result.server,
    definition: { ...result.server.definition, id: 'granola-device' },
  };
}

describe('matchesStockCuratedServer (REG-3052)', () => {
  it('matches the server Add creates, whatever its ids, timestamps, and display text', () => {
    const server = stock();
    expect(matchesStockCuratedServer(granola, server)).toBe(true);
    const [config] = server.configs;
    if (!config) throw new Error('Missing configuration');
    expect(
      matchesStockCuratedServer(granola, {
        definition: {
          ...server.definition,
          id: 'other-id',
          name: 'My Granola',
          description: 'Renamed',
          url: 'https://MCP.granola.example/mcp/',
          createdAt: '2025-01-01T00:00:00.000Z',
          updatedAt: '2026-10-05T00:00:00.000Z',
          curated: { key: 'granola', logoUrl: 'https://cdn.example/old.png' },
        },
        configs: [
          { ...config, id: 'other-config', name: 'Personal', updatedAt: '' },
        ],
      }),
    ).toBe(true);
  });

  it.each<[string, (server: McpServerDataView) => McpServerDataView]>([
    [
      'a custom OAuth client id on the default endpoint',
      (server: McpServerDataView): McpServerDataView => ({
        ...server,
        definition: {
          ...server.definition,
          oauth: { ...server.definition.oauth, clientId: 'my-own-app' },
        },
      }),
    ],
    [
      'no explicit sign-in handler, so it inherits one',
      (server: McpServerDataView): McpServerDataView => ({
        ...server,
        definition: { ...server.definition, httpAuthHandler: undefined },
      }),
    ],
    [
      'the provider sign-in handler',
      (server: McpServerDataView): McpServerDataView => ({
        ...server,
        definition: { ...server.definition, httpAuthHandler: 'provider' },
      }),
    ],
    [
      'credentials in the endpoint URL',
      (server: McpServerDataView): McpServerDataView => ({
        ...server,
        definition: {
          ...server.definition,
          url: (server.definition.url ?? '').replace(
            'https://',
            'https://me:secret@',
          ),
        },
      }),
    ],
    [
      'custom OAuth scopes',
      (server: McpServerDataView): McpServerDataView => ({
        ...server,
        definition: {
          ...server.definition,
          oauth: { ...server.definition.oauth, scopes: ['read', 'write'] },
        },
      }),
    ],
    [
      'a custom OAuth audience',
      (server: McpServerDataView): McpServerDataView => ({
        ...server,
        definition: {
          ...server.definition,
          oauth: { ...server.definition.oauth, audience: 'internal' },
        },
      }),
    ],
    [
      'a custom endpoint',
      (server: McpServerDataView): McpServerDataView => ({
        ...server,
        definition: {
          ...server.definition,
          url: 'https://granola.internal/mcp',
        },
      }),
    ],
    [
      'server headers',
      (server: McpServerDataView): McpServerDataView => ({
        ...server,
        definition: { ...server.definition, headers: { 'X-Team': 'eng' } },
      }),
    ],
    [
      'configuration headers',
      (server: McpServerDataView): McpServerDataView => ({
        ...server,
        configs: server.configs.map((config) => ({
          ...config,
          extraHeaders: { 'X-Team': 'eng' },
        })),
      }),
    ],
    [
      'a stored access token',
      (server: McpServerDataView): McpServerDataView => ({
        ...server,
        configs: server.configs.map((config) => ({
          ...config,
          authToken: 'token',
        })),
      }),
    ],
    [
      'a disabled configuration',
      (server: McpServerDataView): McpServerDataView => ({
        ...server,
        configs: server.configs.map((config) => ({
          ...config,
          enabled: false,
        })),
      }),
    ],
    [
      'a definition field Add never writes',
      (server: McpServerDataView): McpServerDataView => ({
        ...server,
        definition: Object.assign({}, server.definition, {
          proxyOverride: 'http://127.0.0.1:9000',
        }),
      }),
    ],
    [
      'a configuration field Add never writes',
      (server: McpServerDataView): McpServerDataView => ({
        ...server,
        configs: server.configs.map((config) =>
          Object.assign({}, config, { region: 'eu' }),
        ),
      }),
    ],
  ])('does not match a server with %s', (_label, customize) => {
    expect(matchesStockCuratedServer(granola, customize(stock()))).toBe(false);
  });

  it('does not match a server for another catalog key', () => {
    const server = stock();
    expect(
      matchesStockCuratedServer(granola, {
        ...server,
        definition: { ...server.definition, curated: { key: 'notion' } },
      }),
    ).toBe(false);
  });
});
