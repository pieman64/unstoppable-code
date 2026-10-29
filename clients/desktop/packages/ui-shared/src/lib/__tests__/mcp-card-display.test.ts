import {
  deriveMcpConnectionBadge,
  mcpDeleteScopeDescription,
  mcpPlacementLabel,
  mcpRowSecondaryText,
  resolveMcpConnectionBadge,
} from '../mcp-card-display';

describe('mcpRowSecondaryText', () => {
  it('names the configuration of an account connection', () => {
    expect(mcpRowSecondaryText({ source: 'account', configName: 'Work' })).toBe(
      'Account connection · Work',
    );
    expect(mcpRowSecondaryText({ source: 'account' })).toBe(
      'Account connection',
    );
  });

  it('names the plugin an account server came from (REG-3030)', () => {
    expect(
      mcpRowSecondaryText({
        source: 'account',
        configName: 'default',
        viaPluginName: 'Linear',
      }),
    ).toBe('From the Linear plugin');
  });
});

describe('MCP connection badge derivation (CAN-4265)', () => {
  it('reads Not checked without a status', () => {
    expect(deriveMcpConnectionBadge(undefined)).toEqual({
      status: 'unknown',
      isProvider: false,
    });
  });

  it('degrades an unknown status value to Not checked', () => {
    expect(
      deriveMcpConnectionBadge({
        connectionStatus: 'degraded',
        reachability: 'reachable',
      }).status,
    ).toBe('unknown');
  });

  it('derives a provider server from reachability only', () => {
    expect(
      deriveMcpConnectionBadge({
        connectionStatus: 'auth_required',
        reachability: 'unreachable',
        handler: 'provider',
      }),
    ).toEqual({ status: 'unreachable', isProvider: true });
  });

  it('prefers cached status over the account connection state', () => {
    expect(
      resolveMcpConnectionBadge(
        { connectionStatus: 'unreachable', reachability: 'unreachable' },
        'CONNECTED',
      ).status,
    ).toBe('unreachable');
  });

  it.each([
    ['CONNECTED', 'connected'],
    ['REAUTH_REQUIRED', 'auth_required'],
    ['PENDING', 'unknown'],
    ['DISCONNECTED', 'unknown'],
    [undefined, 'unknown'],
  ] as const)('maps account state %s to %s', (account, expected) => {
    expect(resolveMcpConnectionBadge(undefined, account).status).toBe(expected);
  });

  it('names placement and the scope a deletion removes', () => {
    expect(mcpPlacementLabel('device')).toBe('This device');
    expect(mcpDeleteScopeDescription('Acme', 'device')).toContain(
      'from this device',
    );
    expect(mcpDeleteScopeDescription('Acme', 'cloud')).toContain(
      'cloud account',
    );
  });
});

it('does not turn unchecked pending/disconnected account inventory into an auth failure (CAN-4265)', () => {
  const inventory = {
    handler: 'account',
    connectionStatus: 'auth_required',
    reachability: 'unknown',
    configs: [{ configId: 'default', authStatus: 'not_connected' }],
  };
  expect(resolveMcpConnectionBadge(inventory, 'PENDING').status).toBe(
    'unknown',
  );
  expect(resolveMcpConnectionBadge(inventory, 'DISCONNECTED').status).toBe(
    'unknown',
  );
  expect(
    resolveMcpConnectionBadge(
      {
        ...inventory,
        connectionStatus: 'unreachable',
        reachability: 'unreachable',
        lastCheckedAt: '2026-10-19T00:00:00Z',
      },
      'CONNECTED',
    ).status,
  ).toBe('unreachable');
});
