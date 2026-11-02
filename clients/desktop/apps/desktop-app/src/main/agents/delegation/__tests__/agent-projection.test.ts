import { captureHomeCapabilities } from '../capture-home-capabilities';
import type { ChatTabPluginSelections } from '@canopy/desktop-shared/types';
import type { NativeDelegationFiles } from '@canopy/desktop-shared/node/delegation/file-access';
import type * as Paths from '../../../lib/paths';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type * as PluginInterop from '@canopy/plugin-interop';
import {
  materializeDelegationAgentPlugins,
  materializeDelegationCapabilities,
} from '../agent-projection';
import {
  DelegationAgentCapabilityError,
  delegationCapabilitySkipReason,
} from '../agent-capability-error';
import { DelegationCapabilityCache } from '../capability-cache';
import { delegationCapabilityIdForRef } from '../capability-catalog';

const resolveEffectivePluginSelectionRefs = jest.fn();
const resolveSelectedSkillDirectory = jest.fn();
const resolvePluginInfoPath = jest.fn();
const loadMarketplacesCacheOnly = jest.fn();
const readPreferencesFile = jest.fn();
const readMcpAccountIndexEntry = jest.fn();
const getMcpServerFilePath = jest.fn();
const accountMcpConnectionsEnabled = jest.fn();
const loadAccountMcpRefConnections = jest.fn();

// `@canopy/plugin-interop` re-exports its named exports through `export *`,
// which compiles to non-configurable getter bindings; `jest.spyOn` cannot
// redefine those. Mock the module instead, keeping every real export except
// a controllable wrapper around `projectClaudePluginForCodex` so individual
// tests can force a projection failure without losing the real behaviour the
// other tests rely on (restored to a passthrough in `beforeEach`).
const projectClaudePluginForCodex = jest.fn<
  ReturnType<typeof PluginInterop.projectClaudePluginForCodex>,
  Parameters<typeof PluginInterop.projectClaudePluginForCodex>
>();
const actualProjectClaudePluginForCodex = jest.requireActual<
  typeof PluginInterop
>('@canopy/plugin-interop').projectClaudePluginForCodex;

jest.mock('@canopy/plugin-interop', () => ({
  ...jest.requireActual<typeof PluginInterop>('@canopy/plugin-interop'),
  projectClaudePluginForCodex: (
    ...args: Parameters<typeof PluginInterop.projectClaudePluginForCodex>
  ): ReturnType<typeof PluginInterop.projectClaudePluginForCodex> =>
    projectClaudePluginForCodex(...args),
}));

jest.mock('../../../lib/preferences-store', () => ({
  readPreferencesFile: (...args: unknown[]): unknown =>
    readPreferencesFile(...args),
}));
jest.mock('../../../mcp/account-routing', () => ({
  readMcpAccountIndexEntry: (...args: unknown[]): unknown =>
    readMcpAccountIndexEntry(...args),
}));
jest.mock('../../../mcp/account-catalog', () => ({
  accountMcpConnectionsEnabled: (): unknown => accountMcpConnectionsEnabled(),
  loadAccountMcpRefConnections: (): unknown => loadAccountMcpRefConnections(),
}));
jest.mock('../../../lib/paths', () => ({
  ...jest.requireActual<typeof Paths>('../../../lib/paths'),
  getMcpServerFilePath: (...args: unknown[]): unknown =>
    getMcpServerFilePath(...args),
}));

jest.mock('../../../plugins/plugin-resolver', () => ({
  resolveEffectivePluginSelectionRefs: (...args: unknown[]): unknown =>
    resolveEffectivePluginSelectionRefs(...args),
  resolveSelectedSkillDirectory: (...args: unknown[]): unknown =>
    resolveSelectedSkillDirectory(...args),
  resolvePluginInfoPath: (...args: unknown[]): unknown =>
    resolvePluginInfoPath(...args),
}));
jest.mock('../../../plugins/plugin-service', () => ({
  loadMarketplacesCacheOnly: (...args: unknown[]): unknown =>
    loadMarketplacesCacheOnly(...args),
}));

function reader(
  files: Record<string, string>,
): Pick<NativeDelegationFiles, 'list' | 'read' | 'close'> {
  return {
    list: jest.fn((directory = '') => {
      const prefix = directory ? `${directory}/` : '';
      const direct = new Map<string, boolean>();
      for (const file of Object.keys(files)) {
        if (!file.startsWith(prefix)) continue;
        const remainder = file.slice(prefix.length);
        const [name] = remainder.split('/');
        direct.set(name, remainder.includes('/'));
      }
      return Promise.resolve(
        Array.from(direct.entries()).map(([name, isDirectory]) => ({
          path: `${prefix}${name}`,
          directory: isDirectory,
        })),
      );
    }),
    read: jest.fn((name: string) => Promise.resolve(files[name] ?? '')),
    close: jest.fn(() => Promise.resolve(undefined)),
  };
}

describe('delegated Agent selected capability projection', () => {
  beforeEach(() => {
    // `mockReset` (not `mockClear`) so a queued `mockResolvedValueOnce` /
    // `mockImplementationOnce` left over by a previous test — including one
    // that aborted before consuming its queue — can never leak into the next
    // test's calls. Every default this suite relies on is re-established
    // immediately below.
    jest.resetAllMocks();
    projectClaudePluginForCodex.mockImplementation(
      actualProjectClaudePluginForCodex,
    );
    readPreferencesFile.mockResolvedValue({
      mcpHttpAuthDefaultHandler: 'canopy',
    });
    readMcpAccountIndexEntry.mockResolvedValue(undefined);
    accountMcpConnectionsEnabled.mockReturnValue(true);
    loadAccountMcpRefConnections.mockResolvedValue([]);
    resolveEffectivePluginSelectionRefs.mockResolvedValue({
      skillRefs: [{ sourceId: 'builtin', skillName: 'review' }],
      pluginRefs: [{ marketplaceId: 'market', pluginName: 'plugin' }],
      mcpServerRefs: [],
      warnings: [],
    });
    resolveSelectedSkillDirectory.mockReturnValue('/skills/review');
    resolvePluginInfoPath.mockResolvedValue('/plugins/plugin');
    loadMarketplacesCacheOnly.mockResolvedValue({
      success: true,
      data: {
        marketplaces: [
          {
            id: 'market',
            plugins: [{ name: 'plugin', facets: { claude: {} } }],
          },
        ],
      },
    });
  });

  it('retains selected skill and plugin instructions, native metadata, and declared capability identities', async () => {
    const roots: Record<
      string,
      Pick<NativeDelegationFiles, 'list' | 'read' | 'close'>
    > = {
      '/skills/review': reader({ 'SKILL.md': '# Review' }),
      '/plugins/plugin': reader({
        '.claude-plugin/plugin.json': JSON.stringify({
          name: 'plugin',
          mcpServers: '.mcp.json',
        }),
        'commands/review.md': '# Review command',
        '.git/objects/a1/b2': 'GIT_OBJECT',
        '.env': 'TOKEN_SENTINEL',
        '.npmrc': 'NPM_TOKEN_SENTINEL',
        'keys/private.pem': 'PRIVATE_KEY_SENTINEL',
        '.mcp.json': JSON.stringify({
          mcpServers: {
            review_evidence: { url: 'https://example.test/mcp' },
            disabled_optional: {
              url: 'https://disabled.test/mcp',
              enabled: false,
            },
          },
        }),
      }),
    };
    const projected = await materializeDelegationAgentPlugins(
      {
        collectionIds: [],
        skillRefs: [{ sourceId: 'builtin', skillName: 'review' }],
        pluginRefs: [{ marketplaceId: 'market', pluginName: 'plugin' }],
      },
      (directory) => Promise.resolve(roots[directory]),
    );
    expect(Object.values(projected.files)).toContain('# Review');
    expect(Object.values(projected.files)).toContain('# Review command');
    expect(JSON.stringify(projected.files)).not.toContain('GIT_OBJECT');
    expect(JSON.stringify(projected.files)).not.toMatch(
      /TOKEN_SENTINEL|PRIVATE_KEY_SENTINEL/,
    );
    expect(Object.keys(projected.files)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/\.claude-plugin\/plugin\.json$/),
      ]),
    );
    expect(JSON.stringify(projected.files)).not.toContain('mcpServers');
    expect(JSON.stringify(projected.files)).not.toContain('example.test/mcp');
    expect(projected.capabilities.claudePluginRoots).toHaveLength(2);
    expect(projected.capabilities.claudeSkillNames).toEqual([
      'review:review',
      'plugin:review',
    ]);
    expect(projected.capabilities.mcpSelections).toEqual([
      expect.objectContaining({
        source: 'plugin',
        marketplaceId: 'market',
        pluginName: 'plugin',
        serverName: 'review_evidence',
      }),
    ]);
    expect(projected.capabilities.hookDeclarations).toEqual([]);
  });

  it('fails explicitly for selected executable hooks', async () => {
    resolveEffectivePluginSelectionRefs.mockResolvedValue({
      skillRefs: [],
      pluginRefs: [{ marketplaceId: 'market', pluginName: 'plugin' }],
      mcpServerRefs: [],
      warnings: [],
    });
    await expect(
      materializeDelegationAgentPlugins(
        { collectionIds: [], skillRefs: [], pluginRefs: [] },
        () =>
          Promise.resolve(
            reader({
              '.claude-plugin/plugin.json': JSON.stringify({
                name: 'plugin',
                hooks: 'hooks/hooks.json',
              }),
              'hooks/hooks.json': JSON.stringify({ PreToolUse: [] }),
            }),
          ),
      ),
    ).rejects.toMatchObject({ code: 'unsupported_hooks' });
  });

  it('rejects selected plugins with monitor declarations or files', async () => {
    resolveEffectivePluginSelectionRefs.mockResolvedValue({
      skillRefs: [],
      pluginRefs: [{ marketplaceId: 'market', pluginName: 'plugin' }],
      mcpServerRefs: [],
      warnings: [],
    });
    const pluginFilesCases: Record<string, string>[] = [
      {
        '.claude-plugin/plugin.json': JSON.stringify({
          name: 'plugin',
          monitors: './monitors/monitors.json',
        }),
      },
      {
        '.claude-plugin/plugin.json': JSON.stringify({ name: 'plugin' }),
        'monitors/monitors.json': JSON.stringify({ command: 'echo unsafe' }),
      },
    ];
    for (const pluginFiles of pluginFilesCases) {
      await expect(
        materializeDelegationAgentPlugins(
          { collectionIds: [], skillRefs: [], pluginRefs: [] },
          () => Promise.resolve(reader(pluginFiles)),
        ),
      ).rejects.toMatchObject({ code: 'unsupported_hooks' });
    }
  });

  it.each([
    [
      'Claude inline LSP declaration',
      'claude',
      {
        '.claude-plugin/plugin.json': JSON.stringify({
          name: 'plugin',
          lspServers: { typescript: { command: 'language-server' } },
        }),
      },
    ],
    [
      'Claude custom LSP config',
      'claude',
      {
        '.claude-plugin/plugin.json': JSON.stringify({
          name: 'plugin',
          lspServers: './config/language-servers.json',
        }),
        'config/language-servers.json': JSON.stringify({
          typescript: { command: 'language-server' },
        }),
      },
    ],
    [
      'Claude implicit LSP config',
      'claude',
      {
        '.claude-plugin/plugin.json': JSON.stringify({ name: 'plugin' }),
        '.lsp.json': JSON.stringify({
          typescript: { command: 'language-server' },
        }),
      },
    ],
    [
      'LSP declaration in an alternate manifest',
      'claude',
      {
        '.claude-plugin/plugin.json': JSON.stringify({ name: 'plugin' }),
        '.codex-plugin/plugin.json': JSON.stringify({
          name: 'plugin',
          lspServers: { typescript: { command: 'language-server' } },
        }),
      },
    ],
    [
      'Codex native LSP declaration',
      'codex',
      {
        '.codex-plugin/plugin.json': JSON.stringify({
          name: 'plugin',
          lspServers: './config/language-servers.json',
        }),
        'config/language-servers.json': JSON.stringify({
          typescript: { command: 'language-server' },
        }),
      },
    ],
    [
      'Codex native implicit LSP config',
      'codex',
      {
        '.codex-plugin/plugin.json': JSON.stringify({ name: 'plugin' }),
        'config/.lsp.json': JSON.stringify({
          typescript: { command: 'language-server' },
        }),
      },
    ],
  ] as const)(
    'rejects selected plugins with %s',
    async (_description, harness, pluginFiles) => {
      resolveEffectivePluginSelectionRefs.mockResolvedValue({
        skillRefs: [],
        pluginRefs: [{ marketplaceId: 'market', pluginName: 'plugin' }],
        mcpServerRefs: [],
        warnings: [],
      });
      await expect(
        materializeDelegationAgentPlugins(
          { collectionIds: [], skillRefs: [], pluginRefs: [] },
          () => Promise.resolve(reader(pluginFiles)),
          harness,
        ),
      ).rejects.toMatchObject({
        code: 'unsupported_lsp',
        publicMessage:
          'Remove plugin language server configuration, or select a different plugin for managed delegation.',
      });
    },
  );

  it('rejects a selected skill with binary assets instead of dropping them', async () => {
    resolveEffectivePluginSelectionRefs.mockResolvedValue({
      skillRefs: [{ sourceId: 'builtin', skillName: 'review' }],
      pluginRefs: [],
      mcpServerRefs: [],
      warnings: [],
    });
    await expect(
      materializeDelegationAgentPlugins(
        { collectionIds: [], skillRefs: [], pluginRefs: [] },
        () =>
          Promise.resolve(
            reader({ 'SKILL.md': 'Read the diagram.', 'diagram.pdf': 'PDF' }),
          ),
      ),
    ).rejects.toMatchObject({ code: 'unavailable_asset' });
  });

  it('retains account MCP selections by server key without a device file', async () => {
    const github = {
      id: 'connection',
      serverKey: 'github',
      configId: 'default',
      kind: 'CURATED',
    };
    const custom = {
      id: 'custom-connection',
      serverKey: 'custom:11111111-2222-4333-8444-555555555555',
      configId: 'default',
      kind: 'CUSTOM',
    };
    loadAccountMcpRefConnections.mockResolvedValue([github, custom]);
    getMcpServerFilePath.mockReturnValue('/missing/server-github.json');
    resolveEffectivePluginSelectionRefs.mockResolvedValue({
      skillRefs: [],
      pluginRefs: [],
      mcpServerRefs: [
        { serverId: 'account:connection', configId: 'default' },
        { serverId: custom.serverKey, configId: 'default' },
      ],
      warnings: [],
    });
    const projected = await materializeDelegationAgentPlugins(
      { collectionIds: [], skillRefs: [], pluginRefs: [] },
      () => Promise.resolve(reader({})),
    );
    const digest: unknown = expect.stringMatching(/^[0-9a-f]{64}$/);
    expect(projected.capabilities.mcpSelections).toEqual([
      {
        source: 'account',
        serverId: 'github',
        configId: 'default',
        configDigest: digest,
      },
      {
        source: 'account',
        serverId: custom.serverKey,
        configId: 'default',
        configDigest: digest,
      },
    ]);
    expect(getMcpServerFilePath).not.toHaveBeenCalled();
    expect(projected.capabilities.mcpHttpAuthPreferences).toEqual([]);
  });

  it.each([
    ['a deleted connection', true, 'missing_selection'],
    ['account connections switched off', false, 'unsupported_capability'],
  ])(
    'rejects account MCP selections with %s',
    async (_label, enabled, code) => {
      accountMcpConnectionsEnabled.mockReturnValue(enabled);
      resolveEffectivePluginSelectionRefs.mockResolvedValue({
        skillRefs: [],
        pluginRefs: [],
        mcpServerRefs: [
          { serverId: 'account:connection', configId: 'default' },
        ],
        warnings: [],
      });
      await expect(
        materializeDelegationAgentPlugins(
          { collectionIds: [], skillRefs: [], pluginRefs: [] },
          () => Promise.resolve(reader({})),
        ),
      ).rejects.toMatchObject({ code });
    },
  );

  it('pins a selected provider-auth plugin HTTP MCP (parent parity)', async () => {
    resolveEffectivePluginSelectionRefs.mockResolvedValue({
      skillRefs: [],
      pluginRefs: [{ marketplaceId: 'market', pluginName: 'plugin' }],
      mcpServerRefs: [],
      warnings: [],
    });
    await expect(
      materializeDelegationAgentPlugins(
        {
          collectionIds: [],
          skillRefs: [],
          pluginRefs: [],
          mcpHttpAuthPreferences: [
            {
              target: {
                kind: 'plugin',
                marketplaceId: 'market',
                pluginName: 'plugin',
                serverName: 'review',
              },
              handler: 'provider',
            },
          ],
        },
        () =>
          Promise.resolve(
            reader({
              '.claude-plugin/plugin.json': JSON.stringify({
                name: 'plugin',
                mcpServers: { review: { url: 'https://example.test/mcp' } },
              }),
            }),
          ),
      ),
    ).resolves.toMatchObject({
      capabilities: {
        mcpHttpAuthPreferences: [
          {
            target: {
              kind: 'plugin',
              marketplaceId: 'market',
              pluginName: 'plugin',
              serverName: 'review',
            },
            handler: 'provider',
          },
        ],
      },
    });
  });

  it('pins the provider global auth default for a plugin HTTP MCP', async () => {
    readPreferencesFile.mockResolvedValue({
      mcpHttpAuthDefaultHandler: 'provider',
    });
    resolveEffectivePluginSelectionRefs.mockResolvedValue({
      skillRefs: [],
      pluginRefs: [{ marketplaceId: 'market', pluginName: 'plugin' }],
      mcpServerRefs: [],
      warnings: [],
    });
    await expect(
      materializeDelegationAgentPlugins(
        { collectionIds: [], skillRefs: [], pluginRefs: [] },
        () =>
          Promise.resolve(
            reader({
              '.claude-plugin/plugin.json': JSON.stringify({
                name: 'plugin',
                mcpServers: { review: { url: 'https://example.test/mcp' } },
              }),
            }),
          ),
      ),
    ).resolves.toMatchObject({
      capabilities: {
        mcpHttpAuthPreferences: [
          {
            target: {
              kind: 'plugin',
              marketplaceId: 'market',
              pluginName: 'plugin',
              serverName: 'review',
            },
            handler: 'provider',
          },
        ],
      },
    });
  });

  it('pins an account auth preference for a selected plugin HTTP MCP', async () => {
    resolveEffectivePluginSelectionRefs.mockResolvedValue({
      skillRefs: [],
      pluginRefs: [{ marketplaceId: 'market', pluginName: 'plugin' }],
      mcpServerRefs: [],
      warnings: [],
    });
    await expect(
      materializeDelegationAgentPlugins(
        {
          collectionIds: [],
          skillRefs: [],
          pluginRefs: [],
          mcpHttpAuthPreferences: [
            {
              target: {
                kind: 'plugin',
                marketplaceId: 'market',
                pluginName: 'plugin',
                serverName: 'review',
              },
              handler: 'account',
            },
          ],
        },
        () =>
          Promise.resolve(
            reader({
              '.claude-plugin/plugin.json': JSON.stringify({
                name: 'plugin',
                mcpServers: { review: { url: 'https://example.test/mcp' } },
              }),
            }),
          ),
      ),
    ).resolves.toMatchObject({
      capabilities: {
        mcpHttpAuthPreferences: [
          {
            target: {
              kind: 'plugin',
              marketplaceId: 'market',
              pluginName: 'plugin',
              serverName: 'review',
            },
            handler: 'account',
          },
        ],
      },
    });
  });

  it('retains only selected HTTP auth preferences', async () => {
    resolveEffectivePluginSelectionRefs.mockResolvedValue({
      skillRefs: [],
      pluginRefs: [{ marketplaceId: 'market', pluginName: 'plugin' }],
      mcpServerRefs: [],
      warnings: [],
    });
    const selected = {
      target: {
        kind: 'plugin' as const,
        marketplaceId: 'market',
        pluginName: 'plugin',
        serverName: 'review',
      },
      handler: 'canopy' as const,
      source: 'override' as const,
    };
    const unselected = {
      target: {
        kind: 'plugin' as const,
        marketplaceId: 'market',
        pluginName: 'plugin',
        serverName: 'other',
      },
      handler: 'provider' as const,
    };
    const projected = await materializeDelegationAgentPlugins(
      {
        collectionIds: [],
        skillRefs: [],
        pluginRefs: [],
        mcpHttpAuthPreferences: [selected, unselected],
      },
      () =>
        Promise.resolve(
          reader({
            '.claude-plugin/plugin.json': JSON.stringify({
              name: 'plugin',
              mcpServers: { review: { url: 'https://example.test/mcp' } },
            }),
          }),
        ),
    );
    expect(projected.capabilities.mcpHttpAuthPreferences).toEqual([selected]);
  });

  it('pins an inherited HTTP auth default for the selected server', async () => {
    resolveEffectivePluginSelectionRefs.mockResolvedValue({
      skillRefs: [],
      pluginRefs: [{ marketplaceId: 'market', pluginName: 'plugin' }],
      mcpServerRefs: [],
      warnings: [],
    });
    const projected = await materializeDelegationAgentPlugins(
      { collectionIds: [], skillRefs: [], pluginRefs: [] },
      () =>
        Promise.resolve(
          reader({
            '.claude-plugin/plugin.json': JSON.stringify({
              name: 'plugin',
              mcpServers: { review: { url: 'https://example.test/mcp' } },
            }),
          }),
        ),
    );
    expect(projected.capabilities.mcpHttpAuthPreferences).toEqual([
      {
        target: {
          kind: 'plugin',
          marketplaceId: 'market',
          pluginName: 'plugin',
          serverName: 'review',
        },
        handler: 'canopy',
        source: 'default',
      },
    ]);
  });

  it('distinguishes an explicit override from a synthesized pin for the same plugin', async () => {
    resolveEffectivePluginSelectionRefs.mockResolvedValue({
      skillRefs: [],
      pluginRefs: [{ marketplaceId: 'market', pluginName: 'plugin' }],
      mcpServerRefs: [],
      warnings: [],
    });
    const override = {
      target: {
        kind: 'plugin' as const,
        marketplaceId: 'market',
        pluginName: 'plugin',
        serverName: 'review',
      },
      handler: 'provider' as const,
    };
    const projected = await materializeDelegationAgentPlugins(
      {
        collectionIds: [],
        skillRefs: [],
        pluginRefs: [],
        mcpHttpAuthPreferences: [override],
      },
      () =>
        Promise.resolve(
          reader({
            '.claude-plugin/plugin.json': JSON.stringify({
              name: 'plugin',
              mcpServers: {
                review: { url: 'https://example.test/mcp' },
                other: { url: 'https://other.example.test/mcp' },
              },
            }),
          }),
        ),
    );
    expect(projected.capabilities.mcpHttpAuthPreferences).toEqual([
      { ...override, source: 'override' },
      {
        target: { ...override.target, serverName: 'other' },
        handler: 'canopy',
        source: 'default',
      },
    ]);
  });

  it.each([
    ['provider', { scope: 'device', authHandler: 'provider' }],
    ['account', { scope: 'account', authHandler: 'account' }],
  ])(
    'pins standalone HTTP MCP when its index selects %s auth',
    async (handler, indexEntry) => {
      const directory = await mkdtemp(
        path.join(os.tmpdir(), 'delegation-mcp-'),
      );
      try {
        const file = path.join(directory, 'server.json');
        await writeFile(
          file,
          JSON.stringify({
            version: 1,
            server: {
              definition: {
                id: 'server',
                name: 'Server',
                description: '',
                type: 'http',
                url: 'https://example.test/mcp',
                createdAt: '2026-09-23T00:00:00.000Z',
                updatedAt: '2026-09-23T00:00:00.000Z',
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
                  createdAt: '2026-09-23T00:00:00.000Z',
                  updatedAt: '2026-09-23T00:00:00.000Z',
                },
              ],
            },
          }),
        );
        getMcpServerFilePath.mockReturnValue(file);
        readMcpAccountIndexEntry.mockResolvedValue(indexEntry);
        resolveEffectivePluginSelectionRefs.mockResolvedValue({
          skillRefs: [],
          pluginRefs: [],
          mcpServerRefs: [{ serverId: 'server', configId: 'default' }],
          warnings: [],
        });
        await expect(
          materializeDelegationAgentPlugins(
            { collectionIds: [], skillRefs: [], pluginRefs: [] },
            () => Promise.resolve(reader({})),
          ),
        ).resolves.toMatchObject({
          capabilities: {
            mcpHttpAuthPreferences: [
              {
                target: {
                  kind: 'standalone',
                  serverId: 'server',
                  configId: 'default',
                },
                handler,
              },
            ],
          },
        });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it('strips MCP secrets from both manifests and custom config files', async () => {
    resolveEffectivePluginSelectionRefs.mockResolvedValue({
      skillRefs: [],
      pluginRefs: [{ marketplaceId: 'market', pluginName: 'plugin' }],
      mcpServerRefs: [],
      warnings: [],
    });
    const projected = await materializeDelegationAgentPlugins(
      { collectionIds: [], skillRefs: [], pluginRefs: [] },
      () =>
        Promise.resolve(
          reader({
            '.claude-plugin/plugin.json': JSON.stringify({
              name: 'plugin',
              mcpServers: './transport/claude.json',
            }),
            '.codex-plugin/plugin.json': JSON.stringify({
              name: 'plugin',
              mcpServers: './transport/codex.json',
            }),
            'transport/claude.json': JSON.stringify({
              server: {
                url: 'https://example.test',
                headers: { Authorization: 'SECRET_SENTINEL' },
              },
            }),
            'transport/codex.json': JSON.stringify({
              server: {
                url: 'https://other.test',
                headers: { Authorization: 'OTHER_SENTINEL' },
              },
            }),
            'skills/review/SKILL.md': '# Review',
          }),
        ),
    );
    const retained = JSON.stringify(projected.files);
    expect(retained).not.toMatch(
      /SECRET_SENTINEL|OTHER_SENTINEL|mcpServers|transport\/claude|transport\/codex/,
    );
    expect(projected.capabilities.mcpSelections).toHaveLength(1);
  });

  it.each([
    '---\ncontext: fork\n---\nReview',
    '---\nagent: reviewer\n---\nReview',
    '---\nhooks: {}\n---\nReview',
    'Run !`pwd` before reviewing.',
  ])('rejects ungoverned skill execution metadata', async (instructions) => {
    resolveEffectivePluginSelectionRefs.mockResolvedValue({
      skillRefs: [{ sourceId: 'builtin', skillName: 'review' }],
      pluginRefs: [],
      mcpServerRefs: [],
      warnings: [],
    });
    await expect(
      materializeDelegationAgentPlugins(
        { collectionIds: [], skillRefs: [], pluginRefs: [] },
        () => Promise.resolve(reader({ 'SKILL.md': instructions })),
      ),
    ).rejects.toMatchObject({ code: 'unsupported_skill_execution' });
  });

  it('keeps punctuation in ordinary skill prose and disambiguates duplicate names', async () => {
    resolveEffectivePluginSelectionRefs.mockResolvedValue({
      skillRefs: [
        { sourceId: 'one', skillName: 'review' },
        { sourceId: 'two', skillName: 'review' },
      ],
      pluginRefs: [],
      mcpServerRefs: [],
      warnings: [],
    });
    const projected = await materializeDelegationAgentPlugins(
      { collectionIds: [], skillRefs: [], pluginRefs: [] },
      () =>
        Promise.resolve(
          reader({ 'SKILL.md': 'Review carefully! Keep the citation.' }),
        ),
    );
    const manifests = Object.entries(projected.files)
      .filter(([name]) => name.endsWith('.claude-plugin/plugin.json'))
      .map(([, content]) => {
        const parsed: unknown = JSON.parse(content);
        if (
          typeof parsed !== 'object' ||
          parsed === null ||
          !('name' in parsed) ||
          typeof parsed.name !== 'string'
        )
          throw new Error('Invalid projected plugin manifest');
        return parsed.name;
      });
    expect(manifests.sort()).toEqual(['review', 'review-2']);
    expect(projected.capabilities.claudeSkillNames).toEqual([
      'review:review',
      'review-2:review',
    ]);
  });

  it('retains a native Codex plugin root and strips its MCP declaration', async () => {
    resolveEffectivePluginSelectionRefs.mockResolvedValue({
      skillRefs: [],
      pluginRefs: [{ marketplaceId: 'market', pluginName: 'plugin' }],
      mcpServerRefs: [],
      warnings: [],
    });
    const projected = await materializeDelegationAgentPlugins(
      { collectionIds: [], skillRefs: [], pluginRefs: [] },
      () =>
        Promise.resolve(
          reader({
            '.codex-plugin/plugin.json': JSON.stringify({
              name: 'plugin',
              mcpServers: './.mcp.json',
            }),
            '.mcp.json': JSON.stringify({
              mcpServers: { review: { command: 'node', args: ['server.js'] } },
            }),
            'skills/review/SKILL.md':
              '---\nname: review\n---\nReview carefully.',
            'server.js': 'process.stdout.write("ready")',
          }),
        ),
      'codex',
    );
    expect(projected.capabilities.codexCapabilityRoots).toHaveLength(1);
    expect(projected.capabilities.claudePluginRoots).toEqual([]);
    expect(projected.capabilities.mcpSelections).toHaveLength(1);
    expect(Object.keys(projected.files)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/\.codex-plugin\/plugin\.json$/),
        expect.stringMatching(/skills\/review\/SKILL\.md$/),
        expect.stringMatching(/server\.js$/),
      ]),
    );
    expect(JSON.stringify(projected.files)).not.toContain('mcpServers');
  });

  it('projects a Claude-only plugin into a Codex capability root', async () => {
    resolveEffectivePluginSelectionRefs.mockResolvedValue({
      skillRefs: [],
      pluginRefs: [{ marketplaceId: 'market', pluginName: 'plugin' }],
      mcpServerRefs: [],
      warnings: [],
    });
    const projected = await materializeDelegationAgentPlugins(
      { collectionIds: ['collection'], skillRefs: [], pluginRefs: [] },
      () =>
        Promise.resolve(
          reader({
            '.claude-plugin/plugin.json': JSON.stringify({
              name: 'plugin',
              mcpServers: './.mcp.json',
            }),
            '.mcp.json': JSON.stringify({
              mcpServers: { review: { url: 'https://example.test/mcp' } },
            }),
            'skills/review/SKILL.md':
              '---\nname: review\n---\nReview carefully.',
          }),
        ),
      'codex',
    );
    expect(resolveEffectivePluginSelectionRefs).toHaveBeenCalledWith(
      expect.objectContaining({ collectionIds: ['collection'] }),
      expect.any(Array),
    );
    expect(projected.capabilities.codexCapabilityRoots).toHaveLength(1);
    expect(projected.capabilities.mcpSelections).toHaveLength(1);
    expect(Object.keys(projected.files)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/\.codex-plugin\/plugin\.json$/),
        expect.stringMatching(/SKILL\.md$/),
      ]),
    );
    expect(JSON.stringify(projected.files)).not.toContain('mcpServers');
  });

  it('skips unusable inherited items while retaining usable capabilities', async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), 'delegation-items-'),
    );
    const providerFile = path.join(directory, 'provider.json');
    try {
      await writeFile(
        providerFile,
        JSON.stringify({
          version: 1,
          server: {
            definition: {
              id: 'provider',
              name: 'Provider',
              description: '',
              type: 'http',
              url: 'https://example.test/mcp',
              createdAt: '2026-09-23T00:00:00.000Z',
              updatedAt: '2026-09-23T00:00:00.000Z',
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
                createdAt: '2026-09-23T00:00:00.000Z',
                updatedAt: '2026-09-23T00:00:00.000Z',
              },
            ],
          },
        }),
      );
      getMcpServerFilePath.mockReturnValue(providerFile);
      resolveEffectivePluginSelectionRefs.mockResolvedValue({
        skillRefs: [{ sourceId: 'builtin', skillName: 'missing' }],
        pluginRefs: [
          { marketplaceId: 'market', pluginName: 'hooks' },
          { marketplaceId: 'market', pluginName: 'lsp' },
          { marketplaceId: 'market', pluginName: 'bad-codex' },
          { marketplaceId: 'market', pluginName: 'good' },
        ],
        mcpServerRefs: [{ serverId: 'provider', configId: 'default' }],
        warnings: [],
      });
      loadMarketplacesCacheOnly.mockResolvedValue({
        success: true,
        data: {
          marketplaces: [
            {
              id: 'market',
              plugins: [
                { name: 'hooks', facets: { claude: {} } },
                { name: 'lsp', facets: { claude: {} } },
                { name: 'bad-codex', facets: { claude: {} } },
                { name: 'good', facets: { claude: {} } },
              ],
            },
          ],
        },
      });
      resolveSelectedSkillDirectory.mockReturnValue('/skills/missing');
      resolvePluginInfoPath
        .mockResolvedValueOnce('/plugins/hooks')
        .mockResolvedValueOnce('/plugins/lsp')
        .mockResolvedValueOnce('/plugins/bad-codex')
        .mockResolvedValueOnce('/plugins/good');
      accountMcpConnectionsEnabled.mockReturnValue(true);

      const sources: Record<string, Record<string, string>> = {
        '/skills/missing': {},
        '/plugins/hooks': {
          '.claude-plugin/plugin.json': JSON.stringify({
            name: 'hooks',
            hooks: {},
          }),
        },
        '/plugins/lsp': {
          '.claude-plugin/plugin.json': JSON.stringify({
            name: 'lsp',
            lspServers: { typescript: { command: 'language-server' } },
          }),
        },
        '/plugins/bad-codex': {
          '.claude-plugin/plugin.json': JSON.stringify({ name: 'bad-codex' }),
        },
        '/plugins/good': {
          '.claude-plugin/plugin.json': JSON.stringify({ name: 'good' }),
        },
      };
      projectClaudePluginForCodex.mockImplementation((input) => {
        const projection = actualProjectClaudePluginForCodex(input);
        return input.pluginName === 'bad-codex'
          ? { ...projection, warnings: ['unsupported projection'] }
          : projection;
      });
      const projected = await materializeDelegationCapabilities(
        [
          {
            source: 'inherited',
            selections: {
              collectionIds: [],
              skillRefs: [],
              pluginRefs: [],
              mcpHttpAuthPreferences: [
                {
                  target: {
                    kind: 'standalone',
                    serverId: 'provider',
                    configId: 'default',
                  },
                  handler: 'provider',
                },
              ],
            },
          },
        ],
        (sourceDirectory) =>
          Promise.resolve(reader(sources[sourceDirectory] ?? {})),
        'codex',
      );

      // A provider-handled HTTP server is now usable (MCP parity, D4).
      expect(projected.included.map((item) => item.name)).toEqual([
        'good',
        'Provider / Default',
      ]);
      expect(projected.skipped.map((item) => item.reason)).toEqual([
        'missing_selection',
        'unsupported_hooks',
        'unsupported_lsp',
        'unsupported_capability',
      ]);
      expect(projected.capabilities.codexCapabilityRoots).toHaveLength(1);
      expect(JSON.stringify(projected)).not.toContain('/plugins/');
      expect(JSON.stringify(projected)).not.toContain('/skills/');

      resolveEffectivePluginSelectionRefs.mockResolvedValue({
        skillRefs: [],
        pluginRefs: [{ marketplaceId: 'market', pluginName: 'bad-codex' }],
        mcpServerRefs: [],
        warnings: [],
      });
      resolvePluginInfoPath.mockResolvedValue('/plugins/bad-codex');
      await expect(
        materializeDelegationAgentPlugins(
          { collectionIds: [], skillRefs: [], pluginRefs: [] },
          (sourceDirectory) =>
            Promise.resolve(reader(sources[sourceDirectory] ?? {})),
          'codex',
        ),
      ).rejects.toMatchObject({ code: 'unsupported_capability' });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('keeps the Agent wrapper fail-fast for a missing skill', async () => {
    resolveEffectivePluginSelectionRefs.mockResolvedValue({
      skillRefs: [{ sourceId: 'builtin', skillName: 'missing' }],
      pluginRefs: [],
      mcpServerRefs: [],
      warnings: [],
    });
    resolveSelectedSkillDirectory.mockReturnValue('/skills/missing');

    await expect(
      materializeDelegationAgentPlugins(
        { collectionIds: [], skillRefs: [], pluginRefs: [] },
        () => Promise.resolve(reader({})),
      ),
    ).rejects.toMatchObject({ code: 'missing_selection' });
  });

  it('prioritizes Agent items, de-duplicates inheritance, and records provenance', async () => {
    const skillRef = { sourceId: 'builtin', skillName: 'review' };
    const pluginRef = { marketplaceId: 'market', pluginName: 'plugin' };
    const accountConnection = {
      id: 'connection',
      serverKey: 'github',
      configId: 'default',
      displayName: 'GitHub',
      kind: 'CURATED',
    };
    accountMcpConnectionsEnabled.mockReturnValue(true);
    loadAccountMcpRefConnections.mockResolvedValue([accountConnection]);
    getMcpServerFilePath.mockReturnValue('/missing/server.json');
    // Deliberately distinct from the `skills/<name>/...` namespace the
    // materializer wraps a selected skill's own files under, so the
    // no-leaked-path assertion below can't false-positive on that safe,
    // hash-rooted internal path coincidentally containing "skills/review".
    const hostSkillDirectory = '/host-only/skill-source';
    resolveSelectedSkillDirectory.mockReturnValue(hostSkillDirectory);
    resolveEffectivePluginSelectionRefs.mockImplementation(
      (selections: ChatTabPluginSelections) => ({
        skillRefs: selections.skillRefs,
        pluginRefs: selections.pluginRefs,
        mcpServerRefs: selections.mcpServerRefs ?? [],
        warnings: [],
      }),
    );

    const agentSelections: ChatTabPluginSelections = {
      collectionIds: [],
      skillRefs: [skillRef],
      pluginRefs: [],
    };
    const explicitSelections: ChatTabPluginSelections = {
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [pluginRef],
    };
    const inheritedSelections: ChatTabPluginSelections = {
      collectionIds: [],
      skillRefs: [skillRef],
      pluginRefs: [],
      mcpServerRefs: [{ serverId: 'github', configId: 'default' }],
    };
    const projected = await materializeDelegationCapabilities(
      [
        { source: 'inherited', selections: inheritedSelections },
        { source: 'explicit', selections: explicitSelections },
        { source: 'agent', selections: agentSelections },
      ],
      (directory) =>
        Promise.resolve(
          reader(
            directory === hostSkillDirectory
              ? { 'SKILL.md': '# Review' }
              : {
                  '.claude-plugin/plugin.json': JSON.stringify({
                    name: 'plugin',
                  }),
                },
          ),
        ),
      'claude',
    );

    expect(projected.included.map((item) => item.source)).toEqual([
      'agent',
      'explicit',
      'inherited',
    ]);
    expect(projected.included.map((item) => item.id)).toEqual([
      // `normalizePluginSelections` canonicalizes the 'builtin' sourceId
      // alias to 'builtin:app' before refs are resolved (it runs ahead of
      // `resolveEffectivePluginSelectionRefs` in `materializeDelegationCapabilities`),
      // so the item's id is computed from that canonical ref, not the raw
      // `skillRef` selection value — the same "canonical identity" rule the
      // plugin branch already applies via the marketplace's plugin name.
      delegationCapabilityIdForRef({
        kind: 'skill',
        sourceId: 'builtin:app',
        skillName: skillRef.skillName,
      }),
      delegationCapabilityIdForRef({ kind: 'plugin', ...pluginRef }),
      delegationCapabilityIdForRef({
        kind: 'mcp',
        serverId: 'github',
        configId: 'default',
      }),
    ]);
    expect(Object.values(projected.provenance.roots)).toEqual([
      'agent',
      'explicit',
    ]);
    expect(projected.provenance.mcpSelections).toEqual(['inherited']);
    expect(projected.capabilities.mcpSelections).toHaveLength(1);
    expect(JSON.stringify(projected)).not.toContain(hostSkillDirectory);
    expect(JSON.stringify(projected)).not.toContain('/plugins/plugin');
  });

  it('gives higher-priority layers the aggregate byte budget first', async () => {
    const refsBySource: Record<
      string,
      { sourceId: string; skillName: string }
    > = {
      first: { sourceId: 'builtin', skillName: 'first' },
      second: { sourceId: 'builtin', skillName: 'second' },
      third: { sourceId: 'builtin', skillName: 'third' },
    };
    resolveEffectivePluginSelectionRefs.mockImplementation(
      (selections: ChatTabPluginSelections) => ({
        skillRefs: selections.skillRefs,
        pluginRefs: [],
        mcpServerRefs: [],
        warnings: [],
      }),
    );
    resolveSelectedSkillDirectory.mockImplementation(
      (ref: { sourceId: string; skillName: string }) =>
        '/skills/' + ref.skillName,
    );
    const sizes: Record<string, number> = {
      first: 300_000,
      second: 300_000,
      third: 500_000,
    };
    const layers = [
      { source: 'inherited' as const, selections: refsBySource.third },
      { source: 'explicit' as const, selections: refsBySource.second },
      { source: 'agent' as const, selections: refsBySource.first },
    ].map((layer) => ({
      source: layer.source,
      selections: {
        collectionIds: [],
        skillRefs: [layer.selections],
        pluginRefs: [],
      },
    }));

    const projected = await materializeDelegationCapabilities(
      layers,
      (directory) => {
        const skillName = path.basename(directory);
        return Promise.resolve(
          reader({ 'SKILL.md': 'x'.repeat(sizes[skillName] ?? 0) }),
        );
      },
      'claude',
    );

    expect(projected.included.map((item) => item.source)).toEqual([
      'agent',
      'explicit',
    ]);
    expect(projected.skipped).toEqual([
      expect.objectContaining({
        kind: 'skill',
        name: 'third',
        reason: 'unavailable_asset',
      }),
    ]);
  });

  it('reports missing Collections without discarding other resolved refs', async () => {
    resolveEffectivePluginSelectionRefs.mockImplementation(
      (selections: ChatTabPluginSelections) => ({
        skillRefs: selections.skillRefs,
        pluginRefs: [],
        mcpServerRefs: [],
        warnings: ['Collection missing, skipping.'],
      }),
    );
    resolveSelectedSkillDirectory.mockReturnValue('/skills/review');

    const projected = await materializeDelegationCapabilities(
      [
        {
          source: 'inherited',
          selections: {
            collectionIds: ['missing'],
            skillRefs: [{ sourceId: 'builtin', skillName: 'review' }],
            pluginRefs: [],
          },
        },
      ],
      () => Promise.resolve(reader({ 'SKILL.md': '# Review' })),
      'claude',
    );

    expect(projected.layerWarnings).toEqual([
      { source: 'inherited', reason: 'missing_selection' },
    ]);
    expect(projected.included).toHaveLength(1);
  });

  it('uses the content cache across materializations of the same items', async () => {
    resolveEffectivePluginSelectionRefs.mockResolvedValue({
      skillRefs: [{ sourceId: 'builtin', skillName: 'review' }],
      pluginRefs: [{ marketplaceId: 'market', pluginName: 'plugin' }],
      mcpServerRefs: [],
      warnings: [],
    });
    resolveSelectedSkillDirectory.mockReturnValue('/skills/review');
    resolvePluginInfoPath.mockResolvedValue('/plugins/plugin');
    const cache = new DelegationCapabilityCache({
      digest: (): Promise<string> => Promise.resolve('unchanged'),
    });
    const opened = new Map<string, number>();
    const openFiles = jest.fn((directory: string) => {
      opened.set(directory, (opened.get(directory) ?? 0) + 1);
      return Promise.resolve(
        reader(
          directory === '/skills/review'
            ? { 'SKILL.md': '# Review' }
            : {
                '.claude-plugin/plugin.json': JSON.stringify({
                  name: 'plugin',
                }),
              },
        ),
      );
    });
    const layer = {
      source: 'inherited' as const,
      selections: { collectionIds: [], skillRefs: [], pluginRefs: [] },
    };
    const first = await materializeDelegationCapabilities(
      [layer],
      openFiles,
      'claude',
      { cache },
    );
    const second = await materializeDelegationCapabilities(
      [layer],
      openFiles,
      'claude',
      { cache },
    );

    expect(Array.from(opened.entries())).toEqual([
      ['/skills/review', 1],
      ['/plugins/plugin', 1],
    ]);
    expect(first.files).toEqual(second.files);
  });

  it('reads each tree once across concurrent materializations sharing a cache', async () => {
    resolveEffectivePluginSelectionRefs.mockResolvedValue({
      skillRefs: [{ sourceId: 'builtin', skillName: 'review' }],
      pluginRefs: [{ marketplaceId: 'market', pluginName: 'plugin' }],
      mcpServerRefs: [],
      warnings: [],
    });
    resolveSelectedSkillDirectory.mockReturnValue('/skills/review');
    resolvePluginInfoPath.mockResolvedValue('/plugins/plugin');
    const cache = new DelegationCapabilityCache({
      digest: (): Promise<string> => Promise.resolve('unchanged'),
    });
    const opened = new Map<string, number>();
    const openFiles = jest.fn((directory: string) => {
      opened.set(directory, (opened.get(directory) ?? 0) + 1);
      return Promise.resolve(
        reader(
          directory === '/skills/review'
            ? { 'SKILL.md': '# Review' }
            : {
                '.claude-plugin/plugin.json': JSON.stringify({
                  name: 'plugin',
                }),
              },
        ),
      );
    });
    const layer = {
      source: 'inherited' as const,
      selections: { collectionIds: [], skillRefs: [], pluginRefs: [] },
    };

    // Two "sibling" materializations (e.g. a swarm spawn) sharing one cache,
    // issued concurrently rather than sequentially: the in-flight dedupe in
    // `DelegationCapabilityCache.readTree` must collapse both readers' skill
    // and plugin tree reads into a single `openFiles` call each, exactly as
    // the sequential case does.
    const [first, second] = await Promise.all([
      materializeDelegationCapabilities([layer], openFiles, 'claude', {
        cache,
      }),
      materializeDelegationCapabilities([layer], openFiles, 'claude', {
        cache,
      }),
    ]);

    expect(Array.from(opened.entries())).toEqual([
      ['/skills/review', 1],
      ['/plugins/plugin', 1],
    ]);
    expect(first.files).toEqual(second.files);
  });

  it("skips a single layer's later items in ref order once the aggregate budget is spent", async () => {
    const sizes: Record<string, number> = {
      alpha: 400_000,
      beta: 400_000,
      gamma: 400_000,
    };
    resolveEffectivePluginSelectionRefs.mockImplementation(
      (selections: ChatTabPluginSelections) => ({
        skillRefs: selections.skillRefs,
        pluginRefs: [],
        mcpServerRefs: [],
        warnings: [],
      }),
    );
    resolveSelectedSkillDirectory.mockImplementation(
      (ref: { sourceId: string; skillName: string }) =>
        '/skills/' + ref.skillName,
    );

    // A single 'inherited' layer with three items: the first two fit inside
    // the 1,000,000 byte aggregate budget, the third does not. The skip must
    // land on the later item in ref order — not the smallest, not a random
    // one — so a delegate's included set never depends on skip evaluation
    // order alone.
    const projected = await materializeDelegationCapabilities(
      [
        {
          source: 'inherited',
          selections: {
            collectionIds: [],
            skillRefs: [
              { sourceId: 'builtin', skillName: 'alpha' },
              { sourceId: 'builtin', skillName: 'beta' },
              { sourceId: 'builtin', skillName: 'gamma' },
            ],
            pluginRefs: [],
          },
        },
      ],
      (directory) => {
        const skillName = path.basename(directory);
        return Promise.resolve(
          reader({ 'SKILL.md': 'x'.repeat(sizes[skillName] ?? 0) }),
        );
      },
      'claude',
    );

    expect(projected.included.map((item) => item.name)).toEqual([
      'alpha',
      'beta',
    ]);
    expect(projected.skipped).toEqual([
      expect.objectContaining({
        kind: 'skill',
        name: 'gamma',
        reason: 'unavailable_asset',
      }),
    ]);
  });

  it('keeps no host filesystem directory path in the materialized result', async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), 'delegation-no-paths-'),
    );
    try {
      const serverFile = path.join(directory, 'server.json');
      await writeFile(
        serverFile,
        JSON.stringify({
          version: 1,
          server: {
            definition: {
              id: 'server',
              name: 'Server',
              description: '',
              type: 'http',
              url: 'https://example.test/mcp',
              createdAt: '2026-09-23T00:00:00.000Z',
              updatedAt: '2026-09-23T00:00:00.000Z',
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
                createdAt: '2026-09-23T00:00:00.000Z',
                updatedAt: '2026-09-23T00:00:00.000Z',
              },
            ],
          },
        }),
      );
      // Chosen independently of the skill/plugin/server identities below so
      // a safe, hash-namespaced output path (e.g. `skills/<hash>/skills/
      // review/SKILL.md`) can never coincidentally collide with — and mask a
      // regression in — the leaked-path assertions.
      const skillDirectory = path.join(directory, 'skill-source');
      const pluginDirectory = path.join(directory, 'plugin-source');
      getMcpServerFilePath.mockReturnValue(serverFile);
      resolveSelectedSkillDirectory.mockReturnValue(skillDirectory);
      resolvePluginInfoPath.mockResolvedValue(pluginDirectory);
      resolveEffectivePluginSelectionRefs.mockResolvedValue({
        skillRefs: [{ sourceId: 'builtin', skillName: 'review' }],
        pluginRefs: [{ marketplaceId: 'market', pluginName: 'plugin' }],
        mcpServerRefs: [{ serverId: 'server', configId: 'default' }],
        warnings: [],
      });

      const projected = await materializeDelegationCapabilities(
        [
          {
            source: 'agent',
            selections: {
              collectionIds: [],
              skillRefs: [{ sourceId: 'builtin', skillName: 'review' }],
              pluginRefs: [],
            },
          },
          {
            source: 'explicit',
            selections: {
              collectionIds: [],
              skillRefs: [],
              pluginRefs: [{ marketplaceId: 'market', pluginName: 'plugin' }],
            },
          },
          {
            source: 'inherited',
            selections: {
              collectionIds: [],
              skillRefs: [],
              pluginRefs: [],
              mcpServerRefs: [{ serverId: 'server', configId: 'default' }],
            },
          },
        ],
        (openDirectory) =>
          Promise.resolve(
            reader(
              openDirectory === skillDirectory
                ? { 'SKILL.md': '# Review' }
                : {
                    '.claude-plugin/plugin.json': JSON.stringify({
                      name: 'plugin',
                    }),
                  },
            ),
          ),
        'claude',
      );

      expect(projected.included).toHaveLength(3);
      expect(projected.skipped).toHaveLength(0);
      const serialized = JSON.stringify(projected);
      expect(serialized).not.toContain(directory);
      expect(serialized).not.toContain(skillDirectory);
      expect(serialized).not.toContain(pluginDirectory);
      expect(serialized).not.toContain(serverFile);
      expect(serialized).not.toContain(os.tmpdir());
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('names item-specific errors safely and maps skip reasons', () => {
    const error = new DelegationAgentCapabilityError('unsupported_hooks', {
      kind: 'plugin',
      name: 'Review\nPlugin',
    });

    expect(error.publicMessage).toBe(
      'The plugin "Review Plugin" can\'t be given to this delegate: it uses plugin hooks or monitors.',
    );
    expect(error.message).toBe(error.publicMessage);
    expect(error.message).not.toContain('/skills/');
    expect(error.item).toEqual({
      kind: 'plugin',
      name: 'Review\nPlugin',
    });
    expect(
      new DelegationAgentCapabilityError('missing_selection', {
        kind: 'mcp',
        name: 'GitHub',
      }).message,
    ).toBe(
      'The MCP server "GitHub" can\'t be given to this delegate: it is not installed or is turned off.',
    );
    expect(delegationCapabilitySkipReason('invalid_projection')).toBe(
      'unsupported_capability',
    );
    expect(delegationCapabilitySkipReason('config_changed')).toBe(
      'missing_selection',
    );
    expect(delegationCapabilitySkipReason('unsupported_lsp')).toBe(
      'unsupported_lsp',
    );
    expect(delegationCapabilitySkipReason('unsupported_skill_execution')).toBe(
      'unsupported_skill_execution',
    );
    expect(delegationCapabilitySkipReason('unavailable_asset')).toBe(
      'unavailable_asset',
    );
    expect(delegationCapabilitySkipReason('unsupported_capability')).toBe(
      'unsupported_capability',
    );
    expect(delegationCapabilitySkipReason('unsupported_hooks')).toBe(
      'unsupported_hooks',
    );
    expect(delegationCapabilitySkipReason('missing_selection')).toBe(
      'missing_selection',
    );
  });
});

describe('capturing materialized parent home capabilities', () => {
  beforeEach(() => {
    projectClaudePluginForCodex.mockImplementation(
      actualProjectClaudePluginForCodex,
    );
  });

  it.each([
    [
      'hooks',
      '---\nname: unsafe\nhooks:\n  PreToolUse:\n    - matcher: "*"\n      hooks:\n        - type: command\n          command: "printf unmanaged"\n---\nReview changes.',
    ],
    ['fork context', '---\nname: unsafe\ncontext: fork\n---\nReview changes.'],
    [
      'agent override',
      '---\nname: unsafe\nagent: Explore\n---\nReview changes.',
    ],
    ['shell preprocessing', '---\nname: unsafe\n---\n!`printf unmanaged`'],
  ])(
    'does not retain inherited skills or commands with %s',
    async (_kind, markdown) => {
      const files = reader({
        'skills/unsafe-skill/SKILL.md': markdown,
        'commands/unsafe-command.md': markdown,
      });
      const captured = await captureHomeCapabilities({
        root: '/private/materialized',
        signal: new AbortController().signal,
        open: () => Promise.resolve(files),
        prepared: {
          skillIds: ['unsafe-skill'],
          commandIds: ['unsafe-command'],
        },
        projection: {
          skills: [
            {
              id: 'unsafe-skill',
              label: 'Unsafe skill',
              description: 'Unsafe',
              sourceDir: '/ambient/never-read',
              source: {
                kind: 'inherited_skill',
                name: 'unsafe-skill',
                origin: 'claude',
              },
            },
          ],
          commands: [
            {
              id: 'unsafe-command',
              label: 'Unsafe command',
              description: 'Unsafe',
              markdown: 'Read the prepared copy',
              source: {
                kind: 'inherited_command',
                name: 'unsafe-command',
                origin: 'claude',
              },
            },
          ],
        },
      });
      expect(captured.overlay).toBeUndefined();
      expect(captured.skipped).toEqual(['unsafe-skill', 'unsafe-command']);
      expect(files.close).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    ['PDF Helper', 'pdf-helper'],
    ['PDF:Review', 'pdf-review'],
    ['Review/Plan', 'review-plan'],
  ])('normalizes the retained invocation name %s', async (name, expected) => {
    const captured = await captureHomeCapabilities({
      root: '/private/materialized',
      signal: new AbortController().signal,
      open: () =>
        Promise.resolve(
          reader({
            'skills/review/SKILL.md': `---\nname: ${name}\ndescription: Review\n---\nSafe instructions.`,
          }),
        ),
      prepared: { skillIds: ['review'], commandIds: [] },
      projection: {
        skills: [
          {
            id: 'review',
            label: 'Review',
            description: 'Review',
            sourceDir: '/ambient/never-read',
            source: {
              kind: 'inherited_skill',
              name: 'review',
              origin: 'claude',
            },
          },
        ],
        commands: [],
      },
    });
    expect(captured.skipped).toEqual([]);
    expect(captured.overlay?.capabilities.claudeSkillNames).toEqual([
      `review:${expected}`,
    ]);
  });

  it('retains an installed MCP-only plugin without opening ambient files', async () => {
    const open = jest.fn(() => Promise.resolve(reader({})));
    const input = {
      root: '/private/materialized',
      signal: new AbortController().signal,
      open,
      prepared: { skillIds: [], commandIds: [] },
      projection: { skills: [], commands: [] },
      inheritedPluginBindings: [
        {
          marketplaceId: 'market',
          pluginName: 'tool',
          installationDigest: 'b'.repeat(64),
          mcpServers: [{ serverName: 'review', configDigest: 'a'.repeat(64) }],
          mcpHttpAuthPreferences: [],
        },
      ],
    };
    const captured = await captureHomeCapabilities(input);
    expect(open).not.toHaveBeenCalled();
    expect(captured.skipped).toEqual([]);
    expect(captured.overlay?.homeEntries).toEqual([
      expect.objectContaining({
        kind: 'plugin',
        pluginRef: { marketplaceId: 'market', pluginName: 'tool' },
      }),
    ]);
    expect(captured.overlay?.capabilities.mcpSelections).toEqual([
      expect.objectContaining({
        source: 'inherited-plugin',
        marketplaceId: 'market',
        pluginName: 'tool',
        serverName: 'review',
        installationDigest: 'b'.repeat(64),
        configDigest: 'a'.repeat(64),
      }),
    ]);
    expect(Object.keys(captured.overlay?.pluginFiles ?? {})).not.toHaveLength(
      0,
    );
    expect(captured.overlay?.provenance.mcpSelections).toEqual(['inherited']);
    expect(JSON.stringify(captured)).not.toContain('/private/materialized');
  });

  it('retains only prepared members of the parent resolved inherited plugins', async () => {
    const files = reader({
      'skills/installed-review/SKILL.md':
        '---\nname: installed-review\ndescription: Review changes\n---\nFROZEN_PLUGIN_RULES\n',
    });
    const open = jest.fn(() => Promise.resolve(files));
    const input = {
      root: '/private/materialized',
      signal: new AbortController().signal,
      open,
      prepared: {
        skillIds: ['installed-review', 'picked-review'],
        commandIds: [],
      },
      inheritedPluginBindings: [
        {
          marketplaceId: 'market',
          pluginName: 'tool',
          installationDigest: 'b'.repeat(64),
          mcpServers: [],
          mcpHttpAuthPreferences: [],
        },
      ],
      projection: {
        skills: [
          {
            id: 'installed-review',
            description: 'Review',
            label: 'tool:review',
            sourceDir: '/ambient/never-read',
            source: {
              kind: 'plugin_skill' as const,
              marketplaceId: 'market',
              pluginName: 'tool',
              memberName: 'review',
            },
          },
          {
            id: 'picked-review',
            description: 'Picked',
            label: 'picked:review',
            sourceDir: '/ambient/selected',
            source: {
              kind: 'plugin_skill' as const,
              marketplaceId: 'market',
              pluginName: 'picked',
              memberName: 'review',
            },
          },
        ],
        commands: [],
      },
    };
    const captured = await captureHomeCapabilities(input);
    expect(captured.skipped).toEqual([]);
    expect(captured.overlay?.homeEntries).toEqual([
      expect.objectContaining({
        kind: 'plugin',
        name: 'tool',
        origin: 'claude',
      }),
    ]);
    expect(
      Object.values(captured.overlay?.pluginFiles ?? {}).join('\n'),
    ).toContain('FROZEN_PLUGIN_RULES');
    expect(JSON.stringify(captured.overlay)).not.toMatch(
      /ambient|picked-review/,
    );
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('retains prepared skill resources and command text without opening ambient sources', async () => {
    const files = reader({
      'skills/reviewer/SKILL.md':
        '---\nname: reviewer\ndescription: Review changes\n---\nRead references/rules.md.\n',
      'skills/reviewer/references/rules.md': 'FROZEN_RULES',
      'commands/check.md': '# Check changes\n\nFROZEN_COMMAND $ARGUMENTS',
    });
    const open = jest.fn(() => Promise.resolve(files));
    const result = await captureHomeCapabilities({
      root: '/private/materialized',
      signal: new AbortController().signal,
      open,
      prepared: { skillIds: ['reviewer', 'selected'], commandIds: ['check'] },
      projection: {
        skills: [
          {
            id: 'reviewer',
            description: 'Review',
            label: 'Reviewer',
            sourceDir: '/ambient/never-read',
            source: {
              kind: 'inherited_skill',
              name: 'reviewer',
              origin: 'agents',
            },
          },
          {
            id: 'selected',
            description: 'Explicit',
            label: 'Explicit',
            sourceDir: '/ambient/explicit',
            source: {
              kind: 'skill',
              sourceId: 'source',
              skillName: 'explicit',
            },
          },
          {
            id: 'failed',
            description: 'Missing',
            label: 'Missing',
            sourceDir: '/ambient/missing',
            source: {
              kind: 'inherited_skill',
              name: 'missing',
              origin: 'codex',
            },
          },
        ],
        commands: [
          {
            id: 'check',
            description: 'Check',
            label: 'Check',
            markdown: 'NOT_THE_PREPARED_COPY',
            source: {
              kind: 'inherited_command',
              name: 'check',
              origin: 'claude',
            },
          },
        ],
      },
    });
    expect(open).toHaveBeenCalledWith(
      '/private/materialized',
      expect.any(AbortSignal),
    );
    expect(files.close).toHaveBeenCalledTimes(1);
    expect(result.skipped).toEqual([]);
    expect(result.overlay?.homeEntries).toEqual([
      {
        root: 'home/reviewer',
        kind: 'skill',
        name: 'reviewer',
        origin: 'agents',
      },
      { root: 'home/check', kind: 'command', name: 'check', origin: 'claude' },
    ]);
    expect(
      result.overlay?.pluginFiles[
        'home/reviewer/skills/reviewer/references/rules.md'
      ],
    ).toBe('FROZEN_RULES');
    expect(
      result.overlay?.pluginFiles['home/check/commands/check.md'],
    ).toContain('FROZEN_COMMAND');
    expect(JSON.stringify(result.overlay)).not.toContain(
      'NOT_THE_PREPARED_COPY',
    );
    expect(JSON.stringify(result.overlay)).not.toContain('/ambient');
    expect(result.overlay?.capabilities.codexCapabilityRoots).toEqual([
      'home/reviewer',
      'home/check',
    ]);
    expect(
      result.overlay?.pluginFiles['home/check/skills/check/SKILL.md'],
    ).toContain('FROZEN_COMMAND');
    expect(result.overlay?.capabilities.mcpSelections).toEqual([]);
  });

  it('skips an unreadable capability without publishing a partial root', async () => {
    const files = reader({});
    jest
      .mocked(files.read)
      .mockRejectedValue(new Error('private path must not escape'));
    const result = await captureHomeCapabilities({
      root: '/private/materialized',
      signal: new AbortController().signal,
      open: () => Promise.resolve(files),
      prepared: { skillIds: [], commandIds: ['check'] },
      projection: {
        skills: [],
        commands: [
          {
            id: 'check',
            description: 'Check',
            label: 'Check',
            markdown: '',
            source: {
              kind: 'inherited_command',
              name: 'check',
              origin: 'claude',
            },
          },
        ],
      },
    });
    expect(result.overlay).toBeUndefined();
    expect(result.skipped).toEqual(['check']);
    expect(files.close).toHaveBeenCalledTimes(1);
  });

  it('does not suppress cancellation as a skipped home capability', async () => {
    const abort = new AbortController();
    const files = reader({});
    await expect(
      captureHomeCapabilities({
        root: '/private/materialized',
        signal: abort.signal,
        open: () => {
          abort.abort();
          return Promise.resolve(files);
        },
        prepared: { skillIds: [], commandIds: ['check'] },
        projection: {
          skills: [],
          commands: [
            {
              id: 'check',
              description: 'Check',
              label: 'Check',
              markdown: '',
              source: {
                kind: 'inherited_command',
                name: 'check',
                origin: 'claude',
              },
            },
          ],
        },
      }),
    ).rejects.toThrow();
    expect(files.close).toHaveBeenCalledTimes(1);
  });
});
