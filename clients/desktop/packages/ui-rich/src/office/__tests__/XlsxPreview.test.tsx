/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const mockParse = jest.fn();
jest.mock('../office-parse-client', () => ({
  __esModule: true,
  parseOfficeDocument: (...args: unknown[]): unknown => mockParse(...args),
}));

import type { XlsxSheetModel } from '../office-parse';
import { XlsxPreview } from '../XlsxPreview';
import { REPLAY_BLOCK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

class MockResizeObserver implements ResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe(target: Element): void {
    this.callback(
      [
        {
          target,
          contentRect: target.getBoundingClientRect(),
          borderBoxSize: [{ inlineSize: 600, blockSize: 280 }],
          contentBoxSize: [],
          devicePixelContentBoxSize: [],
        },
      ],
      this,
    );
  }
  unobserve(): void {}
  disconnect(): void {}
}
Object.assign(globalThis, { ResizeObserver: MockResizeObserver });
Object.assign(window, { ResizeObserver: MockResizeObserver });

const createTestWorker = jest.fn();

const BYTES = new Uint8Array([80, 75, 3, 4]).buffer;
const summary: XlsxSheetModel = {
  name: 'Summary',
  rowCount: 5,
  colCount: 2,
  rows: [
    ['Region', 'Total'],
    ['North', '10'],
    ['South', '20'],
    ['Sum', '30'],
    ['Merged footer', ''],
  ],
  merges: [{ startRow: 4, startCol: 0, endRow: 4, endCol: 1 }],
  hasFormulas: true,
};

function largeSheet(): XlsxSheetModel {
  return {
    name: 'Data',
    rowCount: 5_020,
    colCount: 2,
    rows: Array.from({ length: 5_000 }, (_, index) => [
      `row ${index + 1}`,
      String(index + 1),
    ]),
    merges: [{ startRow: 0, startCol: 0, endRow: 99, endCol: 0 }],
    hasFormulas: false,
  };
}

function mount(element: React.ReactElement): {
  container: HTMLElement;
  root: Root;
} {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(element));
  return { container, root };
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('XlsxPreview', () => {
  beforeEach(() => {
    Object.defineProperties(HTMLElement.prototype, {
      clientWidth: { configurable: true, get: () => 600 },
      clientHeight: { configurable: true, get: () => 280 },
    });
    HTMLElement.prototype.getBoundingClientRect = (): DOMRect =>
      new DOMRect(0, 0, 600, 280);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    mockParse.mockReset();
    document.body.innerHTML = '';
  });

  it('renders tabs, merged cells, saved-formula guidance, and the semantic banner', async () => {
    mockParse.mockResolvedValue({
      kind: 'xlsx',
      sheets: [summary, largeSheet()],
    });
    const { container, root } = mount(
      <XlsxPreview
        createWorker={createTestWorker}
        bytes={BYTES}
        fileName="q3.xlsx"
        onRenderFailure={jest.fn()}
      />,
    );
    await flush();
    expect(
      container.querySelector('[data-testid="office-preview-banner"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="office-preview-banner"]')
        ?.textContent,
    ).toBe(
      'Semantic preview: formatting may differ; download for the exact document.',
    );
    const tabs = container.querySelectorAll('[data-testid="xlsx-sheet-tab"]');
    expect(tabs).toHaveLength(2);
    expect(tabs[0].getAttribute('aria-selected')).toBe('true');
    expect(tabs[0].getAttribute('tabindex')).toBe('0');
    expect(tabs[1].getAttribute('tabindex')).toBe('-1');
    expect(container.querySelector('[data-cell="A1"]')?.textContent).toBe(
      'Region',
    );
    expect(container.querySelector('[data-cell="B4"]')?.textContent).toBe('30');
    expect(
      container.querySelector('[data-cell="A5"]')?.getAttribute('aria-colspan'),
    ).toBe('2');
    expect(container.querySelector('[data-cell="B5"]')).toBeNull();
    expect(
      container.querySelector('[data-testid="xlsx-formula-note"]')?.textContent,
    ).toContain('formulas are not recalculated');
    expect(
      container.querySelector('[data-testid="xlsx-truncation-banner"]'),
    ).toBeNull();
    act(() => root.unmount());
  });

  // React reuses the loading root div for the workbook, and the recorder
  // ignores a block class added to an element it already recorded, so both
  // roots carry the block from the first mount.
  it('blocks the preview root from session replay from its first mount', async () => {
    mockParse.mockResolvedValue({ kind: 'xlsx', sheets: [summary] });
    const { container, root } = mount(
      <XlsxPreview
        createWorker={createTestWorker}
        bytes={BYTES}
        fileName="q3.xlsx"
        onRenderFailure={jest.fn()}
      />,
    );
    const loadingRoot = container.firstElementChild;
    expect(
      loadingRoot?.querySelector('[data-testid="xlsx-preview-loading"]'),
    ).not.toBeNull();
    expect(loadingRoot?.classList.contains(REPLAY_BLOCK_CLASS)).toBe(true);

    await flush();
    const readyRoot = container.firstElementChild;
    expect(readyRoot).toBe(loadingRoot);
    expect(readyRoot?.getAttribute('data-testid')).toBe('xlsx-preview');
    expect(readyRoot?.querySelector('[data-cell="A1"]')).not.toBeNull();
    expect(readyRoot?.classList.contains(REPLAY_BLOCK_CLASS)).toBe(true);
    act(() => root.unmount());
  });

  it('virtualizes retained rows and reports full row truncation', async () => {
    mockParse.mockResolvedValue({
      kind: 'xlsx',
      sheets: [summary, largeSheet()],
    });
    const { container, root } = mount(
      <XlsxPreview
        createWorker={createTestWorker}
        bytes={BYTES}
        fileName="q3.xlsx"
        onRenderFailure={jest.fn()}
      />,
    );
    await flush();
    const dataTab = container.querySelectorAll<HTMLButtonElement>(
      '[data-testid="xlsx-sheet-tab"]',
    )[1];
    act(() => dataTab.click());
    await flush();
    expect(
      container.querySelector('[data-testid="xlsx-truncation-banner"]')
        ?.textContent,
    ).toContain('Showing the first 5,000 of 5,020 rows');
    expect(
      container
        .querySelector('[data-testid="xlsx-grid"]')
        ?.getAttribute('data-row-count'),
    ).toBe('5000');
    const renderedRows = container.querySelectorAll(
      '[role="row"][data-index]',
    ).length;
    expect(renderedRows).toBeGreaterThan(0);
    expect(renderedRows).toBeLessThan(200);
    act(() => root.unmount());
  });

  it('paints the frozen header row and row-number gutter, and leaves the flow banners flat', async () => {
    // The frozen edge has to be OPAQUE: both surfaces are `position: sticky`,
    // so without a fill the rows scrolling beneath them read straight through
    // the column letters and the row numbers. `bg-surface-secondary` used to
    // sit here and no stylesheet ever declared it, so the fill never painted
    // (removed as a dead class in #3791). `bg-secondary` also carries the
    // row-number gutter, so the header and the gutter read as one frozen edge.
    mockParse.mockResolvedValue({
      kind: 'xlsx',
      sheets: [summary, largeSheet()],
    });
    const { container, root } = mount(
      <XlsxPreview
        createWorker={createTestWorker}
        bytes={BYTES}
        fileName="q3.xlsx"
        onRenderFailure={jest.fn()}
      />,
    );
    await flush();
    const headerRow = container.querySelector(
      '[role="row"][aria-rowindex="1"]',
    );
    expect(headerRow?.classList.contains('bg-secondary')).toBe(true);
    const rowHeaders = Array.from(
      container.querySelectorAll<HTMLElement>('[role="rowheader"]'),
    );
    expect(rowHeaders.length).toBeGreaterThan(0);
    for (const rowHeader of rowHeaders) {
      expect(rowHeader.classList.contains('bg-secondary')).toBe(true);
    }
    // The sticky gutter is a later-in-tree positioned sibling of nothing it
    // must cover, so it also needs to outrank the cells (auto) and the merged
    // cells (1) it slides under, while staying below the header row (10).
    expect(headerRow?.classList.contains('z-10')).toBe(true);
    for (const rowHeader of rowHeaders) {
      expect(rowHeader.classList.contains('z-2')).toBe(true);
    }

    // The two in-flow notes stay flat. Nothing scrolls behind them, they
    // already carry `border-b`, and the formula note directly beneath them is
    // the same kind of note with no fill: tinting one of a stacked pair would
    // split one notice family in two (DESIGN.md, "Earn every surface").
    const dataTab = container.querySelectorAll<HTMLButtonElement>(
      '[data-testid="xlsx-sheet-tab"]',
    )[1];
    act(() => dataTab.click());
    await flush();
    for (const testId of [
      'office-preview-banner',
      'xlsx-truncation-banner',
      'xlsx-formula-note',
    ]) {
      const note = container.querySelector(`[data-testid="${testId}"]`);
      expect(note).not.toBeNull();
      expect(note?.classList.contains('bg-secondary')).toBe(false);
    }
    // The dead role must not come back anywhere in the preview.
    expect(container.innerHTML).not.toContain('bg-surface-secondary');
    act(() => root.unmount());
  });

  it.each(['ArrowRight', 'End', 'Home', 'ArrowLeft'])(
    'selects and focuses tabs with %s',
    async (key) => {
      mockParse.mockResolvedValue({
        kind: 'xlsx',
        sheets: [summary, largeSheet()],
      });
      const { container, root } = mount(
        <XlsxPreview
          createWorker={createTestWorker}
          bytes={BYTES}
          fileName="q3.xlsx"
          onRenderFailure={jest.fn()}
        />,
      );
      await flush();
      const tabs = container.querySelectorAll<HTMLButtonElement>(
        '[data-testid="xlsx-sheet-tab"]',
      );
      const initial =
        key === 'ArrowLeft' ? tabs[0] : key === 'Home' ? tabs[1] : tabs[0];
      initial.focus();
      act(() => {
        initial.dispatchEvent(
          new KeyboardEvent('keydown', { key, bubbles: true }),
        );
      });
      await flush();
      const expected = key === 'Home' ? tabs[0] : tabs[1];
      expect(expected.getAttribute('aria-selected')).toBe('true');
      expect(document.activeElement).toBe(expected);
      const panel = container.querySelector('[role="tabpanel"]');
      expect(expected.getAttribute('aria-controls')).toBe(panel?.id);
      expect(panel?.getAttribute('aria-labelledby')).toBe(expected.id);
      act(() => root.unmount());
    },
  );

  it('shows the empty state inside the selected tab panel', async () => {
    const empty: XlsxSheetModel = {
      name: 'Empty',
      rowCount: 0,
      colCount: 0,
      rows: [],
      merges: [],
      hasFormulas: false,
    };
    mockParse.mockResolvedValue({ kind: 'xlsx', sheets: [summary, empty] });
    const { container, root } = mount(
      <XlsxPreview
        createWorker={createTestWorker}
        bytes={BYTES}
        fileName="empty.xlsx"
        onRenderFailure={jest.fn()}
      />,
    );
    await flush();
    act(() =>
      container
        .querySelectorAll<HTMLButtonElement>(
          '[data-testid="xlsx-sheet-tab"]',
        )[1]
        .click(),
    );
    await flush();
    const panel = container.querySelector('[role="tabpanel"]');
    expect(
      panel?.querySelector('[data-testid="xlsx-empty"]')?.textContent,
    ).toBe('Empty is empty.');
    act(() => root.unmount());
  });

  it('reports parse-failed when parsing rejects', async () => {
    mockParse.mockRejectedValue(new Error('corrupt zip'));
    const onRenderFailure = jest.fn();
    const { root } = mount(
      <XlsxPreview
        createWorker={createTestWorker}
        bytes={BYTES}
        fileName="q3.xlsx"
        onRenderFailure={onRenderFailure}
      />,
    );
    await flush();
    expect(onRenderFailure).toHaveBeenCalledWith('parse-failed');
    act(() => root.unmount());
  });

  it('aborts replacement and unmount requests without publishing stale state', async () => {
    const signals: AbortSignal[] = [];
    mockParse.mockImplementation(
      (_request: unknown, options: { signal: AbortSignal }) => {
        signals.push(options.signal);
        return new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () =>
            reject(new Error('aborted')),
          );
        });
      },
    );
    const onRenderFailure = jest.fn();
    const { root } = mount(
      <XlsxPreview
        createWorker={createTestWorker}
        bytes={new Uint8Array([1]).buffer}
        fileName="first.xlsx"
        onRenderFailure={onRenderFailure}
      />,
    );
    act(() =>
      root.render(
        <XlsxPreview
          createWorker={createTestWorker}
          bytes={new Uint8Array([2]).buffer}
          fileName="second.xlsx"
          onRenderFailure={onRenderFailure}
        />,
      ),
    );
    expect(signals[0].aborted).toBe(true);
    act(() => root.unmount());
    await flush();
    expect(signals[1].aborted).toBe(true);
    expect(onRenderFailure).not.toHaveBeenCalled();
  });
  it('forwards the host worker factory and renders host recovery copy', async () => {
    mockParse.mockResolvedValue({ kind: 'xlsx', sheets: [largeSheet()] });
    const createWorker = jest.fn();
    const copy = {
      banner:
        'Semantic preview: formatting may differ; open in Finder for the exact document.',
      truncationRecovery:
        'Open the workbook in its native app to see everything.',
    };
    const hostProps = { createWorker, copy };
    const { container, root } = mount(
      <XlsxPreview
        bytes={BYTES}
        fileName="brief.xlsx"
        onRenderFailure={jest.fn()}
        {...hostProps}
      />,
    );
    await flush();
    try {
      expect(mockParse).toHaveBeenCalledWith(
        { kind: 'xlsx', bytes: BYTES },
        expect.objectContaining({ createWorker }),
      );
      expect(
        container.querySelector('[data-testid="office-preview-banner"]')
          ?.textContent,
      ).toBe(copy.banner);
      expect(
        container.querySelector('[data-testid="xlsx-truncation-banner"]')
          ?.textContent,
      ).toBe(
        'Showing the first 5,000 of 5,020 rows. ' + copy.truncationRecovery,
      );
    } finally {
      act(() => root.unmount());
    }
  });

  it('aborts and restarts parsing when the host worker factory changes', () => {
    const signals: AbortSignal[] = [];
    mockParse.mockImplementation(
      (_request: unknown, options: { signal: AbortSignal }) => {
        signals.push(options.signal);
        return new Promise(() => {});
      },
    );
    const onRenderFailure = jest.fn();
    const firstHost = { createWorker: jest.fn() };
    const secondHost = { createWorker: jest.fn() };
    const { root } = mount(
      <XlsxPreview
        bytes={BYTES}
        fileName="brief.xlsx"
        onRenderFailure={onRenderFailure}
        {...firstHost}
      />,
    );
    act(() =>
      root.render(
        <XlsxPreview
          bytes={BYTES}
          fileName="brief.xlsx"
          onRenderFailure={onRenderFailure}
          {...secondHost}
        />,
      ),
    );
    try {
      expect(mockParse).toHaveBeenCalledTimes(2);
      expect(signals[0]?.aborted).toBe(true);
      expect(signals[1]?.aborted).toBe(false);
    } finally {
      act(() => root.unmount());
    }
    expect(signals[1]?.aborted).toBe(true);
    expect(onRenderFailure).not.toHaveBeenCalled();
  });
});
