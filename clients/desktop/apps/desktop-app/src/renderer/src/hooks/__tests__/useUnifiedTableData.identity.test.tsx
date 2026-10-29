/**
 * @jest-environment jsdom
 *
 * Its own file because the mocks have to return *stable* arrays. The other
 * suites' mocks build a fresh `[]` on every call, which rebuilds the row set
 * every render for reasons that have nothing to do with the code under test —
 * an identity assertion there would be measuring the harness.
 */
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InstalledItemSnapshot } from '@canopy/protocol/installed-items';
let mockInstalledSnapshot: InstalledItemSnapshot = { items: [] };
let mockInstalledReadError: string | null = null;
jest.mock('../useDesktopInstalledItemStatuses', () => ({
  useDesktopInstalledItemStatuses: (): {
    state:
      | { kind: 'ready'; snapshot: InstalledItemSnapshot }
      | { kind: 'error'; message: string };
  } => ({
    state:
      mockInstalledReadError === null
        ? { kind: 'ready', snapshot: mockInstalledSnapshot }
        : { kind: 'error', message: mockInstalledReadError },
  }),
}));

const NO_SKILLS: unknown[] = [];
const NO_COLLECTIONS: unknown[] = [];
const NO_SERVERS: unknown[] = [];
const MARKETPLACES = {
  cache: {
    marketplaces: [
      {
        id: 'demo-market',
        name: 'Demo',
        sourceType: 'github',
        sourceUrl: 'https://github.com/demo/market',
        plugins: [
          {
            name: 'alpha',
            marketplaceId: 'demo-market',
            description: '',
            providerSupport: { claude: 'native', codex: 'native' },
          },
          {
            name: 'beta',
            marketplaceId: 'demo-market',
            description: '',
            providerSupport: { claude: 'native', codex: 'native' },
          },
        ],
      },
    ],
  },
  loading: false,
};

jest.mock('../useSkillList', () => ({
  useSkillList: (): unknown => ({ skills: NO_SKILLS, loading: false }),
}));
jest.mock('../useMarketplaceList', () => ({
  useMarketplaceList: (): unknown => MARKETPLACES,
}));
jest.mock('../useCollectionList', () => ({
  useCollectionList: (): unknown => ({
    collections: NO_COLLECTIONS,
    loading: false,
  }),
}));
jest.mock('../useMcpServerList', () => ({
  useMcpServerList: (): unknown => ({ servers: NO_SERVERS, loading: false }),
}));

import {
  useUnifiedTableData,
  type UnifiedTableRow,
} from '../useUnifiedTableData';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  mockInstalledSnapshot = { items: [] };
  mockInstalledReadError = null;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  Object.defineProperty(window, 'mcpServers', {
    configurable: true,
    value: {
      listCurated: jest.fn().mockResolvedValue({ version: 1, servers: [] }),
      listProviderConnectors: jest.fn().mockResolvedValue([]),
    },
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('a checkbox toggle does not rebuild the catalog', () => {
  it('excludes Disabled candidates while retaining selected Disabled rows with their reason', async () => {
    mockInstalledSnapshot = {
      items: [
        {
          target: {
            kind: 'plugin',
            marketplaceId: 'demo-market',
            pluginName: 'alpha',
          },
          status: 'disabled',
          removable: true,
          notices: [],
        },
      ],
    };
    let rows: UnifiedTableRow[] = [];
    let retained = new Set<string>();
    function Probe(): null {
      rows = useUnifiedTableData({
        includeCollections: false,
        includeMcp: false,
        retainedDisabledKeys: retained,
      }).rows;
      return null;
    }
    await act(async () => {
      root.render(<Probe />);
      await Promise.resolve();
    });
    expect(rows.map((row) => row.name)).toEqual(['beta']);
    retained = new Set(['plugin:demo-market/alpha']);
    await act(async () => {
      root.render(<Probe />);
      await Promise.resolve();
    });
    expect(rows.find((row) => row.name === 'alpha')).toMatchObject({
      toggleMode: 'unsupported',
      badges: [{ label: 'Disabled', tone: 'neutral' }],
    });
  });
  // A failed status read must not take every row out of the picker: Disabled
  // is still enforced where selections load and run.
  it('keeps rows selectable with a warning when the status read fails', async () => {
    let rows: UnifiedTableRow[] = [];
    function Probe(): null {
      rows = useUnifiedTableData({
        includeCollections: false,
        includeMcp: false,
      }).rows;
      return null;
    }
    await act(async () => {
      root.render(<Probe />);
      await Promise.resolve();
    });
    const ready = rows;
    mockInstalledReadError =
      'Status could not be loaded. Refresh to try again.';
    await act(async () => {
      root.render(<Probe />);
      await Promise.resolve();
    });
    expect(rows.map((row) => row.name)).toEqual(['alpha', 'beta']);
    for (const row of rows) {
      const before = ready.find((candidate) => candidate.key === row.key);
      expect(row.toggleMode).toBe(before?.toggleMode);
      expect(row.toggleMode).not.toBe('unsupported');
      expect(row.toggleReason).toBe(before?.toggleReason);
      expect(row.badges).toContainEqual({
        label: 'Status unavailable',
        tone: 'warning',
      });
    }
  });
  it('keeps the rows array identical when nothing displayed changed', async () => {
    // Folding the selection into the row builder rebuilt every row object on
    // every toggle. `React.memo` on the rows then cannot help, the
    // whole-catalog `localeCompare` sort re-runs, and the selection summary
    // re-derives. CLAUDE.md pins this ("a selection toggle re-renders one row
    // rather than the whole body") and the perf harness measures it against
    // 850–1,700 plugins.
    const seen: UnifiedTableRow[][] = [];
    let selected = new Set<string>();
    function Probe(): null {
      seen.push(
        useUnifiedTableData({
          includeCollections: false,
          includeMcp: true,
          includeProviderConnectors: true,
          collapseDuplicates: true,
          selectedKeys: selected,
        }).rows,
      );
      return null;
    }

    act(() => root.render(<Probe />));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const before = seen[seen.length - 1];

    selected = new Set(['demo-market/alpha']);
    act(() => root.render(<Probe />));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(seen[seen.length - 1]).toBe(before);
  });
});
