import type {
  McpServerData,
  McpServerDataView,
} from '@canopy/desktop-shared/types/mcp-servers';
import {
  isStoredSecretError,
  type StoredSecretError,
} from '../lib/stored-secrets';
import {
  projectMcpServerData,
  resolveAccountSecretInputs,
  resolveMcpServerInput,
} from '../mcp/server-secret-view';

const SECRETS = ['header-secret', 'env-secret', 'extra-secret', 'token-secret'];

function httpServer(
  overrides: Partial<McpServerData['definition']> = {},
): McpServerData {
  return {
    definition: {
      id: 'server-1',
      name: 'Server',
      description: '',
      type: 'http',
      url: 'https://mcp.example.test/mcp',
      headers: { 'X-Api-Key': 'header-secret' },
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-01T00:00:00.000Z',
      ...overrides,
    },
    configs: [
      {
        id: 'default',
        name: 'Default',
        description: '',
        enabled: true,
        envVars: {},
        extraArgs: [],
        extraHeaders: { 'X-Team': 'extra-secret' },
        authToken: 'token-secret',
        createdAt: '2026-11-01T00:00:00.000Z',
        updatedAt: '2026-11-01T00:00:00.000Z',
      },
    ],
  };
}

function commandServer(): McpServerData {
  return {
    definition: {
      id: 'server-2',
      name: 'Command',
      description: '',
      type: 'command',
      command: 'npx',
      args: ['-y', 'pkg-a'],
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-01T00:00:00.000Z',
    },
    configs: [
      {
        id: 'default',
        name: 'Default',
        description: '',
        enabled: true,
        envVars: { API_KEY: 'env-secret' },
        extraArgs: [],
        extraHeaders: {},
        createdAt: '2026-11-01T00:00:00.000Z',
        updatedAt: '2026-11-01T00:00:00.000Z',
      },
    ],
  };
}

function refusal(action: () => unknown): StoredSecretError['code'] | null {
  try {
    action();
  } catch (error) {
    if (isStoredSecretError(error)) return error.code;
    throw error;
  }
  return null;
}

describe('MCP server stored-secret replies (CAN-4411)', () => {
  it('replies with references for every secret-valued field and keeps the rest', () => {
    const view = projectMcpServerData(httpServer());
    const text = JSON.stringify(view);
    for (const secret of SECRETS) expect(text).not.toContain(secret);
    expect(view.definition.url).toBe('https://mcp.example.test/mcp');
    expect(view.definition.headers?.['X-Api-Key']).toMatchObject({
      kind: 'stored-secret',
    });
    expect(view.configs[0]?.authToken).toMatchObject({ kind: 'stored-secret' });
  });

  it('keeps values a save echoes back, including under a new header name', () => {
    const stored = httpServer();
    const view = projectMcpServerData(stored);
    const header = view.definition.headers?.['X-Api-Key'];
    if (header === undefined) throw new Error('Expected a header');
    const next: McpServerDataView = {
      ...view,
      definition: {
        ...view.definition,
        url: 'https://mcp.example.test/v2',
        headers: { 'X-Renamed': header },
      },
    };
    expect(resolveMcpServerInput('server-1', next, stored)).toEqual({
      definition: {
        ...stored.definition,
        url: 'https://mcp.example.test/v2',
        headers: { 'X-Renamed': 'header-secret' },
      },
      configs: stored.configs,
    });
  });

  it('refuses a kept value once the server URL moves to another origin', () => {
    const stored = httpServer();
    const view = projectMcpServerData(stored);
    expect(
      refusal(() =>
        resolveMcpServerInput(
          'server-1',
          {
            ...view,
            definition: {
              ...view.definition,
              url: 'https://attacker.test/mcp',
            },
          },
          stored,
        ),
      ),
    ).toBe('stored_secret_destination_changed');
    // Typing every secret again is a normal save.
    expect(
      resolveMcpServerInput(
        'server-1',
        {
          definition: {
            ...view.definition,
            url: 'https://attacker.test/mcp',
            headers: { 'X-Api-Key': 'typed' },
          },
          configs: stored.configs.map((config) => ({
            ...config,
            extraHeaders: {},
            authToken: 'typed',
          })),
        },
        stored,
      ).definition.headers,
    ).toEqual({ 'X-Api-Key': 'typed' });
  });

  it('refuses a kept environment value once the command args change', () => {
    const stored = commandServer();
    const view = projectMcpServerData(stored);
    expect(
      refusal(() =>
        resolveMcpServerInput(
          'server-2',
          {
            ...view,
            definition: { ...view.definition, args: ['-y', 'pkg-b'] },
          },
          stored,
        ),
      ),
    ).toBe('stored_secret_destination_changed');
    expect(
      refusal(() =>
        resolveMcpServerInput(
          'server-2',
          {
            ...view,
            configs: view.configs.map((config) => ({
              ...config,
              extraArgs: ['--other'],
            })),
          },
          stored,
        ),
      ),
    ).toBe('stored_secret_destination_changed');
  });

  it('refuses a kept OAuth client secret once its token endpoint moves', () => {
    const stored = httpServer({
      oauth: {
        clientId: 'client',
        clientSecret: 'client-secret',
        tokenUrl: 'https://auth.example.test/token',
      },
    });
    const view = projectMcpServerData(stored);
    expect(JSON.stringify(view)).not.toContain('client-secret');
    expect(
      resolveMcpServerInput('server-1', view, stored).definition.oauth,
    ).toEqual(stored.definition.oauth);
    expect(
      refusal(() =>
        resolveMcpServerInput(
          'server-1',
          {
            ...view,
            definition: {
              ...view.definition,
              oauth: {
                ...view.definition.oauth,
                tokenUrl: 'https://attacker.test/token',
              },
            },
          },
          stored,
        ),
      ),
    ).toBe('stored_secret_destination_changed');
  });

  it('refuses references from another server or with no stored server', () => {
    const stored = httpServer();
    const view = projectMcpServerData(stored);
    expect(
      refusal(() =>
        resolveMcpServerInput('server-9', view, {
          ...stored,
          definition: { ...stored.definition, id: 'server-9' },
        }),
      ),
    ).toBe('stored_secret_unknown');
    expect(
      refusal(() => resolveMcpServerInput('server-1', view, undefined)),
    ).toBe('stored_secret_unknown');
  });

  it('sends kept headers and tokens to the cloud only for the server URL origin', () => {
    const stored = httpServer();
    const view = projectMcpServerData(stored);
    const request = {
      customUrl: 'https://mcp.example.test/mcp',
      configId: 'default',
      headers: view.definition.headers,
      bearerToken: view.configs[0]?.authToken,
      secretSource: { serverId: 'server-1' },
    };
    expect(
      resolveAccountSecretInputs(request, {
        server: stored,
        destinationUrl: request.customUrl,
      }),
    ).toEqual({
      customUrl: 'https://mcp.example.test/mcp',
      configId: 'default',
      headers: { 'X-Api-Key': 'header-secret' },
      bearerToken: 'token-secret',
    });
    expect(
      refusal(() =>
        resolveAccountSecretInputs(
          { ...request, customUrl: 'https://attacker.test' },
          { server: stored, destinationUrl: 'https://attacker.test' },
        ),
      ),
    ).toBe('stored_secret_destination_changed');
  });
});
