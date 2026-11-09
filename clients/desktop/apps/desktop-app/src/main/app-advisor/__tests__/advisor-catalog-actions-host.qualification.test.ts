import type * as CoreRuntimeModule from '@canopy/core-runtime';
jest.mock('electron', () => ({
  app: { isPackaged: false, getPath: (): string => '/tmp' },
  BrowserWindow: { getAllWindows: (): [] => [] },
  ipcMain: { on: jest.fn(), removeHandler: jest.fn(), handle: jest.fn() },
}));

const mockInstructions: Array<{
  name: string;
  params: unknown;
  options: unknown;
}> = [];
const mockQueries: unknown[] = [];
let mockSelectionConflict = false;
jest.mock('../../lib/preferences-store', () => ({
  readPreferencesFile: (): object =>
    Promise.resolve({
      globalPluginSelections: {
        collectionIds: [],
        skillRefs: [{ sourceId: 'user', skillName: 'deploy' }],
        pluginRefs: [],
      },
    }),
}));
const mockWaits: string[] = [];
let mockOperation: object | null = null;
jest.mock('../../canopy-runtime/desktop-runtime', () => ({
  getActiveDesktopRuntime: (): object => ({
    instruction: (name: string, params: unknown, options: unknown): object => {
      mockInstructions.push({ name, params, options });
      if (name === 'core.catalog.selection.update')
        return mockSelectionConflict
          ? Promise.reject(
              new (jest.requireActual<typeof CoreRuntimeModule>(
                '@canopy/core-runtime',
              ).CanopyOperationError)({
                kind: 'conflict',
                code: 'core.catalog.selection.revisionConflict',
                message: 'The selection changed since it was read.',
                retry: { kind: 'never' },
              }),
            )
          : Promise.resolve({
              revision: 8,
              selectedItemIds: [],
              materializationOperation: null,
            });
      return Promise.resolve(
        name === 'core.catalog.source.refresh'
          ? {
              operationId: 'op-refresh',
              acceptedSources: ['owner/alpha'],
              scanOnlySources: [],
            }
          : {
              sourceId: 'owner/alpha',
              removedProviders: ['claude'],
              alreadyAbsent: false,
            },
      );
    },
    waitForOperation: (
      operationId: string,
      signal?: AbortSignal,
    ): Promise<object> => {
      mockWaits.push(operationId);
      if (mockOperation) return Promise.resolve(mockOperation);
      // Never ends on its own: only the wait's bound stops it.
      return new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () =>
          reject(new Error('The wait was stopped.')),
        );
      });
    },
    query: (name: string, params: unknown, options: unknown): object => {
      mockQueries.push({ name, params, options });
      if (name === 'core.catalog.selection.get')
        return Promise.resolve({
          revision: 7,
          selectedItemIds: ['skill:user/deploy'],
          unavailableItemIds: [],
        });
      if (name === 'core.catalog.snapshot.get')
        return Promise.resolve({
          revision: 2,
          entries: [
            { entryId: 'skill:user/deploy', availability: 'available' },
            { entryId: 'plugin:owner/zeta/x', availability: 'auth_required' },
          ],
        });
      return Promise.resolve({
        revision: 1,
        sources: [{ sourceId: 'owner/alpha', lastRefresh: { state: 'never' } }],
      });
    },
  }),
}));

const mockAgentWrites: unknown[] = [];
let mockDeleteRefusal: Error | null = null;
jest.mock('../../ipc/agent-models', () => ({
  saveAgentForWindow: (request: unknown): object => {
    mockAgentWrites.push(['save', request]);
    return Promise.resolve({ id: 'agent-1' });
  },
  deleteAgentForWindow: (request: unknown): object => {
    mockAgentWrites.push(['delete', request]);
    return mockDeleteRefusal
      ? Promise.reject(mockDeleteRefusal)
      : Promise.resolve(true);
  },
}));

jest.mock('../../plugins/plugin-service', () => ({
  loadMarketplacesForPresentation: (): Promise<object> =>
    Promise.resolve({
      success: true,
      data: {
        marketplaces: [
          {
            id: 'owner/zeta',
            plugins: [
              {
                name: 'installed-claude',
                marketplaceId: 'owner/zeta',
                globalInstallStatus: { claude: { installed: true } },
              },
              {
                name: 'cached',
                marketplaceId: 'owner/zeta',
                cachePath: '/plugins/cached',
              },
              {
                name: 'offered-only',
                marketplaceId: 'owner/zeta',
                globalInstallStatus: {
                  claude: { installed: false },
                  codex: { installed: false },
                },
              },
            ],
          },
        ],
      },
    }),
}));

import { BUILTIN_PLUGIN_MARKETPLACE_ID } from '@canopy/protocol/plugins/catalog';
import { AskUserDismissedError } from '../../lib/ask-user-outcomes';
import { mainAdvisorCatalogActionHost } from '../advisor-catalog-actions-host';

let mockAnswers: () => Promise<
  Array<{ selectedOptions: string[]; answeredBy?: 'person' | 'agent' }>
>;

function host(): ReturnType<typeof mainAdvisorCatalogActionHost> {
  return mainAdvisorCatalogActionHost({
    requestUserAnswers: () => mockAnswers(),
    chatId: 'advisor-chat',
    idempotencyKey: 'app-advisor-action:advisor-chat:toolu_1:catalog',
    getWindow: () => null,
    refreshWaitMs: 50,
  });
}

beforeEach(() => {
  mockInstructions.length = 0;
  mockQueries.length = 0;
  mockWaits.length = 0;
  mockOperation = null;
  mockAgentWrites.length = 0;
  mockDeleteRefusal = null;
  mockSelectionConflict = false;
});

describe('App Advisor catalog action host (CAN-6002)', () => {
  it('refreshes through core.catalog.source.refresh as the advisor chat with only core.catalog.write, keyed by the tool call', async () => {
    await expect(host().refreshThroughCore('owner/alpha')).resolves.toBe(
      'op-refresh',
    );
    expect(mockInstructions).toEqual([
      {
        name: 'core.catalog.source.refresh',
        params: {
          sourceIds: ['owner/alpha'],
          providers: ['claude', 'codex'],
          mode: 'update_then_scan',
          _meta: {
            idempotencyKey: 'app-advisor-action:advisor-chat:toolu_1:catalog',
          },
        },
        options: {
          caller: {
            principalId: 'local-desktop-user',
            clientInstanceId: 'agent-action:advisor-chat',
            authorityId: 'local-desktop',
            interfaceKind: 'mcp',
            grants: ['core.catalog.write'],
          },
          metadata: {
            idempotencyKey: 'app-advisor-action:advisor-chat:toolu_1:catalog',
          },
        },
      },
    ]);
  });

  it("waits for the refresh operation's own end, in process", async () => {
    mockOperation = {
      operationId: 'op-refresh',
      status: 'completed',
      error: null,
    };
    await expect(host().awaitRefresh('op-refresh')).resolves.toEqual({
      state: 'succeeded',
    });
    expect(mockWaits).toEqual(['op-refresh']);
    // No catalog read is needed to learn how the refresh ended.
    expect(mockQueries).toEqual([]);
  });

  it('a refresh that fails, even before any provider status is saved, ends as failed with its code', async () => {
    mockOperation = {
      operationId: 'op-refresh',
      status: 'failed',
      error: {
        kind: 'unavailable',
        message: 'No source could be refreshed.',
        code: 'core.catalog.refreshUnavailable',
      },
    };
    await expect(host().awaitRefresh('op-refresh')).resolves.toEqual({
      state: 'failed',
      errorCode: 'core.catalog.refreshUnavailable',
    });
  });

  it('a refresh that never ends within the bound times out', async () => {
    await expect(host().awaitRefresh('op-refresh')).resolves.toEqual({
      state: 'timed_out',
    });
  });

  it('removes through core.catalog.source.delete; built-in and curated rows are managed', async () => {
    await expect(
      host().removeThroughCore('owner/alpha', ['claude']),
    ).resolves.toEqual({ removedProviders: ['claude'], alreadyAbsent: false });
    expect(mockInstructions[0]).toMatchObject({
      name: 'core.catalog.source.delete',
      params: { sourceId: 'owner/alpha', providers: ['claude'] },
      options: { caller: { grants: ['core.catalog.write'] } },
    });
    const h = host();
    expect(h.isManagedMarketplace(BUILTIN_PLUGIN_MARKETPLACE_ID)).toBe(true);
    expect(h.isManagedMarketplace('curated/cloud')).toBe(true);
    expect(h.isManagedMarketplace('owner/alpha')).toBe(false);
  });

  it("only a person's answer confirms a marketplace removal", async () => {
    const marketplace = { id: 'owner/alpha', name: 'Alpha' };
    mockAnswers = (): ReturnType<typeof mockAnswers> =>
      Promise.resolve([
        { selectedOptions: ['Remove marketplace'], answeredBy: 'person' },
      ]);
    await expect(host().confirmMarketplaceRemoval(marketplace)).resolves.toBe(
      'confirmed',
    );
    mockAnswers = (): ReturnType<typeof mockAnswers> =>
      Promise.resolve([
        { selectedOptions: ['Remove marketplace'], answeredBy: 'agent' },
      ]);
    await expect(host().confirmMarketplaceRemoval(marketplace)).resolves.toBe(
      'no_person',
    );
    mockAnswers = (): ReturnType<typeof mockAnswers> =>
      Promise.resolve([{ selectedOptions: ['Remove marketplace'] }]);
    await expect(host().confirmMarketplaceRemoval(marketplace)).resolves.toBe(
      'no_person',
    );
    mockAnswers = (): ReturnType<typeof mockAnswers> =>
      Promise.reject(new Error('The main window is not open.'));
    await expect(host().confirmMarketplaceRemoval(marketplace)).resolves.toBe(
      'no_person',
    );
    mockAnswers = (): ReturnType<typeof mockAnswers> =>
      Promise.reject(new AskUserDismissedError('User dismissed'));
    await expect(host().confirmMarketplaceRemoval(marketplace)).resolves.toBe(
      'declined',
    );
    mockAnswers = (): ReturnType<typeof mockAnswers> =>
      Promise.resolve([{ selectedOptions: ['Keep it'], answeredBy: 'person' }]);
    await expect(host().confirmMarketplaceRemoval(marketplace)).resolves.toBe(
      'declined',
    );
  });

  it("saves and deletes agents through the window's agents:save and agents:delete owners, which refuse what they refuse", async () => {
    await host().saveAgent({
      name: 'Reviewer',
      baseModel: 'sonnet',
      instructions: 'Review',
      pluginSelections: { collectionIds: [], skillRefs: [], pluginRefs: [] },
    });
    await host().deleteAgent('agent-1');
    mockDeleteRefusal = new Error(
      'The Agent is not an installed copy of this share.',
    );
    await expect(host().deleteAgent('agent-1')).rejects.toThrow(
      'not an installed copy',
    );

    expect(mockAgentWrites).toEqual([
      ['save', expect.objectContaining({ name: 'Reviewer' })],
      ['delete', { id: 'agent-1' }],
      ['delete', { id: 'agent-1' }],
    ]);
  });

  it('reads the global defaults and their revision through core.catalog.selection.get with only core.catalog.read', async () => {
    await expect(host().readGlobalSelections()).resolves.toEqual({
      selections: {
        collectionIds: [],
        skillRefs: [{ sourceId: 'user', skillName: 'deploy' }],
        pluginRefs: [],
      },
      revision: 7,
    });
    expect(
      mockQueries.find(
        (query) =>
          (query as { name: string }).name === 'core.catalog.selection.get',
      ),
    ).toMatchObject({
      params: { scope: {} },
      options: { caller: { grants: ['core.catalog.read'] } },
    });
  });

  it("reads every catalog entry's availability, unavailable ones included", async () => {
    const availability = await host().catalogAvailability();
    expect(availability.get('skill:user/deploy')).toBe('available');
    expect(availability.get('plugin:owner/zeta/x')).toBe('auth_required');
    expect(mockQueries[0]).toMatchObject({
      name: 'core.catalog.snapshot.get',
      params: { scope: {}, includeUnavailable: true },
    });
  });

  it('replaces the global defaults through core.catalog.selection.update at the revision read, keyed, and reports a conflict', async () => {
    await expect(
      host().replaceGlobalSelections(['skill:user/deploy'], 7),
    ).resolves.toBe('applied');
    expect(mockInstructions[0]).toMatchObject({
      name: 'core.catalog.selection.update',
      params: {
        scope: {},
        expectedRevision: 7,
        selectedItemIds: ['skill:user/deploy'],
        _meta: {
          idempotencyKey: 'app-advisor-action:advisor-chat:toolu_1:catalog',
        },
      },
      options: { caller: { grants: ['core.catalog.write'] } },
    });
    mockSelectionConflict = true;
    await expect(
      host().replaceGlobalSelections(['skill:user/deploy'], 6),
    ).resolves.toBe('conflict');
  });

  it('lists only plugins the Plugins page shows as installed', async () => {
    await expect(host().installedPluginEntryIds()).resolves.toEqual(
      new Set([
        'plugin:owner/zeta/installed-claude',
        'plugin:owner/zeta/cached',
      ]),
    );
  });

  it('reads the sources core.catalog.source.* serves, disabled ones included, with only core.catalog.read', async () => {
    await expect(host().coreSourceIds()).resolves.toEqual(
      new Set(['owner/alpha']),
    );
    expect(mockQueries).toHaveLength(1);
    expect(mockQueries[0]).toMatchObject({
      name: 'core.catalog.source.list',
      params: { includeDisabled: true },
      options: { caller: { grants: ['core.catalog.read'] } },
    });
  });
});
