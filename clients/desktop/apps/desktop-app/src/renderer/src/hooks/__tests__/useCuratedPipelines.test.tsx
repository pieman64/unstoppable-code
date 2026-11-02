/** @jest-environment jsdom */
import { act, useLayoutEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { CuratedPipelineDetail } from '@canopy/protocol/pipeline-catalog';
import { CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT } from '@canopy/desktop-shared/constants/canopy-cloud';
let mockProps: CuratedPipelinesController;
import {
  useCuratedPipelines,
  type CuratedPipelinesController,
} from '../useCuratedPipelines';
let options: Parameters<typeof useCuratedPipelines>[0] = {};
function Harness(): null {
  mockProps = useCuratedPipelines(options);
  return null;
}
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});
const detail: CuratedPipelineDetail = {
  key: 'review',
  name: 'Review',
  shortDescription: '',
  version: '1',
  icon: '',
  triggerTypes: ['dispatch'],
  scopes: ['directory'],
  jobCount: 1,
  stepCount: 1,
  contentHash: 'a'.repeat(64),
  contentSizeBytes: 12,
  categories: [],
  popular: false,
  sortOrder: 0,
  revision: 1,
  authorName: null,
  authorUrl: null,
  docsUrl: null,
  createdAt: '2026-09-10',
  updatedAt: '2026-09-10',
  rawPipeline: 'name: Review',
};
const mockList = jest.fn();
const mockGet = jest.fn();
const mockImport = jest.fn();
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  options = {};
  Object.defineProperty(window, 'pipelines', {
    configurable: true,
    value: {
      listCurated: mockList,
      getCurated: mockGet,
      importCurated: mockImport,
    },
  });
  mockList.mockResolvedValue({
    success: true,
    data: { version: 1, data: [detail], nextCursor: null, stale: false },
  });
  container = document.createElement('div');
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  jest.useRealTimers();
});
async function mount(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    root.render(<Harness />);
  });
  await act(async () => {
    await Promise.resolve();
    jest.advanceTimersByTime(201);
  });
}
it('never fetches content when listing and sends only reviewed identity/hash to import', async () => {
  mockGet.mockResolvedValue({ success: true, data: detail });
  mockImport.mockResolvedValue({ success: true, data: { id: 'copy' } });
  await mount();
  expect(mockGet).not.toHaveBeenCalled();
  expect(mockProps.rows).toHaveLength(1);
  await act(async () => {
    await Promise.resolve();
    mockProps.onSelect(detail);
  });
  expect(mockGet).toHaveBeenCalledWith('review');
  await act(async () => {
    await Promise.resolve();
    mockProps.onImport(detail);
  });
  expect(mockImport).toHaveBeenCalledWith({
    key: 'review',
    expectedContentHash: detail.contentHash,
  });
  expect(mockProps.importedPipelineId).toBe('copy');
});
it('discards an old selection response after Back', async () => {
  let finish!: (value: unknown) => void;
  mockGet.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  await mount();
  await act(async () => {
    await Promise.resolve();
    mockProps.onSelect(detail);
  });
  await act(async () => {
    await Promise.resolve();
    mockProps.onBack();
    finish({ success: true, data: detail });
  });
  expect(mockProps.selectedKey).toBeNull();
  expect(mockProps.detail).toBeNull();
});
it('clears an old account detail and does not display a late import result', async () => {
  let finish!: (value: unknown) => void;
  mockGet.mockResolvedValue({ success: true, data: detail });
  mockImport.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  await mount();
  await act(async () => {
    await Promise.resolve();
    mockProps.onSelect(detail);
  });
  await act(async () => {
    await Promise.resolve();
    mockProps.onImport(detail);
  });
  await act(async () => {
    await Promise.resolve();
    window.dispatchEvent(new Event(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT));
    finish({ success: true, data: { id: 'old-account-copy' } });
  });
  expect(mockProps.detail).toBeNull();
  expect(mockProps.importedPipelineId).toBeNull();
  expect(mockProps.rows).toEqual([]);
});

it('refreshes the local inventory after Add completes with the preview closed', async () => {
  const onImported = jest.fn();
  options = { onImported };
  let finish!: (value: unknown) => void;
  mockGet.mockResolvedValue({ success: true, data: detail });
  mockImport.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  await mount();
  await act(async () => {
    await Promise.resolve();
    mockProps.onSelect(detail);
  });
  await act(async () => {
    await Promise.resolve();
    mockProps.onImport(detail);
  });
  await act(async () => {
    await Promise.resolve();
    mockProps.onBack();
    finish({ success: true, data: { id: 'copy' } });
  });
  expect(onImported).toHaveBeenCalledTimes(1);
  expect(mockProps.selectedKey).toBeNull();
  expect(mockProps.importedPipelineId).toBeNull();
});
it('does not read the catalog for an excluded source', async () => {
  options = { enabled: false };
  await mount();
  expect(mockList).not.toHaveBeenCalled();
  expect(mockGet).not.toHaveBeenCalled();
});
it('does not refresh the catalog for an excluded source', async () => {
  options = { enabled: false };
  await mount();
  await act(async () => {
    await Promise.resolve();
    mockProps.onRefresh();
  });
  expect(mockList).not.toHaveBeenCalled();
});
it('loads every unfiltered metadata page for client-side fuzzy search', async () => {
  options = { q: 'crw' };
  mockList
    .mockResolvedValueOnce({
      success: true,
      data: { version: 1, data: [detail], nextCursor: 'page2', stale: false },
    })
    .mockResolvedValueOnce({
      success: true,
      data: {
        version: 1,
        data: [{ ...detail, key: 'second', name: 'Code review workflow' }],
        nextCursor: null,
        stale: false,
      },
    });
  await mount();
  expect(mockList).toHaveBeenNthCalledWith(
    1,
    expect.objectContaining({ q: undefined, limit: 100, cursor: undefined }),
  );
  expect(mockList).toHaveBeenNthCalledWith(
    2,
    expect.objectContaining({ q: undefined, limit: 100, cursor: 'page2' }),
  );
  expect(mockProps.rows.map((row) => row.key)).toEqual(['review', 'second']);
  expect(mockProps.nextCursor).toBeNull();
});
it('forwards common query, trigger, category and scope and resets paging when filters change', async () => {
  options = {
    q: 'review',
    scope: 'directory',
    category: 'development',
    triggerType: 'dispatch',
  };
  mockList
    .mockResolvedValueOnce({
      success: true,
      data: { version: 1, data: [detail], nextCursor: 'page2', stale: false },
    })
    .mockResolvedValueOnce({
      success: true,
      data: { version: 1, data: [], nextCursor: null, stale: false },
    });
  await mount();
  expect(mockList).toHaveBeenNthCalledWith(
    1,
    expect.objectContaining({
      q: undefined,
      limit: 100,
      scope: 'directory',
      category: 'development',
      triggerType: 'dispatch',
      cursor: undefined,
    }),
  );
  expect(mockList).toHaveBeenNthCalledWith(
    2,
    expect.objectContaining({ cursor: 'page2' }),
  );
  options = { q: 'other', scope: 'worktree' };
  mockList.mockResolvedValueOnce({
    success: true,
    data: { version: 1, data: [], nextCursor: null, stale: false },
  });
  await mount();
  expect(mockList).toHaveBeenNthCalledWith(
    3,
    expect.objectContaining({
      q: undefined,
      limit: 100,
      scope: 'worktree',
      cursor: undefined,
    }),
  );
  expect(mockGet).not.toHaveBeenCalled();
});
it('keeps already loaded rows and a retryable cursor when loading another page fails', async () => {
  mockList.mockResolvedValueOnce({
    success: true,
    data: { version: 1, data: [detail], nextCursor: 'page2', stale: false },
  });
  await mount();
  mockList.mockRejectedValueOnce(new Error('offline'));
  await act(async () => {
    await Promise.resolve();
    mockProps.onLoadMore();
  });
  expect(mockProps.rows).toHaveLength(1);
  expect(mockProps.nextCursor).toBe('page2');
  expect(mockProps.error).toBe('offline');
});

it('reports a changed query as loading from the render that changed it', async () => {
  const commits: { q: string | undefined; loading: boolean; rows: number }[] =
    [];
  function Probe(): null {
    const controller = useCuratedPipelines(options);
    useLayoutEffect(() => {
      commits.push({
        q: controller.query.q,
        loading: controller.loading,
        rows: controller.rows.length,
      });
    });
    return null;
  }
  mockList.mockResolvedValue({
    success: true,
    data: { version: 1, data: [], nextCursor: null, stale: false },
  });
  options = { q: 'no match' };
  await act(async () => {
    await Promise.resolve();
    root.render(<Probe />);
  });
  await act(async () => {
    await Promise.resolve();
    jest.advanceTimersByTime(201);
  });
  expect(commits.at(-1)).toEqual({ q: 'no match', loading: false, rows: 0 });
  commits.length = 0;
  options = {};
  act(() => {
    root.render(<Probe />);
  });
  // No committed render shows the reset query as a settled, empty catalog.
  expect(commits[0]).toEqual({ q: undefined, loading: true, rows: 0 });
});
