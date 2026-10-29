/**
 * @jest-environment jsdom
 *
 * Hook-level behavior the pure composition tests cannot cover: two Add
 * clicks inside the same pre-render window must merge cumulatively. The
 * regression was `enablePlugins` merging onto the mount-time selections
 * base, so the second click's persisted write silently dropped the first.
 */

import { act, createElement } from 'react';
import type { ProviderConnectorListResult } from '@canopy/desktop-shared/types/mcp-servers';
let mockConnectorResults: ProviderConnectorListResult[] = [];
const mockRefreshServers = jest
  .fn<Promise<void>, []>()
  .mockResolvedValue(undefined);
const mockRefreshConnectors = jest.fn<void, []>();
jest.mock('@/hooks/useCuratedMcpServers', () => ({
  useCuratedMcpServers: (): { entries: [] } => ({ entries: [] }),
}));
jest.mock('@/hooks/useDetectedMcpServers', () => ({
  useDetectedMcpServers: (): {
    servers: [];
    initializing: boolean;
    refresh: typeof mockRefreshServers;
  } => ({ servers: [], initializing: false, refresh: mockRefreshServers }),
}));
jest.mock('@/hooks/useProviderConnectors', () => ({
  useProviderConnectors: (): {
    results: ProviderConnectorListResult[];
    refresh: typeof mockRefreshConnectors;
  } => ({ results: mockConnectorResults, refresh: mockRefreshConnectors }),
}));
import { createRoot, type Root } from 'react-dom/client';
import type { ChatTabPluginSelections } from '@canopy/desktop-shared/types';
import type { CuratedOnboardingPlugin } from '@/lib/onboarding/curatedOnboardingPlugins';
import {
  usePluginSuggestions,
  type PluginSuggestionsOptions,
  type PluginSuggestionsResult,
} from '../usePluginSuggestions';

const CATALOG: CuratedOnboardingPlugin[] = [
  {
    key: 'curated/gmail',
    marketplaceId: 'curated',
    name: 'gmail',
    displayName: 'Gmail',
    description: 'Gmail plugin',
    recommended: false,
  },
  {
    key: 'curated/slack',
    marketplaceId: 'curated',
    name: 'slack',
    displayName: 'Slack',
    description: 'Slack plugin',
    recommended: false,
  },
];

jest.mock('@/lib/onboarding/curatedOnboardingPlugins', () => ({
  selectBundledOnboardingPlugins: (): CuratedOnboardingPlugin[] => CATALOG,
  // Name-matched here; the source-aware resolution has its own unit tests.
  // A GitHub ref stands in for "the same name from another marketplace".
  selectBlueprintOnboardingPlugins: (
    _cache: unknown,
    refs: ReadonlyArray<{
      type: string;
      plugin_name?: string;
      marketplace?: { type: string };
    }>,
  ): CuratedOnboardingPlugin[] =>
    refs.flatMap((ref) => {
      if (ref.type === 'skill') return [];
      const row = CATALOG.find((entry) => entry.name === ref.plugin_name);
      if (!row) return [];
      return ref.marketplace?.type === 'github'
        ? [
            {
              ...row,
              key: `someone/else/${row.name}`,
              marketplaceId: 'someone/else',
            },
          ]
        : [row];
    }),
  curatedPluginKey: (marketplaceId: string, pluginName: string): string =>
    `${marketplaceId}/${pluginName}`.toLowerCase(),
  // Append-only merge — enough fidelity to observe whether the second
  // enable call's base already contains the first call's result.
  mergeCuratedPluginSelections: (
    base: ChatTabPluginSelections,
    rows: CuratedOnboardingPlugin[],
  ): ChatTabPluginSelections => ({
    ...base,
    pluginRefs: [
      ...base.pluginRefs,
      ...rows.map((row) => ({
        marketplaceId: row.marketplaceId,
        pluginName: row.name,
      })),
    ],
  }),
}));

jest.mock('@/components/suggestions/mcpPromptIndex', () => ({
  MCP_PROMPT_INDEX: {},
  synthesizedPromptForServer: (
    _key: string,
    displayName: string,
  ): { text: string } => ({ text: `Try ${displayName}` }),
}));

const mockLoadMarketplaces = jest
  .fn()
  .mockResolvedValue({ success: true, data: null });
const mockSavePreferences = jest.fn<
  Promise<void>,
  [{ globalPluginSelections: ChatTabPluginSelections }]
>();

function emptySelections(): ChatTabPluginSelections {
  return { collectionIds: [], skillRefs: [], pluginRefs: [] };
}

let preferencesListener: ((prefs: Record<string, unknown>) => void) | null =
  null;
let latest: PluginSuggestionsResult | null = null;
let probeOptions: PluginSuggestionsOptions | undefined;
function Probe(): ReturnType<typeof createElement> {
  latest = usePluginSuggestions(null, probeOptions);
  return createElement('div');
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
    configurable: true,
    value: true,
  });
  jest.clearAllMocks();
  mockConnectorResults = [];
  latest = null;
  probeOptions = undefined;
  let savedSelections = emptySelections();
  mockSavePreferences.mockImplementation((prefs) => {
    savedSelections = prefs.globalPluginSelections;
    return Promise.resolve();
  });
  Object.defineProperty(window, 'plugins', {
    configurable: true,
    value: {
      loadMarketplacesCacheOnly: mockLoadMarketplaces,
    },
  });
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      loadPreferences: jest.fn().mockImplementation(() =>
        Promise.resolve({
          globalPluginSelections: savedSelections,
        }),
      ),
      savePreferences: mockSavePreferences,
      onPreferencesSynced: (
        listener: (prefs: Record<string, unknown>) => void,
      ): (() => void) => {
        preferencesListener = listener;
        return () => {
          preferencesListener = null;
        };
      },
    },
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
    await Promise.resolve();
  });
  container.remove();
});

describe('usePluginSuggestions enablePlugins', () => {
  it('merges consecutive same-window enables cumulatively into the persisted write', async () => {
    await act(async () => {
      root.render(createElement(Probe));
      await Promise.resolve();
    });
    expect(latest?.ready).toBe(true);

    // Two Add clicks before React re-renders between them.
    await act(async () => {
      const first = latest?.enablePlugins(['curated/gmail']);
      const second = latest?.enablePlugins(['curated/slack']);
      expect(await first).toBe(true);
      expect(await second).toBe(true);
    });

    expect(mockSavePreferences).toHaveBeenCalledTimes(2);
    expect(mockRefreshConnectors).toHaveBeenCalledTimes(2);
    expect(mockRefreshServers).toHaveBeenCalledTimes(2);
    const secondWrite = mockSavePreferences.mock.calls[1][0];
    const selections: unknown = secondWrite.globalPluginSelections;
    const pluginNames =
      selections !== null &&
      typeof selections === 'object' &&
      'pluginRefs' in selections &&
      Array.isArray(selections.pluginRefs)
        ? selections.pluginRefs.map((ref: { pluginName: string }) =>
            String(ref.pluginName),
          )
        : [];
    // The second write must still contain the FIRST click's plugin.
    expect(pluginNames).toEqual(['gmail', 'slack']);
  });
});

test('recognizes provider-linked tools without a global selection and excludes disconnected tools even when selected', async () => {
  mockConnectorResults = [
    {
      provider: 'codex',
      connectors: [{ displayName: 'Gmail', connected: true }],
    },
  ];
  await act(async () => {
    root.render(createElement(Probe));
    await Promise.resolve();
  });
  expect(
    latest?.suggestions.find((row) => row.key === 'universal:gmail')?.enabled,
  ).toBe(true);
  mockConnectorResults = [
    {
      provider: 'codex',
      connectors: [{ displayName: 'Gmail', connected: false }],
    },
  ];
  await act(async () => {
    preferencesListener?.({
      globalPluginSelections: {
        ...emptySelections(),
        pluginRefs: [{ marketplaceId: 'curated', pluginName: 'gmail' }],
      },
    });
    await Promise.resolve();
  });
  expect(
    latest?.suggestions.find((row) => row.key === 'universal:gmail')?.enabled,
  ).toBe(false);
});

test('observes plugins enabled from another surface without remounting the queue', async () => {
  await act(async () => {
    root.render(createElement(Probe));
    await Promise.resolve();
  });
  expect(
    latest?.suggestions.find((row) => row.key === 'universal:slack')?.enabled,
  ).toBe(false);
  await act(async () => {
    preferencesListener?.({
      globalPluginSelections: {
        ...emptySelections(),
        pluginRefs: [{ marketplaceId: 'curated', pluginName: 'slack' }],
      },
    });
    await Promise.resolve();
  });
  expect(
    latest?.suggestions.find((row) => row.key === 'universal:slack')?.enabled,
  ).toBe(true);
  await act(async () => {
    preferencesListener?.({ globalPluginSelections: emptySelections() });
    await Promise.resolve();
  });
  expect(
    latest?.suggestions.find((row) => row.key === 'universal:slack')?.enabled,
  ).toBe(false);
});

test('refreshes recommendations when returning to the app', async () => {
  await act(async () => {
    root.render(createElement(Probe));
    await Promise.resolve();
  });
  const reads = mockLoadMarketplaces.mock.calls.length;
  await act(async () => {
    window.dispatchEvent(new Event('focus'));
    await Promise.resolve();
  });
  expect(mockLoadMarketplaces).toHaveBeenCalledTimes(reads + 1);
});

test('a template project’s own selections enable its rows without touching the general suggestions (CAN-3032)', async () => {
  probeOptions = {
    blueprintPluginRefs: [
      {
        type: 'claude_plugin',
        marketplace: { type: 'builtin', id: 'app' },
        plugin_name: 'slack',
      },
    ],
    projectSelections: {
      ...emptySelections(),
      pluginRefs: [{ marketplaceId: 'curated', pluginName: 'slack' }],
    },
  };
  await act(async () => {
    root.render(createElement(Probe));
    await Promise.resolve();
  });
  expect(latest?.ready).toBe(true);
  expect(
    latest?.blueprintSuggestions.find((row) => row.name === 'slack')?.enabled,
  ).toBe(true);
  // The general shortlist still reads Slack as not enabled: a project's
  // seed-time selections must never retire a global lesson.
  expect(
    latest?.suggestions.find((row) => row.key === 'universal:slack')?.enabled,
  ).toBe(false);
});

test('a same-named plugin from another marketplace does not enable a template row (CAN-3032)', async () => {
  probeOptions = {
    blueprintPluginRefs: [
      {
        type: 'claude_plugin',
        marketplace: { type: 'builtin', id: 'app' },
        plugin_name: 'slack',
      },
    ],
    projectSelections: {
      ...emptySelections(),
      pluginRefs: [{ marketplaceId: 'someone/else', pluginName: 'slack' }],
    },
  };
  await act(async () => {
    root.render(createElement(Probe));
    await Promise.resolve();
  });
  expect(latest?.ready).toBe(true);
  expect(
    latest?.blueprintSuggestions.find((row) => row.name === 'slack')?.enabled,
  ).toBe(false);
});

test('an in-session enable of a same-named plugin from another marketplace leaves the template row pending (CAN-3032)', async () => {
  probeOptions = {
    blueprintPluginRefs: [
      {
        type: 'claude_plugin',
        marketplace: { type: 'github', repo: 'someone/else' },
        plugin_name: 'slack',
      },
    ],
  };
  await act(async () => {
    root.render(createElement(Probe));
    await Promise.resolve();
  });
  await act(async () => {
    expect(await latest?.enablePlugins(['curated/slack'])).toBe(true);
  });
  // The general row is on; the template's own copy of Slack is not.
  expect(
    latest?.suggestions.find((row) => row.key === 'universal:slack')?.enabled,
  ).toBe(true);
  expect(
    latest?.blueprintSuggestions.find((row) => row.key === 'someone/else/slack')
      ?.enabled,
  ).toBe(false);
});
