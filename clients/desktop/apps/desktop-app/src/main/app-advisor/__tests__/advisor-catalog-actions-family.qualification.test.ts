import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  AppAdvisorActionResponse,
  ChatTabPluginSelections,
} from '@canopy/desktop-shared/types';
import type { AgentModelDefinition } from '@canopy/execution-engine/types/agent-models';
import type { MarketplaceInfo } from '@canopy/desktop-shared/types/plugins';
import type * as AppAdvisorIpcModule from '../../ipc/app-advisor';
import type {
  AdvisorCatalogActionHost,
  RefreshWait,
} from '../advisor-catalog-actions';

jest.mock('electron', () => ({
  app: { isPackaged: false },
  BrowserWindow: { getAllWindows: (): [] => [] },
  ipcMain: { on: jest.fn(), removeHandler: jest.fn(), handle: jest.fn() },
}));

const mockRequestRendererTool = jest.fn();
jest.mock('../../ipc/app-advisor', (): object => ({
  ...jest.requireActual<typeof AppAdvisorIpcModule>('../../ipc/app-advisor'),
  requestAppAdvisorRendererTool: (...args: unknown[]): unknown =>
    mockRequestRendererTool(...args),
  routeRendererToolRequest: (): null => null,
}));

let mockHost: AdvisorCatalogActionHost;
const mockHostOptions: unknown[] = [];
jest.mock('../advisor-catalog-actions-host', () => ({
  mainAdvisorCatalogActionHost: (
    options: unknown,
  ): AdvisorCatalogActionHost => {
    mockHostOptions.push(options);
    return mockHost;
  },
}));

import { AdvisorActionRuns } from '@canopy/core-runtime/node/agent/advisor';
import { OperationService } from '@canopy/core-runtime/node/operations';
import { OperationLedger } from '@canopy/core-runtime/node/operations/ledger';
import { appAdvisorActionDisposition } from '@canopy/desktop-shared/lib/app-advisor-action-dispositions';
import {
  APP_ADVISOR_PROJECT_ID,
  APP_ADVISOR_WORKTREE_ID,
} from '@canopy/desktop-shared/types';
import {
  routeAppAdvisorAction,
  type AppAdvisorActionCall,
} from '../action-router';
import { ADVISOR_CATALOG_ACTION_TYPES } from '../advisor-catalog-actions';
import { dispatchActionSchema } from '../definitions';
import { createAppAdvisorToolRuntime } from '../runtime';

const AGENT: AgentModelDefinition = {
  id: 'agent-1',
  name: 'Reviewer',
  baseModel: 'sonnet',
  instructions: 'Review',
  pluginSelections: { collectionIds: [], skillRefs: [], pluginRefs: [] },
  createdAt: '2026-11-09T00:00:00.000Z',
  updatedAt: '2026-11-09T00:00:00.000Z',
};

function marketplace(id: string, name: string): MarketplaceInfo {
  return {
    id,
    name,
    sourceType: 'github',
    sourceUrl: `https://github.com/${id}`,
    installLocation: `/plugins/${id}`,
    pluginCount: 3,
    plugins: [],
    validProviders: ['claude'],
    providerStatus: {
      claude: {
        provider: 'claude',
        state: 'valid',
        accepted: true,
        pluginCount: 3,
        lastCheckedAt: '2026-11-09T00:00:00.000Z',
      },
      codex: {
        provider: 'codex',
        state: 'invalid',
        accepted: false,
        pluginCount: 0,
        lastCheckedAt: '2026-11-09T00:00:00.000Z',
      },
    },
  };
}

let root: string;
let operations: OperationService;
let runs: AdvisorActionRuns;
let calls: Record<string, unknown[]>;
let refreshWait: RefreshWait;
let deleteRefusal: Error | null;
let confirmation: 'confirmed' | 'declined' | 'no_person';
let globalSelections: ChatTabPluginSelections;
let globalRevision: number;
let loadedMarketplaces: MarketplaceInfo[];

function recordingHost(): AdvisorCatalogActionHost {
  const record =
    (name: string) =>
    (...args: unknown[]): void => {
      (calls[name] ??= []).push(args.length === 1 ? args[0] : args);
    };
  return {
    listAgents: () => Promise.resolve([AGENT]),
    getAgent: (id) => Promise.resolve(id === AGENT.id ? AGENT : null),
    saveAgent: (request) => {
      record('saveAgent')(request);
      return Promise.resolve({
        ...AGENT,
        ...request,
        id: request.id ?? 'agent-2',
      });
    },
    deleteAgent: (id) => {
      record('deleteAgent')(id);
      return deleteRefusal
        ? Promise.reject(deleteRefusal)
        : Promise.resolve(true);
    },
    listCollections: () =>
      Promise.resolve([{ id: 'col-1', name: 'Tools' } as never]),
    getCollection: () => Promise.resolve(null),
    saveCollection: (collection) => {
      record('saveCollection')(collection);
      return Promise.resolve({ id: 'col-2', ...collection } as never);
    },
    deleteCollection: (id) => {
      record('deleteCollection')(id);
      return deleteRefusal ? Promise.reject(deleteRefusal) : Promise.resolve();
    },
    loadMarketplaces: () => Promise.resolve([...loadedMarketplaces]),
    isManagedMarketplace: (id) => id === 'builtin' || id === 'curated/cloud',
    coreSourceIds: () =>
      Promise.resolve(new Set(['owner/zeta', 'owner/alpha'])),
    refreshThroughCore: (sourceId) => {
      record('refreshThroughCore')(sourceId);
      return Promise.resolve('op-refresh');
    },
    awaitRefresh: (operationId) => {
      record('awaitRefresh')(operationId);
      return Promise.resolve(refreshWait);
    },
    refreshDirect: (sourceId) => {
      record('refreshDirect')(sourceId);
      return Promise.resolve(marketplace(sourceId, 'Built in'));
    },
    removeThroughCore: (sourceId, providers) => {
      record('removeThroughCore')([sourceId, providers]);
      return Promise.resolve({
        removedProviders: ['claude'],
        alreadyAbsent: false,
      });
    },
    confirmMarketplaceRemoval: (marketplace) => {
      record('confirm')(marketplace);
      return Promise.resolve(confirmation);
    },
    listMarketplaceSkills: () =>
      Promise.resolve([
        {
          externalId: 'x1',
          name: 'Deploy',
          description: 'Ships',
          publisher: 'Acme',
          installedSkillName: 'deploy',
        },
      ]),
    listSkillSuggestions: () =>
      Promise.resolve([
        {
          id: 's1',
          kind: 'repeat',
          title: 'Mine',
          summary: '',
          proposedSkillName: 'mine',
          occurrenceCount: 2,
          chainSkills: [],
          ownerLabel: 'Personal',
          isPrivate: false,
          owner: { kind: 'personal' },
        },
        {
          id: 's2',
          kind: 'repeat',
          title: 'Org',
          summary: '',
          proposedSkillName: 'org',
          occurrenceCount: 2,
          chainSkills: [],
          ownerLabel: 'Acme',
          isPrivate: false,
          owner: { kind: 'organization', organizationId: 'org-1' },
        },
      ] as never),
    activeOwner: () => ({ kind: 'personal' }),
    readGlobalSelections: () =>
      Promise.resolve({
        selections: globalSelections,
        revision: globalRevision,
      }),
    catalogAvailability: () =>
      Promise.resolve(
        new Map([
          ['skill:user/deploy', 'available'],
          ['skill:user/review', 'available'],
          ['plugin:owner/zeta/needs-auth', 'auth_required'],
          ['plugin:owner/zeta/installed', 'available'],
          ['plugin:owner/zeta/offered', 'available'],
        ]),
      ),
    installedPluginEntryIds: () =>
      Promise.resolve(new Set(['plugin:owner/zeta/installed'])),
    replaceGlobalSelections: (entryIds, expectedRevision) => {
      record('replaceGlobal')([entryIds, expectedRevision]);
      if (expectedRevision !== globalRevision)
        return Promise.resolve('conflict');
      globalSelections = {
        collectionIds: [],
        skillRefs: [
          { sourceId: 'user', skillName: 'deploy' },
          { sourceId: 'user', skillName: 'review' },
        ],
        pluginRefs: [],
      };
      globalRevision += 1;
      return Promise.resolve('applied');
    },
  };
}

function setup(): {
  route(
    input: unknown,
    call?: Partial<AppAdvisorActionCall>,
  ): Promise<AppAdvisorActionResponse>;
} {
  const runtime = createAppAdvisorToolRuntime(
    {
      getMainWindow: jest.fn(() => null),
      getAppAdvisorWindow: jest.fn(() => null),
      openAppAdvisorWindow: jest.fn(),
      ensureAppAdvisorWindow: jest.fn(),
    },
    {
      projectId: APP_ADVISOR_PROJECT_ID,
      worktreeId: APP_ADVISOR_WORKTREE_ID,
      chatId: 'advisor-chat',
    },
  );
  return {
    route: async (input, call) => {
      const routed = await routeAppAdvisorAction(
        dispatchActionSchema.parse({ action: input }).action,
        runtime,
        { toolUseId: 'toolu_1', ...call },
        { runs: () => runs },
      );
      return JSON.parse(routed.text) as AppAdvisorActionResponse;
    },
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'can-6002-catalog-'));
  const ledgerPath = join(root, 'ledger.sqlite');
  operations = new OperationService({
    openLedger: (): OperationLedger => OperationLedger.open(ledgerPath),
  });
  runs = new AdvisorActionRuns({ operations });
  calls = {};
  refreshWait = { state: 'succeeded' };
  deleteRefusal = null;
  confirmation = 'confirmed';
  globalSelections = {
    collectionIds: [],
    skillRefs: [{ sourceId: 'user', skillName: 'deploy' }],
    pluginRefs: [],
  };
  globalRevision = 3;
  loadedMarketplaces = [
    marketplace('owner/zeta', 'Zeta'),
    marketplace('owner/alpha', 'Alpha'),
  ];
  mockHost = recordingHost();
  mockHostOptions.length = 0;
  mockRequestRendererTool.mockClear();
});
afterEach(() => {
  operations.close();
  rmSync(root, { recursive: true, force: true });
});

describe('App Advisor catalog actions in main (CAN-6002)', () => {
  it('the sixteen actions are core catalog actions; writes carry only core.catalog.write', () => {
    expect(ADVISOR_CATALOG_ACTION_TYPES).toHaveLength(16);
    for (const type of ADVISOR_CATALOG_ACTION_TYPES) {
      const disposition = appAdvisorActionDisposition(type);
      expect(disposition).toMatchObject({ kind: 'core', executor: 'catalog' });
      if (disposition?.kind === 'core' && disposition.access === 'write')
        expect(disposition.grants).toEqual(['core.catalog.write']);
    }
  });

  it("agents and collections run on the window's owners with the renderer's shapes, and never reach a window", async () => {
    const h = setup();
    await expect(
      h.route({ type: 'agents.list', query: 'review' }, { toolUseId: 'a' }),
    ).resolves.toMatchObject({
      ok: true,
      result: { agents: [{ id: 'agent-1' }] },
    });
    await expect(
      h.route({ type: 'agents.get', id: 'missing' }, { toolUseId: 'b' }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'not_found' } });
    await h.route(
      { type: 'agents.update', id: 'agent-1', name: 'Critic' },
      { toolUseId: 'c' },
    );
    await h.route(
      { type: 'collections.create', name: 'Kit' },
      { toolUseId: 'd' },
    );

    expect(calls.saveAgent).toEqual([
      {
        id: 'agent-1',
        name: 'Critic',
        baseModel: 'sonnet',
        instructions: 'Review',
        pluginSelections: AGENT.pluginSelections,
      },
    ]);
    expect(calls.saveCollection).toEqual([
      { name: 'Kit', skills: [], plugins: [], mcpServers: [] },
    ]);
    expect(mockRequestRendererTool).not.toHaveBeenCalled();
  });

  it('a retried agent or collection delete deletes once', async () => {
    const h = setup();
    for (const input of [
      { type: 'agents.delete', id: 'agent-1' },
      { type: 'collections.delete', id: 'col-1' },
    ]) {
      const first = await h.route(input, { toolUseId: `retry-${input.type}` });
      const second = await h.route(input, { toolUseId: `retry-${input.type}` });
      expect(second).toEqual(first);
      expect(first).toMatchObject({ ok: true, result: { id: input.id } });
    }
    expect(calls.deleteAgent).toEqual(['agent-1']);
    expect(calls.deleteCollection).toEqual(['col-1']);
  });

  it("a delete the window's owner refuses stays refused", async () => {
    deleteRefusal = new Error(
      'The Agent is not an installed copy of this share.',
    );
    await expect(
      setup().route({ type: 'agents.delete', id: 'agent-1' }),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: 'execution_failed',
        message: 'The Agent is not an installed copy of this share.',
      },
    });
  });

  it("lists marketplaces from the window's projection, with plugin counts and provider state", async () => {
    await expect(
      setup().route({ type: 'plugins.list_marketplaces' }),
    ).resolves.toMatchObject({
      ok: true,
      result: {
        totalMatches: 2,
        marketplaces: [
          { id: 'owner/alpha', pluginCount: 3, claudeState: 'valid' },
          { id: 'owner/zeta' },
        ],
      },
    });
  });

  it('a refresh through the core waits for its operation and replies with the refreshed marketplace', async () => {
    await expect(
      setup().route({
        type: 'plugins.refresh_marketplace',
        marketplaceId: 'owner/alpha',
      }),
    ).resolves.toMatchObject({
      ok: true,
      result: {
        operationId: 'op-refresh',
        marketplace: { id: 'owner/alpha', pluginCount: 3 },
      },
    });
    expect(calls.refreshThroughCore).toEqual(['owner/alpha']);
    expect(calls.awaitRefresh).toEqual(['op-refresh']);
  });

  it('a refresh that outlasts the wait replies started with its operation id', async () => {
    refreshWait = { state: 'timed_out' };
    await expect(
      setup().route({
        type: 'plugins.refresh_marketplace',
        marketplaceId: 'owner/alpha',
      }),
    ).resolves.toEqual({
      requestId: 'toolu_1',
      ok: true,
      result: { started: true, operationId: 'op-refresh' },
    });
  });

  it('a failed refresh answers a failure', async () => {
    refreshWait = {
      state: 'failed',
      errorCode: 'core.catalog.sourceUnavailable',
    };
    await expect(
      setup().route({
        type: 'plugins.refresh_marketplace',
        marketplaceId: 'owner/alpha',
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'execution_failed' },
    });
  });

  it('built-in and curated rows are refused before any question; a curated refresh keeps its direct path', async () => {
    const h = setup();
    for (const [toolUseId, marketplaceId] of [
      ['a', 'builtin'],
      ['b', 'curated/cloud'],
    ])
      await expect(
        h.route(
          { type: 'plugins.remove_marketplace', marketplaceId },
          { toolUseId },
        ),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: 'invalid_target' },
      });
    await h.route(
      { type: 'plugins.refresh_marketplace', marketplaceId: 'curated/cloud' },
      { toolUseId: 'c' },
    );

    expect(calls.confirm).toBeUndefined();
    expect(calls.removeThroughCore).toBeUndefined();
    expect(calls.refreshDirect).toEqual(['curated/cloud']);
    expect(calls.refreshThroughCore).toBeUndefined();
  });

  it('a source the core does not serve, such as a native Codex marketplace, keeps the direct refresh and is never removed through the core', async () => {
    const h = setup();
    await h.route(
      { type: 'plugins.refresh_marketplace', marketplaceId: 'codex-local' },
      { toolUseId: 'a' },
    );
    expect(calls.refreshDirect).toEqual(['codex-local']);
    expect(calls.refreshThroughCore).toBeUndefined();

    loadedMarketplaces.push(marketplace('codex-local', 'Codex local'));
    await expect(
      h.route(
        { type: 'plugins.remove_marketplace', marketplaceId: 'codex-local' },
        { toolUseId: 'b' },
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'invalid_target' },
    });
    expect(calls.confirm).toBeUndefined();
    expect(calls.removeThroughCore).toBeUndefined();
  });

  it("removes through the core only after a person confirms, and replies with the core's result and the re-read list", async () => {
    const removed = await setup().route({
      type: 'plugins.remove_marketplace',
      marketplaceId: 'owner/zeta',
      providers: ['claude'],
    });

    expect(calls.confirm).toEqual([{ id: 'owner/zeta', name: 'Zeta' }]);
    expect(calls.removeThroughCore).toEqual([['owner/zeta', ['claude']]]);
    expect(removed).toMatchObject({
      ok: true,
      result: {
        sourceId: 'owner/zeta',
        removedProviders: ['claude'],
        alreadyAbsent: false,
        marketplaces: [{ id: 'owner/zeta' }, { id: 'owner/alpha' }],
      },
    });
  });

  it('a removal no person confirmed, or one declined, removes nothing', async () => {
    const h = setup();
    confirmation = 'no_person';
    await expect(
      h.route(
        { type: 'plugins.remove_marketplace', marketplaceId: 'owner/zeta' },
        { toolUseId: 'a' },
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'surface_unavailable' },
    });
    confirmation = 'declined';
    await expect(
      h.route(
        { type: 'plugins.remove_marketplace', marketplaceId: 'owner/zeta' },
        { toolUseId: 'b' },
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'execution_failed' },
    });
    expect(calls.removeThroughCore).toBeUndefined();
  });

  it('the seven newly reachable actions refuse unknown fields', () => {
    for (const action of [
      { type: 'collections.list', limit: 5 },
      { type: 'collections.create', name: 'Kit' },
      { type: 'collections.update', id: 'col-1', name: 'Kit' },
      { type: 'collections.delete', id: 'col-1' },
      { type: 'plugins.list_marketplaces', query: 'acme' },
      { type: 'plugins.refresh_marketplace', marketplaceId: 'owner/zeta' },
      {
        type: 'plugins.remove_marketplace',
        marketplaceId: 'owner/zeta',
        providers: ['codex'],
      },
    ]) {
      expect(dispatchActionSchema.safeParse({ action }).success).toBe(true);
      expect(
        dispatchActionSchema.safeParse({
          action: { ...action, force: true },
        }).success,
      ).toBe(false);
    }
    expect(
      dispatchActionSchema.safeParse({
        action: {
          type: 'collections.create',
          name: 'Kit',
          skills: [{ sourceId: 'user', skillName: 'deploy', extra: 1 }],
        },
      }).success,
    ).toBe(false);
  });

  it("lists the skill marketplace and only the active owner's suggestions", async () => {
    const h = setup();
    await expect(
      h.route(
        { type: 'skills.list_marketplace', query: 'deploy' },
        { toolUseId: 'a' },
      ),
    ).resolves.toMatchObject({
      ok: true,
      result: {
        totalMatches: 1,
        skills: [{ entryId: 'public-share:skill:x1', installed: true }],
      },
    });
    await expect(
      h.route({ type: 'skill_suggestions.list' }, { toolUseId: 'b' }),
    ).resolves.toMatchObject({
      ok: true,
      result: { otherSuggestionCount: 1, suggestions: [{ id: 's1' }] },
    });
  });

  it('writes are keyed by the tool call for the core', async () => {
    await setup().route({
      type: 'plugins.refresh_marketplace',
      marketplaceId: 'owner/alpha',
    });
    expect(mockHostOptions[0]).toMatchObject({
      chatId: 'advisor-chat',
      idempotencyKey: 'app-advisor-action:advisor-chat:toolu_1:catalog',
    });
  });

  it('reads the global defaults with their revision', async () => {
    await expect(
      setup().route({ type: 'preferences.get_global_plugin_selections' }),
    ).resolves.toMatchObject({
      ok: true,
      result: {
        revision: 3,
        pluginSelections: { skillRefs: [{ skillName: 'deploy' }] },
      },
    });
  });

  it('a set replaces the defaults at the revision read and replies with what changed', async () => {
    const result = await setup().route({
      type: 'preferences.set_global_plugin_selections',
      expectedRevision: 3,
      selections: {
        collectionIds: [],
        skillRefs: [
          { sourceId: 'user', skillName: 'deploy' },
          { sourceId: 'user', skillName: 'review' },
        ],
        pluginRefs: [],
      },
    });

    expect(calls.replaceGlobal).toEqual([
      [['skill:user/deploy', 'skill:user/review'], 3],
    ]);
    expect(result).toMatchObject({
      ok: true,
      result: {
        revision: 4,
        before: { skillRefs: [{ skillName: 'deploy' }] },
        pluginSelections: {
          skillRefs: [{ skillName: 'deploy' }, { skillName: 'review' }],
        },
      },
    });
  });

  it('an unknown or unavailable item refuses the whole set before any write', async () => {
    const h = setup();
    for (const [toolUseId, pluginRefs] of [
      ['a', [{ marketplaceId: 'owner/zeta', pluginName: 'needs-auth' }]],
      ['b', [{ marketplaceId: 'owner/zeta', pluginName: 'not-installed' }]],
      // Offered by its marketplace, so available, but not installed.
      ['c', [{ marketplaceId: 'owner/zeta', pluginName: 'offered' }]],
    ] as const)
      await expect(
        h.route(
          {
            type: 'preferences.set_global_plugin_selections',
            expectedRevision: 3,
            selections: {
              collectionIds: [],
              skillRefs: [{ sourceId: 'user', skillName: 'deploy' }],
              pluginRefs,
            },
          },
          { toolUseId },
        ),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: 'invalid_target' },
      });
    expect(calls.replaceGlobal).toBeUndefined();
  });

  it('an installed plugin can be a global default', async () => {
    await expect(
      setup().route({
        type: 'preferences.set_global_plugin_selections',
        expectedRevision: 3,
        selections: {
          collectionIds: [],
          skillRefs: [],
          pluginRefs: [
            { marketplaceId: 'owner/zeta', pluginName: 'installed' },
          ],
        },
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(calls.replaceGlobal).toEqual([[['plugin:owner/zeta/installed'], 3]]);
  });

  it('a malformed reference refuses the whole set and keeps the defaults', async () => {
    await expect(
      setup().route({
        type: 'preferences.set_global_plugin_selections',
        expectedRevision: 3,
        selections: {
          collectionIds: [],
          skillRefs: [{ sourceId: 'user', skillName: '../missing' }],
          pluginRefs: [],
        },
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: 'invalid_payload',
        message: 'Not a valid reference: skill:user/../missing.',
      },
    });
    expect(calls.replaceGlobal).toBeUndefined();
    expect(globalSelections.skillRefs).toEqual([
      { sourceId: 'user', skillName: 'deploy' },
    ]);
  });

  it('a set that would change MCP sign-in preferences is refused, not dropped; unchanged ones pass', async () => {
    const h = setup();
    await expect(
      h.route(
        {
          type: 'preferences.set_global_plugin_selections',
          expectedRevision: 3,
          selections: {
            collectionIds: [],
            skillRefs: [{ sourceId: 'user', skillName: 'deploy' }],
            pluginRefs: [],
            mcpHttpAuthPreferences: [
              {
                target: {
                  kind: 'standalone',
                  serverId: 'srv',
                  configId: 'cfg',
                },
                handler: 'provider',
              },
            ],
          },
        },
        { toolUseId: 'a' },
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'invalid_payload' },
    });
    expect(calls.replaceGlobal).toBeUndefined();

    await expect(
      h.route(
        {
          type: 'preferences.set_global_plugin_selections',
          expectedRevision: 3,
          selections: {
            collectionIds: [],
            skillRefs: [{ sourceId: 'user', skillName: 'deploy' }],
            pluginRefs: [],
            mcpHttpAuthPreferences: [],
          },
        },
        { toolUseId: 'b' },
      ),
    ).resolves.toMatchObject({ ok: true });
  });

  it('a set at a stale revision changes nothing and asks to read again', async () => {
    await expect(
      setup().route({
        type: 'preferences.set_global_plugin_selections',
        expectedRevision: 2,
        selections: { collectionIds: [], skillRefs: [], pluginRefs: [] },
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'stale_ui_state', retryable: true },
    });
    expect(globalRevision).toBe(3);
  });

  it('a set without the revision it read is refused by the schema', () => {
    expect(
      dispatchActionSchema.safeParse({
        action: {
          type: 'preferences.set_global_plugin_selections',
          selections: { collectionIds: [], skillRefs: [], pluginRefs: [] },
        },
      }).success,
    ).toBe(false);
  });
});
