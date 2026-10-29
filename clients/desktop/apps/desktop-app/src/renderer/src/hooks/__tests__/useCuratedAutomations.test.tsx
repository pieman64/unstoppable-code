/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  CuratedAutomationDetail,
  CuratedAutomationSummary,
} from '@canopy/protocol/automation-catalog';
import { CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT } from '@canopy/desktop-shared/constants/canopy-cloud';
import type { ScheduledActivity } from '@canopy/desktop-shared/types';
import { useAutomationsStore } from '@/stores/automationsStore';
import {
  useCuratedAutomations,
  type CuratedAutomationsController,
} from '../useCuratedAutomations';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

const CURRENT = 'a'.repeat(64);
const OLDER = 'b'.repeat(64);

function summary(
  key: string,
  overrides: Partial<CuratedAutomationSummary> = {},
): CuratedAutomationSummary {
  return {
    key,
    name: key,
    shortDescription: '',
    icon: '',
    triggerKind: 'cron',
    cronExpression: '0 9 * * 1-5',
    actionType: 'app_advisor_prompt',
    pipelineSource: null,
    referencedCuratedPipelineKey: null,
    pluginCount: 0,
    contentHash: CURRENT,
    contentSizeBytes: 64,
    categories: [],
    popular: false,
    sortOrder: 0,
    revision: 1,
    authorName: null,
    authorUrl: null,
    docsUrl: null,
    createdAt: '2026-09-10T00:00:00.000Z',
    updatedAt: '2026-09-10T00:00:00.000Z',
    ...overrides,
  };
}

const detail: CuratedAutomationDetail = {
  ...summary('daily-review'),
  automation: {
    version: 2,
    name: 'Daily review',
    description: '',
    trigger: { kind: 'cron', expression: '0 9 * * 1-5', timezone: 'local' },
    action: { type: 'app_advisor_prompt', prompt: 'Review', plugins: [] },
    hasRunCondition: false,
  },
};

function installedCopy(contentHash: string): ScheduledActivity {
  return {
    version: 1,
    id: 'copy',
    name: 'Daily review',
    enabled: false,
    schedule: { kind: 'cron', expression: '0 9 * * 1-5', timezone: 'local' },
    action: { type: 'app_advisor_prompt', prompt: 'Review' },
    createdAt: '2026-08-19T00:00:00.000Z',
    updatedAt: '2026-08-19T00:00:00.000Z',
    failureCount: 0,
    installedFrom: {
      remoteId: 'daily-review',
      contentHash,
      installedAt: '2026-08-19T00:00:00.000Z',
      sourceKind: 'curated',
    },
  };
}

const mockList = jest.fn();
const mockGet = jest.fn();
let controller: CuratedAutomationsController;
let options: Parameters<typeof useCuratedAutomations>[0] = {};
function Harness(): null {
  controller = useCuratedAutomations(options);
  return null;
}
let root: Root;

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  options = {};
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { automations: { listCurated: mockList, getCurated: mockGet } },
  });
  mockList.mockResolvedValue({
    version: 1,
    data: [summary('daily-review')],
    nextCursor: null,
    stale: false,
  });
  useAutomationsStore.setState({ activities: [] });
  root = createRoot(document.createElement('div'));
});

afterEach(() => {
  act(() => root.unmount());
  jest.useRealTimers();
});

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    jest.advanceTimersByTime(201);
  });
  await act(async () => {
    await Promise.resolve();
  });
}

async function mount(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    root.render(<Harness />);
  });
  await settle();
}

it('lists summaries after the debounce and never fetches a document while listing', async () => {
  await mount();

  expect(mockList).toHaveBeenCalledTimes(1);
  expect(mockList).toHaveBeenCalledWith(
    expect.objectContaining({ limit: 25, q: undefined }),
  );
  expect(mockGet).not.toHaveBeenCalled();
  expect(controller.rows.map((row) => row.key)).toEqual(['daily-review']);
  expect(controller.loading).toBe(false);
  expect(controller.installSource).toBeNull();
});

it('loads nothing while disabled', async () => {
  options = { enabled: false };
  await mount();

  expect(mockList).not.toHaveBeenCalled();
  expect(controller.rows).toEqual([]);
  expect(controller.loading).toBe(false);
});

it('reads the whole catalog for a search and leaves matching to the page', async () => {
  options = { q: ' review ' };
  mockList
    .mockResolvedValueOnce({
      version: 1,
      data: [summary('daily-review')],
      nextCursor: 'page-2',
      stale: false,
    })
    .mockResolvedValueOnce({
      version: 1,
      data: [summary('weekly-digest')],
      nextCursor: null,
      stale: true,
    });
  await mount();

  expect(mockList).toHaveBeenNthCalledWith(
    1,
    expect.objectContaining({ limit: 100, q: undefined }),
  );
  expect(mockList).toHaveBeenNthCalledWith(
    2,
    expect.objectContaining({ limit: 100, cursor: 'page-2' }),
  );
  expect(controller.rows.map((row) => row.key)).toEqual([
    'daily-review',
    'weekly-digest',
  ]);
  expect(controller.nextCursor).toBeNull();
  expect(controller.stale).toBe(true);
});

it('appends the next page and replaces a row the catalog sent again', async () => {
  mockList.mockResolvedValueOnce({
    version: 1,
    data: [summary('daily-review'), summary('weekly-digest')],
    nextCursor: 'page-2',
    stale: false,
  });
  await mount();
  mockList.mockResolvedValueOnce({
    version: 1,
    data: [summary('weekly-digest', { name: 'Weekly digest' })],
    nextCursor: null,
    stale: false,
  });

  await act(async () => {
    controller.onLoadMore();
    await Promise.resolve();
  });

  expect(mockList).toHaveBeenLastCalledWith(
    expect.objectContaining({ cursor: 'page-2' }),
  );
  expect(controller.rows.map((row) => row.name)).toEqual([
    'daily-review',
    'Weekly digest',
  ]);
  expect(controller.nextCursor).toBeNull();
});

it('keeps loaded rows when a refresh fails and forces the next read past the cache', async () => {
  await mount();
  mockList.mockRejectedValueOnce(new Error('Catalog unavailable'));

  await act(async () => {
    controller.onRefresh();
    await Promise.resolve();
  });

  expect(mockList).toHaveBeenLastCalledWith(
    expect.objectContaining({ forceRefresh: true }),
  );
  expect(controller.error).toBe('Catalog unavailable');
  expect(controller.rows.map((row) => row.key)).toEqual(['daily-review']);
});

it('loads the selected detail and exposes it as an install source', async () => {
  mockGet.mockResolvedValue(detail);
  await mount();

  await act(async () => {
    controller.onSelectKey('daily-review');
    await Promise.resolve();
  });

  expect(mockGet).toHaveBeenCalledWith('daily-review');
  expect(controller.selectedKey).toBe('daily-review');
  expect(controller.detail).toBe(detail);
  expect(controller.installSource).toEqual({
    id: 'daily-review',
    contentHash: CURRENT,
    automation: detail.automation,
  });

  act(() => controller.onClearDetail());
  expect(controller.selectedKey).toBeNull();
  expect(controller.installSource).toBeNull();
});

it('reports a detail that failed to load and ignores one that was superseded', async () => {
  await mount();
  let resolveFirst: (value: CuratedAutomationDetail) => void = () => undefined;
  mockGet
    .mockImplementationOnce(
      () =>
        new Promise<CuratedAutomationDetail>((resolve) => {
          resolveFirst = resolve;
        }),
    )
    .mockRejectedValueOnce(new Error('Not available'));

  await act(async () => {
    controller.onSelectKey('daily-review');
    await Promise.resolve();
  });
  await act(async () => {
    controller.onSelectKey('weekly-digest');
    await Promise.resolve();
  });
  await act(async () => {
    resolveFirst(detail);
    await Promise.resolve();
  });

  expect(controller.selectedKey).toBe('weekly-digest');
  expect(controller.detail).toBeNull();
  expect(controller.detailError).toBe('Not available');
});

it.each<[string, string, 'installed' | 'update-available']>([
  ['a current copy', CURRENT, 'installed'],
  ['a copy from an older revision', OLDER, 'update-available'],
])(
  'reports %s per key from the automations store',
  async (_label, hash, state) => {
    useAutomationsStore.setState({ activities: [installedCopy(hash)] });
    await mount();

    expect(controller.localStateByKey.get('daily-review')).toBe(state);
  },
);

it('drops every row and the open detail when the Cloud account changes', async () => {
  mockGet.mockResolvedValue(detail);
  await mount();
  await act(async () => {
    controller.onSelectKey('daily-review');
    await Promise.resolve();
  });
  mockList.mockResolvedValueOnce({
    version: 1,
    data: [summary('other-account')],
    nextCursor: null,
    stale: false,
  });

  act(() => {
    window.dispatchEvent(new Event(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT));
  });
  expect(controller.rows).toEqual([]);
  expect(controller.selectedKey).toBeNull();
  expect(controller.detail).toBeNull();

  await settle();
  expect(controller.rows.map((row) => row.key)).toEqual(['other-account']);
});
