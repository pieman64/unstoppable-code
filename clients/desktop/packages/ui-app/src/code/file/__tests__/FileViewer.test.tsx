/** @jest-environment jsdom */
import { act, StrictMode, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import type { FileViewerSession, FileViewerState } from '@canopy/app-state';
import type { PortalFileReadPayload } from '@canopy/protocol/portal';

// Replace the client-bound store hook with a selector over a controllable
// state object; keep the real key helpers (fileViewerKey) from the module.
let mockState: FileViewerState;
jest.mock('@canopy/app-state', () => {
  const real: Record<string, unknown> = jest.requireActual('@canopy/app-state');
  return {
    __esModule: true,
    ...real,
    useFileViewerStore: <T,>(selector: (state: FileViewerState) => T): T =>
      selector(mockState),
  };
});

import { fileViewerKey } from '@canopy/app-state';
import {
  FileViewer,
  type FileEditorSlot,
  type FileLineReveal,
  type FileDocumentBytesResult,
  type FileDocumentRenderFailure,
  type FileRichDocumentSlot,
} from '../FileViewer';
import { FileReadOnlyCode } from '../FileReadOnlyCode';
import {
  resolvePreviewScrollContainer,
  type PreviewSearchState,
} from '../FilePreviewSearch';
import { REPLAY_BLOCK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const mockOpenFile = jest.fn<Promise<string>, [PortalFileReadPayload]>();

const REQUEST: PortalFileReadPayload = {
  projectId: 'p1',
  worktreeId: 'w1',
  relativePath: 'src/a.ts',
};

function baseState(session: FileViewerSession | undefined): FileViewerState {
  const key = fileViewerKey(REQUEST);
  return {
    files: session ? { [key]: session } : {},
    diffs: {},
    activeFileKey: session ? key : null,
    activeDiffKey: null,
    canEdit: true,
    openFile: mockOpenFile,
    updateContent: (): void => {},
    saveFile: (): Promise<boolean> => Promise.resolve(true),
    discardEdits: (): void => {},
    setViewMode: (): void => {},
    closeFile: (): void => {},
    openDiff: (): Promise<string> => Promise.resolve(''),
    closeDiff: (): void => {},
  };
}

function session(
  overrides: Partial<FileViewerSession> & { path: string; content: string },
): FileViewerSession {
  const { path, content, ...rest } = overrides;
  return {
    key: fileViewerKey(REQUEST),
    request: REQUEST,
    preview: {
      workspaceLocalId: 'w',
      worktreeLocalId: 'wt',
      path,
      content,
      size: content.length,
      version: 'v1',
      truncated: false,
    },
    content,
    dirty: false,
    viewMode: 'raw',
    status: 'idle',
    error: null,
    ...rest,
  };
}

function render(request: PortalFileReadPayload = REQUEST): string {
  return renderToString(<FileViewer request={request} />);
}

describe('FileViewer', () => {
  beforeEach(() => {
    mockOpenFile.mockReset();
    mockOpenFile.mockResolvedValue(fileViewerKey(REQUEST));
  });

  it('shows a loading placeholder before the first read resolves', () => {
    mockState = baseState(undefined);
    const out = render();
    expect(out).not.toContain('data-testid="file-viewer"');
  });

  it('blocks the file content from session replay and records the path header', () => {
    mockState = baseState(
      session({ path: 'src/a.ts', content: 'const secret = 1;' }),
    );
    const container = document.createElement('div');
    container.innerHTML = render();
    const root = container.firstElementChild;

    expect(Array.from(root?.classList ?? [])).toEqual([
      'flex',
      'h-full',
      'min-h-0',
      'flex-col',
    ]);
    expect(root?.querySelector('[data-testid="file-viewer"]')).not.toBeNull();
    const header = root?.querySelector('[data-testid="file-viewer-header"]');
    expect(header?.textContent).toContain('src/a.ts');
    expect(header?.closest(`.${REPLAY_BLOCK_CLASS}`)).toBeNull();
    const body = root?.querySelector(
      '[data-testid="file-viewer-raw-text-scroll"]',
    );
    expect(body?.textContent).toBe('const secret = 1;');
    expect(body?.classList.contains(REPLAY_BLOCK_CLASS)).toBe(true);
  });

  it('blocks the image and document bodies from session replay', () => {
    const imageRequest: PortalFileReadPayload = {
      ...REQUEST,
      relativePath: 'assets/logo.png',
    };
    mockState = baseState(undefined);
    const image = document.createElement('div');
    image.innerHTML = renderToString(
      <FileViewer
        request={imageRequest}
        resolveImageSrc={(): Promise<string | null> => new Promise(() => {})}
      />,
    );
    expect(
      image
        .querySelector('[data-testid="file-viewer-image-scroll"]')
        ?.classList.contains(REPLAY_BLOCK_CLASS),
    ).toBe(true);

    const pdfRequest: PortalFileReadPayload = {
      ...REQUEST,
      relativePath: 'docs/report.pdf',
    };
    const document_ = document.createElement('div');
    document_.innerHTML = renderToString(
      <FileViewer
        request={pdfRequest}
        resolveDocumentBytes={() => new Promise(() => {})}
        renderRichDocument={() => <div />}
        trailingHeaderActions={<button type="button">Download</button>}
      />,
    );
    const documentHeader = document_.querySelector(
      '[data-testid="file-viewer-document-header"]',
    );
    expect(documentHeader?.textContent).toContain('docs/report.pdf');
    expect(documentHeader?.closest(`.${REPLAY_BLOCK_CLASS}`)).toBeNull();
    expect(
      document_
        .querySelector('[data-testid="file-viewer-document"]')
        ?.classList.contains(REPLAY_BLOCK_CLASS),
    ).toBe(true);
  });

  it('renders a read-only code view when no editor slot is injected', () => {
    mockState = baseState(
      session({ path: 'src/a.ts', content: 'const a = 1;' }),
    );
    const out = render();
    expect(out).toContain('data-testid="file-viewer"');
    expect(out).toContain('data-testid="file-viewer-raw-text-scroll"');
    expect(out).toContain('const a = 1;');
  });

  it('renders the injected editor slot when the host can edit', () => {
    mockState = baseState(session({ path: 'src/a.ts', content: 'x' }));
    const out = renderToString(
      <FileViewer
        request={REQUEST}
        renderEditor={(slot): JSX.Element => (
          <div data-testid="host-editor">{slot.value}</div>
        )}
      />,
    );
    expect(out).toContain('data-testid="host-editor"');
    expect(out).not.toContain('data-testid="file-viewer-raw-text-scroll"');
  });

  it('does not render the editor slot when the host is read-only', () => {
    mockState = {
      ...baseState(session({ path: 'src/a.ts', content: 'x' })),
      canEdit: false,
    };
    const out = renderToString(
      <FileViewer
        request={REQUEST}
        renderEditor={(slot): JSX.Element => (
          <div data-testid="host-editor">{slot.value}</div>
        )}
      />,
    );
    expect(out).not.toContain('data-testid="host-editor"');
    expect(out).toContain('data-testid="file-viewer-raw-text-scroll"');
  });

  it('exposes a view toggle for markdown and renders the preview', () => {
    mockState = baseState(
      session({ path: 'docs/readme.md', content: '# Hi', viewMode: 'preview' }),
    );
    const out = render();
    expect(out).toContain('data-testid="file-view-toggle"');
    expect(out).toContain('aria-label="View source; current view: preview"');
    // In a rendered mode the single-button toggle offers the way back.
    expect(out).toContain('>View source</button>');
    expect(out).toContain('data-testid="file-markdown-preview"');
  });

  it('honors a validated text render kind after the content read', () => {
    mockState = baseState(
      session({
        path: 'extensionless',
        content: '# Heading',
        viewMode: 'preview',
      }),
    );
    const out = renderToString(
      <FileViewer request={REQUEST} requestRenderKind="markdown" />,
    );
    expect(out).toContain('data-testid="file-markdown-preview"');
  });

  it('offers "View preview" from raw mode', () => {
    mockState = baseState(
      session({ path: 'docs/readme.md', content: '# Hi', viewMode: 'raw' }),
    );
    const out = render();
    expect(out).toContain('aria-label="View preview; current view: source"');
    expect(out).toContain('>View preview</button>');
  });

  it('honors a host-controlled preview mode', () => {
    mockState = baseState(
      session({ path: 'docs/readme.md', content: '# Hi', viewMode: 'raw' }),
    );
    const out = renderToString(
      <FileViewer request={REQUEST} viewMode="preview" />,
    );
    expect(out).toContain('data-testid="file-markdown-preview"');
  });

  it('passes the headless preview search through to the host (CAN-3048)', () => {
    mockState = baseState(
      session({
        path: 'docs/readme.md',
        content: '# Hi there',
        viewMode: 'preview',
      }),
    );
    const states: PreviewSearchState[] = [];
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    act(() => {
      root.render(
        <FileViewer
          request={REQUEST}
          searchShortcutActive
          previewSearchPresentation="headless"
          previewSearchControlled={{ open: true, query: 'there', index: 0 }}
          onPreviewSearchStateChange={(state) => states.push(state)}
        />,
      );
    });

    const viewer = host.querySelector('[data-testid="file-viewer"]');
    if (!viewer) throw new Error('file viewer missing');
    const event = new KeyboardEvent('keydown', {
      key: 'f',
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      viewer.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(false);
    expect(
      host.querySelector('[data-testid="file-preview-search-drawer"]'),
    ).toBeNull();
    expect(states.at(-1)).toMatchObject({
      enabled: true,
      open: true,
      queryPresent: true,
    });
    act(() => root.unmount());
    host.remove();
  });

  it('exposes an accessible view toggle and renders CSV table mode', () => {
    mockState = baseState(
      session({ path: 'data.csv', content: 'name,count\nalpha,2' }),
    );
    const out = renderToString(
      <FileViewer request={REQUEST} viewMode="table" />,
    );
    expect(out).toContain('aria-label="View source; current view: table"');
    expect(out).toContain('>View source</button>');
    expect(out).toContain('data-testid="file-viewer-csv-table-scroll"');

    mockState = baseState(
      session({ path: 'data.csv', content: 'name,count\nalpha,2' }),
    );
    const rawOut = renderToString(
      <FileViewer request={REQUEST} viewMode="raw" />,
    );
    expect(rawOut).toContain('aria-label="View table; current view: source"');
    expect(rawOut).toContain('>View table</button>');
  });

  it('normalizes the neutral preview mode to the CSV table view', () => {
    // A persisted/host 'preview' mode (e.g. a tab restored from before the
    // file was a CSV) must not fall through to raw with no active toggle.
    mockState = baseState(
      session({ path: 'data.csv', content: 'name,count\nalpha,2' }),
    );
    const out = renderToString(
      <FileViewer request={REQUEST} viewMode="preview" />,
    );
    expect(out).toContain('data-testid="file-viewer-csv-table-scroll"');
  });

  it('normalizes a stale table mode to preview for non-CSV kinds', () => {
    mockState = baseState(session({ path: 'docs/readme.md', content: '# Hi' }));
    const out = renderToString(
      <FileViewer request={REQUEST} viewMode="table" />,
    );
    expect(out).toContain('data-testid="file-markdown-preview"');
  });

  it('renders Save + Discard + the dirty marker only when dirty and editable', () => {
    mockState = baseState(
      session({ path: 'src/a.ts', content: 'edited', dirty: true }),
    );
    const dirtyOut = renderToString(
      <FileViewer
        request={REQUEST}
        renderEditor={(): JSX.Element => <div data-testid="host-editor" />}
      />,
    );
    expect(dirtyOut).toContain('data-testid="file-save"');
    expect(dirtyOut).toContain('data-testid="file-discard"');
    // The authoritative in-view dirty marker rides the same `session.dirty`.
    expect(dirtyOut).toContain('data-testid="file-viewer-dirty"');

    mockState = baseState(
      session({ path: 'src/a.ts', content: 'edited', dirty: false }),
    );
    const cleanOut = renderToString(
      <FileViewer
        request={REQUEST}
        renderEditor={(): JSX.Element => <div data-testid="host-editor" />}
      />,
    );
    expect(cleanOut).not.toContain('data-testid="file-save"');
    expect(cleanOut).not.toContain('data-testid="file-discard"');
    expect(cleanOut).not.toContain('data-testid="file-viewer-dirty"');
  });

  it('keeps dirty state and save controls visible over alternate content', () => {
    mockState = baseState(
      session({ path: 'src/a.ts', content: 'edited', dirty: true }),
    );

    const out = renderToString(
      <FileViewer
        request={REQUEST}
        renderEditor={(): JSX.Element => <div data-testid="host-editor" />}
        alternateContent={<div data-testid="host-diff">Diff</div>}
      />,
    );

    expect(out).toContain('data-testid="host-diff"');
    expect(out).toContain('data-testid="file-viewer-dirty"');
    expect(out).toMatch(
      /class="[^"]*fg-warning[^"]*"[^>]*data-testid="file-viewer-dirty"/,
    );
    expect(out).not.toContain('text-amber-400');
    expect(out).toContain('data-testid="file-save"');
    expect(out).toContain('data-testid="file-discard"');
    expect(out).toContain('Diff shows saved content');
  });

  it('renders an error state when the first read fails', () => {
    mockState = baseState(
      session({
        path: 'src/a.ts',
        content: '',
        preview: null,
        status: 'error',
        error: 'boom',
      }),
    );
    const out = render();
    expect(out).toContain('data-testid="file-error"');
    expect(out).toContain('boom');
  });

  it('keeps the shared viewer wrapper around the unsupported-file body', () => {
    const binaryRequest = { ...REQUEST, relativePath: 'archive.zip' };
    const binarySession = session({
      path: 'archive.zip',
      content: '',
      preview: null,
      status: 'error',
      error: 'Binary files cannot be read.',
    });
    mockState = {
      ...baseState(undefined),
      files: { [fileViewerKey(binaryRequest)]: binarySession },
    };
    const out = renderToString(
      <FileViewer
        request={binaryRequest}
        renderPathBreadcrumb={(filePath): JSX.Element => (
          <nav data-testid="host-file-breadcrumb">{filePath}</nav>
        )}
        trailingHeaderActions={
          <button data-testid="host-tree-toggle">Files</button>
        }
      />,
    );
    expect(out).toContain('data-testid="file-viewer"');
    expect(out).toContain('data-testid="host-file-breadcrumb"');
    expect(out).toContain('data-testid="host-tree-toggle"');
    expect(out).toContain('Unsupported file type');
    expect(out).toContain('archive.zip');
    expect(out).toContain('cannot be previewed');
    expect(out).not.toContain('data-testid="file-error"');
  });

  it('renders the host unsupported-file action after the info text', () => {
    const binaryRequest = { ...REQUEST, relativePath: 'archive.zip' };
    mockState = {
      ...baseState(undefined),
      files: {
        [fileViewerKey(binaryRequest)]: session({
          path: 'archive.zip',
          content: '',
          preview: null,
          status: 'error',
          error: 'Binary files cannot be read.',
        }),
      },
    };
    const out = renderToString(
      <FileViewer
        request={binaryRequest}
        unsupportedFileAction={
          <button data-testid="host-unsupported-action">Open in Finder</button>
        }
      />,
    );
    expect(out).toContain('data-testid="host-unsupported-action"');
    expect(out.indexOf('cannot be previewed')).toBeLessThan(
      out.indexOf('data-testid="host-unsupported-action"'),
    );
  });

  it('wraps an image preview in a minimal header only when the host has actions', () => {
    mockState = baseState(undefined);
    const imageRequest = { ...REQUEST, relativePath: 'assets/logo.png' };
    const resolveImageSrc = (): Promise<string | null> =>
      Promise.resolve('data:image/png;base64,abc');

    // Image tabs never touch `file.read`, so without a host slot they must keep
    // their existing chrome-free markup byte for byte.
    const bare = renderToString(
      <FileViewer request={imageRequest} resolveImageSrc={resolveImageSrc} />,
    );
    expect(bare).toContain('file-viewer-image-scroll');
    expect(bare).not.toContain('data-testid="file-viewer-image-header"');

    // Existing callers spell "no action" as `null` (DesktopSharedFileViewer
    // passes `diffTarget ? <button/> : null`), so a strict `=== undefined`
    // check would give every desktop image preview an empty header row.
    const nullAction = renderToString(
      <FileViewer
        request={imageRequest}
        resolveImageSrc={resolveImageSrc}
        headerActions={null}
      />,
    );
    expect(nullAction).toContain('file-viewer-image-scroll');
    expect(nullAction).not.toContain('data-testid="file-viewer-image-header"');

    const withAction = renderToString(
      <FileViewer
        request={imageRequest}
        resolveImageSrc={resolveImageSrc}
        headerActions={<button data-testid="host-action">Download</button>}
      />,
    );
    expect(withAction).toContain('data-testid="file-viewer-image-header"');
    expect(withAction).toContain('data-testid="host-action"');
    expect(withAction).toContain('assets/logo.png');
    expect(withAction).toContain('file-viewer-image-scroll');
  });

  it('collapses every header row when a host breadcrumb renders nothing', () => {
    // A host that names the file in its own chrome returns nothing from the
    // breadcrumb; the viewer must drop the row instead of leaving a bare
    // bordered strip under the host's own title.
    mockState = baseState(
      session({ path: 'src/a.ts', content: 'const a = 1;' }),
    );
    const text = renderToString(
      <FileViewer request={REQUEST} renderPathBreadcrumb={() => null} />,
    );
    expect(text).not.toContain('data-testid="file-viewer-header"');
    expect(text).toContain('const a = 1;');

    mockState = baseState(undefined);
    const document = mountViewer(
      <FileViewer
        request={{ ...REQUEST, relativePath: 'brief.pdf' }}
        resolveDocumentBytes={() => new Promise(() => {})}
        renderRichDocument={() => <div />}
        renderPathBreadcrumb={() => null}
      />,
    );
    expect(
      document.container.querySelector(
        '[data-testid="file-viewer-document-header"]',
      ),
    ).toBeNull();
    document.unmount();

    const image = renderToString(
      <FileViewer
        request={{ ...REQUEST, relativePath: 'assets/logo.png' }}
        resolveImageSrc={() => Promise.resolve('data:image/png;base64,abc')}
        renderPathBreadcrumb={() => null}
      />,
    );
    expect(image).not.toContain('data-testid="file-viewer-image-header"');
  });

  it('keeps a header row a nothing-breadcrumb host still fills, without the path', () => {
    mockState = baseState(
      session({ path: 'src/a.ts', content: 'const a = 1;' }),
    );
    const text = mountViewer(
      <FileViewer
        request={REQUEST}
        renderPathBreadcrumb={() => null}
        headerActions={<button data-testid="host-action">Download</button>}
      />,
    );
    const textHeader = text.container.querySelector(
      '[data-testid="file-viewer-header"]',
    );
    expect(
      textHeader?.querySelector('[data-testid="host-action"]'),
    ).not.toBeNull();
    expect(textHeader?.textContent).not.toContain('src/a.ts');
    text.unmount();

    mockState = baseState(undefined);
    const document = mountViewer(
      <FileViewer
        request={{ ...REQUEST, relativePath: 'brief.pdf' }}
        resolveDocumentBytes={() => new Promise(() => {})}
        renderRichDocument={() => <div />}
        renderPathBreadcrumb={() => null}
        trailingHeaderActions={<button>Toggle tree</button>}
      />,
    );
    const documentHeader = document.container.querySelector(
      '[data-testid="file-viewer-document-header"]',
    );
    expect(documentHeader?.textContent).toContain('Toggle tree');
    expect(documentHeader?.textContent).not.toContain('brief.pdf');
    document.unmount();
  });

  it('formats the truncation banner from the host preview byte budget', () => {
    const truncatedState = (): FileViewerState =>
      baseState(
        session({
          path: 'large.txt',
          content: 'truncated contents',
          preview: {
            workspaceLocalId: 'w',
            worktreeLocalId: 'wt',
            path: 'large.txt',
            content: 'truncated contents',
            size: 6_000_000,
            version: 'v1',
            truncated: true,
          },
        }),
      );

    mockState = truncatedState();
    // Desktop passes no budget and keeps its existing 5 MB copy.
    expect(renderToString(<FileViewer request={REQUEST} />)).toContain(
      'Showing the first 5 MB',
    );

    mockState = truncatedState();
    expect(
      renderToString(
        <FileViewer request={REQUEST} previewByteBudget={1024 * 1024} />,
      ),
    ).toContain('Showing the first 1 MB');
  });

  it('renders an injected image preview while leaving no-resolver hosts unchanged', () => {
    mockState = baseState(undefined);
    const imageRequest = { ...REQUEST, relativePath: 'assets/logo.png' };
    const withoutResolver = render(imageRequest);
    expect(withoutResolver).not.toContain('file-viewer-image-scroll');

    const withResolver = renderToString(
      <FileViewer
        request={imageRequest}
        resolveImageSrc={(): Promise<string | null> =>
          Promise.resolve('data:image/png;base64,abc')
        }
      />,
    );
    expect(withResolver).toContain('file-viewer-image-scroll');
  });

  it('dispatches PDF paths and an extensionless host override through the document seam', async () => {
    for (const [request, requestRenderKind] of [
      [{ ...REQUEST, relativePath: 'docs/brief.pdf' }, undefined],
      [{ ...REQUEST, relativePath: 'attachment-id/brief' }, 'pdf' as const],
    ] as const) {
      mockState = baseState(undefined);
      const resolveDocumentBytes = jest
        .fn()
        .mockResolvedValue({ status: 'ready', bytes: new ArrayBuffer(4) });
      const renderRichDocument = jest.fn(
        (slot: FileRichDocumentSlot): JSX.Element => (
          <div data-testid="host-pdf">{slot.request.relativePath}</div>
        ),
      );
      const mounted = mountViewer(
        <FileViewer
          request={request}
          requestRenderKind={requestRenderKind}
          resolveDocumentBytes={resolveDocumentBytes}
          renderRichDocument={renderRichDocument}
        />,
      );
      await flushEffects();

      expect(resolveDocumentBytes).toHaveBeenCalledWith(
        request,
        expect.any(AbortSignal),
      );
      const renderedSlot = renderRichDocument.mock.calls[0]?.[0];
      expect(renderedSlot?.request).toEqual(request);
      expect(renderedSlot?.bytes).toBeInstanceOf(ArrayBuffer);
      expect(renderedSlot?.displayName).toBe(request.relativePath);
      expect(mounted.container.textContent).toContain(request.relativePath);
      expect(mockOpenFile).not.toHaveBeenCalled();
      mounted.unmount();
    }
  });

  it('dispatches docx/xlsx paths and MIME overrides through the document seam with renderKind', async () => {
    for (const [request, requestRenderKind, expectedKind] of [
      [{ ...REQUEST, relativePath: 'docs/brief.docx' }, undefined, 'docx'],
      [{ ...REQUEST, relativePath: 'data/q3.xlsx' }, undefined, 'xlsx'],
      [
        { ...REQUEST, relativePath: 'attachment-id/brief' },
        'docx' as const,
        'docx',
      ],
      [
        { ...REQUEST, relativePath: 'attachment-id/numbers.png' },
        'xlsx' as const,
        'xlsx',
      ],
    ] as const) {
      mockState = baseState(undefined);
      const resolveDocumentBytes = jest
        .fn()
        .mockResolvedValue({ status: 'ready', bytes: new ArrayBuffer(4) });
      const renderRichDocument = jest.fn(
        (slot: FileRichDocumentSlot): JSX.Element => (
          <div data-testid="host-office">{slot.renderKind}</div>
        ),
      );
      const mounted = mountViewer(
        <FileViewer
          request={request}
          supportedDocumentKinds={['pdf', 'docx', 'xlsx']}
          requestRenderKind={requestRenderKind}
          resolveDocumentBytes={resolveDocumentBytes}
          renderRichDocument={renderRichDocument}
        />,
      );
      await flushEffects();

      expect(resolveDocumentBytes).toHaveBeenCalledWith(
        request,
        expect.any(AbortSignal),
      );
      expect(renderRichDocument.mock.calls[0]?.[0]?.renderKind).toBe(
        expectedKind,
      );
      expect(mockOpenFile).not.toHaveBeenCalled();
      mounted.unmount();
    }
  });

  it('keeps the PDF slot renderKind as pdf', async () => {
    mockState = baseState(undefined);
    const renderRichDocument = jest.fn(
      (slot: FileRichDocumentSlot): JSX.Element => <div>{slot.renderKind}</div>,
    );
    const mounted = mountViewer(
      <FileViewer
        request={{ ...REQUEST, relativePath: 'docs/brief.pdf' }}
        resolveDocumentBytes={jest
          .fn()
          .mockResolvedValue({ status: 'ready', bytes: new ArrayBuffer(4) })}
        renderRichDocument={renderRichDocument}
      />,
    );
    await flushEffects();
    expect(renderRichDocument.mock.calls[0]?.[0]?.renderKind).toBe('pdf');
    mounted.unmount();
  });

  it('renders the host recovery hint in the parse-failed card', async () => {
    mockState = baseState(undefined);
    const request = { ...REQUEST, relativePath: 'docs/brief.docx' };
    let reportFailure: FileRichDocumentSlot['onRenderFailure'] | undefined;
    const mounted = mountViewer(
      <FileViewer
        request={request}
        supportedDocumentKinds={['pdf', 'docx', 'xlsx']}
        resolveDocumentBytes={jest
          .fn()
          .mockResolvedValue({ status: 'ready', bytes: new ArrayBuffer(4) })}
        renderRichDocument={(slot: FileRichDocumentSlot): JSX.Element => {
          reportFailure = slot.onRenderFailure;
          return <div data-testid="host-office" />;
        }}
        documentRecoveryHint="Open it in its native app to view the full document."
      />,
    );
    await flushEffects();

    act(() => reportFailure?.('parse-failed'));
    await flushEffects();
    const card = mounted.container.querySelector(
      '[data-testid="file-viewer-document-error"]',
    );
    mounted.unmount();
    expect(card?.getAttribute('data-error-kind')).toBe('parse-failed');
    expect(card?.textContent).toContain(
      'docs/brief.docx could not be converted for preview. Open it in its native app to view the full document.',
    );
  });

  it('renders the typed parse-failed card with the download seam (REG-2903 seam)', async () => {
    mockState = baseState(undefined);
    const request = { ...REQUEST, relativePath: 'docs/brief.docx' };
    let reportFailure: FileRichDocumentSlot['onRenderFailure'] | undefined;
    const mounted = mountViewer(
      <FileViewer
        request={request}
        supportedDocumentKinds={['pdf', 'docx', 'xlsx']}
        resolveDocumentBytes={jest
          .fn()
          .mockResolvedValue({ status: 'ready', bytes: new ArrayBuffer(4) })}
        renderRichDocument={(slot: FileRichDocumentSlot): JSX.Element => {
          reportFailure = slot.onRenderFailure;
          return <div data-testid="host-office" />;
        }}
        documentDisplayName="brief.docx"
        unsupportedFileAction={<button type="button">Download</button>}
      />,
    );
    await flushEffects();

    act(() => reportFailure?.('parse-failed'));
    await flushEffects();
    const card = mounted.container.querySelector(
      '[data-testid="file-viewer-document-error"]',
    );
    expect(card?.getAttribute('data-error-kind')).toBe('parse-failed');
    expect(card?.textContent).toContain(
      'brief.docx could not be converted for preview. Download it to open in its native app.',
    );
    expect(card?.textContent).toContain('Download');
    expect(
      mounted.container.querySelector('[data-testid="host-office"]'),
    ).toBeNull();
    mounted.unmount();
  });

  it('cancels bytes and remounts when the same request changes rich kind', async () => {
    mockState = baseState(undefined);
    const signals: AbortSignal[] = [];
    const resolveDocumentBytes = jest.fn(
      (_request: PortalFileReadPayload, signal: AbortSignal) => {
        signals.push(signal);
        return new Promise<FileDocumentBytesResult>(() => {});
      },
    );
    const request = { ...REQUEST, relativePath: 'extensionless' };
    const renderRichDocument = jest.fn();
    const mounted = mountViewer(
      <FileViewer
        request={request}
        requestRenderKind="docx"
        supportedDocumentKinds={['pdf', 'docx', 'xlsx']}
        resolveDocumentBytes={resolveDocumentBytes}
        renderRichDocument={renderRichDocument}
      />,
    );
    await flushEffects();
    await mounted.render(
      <FileViewer
        request={request}
        requestRenderKind="xlsx"
        supportedDocumentKinds={['pdf', 'docx', 'xlsx']}
        resolveDocumentBytes={resolveDocumentBytes}
        renderRichDocument={renderRichDocument}
      />,
    );
    expect(signals).toHaveLength(2);
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
    expect(renderRichDocument).not.toHaveBeenCalled();
    mounted.unmount();
    expect(signals[1]?.aborted).toBe(true);
  });

  it.each(['docx', 'xlsx'])(
    'keeps default PDF-only hosts from loading %s bytes',
    async (extension) => {
      mockState = baseState(undefined);
      const resolveDocumentBytes = jest.fn();
      const renderRichDocument = jest.fn();
      const mounted = mountViewer(
        <FileViewer
          request={{ ...REQUEST, relativePath: `report.${extension}` }}
          resolveDocumentBytes={resolveDocumentBytes}
          renderRichDocument={renderRichDocument}
        />,
      );
      await flushEffects();
      expect(resolveDocumentBytes).not.toHaveBeenCalled();
      expect(renderRichDocument).not.toHaveBeenCalled();
      expect(mockOpenFile).toHaveBeenCalled();
      mounted.unmount();
    },
  );

  it('uses the bounded image document slot before the legacy URL resolver', async () => {
    mockState = baseState(undefined);
    const resolveDocumentBytes = jest
      .fn()
      .mockResolvedValue({ status: 'ready', bytes: new ArrayBuffer(4) });
    const resolveImageSrc = jest.fn().mockResolvedValue('legacy');
    const renderRichDocument = jest.fn();
    const renderImageDocument = jest.fn((slot: FileRichDocumentSlot) => (
      <div data-testid="bounded-image">{slot.renderKind}</div>
    ));
    const mounted = mountViewer(
      <FileViewer
        request={{ ...REQUEST, relativePath: 'image' }}
        requestRenderKind="image"
        resolveDocumentBytes={resolveDocumentBytes}
        resolveImageSrc={resolveImageSrc}
        renderRichDocument={renderRichDocument}
        {...{ renderImageDocument }}
      />,
    );
    await flushEffects();
    expect(
      mounted.container.querySelector('[data-testid="bounded-image"]'),
    ).not.toBeNull();
    expect(resolveDocumentBytes).toHaveBeenCalledTimes(1);
    expect(renderImageDocument.mock.calls[0]?.[0]?.renderKind).toBe('image');
    expect(resolveImageSrc).not.toHaveBeenCalled();
    expect(renderRichDocument).not.toHaveBeenCalled();
    expect(mockOpenFile).not.toHaveBeenCalled();
    mounted.unmount();
  });

  it('honors a PDF render-kind override before image filename dispatch', async () => {
    const request = { ...REQUEST, relativePath: 'attachment-id/scan.png' };
    mockState = baseState(undefined);
    const resolveImageSrc = jest
      .fn()
      .mockResolvedValue('data:image/png;base64,abc');
    const resolveDocumentBytes = jest
      .fn()
      .mockResolvedValue({ status: 'ready', bytes: new ArrayBuffer(4) });
    const mounted = mountViewer(
      <FileViewer
        request={request}
        requestRenderKind="pdf"
        resolveImageSrc={resolveImageSrc}
        resolveDocumentBytes={resolveDocumentBytes}
        renderRichDocument={() => <div data-testid="host-pdf" />}
      />,
    );
    await flushEffects();

    expect(resolveDocumentBytes).toHaveBeenCalledWith(
      request,
      expect.any(AbortSignal),
    );
    expect(resolveImageSrc).not.toHaveBeenCalled();
    expect(
      mounted.container.querySelector('[data-testid="host-pdf"]'),
    ).not.toBeNull();
    expect(mockOpenFile).not.toHaveBeenCalled();
    mounted.unmount();
  });

  it.each([
    ['too-large', { status: 'too-large', maxBytes: 25 * 1024 * 1024 }],
    ['fetch-failed', { status: 'failed', message: 'Project is unavailable.' }],
  ] as const)(
    'renders the %s document failure with one host action',
    async (kind, result) => {
      mockState = baseState(undefined);
      const mounted = mountViewer(
        <FileViewer
          request={{ ...REQUEST, relativePath: 'report.pdf' }}
          resolveDocumentBytes={jest.fn().mockResolvedValue(result)}
          renderRichDocument={() => <div data-testid="host-pdf" />}
          unsupportedFileAction={
            <button data-testid="download-document">Download</button>
          }
        />,
      );
      await flushEffects();

      const error = mounted.container.querySelector(
        '[data-testid="file-viewer-document-error"]',
      );
      expect(error?.getAttribute('data-error-kind')).toBe(kind);
      expect(error?.textContent).toContain('Document preview unavailable');
      expect(
        mounted.container.querySelectorAll('[data-testid="download-document"]'),
      ).toHaveLength(1);
      expect(
        mounted.container.querySelector('[data-testid="host-pdf"]'),
      ).toBeNull();
      mounted.unmount();
    },
  );

  it.each([
    ['password-protected', 'password-protected'],
    ['corrupt', 'damaged or invalid'],
  ] as const)(
    'replaces a ready document with the %s render failure card',
    async (failure, expectedCopy) => {
      mockState = baseState(undefined);
      let reportFailure: ((failure: FileDocumentRenderFailure) => void) | null =
        null;
      const mounted = mountViewer(
        <FileViewer
          request={{ ...REQUEST, relativePath: 'encoded/id.pdf' }}
          documentDisplayName="Brief.pdf"
          resolveDocumentBytes={jest.fn().mockResolvedValue({
            status: 'ready',
            bytes: new ArrayBuffer(4),
          })}
          renderRichDocument={(slot) => {
            reportFailure = slot.onRenderFailure;
            return <div data-testid="host-pdf" />;
          }}
        />,
      );
      await flushEffects();
      act(() => {
        reportFailure?.(failure);
      });

      const error = mounted.container.querySelector(
        '[data-testid="file-viewer-document-error"]',
      );
      expect(error?.getAttribute('data-error-kind')).toBe(failure);
      expect(error?.textContent).toContain('Brief.pdf');
      expect(error?.textContent).toContain(expectedCopy);
      expect(
        mounted.container.querySelector('[data-testid="host-pdf"]'),
      ).toBeNull();
      mounted.unmount();
    },
  );

  it('aborts document byte resolution when the request changes and on unmount', async () => {
    mockState = baseState(undefined);
    const signals: AbortSignal[] = [];
    const resolveDocumentBytes = jest.fn(
      (_request: PortalFileReadPayload, signal: AbortSignal) => {
        signals.push(signal);
        return new Promise<never>(() => {});
      },
    );
    const first = { ...REQUEST, relativePath: 'first.pdf' };
    const second = { ...REQUEST, relativePath: 'second.pdf' };
    const mounted = mountViewer(
      <FileViewer
        request={first}
        resolveDocumentBytes={resolveDocumentBytes}
        renderRichDocument={() => <div />}
      />,
    );
    await flushEffects();
    await mounted.render(
      <FileViewer
        request={second}
        resolveDocumentBytes={resolveDocumentBytes}
        renderRichDocument={() => <div />}
      />,
    );

    expect(signals).toHaveLength(2);
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
    mounted.unmount();
    expect(signals[1]?.aborted).toBe(true);
  });

  it('does not render bytes from the previous document under a new request', async () => {
    mockState = baseState(undefined);
    const first = { ...REQUEST, relativePath: 'first.pdf' };
    const second = { ...REQUEST, relativePath: 'second.pdf' };
    const secondResolution = new Promise<never>(() => {});
    const resolveDocumentBytes = jest.fn(
      (request: PortalFileReadPayload): Promise<FileDocumentBytesResult> => {
        if (request.relativePath !== first.relativePath)
          return secondResolution;
        return Promise.resolve({
          status: 'ready',
          bytes: new Uint8Array([1]).buffer,
        });
      },
    );
    const renderRichDocument = jest.fn(
      (slot: FileRichDocumentSlot): JSX.Element => (
        <div data-testid="host-pdf">
          {slot.request.relativePath}:
          {String(new Uint8Array(slot.bytes)[0] ?? 0)}
        </div>
      ),
    );
    const mounted = mountViewer(
      <FileViewer
        request={first}
        resolveDocumentBytes={resolveDocumentBytes}
        renderRichDocument={renderRichDocument}
      />,
    );
    await flushEffects();
    expect(mounted.container.textContent).toContain('first.pdf:1');

    renderRichDocument.mockClear();
    await mounted.render(
      <FileViewer
        request={second}
        resolveDocumentBytes={resolveDocumentBytes}
        renderRichDocument={renderRichDocument}
      />,
    );

    expect(renderRichDocument).not.toHaveBeenCalled();
    expect(mounted.container.textContent).not.toContain('second.pdf:1');
    mounted.unmount();
  });

  it.each(['loading', 'ready', 'failed', 'too-large'] as const)(
    'keeps document breadcrumbs and recovery controls in %s state',
    async (status) => {
      mockState = baseState(undefined);
      const resolveDocumentBytes = (): Promise<FileDocumentBytesResult> =>
        status === 'loading'
          ? new Promise(() => {})
          : Promise.resolve(
              status === 'ready'
                ? { status, bytes: new ArrayBuffer(1) }
                : status === 'too-large'
                  ? { status, maxBytes: 25 * 1024 * 1024 }
                  : { status },
            );
      const mounted = mountViewer(
        <FileViewer
          request={{ ...REQUEST, relativePath: 'docs/brief.pdf' }}
          resolveDocumentBytes={resolveDocumentBytes}
          renderRichDocument={() => <div>PDF contents</div>}
          renderPathBreadcrumb={(relativePath) => <nav>{relativePath}</nav>}
          trailingHeaderActions={<button>Toggle tree</button>}
          unsupportedFileAction={<button>Open in Finder</button>}
        />,
      );
      await flushEffects();
      expect(mounted.container.querySelector('nav')?.textContent).toBe(
        'docs/brief.pdf',
      );
      expect(mounted.container.textContent).toContain('Toggle tree');
      if (status === 'failed' || status === 'too-large')
        expect(mounted.container.textContent).toContain('Open in Finder');
      mounted.unmount();
    },
  );

  it('renders a document header when only trailing actions are supplied', () => {
    mockState = baseState(undefined);
    const mounted = mountViewer(
      <FileViewer
        request={{ ...REQUEST, relativePath: 'brief.pdf' }}
        resolveDocumentBytes={() => new Promise(() => {})}
        renderRichDocument={() => <div />}
        trailingHeaderActions={<button>Toggle tree</button>}
      />,
    );
    expect(
      mounted.container.querySelector(
        '[data-testid="file-viewer-document-header"]',
      )?.textContent,
    ).toContain('Toggle tree');
    mounted.unmount();
  });

  it('defers missing documents during setup, then retries independently of text sessions', async () => {
    mockState = baseState(undefined);
    const resolveDocumentBytes = jest
      .fn<Promise<FileDocumentBytesResult>, []>()
      .mockResolvedValueOnce({ status: 'failed' })
      .mockResolvedValueOnce({ status: 'ready', bytes: new ArrayBuffer(1) });
    const viewer = (
      documentRetryGeneration: number,
      deferMissing: boolean,
    ): JSX.Element => (
      <FileViewer
        request={{ ...REQUEST, relativePath: 'brief.pdf' }}
        resolveDocumentBytes={resolveDocumentBytes}
        renderRichDocument={() => <div>Recovered document</div>}
        {...{ documentRetryGeneration, deferMissing }}
      />
    );
    const mounted = mountViewer(viewer(0, true));
    await flushEffects();
    expect(
      mounted.container.querySelector(
        '[data-testid="file-viewer-document-error"]',
      ),
    ).toBeNull();
    expect(
      mounted.container.querySelector('[data-testid="file-viewer-document"]'),
    ).not.toBeNull();
    await mounted.render(viewer(1, false));
    await flushEffects();
    expect(mounted.container.textContent).toContain('Recovered document');
    expect(mockOpenFile).not.toHaveBeenCalled();
    mounted.unmount();
  });

  it('displays a deferred missing document failure when setup ends without the file', async () => {
    mockState = baseState(undefined);
    const resolveDocumentBytes = (): Promise<FileDocumentBytesResult> =>
      Promise.resolve({ status: 'failed' });
    const viewer = (deferMissing: boolean): JSX.Element => (
      <FileViewer
        request={{ ...REQUEST, relativePath: 'brief.pdf' }}
        resolveDocumentBytes={resolveDocumentBytes}
        renderRichDocument={() => <div />}
        deferMissing={deferMissing}
      />
    );
    const mounted = mountViewer(viewer(true));
    await flushEffects();
    expect(
      mounted.container.querySelector(
        '[data-testid="file-viewer-document-error"]',
      ),
    ).toBeNull();
    await mounted.render(viewer(false));
    await flushEffects();
    expect(
      mounted.container.querySelector('[data-error-kind="fetch-failed"]'),
    ).not.toBeNull();
    mounted.unmount();
  });

  it('ignores a stale document response after a retry generation changes', async () => {
    mockState = baseState(undefined);
    let finishOld: ((value: FileDocumentBytesResult) => void) | undefined;
    const oldRead = new Promise<FileDocumentBytesResult>((resolve) => {
      finishOld = resolve;
    });
    const resolveDocumentBytes = jest
      .fn<Promise<FileDocumentBytesResult>, []>()
      .mockReturnValueOnce(oldRead)
      .mockResolvedValueOnce({
        status: 'ready',
        bytes: new Uint8Array([2]).buffer,
      });
    const viewer = (documentRetryGeneration: number): JSX.Element => (
      <FileViewer
        request={{ ...REQUEST, relativePath: 'brief.pdf' }}
        resolveDocumentBytes={resolveDocumentBytes}
        renderRichDocument={({ bytes }) => (
          <div>Document {new Uint8Array(bytes)[0]}</div>
        )}
        {...{ documentRetryGeneration }}
      />
    );
    const mounted = mountViewer(viewer(0));
    await mounted.render(viewer(1));
    await flushEffects();
    expect(mounted.container.textContent).toContain('Document 2');
    await act(async () => {
      finishOld?.({ status: 'failed' });
      await Promise.resolve();
    });
    expect(mounted.container.textContent).toContain('Document 2');
    expect(
      mounted.container.querySelector(
        '[data-testid="file-viewer-document-header"]',
      ),
    ).toBeNull();
    mounted.unmount();
  });

  it('keeps the desktop-compatible file.read fallback when document seams are absent', async () => {
    const request = { ...REQUEST, relativePath: 'brief.pdf' };
    mockState = {
      ...baseState(undefined),
      files: {
        [fileViewerKey(request)]: session({
          path: 'brief.pdf',
          content: '',
          preview: null,
          status: 'error',
          error: 'Binary files cannot be read.',
        }),
      },
    };
    const mounted = mountViewer(<FileViewer request={request} />);
    await flushEffects();

    expect(mockOpenFile).toHaveBeenCalledWith(request);
    expect(mounted.container.textContent).toContain('Unsupported file type');
    mounted.unmount();
  });

  it('renders a first-class missing-file state for a failed missing read', () => {
    mockState = baseState(
      session({
        path: 'src/a.ts',
        content: '',
        preview: null,
        status: 'error',
        error: 'File not found: src/a.ts',
      }),
    );
    const out = render();
    expect(out).toContain('data-testid="file-viewer-missing"');
    expect(out).toContain('File does not exist');
    expect(out).toContain('src/a.ts');
    expect(out).not.toContain('data-testid="file-error"');
  });

  it('keeps a missing file in the loading state while the host defers it', () => {
    mockState = baseState(
      session({
        path: 'src/a.ts',
        content: '',
        preview: null,
        status: 'error',
        error: 'File not found: src/a.ts',
      }),
    );
    const out = renderToString(<FileViewer request={REQUEST} deferMissing />);
    expect(out).not.toContain('data-testid="file-viewer-missing"');
    expect(out).not.toContain('File does not exist');
  });

  it('renders truncated text read-only with the host header slot', () => {
    mockState = baseState(
      session({
        path: 'large.txt',
        content: 'truncated contents',
        preview: {
          workspaceLocalId: 'w',
          worktreeLocalId: 'wt',
          path: 'large.txt',
          content: 'truncated contents',
          size: 6_000_000,
          version: 'v1',
          truncated: true,
        },
      }),
    );
    const out = renderToString(
      <FileViewer
        request={REQUEST}
        renderEditor={(): JSX.Element => <div data-testid="host-editor" />}
        headerActions={<button data-testid="host-action">Action</button>}
      />,
    );
    expect(out).toContain('data-testid="file-viewer-raw-text-scroll"');
    expect(out).toContain('data-testid="host-action"');
    expect(out).toContain('File too large to edit');
    expect(out).not.toContain('data-testid="host-editor"');
  });
});

describe('resolvePreviewScrollContainer', () => {
  it('selects the CSV raw fallback scroller after its warning', () => {
    const container = document.createElement('div');
    container.innerHTML =
      '<div role="alert">Could not parse as CSV</div><pre data-testid="file-viewer-csv-raw-scroll"></pre>';

    expect(resolvePreviewScrollContainer(container)).toBe(
      container.querySelector('[data-testid="file-viewer-csv-raw-scroll"]'),
    );
  });
});

function mountViewer(node: JSX.Element): {
  container: HTMLDivElement;
  root: Root;
  render: (next: JSX.Element) => Promise<void>;
  unmount: () => void;
} {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(node));
  return {
    container,
    root,
    render: (next): Promise<void> => {
      act(() => root.render(next));
      return Promise.resolve();
    },
    unmount: (): void => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('FileViewer line reveal (CAN-4275)', () => {
  const LINE_HEIGHT = 20;
  const VIEWPORT_HEIGHT = 200;
  const CONTAINER_TOP = 100;
  const SCROLL_SELECTOR = '[data-testid="file-viewer-raw-text-scroll"]';
  const RANGE_SELECTOR = '[data-testid="file-viewer-line-range"]';
  const TARGET_SELECTOR = '[data-testid="file-viewer-line-target"]';
  const CONTENT = Array.from(
    { length: 60 },
    (_, index) => `line ${index + 1}`,
  ).join('\n');
  const OTHER: PortalFileReadPayload = { ...REQUEST, relativePath: 'src/b.ts' };

  function rect(top: number, height: number): DOMRect {
    return {
      x: 0,
      y: top,
      top,
      left: 0,
      right: 0,
      bottom: top + height,
      width: 0,
      height,
      toJSON: (): Record<string, never> => ({}),
    };
  }

  /** Scroll position that puts `line`'s top-of-line target at the center. */
  function centeredScrollTop(line: number): number {
    return Math.max(
      0,
      (line - 1) * LINE_HEIGHT - (VIEWPORT_HEIGHT - LINE_HEIGHT) / 2,
    );
  }

  let rectSpy: jest.SpyInstance<DOMRect, []>;

  beforeAll(() => {
    // jsdom has no layout: model a fixed-height viewer whose lines are
    // LINE_HEIGHT tall and move with the scroller's scrollTop.
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get(this: HTMLElement): number {
        return this.matches(SCROLL_SELECTOR) ? VIEWPORT_HEIGHT : 0;
      },
    });
  });

  afterAll(() => {
    Reflect.deleteProperty(HTMLElement.prototype, 'clientHeight');
  });

  beforeEach(() => {
    mockOpenFile.mockReset();
    mockOpenFile.mockResolvedValue(fileViewerKey(REQUEST));
    rectSpy = jest
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: HTMLElement): DOMRect {
        if (this.matches(SCROLL_SELECTOR))
          return rect(CONTAINER_TOP, VIEWPORT_HEIGHT);
        if (this.matches(TARGET_SELECTOR)) {
          const scroller = this.closest<HTMLElement>(SCROLL_SELECTOR);
          const line = Number(
            this.closest<HTMLElement>(RANGE_SELECTOR)?.dataset.lineStart ?? 1,
          );
          return rect(
            CONTAINER_TOP +
              (line - 1) * LINE_HEIGHT -
              (scroller?.scrollTop ?? 0),
            LINE_HEIGHT,
          );
        }
        return rect(0, 0);
      });
  });

  afterEach(() => {
    rectSpy.mockRestore();
  });

  function scroller(container: HTMLElement): HTMLElement | null {
    return container.querySelector<HTMLElement>(SCROLL_SELECTOR);
  }

  function highlighted(container: HTMLElement): HTMLElement | null {
    return container.querySelector<HTMLElement>(RANGE_SELECTOR);
  }

  it('highlights the requested lines without altering the text', async () => {
    mockState = baseState(session({ path: 'src/a.ts', content: CONTENT }));
    const mounted = mountViewer(
      <FileViewer request={REQUEST} revealLine={{ line: 30, lineEnd: 32 }} />,
    );
    await flushEffects();
    const pre = scroller(mounted.container);
    const range = highlighted(mounted.container);
    expect(pre?.textContent).toBe(CONTENT);
    expect(range?.textContent).toBe('line 30\nline 31\nline 32\n');
    expect(range?.dataset.lineStart).toBe('30');
    expect(range?.dataset.lineEnd).toBe('32');
    const target = range?.querySelector(TARGET_SELECTOR);
    expect(range?.firstElementChild).toBe(target);
    expect(target?.textContent).toBe('');
    // The first line is centered in the viewer's own scroller.
    expect(pre?.scrollTop).toBe(centeredScrollTop(30));
    mounted.unmount();
  });

  it('renders the highlight on the server without scrolling', () => {
    mockState = baseState(session({ path: 'src/a.ts', content: 'a\nb\nc' }));
    const out = renderToString(
      <FileViewer request={REQUEST} revealLine={{ line: 2 }} />,
    );
    expect(out).toContain('data-testid="file-viewer-line-range"');
    expect(out).toContain('data-testid="file-viewer-line-target"');
  });

  it.each<
    [string, string, { line: number; lineEnd?: number }, string, number, number]
  >([
    ['an empty final line', 'a\nb\n', { line: 3 }, '', 3, 3],
    [
      'a range through the final empty line',
      'a\nb\n',
      { line: 2, lineEnd: 3 },
      'b\n',
      2,
      3,
    ],
    ['empty content', '', { line: 1 }, '', 1, 1],
    ['blank lines', 'a\n\n\nb', { line: 2, lineEnd: 3 }, '\n\n', 2, 3],
    ['CRLF lines', 'a\r\nb\r\nc', { line: 2 }, 'b\r\n', 2, 2],
    [
      'unicode lines',
      'π\n😀 x\n中文',
      { line: 2, lineEnd: 3 },
      '😀 x\n中文',
      2,
      3,
    ],
    ['an out-of-bounds range', 'a\nb', { line: 40, lineEnd: 50 }, 'b', 2, 2],
    ['a range past the end', 'a\nb\nc', { line: 2, lineEnd: 99 }, 'b\nc', 2, 3],
  ])(
    'keeps exact text and a measurable target for %s',
    async (_label, content, location, rangeText, lineStart, lineEnd) => {
      mockState = baseState(session({ path: 'src/a.ts', content }));
      const mounted = mountViewer(
        <FileViewer request={REQUEST} revealLine={location} />,
      );
      await flushEffects();
      const range = highlighted(mounted.container);
      expect(scroller(mounted.container)?.textContent).toBe(content);
      expect(range?.textContent).toBe(rangeText);
      expect(range?.dataset.lineStart).toBe(String(lineStart));
      expect(range?.dataset.lineEnd).toBe(String(lineEnd));
      expect(range?.querySelector(TARGET_SELECTOR)).not.toBeNull();
      mounted.unmount();
    },
  );

  it('passes the reveal to the host editor slot', async () => {
    mockState = baseState(session({ path: 'src/a.ts', content: CONTENT }));
    const renderEditor = jest
      .fn<JSX.Element, [FileEditorSlot]>()
      .mockReturnValue(<div data-testid="host-editor" />);
    const reveal: FileLineReveal = { line: 4, lineEnd: 6, revision: 2 };
    const mounted = mountViewer(
      <FileViewer
        request={REQUEST}
        renderEditor={renderEditor}
        revealLine={reveal}
      />,
    );
    await flushEffects();
    expect(renderEditor.mock.lastCall?.[0].reveal).toEqual(reveal);
    expect(highlighted(mounted.container)).toBeNull();

    void mounted.render(
      <FileViewer request={REQUEST} renderEditor={renderEditor} />,
    );
    await flushEffects();
    expect(renderEditor.mock.lastCall?.[0].reveal).toBeUndefined();
    mounted.unmount();
  });

  it.each([
    [
      'markdown',
      'docs/readme.md',
      CONTENT.replace('line 1', '# Title'),
      'file-markdown-preview',
    ],
    [
      'HTML',
      'docs/page.html',
      CONTENT.replaceAll(/line (\d+)/g, '<p>line $1</p>'),
      'html-file-preview-frame',
    ],
    [
      'CSV',
      'data.csv',
      CONTENT.replaceAll('line ', 'row,'),
      'file-viewer-csv-table-scroll',
    ],
  ])(
    'ignores a reveal in the %s preview and preserves it on entering raw mode',
    async (_label, path, content, previewTestId) => {
      mockState = baseState(session({ path, content, viewMode: 'preview' }));
      const reveal: FileLineReveal = {
        line: 30,
        lineEnd: 50,
        revision: 2,
      };
      const mounted = mountViewer(
        <FileViewer request={REQUEST} viewMode="preview" revealLine={reveal} />,
      );
      await flushEffects();
      expect(
        mounted.container.querySelector(`[data-testid="${previewTestId}"]`),
      ).not.toBeNull();
      expect(scroller(mounted.container)).toBeNull();
      expect(highlighted(mounted.container)).toBeNull();
      expect(
        mounted.container.querySelector(
          '[data-testid="file-error"], [role="alert"]',
        ),
      ).toBeNull();

      void mounted.render(
        <FileViewer request={REQUEST} viewMode="raw" revealLine={reveal} />,
      );
      await flushEffects();
      expect(scroller(mounted.container)?.textContent).toBe(content);
      expect(highlighted(mounted.container)?.dataset.lineStart).toBe('30');
      expect(highlighted(mounted.container)?.dataset.lineEnd).toBe('50');
      expect(scroller(mounted.container)?.scrollTop).toBe(
        centeredScrollTop(30),
      );
      mounted.unmount();
    },
  );

  it.each([
    [
      'image',
      'assets/logo.png',
      '[data-testid="file-viewer-image-scroll"] img',
    ],
    ['document', 'docs/report.pdf', '[data-testid="host-document"]'],
  ])(
    'ignores reveals without stale highlights or errors when switching to a non-text %s',
    async (_label, relativePath, assetSelector) => {
      mockState = baseState(session({ path: 'src/a.ts', content: CONTENT }));
      const reveal: FileLineReveal = { line: 30, lineEnd: 50, revision: 1 };
      const mounted = mountViewer(
        <FileViewer request={REQUEST} revealLine={reveal} />,
      );
      await flushEffects();
      expect(highlighted(mounted.container)).not.toBeNull();

      const request = { ...REQUEST, relativePath };
      const resolveImageSrc = (): Promise<string> =>
        Promise.resolve('data:image/png;base64,abc');
      const resolveDocumentBytes = (): Promise<FileDocumentBytesResult> =>
        Promise.resolve({ status: 'ready', bytes: new ArrayBuffer(4) });
      const renderRichDocument = (): JSX.Element => (
        <div data-testid="host-document">Document preview</div>
      );
      const assetViewer = (revealLine?: FileLineReveal): JSX.Element => (
        <FileViewer
          request={request}
          revealLine={revealLine}
          resolveImageSrc={resolveImageSrc}
          resolveDocumentBytes={resolveDocumentBytes}
          renderRichDocument={renderRichDocument}
        />
      );
      for (const location of [reveal, { ...reveal, revision: 2 }, undefined]) {
        await act(async () => {
          await mounted.render(assetViewer(location));
        });
        expect(mounted.container.querySelector(assetSelector)).not.toBeNull();
        expect(scroller(mounted.container)).toBeNull();
        expect(highlighted(mounted.container)).toBeNull();
        expect(
          mounted.container.querySelector(
            '[data-testid="file-error"], [data-testid="file-viewer-document-error"], [role="alert"]',
          ),
        ).toBeNull();
      }
      mounted.unmount();
    },
  );

  it.each(['idle', 'saving', 'error'] as const)(
    'reveals the protected dirty buffer while its status is %s',
    async (status) => {
      mockState = baseState(
        session({ path: 'src/a.ts', content: CONTENT, dirty: true, status }),
      );
      const mounted = mountViewer(
        <FileViewer request={REQUEST} revealLine={{ line: 30, revision: 1 }} />,
      );
      await flushEffects();
      expect(scroller(mounted.container)?.textContent).toBe(CONTENT);
      expect(scroller(mounted.container)?.scrollTop).toBe(
        centeredScrollTop(30),
      );
      mounted.unmount();
    },
  );

  it('waits for refreshed cached content before consuming a late reveal', async () => {
    const cached = CONTENT.split('\n').slice(0, 10).join('\n');
    let completeRefresh: (key: string) => void = () => {
      throw new Error('Refresh promise was not initialized');
    };
    const refresh = new Promise<string>((resolve) => {
      completeRefresh = resolve;
    });
    mockOpenFile.mockReturnValueOnce(refresh);
    mockState = baseState(session({ path: 'src/a.ts', content: cached }));
    const reveal = { line: 30, lineEnd: 32, revision: 1 };
    const mounted = mountViewer(
      <FileViewer request={REQUEST} revealLine={reveal} />,
    );
    await flushEffects();

    // A cached preview remains visible while the opening read refreshes it.
    mockState = baseState(
      session({ path: 'src/a.ts', content: cached, status: 'loading' }),
    );
    await mounted.render(<FileViewer request={REQUEST} revealLine={reveal} />);
    await flushEffects();
    await act(async () => {
      mockState = baseState(session({ path: 'src/a.ts', content: CONTENT }));
      await mounted.render(
        <FileViewer request={REQUEST} revealLine={reveal} />,
      );
      completeRefresh(fileViewerKey(REQUEST));
      await refresh;
    });
    expect(highlighted(mounted.container)?.dataset.lineStart).toBe('30');
    expect(scroller(mounted.container)?.scrollTop).toBe(centeredScrollTop(30));

    // Subsequent buffer edits must preserve where the user scrolls.
    const pre = scroller(mounted.container);
    if (pre) pre.scrollTop = 7;
    mockState = baseState(
      session({
        path: 'src/a.ts',
        content: `${CONTENT}\nline 61`,
        dirty: true,
      }),
    );
    await mounted.render(<FileViewer request={REQUEST} revealLine={reveal} />);
    await flushEffects();
    expect(scroller(mounted.container)?.scrollTop).toBe(7);
    mounted.unmount();
  });

  it('waits for delayed content before revealing', async () => {
    mockState = baseState(undefined);
    const element = <FileViewer request={REQUEST} revealLine={{ line: 30 }} />;
    const mounted = mountViewer(element);
    await flushEffects();
    expect(scroller(mounted.container)).toBeNull();

    mockState = baseState(session({ path: 'src/a.ts', content: CONTENT }));
    void mounted.render(
      <FileViewer request={REQUEST} revealLine={{ line: 30 }} />,
    );
    await flushEffects();
    expect(highlighted(mounted.container)?.dataset.lineStart).toBe('30');
    expect(scroller(mounted.container)?.scrollTop).toBe(centeredScrollTop(30));
    mounted.unmount();
  });

  it('reveals again for each new request revision but not on re-render', async () => {
    mockState = baseState(session({ path: 'src/a.ts', content: CONTENT }));
    const mounted = mountViewer(
      <FileViewer request={REQUEST} revealLine={{ line: 30, revision: 1 }} />,
    );
    await flushEffects();
    const pre = scroller(mounted.container);
    expect(pre?.scrollTop).toBe(centeredScrollTop(30));

    // The user scrolls away; an unrelated host re-render keeps their place.
    if (pre) pre.scrollTop = 0;
    void mounted.render(
      <FileViewer request={REQUEST} revealLine={{ line: 30, revision: 1 }} />,
    );
    await flushEffects();
    expect(pre?.scrollTop).toBe(0);

    // Clicking the same link again is a fresh reveal.
    void mounted.render(
      <FileViewer request={REQUEST} revealLine={{ line: 30, revision: 2 }} />,
    );
    await flushEffects();
    expect(pre?.scrollTop).toBe(centeredScrollTop(30));
    mounted.unmount();
  });

  it('moves the highlight and scroll for a changed request', async () => {
    mockState = baseState(session({ path: 'src/a.ts', content: CONTENT }));
    const mounted = mountViewer(
      <FileViewer request={REQUEST} revealLine={{ line: 30, lineEnd: 40 }} />,
    );
    await flushEffects();
    void mounted.render(
      <FileViewer request={REQUEST} revealLine={{ line: 10 }} />,
    );
    await flushEffects();
    const range = highlighted(mounted.container);
    expect(range?.dataset.lineStart).toBe('10');
    expect(range?.dataset.lineEnd).toBe('10');
    expect(range?.textContent).toBe('line 10\n');
    expect(scroller(mounted.container)?.scrollTop).toBe(centeredScrollTop(10));
    mounted.unmount();
  });

  it('clears a stale highlight when the file opens from a plain link', async () => {
    mockState = baseState(session({ path: 'src/a.ts', content: CONTENT }));
    const mounted = mountViewer(
      <FileViewer request={REQUEST} revealLine={{ line: 30 }} />,
    );
    await flushEffects();
    const pre = scroller(mounted.container);
    if (pre) pre.scrollTop = 123;
    void mounted.render(<FileViewer request={REQUEST} />);
    await flushEffects();
    expect(highlighted(mounted.container)).toBeNull();
    expect(scroller(mounted.container)?.textContent).toBe(CONTENT);
    // A plain link keeps the remembered scroll position.
    expect(scroller(mounted.container)?.scrollTop).toBe(123);
    mounted.unmount();
  });

  it('does not replay the reveal when the content reloads', async () => {
    mockState = baseState(session({ path: 'src/a.ts', content: CONTENT }));
    const mounted = mountViewer(
      <FileViewer request={REQUEST} revealLine={{ line: 30 }} />,
    );
    await flushEffects();
    const pre = scroller(mounted.container);
    if (pre) pre.scrollTop = 7;
    const reloaded = `${CONTENT}\nline 61`;
    mockState = baseState(session({ path: 'src/a.ts', content: reloaded }));
    void mounted.render(
      <FileViewer request={REQUEST} revealLine={{ line: 30 }} />,
    );
    await flushEffects();
    expect(scroller(mounted.container)?.textContent).toBe(reloaded);
    expect(highlighted(mounted.container)?.dataset.lineStart).toBe('30');
    expect(scroller(mounted.container)?.scrollTop).toBe(7);
    mounted.unmount();
  });

  it.each([
    ['path', OTHER],
    ['worktree', { ...REQUEST, worktreeId: 'w2' }],
  ])(
    'reveals a preloaded file after its %s changes with the same range and revision',
    async (_label, otherRequest) => {
      const otherContent = CONTENT.replaceAll('line ', 'other ');
      mockState = {
        ...baseState(session({ path: REQUEST.relativePath, content: CONTENT })),
        files: {
          [fileViewerKey(REQUEST)]: session({
            path: REQUEST.relativePath,
            content: CONTENT,
          }),
          [fileViewerKey(otherRequest)]: session({
            path: otherRequest.relativePath,
            content: otherContent,
            key: fileViewerKey(otherRequest),
            request: otherRequest,
          }),
        },
      };
      const reveal: FileLineReveal = { line: 30, lineEnd: 40, revision: 1 };
      const mounted = mountViewer(
        <StrictMode>
          <FileViewer request={REQUEST} revealLine={reveal} />
        </StrictMode>,
      );
      await flushEffects();
      const firstScroller = scroller(mounted.container);
      expect(firstScroller?.scrollTop).toBe(centeredScrollTop(30));
      if (firstScroller) firstScroller.scrollTop = 0;

      void mounted.render(
        <StrictMode>
          <FileViewer request={otherRequest} revealLine={reveal} />
        </StrictMode>,
      );
      await flushEffects();
      expect(scroller(mounted.container)?.textContent).toBe(otherContent);
      expect(highlighted(mounted.container)?.textContent).toContain('other 30');
      expect(scroller(mounted.container)?.scrollTop).toBe(
        centeredScrollTop(30),
      );

      // Once applied to the matching file, unrelated re-renders keep user scroll.
      const otherScroller = scroller(mounted.container);
      if (otherScroller) otherScroller.scrollTop = 7;
      void mounted.render(
        <StrictMode>
          <FileViewer request={otherRequest} revealLine={reveal} />
        </StrictMode>,
      );
      await flushEffects();
      expect(scroller(mounted.container)?.scrollTop).toBe(7);
      mounted.unmount();
    },
  );

  it('reveals matching content when the standalone shared text unit changes file identity', async () => {
    const reveal: FileLineReveal = { line: 30, lineEnd: 40, revision: 1 };
    const mounted = mountViewer(
      <StrictMode>
        <FileReadOnlyCode
          content={CONTENT}
          fileIdentity="first"
          reveal={reveal}
        />
      </StrictMode>,
    );
    await flushEffects();
    const pre = scroller(mounted.container);
    expect(pre?.scrollTop).toBe(centeredScrollTop(30));
    if (pre) pre.scrollTop = 0;
    const otherContent = CONTENT.replaceAll('line ', 'other ');
    void mounted.render(
      <StrictMode>
        <FileReadOnlyCode
          content={otherContent}
          fileIdentity="second"
          reveal={reveal}
        />
      </StrictMode>,
    );
    await flushEffects();
    expect(scroller(mounted.container)?.textContent).toBe(otherContent);
    expect(scroller(mounted.container)?.scrollTop).toBe(centeredScrollTop(30));

    // Edits/reloads within this file update highlighting without a scroll replay.
    const otherScroller = scroller(mounted.container);
    if (otherScroller) otherScroller.scrollTop = 7;
    void mounted.render(
      <StrictMode>
        <FileReadOnlyCode
          content={`${otherContent}\nedit`}
          fileIdentity="second"
          reveal={reveal}
        />
      </StrictMode>,
    );
    await flushEffects();
    expect(scroller(mounted.container)?.textContent).toBe(
      `${otherContent}\nedit`,
    );
    expect(scroller(mounted.container)?.scrollTop).toBe(7);
    mounted.unmount();
  });

  it('does not let a late load of the previous file reveal in the newer one', async () => {
    mockState = baseState(undefined);
    const mounted = mountViewer(
      <FileViewer request={REQUEST} revealLine={{ line: 30 }} />,
    );
    await flushEffects();
    const otherSession = session({
      path: 'src/b.ts',
      content: CONTENT,
      key: fileViewerKey(OTHER),
      request: OTHER,
    });
    mockState = {
      ...baseState(undefined),
      files: { [fileViewerKey(OTHER)]: otherSession },
    };
    void mounted.render(
      <FileViewer request={OTHER} revealLine={{ line: 10 }} />,
    );
    await flushEffects();
    const pre = scroller(mounted.container);
    expect(highlighted(mounted.container)?.dataset.lineStart).toBe('10');
    expect(pre?.scrollTop).toBe(centeredScrollTop(10));
    if (pre) pre.scrollTop = 5;

    // The first file's read finally lands while the second is shown.
    mockState = {
      ...baseState(session({ path: 'src/a.ts', content: CONTENT })),
      files: {
        [fileViewerKey(REQUEST)]: session({
          path: 'src/a.ts',
          content: CONTENT,
        }),
        [fileViewerKey(OTHER)]: otherSession,
      },
    };
    void mounted.render(
      <FileViewer request={OTHER} revealLine={{ line: 10 }} />,
    );
    await flushEffects();
    expect(highlighted(mounted.container)?.dataset.lineStart).toBe('10');
    expect(scroller(mounted.container)?.scrollTop).toBe(5);
    mounted.unmount();
  });
});
