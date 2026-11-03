'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type JSX,
} from 'react';
import {
  GlobalWorkerOptions,
  TextLayer,
  getDocument,
  version,
  type PDFDocumentLoadingTask,
  type PDFDocumentProxy,
  type PDFPageProxy,
  type RenderTask,
} from 'pdfjs-dist';
import {
  nextPdfSearchMatchIndex,
  searchPdfPagesIncrementally,
  type PdfSearchMatch,
  type PdfSearchTextItem,
} from './pdf-search';
import { Button, SearchField } from '@canopy/ui-shared/components';
import { REPLAY_BLOCK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import styles from './PdfPreview.module.css';

export const PDF_PREVIEW_MAX_PAGES = 500;
export const PDF_PREVIEW_MAX_CANVAS_PIXELS = 8_388_608;
export const PDF_PREVIEW_MAX_SOURCE_IMAGE_PIXELS = 8_388_608;
const PDF_PREVIEW_PAGE_LOAD_CONCURRENCY = 8;
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 4;
const ZOOM_STEP = 0.25;

export type PdfPreviewRenderFailure = 'password-protected' | 'corrupt';

export interface PdfPreviewAssets {
  readonly workerSrc: string;
  readonly assetBaseUrl: string;
}

export interface PdfPreviewProps {
  readonly bytes: ArrayBuffer;
  readonly fileName: string;
  /**
   * Show the name in the toolbar. Hosts that already name the file in their
   * own chrome pass `false`; the name then survives only as the preview
   * region's accessible name, so the panel states it exactly once.
   */
  readonly showFileName?: boolean;
  readonly onRenderFailure: (failure: PdfPreviewRenderFailure) => void;
  readonly resolveAssets: (pdfJsVersion: string) => PdfPreviewAssets;
}

interface PdfLoadedPageInfo {
  readonly state: 'loaded';
  readonly page: PDFPageProxy;
  readonly width: number;
  readonly height: number;
}

interface PdfFailedPageInfo {
  readonly state: 'failed';
  readonly width: number;
  readonly height: number;
}

type PdfPageInfo = PdfLoadedPageInfo | PdfFailedPageInfo;

interface PdfPageRenderWork {
  readonly token: symbol;
  canvasTask?: RenderTask;
  textLayer?: TextLayer;
}

type PdfTextContent = Awaited<ReturnType<PDFPageProxy['getTextContent']>>;

function isCancellation(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.name === 'RenderingCancelledException' ||
    error.name === 'AbortException' ||
    /cancel/i.test(error.message)
  );
}

function textItems(content: PdfTextContent): PdfSearchTextItem[] {
  return content.items.map((item) =>
    'str' in item
      ? { text: item.str, hasEOL: item.hasEOL }
      : { text: '', hasEOL: false },
  );
}

/** CSS custom properties the pdf.js text layer scales itself from. */
type PdfPageShellStyle = CSSProperties & {
  readonly '--total-scale-factor': string;
  readonly '--scale-round-x': string;
  readonly '--scale-round-y': string;
};

export function PdfPreview({
  bytes,
  fileName,
  showFileName = true,
  onRenderFailure,
  resolveAssets,
}: PdfPreviewProps): JSX.Element {
  const [pages, setPages] = useState<readonly PdfPageInfo[]>([]);
  const [totalPages, setTotalPages] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [fitWidth, setFitWidth] = useState(false);
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<readonly PdfSearchMatch[]>([]);
  const [activeMatchIndex, setActiveMatchIndex] = useState(-1);
  const [searching, setSearching] = useState(false);
  const previewPageCount = Math.min(totalPages, PDF_PREVIEW_MAX_PAGES);
  const searchReady = previewPageCount > 0 && pages.length === previewPageCount;
  const assets = useMemo(() => resolveAssets(version), [resolveAssets]);

  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const loadingTaskRef = useRef<PDFDocumentLoadingTask | null>(null);
  const documentRef = useRef<PDFDocumentProxy | null>(null);
  const pageShells = useRef(new Map<number, HTMLElement>());
  const canvases = useRef(new Map<number, HTMLCanvasElement>());
  const textLayers = useRef(new Map<number, HTMLDivElement>());
  const renderWork = useRef(new Map<number, PdfPageRenderWork>());
  const textDivs = useRef(new Map<number, HTMLElement[]>());
  const textCache = useRef(new Map<number, Promise<PdfTextContent>>());
  const visibleRatios = useRef(new Map<number, number>());
  const searchGeneration = useRef(0);
  const searchState = useRef<{
    readonly matches: readonly PdfSearchMatch[];
    readonly activeMatchIndex: number;
  }>({
    matches: [],
    activeMatchIndex: -1,
  });
  useEffect(() => {
    searchState.current = { matches, activeMatchIndex };
  }, [activeMatchIndex, matches]);

  const cancelPage = useCallback((pageIndex: number): void => {
    const work = renderWork.current.get(pageIndex);
    work?.canvasTask?.cancel();
    work?.textLayer?.cancel();
    renderWork.current.delete(pageIndex);
    textDivs.current.delete(pageIndex);
    const canvas = canvases.current.get(pageIndex);
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
    }
    textLayers.current.get(pageIndex)?.replaceChildren();
  }, []);

  const applySearchHighlight = useCallback((pageIndex?: number): void => {
    const state = searchState.current;
    for (const [index, spans] of textDivs.current) {
      if (pageIndex !== undefined && index !== pageIndex) continue;
      const highlightStates = spans.map(
        (span) => new Uint8Array(span.textContent?.length ?? 0),
      );
      state.matches.forEach((match, matchIndex) => {
        if (match.pageIndex !== index) return;
        const highlightState = matchIndex === state.activeMatchIndex ? 2 : 1;
        for (const fragment of match.fragments) {
          const characterStates = highlightStates[fragment.itemIndex];
          if (!characterStates) continue;
          const endOffset = Math.min(
            fragment.endOffset,
            characterStates.length,
          );
          for (
            let offset = Math.max(0, fragment.startOffset);
            offset < endOffset;
            offset += 1
          ) {
            characterStates[offset] = Math.max(
              characterStates[offset] ?? 0,
              highlightState,
            );
          }
        }
      });

      for (let itemIndex = 0; itemIndex < spans.length; itemIndex += 1) {
        const span = spans[itemIndex];
        const characterStates = highlightStates[itemIndex];
        if (!span || !characterStates) continue;
        const text = span.textContent ?? '';
        const children: Node[] = [];
        let rangeStart = 0;
        while (rangeStart < text.length) {
          const rangeState = characterStates[rangeStart] ?? 0;
          let rangeEnd = rangeStart + 1;
          while (
            rangeEnd < text.length &&
            characterStates[rangeEnd] === rangeState
          ) {
            rangeEnd += 1;
          }
          const rangeText = text.slice(rangeStart, rangeEnd);
          if (rangeState === 0) {
            children.push(document.createTextNode(rangeText));
          } else {
            const mark = document.createElement('mark');
            mark.className =
              rangeState === 2 ? styles.searchMatchActive : styles.searchMatch;
            mark.dataset.pdfSearchHighlight =
              rangeState === 2 ? 'active' : 'match';
            mark.textContent = rangeText;
            children.push(mark);
          }
          rangeStart = rangeEnd;
        }
        span.replaceChildren(...children);
      }
    }
  }, []);

  const getPageTextContent = useCallback(
    (pageIndex: number): Promise<PdfTextContent> | null => {
      const existing = textCache.current.get(pageIndex);
      if (existing) return existing;
      const pageInfo = pages[pageIndex];
      const page = pageInfo?.state === 'loaded' ? pageInfo.page : undefined;
      if (!page) return null;
      const promise = page.getTextContent();
      textCache.current.set(pageIndex, promise);
      // Evict on rejection so one failed extraction cannot poison every later
      // render and search of the page. Attaching the handler here also keeps a
      // caller-abandoned rejection from surfacing as unhandled.
      void promise.catch(() => {
        if (textCache.current.get(pageIndex) === promise) {
          textCache.current.delete(pageIndex);
        }
      });
      return promise;
    },
    [pages],
  );

  const renderPage = useCallback(
    async (pageIndex: number): Promise<void> => {
      const info = pages[pageIndex];
      const canvas = canvases.current.get(pageIndex);
      const layerContainer = textLayers.current.get(pageIndex);
      if (!info || info.state !== 'loaded' || !canvas || !layerContainer)
        return;
      cancelPage(pageIndex);
      const token = Symbol(`pdf-page-${String(pageIndex)}`);
      const work: PdfPageRenderWork = { token };
      renderWork.current.set(pageIndex, work);
      const viewport = info.page.getViewport({ scale: zoom });
      const cssPixels = Math.max(1, viewport.width * viewport.height);
      const maxOutputScale = Math.sqrt(
        PDF_PREVIEW_MAX_CANVAS_PIXELS / cssPixels,
      );
      const outputScale = Math.min(
        globalThis.devicePixelRatio || 1,
        maxOutputScale,
      );
      canvas.width = Math.max(1, Math.floor(viewport.width * outputScale));
      canvas.height = Math.max(1, Math.floor(viewport.height * outputScale));
      canvas.style.width = `${String(viewport.width)}px`;
      canvas.style.height = `${String(viewport.height)}px`;
      layerContainer.replaceChildren();
      layerContainer.style.setProperty('--total-scale-factor', String(zoom));
      layerContainer.style.setProperty('--scale-round-x', '1px');
      layerContainer.style.setProperty('--scale-round-y', '1px');

      try {
        const contentPromise = getPageTextContent(pageIndex);
        if (contentPromise === null) return;
        const canvasTask = info.page.render({
          canvas,
          viewport,
          ...(outputScale === 1
            ? {}
            : { transform: [outputScale, 0, 0, outputScale, 0, 0] }),
        });
        work.canvasTask = canvasTask;
        // Observe the render promise immediately: a cancellation while this
        // routine is parked on the text-content await below would otherwise
        // reject it with no handler attached (an unhandled rejection on every
        // routine scroll-out).
        void canvasTask.promise.catch(() => undefined);
        const content = await contentPromise;
        if (renderWork.current.get(pageIndex)?.token !== token) return;
        const textLayer = new TextLayer({
          textContentSource: content,
          container: layerContainer,
          viewport,
        });
        work.textLayer = textLayer;
        await Promise.all([canvasTask.promise, textLayer.render()]);
        if (renderWork.current.get(pageIndex)?.token !== token) return;
        textDivs.current.set(pageIndex, textLayer.textDivs);
        applySearchHighlight(pageIndex);
      } catch (error) {
        // A cancelled or superseded render (scroll-out, zoom change) is
        // routine and must not touch page state. A real rasterization or
        // text-layer failure (a bad embedded font or image) is not a corrupt
        // document — the file already opened — but a silently blank shell is
        // indistinguishable from an empty page, so mark just this page failed
        // and let the existing per-page error placeholder render.
        if (isCancellation(error)) return;
        if (renderWork.current.get(pageIndex)?.token !== token) return;
        renderWork.current.delete(pageIndex);
        setPages((current) =>
          current.map((page, index) =>
            index === pageIndex && page.state === 'loaded'
              ? { state: 'failed', width: page.width, height: page.height }
              : page,
          ),
        );
      }
    },
    [applySearchHighlight, cancelPage, getPageTextContent, pages, zoom],
  );

  useEffect(() => {
    let active = true;
    let passwordRequested = false;
    // Keep a document switch visually clean without synchronously cascading a
    // render from the effect body under React 19's effect semantics.
    void Promise.resolve().then(() => {
      if (!active) return;
      setPages([]);
      setTotalPages(0);
      setCurrentPage(1);
      setMatches([]);
      setActiveMatchIndex(-1);
      setSearching(false);
    });
    textCache.current.clear();
    searchGeneration.current += 1;
    const documentRenderWork = renderWork.current;

    // `isEvalSupported` is kept explicit as a hardening declaration across
    // PDF.js versions: 5.7.284 removed the evaluator option (and its
    // dynamic-code path) from its public type/runtime, so the intersection
    // re-adds the field the shipped type no longer names.
    GlobalWorkerOptions.workerSrc = assets.workerSrc;
    const documentInit: Parameters<typeof getDocument>[0] & {
      isEvalSupported: boolean;
    } = {
      data: new Uint8Array(bytes.slice(0)),
      isEvalSupported: false,
      enableXfa: false,
      maxImageSize: PDF_PREVIEW_MAX_SOURCE_IMAGE_PIXELS,
      cMapUrl: `${assets.assetBaseUrl}cmaps/`,
      standardFontDataUrl: `${assets.assetBaseUrl}standard_fonts/`,
      wasmUrl: `${assets.assetBaseUrl}wasm/`,
      iccUrl: `${assets.assetBaseUrl}iccs/`,
    };
    const loadingTask = getDocument(documentInit);
    loadingTaskRef.current = loadingTask;
    loadingTask.onPassword = (
      updatePassword: (password: string | Error) => void,
    ): void => {
      passwordRequested = true;
      updatePassword(new Error('Password-protected PDF'));
    };
    // `.then(...).catch(...)` rather than a two-argument `.then` keeps failures
    // opening the document and failures forced by a mid-load destroy observed.
    // Individual page failures are settled below and rendered in place.
    void loadingTask.promise
      .then(async (document) => {
        if (!active) return;
        documentRef.current = document;
        const count = Math.min(document.numPages, PDF_PREVIEW_MAX_PAGES);
        setTotalPages(document.numPages);
        if (count === 0) return;

        const loadPage = async (
          pageIndex: number,
        ): Promise<PdfLoadedPageInfo> => {
          const page = await document.getPage(pageIndex + 1);
          const viewport = page.getViewport({ scale: 1 });
          return {
            state: 'loaded',
            page,
            width: viewport.width,
            height: viewport.height,
          };
        };
        let fallbackWidth = 612;
        let fallbackHeight = 792;
        const settlePages = async (
          pageIndexes: readonly number[],
        ): Promise<PdfPageInfo[]> => {
          const results = await Promise.allSettled(
            pageIndexes.map((pageIndex) => loadPage(pageIndex)),
          );
          return results.map((result) => {
            if (result.status === 'fulfilled') {
              fallbackWidth = result.value.width;
              fallbackHeight = result.value.height;
              return result.value;
            }
            return {
              state: 'failed',
              width: fallbackWidth,
              height: fallbackHeight,
            };
          });
        };
        const loaded = await settlePages([0]);
        if (!active) return;
        setPages([...loaded]);

        for (
          let batchStart = 1;
          batchStart < count;
          batchStart += PDF_PREVIEW_PAGE_LOAD_CONCURRENCY
        ) {
          const batchSize = Math.min(
            PDF_PREVIEW_PAGE_LOAD_CONCURRENCY,
            count - batchStart,
          );
          const batch = await settlePages(
            Array.from(
              { length: batchSize },
              (_, offset) => batchStart + offset,
            ),
          );
          if (!active) return;
          loaded.push(...batch);
        }
        if (active) {
          setPages([...loaded]);
        }
      })
      .catch((error: unknown) => {
        if (!active || isCancellation(error)) return;
        onRenderFailure(passwordRequested ? 'password-protected' : 'corrupt');
        void loadingTask.destroy();
      });

    return (): void => {
      active = false;
      searchGeneration.current += 1;
      for (const pageIndex of [...documentRenderWork.keys()]) {
        cancelPage(pageIndex);
      }
      documentRef.current = null;
      void loadingTask.destroy();
      if (loadingTaskRef.current === loadingTask) loadingTaskRef.current = null;
    };
  }, [
    assets.assetBaseUrl,
    assets.workerSrc,
    bytes,
    cancelPage,
    onRenderFailure,
  ]);

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller || pages.length === 0) return undefined;
    const observedRenderWork = renderWork.current;
    visibleRatios.current.clear();
    const prefetchObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!(entry.target instanceof HTMLElement)) continue;
          const pageIndex = Number(entry.target.dataset.pageIndex);
          if (entry.isIntersecting) void renderPage(pageIndex);
          else cancelPage(pageIndex);
        }
      },
      { root: scroller, rootMargin: '100% 0px' },
    );
    const visibilityObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!(entry.target instanceof HTMLElement)) continue;
          const pageIndex = Number(entry.target.dataset.pageIndex);
          visibleRatios.current.set(
            pageIndex,
            entry.isIntersecting ? entry.intersectionRatio : 0,
          );
        }
        let bestIndex = 0;
        let bestRatio = -1;
        for (const [pageIndex, ratio] of visibleRatios.current) {
          if (ratio > bestRatio) {
            bestRatio = ratio;
            bestIndex = pageIndex;
          }
        }
        setCurrentPage(bestIndex + 1);
      },
      { root: scroller, rootMargin: '0px', threshold: [0, 0.25, 0.5, 0.75, 1] },
    );
    for (const shell of pageShells.current.values()) {
      prefetchObserver.observe(shell);
      visibilityObserver.observe(shell);
    }
    return (): void => {
      prefetchObserver.disconnect();
      visibilityObserver.disconnect();
      for (const pageIndex of [...observedRenderWork.keys()]) {
        cancelPage(pageIndex);
      }
    };
  }, [cancelPage, pages, renderPage]);

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller || pages.length === 0) return undefined;
    const observer = new ResizeObserver((entries) => {
      if (!fitWidth) return;
      const availableWidth =
        Math.max(1, entries[0]?.contentRect.width ?? 1) - 32;
      const widestPage = Math.max(...pages.map((page) => page.width));
      setZoom(
        Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, availableWidth / widestPage)),
      );
    });
    observer.observe(scroller);
    return (): void => observer.disconnect();
  }, [fitWidth, pages]);

  useEffect(() => {
    applySearchHighlight();
    const match = matches[activeMatchIndex];
    if (match) {
      pageShells.current.get(match.pageIndex)?.scrollIntoView({
        block: 'center',
        behavior: 'smooth',
      });
    }
  }, [activeMatchIndex, applySearchHighlight, matches]);

  const runSearch = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!searchReady) return;
    const normalized = query.trim();
    const generation = searchGeneration.current + 1;
    searchGeneration.current = generation;
    if (normalized.length === 0) {
      setMatches([]);
      setActiveMatchIndex(-1);
      setSearching(false);
      return;
    }
    setSearching(true);
    void searchPdfPagesIncrementally({
      pageCount: pages.length,
      query: normalized,
      getPageItems: async (pageIndex) => {
        const cached = getPageTextContent(pageIndex);
        if (!cached) return [];
        try {
          return textItems(await cached);
        } catch {
          // One page failing extraction contributes no items for that page
          // only; matches already found on healthy pages must survive.
          return [];
        }
      },
      isCurrent: () => searchGeneration.current === generation,
    })
      .then((result) => {
        if (result === null || searchGeneration.current !== generation) return;
        setMatches(result);
        setActiveMatchIndex(result.length > 0 ? 0 : -1);
        setSearching(false);
      })
      .catch(() => {
        // A failed extraction must not strand the aria-live region on
        // "Searching…" (or reject unhandled); report an empty result instead.
        if (searchGeneration.current !== generation) return;
        setMatches([]);
        setActiveMatchIndex(-1);
        setSearching(false);
      });
  };

  const moveMatch = (direction: 1 | -1): void => {
    setActiveMatchIndex((current) =>
      nextPdfSearchMatchIndex(current, matches.length, direction),
    );
  };

  return (
    <div
      className={styles.preview}
      data-testid="pdf-preview"
      // `role` is required for the label to reach assistive tech: neither this
      // element nor the toolbar carries one otherwise, and `aria-label` on a
      // role-less div is ignored.
      role={showFileName ? undefined : 'group'}
      aria-label={showFileName ? undefined : fileName}
    >
      <div className={styles.toolbar} data-testid="pdf-preview-toolbar">
        {showFileName && (
          <span className={styles.fileName} title={fileName}>
            {fileName}
          </span>
        )}
        <Button
          variant="ghost"
          size="compact"
          iconOnly
          aria-label="Zoom out"
          disabled={zoom <= MIN_ZOOM}
          onClick={() => {
            setFitWidth(false);
            setZoom((value) => Math.max(MIN_ZOOM, value - ZOOM_STEP));
          }}
        >
          −
        </Button>
        <span aria-label="Zoom level">{Math.round(zoom * 100)}%</span>
        <Button
          variant="ghost"
          size="compact"
          iconOnly
          aria-label="Zoom in"
          disabled={zoom >= MAX_ZOOM}
          onClick={() => {
            setFitWidth(false);
            setZoom((value) => Math.min(MAX_ZOOM, value + ZOOM_STEP));
          }}
        >
          +
        </Button>
        <Button
          variant="ghost"
          size="compact"
          aria-label="Fit PDF to width"
          aria-pressed={fitWidth}
          onClick={() => setFitWidth(true)}
        >
          Fit width
        </Button>
        <span aria-label="Current PDF page">
          {currentPage} / {Math.max(totalPages, pages.length)}
        </span>
        <form className={styles.search} onSubmit={runSearch}>
          <SearchField
            aria-label="Search PDF"
            data-testid="pdf-search-input"
            className="w-44"
            disabled={!searchReady}
            value={query}
            onValueChange={(next) => {
              searchGeneration.current += 1;
              setQuery(next);
              setMatches([]);
              setActiveMatchIndex(-1);
              setSearching(false);
            }}
          />
          <Button
            type="submit"
            variant="secondary"
            size="compact"
            aria-label="Search PDF text"
            disabled={!searchReady}
          >
            Search
          </Button>
          <Button
            variant="ghost"
            size="compact"
            iconOnly
            aria-label="Previous PDF search match"
            disabled={matches.length === 0}
            onClick={() => moveMatch(-1)}
          >
            ↑
          </Button>
          <Button
            variant="ghost"
            size="compact"
            iconOnly
            aria-label="Next PDF search match"
            disabled={matches.length === 0}
            onClick={() => moveMatch(1)}
          >
            ↓
          </Button>
          <span data-testid="pdf-search-count" aria-live="polite">
            {searching
              ? 'Searching…'
              : `${activeMatchIndex < 0 ? 0 : activeMatchIndex + 1} / ${String(matches.length)}`}
          </span>
        </form>
      </div>
      {/* The rendered pages are file content: session replay keeps a
          placeholder. The toolbar and its file name stay recorded. */}
      <div
        className={`${REPLAY_BLOCK_CLASS} ${styles.scroller}`}
        ref={scrollerRef}
      >
        {pages.map((info, pageIndex) => {
          const pageStyle: PdfPageShellStyle = {
            width:
              info.state === 'failed'
                ? `min(${String(info.width * zoom)}px, 100%)`
                : `${String(info.width * zoom)}px`,
            height: `${String(info.height * zoom)}px`,
            '--total-scale-factor': String(zoom),
            '--scale-round-x': '1px',
            '--scale-round-y': '1px',
          };
          return (
            <div
              key={pageIndex}
              ref={(node) => {
                if (node) pageShells.current.set(pageIndex, node);
                else pageShells.current.delete(pageIndex);
              }}
              className={styles.page}
              style={pageStyle}
              data-page-index={pageIndex}
              data-testid="pdf-preview-page"
            >
              {info.state === 'loaded' ? (
                <>
                  <canvas
                    ref={(node) => {
                      if (node) canvases.current.set(pageIndex, node);
                      else canvases.current.delete(pageIndex);
                    }}
                    data-testid="pdf-preview-page-canvas"
                  />
                  <div
                    ref={(node) => {
                      if (node) textLayers.current.set(pageIndex, node);
                      else textLayers.current.delete(pageIndex);
                    }}
                    className={styles.textLayer}
                  />
                </>
              ) : (
                <div
                  className={styles.pageError}
                  data-testid="pdf-preview-page-error"
                  role="status"
                >
                  Page {pageIndex + 1} could not be previewed.
                </div>
              )}
            </div>
          );
        })}
        {totalPages > PDF_PREVIEW_MAX_PAGES && (
          <p className={styles.truncated} role="status">
            Showing first {PDF_PREVIEW_MAX_PAGES} of {totalPages} pages
          </p>
        )}
      </div>
    </div>
  );
}
