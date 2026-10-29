/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const mockParse = jest.fn();
jest.mock('../office-parse-client', () => ({
  __esModule: true,
  parseOfficeDocument: (...args: unknown[]): unknown => mockParse(...args),
}));

import * as docxSanitize from '../docx-sanitize';
import { DocxPreview } from '../DocxPreview';
import { REPLAY_BLOCK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const createTestWorker = jest.fn();

const BYTES = new Uint8Array([80, 75, 3, 4]).buffer;

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

describe('DocxPreview', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    mockParse.mockReset();
    document.body.innerHTML = '';
  });

  it('sanitizes parsed HTML and renders it in an opaque-origin sandbox', async () => {
    mockParse.mockResolvedValue({
      kind: 'docx',
      html: '<h1>Hello</h1><script>bad()</script><a href="javascript:x()">link</a>',
      warnings: [],
    });
    const onRenderFailure = jest.fn();
    const { container, root } = mount(
      <DocxPreview
        createWorker={createTestWorker}
        bytes={BYTES}
        fileName="brief.docx"
        onRenderFailure={onRenderFailure}
      />,
    );
    expect(
      container.querySelector('[data-testid="office-preview-banner"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="office-preview-banner"]')
        ?.textContent,
    ).toBe(
      'Semantic preview: formatting may differ; download for the exact document.',
    );
    expect(
      container.querySelector('[data-testid="docx-preview-loading"]'),
    ).not.toBeNull();
    await flush();

    const expectedSignal: unknown = expect.any(AbortSignal);
    expect(mockParse).toHaveBeenCalledWith(
      { kind: 'docx', bytes: BYTES },
      { createWorker: createTestWorker, signal: expectedSignal },
    );
    const frame = container.querySelector<HTMLIFrameElement>(
      '[data-testid="docx-preview-frame"]',
    );
    expect(frame?.getAttribute('sandbox')).toBe('');
    expect(frame?.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(frame?.title).toBe('brief.docx');
    expect(frame?.srcdoc).toContain('<h1>Hello</h1>');
    expect(frame?.srcdoc).not.toContain('javascript:');
    expect(frame?.srcdoc).not.toContain('<script>bad()');
    expect(frame?.srcdoc).toContain("script-src 'none'");
    expect(onRenderFailure).not.toHaveBeenCalled();
    act(() => root.unmount());
  });

  it('blocks the preview root from session replay from its first mount', async () => {
    mockParse.mockResolvedValue({
      kind: 'docx',
      html: '<p>Confidential</p>',
      warnings: [],
    });
    const { container, root } = mount(
      <DocxPreview
        createWorker={createTestWorker}
        bytes={BYTES}
        fileName="brief.docx"
        onRenderFailure={jest.fn()}
      />,
    );
    const loadingRoot = container.firstElementChild;
    expect(loadingRoot?.getAttribute('data-testid')).toBe('docx-preview');
    expect(loadingRoot?.classList.contains(REPLAY_BLOCK_CLASS)).toBe(true);

    await flush();
    expect(container.firstElementChild).toBe(loadingRoot);
    expect(
      loadingRoot?.querySelector('[data-testid="docx-preview-frame"]'),
    ).not.toBeNull();
    act(() => root.unmount());
  });

  it('reports parse-failed when parsing rejects', async () => {
    mockParse.mockRejectedValue(new Error('timeout'));
    const onRenderFailure = jest.fn();
    const { root } = mount(
      <DocxPreview
        createWorker={createTestWorker}
        bytes={BYTES}
        fileName="brief.docx"
        onRenderFailure={onRenderFailure}
      />,
    );
    await flush();
    expect(onRenderFailure).toHaveBeenCalledWith('parse-failed');
    act(() => root.unmount());
  });

  it('reports parse-failed when sanitization exceeds its element budget', async () => {
    // Real element boundaries are covered in docx-sanitize.test.ts. This
    // component test only verifies that the sanitizer error reaches the host.
    jest.spyOn(docxSanitize, 'sanitizeDocxHtml').mockImplementationOnce(() => {
      throw new docxSanitize.DocxElementBudgetError();
    });
    mockParse.mockResolvedValue({
      kind: 'docx',
      html: '<p>Preview</p>',
      warnings: [],
    });
    const onRenderFailure = jest.fn();
    const { container, root } = mount(
      <DocxPreview
        createWorker={createTestWorker}
        bytes={BYTES}
        fileName="dense.docx"
        onRenderFailure={onRenderFailure}
      />,
    );
    await flush();
    expect(onRenderFailure).toHaveBeenCalledWith('parse-failed');
    expect(
      container.querySelector('[data-testid="docx-preview-frame"]'),
    ).toBeNull();
    act(() => root.unmount());
  });

  it('aborts the in-flight parse on unmount and stays silent', async () => {
    let capturedSignal: AbortSignal | undefined;
    mockParse.mockImplementation(
      (_request: unknown, options: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          capturedSignal = options.signal;
          options.signal.addEventListener('abort', () =>
            reject(new Error('aborted')),
          );
        }),
    );
    const onRenderFailure = jest.fn();
    const { root } = mount(
      <DocxPreview
        createWorker={createTestWorker}
        bytes={BYTES}
        fileName="brief.docx"
        onRenderFailure={onRenderFailure}
      />,
    );
    act(() => root.unmount());
    await flush();
    expect(capturedSignal?.aborted).toBe(true);
    expect(onRenderFailure).not.toHaveBeenCalled();
  });

  it('ignores stale success and failure after replacing bytes', async () => {
    const pending: Array<{
      readonly resolve: (value: {
        kind: 'docx';
        html: string;
        warnings: readonly string[];
      }) => void;
      readonly reject: (error: Error) => void;
    }> = [];
    mockParse.mockImplementation(
      () => new Promise((resolve, reject) => pending.push({ resolve, reject })),
    );
    const firstBytes = new Uint8Array([1]).buffer;
    const secondBytes = new Uint8Array([2]).buffer;
    const firstFailure = jest.fn();
    const secondFailure = jest.fn();
    const { container, root } = mount(
      <DocxPreview
        createWorker={createTestWorker}
        bytes={firstBytes}
        fileName="first.docx"
        onRenderFailure={firstFailure}
      />,
    );
    act(() =>
      root.render(
        <DocxPreview
          createWorker={createTestWorker}
          bytes={secondBytes}
          fileName="second.docx"
          onRenderFailure={secondFailure}
        />,
      ),
    );
    await act(async () => {
      pending[0].resolve({ kind: 'docx', html: '<p>stale</p>', warnings: [] });
      await Promise.resolve();
    });
    expect(container.querySelector('iframe')).toBeNull();
    pending[0].reject(new Error('late'));
    await act(async () => {
      pending[1].resolve({
        kind: 'docx',
        html: '<p>current</p>',
        warnings: [],
      });
      await Promise.resolve();
    });
    expect(
      container.querySelector<HTMLIFrameElement>('iframe')?.srcdoc,
    ).toContain('current');
    expect(firstFailure).not.toHaveBeenCalled();
    expect(secondFailure).not.toHaveBeenCalled();
    act(() => root.unmount());
  });
  it('forwards the host worker factory and renders host recovery copy', async () => {
    mockParse.mockResolvedValue({
      kind: 'docx',
      html: '<p>ok</p>',
      warnings: [],
    });
    const createWorker = jest.fn();
    const copy = {
      banner:
        'Semantic preview: formatting may differ; open in Finder for the exact document.',
      truncationRecovery:
        'Open the workbook in its native app to see everything.',
    };
    const hostProps = { createWorker, copy };
    const { container, root } = mount(
      <DocxPreview
        bytes={BYTES}
        fileName="brief.docx"
        onRenderFailure={jest.fn()}
        {...hostProps}
      />,
    );
    await flush();
    try {
      expect(mockParse).toHaveBeenCalledWith(
        { kind: 'docx', bytes: BYTES },
        expect.objectContaining({ createWorker }),
      );
      expect(
        container.querySelector('[data-testid="office-preview-banner"]')
          ?.textContent,
      ).toBe(copy.banner);
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
      <DocxPreview
        bytes={BYTES}
        fileName="brief.docx"
        onRenderFailure={onRenderFailure}
        {...firstHost}
      />,
    );
    act(() =>
      root.render(
        <DocxPreview
          bytes={BYTES}
          fileName="brief.docx"
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
