import type * as CollectionStore from '@canopy/desktop-shared/node/pipelines/plugin-collection-store';
import type * as CloudClientModule from '../canopy-cloud/client';
import { CanopyCloudClientError } from '../canopy-cloud/client';
import { BRAND } from '@canopy/brand/current';
import {
  PIPELINE_PACKAGE_CLIENT_VERSION,
  PIPELINE_PACKAGE_VERSION_HEADER,
} from '@canopy/protocol/pipelines';
import { createBackgroundCapabilityResolver } from '../services/background-capability-context';
import {
  decideResourceContext,
  type InstallReceipt,
} from '@canopy/desktop-shared/lib/resource-context-policy';
import type { ChatTabPluginSelections } from '@canopy/desktop-shared/types';
import type { WorkspaceContext } from '@canopy/protocol/workspace-context';

const mockPublicSnapshot = jest.fn<Promise<unknown>, unknown[]>();
jest.mock('../canopy-cloud/public-share-client', () => ({
  getPublicCollectionShareSnapshot: (...args: unknown[]): Promise<unknown> =>
    mockPublicSnapshot(...args),
}));
const mockFiles = new Map<string, unknown>();
let mockAccountId = 'account-1';
let mockAccountStatus = 'ok';
let mockBinding: { accountId: string; receipt: InstallReceipt } | undefined;
const mockFetch = jest.fn<Promise<{ owner?: unknown }>, unknown[]>();
let mockAliasPreferences: Record<string, unknown> = {};
let mockCollectionPreferences: Record<string, unknown> = {};
let mockMarketplaces: unknown[] = [];
let mockAccountConnections: unknown[] = [];
jest.mock('node:fs/promises', () => ({
  readFile: jest.fn((file: string): Promise<string> => {
    if (!mockFiles.has(file))
      return Promise.reject(new Error('Missing fixture'));
    return Promise.resolve(JSON.stringify(mockFiles.get(file)));
  }),
}));
jest.mock('../collections/collection-store', () => ({
  readCollectionConfigForBackgroundAuthorization: (
    id: string,
  ): Promise<unknown> =>
    Promise.resolve(
      mockFiles.get(`collection:${id}`) ??
        mockFiles.get(`legacy:${id}`) ??
        null,
    ),
}));
jest.mock('../lib/paths', () => ({
  getAgentModelsFilePath: (): string => 'agents',
  getCollectionConfigFilePath: (id: string): string => `collection:${id}`,
  getMcpServerFilePath: (id: string): string => `mcp:${id}`,
}));
jest.mock('../lib/canopy-cloud-account-store', () => ({
  subscribeCanopyCloudAccountChanges: jest.fn(),
  readCanopyCloudAccountWithStatus: (): Promise<unknown> =>
    Promise.resolve(
      mockAccountStatus === 'ok'
        ? { status: 'ok', entry: { account: { id: mockAccountId } } }
        : { status: mockAccountStatus },
    ),
}));
jest.mock('../lib/resource-install-receipts', () => ({
  createResourceInstallReceiptsStore: (): unknown => ({
    findLocal: (): Promise<typeof mockBinding> => Promise.resolve(mockBinding),
  }),
}));
jest.mock('../canopy-cloud/client', () => ({
  ...jest.requireActual<typeof CloudClientModule>('../canopy-cloud/client'),
  requestCanopyCloudJson: (...args: unknown[]): Promise<unknown> =>
    mockFetch(...args),
}));
jest.mock('../skills/skill-service', () => ({
  loadSkills: (): unknown => ({
    success: true,
    data: [{ sourceId: 'custom:app', name: 'check' }],
  }),
}));
jest.mock('../plugins/plugin-service', () => ({
  loadMarketplaces: (): Promise<unknown> =>
    Promise.resolve({
      success: true,
      data: {
        marketplaces: mockMarketplaces,
      },
    }),
}));
jest.mock('../canopy-cloud/mcp-connections', () => ({
  listAccountMcpConnections: (): Promise<unknown[]> =>
    Promise.resolve(mockAccountConnections),
}));
jest.mock(
  '@canopy/desktop-shared/node/pipelines/plugin-collection-store',
  () => ({
    ...jest.requireActual<typeof CollectionStore>(
      '@canopy/desktop-shared/node/pipelines/plugin-collection-store',
    ),
    loadPipelinePluginCollectionPreferences: (): Record<string, unknown> =>
      mockCollectionPreferences,
    loadPipelineModelAliasPreferences: (): Record<string, unknown> =>
      mockAliasPreferences,
  }),
);
const empty: ChatTabPluginSelections = {
  collectionIds: [],
  skillRefs: [],
  pluginRefs: [],
};
const selected: ChatTabPluginSelections = {
  ...empty,
  skillRefs: [{ sourceId: 'custom:app', skillName: 'check' }],
};
const org = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
function resolver(
  context: WorkspaceContext = { kind: 'personal' },
): ReturnType<typeof createBackgroundCapabilityResolver> {
  return createBackgroundCapabilityResolver((resource) =>
    Promise.resolve(
      decideResourceContext({
        resource,
        invocation: { mode: 'background', context },
      }),
    ),
  );
}
beforeEach(() => {
  mockFiles.clear();
  mockAliasPreferences = {};
  mockCollectionPreferences = {};
  mockAccountId = 'account-1';
  mockAccountStatus = 'ok';
  mockBinding = undefined;
  mockAccountConnections = [];
  mockMarketplaces = [
    {
      id: 'builtin/app',
      builtIn: true,
      plugins: [{ name: 'builtin-security', facets: {} }],
    },
  ];
  mockFetch.mockReset();
});

describe('shared pipeline replay', () => {
  const capability = { sharedPipeline: { remoteId: 'remote-1' } };
  const owner = { type: 'organization', id: org, name: 'Org' };

  it('checks the current owner against the persisted organization and ignores a matching receipt', async () => {
    mockBinding = {
      accountId: 'account-1',
      receipt: {
        family: 'pipelines',
        remoteId: 'remote-1',
        localResourceIds: ['shared:canopy-cloud:remote-1'],
        shareScope: 'private',
        ownerContext: { kind: 'personal' },
        hash: 'hash',
        authorizedAt: '2026-01-01T00:00:00Z',
      },
    };
    mockFetch.mockResolvedValue({ owner });
    expect(
      await resolver({ kind: 'organization', organizationId: org })(capability),
    ).toEqual({ allow: true });
    expect(mockFetch).toHaveBeenCalledWith(
      `/api/v1/${BRAND.web.apiNamespace}/pipelines/remote-1`,
      {
        headers: {
          [PIPELINE_PACKAGE_VERSION_HEADER]: String(
            PIPELINE_PACKAGE_CLIENT_VERSION,
          ),
        },
      },
    );
    expect(await resolver()(capability)).toEqual({
      allow: false,
      reason: 'context-mismatch',
    });
  });

  it('rejects a different organization and allows a Personal owner in Personal', async () => {
    mockFetch.mockResolvedValueOnce({ owner });
    expect(
      await resolver({
        kind: 'organization',
        organizationId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      })(capability),
    ).toEqual({ allow: false, reason: 'context-mismatch' });
    mockFetch.mockResolvedValueOnce({
      owner: { type: 'user', id: 'account-1', name: null },
    });
    expect(await resolver()(capability)).toEqual({ allow: true });
  });

  it('distinguishes transient fetch failure, missing owner, and account change', async () => {
    mockFetch.mockRejectedValueOnce(
      new CanopyCloudClientError('network-error', 'offline'),
    );
    expect(await resolver()(capability)).toEqual({
      allow: false,
      reason: 'unknown-provenance',
      transient: true,
    });
    mockFetch.mockResolvedValueOnce({});
    expect(await resolver()(capability)).toEqual({
      allow: false,
      reason: 'unknown-provenance',
    });
    mockFetch.mockImplementationOnce(() => {
      mockAccountId = 'other-account';
      return Promise.resolve({ owner });
    });
    expect(
      await resolver({ kind: 'organization', organizationId: org })(capability),
    ).toEqual({ allow: false, reason: 'access-removed' });
    mockAccountId = 'account-1';
    mockFetch.mockImplementationOnce(() => {
      mockAccountId = '';
      return Promise.resolve({ owner });
    });
    expect(await resolver()(capability)).toEqual({
      allow: false,
      reason: 'access-removed',
    });
  });

  it.each([403, 404])(
    'treats a validated %s as access removed',
    async (status) => {
      mockFetch.mockRejectedValueOnce(
        new CanopyCloudClientError(
          'http-error',
          'gone',
          status,
          undefined,
          undefined,
          true,
        ),
      );
      expect(await resolver()(capability)).toEqual({
        allow: false,
        reason: 'access-removed',
      });
    },
  );
});

it('allows existing local custom skills and bundled plugins', async () => {
  expect(
    await resolver()({
      selections: {
        ...selected,
        pluginRefs: [
          { marketplaceId: 'builtin/app', pluginName: 'builtin-security' },
        ],
      },
    }),
  ).toEqual({ allow: true });
  expect(mockFetch).not.toHaveBeenCalled();
});
it('rejects account MCP connections that cannot be dispatched', async () => {
  mockAccountConnections = [
    { id: 'connection', configId: 'config', status: 'DISCONNECTED' },
  ];
  expect(
    await resolver()({
      selections: {
        ...empty,
        mcpServerRefs: [{ serverId: 'account:connection', configId: 'config' }],
      },
    }),
  ).toEqual({ allow: false, reason: 'missing-dependency' });
});
it.each(['github', 'local', 'directory', 'codex', 'curated'])(
  'treats an ownerless %s provider marketplace plugin as Personal',
  async (sourceType): Promise<void> => {
    mockMarketplaces.push({
      id: `local-${sourceType}`,
      sourceType,
      plugins: [{ name: 'locally-installed' }],
    });
    const selections: ChatTabPluginSelections = {
      ...empty,
      pluginRefs: [
        {
          marketplaceId: `local-${sourceType}`,
          pluginName: 'locally-installed',
        },
      ],
    };
    expect(await resolver()({ selections })).toEqual({ allow: true });
    expect(
      await resolver({ kind: 'organization', organizationId: org })({
        selections,
      }),
    ).toEqual({ allow: true });
  },
);
it('preserves explicit plugin ownership and names unclassifiable plugins', async () => {
  mockMarketplaces.push({
    id: 'external',
    sourceType: 'remote-catalog',
    plugins: [
      { name: 'owned', owner: { type: 'organization', id: org, name: 'Org' } },
      { name: 'unknown', displayName: 'Mystery plugin' },
    ],
  });
  expect(
    await resolver()({
      selections: {
        ...empty,
        pluginRefs: [{ marketplaceId: 'external', pluginName: 'owned' }],
      },
    }),
  ).toEqual({ allow: false, reason: 'context-mismatch' });
  expect(
    await resolver()({
      selections: {
        ...empty,
        pluginRefs: [{ marketplaceId: 'external', pluginName: 'unknown' }],
      },
    }),
  ).toEqual({
    allow: false,
    reason: 'unknown-provenance',
    subject: { kind: 'plugin', name: 'Mystery plugin' },
  });
});
it('preserves explicit marketplace ownership for an ownerless plugin', async () => {
  const owner = { type: 'organization', id: org, name: 'Org' };
  mockMarketplaces.push({
    id: 'organization-marketplace',
    sourceType: 'github',
    owner,
    plugins: [{ name: 'ownerless-plugin' }],
  });
  const selections: ChatTabPluginSelections = {
    ...empty,
    pluginRefs: [
      {
        marketplaceId: 'organization-marketplace',
        pluginName: 'ownerless-plugin',
      },
    ],
  };
  expect(await resolver()({ selections })).toEqual({
    allow: false,
    reason: 'context-mismatch',
  });
  expect(
    await resolver({ kind: 'organization', organizationId: org })({
      selections,
    }),
  ).toEqual({ allow: true });
});
it('preserves a safe subject returned by the policy callback', async () => {
  mockMarketplaces.push({
    id: 'unclassified',
    sourceType: 'remote-catalog',
    plugins: [{ name: 'unknown', displayName: 'Raw\nplugin' }],
  });
  const decide = jest.fn(() =>
    Promise.resolve({
      allow: false as const,
      reason: 'unknown-provenance' as const,
      subject: { kind: 'plugin' as const, name: 'Safe plugin' },
    }),
  );
  const resolve = createBackgroundCapabilityResolver(decide);

  expect(
    await resolve({
      selections: {
        ...empty,
        pluginRefs: [{ marketplaceId: 'unclassified', pluginName: 'unknown' }],
      },
    }),
  ).toEqual({
    allow: false,
    reason: 'unknown-provenance',
    subject: { kind: 'plugin', name: 'Safe plugin' },
  });
});
it.each(['skill', 'plugin', 'collection'])(
  'rejects a missing %s',
  async (kind) => {
    const value =
      kind === 'skill'
        ? {
            ...empty,
            skillRefs: [{ sourceId: 'custom:app', skillName: 'missing' }],
          }
        : kind === 'plugin'
          ? {
              ...empty,
              pluginRefs: [
                { marketplaceId: 'builtin/app', pluginName: 'missing' },
              ],
            }
          : { ...empty, collectionIds: ['../escape'] };
    expect(await resolver()({ selections: value })).toMatchObject({
      allow: false,
    });
  },
);
it.each([false, true])(
  'reauthorizes installed skill origin in the bound context (matching=%s)',
  async (matching) => {
    mockBinding = {
      accountId: 'account-1',
      receipt: {
        family: 'skills',
        remoteId: 'remote-skill',
        shareScope: 'organization',
        ownerContext: { kind: 'organization', organizationId: org },
        hash: 'hash',
        authorizedAt: '2026-09-25T00:00:00.000Z',
      },
    };
    mockFetch.mockResolvedValue({
      owner: { type: 'organization', id: org, name: 'Org' },
    });
    expect(
      await resolver(
        matching
          ? { kind: 'organization', organizationId: org }
          : { kind: 'personal' },
      )({ selections: selected }),
    ).toEqual(
      matching ? { allow: true } : { allow: false, reason: 'context-mismatch' },
    );
    expect(mockFetch).toHaveBeenCalledTimes(1);
  },
);
it.each([false, true])(
  'reauthorizes an installed automation against its receipt and current share owner (matching=%s)',
  async (matching) => {
    mockBinding = {
      accountId: 'account-1',
      receipt: {
        family: 'automations',
        remoteId: 'remote-automation',
        shareScope: 'organization',
        ownerContext: { kind: 'organization', organizationId: org },
        hash: 'hash',
        authorizedAt: '2026-09-25T00:00:00.000Z',
      },
    };
    mockFetch.mockResolvedValue({
      owner: { type: 'organization', id: org, name: 'Org' },
    });
    expect(
      await resolver(
        matching
          ? { kind: 'organization', organizationId: org }
          : { kind: 'personal' },
      )({ installedAutomation: { id: 'local-automation' } }),
    ).toEqual(
      matching ? { allow: true } : { allow: false, reason: 'context-mismatch' },
    );
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(String(mockFetch.mock.calls[0]?.[0])).toMatch(
      /\/automations\/remote-automation$/,
    );
  },
);
it.each([
  {
    label: 'a network failure',
    error: new CanopyCloudClientError('network-error', 'offline'),
  },
  {
    label: 'a server outage',
    error: new CanopyCloudClientError(
      'http-error',
      'Unavailable',
      503,
      undefined,
      undefined,
      true,
    ),
  },
  {
    label: 'an unvalidated gateway response',
    error: new CanopyCloudClientError('http-error', 'Forbidden', 403),
  },
])(
  'reports $label while checking an installed origin as temporary',
  async ({ error }) => {
    mockBinding = {
      accountId: 'account-1',
      receipt: {
        family: 'automations',
        remoteId: 'remote-automation',
        shareScope: 'private',
        ownerContext: { kind: 'personal' },
        hash: 'hash',
        authorizedAt: '2026-09-25T00:00:00.000Z',
      },
    };
    mockFetch.mockRejectedValue(error);
    expect(
      await resolver()({ installedAutomation: { id: 'local-automation' } }),
    ).toEqual({ allow: false, reason: 'unknown-provenance', transient: true });
  },
);
it('does not treat a validated rejection of an installed origin as temporary', async () => {
  mockBinding = {
    accountId: 'account-1',
    receipt: {
      family: 'automations',
      remoteId: 'remote-automation',
      shareScope: 'private',
      ownerContext: { kind: 'personal' },
      hash: 'hash',
      authorizedAt: '2026-09-25T00:00:00.000Z',
    },
  };
  mockFetch.mockRejectedValue(
    new CanopyCloudClientError(
      'http-error',
      'Not found',
      404,
      undefined,
      undefined,
      true,
    ),
  );
  await expect(
    resolver()({ installedAutomation: { id: 'local-automation' } }),
  ).rejects.toThrow('Not found');
});
it('denies an installed automation with no install receipt until one is recorded', async () => {
  // Installs made before the gate was on gain their receipt on a foreground
  // read; until then the run is denied without disabling the automation.
  expect(
    await resolver()({ installedAutomation: { id: 'local-automation' } }),
  ).toEqual({ allow: false, reason: 'unknown-provenance', transient: true });
  expect(mockFetch).not.toHaveBeenCalled();
});
it('reports an account store that becomes unreadable mid-check as temporary', async () => {
  mockBinding = {
    accountId: 'account-1',
    receipt: {
      family: 'automations',
      remoteId: 'remote-automation',
      shareScope: 'private',
      ownerContext: { kind: 'personal' },
      hash: 'hash',
      authorizedAt: '2026-09-25T00:00:00.000Z',
    },
  };
  mockFetch.mockImplementation(() => {
    mockAccountStatus = 'unavailable';
    return Promise.resolve({ owner: { type: 'system' } });
  });
  expect(
    await resolver()({ installedAutomation: { id: 'local-automation' } }),
  ).toEqual({ allow: false, reason: 'unknown-provenance', transient: true });
});
it('denies an installed automation recorded under another account', async () => {
  mockBinding = {
    accountId: 'other-account',
    receipt: {
      family: 'automations',
      remoteId: 'remote-automation',
      shareScope: 'private',
      ownerContext: { kind: 'personal' },
      hash: 'hash',
      authorizedAt: '2026-09-25T00:00:00.000Z',
    },
  };
  expect(
    await resolver()({ installedAutomation: { id: 'local-automation' } }),
  ).toEqual({ allow: false, reason: 'access-removed' });
  expect(mockFetch).not.toHaveBeenCalled();
});
it('does not relabel a previous account installation as local', async () => {
  mockBinding = { accountId: 'other-account', receipt: {} as InstallReceipt };
  expect(await resolver()({ selections: selected })).toEqual({
    allow: false,
    reason: 'access-removed',
  });
  expect(mockFetch).not.toHaveBeenCalled();
});
it('rejects an account change during remote authorization', async () => {
  mockBinding = {
    accountId: 'account-1',
    receipt: { remoteId: 'remote-skill' } as InstallReceipt,
  };
  mockFetch.mockImplementation(() => {
    mockAccountId = 'account-2';
    return Promise.resolve({ owner: { type: 'system' } });
  });
  expect(await resolver()({ selections: selected })).toEqual({
    allow: false,
    reason: 'access-removed',
  });
});
it('checks collection members instead of trusting the collection alone', async () => {
  mockFiles.set('collection:abcd', {
    version: 2,
    collection: {
      id: 'abcd',
      skills: selected.skillRefs,
      plugins: [],
      mcpServers: [],
    },
  });
  expect(
    await resolver()({ selections: { ...empty, collectionIds: ['abcd'] } }),
  ).toEqual({ allow: true });
  mockFiles.set('collection:abcd', {
    version: 2,
    collection: {
      id: 'abcd',
      skills: [],
      plugins: [{ marketplaceId: 'builtin/app', pluginName: 'absent' }],
      mcpServers: [],
    },
  });
  expect(
    await resolver()({ selections: { ...empty, collectionIds: ['abcd'] } }),
  ).toEqual({ allow: false, reason: 'missing-dependency' });
});
it.each([true, false])(
  'requires the selected MCP configuration to exist and be enabled (%s)',
  async (enabled) => {
    mockFiles.set('mcp:server', {
      version: 1,
      server: {
        definition: {
          id: 'server',
          name: 'Server',
          description: '',
          type: 'command',
          command: 'node',
          args: [],
          createdAt: '2026-09-25',
          updatedAt: '2026-09-25',
        },
        configs: [
          {
            id: 'config',
            name: 'Config',
            description: '',
            enabled,
            envVars: {},
            extraArgs: [],
            extraHeaders: {},
            createdAt: '2026-09-25',
            updatedAt: '2026-09-25',
          },
        ],
      },
    });
    expect(
      await resolver()({
        selections: {
          ...empty,
          mcpServerRefs: [{ serverId: 'server', configId: 'config' }],
        },
      }),
    ).toEqual(
      enabled
        ? { allow: true }
        : { allow: false, reason: 'missing-dependency' },
    );
  },
);
it('checks custom agent selections and allows inline aliases without external resources', async () => {
  mockFiles.set('agents', {
    version: 1,
    agents: [{ id: 'agent_model_review', pluginSelections: selected }],
  });
  expect(
    await resolver()({
      pipeline: {
        model_aliases: [
          {
            id: 'review',
            name: 'Review',
            defaults: { agent_id: 'agent_model_review' },
          },
        ],
      },
    }),
  ).toEqual({ allow: true });
  expect(
    await resolver()({
      pipeline: {
        model_aliases: [
          { id: 'review', name: 'Review', defaults: { base: 'gpt-6-sol' } },
        ],
      },
    }),
  ).toEqual({ allow: true });
});
it('authorizes a chat route id through the Agent it pins', async () => {
  mockFiles.set('agents', {
    version: 1,
    agents: [{ id: 'agent_model_review', pluginSelections: selected }],
  });
  expect(
    await resolver()({ model: 'agent_model_review@claude-sonnet-4-6' }),
  ).toEqual({ allow: true });
  expect(
    await resolver()({ model: 'agent_model_missing@claude-sonnet-4-6' }),
  ).toEqual({ allow: false, reason: 'missing-dependency' });
});
it('checks pipeline extras and replay snapshots, including resources absent from defaults', async () => {
  const pipeline = {
    plugin_collections: [{ id: 'review', name: 'Review', defaults: [] }],
  };
  expect(
    await resolver()({
      pipeline,
      location: {
        cwd: '/workspace',
        pluginCollectionPreferences: {
          review: { disabledDefaultKeys: [], extraSelections: selected },
        },
      },
    }),
  ).toEqual({ allow: true });
  expect(
    await resolver()({
      pipeline,
      location: {
        cwd: '/workspace',
        resolvedPluginCollections: {
          review: {
            selections: {
              ...empty,
              skillRefs: [{ sourceId: 'custom:app', skillName: 'missing' }],
            },
            missingOptionalDefaults: [],
            unresolvedRequiredDefaults: [],
          },
        },
      },
    }),
  ).toEqual({ allow: false, reason: 'missing-dependency' });
});
it('reauthorizes the original collection when replay uses expanded members', async () => {
  mockFiles.set('collection:abcd', {
    version: 2,
    collection: {
      id: 'abcd',
      sharedSource: { remoteId: 'remote-collection' },
      skills: selected.skillRefs,
      plugins: [],
      mcpServers: [],
    },
  });
  mockFetch.mockResolvedValue({
    owner: { type: 'organization', id: org, name: 'Org' },
  });
  expect(
    await resolver()({
      pipeline: {
        plugin_collections: [{ id: 'review', name: 'Review', defaults: [] }],
      },
      location: {
        cwd: '/workspace',
        resolvedPluginCollections: {
          review: {
            selections: selected,
            sourceCollectionIds: ['abcd'],
            missingOptionalDefaults: [],
            unresolvedRequiredDefaults: [],
          },
        },
      },
    }),
  ).toEqual({ allow: false, reason: 'context-mismatch' });
});

it.each([false, true])(
  'enforces required defaults even when disabled (%s)',
  async (required) => {
    const ref = {
      type: 'plugin' as const,
      marketplace: { type: 'builtin' as const, id: 'app' },
      plugin_name: 'missing',
      required,
    };
    const { getPipelinePluginDefaultKey } =
      await import('@canopy/desktop-shared/pipelines/plugin-collections');
    mockCollectionPreferences = {
      review: { disabledDefaultKeys: [getPipelinePluginDefaultKey(ref)] },
    };
    expect(
      await resolver()({
        pipeline: {
          plugin_collections: [
            { id: 'review', name: 'Review', defaults: [ref] },
          ],
        },
        location: {
          cwd: '/workspace',
          pipelinePreferenceLocator: {
            type: 'stored',
            source: 'bundled',
            value: 'review',
          },
        },
      }),
    ).toEqual(
      required
        ? { allow: false, reason: 'missing-dependency' }
        : { allow: true },
    );
  },
);
it('honors saved alias overrides, explicit resets, and replay preferences', async () => {
  mockFiles.set('agents', { version: 1, agents: [] });
  mockAliasPreferences = {
    review: { mode: 'agent', agent_id: 'agent_model_missing' },
  };
  const pipeline = {
    model_aliases: [
      { id: 'review', name: 'Review', defaults: { base: 'gpt-6-sol' } },
    ],
  };
  const location = {
    cwd: '/workspace',
    pipelinePreferenceLocator: {
      type: 'stored' as const,
      source: 'bundled' as const,
      value: 'review',
    },
  };
  expect(await resolver()({ pipeline, location })).toEqual({
    allow: false,
    reason: 'missing-dependency',
  });
  expect(
    await resolver()({
      pipeline,
      location: {
        ...location,
        modelAliasPreferences: { review: { mode: 'reset' } },
      },
    }),
  ).toEqual({ allow: true });
  expect(
    await resolver()({
      pipeline,
      location: {
        ...location,
        preferencesResolved: true,
        modelAliasPreferences: {},
      },
    }),
  ).toEqual({ allow: true });
});
it('checks explicit dependency references and permits readiness-only declarations', async () => {
  expect(
    await resolver()({
      pipeline: {
        dependencies: [
          {
            kind: 'local_runtime',
            id: 'node',
            runtime: 'node',
            required: true,
          },
        ],
      },
    }),
  ).toEqual({ allow: true });
  expect(
    await resolver()({
      pipeline: {
        dependencies: [
          {
            kind: 'plugin',
            id: 'missing',
            required: true,
            ref: {
              type: 'plugin',
              marketplace: { type: 'builtin', id: 'app' },
              plugin_name: 'missing',
            },
          },
        ],
      },
    }),
  ).toEqual({ allow: false, reason: 'missing-dependency' });
});

it('uses the collection store migration reader for legacy bundle selections', async () => {
  mockFiles.set('legacy:abcd', {
    version: 2,
    collection: {
      id: 'abcd',
      skills: selected.skillRefs,
      plugins: [],
      mcpServers: [],
    },
  });
  expect(
    await resolver()({ selections: { ...empty, bundleIds: ['abcd'] } }),
  ).toEqual({ allow: true });
});

it('reauthorizes a Public collection in background execution without its private canonical row', async () => {
  mockFiles.set('collection:abcd', {
    version: 2,
    collection: {
      id: 'abcd',
      sharedSource: { remoteId: 'public-a', fromPublicShare: true },
      skills: [],
      plugins: [],
      mcpServers: [],
    },
  });
  const publicReceipt = {
    family: 'collections',
    remoteId: 'public-a',
    sourceKind: 'public-share' as const,
    shareScope: 'private' as const,
    ownerContext: { kind: 'personal' as const },
    hash: 'hash',
    authorizedAt: '2026-09-23T00:00:00Z',
    localResourceIds: ['abcd'],
  };
  mockBinding = { accountId: mockAccountId, receipt: publicReceipt };
  mockPublicSnapshot.mockResolvedValue({
    externalId: 'public-a',
    contentHash: 'hash',
  });
  expect(
    await resolver()({ selections: { ...empty, collectionIds: ['abcd'] } }),
  ).toEqual({ allow: true });
  expect(mockPublicSnapshot).toHaveBeenCalledWith('public-a');
  expect(mockFetch).not.toHaveBeenCalled();
});

// A Public share is readable by anyone, so its install does not depend on
// which account, if any, is signed in.
it.each([
  ['after signing out', ''],
  ['under another account', 'account-2'],
])(
  'keeps a Public collection usable in background execution %s',
  async (_label, currentAccountId) => {
    mockFiles.set('collection:abcd', {
      version: 2,
      collection: {
        id: 'abcd',
        sharedSource: { remoteId: 'public-a', fromPublicShare: true },
        skills: [],
        plugins: [],
        mcpServers: [],
      },
    });
    mockBinding = {
      accountId: 'account-1',
      receipt: {
        family: 'collections',
        remoteId: 'public-a',
        sourceKind: 'public-share',
        shareScope: 'private',
        ownerContext: { kind: 'personal' },
        hash: 'hash',
        authorizedAt: '2026-09-23T00:00:00Z',
        localResourceIds: ['abcd'],
      },
    };
    mockAccountId = currentAccountId;
    mockPublicSnapshot.mockResolvedValue({
      externalId: 'public-a',
      contentHash: 'hash',
    });
    expect(
      await resolver()({ selections: { ...empty, collectionIds: ['abcd'] } }),
    ).toEqual({ allow: true });
    expect(mockPublicSnapshot).toHaveBeenCalledWith('public-a');
    expect(mockFetch).not.toHaveBeenCalled();
  },
);
