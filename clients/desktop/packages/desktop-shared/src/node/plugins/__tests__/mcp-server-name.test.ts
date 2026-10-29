import {
  buildAccountMcpServerName,
  buildManagedMcpServerIdentityDigest,
  buildManagedMcpServerName,
  managedMcpServerFriendlyLabel,
  readManagedMcpServerNameDigest,
  MANAGED_MCP_SERVER_DIGEST_LENGTH,
  MANAGED_MCP_SERVER_NAME_MAX_LENGTH,
  normalizeManagedMcpServerLabel,
  type ManagedMcpServerKind,
} from '../mcp-server-name';

const WALLABY_SERVER_ID = '8130e671-b9ad-408e-b2f2-3e7563a6a8a9';
const WALLABY_CONFIG_ID = 'bc90c68e-1c34-426b-858d-7cda9af0fc85';
const PRODUCTION_HUB_TOOLS = [
  'query-gcp-logs',
  'get-registration-snapshot',
  'get-domain-dns-provider-records',
  'list_agentic_context_account_billing_profile_storages',
] as const;

describe('managed MCP server names', () => {
  it('normalizes labels with the resolver-compatible rules', () => {
    expect(normalizeManagedMcpServerLabel('  Production__Hub MCP  ')).toBe(
      'production-hub-mcp',
    );
    expect(normalizeManagedMcpServerLabel('Café / 東京 / API')).toBe('caf-api');
    expect(normalizeManagedMcpServerLabel(' 🚀 東京 ')).toBe('');
  });

  it('produces a deterministic versioned SHA-256 suffix from raw identity parts', () => {
    const args = {
      kind: 'dynamic' as const,
      friendlyParts: ['Production Hub MCP'],
      identityParts: ['server-id', 'config-id'],
    };

    expect(buildManagedMcpServerName(args)).toBe(
      'appdyn-production-hub-mcp--cb6c65b936a760bf',
    );
    expect(buildManagedMcpServerName(args)).toBe(
      buildManagedMcpServerName(args),
    );
    expect(buildManagedMcpServerName(args).split('--')[1]).toHaveLength(
      MANAGED_MCP_SERVER_DIGEST_LENGTH,
    );
  });

  it('keeps distinct identities and array boundaries distinct', () => {
    const build = (identityParts: readonly string[]): string =>
      buildManagedMcpServerName({
        kind: 'dynamic',
        friendlyParts: ['Same label'],
        identityParts,
      });

    expect(build(['server-a', 'config'])).not.toBe(
      build(['server-b', 'config']),
    );
    expect(build(['ab', 'c'])).not.toBe(build(['a', 'bc']));
    expect(build(['Server', 'config'])).not.toBe(build(['server', 'config']));

    const buildPlugin = (marketplaceId: string): string =>
      buildManagedMcpServerName({
        kind: 'plugin',
        friendlyParts: ['Plugin', 'Server'],
        identityParts: [marketplaceId, 'Plugin', 'Server'],
      });
    expect(buildPlugin('marketplace-one')).not.toBe(
      buildPlugin('marketplace-two'),
    );
  });

  it.each<[ManagedMcpServerKind, string]>([
    ['dynamic', 'appdyn'],
    ['proxy', 'appproxy'],
    ['plugin', 'appplugin'],
  ])('uses the %s prefix and caps the complete name', (kind, prefix) => {
    const name = buildManagedMcpServerName({
      kind,
      friendlyParts: [
        'A very long marketplace plugin or standalone server label that must be truncated',
      ],
      identityParts: ['identity-one', 'identity-two'],
    });

    expect(name.startsWith(`${prefix}-`)).toBe(true);
    expect(name).toHaveLength(MANAGED_MCP_SERVER_NAME_MAX_LENGTH);
    expect(name).toMatch(/^[a-z0-9-]+$/);
    expect(name).toMatch(/--[a-f0-9]{16}$/);
  });

  it('includes kind in the digest as well as the prefix', () => {
    const dynamic = buildManagedMcpServerName({
      kind: 'dynamic',
      friendlyParts: ['Server'],
      identityParts: ['server-id', 'config-id'],
    });
    const proxy = buildManagedMcpServerName({
      kind: 'proxy',
      friendlyParts: ['Server'],
      identityParts: ['server-id', 'config-id'],
    });

    expect(dynamic.split('--')[0]?.replace('appdyn', '')).toBe(
      proxy.split('--')[0]?.replace('appproxy', ''),
    );
    expect(dynamic.split('--')[1]).not.toBe(proxy.split('--')[1]);
  });

  it('joins only non-empty friendly parts and falls back to server', () => {
    expect(
      buildManagedMcpServerName({
        kind: 'dynamic',
        friendlyParts: ['🚀', 'Prod'],
        identityParts: ['server-id', 'config-id'],
      }),
    ).toMatch(/^appdyn-prod--[a-f0-9]{16}$/);
    expect(
      buildManagedMcpServerName({
        kind: 'plugin',
        friendlyParts: ['', '東京'],
        identityParts: ['marketplace', 'plugin', 'server'],
      }),
    ).toMatch(/^appplugin-server--[a-f0-9]{16}$/);
  });

  it('names an account-bound server by its connection, whichever selection asked', () => {
    // REG-3033: a standalone ref `{ serverId: 'linear', configId: 'default' }`
    // and the curated Linear plugin's member both resolve to the same account
    // connection. The name must not depend on which of them asked, or the
    // session loads the same upstream twice.
    const connection = {
      serverKey: 'linear',
      configId: 'default',
      displayName: 'Linear',
    };
    const bound = buildAccountMcpServerName(connection);

    expect(bound).toBe(
      buildManagedMcpServerName({
        kind: 'proxy',
        friendlyParts: ['Linear'],
        identityParts: ['linear', 'default'],
      }),
    );
    expect(bound).toMatch(/^appproxy-linear--[a-f0-9]{16}$/);
    // The plugin-source name for the same member is a different identity.
    expect(bound).not.toBe(
      buildManagedMcpServerName({
        kind: 'plugin',
        friendlyParts: ['linear', 'linear'],
        identityParts: ['curated/cloud', 'linear', 'linear'],
      }),
    );
    // Tool attribution reads the connection identity back from the name.
    expect(readManagedMcpServerNameDigest(bound)).toBe(
      buildManagedMcpServerIdentityDigest({
        kind: 'proxy',
        identityParts: ['linear', 'default'],
      }),
    );
    // A second config of the same key is a different connection.
    expect(bound).not.toBe(
      buildAccountMcpServerName({ ...connection, configId: 'work' }),
    );
    // Display labels never change identity.
    expect(readManagedMcpServerNameDigest(bound)).toBe(
      readManagedMcpServerNameDigest(
        buildAccountMcpServerName({
          ...connection,
          displayName: 'Linear (Personal)',
        }),
      ),
    );
  });

  it('pins the deferred-tools-reload E2E fixture name', () => {
    // apps/desktop-app/tests/electron/deferred-tools-reload.spec.mjs scripts
    // its mock provider to call `mcp__<this>__deferred_echo`, and cannot import
    // this builder because the spec is .mjs. Without this pin, a change to the
    // prefix, cap, digest length, or the versioned digest string surfaces there
    // as an opaque 90s poll timeout instead of a failure that names the cause.
    // Update both together.
    expect(
      buildManagedMcpServerName({
        kind: 'dynamic',
        friendlyParts: ['Deferred Reload Fixture'],
        identityParts: ['dr', 'd'],
      }),
    ).toBe('appdyn-deferred-reload-fixture--4413e6b1dd9abc47');
  });

  it('fits all observed Production Hub tool names without exposing full IDs', () => {
    const serverName = buildManagedMcpServerName({
      kind: 'proxy',
      friendlyParts: ['Production Hub MCP'],
      identityParts: [WALLABY_SERVER_ID, WALLABY_CONFIG_ID],
    });

    expect(serverName.length).toBeLessThanOrEqual(
      MANAGED_MCP_SERVER_NAME_MAX_LENGTH,
    );
    expect(serverName).not.toContain(WALLABY_SERVER_ID);
    expect(serverName).not.toContain(WALLABY_CONFIG_ID);
    for (const toolName of PRODUCTION_HUB_TOOLS) {
      expect(`mcp__${serverName}__${toolName}`.length).toBeLessThanOrEqual(128);
    }
  });
});

describe('managedMcpServerFriendlyLabel', () => {
  it('returns the friendly part of a managed name without its prefix or digest', () => {
    const name = buildManagedMcpServerName({
      kind: 'dynamic',
      friendlyParts: ['Unreachable'],
      identityParts: [WALLABY_SERVER_ID, WALLABY_CONFIG_ID],
    });
    expect(name.startsWith('appdyn-unreachable--')).toBe(true);
    expect(managedMcpServerFriendlyLabel(name)).toBe('unreachable');
    expect(
      managedMcpServerFriendlyLabel(
        buildManagedMcpServerName({
          kind: 'plugin',
          friendlyParts: ['slack', 'default'],
          identityParts: ['marketplace', 'slack'],
        }),
      ),
    ).toBe('slack-default');
  });

  it('leaves names it did not build alone', () => {
    expect(managedMcpServerFriendlyLabel('slack')).toBeUndefined();
    expect(managedMcpServerFriendlyLabel('appdyn-only')).toBeUndefined();
    expect(
      managedMcpServerFriendlyLabel('other-x--0123456789abcdef'),
    ).toBeUndefined();
  });
});
