/** @jest-environment jsdom */
import './jsdom-text-encoding';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const mockParse = jest.fn();
jest.mock('../office-parse-client', () => ({
  __esModule: true,
  parseOfficeDocument: (...args: unknown[]): unknown => mockParse(...args),
}));

import {
  buildPptxFixture,
  PPTX_BULLETS,
  PPTX_NOTES,
  PPTX_TABLE_CELL,
  PPTX_TITLE,
} from '../../../test/ooxml-fixtures.js';
import { parsePptxPresentation, type PptxParseResult } from '../pptx-parse';
import { PptxPreview } from '../PptxPreview';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const createTestWorker = jest.fn();
const BYTES = new Uint8Array([80, 75, 3, 4]).buffer;

function fixtureResult(extraSlides = 0): PptxParseResult {
  return parsePptxPresentation(
    Uint8Array.from(buildPptxFixture({ extraSlides })).buffer,
  );
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
  });
}

describe('PptxPreview', () => {
  afterEach(() => {
    mockParse.mockReset();
    document.body.innerHTML = '';
  });

  it('resolves selection against each solid slide surface rather than app appearance', async () => {
    const result = fixtureResult();
    mockParse.mockResolvedValue({
      ...result,
      slides: result.slides.map((slide, index) => ({
        ...slide,
        background: index === 0 ? '#ffffff' : '#000000',
      })),
    });
    const { container, root } = mount(
      <PptxPreview
        createWorker={createTestWorker}
        bytes={BYTES}
        fileName="deck.pptx"
        onRenderFailure={jest.fn()}
      />,
    );
    await flush();
    expect(
      Array.from(
        container.querySelectorAll('[data-testid="pptx-slide-canvas"]'),
        (canvas) => canvas.getAttribute('data-selection-surface'),
      ),
    ).toEqual(['paper', 'dark']);
    act(() => root.unmount());
  });

  it('shows the banner while loading, then one canvas per slide', async () => {
    mockParse.mockResolvedValue(fixtureResult());
    const onRenderFailure = jest.fn();
    const { container, root } = mount(
      <PptxPreview
        createWorker={createTestWorker}
        bytes={BYTES}
        fileName="deck.pptx"
        onRenderFailure={onRenderFailure}
      />,
    );
    expect(
      container.querySelector('[data-testid="office-preview-banner"]')
        ?.textContent,
    ).toBe(
      'Semantic preview: formatting may differ; download for the exact document.',
    );
    expect(
      container.querySelector('[data-testid="pptx-preview-loading"]'),
    ).not.toBeNull();
    await flush();

    const expectedSignal: unknown = expect.any(AbortSignal);
    expect(mockParse).toHaveBeenCalledWith(
      { kind: 'pptx', bytes: BYTES },
      { createWorker: createTestWorker, signal: expectedSignal },
    );
    const slides = container.querySelectorAll('[data-testid="pptx-slide"]');
    expect(slides).toHaveLength(2);
    expect(slides[0]?.getAttribute('aria-label')).toBe('Slide 1 of 2');
    const [first, second] = Array.from(slides);
    expect(first?.textContent).toContain(PPTX_TITLE);
    expect(first?.textContent).toContain(PPTX_BULLETS[0]);
    expect(
      first?.querySelector('[data-testid="pptx-slide-notes"]')?.textContent,
    ).toContain(PPTX_NOTES);
    const image = first?.querySelector<HTMLImageElement>(
      '[data-testid="pptx-image"]',
    );
    expect(image?.alt).toBe('Ticket trend');
    expect(image?.getAttribute('src')).toMatch(/^data:image\/png;base64,/);
    expect(
      second?.querySelector('[data-testid="pptx-slide-hidden"]'),
    ).not.toBeNull();
    expect(
      second?.querySelector('[data-testid="pptx-table"]')?.textContent,
    ).toContain(PPTX_TABLE_CELL);
    expect(
      second?.querySelector('[data-testid="pptx-unsupported"]')?.textContent,
    ).toBe('Chart not shown in preview');
    expect(
      container.querySelector('[data-testid="pptx-truncation-banner"]'),
    ).toBeNull();
    expect(onRenderFailure).not.toHaveBeenCalled();
    act(() => root.unmount());
  });

  it('positions shapes as slide percentages with inherited text styling', async () => {
    mockParse.mockResolvedValue(fixtureResult());
    const { container, root } = mount(
      <PptxPreview
        createWorker={createTestWorker}
        bytes={BYTES}
        fileName="deck.pptx"
        onRenderFailure={jest.fn()}
      />,
    );
    await flush();
    const canvas = container.querySelector<HTMLElement>(
      '[data-testid="pptx-slide-canvas"]',
    );
    expect(canvas?.style.aspectRatio).toBe('12192000 / 6858000');
    const title = Array.from(
      container.querySelectorAll<HTMLElement>('[data-testid="pptx-shape"]'),
    ).find((shape) => shape.textContent === PPTX_TITLE);
    // 838,200 / 12,192,000 EMU from the left edge.
    expect(title?.style.left).toBe('6.875%');
    // jsdom drops container-query units, so text scaling is asserted in the
    // Electron office preview spec; inherited title styling is checked here.
    const run = title?.querySelector<HTMLElement>('span');
    expect(run?.style.fontWeight).toBe('700');
    expect(run?.style.fontFamily).toBe('"Calibri Light", sans-serif');
    act(() => root.unmount());
  });

  it('reports a capped slide list', async () => {
    mockParse.mockResolvedValue(fixtureResult(299));
    const { container, root } = mount(
      <PptxPreview
        createWorker={createTestWorker}
        bytes={BYTES}
        fileName="deck.pptx"
        onRenderFailure={jest.fn()}
      />,
    );
    await flush();
    expect(
      container.querySelector('[data-testid="pptx-truncation-banner"]')
        ?.textContent,
    ).toBe('Showing the first 300 of 301 slides.');
    act(() => root.unmount());
  });

  it('reports parse-failed when parsing rejects', async () => {
    mockParse.mockRejectedValue(new Error('timeout'));
    const onRenderFailure = jest.fn();
    const { root } = mount(
      <PptxPreview
        createWorker={createTestWorker}
        bytes={BYTES}
        fileName="deck.pptx"
        onRenderFailure={onRenderFailure}
      />,
    );
    await flush();
    expect(onRenderFailure).toHaveBeenCalledWith('parse-failed');
    act(() => root.unmount());
  });
});
