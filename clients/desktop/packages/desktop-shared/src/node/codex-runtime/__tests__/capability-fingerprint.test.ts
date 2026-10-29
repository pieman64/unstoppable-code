import {
  createCodexCapabilitySnapshotId,
  normalizeCapabilityConfigForFingerprint,
} from '../capability-fingerprint';

describe('normalizeCapabilityConfigForFingerprint', () => {
  it('ignores process-local stdio route ids but preserves the capability digest', () => {
    const capabilityId = 'a'.repeat(64);
    const config = (routeId: string): Record<string, unknown> => ({
      mcp_servers: {
        github: {
          command: '/opt/canopy',
          args: ['__codex-mcp-stdio-launcher', capabilityId, routeId],
        },
      },
    });

    expect(
      normalizeCapabilityConfigForFingerprint(
        config(
          '0123456789abcdef0123456789abcdef.0123456789abcdef0123456789abcdef0123456789abcdef',
        ),
      ),
    ).toEqual(
      normalizeCapabilityConfigForFingerprint(
        config(
          'fedcba9876543210fedcba9876543210.fedcba9876543210fedcba9876543210fedcba9876543210',
        ),
      ),
    );
    expect(
      JSON.stringify(normalizeCapabilityConfigForFingerprint(config('raw'))),
    ).toContain(capabilityId);
  });

  it('ignores process-local HTTP proxy ports and route ids', () => {
    const config = (url: string): Record<string, unknown> => ({
      mcp_servers: {
        github: { type: 'http', url },
      },
    });

    expect(
      normalizeCapabilityConfigForFingerprint(
        config('http://127.0.0.1:43111/canopy/mcp/proxy/random-route-a'),
        ['github:authority'],
      ),
    ).toEqual(
      normalizeCapabilityConfigForFingerprint(
        config('http://127.0.0.1:49876/canopy/mcp/proxy/random-route-b'),
        ['github:authority'],
      ),
    );
    expect(
      normalizeCapabilityConfigForFingerprint({
        url: 'https://mcp.example.com/mcp/proxy/stable',
      }),
    ).toEqual({ url: 'https://mcp.example.com/mcp/proxy/stable' });
  });

  it('preserves directly configured loopback MCP URLs without parent authority', () => {
    expect(
      normalizeCapabilityConfigForFingerprint({
        url: 'http://127.0.0.1:43111/mcp/local-a',
      }),
    ).not.toEqual(
      normalizeCapabilityConfigForFingerprint({
        url: 'http://127.0.0.1:43112/mcp/local-b',
      }),
    );
  });

  it('normalizes only the loopback route with matching parent authority', () => {
    const normalized = normalizeCapabilityConfigForFingerprint(
      {
        proxied: {
          type: 'http',
          url: 'http://127.0.0.1:43111/mcp/proxied-route',
        },
        direct: {
          type: 'http',
          url: 'http://127.0.0.1:43112/mcp/direct-route',
        },
      },
      ['proxied:authority-digest'],
    );

    expect(normalized).toEqual({
      direct: {
        type: 'http',
        url: 'http://127.0.0.1:43112/mcp/direct-route',
      },
      proxied: { type: 'http', url: '<parent-http-route>' },
    });
  });

  it('distinguishes parent-proxied HTTP authorities without retaining secrets', () => {
    const common = {
      mcpServers: {
        github: {
          type: 'http',
          url: 'http://127.0.0.1:43111/canopy/mcp/proxy/random-route',
        },
      },
    };

    expect(
      createCodexCapabilitySnapshotId({
        ...common,
        mcpAuthorityIds: ['github:authority-a'],
      }),
    ).not.toBe(
      createCodexCapabilitySnapshotId({
        ...common,
        mcpAuthorityIds: ['github:authority-b'],
      }),
    );
  });

  it('keeps tool-schema profiles distinct when projected schemas match', () => {
    const dynamicTools = [
      {
        type: 'function' as const,
        name: 'plain_tool',
        description: 'No schema combinators',
        inputSchema: {
          type: 'object',
          properties: { value: { type: 'string' } },
        },
      },
    ];

    expect(
      createCodexCapabilitySnapshotId({
        dynamicTools,
        toolSchemaProfile: 'standard',
      }),
    ).not.toBe(
      createCodexCapabilitySnapshotId({
        dynamicTools,
        toolSchemaProfile: 'flat',
      }),
    );
  });
});
