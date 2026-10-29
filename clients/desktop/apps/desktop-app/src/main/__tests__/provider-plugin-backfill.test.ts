import type {
  BuiltInProviderInstallStatus,
  MarketplaceInfo,
  PluginInfo,
  PluginProvider,
  PluginsCache,
} from '@canopy/desktop-shared/types/plugins';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

jest.mock('../lib/main-process-logging', () => ({
  logMainProcessInfo: jest.fn(),
  logMainProcessWarn: jest.fn(),
}));
let mockE2eBuild = false;
jest.mock('../lib/e2e-gate', () => ({
  isE2eBuild: (): boolean => mockE2eBuild,
}));

import { logMainProcessWarn } from '../lib/main-process-logging';
import {
  planProviderPluginBackfill,
  readProviderPluginBackfillState,
  runProviderPluginBackfill,
  startProviderPluginBackfill,
  writeProviderPluginBackfillState,
  type ProviderPluginBackfillDependencies,
  type ProviderPluginBackfillRecord,
  type ProviderPluginBackfillState,
} from '../plugins/provider-plugin-backfill';

function status(
  overrides: Partial<BuiltInProviderInstallStatus> = {},
): BuiltInProviderInstallStatus {
  return { available: true, installed: false, ...overrides };
}

function plugin(
  name: string,
  overrides: Partial<PluginInfo> & { marketplaceId: string },
): PluginInfo {
  return {
    name,
    sourcePath: `/plugins/${name}`,
    providerSupport: { claude: 'native', codex: 'native' },
    facets: {},
    ...overrides,
  };
}

function marketplace(
  id: string,
  plugins: PluginInfo[],
  sourceType: MarketplaceInfo['sourceType'] = 'curated',
): MarketplaceInfo {
  return {
    id,
    name: id,
    sourceType,
    sourceUrl: '',
    installLocation: `/marketplaces/${id}`,
    lastUpdated: '2026-10-09T00:00:00.000Z',
    pluginCount: plugins.length,
    plugins,
    providerStatus: {
      claude: {
        provider: 'claude',
        state: 'valid',
        accepted: true,
        pluginCount: plugins.length,
        lastCheckedAt: '2026-10-09T00:00:00.000Z',
      },
      codex: {
        provider: 'codex',
        state: 'valid',
        accepted: true,
        pluginCount: plugins.length,
        lastCheckedAt: '2026-10-09T00:00:00.000Z',
      },
    },
    validProviders: ['claude', 'codex'] satisfies PluginProvider[],
  };
}

function cache(marketplaces: MarketplaceInfo[]): PluginsCache {
  return {
    version: 2,
    lastRefreshed: '2026-10-09T00:00:00.000Z',
    marketplaces,
  };
}

describe('planProviderPluginBackfill', () => {
  it('picks a curated plugin installed in Claude but not yet in Codex when Codex connects', () => {
    const plan = planProviderPluginBackfill(
      cache([
        marketplace('canopy-curated', [
          plugin('slack', {
            marketplaceId: 'canopy-curated',
            curated: true,
            globalInstallStatus: {
              checkedAt: '2026-10-09T00:00:00.000Z',
              claude: status({ installed: true }),
              codex: status(),
            },
          }),
        ]),
      ]),
      'codex',
    );
    expect(plan).toEqual([
      { marketplaceId: 'canopy-curated', pluginName: 'slack' },
    ]);
  });

  it('leaves out a plugin the other provider has but turned off, so it does not come back enabled', () => {
    const plan = planProviderPluginBackfill(
      cache([
        marketplace('canopy-curated', [
          plugin('muted', {
            marketplaceId: 'canopy-curated',
            curated: true,
            globalInstallStatus: {
              checkedAt: '2026-10-09T00:00:00.000Z',
              claude: status({ installed: true, enabled: false }),
              codex: status(),
            },
          }),
          plugin('live', {
            marketplaceId: 'canopy-curated',
            curated: true,
            globalInstallStatus: {
              checkedAt: '2026-10-09T00:00:00.000Z',
              claude: status({ installed: true, enabled: true }),
              codex: status(),
            },
          }),
        ]),
      ]),
      'codex',
    );
    expect(plan).toEqual([
      { marketplaceId: 'canopy-curated', pluginName: 'live' },
    ]);
  });

  it('leaves out plugins the new provider cannot host, already has, or that were never installed anywhere', () => {
    const checkedAt = '2026-10-09T00:00:00.000Z';
    const plan = planProviderPluginBackfill(
      cache([
        marketplace('canopy-curated', [
          plugin('claude-only', {
            marketplaceId: 'canopy-curated',
            curated: true,
            globalInstallStatus: {
              checkedAt,
              claude: status({ installed: true }),
              codex: status({ available: false }),
            },
          }),
          plugin('already-there', {
            marketplaceId: 'canopy-curated',
            curated: true,
            globalInstallStatus: {
              checkedAt,
              claude: status({ installed: true }),
              codex: status({ installed: true }),
            },
          }),
          plugin('never-installed', {
            marketplaceId: 'canopy-curated',
            curated: true,
            globalInstallStatus: {
              checkedAt,
              claude: status(),
              codex: status(),
            },
          }),
          plugin('wanted', {
            marketplaceId: 'canopy-curated',
            curated: true,
            globalInstallStatus: {
              checkedAt,
              claude: status({ installed: true }),
              codex: status(),
            },
          }),
        ]),
        marketplace(
          'github-marketplace',
          [
            plugin('external', {
              marketplaceId: 'github-marketplace',
              globalInstallStatus: {
                checkedAt,
                claude: status({ installed: true }),
                codex: status(),
              },
            }),
          ],
          'github',
        ),
      ]),
      'codex',
    );
    expect(plan).toEqual([
      { marketplaceId: 'canopy-curated', pluginName: 'wanted' },
    ]);
  });

  it('plans the Claude side from Codex installs when Claude connects later', () => {
    const plan = planProviderPluginBackfill(
      cache([
        marketplace('canopy-curated', [
          plugin('linear', {
            marketplaceId: 'canopy-curated',
            builtIn: true,
            globalInstallStatus: {
              checkedAt: '2026-10-09T00:00:00.000Z',
              claude: status(),
              codex: status({ installed: true }),
            },
          }),
        ]),
      ]),
      'claude',
    );
    expect(plan).toEqual([
      { marketplaceId: 'canopy-curated', pluginName: 'linear' },
    ]);
  });
});

function codexBackfillCache(names: string[]): PluginsCache {
  return cache([
    marketplace(
      'canopy-curated',
      names.map((name) =>
        plugin(name, {
          marketplaceId: 'canopy-curated',
          curated: true,
          globalInstallStatus: {
            checkedAt: '2026-10-09T00:00:00.000Z',
            claude: status({ installed: true }),
            codex: status(),
          },
        }),
      ),
    ),
  ]);
}

function record(
  fingerprint: string,
  completedAt = '2026-10-08T00:00:00.000Z',
): ProviderPluginBackfillRecord {
  return { fingerprint, completedAt, failures: [] };
}

function dependencies(
  overrides: Partial<ProviderPluginBackfillDependencies> = {},
): ProviderPluginBackfillDependencies & {
  state: ProviderPluginBackfillState;
} {
  const state: ProviderPluginBackfillState = { version: 1, providers: {} };
  const deps: ProviderPluginBackfillDependencies & {
    state: ProviderPluginBackfillState;
  } = {
    state,
    loadCache: jest.fn(() => Promise.resolve(codexBackfillCache(['slack']))),
    installPlugin: jest.fn((request) =>
      Promise.resolve({
        success: true as const,
        data: {
          plugin: plugin(request.pluginName, {
            marketplaceId: request.marketplaceId,
          }),
          providerOutcomes: Object.fromEntries(
            request.providers.map((provider) => [
              provider,
              { installed: true },
            ]),
          ),
        },
      }),
    ),
    readState: jest.fn(() => ({
      version: state.version,
      providers: { ...state.providers },
    })),
    writeState: jest.fn((next) => {
      state.version = next.version;
      for (const key of Object.keys(state.providers) as PluginProvider[])
        delete state.providers[key];
      Object.assign(state.providers, next.providers);
    }),
    recordInstallError: jest.fn(() => Promise.resolve()),
    refreshInventory: jest.fn(),
    now: () => new Date('2026-10-09T12:00:00.000Z'),
    ...overrides,
  };
  return deps;
}

describe('runProviderPluginBackfill', () => {
  it('installs each planned plugin into the new provider only, remembers the account, and refreshes the inventory', async () => {
    const deps = dependencies({
      loadCache: jest.fn(() =>
        Promise.resolve(codexBackfillCache(['slack', 'linear'])),
      ),
    });
    const report = await runProviderPluginBackfill(
      'codex',
      'auth:codex:a',
      deps,
    );
    expect(deps.installPlugin).toHaveBeenCalledTimes(2);
    expect(deps.installPlugin).toHaveBeenNthCalledWith(1, {
      marketplaceId: 'canopy-curated',
      pluginName: 'slack',
      providers: ['codex'],
    });
    expect(deps.installPlugin).toHaveBeenNthCalledWith(2, {
      marketplaceId: 'canopy-curated',
      pluginName: 'linear',
      providers: ['codex'],
    });
    expect(report).toEqual({
      provider: 'codex',
      status: 'completed',
      installed: [
        { marketplaceId: 'canopy-curated', pluginName: 'slack' },
        { marketplaceId: 'canopy-curated', pluginName: 'linear' },
      ],
      failed: [],
    });
    expect(deps.state).toEqual({
      version: 1,
      providers: {
        codex: [
          {
            fingerprint: 'auth:codex:a',
            completedAt: '2026-10-09T12:00:00.000Z',
            failures: [],
          },
        ],
      },
    });
    expect(deps.refreshInventory).toHaveBeenCalledWith(
      'provider-plugin-backfill:codex',
    );
  });

  it('does nothing for an account it already backfilled', async () => {
    const deps = dependencies();
    deps.state.providers.codex = [record('auth:codex:a')];
    const report = await runProviderPluginBackfill(
      'codex',
      'auth:codex:a',
      deps,
    );
    expect(report.status).toBe('skipped');
    expect(deps.loadCache).not.toHaveBeenCalled();
    expect(deps.installPlugin).not.toHaveBeenCalled();
    expect(deps.refreshInventory).not.toHaveBeenCalled();
  });

  it('backfills again when the provider signs in as a different account, keeping the first on record', async () => {
    const deps = dependencies();
    deps.state.providers.codex = [record('auth:codex:a')];
    const report = await runProviderPluginBackfill(
      'codex',
      'auth:codex:b',
      deps,
    );
    expect(report.status).toBe('completed');
    expect(deps.installPlugin).toHaveBeenCalledTimes(1);
    expect(
      deps.state.providers.codex?.map((entry) => entry.fingerprint),
    ).toEqual(['auth:codex:a', 'auth:codex:b']);
  });

  it('does not backfill an earlier account again when the user switches back to it', async () => {
    const deps = dependencies();
    deps.state.providers.codex = [
      record('auth:codex:a'),
      record('auth:codex:b', '2026-10-08T01:00:00.000Z'),
    ];
    const report = await runProviderPluginBackfill(
      'codex',
      'auth:codex:a',
      deps,
    );
    expect(report.status).toBe('skipped');
    expect(deps.installPlugin).not.toHaveBeenCalled();
  });

  it('keeps the most recent accounts per provider, dropping the oldest beyond eight', async () => {
    const deps = dependencies();
    deps.state.providers.codex = Array.from({ length: 8 }, (_, index) =>
      record(`auth:codex:${index}`, `2026-10-0${index + 1}T00:00:00.000Z`),
    );
    await runProviderPluginBackfill('codex', 'auth:codex:new', deps);
    const fingerprints = deps.state.providers.codex?.map(
      (entry) => entry.fingerprint,
    );
    expect(fingerprints).toHaveLength(8);
    expect(fingerprints?.[0]).toBe('auth:codex:1');
    expect(fingerprints?.[7]).toBe('auth:codex:new');
  });

  it('keeps going after one plugin fails, records that failure on the plugin, and remembers it', async () => {
    const deps = dependencies({
      loadCache: jest.fn(() =>
        Promise.resolve(codexBackfillCache(['broken', 'linear'])),
      ),
      installPlugin: jest.fn((request) =>
        request.pluginName === 'broken'
          ? Promise.resolve({
              success: false as const,
              error: 'codex: marketplace refused',
              data: {
                plugin: plugin('broken', { marketplaceId: 'canopy-curated' }),
                providerOutcomes: {
                  codex: { installed: false, error: 'marketplace refused' },
                },
              },
            })
          : Promise.resolve({
              success: true as const,
              data: {
                plugin: plugin(request.pluginName, {
                  marketplaceId: request.marketplaceId,
                }),
                providerOutcomes: { codex: { installed: true } },
              },
            }),
      ),
    });
    const report = await runProviderPluginBackfill(
      'codex',
      'auth:codex:a',
      deps,
    );
    expect(report).toEqual({
      provider: 'codex',
      status: 'completed',
      installed: [{ marketplaceId: 'canopy-curated', pluginName: 'linear' }],
      failed: [
        {
          marketplaceId: 'canopy-curated',
          pluginName: 'broken',
          error: 'marketplace refused',
        },
      ],
    });
    expect(deps.recordInstallError).toHaveBeenCalledWith(
      { marketplaceId: 'canopy-curated', pluginName: 'broken' },
      'codex',
      'marketplace refused',
    );
    expect(deps.state.providers.codex?.[0]?.failures).toEqual([
      {
        marketplaceId: 'canopy-curated',
        pluginName: 'broken',
        error: 'marketplace refused',
      },
    ]);
    expect(deps.refreshInventory).toHaveBeenCalledTimes(1);
  });

  // A later install from the same marketplace rescans it and replaces the
  // cached entry, which would drop an error recorded before it ran.
  it('records install failures on their plugins only after every install has finished', async () => {
    const order: string[] = [];
    const deps = dependencies({
      loadCache: jest.fn(() =>
        Promise.resolve(codexBackfillCache(['broken', 'linear'])),
      ),
      installPlugin: jest.fn((request) => {
        order.push(`install:${request.pluginName}`);
        return Promise.resolve(
          request.pluginName === 'broken'
            ? {
                success: false as const,
                error: 'marketplace refused',
                data: {
                  plugin: plugin('broken', { marketplaceId: 'canopy-curated' }),
                  providerOutcomes: {
                    codex: { installed: false, error: 'marketplace refused' },
                  },
                },
              }
            : {
                success: true as const,
                data: {
                  plugin: plugin(request.pluginName, {
                    marketplaceId: request.marketplaceId,
                  }),
                  providerOutcomes: { codex: { installed: true } },
                },
              },
        );
      }),
      recordInstallError: jest.fn((candidate) => {
        order.push(`record:${candidate.pluginName}`);
        return Promise.resolve();
      }),
    });
    await runProviderPluginBackfill('codex', 'auth:codex:a', deps);
    expect(order).toEqual([
      'install:broken',
      'install:linear',
      'record:broken',
    ]);
  });

  it('treats a thrown install as that plugin failing, not the whole run', async () => {
    const deps = dependencies({
      installPlugin: jest.fn(() => Promise.reject(new Error('disk full'))),
    });
    const report = await runProviderPluginBackfill(
      'codex',
      'auth:codex:a',
      deps,
    );
    expect(report.failed).toEqual([
      {
        marketplaceId: 'canopy-curated',
        pluginName: 'slack',
        error: 'disk full',
      },
    ]);
    expect(deps.state.providers.codex?.[0]?.fingerprint).toBe('auth:codex:a');
    expect(deps.refreshInventory).not.toHaveBeenCalled();
  });

  it('leaves the account unrecorded when no marketplace data can be read, so the next sign-in tries again', async () => {
    const deps = dependencies({
      loadCache: jest.fn(() => Promise.resolve(null)),
    });
    const report = await runProviderPluginBackfill(
      'codex',
      'auth:codex:a',
      deps,
    );
    expect(report).toEqual({
      provider: 'codex',
      status: 'deferred',
      deferred: 'no-marketplace-data',
      installed: [],
      failed: [],
    });
    expect(deps.installPlugin).not.toHaveBeenCalled();
    expect(deps.writeState).not.toHaveBeenCalled();
    expect(deps.state.providers.codex).toBeUndefined();
    // The same account is planned again once the marketplaces can be read.
    deps.loadCache = jest.fn(() =>
      Promise.resolve(codexBackfillCache(['slack'])),
    );
    expect(
      (await runProviderPluginBackfill('codex', 'auth:codex:a', deps)).status,
    ).toBe('completed');
    expect(deps.installPlugin).toHaveBeenCalledTimes(1);
  });

  it("leaves the account unrecorded when a provider's install state could not be read, and plans it once the read recovers", async () => {
    const unreadable = (
      side: 'claude' | 'codex',
      error: string,
    ): PluginsCache =>
      cache([
        marketplace('canopy-curated', [
          plugin('slack', {
            marketplaceId: 'canopy-curated',
            curated: true,
            globalInstallStatus: {
              checkedAt: '2026-10-09T00:00:00.000Z',
              // A failed read reports "not installed" with the error beside it.
              claude:
                side === 'claude'
                  ? status({ error })
                  : status({ installed: true }),
              codex: side === 'codex' ? status({ error }) : status(),
            },
          }),
        ]),
      ]);
    // The other provider's state is unknown: nothing to plan from.
    const deps = dependencies({
      loadCache: jest.fn(() =>
        Promise.resolve(unreadable('claude', 'settings unreadable')),
      ),
    });
    expect(
      await runProviderPluginBackfill('codex', 'auth:codex:a', deps),
    ).toEqual({
      provider: 'codex',
      status: 'deferred',
      deferred: 'install-status-unreadable',
      installed: [],
      failed: [],
    });
    // This provider's own state is unknown: it may already have the plugin.
    deps.loadCache = jest.fn(() =>
      Promise.resolve(unreadable('codex', 'Codex app-server is not running')),
    );
    expect(
      (await runProviderPluginBackfill('codex', 'auth:codex:a', deps)).deferred,
    ).toBe('install-status-unreadable');
    expect(deps.installPlugin).not.toHaveBeenCalled();
    expect(deps.writeState).not.toHaveBeenCalled();
    expect(deps.state.providers.codex).toBeUndefined();
    // The same account is planned again once both states can be read.
    deps.loadCache = jest.fn(() =>
      Promise.resolve(codexBackfillCache(['slack'])),
    );
    expect(
      (await runProviderPluginBackfill('codex', 'auth:codex:a', deps)).status,
    ).toBe('completed');
    expect(deps.installPlugin).toHaveBeenCalledTimes(1);
    expect(deps.state.providers.codex?.[0]?.fingerprint).toBe('auth:codex:a');
  });

  it('leaves the account unrecorded while whether the other provider turned a plugin off is unknown, and installs nothing once it reads as off', async () => {
    const withClaude = (claude: BuiltInProviderInstallStatus): PluginsCache =>
      cache([
        marketplace('canopy-curated', [
          plugin('slack', {
            marketplaceId: 'canopy-curated',
            curated: true,
            globalInstallStatus: {
              checkedAt: '2026-10-09T00:00:00.000Z',
              claude,
              codex: status(),
            },
          }),
        ]),
      ]);
    // Claude has the plugin, but its settings file could not be read, so
    // whether the user turned the plugin off is unknown.
    const deps = dependencies({
      loadCache: jest.fn(() =>
        Promise.resolve(
          withClaude(
            status({ installed: true, error: 'Could not read settings.json.' }),
          ),
        ),
      ),
    });
    const report = await runProviderPluginBackfill(
      'codex',
      'auth:codex:a',
      deps,
    );
    expect(report.status).toBe('deferred');
    expect(report.deferred).toBe('install-status-unreadable');
    expect(deps.installPlugin).not.toHaveBeenCalled();
    expect(deps.writeState).not.toHaveBeenCalled();
    // Once the settings read recovers and shows the plugin turned off, the
    // same account is recorded with nothing installed.
    deps.loadCache = jest.fn(() =>
      Promise.resolve(withClaude(status({ installed: true, enabled: false }))),
    );
    expect(
      await runProviderPluginBackfill('codex', 'auth:codex:a', deps),
    ).toEqual({
      provider: 'codex',
      status: 'completed',
      installed: [],
      failed: [],
    });
    expect(deps.installPlugin).not.toHaveBeenCalled();
    expect(deps.state.providers.codex?.[0]?.fingerprint).toBe('auth:codex:a');
  });

  it('remembers the account even when nothing needed installing, without touching the inventory', async () => {
    const deps = dependencies({
      loadCache: jest.fn(() => Promise.resolve(codexBackfillCache([]))),
    });
    const report = await runProviderPluginBackfill(
      'codex',
      'auth:codex:a',
      deps,
    );
    expect(report).toEqual({
      provider: 'codex',
      status: 'completed',
      installed: [],
      failed: [],
    });
    expect(deps.state.providers.codex?.[0]?.fingerprint).toBe('auth:codex:a');
    expect(deps.refreshInventory).not.toHaveBeenCalled();
  });

  it('runs overlapping requests for one provider one after the other, so the second sees the first', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const deps = dependencies({
      installPlugin: jest.fn(async (request) => {
        await gate;
        return {
          success: true as const,
          data: {
            plugin: plugin(request.pluginName, {
              marketplaceId: request.marketplaceId,
            }),
            providerOutcomes: { codex: { installed: true } },
          },
        };
      }),
    });
    const first = runProviderPluginBackfill('codex', 'auth:codex:a', deps);
    const second = runProviderPluginBackfill('codex', 'auth:codex:a', deps);
    release();
    const [firstReport, secondReport] = await Promise.all([first, second]);
    expect(firstReport.status).toBe('completed');
    expect(secondReport.status).toBe('skipped');
    expect(deps.installPlugin).toHaveBeenCalledTimes(1);
  });

  it('leaves the other provider untouched', async () => {
    const deps = dependencies();
    deps.state.providers.claude = [record('auth:claude:a')];
    await runProviderPluginBackfill('codex', 'auth:codex:a', deps);
    expect(deps.state.providers.claude?.[0]?.fingerprint).toBe('auth:claude:a');
    expect(deps.state.providers.codex?.[0]?.fingerprint).toBe('auth:codex:a');
  });
});

describe('provider plugin backfill state file', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'provider-plugin-backfill-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips the state through its file, creating the folder on first write', () => {
    const file = join(dir, 'nested', 'provider-plugin-backfill.json');
    const state: ProviderPluginBackfillState = {
      version: 1,
      providers: {
        codex: [
          {
            fingerprint: 'auth:codex:a',
            completedAt: '2026-10-09T12:00:00.000Z',
            failures: [
              {
                marketplaceId: 'canopy-curated',
                pluginName: 'broken',
                error: 'refused',
              },
            ],
          },
        ],
      },
    };
    writeProviderPluginBackfillState(state, file);
    expect(readProviderPluginBackfillState(file)).toEqual(state);
  });

  it('reads a missing, unreadable, malformed, or differently versioned file as nothing backfilled yet', () => {
    const file = join(dir, 'provider-plugin-backfill.json');
    const empty: ProviderPluginBackfillState = { version: 1, providers: {} };
    expect(readProviderPluginBackfillState(file)).toEqual(empty);
    writeFileSync(file, '{"version": 1, "providers": {"codex": "no"', 'utf8');
    expect(readProviderPluginBackfillState(file)).toEqual(empty);
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        providers: { codex: [{ fingerprint: 7 }] },
      }),
      'utf8',
    );
    expect(readProviderPluginBackfillState(file)).toEqual(empty);
    writeFileSync(
      file,
      JSON.stringify({ version: 2, providers: { codex: [record('x')] } }),
      'utf8',
    );
    expect(readProviderPluginBackfillState(file)).toEqual(empty);
  });
});

describe('startProviderPluginBackfill', () => {
  const event = {
    provider: 'codex' as const,
    fingerprint: 'auth:codex:a',
    status: {
      authenticated: true,
      accountLabel: 'codex@example.com',
      detail: null,
      error: null,
    },
  };

  it('backfills on each confirmed sign-in and stops listening when disposed', async () => {
    let listener: ((next: typeof event) => void) | undefined;
    const unsubscribe = jest.fn();
    const subscribe = jest.fn((next: (next: typeof event) => void) => {
      listener = next;
      return unsubscribe;
    });
    const run = jest.fn(() =>
      Promise.resolve({
        provider: 'codex' as const,
        status: 'completed' as const,
        installed: [{ marketplaceId: 'canopy-curated', pluginName: 'slack' }],
        failed: [],
      }),
    );
    const dispose = startProviderPluginBackfill({ subscribe, run });
    expect(listener).toBeDefined();
    listener?.(event);
    await new Promise((resolve) => setImmediate(resolve));
    expect(run).toHaveBeenCalledWith('codex', 'auth:codex:a');
    dispose();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('stays off in UI-automation builds unless the suite turns it on', () => {
    const subscribe = jest.fn(() => jest.fn());
    mockE2eBuild = true;
    try {
      startProviderPluginBackfill({ subscribe, run: jest.fn() });
      expect(subscribe).not.toHaveBeenCalled();
      startProviderPluginBackfill({
        subscribe,
        run: jest.fn(),
        env: { CANOPY_E2E_PROVIDER_PLUGIN_BACKFILL: '1' },
      });
      expect(subscribe).toHaveBeenCalledTimes(1);
    } finally {
      mockE2eBuild = false;
    }
  });

  it('logs a deferred run with the reason it recorded nothing', async () => {
    let listener: ((next: typeof event) => void) | undefined;
    const subscribe = jest.fn((next: (next: typeof event) => void) => {
      listener = next;
      return jest.fn();
    });
    const run = jest.fn(() =>
      Promise.resolve({
        provider: 'codex' as const,
        status: 'deferred' as const,
        deferred: 'install-status-unreadable' as const,
        installed: [],
        failed: [],
      }),
    );
    startProviderPluginBackfill({ subscribe, run });
    listener?.(event);
    await new Promise((resolve) => setImmediate(resolve));
    expect(logMainProcessWarn).toHaveBeenCalledWith(
      expect.stringContaining('install state could not be read'),
    );
  });

  it('logs a failed run instead of letting it escape the sign-in path', async () => {
    let listener: ((next: typeof event) => void) | undefined;
    const subscribe = jest.fn((next: (next: typeof event) => void) => {
      listener = next;
      return jest.fn();
    });
    const run = jest.fn(() => Promise.reject(new Error('cache unreadable')));
    startProviderPluginBackfill({ subscribe, run });
    expect(() => listener?.(event)).not.toThrow();
    await new Promise((resolve) => setImmediate(resolve));
    expect(logMainProcessWarn).toHaveBeenCalledWith(
      expect.stringContaining('provider-plugin-backfill'),
      'cache unreadable',
    );
  });
});
