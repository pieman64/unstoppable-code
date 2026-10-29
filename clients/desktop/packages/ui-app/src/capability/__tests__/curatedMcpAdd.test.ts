import type { CuratedMcpServerEntry } from '@canopy/protocol/mcp-catalog';
import { curatedMcpAddTarget } from '../curatedMcpAdd';

function entry(
  overrides: Partial<CuratedMcpServerEntry> = {},
): CuratedMcpServerEntry {
  return {
    key: 'linear',
    name: 'Linear',
    shortDescription: 'Linear integration',
    url: 'https://mcp.linear.app/mcp',
    transport: 'http',
    categories: [],
    popular: false,
    sortOrder: 0,
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('curatedMcpAddTarget (REG-3033)', () => {
  it('creates an account connection when the flag is on, the account is available, and the entry is not desktop-only', (): void => {
    expect(
      curatedMcpAddTarget(entry(), {
        accountConnectionsEnabled: true,
        accountConnectionsAvailable: true,
      }),
    ).toEqual({ kind: 'account', serverKey: 'linear', configId: 'default' });
    expect(
      curatedMcpAddTarget(entry(), {
        accountConnectionsEnabled: true,
        accountConnectionsAvailable: true,
        configId: 'work',
      }),
    ).toEqual({ kind: 'account', serverKey: 'linear', configId: 'work' });
  });

  it('creates a device file carrying the curated key and the app handler when the flag is off', (): void => {
    expect(
      curatedMcpAddTarget(entry(), {
        accountConnectionsEnabled: false,
        accountConnectionsAvailable: true,
      }),
    ).toEqual({
      kind: 'device',
      curatedKey: 'linear',
      httpAuthHandler: 'canopy',
    });
  });

  it.each([
    ['the account list is unavailable', { accountConnectionsAvailable: false }],
    ['the account list is unknown', { accountConnectionsAvailable: undefined }],
  ])('falls back to a device file when %s', (_label, context): void => {
    expect(
      curatedMcpAddTarget(entry(), {
        accountConnectionsEnabled: true,
        ...context,
      }).kind,
    ).toBe('device');
  });

  it('keeps a desktop-only connector entry on the device', (): void => {
    expect(
      curatedMcpAddTarget(
        entry({ providerConnector: { providers: ['claude'] } }),
        { accountConnectionsEnabled: true, accountConnectionsAvailable: true },
      ).kind,
    ).toBe('device');
  });

  it('adds a server the catalog marks desktop only as a device server that signs in on its own (REG-3035)', (): void => {
    // The account broker cannot connect it, so Add must not create an
    // account connection; the device file signs in with the app's handler.
    expect(
      curatedMcpAddTarget(
        entry({ availability: 'desktop', oauthHints: { scopes: ['read'] } }),
        { accountConnectionsEnabled: true, accountConnectionsAvailable: true },
      ),
    ).toEqual({
      kind: 'device',
      curatedKey: 'linear',
      httpAuthHandler: 'canopy',
    });
  });
});

describe('curatedMcpAddTarget with a device server already installed (REG-3052)', () => {
  const account = {
    accountConnectionsEnabled: true,
    accountConnectionsAvailable: true,
  } as const;
  const device = {
    id: 'device-linear',
    type: 'http',
    configIds: ['config-1'],
    httpAuthHandler: 'canopy',
    matchesCatalogDefaults: true,
  } as const;
  const keptOnDevice = {
    kind: 'device',
    curatedKey: 'linear',
    httpAuthHandler: 'canopy',
    serverId: 'device-linear',
  } as const;

  it('signs in through the account and replaces a stock device server', (): void => {
    expect(
      curatedMcpAddTarget(entry(), { ...account, deviceServer: device }),
    ).toEqual({
      kind: 'account',
      serverKey: 'linear',
      configId: 'default',
      replacesDeviceServer: { serverId: 'device-linear', configId: 'config-1' },
    });
    expect(
      curatedMcpAddTarget(entry(), {
        ...account,
        deviceServer: { ...device, httpAuthHandler: undefined },
      }).kind,
    ).toBe('account');
  });

  it.each([
    ['the flag is off', { accountConnectionsEnabled: false }],
    ['the account list is unavailable', { accountConnectionsAvailable: false }],
    ['the account list is unknown', { accountConnectionsAvailable: undefined }],
  ])(
    'keeps signing in on the device server when %s',
    (_label, context): void => {
      expect(
        curatedMcpAddTarget(entry(), {
          ...account,
          ...context,
          deviceServer: device,
        }),
      ).toEqual(keptOnDevice);
    },
  );

  it('keeps a desktop-only entry on its device server', (): void => {
    expect(
      curatedMcpAddTarget(entry({ availability: 'desktop' }), {
        ...account,
        deviceServer: device,
      }),
    ).toEqual(keptOnDevice);
  });

  it.each([
    ['differs from what Add creates', { matchesCatalogDefaults: false }],
    ['has more than one configuration', { configIds: ['one', 'two'] }],
    ['signs in through a provider', { httpAuthHandler: 'provider' }],
    ['is already bound to an account', { httpAuthHandler: 'account' }],
    ['runs a local command', { type: 'command' }],
  ] as const)(
    'keeps a device server that %s on the device without replacing it',
    (_label, overrides): void => {
      expect(
        curatedMcpAddTarget(entry(), {
          ...account,
          deviceServer: { ...device, ...overrides },
        }),
      ).toEqual({ ...keptOnDevice, keepsDeviceSetup: true });
    },
  );

  it('keeps a device server for an entry that needs an OAuth app of its own', (): void => {
    expect(
      curatedMcpAddTarget(
        entry({ requiredConfigFields: [{ kind: 'oauth-client-id' }] }),
        { ...account, deviceServer: device },
      ),
    ).toEqual({ ...keptOnDevice, keepsDeviceSetup: true });
  });
});
