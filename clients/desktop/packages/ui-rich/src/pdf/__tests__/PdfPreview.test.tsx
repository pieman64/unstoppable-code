/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  PdfPreviewRenderFailure,
  PdfPreviewSearchResult,
} from '../PdfPreview';
import { REPLAY_BLOCK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const mockGlobalWorkerOptions = { workerSrc: '' };
const mockGetDocument = jest.fn<
  MockLoadingTask<MockPdfDocument>,
  [MockDocumentInit]
>();
const mockCanvasCancel = jest.fn();
const mockTextCancel = jest.fn();
const mockTaskDestroy = jest.fn().mockResolvedValue(undefined);

class MockTextLayer {
  readonly textDivs: HTMLElement[];
  constructor({
    textContentSource,
    container,
  }: {
    textContentSource: { items: Array<{ str: string }> };
    container: HTMLElement;
  }) {
    this.textDivs = textContentSource.items.map((item) => {
      const span = document.createElement('span');
      span.textContent = item.str;
      container.append(span);
      return span;
    });
  }
  render(): Promise<void> {
    return Promise.resolve();
  }
  cancel(): void {
    mockTextCancel();
  }
}

jest.mock('pdfjs-dist', () => ({
  __esModule: true,
  version: '5.7.284',
  get GlobalWorkerOptions(): typeof mockGlobalWorkerOptions {
    return mockGlobalWorkerOptions;
  },
  getDocument: (options: MockDocumentInit): MockLoadingTask<MockPdfDocument> =>
    mockGetDocument(options),
  get TextLayer(): typeof MockTextLayer {
    return MockTextLayer;
  },
}));

interface ObservedEntry {
  readonly target: Element;
  readonly isIntersecting: boolean;
  readonly intersectionRatio: number;
}

class MockIntersectionObserver {
  static instances: MockIntersectionObserver[] = [];
  readonly observed: Element[] = [];
  readonly disconnect = jest.fn();
  constructor(
    readonly callback: (entries: ObservedEntry[]) => void,
    readonly options?: IntersectionObserverInit,
  ) {
    MockIntersectionObserver.instances.push(this);
  }
  observe(target: Element): void {
    this.observed.push(target);
  }
  unobserve(): void {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
  trigger(entries: ObservedEntry[]): void {
    this.callback(entries);
  }
}

class MockResizeObserver {
  readonly disconnect = jest.fn();
  constructor(
    readonly callback: (
      entries: Array<{ contentRect: { width: number } }>,
    ) => void,
  ) {}
  observe(): void {
    this.callback([{ contentRect: { width: 640 } }]);
  }
  unobserve(): void {}
}

Object.assign(globalThis, {
  IntersectionObserver: MockIntersectionObserver,
  ResizeObserver: MockResizeObserver,
});

const mockScrollIntoView = jest.fn();
HTMLElement.prototype.scrollIntoView = mockScrollIntoView;

import {
  PDF_PREVIEW_MAX_CANVAS_PIXELS,
  PDF_PREVIEW_MAX_SOURCE_IMAGE_PIXELS,
  PdfPreview,
} from '../PdfPreview';

interface MockDocumentInit {
  readonly data: Uint8Array;
  readonly isEvalSupported: boolean;
  readonly enableXfa: boolean;
  readonly maxImageSize: number;
  readonly cMapUrl: string;
  readonly standardFontDataUrl: string;
  readonly wasmUrl: string;
  readonly iccUrl: string;
}

interface MockViewport {
  readonly convertToViewportRectangle: (rect: number[]) => number[];
  readonly width: number;
  readonly height: number;
  readonly scale: number;
  readonly rotation: number;
  readonly rawDims: {
    readonly pageWidth: number;
    readonly pageHeight: number;
    readonly pageX: number;
    readonly pageY: number;
  };
}

interface MockRenderTask {
  readonly promise: Promise<void>;
  readonly cancel: typeof mockCanvasCancel;
}

interface MockTextContent {
  readonly items: Array<{ readonly str: string; readonly hasEOL?: boolean }>;
  readonly styles: Record<string, never>;
}

interface MockPdfPage {
  readonly getAnnotations: jest.Mock<Promise<unknown[]>, []>;
  readonly getViewport: jest.Mock<MockViewport, [{ readonly scale: number }]>;
  readonly render: jest.Mock<MockRenderTask, []>;
  readonly getTextContent: jest.Mock<Promise<MockTextContent>, []>;
}

interface MockPdfDocument {
  readonly numPages: number;
  readonly getPage: jest.Mock<
    Promise<MockPdfPage | undefined>,
    [pageNumber: number]
  >;
  readonly pages: MockPdfPage[];
}

function viewport(scale: number, width = 100, height = 200): MockViewport {
  return {
    convertToViewportRectangle: (rect) => rect.map((value) => value * scale),
    width: width * scale,
    height: height * scale,
    scale,
    rotation: 0,
    rawDims: { pageWidth: width, pageHeight: height, pageX: 0, pageY: 0 },
  };
}

function pdfDocument(
  pageCount = 2,
  width = 100,
  height = 200,
): MockPdfDocument {
  const pages: MockPdfPage[] = Array.from(
    { length: Math.min(pageCount, 500) },
    (_, index): MockPdfPage => ({
      getAnnotations: jest.fn<Promise<unknown[]>, []>().mockResolvedValue([]),
      getViewport: jest.fn(
        ({ scale }: { readonly scale: number }): MockViewport =>
          viewport(scale, width, height),
      ),
      render: jest.fn(
        (): MockRenderTask => ({
          promise: Promise.resolve(),
          cancel: mockCanvasCancel,
        }),
      ),
      getTextContent: jest
        .fn<Promise<MockTextContent>, []>()
        .mockResolvedValue({
          items: [{ str: index === 0 ? 'alpha' : 'search target' }],
          styles: {},
        }),
    }),
  );
  return {
    numPages: pageCount,
    getPage: jest.fn(
      (pageNumber: number): Promise<MockPdfPage | undefined> =>
        Promise.resolve(pages[pageNumber - 1]),
    ),
    pages,
  };
}

type MockPasswordHandler = (
  updatePassword: (password: string | Error) => void,
) => void;

interface MockLoadingTask<T> {
  readonly promise: Promise<T>;
  readonly destroy: typeof mockTaskDestroy;
  onPassword: MockPasswordHandler | null;
}

function loadingTask(
  document = pdfDocument(),
): MockLoadingTask<MockPdfDocument> {
  return {
    promise: Promise.resolve(document),
    destroy: mockTaskDestroy,
    onPassword: null,
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function mountPreview(
  onRenderFailure = jest.fn<void, [PdfPreviewRenderFailure]>(),
  overrides: {
    search?: { query: string; index: number };
    onSearchResult?: (state: {
      ready: boolean;
      query: string;
      totalCount: number;
      currentIndex: number;
    }) => void;
  } = {},
): {
  bytes: ArrayBuffer;
  container: HTMLDivElement;
  root: Root;
  onRenderFailure: typeof onRenderFailure;
  resolveAssets: jest.Mock;
  onSearchResult: jest.Mock;
  setSearch: (query: string, index?: number) => void;
} {
  const container = document.createElement('div');
  const bytes = new Uint8Array([1, 2, 3]).buffer;
  document.body.appendChild(container);
  const root = createRoot(container);
  const resolveAssets = jest.fn(() => ({
    workerSrc: '/host-assets/pdf.worker.min.mjs',
    assetBaseUrl: '/host-assets/',
  }));
  const onSearchResult = jest.fn(overrides.onSearchResult);
  const render = (query = '', index = 0): void => {
    act(() => {
      root.render(
        <PdfPreview
          bytes={bytes}
          fileName="brief.pdf"
          onRenderFailure={onRenderFailure}
          resolveAssets={resolveAssets}
          search={{ query, index }}
          onSearchResult={onSearchResult}
        />,
      );
    });
  };
  render(overrides.search?.query, overrides.search?.index);
  return {
    bytes,
    container,
    root,
    onRenderFailure,
    resolveAssets,
    onSearchResult,
    setSearch: render,
  };
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  MockIntersectionObserver.instances = [];
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('PdfPreview', () => {
  it('pins the same-origin worker and opens with hardened PDF.js options', async () => {
    const task = loadingTask();
    mockGetDocument.mockReturnValue(task);
    const mounted = mountPreview();
    await flush();

    expect(mockGlobalWorkerOptions.workerSrc).toBe(
      '/host-assets/pdf.worker.min.mjs',
    );
    expect(mounted.resolveAssets).toHaveBeenCalledTimes(1);
    expect(mounted.resolveAssets).toHaveBeenCalledWith('5.7.284');
    const options = mockGetDocument.mock.calls[0]?.[0];
    expect(options).toMatchObject({
      isEvalSupported: false,
      enableXfa: false,
      maxImageSize: PDF_PREVIEW_MAX_SOURCE_IMAGE_PIXELS,
      cMapUrl: '/host-assets/cmaps/',
      standardFontDataUrl: '/host-assets/standard_fonts/',
      wasmUrl: '/host-assets/wasm/',
      iccUrl: '/host-assets/iccs/',
    });
    expect(options?.data).toBeInstanceOf(Uint8Array);
    expect(options.data.buffer).not.toBe(mounted.bytes);
    act(() => mounted.root.unmount());
  });

  it('blocks the pages from session replay and records the floating controls', async () => {
    mockGetDocument.mockReturnValue(loadingTask());
    const mounted = mountPreview();
    await flush();

    const preview = mounted.container.querySelector(
      '[data-testid="pdf-preview"]',
    );
    expect(preview).toBe(mounted.container.firstElementChild);
    expect(preview?.classList.contains(REPLAY_BLOCK_CLASS)).toBe(false);
    const toolbar = mounted.container.querySelector(
      '[data-testid="pdf-zoom-controls"]',
    );
    expect(toolbar).not.toBeNull();
    expect(toolbar?.closest(`.${REPLAY_BLOCK_CLASS}`)).toBeNull();
    const blocks = mounted.container.querySelectorAll(`.${REPLAY_BLOCK_CLASS}`);
    expect(blocks).toHaveLength(1);
    const page = mounted.container.querySelector(
      '[data-testid="pdf-preview-page"]',
    );
    expect(page).not.toBeNull();
    expect(page?.closest(`.${REPLAY_BLOCK_CLASS}`)).toBe(blocks[0]);
    act(() => mounted.root.unmount());
  });

  it('keeps the accessible file name without a duplicate name or PDF toolbar', async () => {
    mockGetDocument.mockReturnValue(loadingTask());
    const mounted = mountPreview();
    await flush();
    const preview = mounted.container.querySelector(
      '[data-testid="pdf-preview"]',
    );
    expect(preview?.getAttribute('aria-label')).toBe('brief.pdf');
    expect(preview?.textContent).not.toContain('brief.pdf');
    expect(
      mounted.container.querySelector('[data-testid="pdf-preview-toolbar"]'),
    ).toBeNull();
    expect(
      mounted.container.querySelector('[data-testid="pdf-zoom-controls"]'),
    ).not.toBeNull();
    expect(
      mounted.container.querySelector('[data-testid="pdf-page-counter"]'),
    ).not.toBeNull();
    act(() => mounted.root.unmount());
  });

  it('keeps the file name accessible without adding a visible copy', async () => {
    mockGetDocument.mockReturnValue(loadingTask());
    const mounted = mountPreview();
    await flush();

    const preview = mounted.container.querySelector(
      '[data-testid="pdf-preview"]',
    );
    // `textContent` is what the dedupe assertions measure, so an `sr-only`
    // span would not do: the name has to leave the tree entirely and survive
    // as the region's accessible name instead.
    expect(preview?.textContent).not.toContain('brief.pdf');
    expect(preview?.getAttribute('role')).toBe('group');
    expect(preview?.getAttribute('aria-label')).toBe('brief.pdf');
    act(() => mounted.root.unmount());
  });

  it('searches all pages through the host find controls without a local search input', async () => {
    const doc = pdfDocument();
    mockGetDocument.mockReturnValue(loadingTask(doc));
    const onSearchResult = jest.fn<void, [PdfPreviewSearchResult]>();
    const mounted = mountPreview(undefined, {
      search: { query: 'target', index: 0 },
      onSearchResult,
    });
    await flush();
    await flush();
    for (
      let attempt = 0;
      attempt < 20 && onSearchResult.mock.lastCall?.[0]?.totalCount !== 1;
      attempt += 1
    )
      await flush();
    expect(onSearchResult).toHaveBeenLastCalledWith({
      ready: true,
      query: 'target',
      totalCount: 1,
      currentIndex: 0,
    });
    expect(mounted.container.querySelector('input')).toBeNull();
    act(() => mounted.root.unmount());
  });

  it('preserves text selection on parent renders after closing search', async () => {
    mockGetDocument.mockReturnValue(loadingTask(pdfDocument(1)));
    const mounted = mountPreview(undefined, {
      search: { query: 'alpha', index: 0 },
    });
    await flush();
    const observer = MockIntersectionObserver.instances.find(
      (item) => item.options?.rootMargin === '100% 0px',
    );
    const page = mounted.container.querySelector(
      '[data-testid="pdf-preview-page"]',
    );
    if (!page || !observer) throw new Error('missing page observer');
    act(() =>
      observer.trigger([
        { target: page, isIntersecting: true, intersectionRatio: 1 },
      ]),
    );
    await flush();
    expect(page.querySelector('mark')?.textContent).toBe('alpha');
    mounted.setSearch('');
    await flush();
    expect(page.querySelector('mark')).toBeNull();

    const text = page.querySelector('span')?.firstChild;
    const selection = window.getSelection();
    if (!text || !selection) throw new Error('missing selectable text');
    const range = document.createRange();
    range.setStart(text, 1);
    range.setEnd(text, 4);
    selection.removeAllRanges();
    selection.addRange(range);
    expect(selection.toString()).toBe('lph');

    mounted.setSearch('');
    await flush();
    expect(selection.toString()).toBe('lph');
    selection.removeAllRanges();
    act(() => mounted.root.unmount());
  });

  it('renders clickable link annotations over the page without enabling PDF actions', async () => {
    const doc = pdfDocument(1);
    doc.pages[0]?.getAnnotations.mockResolvedValue([
      {
        subtype: 'Link',
        url: 'https://example.com/report',
        rect: [10, 20, 80, 40],
      },
      { subtype: 'Link', url: 'javascript:alert(1)', rect: [0, 0, 20, 20] },
    ]);
    mockGetDocument.mockReturnValue(loadingTask(doc));
    const mounted = mountPreview();
    await flush();
    const observer = MockIntersectionObserver.instances.find(
      (item) => item.options?.rootMargin === '100% 0px',
    );
    const page = mounted.container.querySelector(
      '[data-testid="pdf-preview-page"]',
    );
    if (!page) throw new Error('missing page');
    act(() =>
      observer?.trigger([
        { target: page, isIntersecting: true, intersectionRatio: 1 },
      ]),
    );
    await flush();
    const links = mounted.container.querySelectorAll('a');
    expect(links).toHaveLength(1);
    expect(links[0]?.href).toBe('https://example.com/report');
    expect(links[0]?.target).toBe('_blank');
    expect(links[0]?.rel).toBe('noopener noreferrer');
    expect(links[0]?.style.left).toBe('10px');
    expect(links[0]?.style.width).toBe('70px');
    act(() => mounted.root.unmount());
  });

  it('renders at most 500 fixed page shells and reports truncation', async () => {
    mockGetDocument.mockReturnValue(loadingTask(pdfDocument(503)));
    const mounted = mountPreview();
    await flush();

    expect(
      mounted.container.querySelectorAll('[data-testid="pdf-preview-page"]'),
    ).toHaveLength(500);
    expect(mounted.container.textContent).toContain(
      'Showing first 500 of 503 pages',
    );
    act(() => mounted.root.unmount());
  });

  it('publishes the first page before a later page proxy resolves', async () => {
    const document = pdfDocument();
    const firstPage = document.pages[0];
    const secondPage = document.pages[1];
    if (!firstPage || !secondPage) throw new Error('missing mock pages');
    const delayedSecondPage = deferred<typeof secondPage>();
    document.getPage.mockImplementation((pageNumber: number) =>
      pageNumber === 1 ? Promise.resolve(firstPage) : delayedSecondPage.promise,
    );
    mockGetDocument.mockReturnValue(loadingTask(document));

    const mounted = mountPreview();
    await flush();

    expect(document.getPage).toHaveBeenCalledWith(2);
    expect(
      mounted.container.querySelectorAll('[data-testid="pdf-preview-page"]'),
    ).toHaveLength(1);
    expect(mounted.onSearchResult).toHaveBeenLastCalledWith(
      expect.objectContaining({ ready: false }),
    );

    delayedSecondPage.resolve(secondPage);
    await flush();
    expect(
      mounted.container.querySelectorAll('[data-testid="pdf-preview-page"]'),
    ).toHaveLength(2);
    expect(mounted.onSearchResult).toHaveBeenLastCalledWith(
      expect.objectContaining({ ready: true }),
    );
    act(() => mounted.root.unmount());
  });

  it('keeps loaded pages visible when a later page proxy fails', async () => {
    const document = pdfDocument();
    const firstPage = document.pages[0];
    if (!firstPage) throw new Error('missing first mock page');
    document.getPage.mockImplementation((pageNumber: number) =>
      pageNumber === 1
        ? Promise.resolve(firstPage)
        : Promise.reject(new Error('invalid second page')),
    );
    mockGetDocument.mockReturnValue(loadingTask(document));

    const mounted = mountPreview();
    await flush();

    expect(mounted.onRenderFailure).not.toHaveBeenCalled();
    expect(
      mounted.container.querySelectorAll('[data-testid="pdf-preview-page"]'),
    ).toHaveLength(2);
    expect(
      mounted.container.querySelector('[data-testid="pdf-preview-page-error"]')
        ?.textContent,
    ).toBe('Page 2 could not be previewed.');
    expect(mounted.onSearchResult).toHaveBeenLastCalledWith(
      expect.objectContaining({ ready: true }),
    );
    act(() => mounted.root.unmount());
  });

  it('marks a page failed when its render pipeline rejects', async () => {
    const document = pdfDocument();
    document.pages[0]?.render.mockImplementation(() => ({
      promise: Promise.reject(new Error('bad embedded font')),
      cancel: mockCanvasCancel,
    }));
    mockGetDocument.mockReturnValue(loadingTask(document));
    const mounted = mountPreview();
    await flush();
    const prefetch = MockIntersectionObserver.instances.find(
      (observer) => observer.options?.rootMargin === '100% 0px',
    );
    const page = mounted.container.querySelector(
      '[data-testid="pdf-preview-page"]',
    );
    if (!page) throw new Error('missing page shell');
    await act(async () => {
      prefetch?.trigger([
        { target: page, isIntersecting: true, intersectionRatio: 1 },
      ]);
      await Promise.resolve();
    });
    await flush();

    expect(mounted.onRenderFailure).not.toHaveBeenCalled();
    expect(
      mounted.container.querySelector('[data-testid="pdf-preview-page-error"]')
        ?.textContent,
    ).toBe('Page 1 could not be previewed.');
    expect(
      mounted.container.querySelectorAll('[data-testid="pdf-preview-page"]'),
    ).toHaveLength(2);
    act(() => mounted.root.unmount());
  });

  it('keeps search matches from healthy pages when one page fails text extraction', async () => {
    const document = pdfDocument();
    document.pages[0]?.getTextContent.mockRejectedValue(
      new Error('content stream error'),
    );
    mockGetDocument.mockReturnValue(loadingTask(document));
    const mounted = mountPreview();
    await flush();

    mounted.setSearch('target');

    await flush();
    await flush();

    expect(mounted.onSearchResult).toHaveBeenLastCalledWith(
      expect.objectContaining({ totalCount: 1, currentIndex: 0 }),
    );
    act(() => mounted.root.unmount());
  });

  it('uses separate prefetch and visibility observers and advances the page indicator', async () => {
    mockGetDocument.mockReturnValue(loadingTask());
    const mounted = mountPreview();
    await flush();
    const prefetch = MockIntersectionObserver.instances.find(
      (observer) => observer.options?.rootMargin === '100% 0px',
    );
    const visible = MockIntersectionObserver.instances.find(
      (observer) => observer.options?.rootMargin === '0px',
    );
    expect(prefetch).toBeDefined();
    expect(visible).toBeDefined();
    const pages = mounted.container.querySelectorAll(
      '[data-testid="pdf-preview-page"]',
    );
    act(() => {
      visible?.trigger([
        { target: pages[0], isIntersecting: false, intersectionRatio: 0 },
        { target: pages[1], isIntersecting: true, intersectionRatio: 1 },
      ]);
    });
    expect(mounted.container.textContent).toContain('2 / 2');
    act(() => mounted.root.unmount());
  });

  it('clamps an oversized canvas backing store to the pixel budget', async () => {
    mockGetDocument.mockReturnValue(
      loadingTask(pdfDocument(1, 10_000, 10_000)),
    );
    Object.defineProperty(window, 'devicePixelRatio', {
      configurable: true,
      value: 2,
    });
    const mounted = mountPreview();
    await flush();
    const prefetch = MockIntersectionObserver.instances.find(
      (observer) => observer.options?.rootMargin === '100% 0px',
    );
    const page = mounted.container.querySelector(
      '[data-testid="pdf-preview-page"]',
    );
    if (!page) throw new Error('missing page shell');
    await act(async () => {
      prefetch?.trigger([
        { target: page, isIntersecting: true, intersectionRatio: 1 },
      ]);
      await Promise.resolve();
    });
    const canvas = mounted.container.querySelector<HTMLCanvasElement>(
      '[data-testid="pdf-preview-page-canvas"]',
    );
    expect((canvas?.width ?? 0) * (canvas?.height ?? 0)).toBeLessThanOrEqual(
      PDF_PREVIEW_MAX_CANVAS_PIXELS,
    );
    act(() => mounted.root.unmount());
  });

  it.each([
    ['password-protected', true],
    ['corrupt', false],
  ] as const)(
    'maps an open failure to %s and destroys the loading task',
    async (failure, password) => {
      let reject = (error: Error): void => {
        throw error;
      };
      const task: MockLoadingTask<never> = {
        promise: new Promise<never>((_resolve, rejectPromise) => {
          reject = (error): void => rejectPromise(error);
        }),
        destroy: mockTaskDestroy,
        onPassword: null,
      };
      mockGetDocument.mockReturnValue(task);
      const mounted = mountPreview();
      await flush();
      await act(async () => {
        if (password) {
          task.onPassword?.((value) =>
            reject(value instanceof Error ? value : new Error(value)),
          );
        } else {
          reject(new Error('bad xref'));
        }
        await Promise.resolve();
      });

      expect(mounted.onRenderFailure).toHaveBeenCalledWith(failure);
      expect(mockTaskDestroy).toHaveBeenCalled();
      act(() => mounted.root.unmount());
    },
  );

  it('searches lazily, navigates to the match, and cancels render work on cleanup', async () => {
    const document = pdfDocument();
    mockGetDocument.mockReturnValue(loadingTask(document));
    const mounted = mountPreview();
    await flush();
    const prefetch = MockIntersectionObserver.instances.find(
      (observer) => observer.options?.rootMargin === '100% 0px',
    );
    const second = mounted.container.querySelectorAll(
      '[data-testid="pdf-preview-page"]',
    )[1];
    await act(async () => {
      prefetch?.trigger([
        { target: second, isIntersecting: true, intersectionRatio: 1 },
      ]);
      await Promise.resolve();
    });

    mounted.setSearch('target');
    await flush();
    await flush();

    expect(mounted.onSearchResult).toHaveBeenLastCalledWith(
      expect.objectContaining({ totalCount: 1, currentIndex: 0 }),
    );
    expect(mockScrollIntoView).toHaveBeenCalled();
    act(() => mounted.root.unmount());
    expect(mockCanvasCancel).toHaveBeenCalled();
    expect(mockTextCancel).toHaveBeenCalled();
    expect(
      MockIntersectionObserver.instances.every(
        (observer) => observer.disconnect.mock.calls.length > 0,
      ),
    ).toBe(true);
  });

  it('highlights repeated matches as distinct navigable character ranges', async () => {
    const document = pdfDocument(1);
    document.pages[0]?.getTextContent.mockResolvedValue({
      items: [{ str: 'alpha alpha' }],
      styles: {},
    });
    mockGetDocument.mockReturnValue(loadingTask(document));
    const mounted = mountPreview();
    await flush();
    const prefetch = MockIntersectionObserver.instances.find(
      (observer) => observer.options?.rootMargin === '100% 0px',
    );
    const page = mounted.container.querySelector(
      '[data-testid="pdf-preview-page"]',
    );
    if (!page) throw new Error('missing page shell');
    await act(async () => {
      prefetch?.trigger([
        { target: page, isIntersecting: true, intersectionRatio: 1 },
      ]);
      await Promise.resolve();
    });

    mounted.setSearch('alpha');
    await flush();
    await flush();

    let highlights = mounted.container.querySelectorAll<HTMLElement>(
      'mark[data-pdf-search-highlight]',
    );
    expect(
      Array.from(highlights, (node: HTMLElement) => node.textContent),
    ).toEqual(['alpha', 'alpha']);
    expect(highlights[0]?.getAttribute('data-pdf-search-highlight')).toBe(
      'active',
    );
    expect(highlights[1]?.getAttribute('data-pdf-search-highlight')).toBe(
      'match',
    );

    mounted.setSearch('alpha', 1);
    highlights = mounted.container.querySelectorAll<HTMLElement>(
      'mark[data-pdf-search-highlight]',
    );
    expect(highlights[0]?.getAttribute('data-pdf-search-highlight')).toBe(
      'match',
    );
    expect(highlights[1]?.getAttribute('data-pdf-search-highlight')).toBe(
      'active',
    );
    act(() => mounted.root.unmount());
  });
});
