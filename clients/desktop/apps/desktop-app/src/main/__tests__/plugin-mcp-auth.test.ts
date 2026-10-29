import {
  buildPluginHttpMcpServerForAuth,
  hasPluginManagedAuth,
  getPluginMcpAuthNamespace,
} from '../plugins/plugin-mcp-auth';

describe('plugin mcp auth helpers', () => {
  it.each([
    [{ headers: { 'X-Tenant': 'team' } }, { headers: { 'x-tenant': 'team' } }],
    [
      { env_http_headers: { 'X-API-Key': 'PLUGIN_KEY' } },
      { env_http_headers: { 'x-api-key': 'PLUGIN_KEY' } },
    ],
    [
      { oauth: { scopes: ['read', 'write'] } },
      { oauth: { scopes: [' write ', 'read', 'read'] } },
    ],
  ])(
    'shares inventory and credentials for equivalent HTTP declarations: %j',
    (a, b) => {
      const identity = {
        marketplaceId: 'market',
        pluginName: 'plugin',
        serverName: 'vendor',
      };
      const primary = { url: 'https://vendor.test/mcp', ...a };
      const codex = { url: 'https://vendor.test/mcp', ...b };
      expect(getPluginMcpAuthNamespace(codex, primary)).toBeUndefined();
      expect(
        buildPluginHttpMcpServerForAuth(identity, codex, true)?.definition.id,
      ).toBe(
        buildPluginHttpMcpServerForAuth(identity, primary, true)?.definition.id,
      );
    },
  );

  it('does not collapse conflicting header values, bindings, or scope sets', () => {
    const primary = {
      url: 'https://vendor.test/mcp',
      headers: { 'X-Tenant': 'first', 'x-tenant': 'second' },
    };
    expect(
      getPluginMcpAuthNamespace(
        { ...primary, headers: { 'x-tenant': 'second' } },
        primary,
      ),
    ).toBe('codex');
    expect(
      getPluginMcpAuthNamespace(
        { url: primary.url, env_http_headers: { 'x-key': 'OTHER' } },
        { url: primary.url, env_http_headers: { 'X-Key': 'KEY' } },
      ),
    ).toBe('codex');
    expect(
      getPluginMcpAuthNamespace(
        { url: primary.url, oauth: { scopes: ['read', 'write'] } },
        { url: primary.url, oauth: { scopes: ['read'] } },
      ),
    ).toBe('codex');
  });

  it('binds credentials to the declaration independently of header order and environment values', () => {
    const identity = {
      marketplaceId: 'market',
      pluginName: 'plugin',
      serverName: 'server',
    };
    const id = (raw: Record<string, unknown>): string | undefined =>
      buildPluginHttpMcpServerForAuth(identity, raw, true)?.definition.id;
    const original = {
      url: 'https://vendor.test/mcp',
      oauth: { clientId: 'client' },
      headers: { Z: 'last', A: 'first' },
      bearer_token_env_var: 'PR3758_AUTH_ID_TEST_TOKEN',
    };
    const initial = id(original);
    expect(
      id({
        ...original,
        oauth: { client_id: 'client' },
        headers: { A: 'first', Z: 'last' },
      }),
    ).toBe(initial);
    const previous = process.env.PR3758_AUTH_ID_TEST_TOKEN;
    try {
      process.env.PR3758_AUTH_ID_TEST_TOKEN = 'changed-value';
      expect(id(original)).toBe(initial);
    } finally {
      if (previous === undefined) delete process.env.PR3758_AUTH_ID_TEST_TOKEN;
      else process.env.PR3758_AUTH_ID_TEST_TOKEN = previous;
    }
    for (const change of [
      { url: 'https://other.test/mcp' },
      { oauth: { clientId: 'other-client' } },
      { headers: { Authorization: 'other-credential' } },
      { bearer_token_env_var: 'OTHER_AUTH_ID_TEST_TOKEN' },
    ])
      expect(id({ ...original, ...change })).not.toBe(initial);
  });
  it('uses the same normalized URL for facet equivalence and credential identity', () => {
    const primary = {
      url: 'https://vendor.test:443/mcp#claude',
      oauth: { clientId: 'client' },
    };
    const codex = {
      url: 'https://vendor.test/mcp#codex',
      oauth: { client_id: 'client' },
    };
    expect(getPluginMcpAuthNamespace(codex, primary)).toBeUndefined();
    const identity = {
      marketplaceId: 'market',
      pluginName: 'plugin',
      serverName: 'vendor',
    };
    expect(
      buildPluginHttpMcpServerForAuth(identity, codex, true)?.definition.id,
    ).toBe(
      buildPluginHttpMcpServerForAuth(identity, primary, true)?.definition.id,
    );
  });

  it('keeps different environment bindings distinct even when current secrets match or are missing', () => {
    const names = ['PR3758_CLAUDE_AUTH', 'PR3758_CODEX_AUTH'] as const;
    const previous = names.map((name) => process.env[name]);
    const primary = {
      url: 'https://vendor.test/mcp',
      env_http_headers: { Authorization: names[0] },
    };
    const codex = {
      url: 'https://vendor.test/mcp',
      env_http_headers: { Authorization: names[1] },
    };
    try {
      for (const name of names) process.env[name] = 'matching-test-secret';
      expect(getPluginMcpAuthNamespace(codex, primary)).toBe('codex');
      for (const name of names) delete process.env[name];
      expect(getPluginMcpAuthNamespace(codex, primary)).toBe('codex');
    } finally {
      names.forEach((name, index) => {
        if (previous[index] === undefined) delete process.env[name];
        else process.env[name] = previous[index];
      });
    }
  });

  it('does not treat empty or ordinary static headers as managed auth', () => {
    expect(hasPluginManagedAuth({ headers: {} })).toBe(false);
    expect(hasPluginManagedAuth({ headers: { 'X-Base': 'base' } })).toBe(false);
  });

  it('detects auth-specific plugin header configuration', () => {
    expect(
      hasPluginManagedAuth({
        headers: { Authorization: 'Bearer token' },
      }),
    ).toBe(true);
    expect(
      hasPluginManagedAuth({
        env_http_headers: { 'X-API-Key': 'PLUGIN_API_KEY' },
      }),
    ).toBe(true);
  });
});
