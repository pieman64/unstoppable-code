import {
  ambientCodexMcpServerNames,
  CODEX_PROJECT_DOC_THREAD_CONFIG,
  enabledCodexMcpServerNames,
  excludeAmbientCodexMcpServers,
  flattenCodexThreadConfig,
  omitCodexMcpServersFromThreadConfig,
} from '../thread-config';

describe('CODEX_PROJECT_DOC_THREAD_CONFIG', () => {
  it('cannot be changed through a launch config that spreads it', () => {
    const launchConfig = { ...CODEX_PROJECT_DOC_THREAD_CONFIG };

    expect(() =>
      launchConfig.project_doc_fallback_filenames.push('GEMINI.md'),
    ).toThrow(TypeError);
    expect(CODEX_PROJECT_DOC_THREAD_CONFIG).toEqual({
      project_doc_max_bytes: 131_072,
      project_doc_fallback_filenames: ['CLAUDE.md'],
    });
  });
});

describe('enabledCodexMcpServerNames', () => {
  it('includes enabled nested and dotted declarations but excludes disabled servers', () => {
    expect(
      enabledCodexMcpServerNames({
        mcp_servers: {
          selected: { url: 'http://127.0.0.1/selected' },
          disabled: {
            url: 'http://127.0.0.1/disabled',
            enabled: false,
          },
        },
        'mcp_servers.dotted': {
          command: '/opt/dotted',
        },
        'mcp_servers.disabled_dotted.enabled': false,
      }),
    ).toEqual(['selected', 'dotted']);
  });
});

describe('flattenCodexThreadConfig', () => {
  it('makes MCP startup optional at the runtime boundary without mutating the selected snapshot', () => {
    const config = {
      mcp_servers: {
        legacy: { command: '/opt/server', required: true },
        disabled: {
          url: 'https://example.test',
          enabled: false,
          required: true,
        },
      },
    };
    expect(flattenCodexThreadConfig(config)).toEqual({
      mcp_servers: {
        legacy: { command: '/opt/server', required: false },
        disabled: {
          url: 'https://example.test',
          enabled: false,
          required: false,
        },
      },
    });
    expect(config.mcp_servers.legacy.required).toBe(true);
  });

  it('makes dotted MCP declarations optional too', () => {
    expect(
      flattenCodexThreadConfig({
        'mcp_servers.selected': { command: '/opt/server', required: true },
        'mcp_servers.other.url': 'https://example.test',
        'mcp_servers.other.required': true,
      }),
    ).toEqual({
      'mcp_servers.selected': { command: '/opt/server', required: false },
      'mcp_servers.other.url': 'https://example.test',
      'mcp_servers.other.required': false,
    });
  });

  it('projects nested provider and MCP tables into app-server override keys', () => {
    expect(
      flattenCodexThreadConfig(
        {
          model_provider: 'canopy',
          model_providers: {
            canopy: {
              base_url: 'http://127.0.0.1:1234/v1',
              requires_openai_auth: false,
            },
          },
          mcp_servers: {
            selected: {
              command: '/opt/canopy',
              args: ['__codex-mcp-stdio-launcher', 'capability', 'route'],
            },
          },
        },
        { resetMcpServers: true },
      ),
    ).toEqual({
      mcp_servers: {
        selected: {
          command: '/opt/canopy',
          args: ['__codex-mcp-stdio-launcher', 'capability', 'route'],
          required: false,
        },
      },
      model_provider: 'canopy',
      'model_providers.canopy': {
        base_url: 'http://127.0.0.1:1234/v1',
        requires_openai_auth: false,
      },
    });
  });

  it('preserves explicit dotted keys and empty table resets', () => {
    expect(
      flattenCodexThreadConfig({
        'features.multi_agent': true,
        'features.memories': false,
        mcp_servers: {},
      }),
    ).toEqual({
      'features.multi_agent': true,
      'features.memories': false,
      mcp_servers: {},
    });
  });

  it('projects a report-only permission profile without restoring MCP servers', () => {
    expect(
      flattenCodexThreadConfig(
        {
          permissions: {
            canopy_report_only: {
              filesystem: { ':minimal': 'read' },
              network: { enabled: false },
            },
          },
          mcp_servers: {},
        },
        { resetMcpServers: true },
      ),
    ).toEqual({
      'permissions.canopy_report_only': {
        filesystem: { ':minimal': 'read' },
        network: { enabled: false },
      },
      mcp_servers: {},
    });
  });

  it('clears canonical MCP servers for a new thread with no selected servers', () => {
    expect(
      flattenCodexThreadConfig(undefined, { resetMcpServers: true }),
    ).toEqual({
      mcp_servers: {},
    });
  });

  it('does not alter persisted MCP configuration on resume or native fork', () => {
    expect(flattenCodexThreadConfig(undefined)).toBeUndefined();
  });
});

describe('ambientCodexMcpServerNames', () => {
  it('lists enabled servers from the effective config', () => {
    expect(
      ambientCodexMcpServerNames({
        config: {
          model: 'gpt',
          mcp_servers: {
            telegram: { command: 'npx' },
            node_repl: { command: '/opt/node_repl', enabled: true },
            off: { command: '/opt/off', enabled: false },
          },
        },
        origins: {},
        layers: null,
      }),
    ).toEqual(['telegram', 'node_repl']);
  });

  it('returns no names for responses without an MCP table', () => {
    expect(ambientCodexMcpServerNames({})).toEqual([]);
    expect(ambientCodexMcpServerNames({ config: { mcp_servers: [] } })).toEqual(
      [],
    );
    expect(ambientCodexMcpServerNames(null)).toEqual([]);
  });
});

describe('excludeAmbientCodexMcpServers', () => {
  it('disables ambient servers inside an empty replacement table', () => {
    expect(
      excludeAmbientCodexMcpServers(
        flattenCodexThreadConfig(undefined, { resetMcpServers: true }),
        ['telegram', 'node_repl'],
      ),
    ).toEqual({
      mcp_servers: {
        telegram: { enabled: false },
        node_repl: { enabled: false },
      },
    });
  });

  it('keeps selected servers and disables only the unselected ambient ones', () => {
    expect(
      excludeAmbientCodexMcpServers(
        {
          model: 'gpt',
          mcp_servers: {
            chosen: { url: 'http://127.0.0.1/chosen', required: false },
            telegram: { command: 'npx', required: false },
          },
        },
        ['telegram', 'node_repl'],
      ),
    ).toEqual({
      model: 'gpt',
      mcp_servers: {
        chosen: { url: 'http://127.0.0.1/chosen', required: false },
        telegram: { command: 'npx', required: false },
        node_repl: { enabled: false },
      },
    });
  });

  it('folds dotted MCP overrides into the replacement table', () => {
    // Codex drops dotted `mcp_servers.*` keys sent beside a root table, so
    // every MCP override must travel in the one table.
    expect(
      excludeAmbientCodexMcpServers(
        {
          mcp_servers: {},
          'mcp_servers.dotted': { command: '/opt/dotted', required: false },
          'mcp_servers.partial.url': 'https://example.test',
          'mcp_servers.partial.env.TOKEN_REF': 'broker',
          'mcp_servers.partial.required': false,
        },
        ['telegram'],
      ),
    ).toEqual({
      mcp_servers: {
        dotted: { command: '/opt/dotted', required: false },
        partial: {
          url: 'https://example.test',
          env: { TOKEN_REF: 'broker' },
          required: false,
        },
        telegram: { enabled: false },
      },
    });
  });

  it('uses dotted disables when the request has no replacement table', () => {
    expect(
      excludeAmbientCodexMcpServers(
        {
          model: 'gpt',
          'mcp_servers.chosen': { command: '/opt/chosen' },
        },
        ['telegram', 'chosen'],
      ),
    ).toEqual({
      model: 'gpt',
      'mcp_servers.chosen': { command: '/opt/chosen' },
      'mcp_servers.telegram.enabled': false,
    });
    expect(excludeAmbientCodexMcpServers(undefined, ['telegram'])).toEqual({
      'mcp_servers.telegram.enabled': false,
    });
  });

  it('leaves the request unchanged when nothing ambient needs disabling', () => {
    const config = { mcp_servers: { chosen: { command: '/opt/chosen' } } };
    expect(excludeAmbientCodexMcpServers(config, [])).toBe(config);
    expect(excludeAmbientCodexMcpServers(config, ['chosen'])).toBe(config);
    expect(excludeAmbientCodexMcpServers(undefined, [])).toBeUndefined();
  });

  it('does not mutate the caller configuration', () => {
    const table = { chosen: { command: '/opt/chosen' } };
    const config = { mcp_servers: table, 'mcp_servers.extra.url': 'x' };
    excludeAmbientCodexMcpServers(config, ['telegram']);
    expect(config).toEqual({
      mcp_servers: { chosen: { command: '/opt/chosen' } },
      'mcp_servers.extra.url': 'x',
    });
    expect(table).toEqual({ chosen: { command: '/opt/chosen' } });
  });
});

describe('omitCodexMcpServersFromThreadConfig', () => {
  it('keeps non-capability overrides while removing nested and dotted MCP replacements', () => {
    expect(
      omitCodexMcpServersFromThreadConfig({
        model_provider: 'canopy',
        model_providers: {
          canopy: {
            base_url: 'http://127.0.0.1:1234/v1',
          },
        },
        mcp_servers: {
          selected: {
            command: '/opt/canopy',
          },
        },
        'mcp_servers.legacy': {
          command: '/opt/legacy',
        },
      }),
    ).toEqual({
      model_provider: 'canopy',
      model_providers: {
        canopy: {
          base_url: 'http://127.0.0.1:1234/v1',
        },
      },
    });
  });

  it('returns undefined when MCP overrides were the only entries', () => {
    expect(
      omitCodexMcpServersFromThreadConfig({
        mcp_servers: {},
      }),
    ).toBeUndefined();
  });
});
