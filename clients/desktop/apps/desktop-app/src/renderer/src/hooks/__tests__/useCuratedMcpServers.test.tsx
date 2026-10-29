/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { CuratedMcpServerListResponse } from '@canopy/protocol/mcp-catalog';
import { useCuratedMcpServers } from '../useCuratedMcpServers';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

interface RenderRecord {
  readonly enabled: boolean;
  readonly loading: boolean;
  readonly entries: number;
}

let renders: RenderRecord[] = [];
function Harness({ enabled }: { enabled: boolean }): null {
  const { loading, entries } = useCuratedMcpServers({ enabled });
  renders.push({ enabled, loading, entries: entries.length });
  return null;
}

let container: HTMLDivElement;
let root: Root;
let resolveList: (value: CuratedMcpServerListResponse) => void = (): void =>
  undefined;
const listCurated = jest.fn(
  (): Promise<CuratedMcpServerListResponse> =>
    new Promise((resolve) => {
      resolveList = resolve;
    }),
);

beforeEach((): void => {
  renders = [];
  listCurated.mockClear();
  Object.defineProperty(window, 'mcpServers', {
    configurable: true,
    value: { listCurated, refreshCurated: listCurated },
  });
  container = document.createElement('div');
  root = createRoot(container);
});

afterEach((): void => {
  act((): void => root.unmount());
  Reflect.deleteProperty(window, 'mcpServers');
});

async function flush(): Promise<void> {
  await act(async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

it('reads as loading from the first render it is enabled until the catalog arrives', async (): Promise<void> => {
  act((): void => root.render(<Harness enabled={false} />));
  await flush();
  expect(listCurated).not.toHaveBeenCalled();
  expect(renders.at(-1)).toEqual({
    enabled: false,
    loading: false,
    entries: 0,
  });

  act((): void => root.render(<Harness enabled />));
  await flush();
  expect(listCurated).toHaveBeenCalledTimes(1);
  expect(renders.filter((record) => record.enabled && !record.loading)).toEqual(
    [],
  );

  act((): void => resolveList({ version: 1, servers: [] }));
  await flush();
  expect(renders.at(-1)).toEqual({ enabled: true, loading: false, entries: 0 });
});

it('resolves a forced refresh to the entries it loaded, empty when it fails', async (): Promise<void> => {
  const entry = {
    key: 'datadog',
    name: 'Datadog',
    shortDescription: '',
    url: 'https://mcp.example.test/mcp',
    transport: 'http' as const,
    categories: [],
    popular: false,
    sortOrder: 0,
    updatedAt: '2026-10-01T00:00:00.000Z',
  };
  const refreshCurated = jest
    .fn()
    .mockResolvedValueOnce({ version: 1, servers: [entry] })
    .mockRejectedValueOnce(new Error('offline'));
  Object.defineProperty(window, 'mcpServers', {
    configurable: true,
    value: {
      listCurated: (): Promise<CuratedMcpServerListResponse> =>
        Promise.resolve({ version: 1, servers: [] }),
      refreshCurated,
    },
  });
  let refresh: (() => Promise<unknown>) | undefined;
  function RefreshHarness(): null {
    refresh = useCuratedMcpServers().refresh;
    return null;
  }
  act((): void => root.render(<RefreshHarness />));
  await flush();
  let loaded: unknown;
  await act(async (): Promise<void> => {
    loaded = await refresh?.();
  });
  expect(loaded).toEqual([entry]);
  await act(async (): Promise<void> => {
    loaded = await refresh?.();
  });
  expect(loaded).toEqual([]);
});
