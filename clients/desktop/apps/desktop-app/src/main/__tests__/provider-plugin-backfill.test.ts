import type {
  BuiltInProviderInstallStatus,
  MarketplaceInfo,
  PluginInfo,
  PluginProvider,
  PluginsCache,
} from '@canopy/desktop-shared/types/plugins';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as FsModule from 'fs';
import type * as AtomicFileModule from '@canopy/desktop-shared/node/lib/atomic-file';

jest.mock('../lib/main-process-logging', () => ({
  logMainProcessInfo: jest.fn(),
  logMainProcessWarn: jest.fn(),
}));
let mockE2eBuild = false;
jest.mock('../lib/e2e-gate', () => ({
  isE2eBuild: (): boolean => mockE2eBuild,
}));
let mockFailCopy = false;
jest.mock('fs', () => {
  const actual = jest.requireActual<typeof FsModule>('fs');
  return {
    ...actual,
    copyFileSync: (...args: Parameters<typeof actual.copyFileSync>): void => {
      if (mockFailCopy) throw new Error('EACCES');
      actual.copyFileSync(...args);
    },
  };
});
let mockFailAtomicWrite = false;
let mockFailAfterAtomicInstall = false;
// Runs where a process ending mid-write would stop: before the install.
let mockBeforeAtomicWrite: (() => void) | null = null;
let mockAtomicWrites = 0;
jest.mock('@canopy/desktop-shared/node/lib/atomic-file', () => {
  const actual = jest.requireActual<typeof AtomicFileModule>(
    '@canopy/desktop-shared/node/lib/atomic-file',
  );
  return {
    ...actual,
    writeFileAtomicallySync: (
      ...args: Parameters<typeof actual.writeFileAtomicallySync>
    ): void => {
      mockAtomicWrites += 1;
      mockBeforeAtomicWrite?.();
      if (mockFailAtomicWrite) throw new Error('disk full');
      actual.writeFileAtomicallySync(...args);
      // The rename landed but the directory fsync after it failed.
      if (mockFailAfterAtomicInstall) throw new Error('EIO');
    },
  };
});

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
      status: 'ok' as const,
      state: { version: state.version, providers: { ...state.providers } },
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

  it('keeps the record the other provider wrote while this run was planning', async () => {
    let releaseCodexCache!: () => void;
    const codexCacheGate = new Promise<void>((resolve) => {
      releaseCodexCache = resolve;
    });
    const deps = dependencies();
    deps.loadCache = jest
      .fn<Promise<PluginsCache | null>, []>()
      .mockImplementationOnce(async () => {
        await codexCacheGate;
        return codexBackfillCache(['slack']);
      })
      .mockImplementation(() => Promise.resolve(codexBackfillCache([])));
    const codex = runProviderPluginBackfill('codex', 'auth:codex:a', deps);
    await runProviderPluginBackfill('claude', 'auth:claude:a', deps);
    expect(deps.state.providers.claude?.[0]?.fingerprint).toBe('auth:claude:a');
    releaseCodexCache();
    expect((await codex).status).toBe('completed');
    expect(deps.state.providers.claude?.[0]?.fingerprint).toBe('auth:claude:a');
    expect(deps.state.providers.codex?.[0]?.fingerprint).toBe('auth:codex:a');
  });

  it('installs nothing while the state cannot be written, so a removed plugin does not return on every start', async () => {
    const deps = dependencies({
      writeState: jest.fn(() => {
        throw new Error('read-only volume');
      }),
    });
    const report = await runProviderPluginBackfill(
      'codex',
      'auth:codex:a',
      deps,
    );
    expect(report).toEqual({
      provider: 'codex',
      status: 'deferred',
      deferred: 'state-unwritable',
      installed: [],
      failed: [],
    });
    expect(deps.installPlugin).not.toHaveBeenCalled();
    expect(deps.refreshInventory).not.toHaveBeenCalled();
  });

  it.each(['newer', 'unreadable'] as const)(
    'installs nothing while the state file reads as %s',
    async (stateStatus) => {
      const deps = dependencies({
        readState: jest.fn(() => ({
          status: stateStatus,
          state: { version: 1 as const, providers: {} },
        })),
      });
      const report = await runProviderPluginBackfill(
        'codex',
        'auth:codex:a',
        deps,
      );
      expect(report.deferred).toBe('state-unreadable');
      expect(deps.loadCache).not.toHaveBeenCalled();
      expect(deps.installPlugin).not.toHaveBeenCalled();
      expect(deps.writeState).not.toHaveBeenCalled();
    },
  );

  it('checks the state is writable before the first install', async () => {
    const events: string[] = [];
    const deps = dependencies();
    const write = deps.writeState;
    deps.writeState = jest.fn((next: ProviderPluginBackfillState) => {
      events.push('write');
      write(next);
    });
    const install = deps.installPlugin;
    deps.installPlugin = jest.fn((request) => {
      events.push('install');
      return install(request);
    });
    await runProviderPluginBackfill('codex', 'auth:codex:a', deps);
    expect(events).toEqual(['write', 'install', 'write']);
  });

  it('refreshes the inventory and rejects, leaving the account unrecorded, when the final write fails before installing the state', async () => {
    const deps = dependencies();
    const write = deps.writeState;
    let writes = 0;
    deps.writeState = jest.fn((next: ProviderPluginBackfillState) => {
      writes += 1;
      if (writes > 1) throw new Error('disk full');
      write(next);
    });
    await expect(
      runProviderPluginBackfill('codex', 'auth:codex:a', deps),
    ).rejects.toThrow('disk full');
    expect(deps.installPlugin).toHaveBeenCalledTimes(1);
    expect(deps.refreshInventory).toHaveBeenCalledWith(
      'provider-plugin-backfill:codex',
    );
    expect(deps.state.providers.codex).toBeUndefined();
  });
});

describe('runProviderPluginBackfill with the state file', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'provider-plugin-backfill-run-'));
    mockFailAfterAtomicInstall = false;
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    mockFailAfterAtomicInstall = false;
  });

  it('refreshes the inventory and reports the error when the final write fails after installing the state', async () => {
    const file = join(dir, 'provider-plugin-backfill.json');
    const deps = dependencies({
      readState: () => readProviderPluginBackfillState(file),
      writeState: (next) => writeProviderPluginBackfillState(next, file),
    });
    const install = deps.installPlugin;
    deps.installPlugin = jest.fn((request) => {
      // The probe before this install succeeded; the final write's directory
      // sync fails after its rename.
      mockFailAfterAtomicInstall = true;
      return install(request);
    });
    const report = await runProviderPluginBackfill(
      'codex',
      'auth:codex:a',
      deps,
    );
    expect(report).toEqual({
      provider: 'codex',
      status: 'completed',
      installed: [{ marketplaceId: 'canopy-curated', pluginName: 'slack' }],
      failed: [],
      stateWriteError: 'EIO',
    });
    expect(deps.refreshInventory).toHaveBeenCalledWith(
      'provider-plugin-backfill:codex',
    );
    mockFailAfterAtomicInstall = false;
    expect(
      (await runProviderPluginBackfill('codex', 'auth:codex:a', deps)).status,
    ).toBe('skipped');
    expect(deps.installPlugin).toHaveBeenCalledTimes(1);
  });
});

describe('provider plugin backfill state file', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'provider-plugin-backfill-'));
    mockFailCopy = false;
    mockFailAtomicWrite = false;
    mockFailAfterAtomicInstall = false;
    mockBeforeAtomicWrite = null;
    mockAtomicWrites = 0;
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function asideFiles(): string[] {
    return readdirSync(dir).filter((name) =>
      /^provider-plugin-backfill\.json\.damaged-\d+$/.test(name),
    );
  }

  // A valid record beside an invalid one: the file reads as damaged but keeps
  // the account it already backfilled.
  const damagedText = JSON.stringify({
    version: 1,
    providers: { codex: [record('auth:codex:kept'), { fingerprint: 7 }] },
  });
  const damagedRead = {
    status: 'damaged',
    state: { version: 1, providers: { codex: [record('auth:codex:kept')] } },
  };
  const nextState: ProviderPluginBackfillState = {
    version: 1,
    providers: { codex: [record('auth:codex:kept'), record('auth:codex:b')] },
  };

  it('keeps a damaged file readable while its evidence copy is taken', () => {
    const file = join(dir, 'provider-plugin-backfill.json');
    writeFileSync(file, damagedText, 'utf8');
    // What a process ending after the copy but before the install leaves.
    let onDisk: {
      text: string | null;
      read: unknown;
      aside: string[];
    } | null = null;
    mockBeforeAtomicWrite = (): void => {
      onDisk = {
        text: existsSync(file) ? readFileSync(file, 'utf8') : null,
        read: readProviderPluginBackfillState(file),
        aside: asideFiles(),
      };
    };

    writeProviderPluginBackfillState(nextState, file);

    expect(onDisk).toEqual({
      text: damagedText,
      read: damagedRead,
      aside: [expect.stringMatching(/\.damaged-\d+$/)],
    });
  });

  it('leaves a damaged file in place when the rewrite fails', () => {
    const file = join(dir, 'provider-plugin-backfill.json');
    writeFileSync(file, damagedText, 'utf8');
    mockFailAtomicWrite = true;

    expect(() => writeProviderPluginBackfillState(nextState, file)).toThrow(
      'disk full',
    );

    expect(readFileSync(file, 'utf8')).toBe(damagedText);
    expect(readProviderPluginBackfillState(file)).toEqual(damagedRead);
    const aside = asideFiles();
    expect(aside).toHaveLength(1);
    expect(readFileSync(join(dir, aside[0] ?? ''), 'utf8')).toBe(damagedText);
  });

  it('does not rewrite a damaged file it could not copy aside', () => {
    const file = join(dir, 'provider-plugin-backfill.json');
    writeFileSync(file, damagedText, 'utf8');
    mockFailCopy = true;

    expect(() => writeProviderPluginBackfillState(nextState, file)).toThrow(
      'EACCES',
    );

    expect(mockAtomicWrites).toBe(0);
    expect(readFileSync(file, 'utf8')).toBe(damagedText);
    expect(asideFiles()).toEqual([]);
  });

  it('keeps an installed state when the write fails after the rename', () => {
    const file = join(dir, 'provider-plugin-backfill.json');
    writeFileSync(file, '{"version": 1, "prov', 'utf8');
    const state: ProviderPluginBackfillState = {
      version: 1,
      providers: { codex: [record('auth:codex:a')] },
    };
    mockFailAfterAtomicInstall = true;
    expect(() => writeProviderPluginBackfillState(state, file)).toThrow('EIO');
    expect(readProviderPluginBackfillState(file)).toEqual({
      status: 'ok',
      state,
    });
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
    expect(readProviderPluginBackfillState(file)).toEqual({
      status: 'ok',
      state,
    });
  });

  it('tells a missing file from a damaged, newer, or unreadable one', () => {
    const file = join(dir, 'provider-plugin-backfill.json');
    const empty: ProviderPluginBackfillState = { version: 1, providers: {} };
    expect(readProviderPluginBackfillState(file)).toEqual({
      status: 'missing',
      state: empty,
    });
    writeFileSync(file, '{"version": 1, "providers": {"codex": "no"', 'utf8');
    expect(readProviderPluginBackfillState(file)).toEqual({
      status: 'damaged',
      state: empty,
    });
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        providers: { claude: [record('kept')], codex: [{ fingerprint: 7 }] },
      }),
      'utf8',
    );
    expect(readProviderPluginBackfillState(file)).toEqual({
      status: 'damaged',
      state: { version: 1, providers: { claude: [record('kept')], codex: [] } },
    });
    writeFileSync(
      file,
      JSON.stringify({ version: 2, providers: { codex: [record('x')] } }),
      'utf8',
    );
    expect(readProviderPluginBackfillState(file)).toEqual({
      status: 'newer',
      state: empty,
    });
    expect(readProviderPluginBackfillState(dir).status).toBe('unreadable');
  });

  it('copies a damaged file aside before writing over it', () => {
    const file = join(dir, 'provider-plugin-backfill.json');
    writeFileSync(file, '{"version": 1, "prov', 'utf8');
    const state: ProviderPluginBackfillState = {
      version: 1,
      providers: { codex: [record('auth:codex:a')] },
    };
    writeProviderPluginBackfillState(state, file);
    const aside = readdirSync(dir).filter((name) =>
      /^provider-plugin-backfill\.json\.damaged-\d+$/.test(name),
    );
    expect(aside).toHaveLength(1);
    expect(readFileSync(join(dir, aside[0] ?? ''), 'utf8')).toBe(
      '{"version": 1, "prov',
    );
    expect(readProviderPluginBackfillState(file)).toEqual({
      status: 'ok',
      state,
    });
  });

  it('never writes over a file from a newer version', () => {
    const file = join(dir, 'provider-plugin-backfill.json');
    const newer = JSON.stringify({ version: 2, providers: {} });
    writeFileSync(file, newer, 'utf8');
    expect(() =>
      writeProviderPluginBackfillState({ version: 1, providers: {} }, file),
    ).toThrow(/newer/);
    expect(readFileSync(file, 'utf8')).toBe(newer);
    expect(readdirSync(dir)).toEqual(['provider-plugin-backfill.json']);
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

  it('logs a recorded run whose state write reported an error', async () => {
    let listener: ((next: typeof event) => void) | undefined;
    const subscribe = jest.fn((next: (next: typeof event) => void) => {
      listener = next;
      return jest.fn();
    });
    const run = jest.fn(() =>
      Promise.resolve({
        provider: 'codex' as const,
        status: 'completed' as const,
        installed: [{ marketplaceId: 'canopy-curated', pluginName: 'slack' }],
        failed: [],
        stateWriteError: 'EIO',
      }),
    );
    startProviderPluginBackfill({ subscribe, run });
    listener?.(event);
    await new Promise((resolve) => setImmediate(resolve));
    expect(logMainProcessWarn).toHaveBeenCalledWith(
      expect.stringContaining('state write reported an error'),
      'EIO',
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
