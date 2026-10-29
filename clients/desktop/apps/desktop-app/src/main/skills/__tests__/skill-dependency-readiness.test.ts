jest.mock('../../mcp/connection-status', () => ({
  getMcpServerStatusByName: jest.fn(),
}));
jest.mock('../../plugins/invocable-inventory-service', () => ({
  loadCachedInventory: jest.fn(),
}));

import type { McpServerStatusEntry } from '@canopy/desktop-shared/types/mcp-servers';
import { getMcpServerStatusByName } from '../../mcp/connection-status';
import { loadCachedInventory } from '../../plugins/invocable-inventory-service';
import {
  getSkillDependencyReadiness,
  normalizeSkillDependencyReadinessRequest,
} from '../skill-dependency-readiness';

function mcpStatus(
  connectionStatus: McpServerStatusEntry['connectionStatus'],
): McpServerStatusEntry {
  return {
    serverId: 'slack',
    transport: 'http',
    connectionStatus,
    reachability: 'reachable',
    configs: [],
  };
}

describe('getSkillDependencyReadiness', () => {
  beforeEach(() => {
    jest.mocked(getMcpServerStatusByName).mockReset();
    jest.mocked(loadCachedInventory).mockReset();
    jest.mocked(loadCachedInventory).mockResolvedValue({
      version: 2,
      builtAt: '2026-09-23T00:00:00.000Z',
      entries: [
        {
          id: 'superpowers-brainstorm',
          provider: 'claude',
          kind: 'plugin_skill',
          name: 'brainstorm',
          displayName: 'superpowers:brainstorm',
          description: '',
          insertText: '/superpowers:brainstorm ',
          invocationKey: '/superpowers:brainstorm',
          enableRef: {
            kind: 'plugin',
            marketplaceId: 'obra',
            pluginName: 'Superpowers',
          },
        },
      ],
    });
  });

  it('checks MCP servers by name and plugins against installed plugins', async () => {
    jest
      .mocked(getMcpServerStatusByName)
      .mockImplementation((name) =>
        Promise.resolve(name === 'Slack' ? mcpStatus('connected') : null),
      );

    const readiness = await getSkillDependencyReadiness({
      dependencies: [
        { kind: 'mcp', name: 'Slack' },
        { kind: 'mcp', name: 'Linear' },
        { kind: 'plugin', name: 'superpowers' },
        { kind: 'plugin', name: 'not-installed' },
      ],
    });

    expect(
      readiness.requirements.map(({ displayName, kind, status }) => ({
        displayName,
        kind,
        status,
      })),
    ).toEqual([
      { displayName: 'Slack', kind: 'mcp', status: 'available' },
      { displayName: 'Linear', kind: 'mcp', status: 'missing' },
      // A plugin is never probed as an executable on PATH.
      { displayName: 'superpowers', kind: 'runtime', status: 'available' },
      { displayName: 'not-installed', kind: 'runtime', status: 'missing' },
    ]);
    // Unmet requirements warn and never block: none is marked required, so
    // the skill still reads as ready to use.
    expect(readiness.status).toBe('ready');
  });

  it('reports a plugin as unknown before the inventory has been built', async () => {
    jest.mocked(loadCachedInventory).mockResolvedValue(null);

    const readiness = await getSkillDependencyReadiness({
      dependencies: [{ kind: 'plugin', name: 'superpowers' }],
    });

    expect(readiness.requirements[0]?.status).toBe('unknown');
  });

  it('treats a server that needs sign-in as missing', async () => {
    jest
      .mocked(getMcpServerStatusByName)
      .mockResolvedValue(mcpStatus('auth_required'));

    const readiness = await getSkillDependencyReadiness({
      dependencies: [{ kind: 'mcp', name: 'Slack' }],
    });

    expect(readiness.requirements[0]).toMatchObject({
      status: 'missing',
      detail: 'MCP server authentication is required.',
    });
  });
});

describe('normalizeSkillDependencyReadinessRequest', () => {
  it('keeps well-formed dependencies and drops anything else', () => {
    expect(
      normalizeSkillDependencyReadinessRequest({
        dependencies: [
          { kind: 'mcp', name: ' Slack ' },
          { kind: 'command', name: 'rm' },
          { kind: 'plugin', name: '' },
          { kind: 'plugin', name: 'x'.repeat(201) },
          'nope',
        ],
      }),
    ).toEqual({ dependencies: [{ kind: 'mcp', name: 'Slack' }] });
  });

  it('rejects a request that is not a dependency list', () => {
    expect(() => normalizeSkillDependencyReadinessRequest(null)).toThrow(
      'Invalid skill dependency readiness request',
    );
    expect(() =>
      normalizeSkillDependencyReadinessRequest({
        dependencies: Array.from({ length: 51 }, () => ({
          kind: 'mcp',
          name: 'Slack',
        })),
      }),
    ).toThrow('Invalid skill dependency readiness request');
  });
});
