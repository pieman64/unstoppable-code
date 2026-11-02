/**
 * @jest-environment jsdom
 *
 * Integration coverage for the connector rows the picker renders.
 *
 * The pure builders are tested elsewhere with hand-supplied inputs. This file
 * exercises the wiring instead — the hook composing two async reads and the
 * builder — because that seam is where this feature's regressions have
 * actually landed: a row rendered checked for an account nobody had linked, a
 * `sourceId` with no matching filter option, and a first paint that asserted
 * "not linked" before either read returned. Every consumer test mocks
 * `useUnifiedTableData`, so none of that was covered anywhere.
 */
import { GMAIL_CONNECTOR as GMAIL } from './connectorFixtures';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useUnifiedTableData } from '../useUnifiedTableData';
import type { UnifiedTableRow } from '../useUnifiedTableData';
import type { useMarketplaceList as useMarketplaceListHook } from '../useMarketplaceList';
import type {
  MarketplaceInfo,
  PluginInfo,
  PluginProviderSupport,
} from '@canopy/desktop-shared/types/plugins';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

jest.mock('../useSkillList', () => ({
  useSkillList: (): unknown => ({ skills: [], loading: false }),
}));
jest.mock('../useMarketplaceList', () => ({
  useMarketplaceList: jest.fn(() => ({ cache: null, loading: false })),
}));
jest.mock('../useCollectionList', () => ({
  useCollectionList: (): unknown => ({ collections: [], loading: false }),
}));
jest.mock('../useMcpServerList', () => ({
  useMcpServerList: jest.fn(() => ({ servers: [], loading: false })),
}));

let container: HTMLDivElement;
let root: Root;

function marketplacePlugin(
  name: string,
  marketplaceId: string,
  description: string,
  providerSupport: PluginProviderSupport,
): PluginInfo {
  const sourcePath = `${marketplaceId}/${name}`;
  const facets: PluginInfo['facets'] = {};
  if (providerSupport.claude === 'native') {
    facets.claude = {
      provider: 'claude',
      mode: 'native',
      name,
      installLocation: marketplaceId,
      sourcePath,
    };
  }
  if (providerSupport.codex === 'native') {
    facets.codex = {
      provider: 'codex',
      mode: 'native',
      name,
      installLocation: marketplaceId,
      sourcePath,
    };
  } else if (providerSupport.codex === 'compat') {
    facets.codexCompatibility = {
      provider: 'codex',
      mode: 'compat',
      name,
      installLocation: marketplaceId,
      sourcePath,
    };
  }
  return {
    name,
    marketplaceId,
    description,
    sourcePath,
    providerSupport,
    facets,
  };
}

function marketplaceInfo(
  info: Pick<
    MarketplaceInfo,
    'id' | 'name' | 'sourceType' | 'sourceUrl' | 'plugins'
  >,
): MarketplaceInfo {
  const claudePluginCount = info.plugins.filter(
    (plugin) => plugin.providerSupport.claude === 'native',
  ).length;
  const codexPluginCount = info.plugins.filter(
    (plugin) => plugin.providerSupport.codex !== 'none',
  ).length;
  const claude: MarketplaceInfo['providerStatus']['claude'] = {
    provider: 'claude',
    state: claudePluginCount > 0 ? 'valid' : 'invalid',
    accepted: claudePluginCount > 0,
    pluginCount: claudePluginCount,
    lastCheckedAt: '2026-10-25T12:00:00.000Z',
  };
  const codex: MarketplaceInfo['providerStatus']['codex'] = {
    provider: 'codex',
    state: codexPluginCount > 0 ? 'valid' : 'invalid',
    accepted: codexPluginCount > 0,
    pluginCount: codexPluginCount,
    lastCheckedAt: '2026-10-25T12:00:00.000Z',
  };
  const validProviders: MarketplaceInfo['validProviders'] = [];
  if (claudePluginCount > 0) validProviders.push('claude');
  if (codexPluginCount > 0) validProviders.push('codex');
  return {
    ...info,
    installLocation: `marketplaces/${info.id}`,
    pluginCount: info.plugins.length,
    providerStatus: { claude, codex },
    validProviders,
  };
}

const MARKETPLACE_LIST_DEFAULTS: Omit<
  ReturnType<typeof useMarketplaceListHook>,
  'cache' | 'loading'
> = {
  error: null,
  progressMessage: null,
  reload: (): Promise<void> => Promise.resolve(),
  refresh: (): Promise<void> => Promise.resolve(),
  upsertMarketplace: (): void => undefined,
  applyMarketplaceRemoval: (): void => undefined,
};

function mountWithoutCollapse(): { rows: UnifiedTableRow[] } {
  const captured: { rows: UnifiedTableRow[] } = { rows: [] };
  function Probe(): null {
    captured.rows = useUnifiedTableData({
      includeCollections: false,
      includeMcp: true,
    }).rows;
    return null;
  }
  act(() => {
    root.render(<Probe />);
  });
  return captured;
}

function mount(): {
  rows: UnifiedTableRow[];
  sourceOptions: Array<{ value: string }>;
} {
  const captured: {
    rows: UnifiedTableRow[];
    sourceOptions: Array<{ value: string }>;
  } = { rows: [], sourceOptions: [] };
  function Probe(): null {
    const data = useUnifiedTableData({
      includeCollections: false,
      includeMcp: true,
      includeProviderConnectors: true,
      collapseDuplicates: true,
    });
    captured.rows = data.rows;
    captured.sourceOptions = data.sourceOptions;
    return null;
  }
  act(() => {
    root.render(<Probe />);
  });
  return captured;
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

const REAL_START_MS = Date.now();
let clockOffsetMs = 0;

beforeEach(() => {
  // The connector read is cached module-wide for a short TTL, so each test runs
  // at a later wall-clock time than the last rather than inheriting the
  // previous one's answer.
  clockOffsetMs += 10 * 60_000;
  jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask'] });
  jest.setSystemTime(REAL_START_MS + clockOffsetMs);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('connector rows through the real hook', () => {
  function stub(connected: boolean): void {
    Object.defineProperty(window, 'mcpServers', {
      configurable: true,
      value: {
        listCurated: jest
          .fn()
          .mockResolvedValue({ version: 1, servers: [GMAIL] }),
        listProviderConnectors: jest.fn().mockResolvedValue([
          {
            provider: 'claude',
            connectors: connected
              ? [
                  {
                    name: 'claude.ai Gmail',
                    displayName: 'Gmail',
                    connected: true,
                    status: '✔ Connected',
                  },
                ]
              : [],
          },
          { provider: 'codex', connectors: [] },
        ]),
      },
    });
  }

  it('renders an unlinked connector unchecked, with a matching filter option', async () => {
    stub(false);
    const captured = mount();
    await flush();

    const gmail = captured.rows.find((row) => row.name === 'Gmail');
    expect(gmail?.toggleMode).toBe('disabled');
    expect(gmail?.sourceSubtitle).toMatch(/link it there/i);
    // Without this the source filter — an allowlist — hides every connector.
    expect(captured.sourceOptions.map((option) => option.value)).toContain(
      gmail?.sourceId,
    );
  });

  it('locks the row once the account actually has it', async () => {
    stub(true);
    const captured = mount();
    await flush();

    const gmail = captured.rows.find((row) => row.name === 'Gmail');
    expect(gmail?.toggleMode).toBe('locked');
    expect(gmail?.sourceSubtitle).toMatch(/linked/i);
  });
});

describe('reads are paid only by surfaces that use them', () => {
  it('does not fetch the curated catalog for a caller that shows no connectors', async () => {
    // The Collection editor passes `includeMcp: true` without opting into
    // connector rows. `curatedMcpServers` is read only inside the connector
    // blocks, so gating its fetch on `includeMcp` made that surface pay an IPC
    // — and a live cloud fetch on a stale cache — for a result it discards.
    // This is the cost pattern the last three rounds removed elsewhere.
    const listCurated = jest
      .fn()
      .mockResolvedValue({ version: 1, servers: [GMAIL] });
    const listProviderConnectors = jest.fn().mockResolvedValue([]);
    Object.defineProperty(window, 'mcpServers', {
      configurable: true,
      value: { listCurated, listProviderConnectors },
    });

    function Probe(): null {
      useUnifiedTableData({ includeCollections: false, includeMcp: true });
      return null;
    }
    act(() => {
      root.render(<Probe />);
    });
    await flush();

    expect(listProviderConnectors).not.toHaveBeenCalled();
    expect(listCurated).not.toHaveBeenCalled();
  });
});

describe('duplicate plugins across overlapping marketplaces', () => {
  it('collapses them the way the Plugins page does', async () => {
    // Driven through the hook rather than the pure function, because the row
    // builder sets `source` to a display label — `github:anthropics:...` for a
    // GitHub marketplace — not the marketplace id. A hand-built fixture using
    // the id passed while production never matched at all.
    const { useMarketplaceList } = await import('../useMarketplaceList');
    const listing: ReturnType<typeof useMarketplaceList> = {
      ...MARKETPLACE_LIST_DEFAULTS,
      cache: {
        version: 2,
        lastRefreshed: '2026-10-25T12:00:00.000Z',
        marketplaces: [
          marketplaceInfo({
            id: 'claude-plugins-official',
            name: 'Claude Plugins',
            sourceType: 'github',
            sourceUrl: 'https://github.com/anthropics/claude-plugins-official',
            plugins: [
              {
                ...marketplacePlugin('slack', 'claude-plugins-official', '', {
                  claude: 'native',
                  codex: 'native',
                }),
              },
            ],
          }),
          marketplaceInfo({
            id: 'openai-curated-remote',
            name: 'Codex Curated',
            sourceType: 'codex',
            sourceUrl: 'openai-curated-remote',
            plugins: [
              {
                ...marketplacePlugin('slack', 'openai-curated-remote', '', {
                  claude: 'none',
                  codex: 'native',
                }),
              },
            ],
          }),
        ],
      },
      loading: false,
    };
    jest.mocked(useMarketplaceList).mockReturnValue(listing);

    Object.defineProperty(window, 'mcpServers', {
      configurable: true,
      value: {
        listCurated: jest.fn().mockResolvedValue({ version: 1, servers: [] }),
        listProviderConnectors: jest.fn().mockResolvedValue([]),
      },
    });

    const captured = mount();
    await flush();

    const slacks = captured.rows.filter(
      (row) => row.name.toLowerCase() === 'slack',
    );
    expect(slacks).toHaveLength(1);
  });
});

describe('a capability reachable on only one provider is never collapsed away', () => {
  it('keeps both copies when neither covers the other', async () => {
    // The Plugins page refuses to collapse a Claude-only copy into a
    // Codex-only one: both "reach one provider", so marketplace order would
    // decide the survivor and take the capability away from users of the
    // losing provider. This list has to refuse it for the same reason — and
    // the previous test deliberately uses a covering pair, the one shape where
    // a first-wins rule and the coverage rule agree, so only this case can
    // tell them apart.
    const { useMarketplaceList } = await import('../useMarketplaceList');
    const listing: ReturnType<typeof useMarketplaceList> = {
      ...MARKETPLACE_LIST_DEFAULTS,
      cache: {
        version: 2,
        lastRefreshed: '2026-10-25T12:00:00.000Z',
        marketplaces: [
          marketplaceInfo({
            id: 'claude-plugins-official',
            name: 'Claude Plugins',
            sourceType: 'github',
            sourceUrl: 'https://github.com/anthropics/claude-plugins-official',
            plugins: [
              {
                ...marketplacePlugin('slack', 'claude-plugins-official', '', {
                  claude: 'native',
                  codex: 'none',
                }),
              },
            ],
          }),
          marketplaceInfo({
            id: 'openai-curated-remote',
            name: 'Codex Curated',
            sourceType: 'codex',
            sourceUrl: 'openai-curated-remote',
            plugins: [
              {
                ...marketplacePlugin('slack', 'openai-curated-remote', '', {
                  claude: 'none',
                  codex: 'native',
                }),
              },
            ],
          }),
        ],
      },
      loading: false,
    };
    jest.mocked(useMarketplaceList).mockReturnValue(listing);

    Object.defineProperty(window, 'mcpServers', {
      configurable: true,
      value: {
        listCurated: jest.fn().mockResolvedValue({ version: 1, servers: [] }),
        listProviderConnectors: jest.fn().mockResolvedValue([]),
      },
    });

    const captured = mount();
    await flush();

    const slacks = captured.rows.filter(
      (row) => row.name.toLowerCase() === 'slack',
    );
    expect(slacks).toHaveLength(2);
  });
});

describe('a connector linked on one account does not claim the other', () => {
  it('names only the accounts it is actually linked on', async () => {
    // The catalog advertises Gmail on both providers. Linked on Claude alone,
    // the row is checked and reads "Linked" — so if the label still said
    // "Claude or Codex account" it would be telling a Codex user they have a
    // capability they do not have, in a row they cannot untick.
    Object.defineProperty(window, 'mcpServers', {
      configurable: true,
      value: {
        listCurated: jest
          .fn()
          .mockResolvedValue({ version: 1, servers: [GMAIL] }),
        listProviderConnectors: jest.fn().mockResolvedValue([
          {
            provider: 'claude',
            connectors: [
              {
                name: 'claude.ai Gmail',
                displayName: 'Gmail',
                connected: true,
                status: '✔ Connected',
              },
            ],
          },
          { provider: 'codex', connectors: [] },
        ]),
      },
    });

    const captured = mount();
    await flush();

    const gmail = captured.rows.find((row) => row.name === 'Gmail');
    expect(gmail?.toggleMode).toBe('locked');
    expect(gmail?.source).toBe('Claude account');
    expect(gmail?.source).not.toMatch(/codex/i);
  });
});

describe('the provider read is skipped when no row could come of it', () => {
  it('does not spawn the read for a catalog that advertises no connector', async () => {
    // The read spawns the Claude CLI (which health-checks every configured MCP
    // server) and parses the Codex caches. With no advertised connector there
    // is nothing to join it against, so every one of those results is
    // discarded — the catalog answers this first, and cheaply.
    const listCurated = jest.fn().mockResolvedValue({
      version: 1,
      servers: [{ ...GMAIL, providerConnector: undefined }],
    });
    const listProviderConnectors = jest.fn().mockResolvedValue([]);
    Object.defineProperty(window, 'mcpServers', {
      configurable: true,
      value: { listCurated, listProviderConnectors },
    });

    mount();
    await flush();

    expect(listCurated).toHaveBeenCalled();
    expect(listProviderConnectors).not.toHaveBeenCalled();
  });
});

describe('collapsing is opt-in', () => {
  it('leaves both copies for a caller that never asked to collapse', async () => {
    // The mirror of the `collapseDuplicates: true` case. The share modals and
    // the collection editors hold saved selections but pass no `selectedKeys`,
    // so collapsing there can hide a row the user's configuration refers to —
    // an agent whose selection points at the hidden copy becomes unshareable,
    // and a collapsed collection member renders unchecked and cannot be
    // removed. This guard shipped with no coverage at all: deleting it left
    // the whole renderer suite green.
    const { useMarketplaceList } = await import('../useMarketplaceList');
    const listing: ReturnType<typeof useMarketplaceList> = {
      ...MARKETPLACE_LIST_DEFAULTS,
      cache: {
        version: 2,
        lastRefreshed: '2026-10-25T12:00:00.000Z',
        marketplaces: [
          marketplaceInfo({
            id: 'claude-plugins-official',
            name: 'Claude Plugins',
            sourceType: 'github',
            sourceUrl: 'https://github.com/anthropics/claude-plugins-official',
            plugins: [
              {
                ...marketplacePlugin('slack', 'claude-plugins-official', '', {
                  claude: 'native',
                  codex: 'native',
                }),
              },
            ],
          }),
          marketplaceInfo({
            id: 'openai-curated-remote',
            name: 'Codex Curated',
            sourceType: 'codex',
            sourceUrl: 'openai-curated-remote',
            plugins: [
              {
                ...marketplacePlugin('slack', 'openai-curated-remote', '', {
                  claude: 'none',
                  codex: 'native',
                }),
              },
            ],
          }),
        ],
      },
      loading: false,
    };
    jest.mocked(useMarketplaceList).mockReturnValue(listing);

    Object.defineProperty(window, 'mcpServers', {
      configurable: true,
      value: {
        listCurated: jest.fn().mockResolvedValue({ version: 1, servers: [] }),
        listProviderConnectors: jest.fn().mockResolvedValue([]),
      },
    });

    const captured = mountWithoutCollapse();
    await flush();

    const slacks = captured.rows.filter(
      (row) => row.name.toLowerCase() === 'slack',
    );
    expect(slacks).toHaveLength(2);
  });
});

describe('the row never asserts a negative it cannot support', () => {
  it('says it could not check when a provider read failed', async () => {
    // A Claude CLI that is missing or errored is not the same as an account
    // with nothing linked. Reporting "Link it there to use it here" would be
    // stating a fact about the user's account that Canopy did not learn.
    Object.defineProperty(window, 'mcpServers', {
      configurable: true,
      value: {
        listCurated: jest
          .fn()
          .mockResolvedValue({ version: 1, servers: [GMAIL] }),
        listProviderConnectors: jest.fn().mockResolvedValue([
          {
            provider: 'claude',
            connectors: [],
            unavailableReason: 'cli-missing',
            detail: 'Claude CLI not found',
          },
          { provider: 'codex', connectors: [] },
        ]),
      },
    });

    const captured = mount();
    await flush();

    const gmail = captured.rows.find((row) => row.name === 'Gmail');
    expect(gmail?.toggleMode).toBe('disabled');
    expect(gmail?.sourceSubtitle).toMatch(/couldn’t check/i);
    expect(gmail?.sourceSubtitle).not.toMatch(/link it there/i);
  });

  it('still says checking while one provider is outstanding', async () => {
    // Claude answers, Codex has not. Requiring every provider to be pending
    // let the row report a settled negative about a read still in flight.
    Object.defineProperty(window, 'mcpServers', {
      configurable: true,
      value: {
        listCurated: jest
          .fn()
          .mockResolvedValue({ version: 1, servers: [GMAIL] }),
        listProviderConnectors: jest
          .fn()
          .mockResolvedValue([{ provider: 'claude', connectors: [] }]),
      },
    });

    const captured = mount();
    await flush();

    const gmail = captured.rows.find((row) => row.name === 'Gmail');
    expect(gmail?.sourceSubtitle).toMatch(/checking/i);
  });
});

describe('an entry advertising no providers is not a connector', () => {
  it('does not spawn the read for providerConnector: { providers: [] }', async () => {
    // The catalog reader tolerates an empty `providers` array for
    // forward-compatibility, so a `!== undefined` gate let it through — and it
    // then produced no row and no source option, having paid for a Claude CLI
    // spawn and a Codex cache parse. Three call sites had drifted into three
    // different answers to "does this advertise a connector".
    const listCurated = jest.fn().mockResolvedValue({
      version: 1,
      servers: [{ ...GMAIL, providerConnector: { providers: [] } }],
    });
    const listProviderConnectors = jest.fn().mockResolvedValue([]);
    Object.defineProperty(window, 'mcpServers', {
      configurable: true,
      value: { listCurated, listProviderConnectors },
    });

    const captured = mount();
    await flush();

    expect(listCurated).toHaveBeenCalled();
    expect(listProviderConnectors).not.toHaveBeenCalled();
    expect(captured.rows.some((row) => row.name === 'Gmail')).toBe(false);
    expect(
      captured.sourceOptions.some(
        (option) => option.value === 'provider-account',
      ),
    ).toBe(false);
  });
});

describe('a connector and the provider’s wrapper for it are one capability', () => {
  it('shows one Gmail, not the connector plus the marketplace wrapper', async () => {
    // The Codex marketplace publishes connector wrappers for exactly these
    // capabilities, so adding connector rows to this picker without the
    // Plugins page's suppression put two Gmails in the list — the duplicate
    // this change exists to remove, reintroduced on the surface it just fixed.
    // The wrapper is the one the user can tick and the one that dead-ends:
    // Canopy does not implement its ON_INSTALL auth.
    const { useMarketplaceList } = await import('../useMarketplaceList');
    const listing: ReturnType<typeof useMarketplaceList> = {
      ...MARKETPLACE_LIST_DEFAULTS,
      cache: {
        version: 2,
        lastRefreshed: '2026-10-25T12:00:00.000Z',
        marketplaces: [
          marketplaceInfo({
            id: 'openai-curated-remote',
            name: 'Codex Curated',
            sourceType: 'codex',
            sourceUrl: 'openai-curated-remote',
            plugins: [
              {
                ...marketplacePlugin(
                  'gmail',
                  'openai-curated-remote',
                  'Gmail connector',
                  { claude: 'none', codex: 'native' },
                ),
              },
            ],
          }),
        ],
      },
      loading: false,
    };
    jest.mocked(useMarketplaceList).mockReturnValue(listing);

    Object.defineProperty(window, 'mcpServers', {
      configurable: true,
      value: {
        listCurated: jest
          .fn()
          .mockResolvedValue({ version: 1, servers: [GMAIL] }),
        listProviderConnectors: jest.fn().mockResolvedValue([]),
      },
    });

    const captured = mount();
    await flush();

    const gmails = captured.rows.filter(
      (row) => row.name.toLowerCase() === 'gmail',
    );
    expect(gmails).toHaveLength(1);
    expect(gmails[0]?.key).toMatch(/^provider-connector:/);
  });
});

describe('a curated plugin is never suppressed by a connector name', () => {
  it('keeps a curated Gmail plugin beside the Gmail connector (REG-3033)', async () => {
    // The name rule exists for the provider marketplace's wrapper of a
    // connector. A curated plugin is not one: a multi-key plugin named like
    // a folded connector must keep its picker row, as it keeps its card on
    // the Plugins page.
    const { useMarketplaceList } = await import('../useMarketplaceList');
    const listing: ReturnType<typeof useMarketplaceList> = {
      ...MARKETPLACE_LIST_DEFAULTS,
      cache: {
        version: 2,
        lastRefreshed: '2026-10-25T12:00:00.000Z',
        marketplaces: [
          marketplaceInfo({
            id: 'curated/cloud',
            name: 'Curated',
            sourceType: 'github',
            sourceUrl: 'https://github.com/acme/curated',
            plugins: [
              {
                ...marketplacePlugin(
                  'gmail',
                  'curated/cloud',
                  'Gmail and Calendar skills',
                  { claude: 'native', codex: 'native' },
                ),
              },
            ],
          }),
        ],
      },
      loading: false,
    };
    jest.mocked(useMarketplaceList).mockReturnValue(listing);

    Object.defineProperty(window, 'mcpServers', {
      configurable: true,
      value: {
        listCurated: jest
          .fn()
          .mockResolvedValue({ version: 1, servers: [GMAIL] }),
        listProviderConnectors: jest.fn().mockResolvedValue([]),
      },
    });

    const captured = mount();
    await flush();

    const gmails = captured.rows.filter(
      (row) => row.name.toLowerCase() === 'gmail',
    );
    expect(gmails.map((row) => row.key).sort()).toEqual([
      'curated/cloud/gmail',
      expect.stringMatching(/^provider-connector:/),
    ]);
  });
});

describe('a server the user configured is never suppressed', () => {
  it('keeps a local Gmail MCP server alongside an unlinked Gmail connector', async () => {
    // Suppressing the provider's marketplace wrapper must not also remove the
    // user's own configured, enabled server for the same capability. That
    // swapped a working, selectable row for a `disabled` connector row reading
    // "Link it there to use it here" with nothing actually linked — the exact
    // "a working capability is replaced by a row saying it is not set up"
    // failure the Plugins page spends a paragraph guarding against.
    //
    // `selectedKeys` cannot rescue it either: the picker passes plugin keys
    // only, and MCP selections live in a set this hook never sees.
    const { useMcpServerList } = await import('../useMcpServerList');
    const servers: ReturnType<typeof useMcpServerList> = {
      servers: [
        {
          id: 'gmail-local',
          name: 'Gmail',
          description: 'Local Gmail server',
          type: 'command',
          curatedKey: 'gmail-gmailmcp',
          configs: [{ id: 'default', name: 'default', enabled: true }],
          updatedAt: '2026-10-25T12:00:00.000Z',
        },
      ],
      loading: false,
      error: null,
      refresh: (): Promise<void> => Promise.resolve(),
    };
    jest.mocked(useMcpServerList).mockReturnValue(servers);

    Object.defineProperty(window, 'mcpServers', {
      configurable: true,
      value: {
        listCurated: jest
          .fn()
          .mockResolvedValue({ version: 1, servers: [GMAIL] }),
        listProviderConnectors: jest.fn().mockResolvedValue([]),
      },
    });

    const captured = mount();
    await flush();

    const gmails = captured.rows.filter(
      (row) => row.name.toLowerCase() === 'gmail',
    );
    const local = gmails.find((row) => row.key === 'gmail-local/default');
    // The regression replaced a working, selectable server with a `disabled`
    // row, so identity and affordance are both part of the claim — asserting
    // only that *some* non-connector Gmail row exists would pass on a row the
    // user still could not use.
    expect(local).toBeDefined();
    expect(local?.toggleMode).not.toBe('disabled');

    // The module-factory mock is a `jest.fn()`; `restoreAllMocks` only restores
    // spies, so without this the rest of the file inherits a configured server.
    jest.mocked(useMcpServerList).mockReturnValue({
      servers: [],
      loading: false,
      error: null,
      refresh: (): Promise<void> => Promise.resolve(),
    });
  });
});

describe('a connector row states a fact rather than a selection', () => {
  it('is built excluded from the selection count', async () => {
    // `UnifiedTable` honours the flag — that is covered there — but nothing
    // asserted the row builder sets it, so an edit here silently brings back
    // "1 MCP server selected" for something the user never chose.
    Object.defineProperty(window, 'mcpServers', {
      configurable: true,
      value: {
        listCurated: jest
          .fn()
          .mockResolvedValue({ version: 1, servers: [GMAIL] }),
        listProviderConnectors: jest.fn().mockResolvedValue([]),
      },
    });

    const captured = mount();
    await flush();

    const gmail = captured.rows.find((row) => row.name === 'Gmail');
    expect(gmail?.excludeFromSelectionCount).toBe(true);
  });
});

describe('a connector advertising an unrecognised provider', () => {
  it('produces no row at all', async () => {
    // `advertisesProviderConnector` passes `providers: ['gemini']` — it only
    // counts them — but the join filters to nothing through `PROVIDER_ORDER`.
    // Without the empty-providers guard that becomes a dead row whose Source
    // cell reads " account".
    Object.defineProperty(window, 'mcpServers', {
      configurable: true,
      value: {
        listCurated: jest.fn().mockResolvedValue({
          version: 1,
          servers: [{ ...GMAIL, providerConnector: { providers: ['gemini'] } }],
        }),
        listProviderConnectors: jest.fn().mockResolvedValue([]),
      },
    });

    const captured = mount();
    await flush();

    expect(captured.rows.some((row) => row.name === 'Gmail')).toBe(false);
  });
});
