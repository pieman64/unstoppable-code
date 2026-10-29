import type {
  AccountMcpConnection,
  McpServerIndexEntry,
} from '@canopy/protocol/mcp-servers';
import {
  accountMcpIndexEntry,
  customAccountMcpPromotable,
  findAccountMcpRow,
  hasMcpServerRef,
  isLoopbackMcpHost,
  MCP_WORKSPACE_DEFAULTS_HINT,
  mcpWorkspaceDefaultsStatus,
  mcpServerRowSurface,
  mergeAccountMcpInventory,
  pickerMcpServers,
  withMcpServerRef,
  withoutMcpServerRef,
  workspaceDefaultMcpLabel,
} from '../accountMcpRows';

const connection: AccountMcpConnection = {
  id: 'conn-1',
  serverKey: 'custom:def',
  configId: 'default',
  displayName: 'Internal tools',
  status: 'CONNECTED',
  routeId: 'route',
  enabledTools: null,
  kind: 'CUSTOM',
};

function device(overrides: Partial<McpServerIndexEntry>): McpServerIndexEntry {
  return {
    id: 'device',
    name: 'Device server',
    description: 'From this device',
    type: 'http',
    configs: [{ id: 'default', name: 'Default', enabled: true }],
    updatedAt: '',
    ...overrides,
  };
}

describe('accountMcpIndexEntry', () => {
  it('keys a custom connection by its server key, the shared selection ref', (): void => {
    expect(accountMcpIndexEntry(connection)).toMatchObject({
      id: 'custom:def',
      scope: 'account',
      accountConnectionId: 'conn-1',
      accountConnection: connection,
    });
    expect(accountMcpIndexEntry(connection).curatedKey).toBeUndefined();
  });

  it('keys a curated connection by its catalog key', (): void => {
    expect(
      accountMcpIndexEntry({
        ...connection,
        serverKey: 'github',
        configId: 'work',
        kind: 'CURATED',
      }),
    ).toMatchObject({
      id: 'github',
      curatedKey: 'github',
      configs: [{ id: 'work', name: 'Work', enabled: true }],
    });
  });
});

describe('findAccountMcpRow', () => {
  it('finds account rows by id and ignores device rows with the same id', (): void => {
    const rows = mergeAccountMcpInventory(
      [device({ id: 'github', curatedKey: 'other' })],
      [connection],
    );
    expect(findAccountMcpRow(rows, 'custom:def')?.accountConnection).toBe(
      connection,
    );
    expect(findAccountMcpRow(rows, 'github')).toBeUndefined();
  });
});

describe('mergeAccountMcpInventory', () => {
  const personal: AccountMcpConnection = {
    ...connection,
    id: 'conn-linear-default',
    serverKey: 'linear',
    configId: 'default',
    displayName: 'Linear',
    kind: 'CURATED',
  };
  const work: AccountMcpConnection = {
    ...personal,
    id: 'conn-linear-work',
    configId: 'work',
  };

  it('keeps one row per connection id, so the default and work configs both survive (REG-3033)', (): void => {
    const rows = mergeAccountMcpInventory([], [work, personal]);
    expect(
      rows.map((row) => [
        row.id,
        row.accountConnectionId,
        row.configs.map((config) => config.name),
      ]),
    ).toEqual([
      ['linear', 'conn-linear-default', ['Default']],
      ['linear', 'conn-linear-work', ['Work']],
    ]);
  });

  it('folds a device copy under the connection it is bound to, and an unbound copy under the default config', (): void => {
    const boundToWork = device({
      id: 'device-work',
      curatedKey: 'linear',
      accountConnectionId: 'conn-linear-work',
    });
    const unbound = device({ id: 'device-linear', curatedKey: 'linear' });
    const rows = mergeAccountMcpInventory(
      [boundToWork, unbound],
      [work, personal],
    );
    expect(rows.map((row) => row.accountConnectionId)).toEqual([
      'conn-linear-default',
      'conn-linear-work',
    ]);
    expect(rows[0]?.deviceCopies).toEqual([unbound]);
    expect(rows[1]?.deviceCopies).toEqual([boundToWork]);
  });

  it('enumerates every connection and config for pickers', (): void => {
    const rows = mergeAccountMcpInventory(
      [device({ id: 'device-linear', curatedKey: 'linear' })],
      [personal, work],
    );
    expect(
      pickerMcpServers(rows).map((row) => [row.id, row.configs[0]?.id]),
    ).toEqual([
      ['linear', 'default'],
      ['linear', 'work'],
    ]);
  });

  it('finds the connection for a config when one is given', (): void => {
    const rows = mergeAccountMcpInventory([], [work, personal]);
    expect(findAccountMcpRow(rows, 'linear')?.accountConnectionId).toBe(
      'conn-linear-default',
    );
    expect(findAccountMcpRow(rows, 'linear', 'work')?.accountConnectionId).toBe(
      'conn-linear-work',
    );
    expect(findAccountMcpRow(rows, 'linear', 'missing')).toBeUndefined();
  });

  it('folds a custom device row bound to the connection into its account row', (): void => {
    const bound = device({ id: 'bound', accountConnectionId: 'conn-1' });
    const rows = mergeAccountMcpInventory([bound], [connection]);
    expect(rows.map((row) => row.id)).toEqual(['custom:def']);
    expect(rows[0]?.deviceCopies).toEqual([bound]);
    expect(rows[0]?.description).toBe('From this device');
  });

  it('keeps device rows bound to an unknown connection as their own rows', (): void => {
    const orphan = device({ id: 'orphan', accountConnectionId: 'gone' });
    expect(
      mergeAccountMcpInventory([orphan], [connection]).map((row) => row.id),
    ).toEqual(['custom:def', 'orphan']);
  });
});

describe('pickerMcpServers', () => {
  it('drops device copies that share the account row curated key', (): void => {
    const account = device({
      id: 'account-github',
      curatedKey: 'github',
      scope: 'account',
      deviceCopies: [device({ id: 'device-github', curatedKey: 'github' })],
    });
    expect(pickerMcpServers([account]).map((row) => row.id)).toEqual([
      'account-github',
    ]);
  });

  it('drops device copies bound to the account row connection', (): void => {
    const [account] = mergeAccountMcpInventory(
      [device({ id: 'bound', accountConnectionId: 'conn-1' })],
      [connection],
    );
    if (!account) throw new Error('Missing account row');
    expect(pickerMcpServers([account]).map((row) => row.id)).toEqual([
      'custom:def',
    ]);
  });

  it('keeps device copies without a matching curated key and plain rows', (): void => {
    const account = device({
      id: 'account-github',
      curatedKey: 'github',
      scope: 'account',
      deviceCopies: [device({ id: 'device-custom' })],
    });
    const plain = device({ id: 'device-plain' });
    expect(pickerMcpServers([account, plain]).map((row) => row.id)).toEqual([
      'account-github',
      'device-custom',
      'device-plain',
    ]);
  });
});

describe('isLoopbackMcpHost', () => {
  it.each([
    'localhost',
    'LOCALHOST.',
    'api.localhost',
    '127.0.0.1',
    '127.255.10.2',
    '::1',
    '[::1]',
    '0.0.0.0',
  ])('treats %s as loopback', (host): void => {
    expect(isLoopbackMcpHost(host)).toBe(true);
  });
  it.each([
    'mcp.example.test',
    'localhost.example.test',
    '128.0.0.1',
    '127.0.0.256',
    '10.0.0.1',
    '[2001:db8::1]',
  ])('keeps %s reachable', (host): void => {
    expect(isLoopbackMcpHost(host)).toBe(false);
  });
});

describe('customAccountMcpPromotable', () => {
  const custom = device({ urlHost: 'mcp.example.test', urlScheme: 'https' });
  it('accepts a device-only custom HTTP row', (): void => {
    expect(customAccountMcpPromotable(custom)).toBe(true);
  });
  it.each([
    ['command', { type: 'command' as const, urlHost: undefined }],
    ['account scope', { scope: 'account' as const }],
    ['bound', { accountConnectionId: 'conn-1' }],
    ['curated', { curatedKey: 'github' }],
    ['provider', { authHandler: 'provider' as const }],
    ['hostless', { urlHost: undefined }],
    ['loopback', { urlHost: '127.0.0.1' }],
    ['plain HTTP', { urlScheme: 'http' }],
    ['schemeless', { urlScheme: undefined }],
  ])('rejects a %s row', (_label, overrides): void => {
    expect(customAccountMcpPromotable({ ...custom, ...overrides })).toBe(false);
  });
});

describe('mcpServerRowSurface', () => {
  it('reports account rows and account-bound device rows as cloud', (): void => {
    expect(mcpServerRowSurface(accountMcpIndexEntry(connection))).toBe('cloud');
    expect(mcpServerRowSurface(device({ authHandler: 'account' }))).toBe(
      'cloud',
    );
    expect(mcpServerRowSurface(device({ accountConnectionId: 'conn-1' }))).toBe(
      'cloud',
    );
  });

  it('reports device-only rows as desktop', (): void => {
    expect(mcpServerRowSurface(device({}))).toBe('desktop');
    expect(
      mcpServerRowSurface(device({ type: 'command', authHandler: 'canopy' })),
    ).toBe('desktop');
  });
});

describe('withMcpServerRef', () => {
  const empty = { collectionIds: [], skillRefs: [], pluginRefs: [] };

  it('adds the ref and keeps every other selection', (): void => {
    expect(
      withMcpServerRef(
        { ...empty, collectionIds: ['c1'] },
        { serverId: 'custom:def', configId: 'default' },
      ),
    ).toEqual({
      ...empty,
      collectionIds: ['c1'],
      mcpServerRefs: [{ serverId: 'custom:def', configId: 'default' }],
    });
  });

  it('returns the same selections when the ref is already there', (): void => {
    const selections = {
      ...empty,
      mcpServerRefs: [{ serverId: 'linear', configId: 'default' }],
    };
    expect(
      withMcpServerRef(selections, { serverId: 'linear', configId: 'default' }),
    ).toBe(selections);
  });
});

describe('withoutMcpServerRef', () => {
  const empty = { collectionIds: [], skillRefs: [], pluginRefs: [] };

  it('removes only that server and keeps every other selection', (): void => {
    expect(
      withoutMcpServerRef(
        {
          ...empty,
          collectionIds: ['c1'],
          mcpServerRefs: [
            { serverId: 'linear', configId: 'default' },
            { serverId: 'linear', configId: 'other' },
          ],
        },
        { serverId: 'linear', configId: 'default' },
      ),
    ).toEqual({
      ...empty,
      collectionIds: ['c1'],
      mcpServerRefs: [{ serverId: 'linear', configId: 'other' }],
    });
  });

  it('returns the same selections when the server is not selected', (): void => {
    const selections = { ...empty };
    expect(
      withoutMcpServerRef(selections, {
        serverId: 'linear',
        configId: 'default',
      }),
    ).toBe(selections);
  });
});

describe('hasMcpServerRef', () => {
  it('matches the server and config exactly', (): void => {
    const selections = {
      mcpServerRefs: [{ serverId: 'linear', configId: 'default' }],
    };
    expect(
      hasMcpServerRef(selections, { serverId: 'linear', configId: 'default' }),
    ).toBe(true);
    expect(
      hasMcpServerRef(selections, { serverId: 'linear', configId: 'other' }),
    ).toBe(false);
    expect(
      hasMcpServerRef(null, { serverId: 'linear', configId: 'default' }),
    ).toBe(false);
  });
});

describe('workspaceDefaultMcpLabel', () => {
  it('names the project when one is known', (): void => {
    expect(workspaceDefaultMcpLabel('Acme')).toBe('Add to Acme');
    expect(workspaceDefaultMcpLabel()).toBe('Add to this project');
    expect(workspaceDefaultMcpLabel('  ')).toBe('Add to this project');
  });
});

describe('mcpWorkspaceDefaultsStatus', () => {
  it('says where a signed-in server is on by default', (): void => {
    expect(mcpWorkspaceDefaultsStatus([])).toBe('Not in any project yet.');
    expect(mcpWorkspaceDefaultsStatus(['Acme'])).toBe('Enabled in Acme.');
    expect(mcpWorkspaceDefaultsStatus(['Acme', 'Beta'])).toBe(
      'Enabled in Acme and Beta.',
    );
    expect(mcpWorkspaceDefaultsStatus(['Acme', 'Beta', 'Core'])).toBe(
      'Enabled in Acme, Beta, and Core.',
    );
    expect(mcpWorkspaceDefaultsStatus(['A', 'B', 'C', 'D'])).toBe(
      'Enabled in A, B, and 2 more projects.',
    );
    expect(MCP_WORKSPACE_DEFAULTS_HINT).toBe(
      'Chats use it once you add it to a project or turn it on in a chat.',
    );
  });
});
