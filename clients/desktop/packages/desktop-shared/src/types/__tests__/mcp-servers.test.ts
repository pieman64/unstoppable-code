import { isMcpServersIndexFile, normalizeMcpServerFile } from '../mcp-servers';

const validServerFile = {
  version: 1,
  server: {
    definition: {
      id: 'server-1',
      name: 'Server',
      description: '',
      type: 'http',
      url: 'https://mcp.example.test',
      createdAt: '2026-07-21T00:00:00.000Z',
      updatedAt: '2026-07-21T00:00:00.000Z',
    },
    configs: [
      {
        id: 'default',
        name: 'Default',
        description: '',
        enabled: true,
        envVars: {},
        extraArgs: [],
        extraHeaders: {},
        createdAt: '2026-07-21T00:00:00.000Z',
        updatedAt: '2026-07-21T00:00:00.000Z',
      },
    ],
  },
};

describe('MCP persisted file validation', () => {
  it('normalizes a fully validated server file', () => {
    expect(normalizeMcpServerFile(validServerFile)).toEqual(validServerFile);
  });

  it('rejects malformed nested server data', () => {
    expect(() =>
      normalizeMcpServerFile({
        ...validServerFile,
        server: {
          ...validServerFile.server,
          configs: [{ id: 'default', enabled: true }],
        },
      }),
    ).toThrow('Invalid MCP server file');
  });

  it('preserves an account handler on a local HTTP definition', (): void => {
    const file = {
      ...validServerFile,
      server: {
        ...validServerFile.server,
        definition: {
          ...validServerFile.server.definition,
          httpAuthHandler: 'account',
        },
      },
    };
    expect(normalizeMcpServerFile(file)).toEqual(file);
  });

  it('reports malformed HTTP auth handling precisely', () => {
    expect(() =>
      normalizeMcpServerFile({
        ...validServerFile,
        server: {
          ...validServerFile.server,
          definition: {
            ...validServerFile.server.definition,
            httpAuthHandler: 'invalid',
          },
        },
      }),
    ).toThrow('HTTP auth handler must be "canopy", "provider", or "account".');
  });

  it('reports malformed curated metadata precisely', () => {
    expect(() =>
      normalizeMcpServerFile({
        ...validServerFile,
        server: {
          ...validServerFile.server,
          definition: {
            ...validServerFile.server.definition,
            curated: 'invalid',
          },
        },
      }),
    ).toThrow('Curated MCP server metadata must be an object.');
  });

  it('validates index entries before narrowing the file type', () => {
    expect(
      isMcpServersIndexFile({
        version: 1,
        servers: [
          {
            id: 'server-1',
            name: 'Server',
            description: '',
            type: 'http',
            configs: [{ id: 'default', name: 'Default', enabled: true }],
            updatedAt: '2026-07-21T00:00:00.000Z',
          },
        ],
      }),
    ).toBe(true);
    expect(
      isMcpServersIndexFile({
        version: 1,
        servers: [{ id: 'server-1', type: 'http' }],
      }),
    ).toBe(false);
  });
});
