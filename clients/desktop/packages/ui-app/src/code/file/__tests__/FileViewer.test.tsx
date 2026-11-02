/** @jest-environment jsdom */
import { act, StrictMode, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import type {
  FileOverlapComparison,
  FileViewerSession,
  FileViewerState,
  FileViewMode,
  OverlapRegion,
} from '@canopy/app-state';
import type { PortalFileReadPayload } from '@canopy/protocol/portal';
import type { CanopyClient } from '@canopy/app-core';
import type * as SharedComponents from '@canopy/ui-shared/components';

// Replace the client-bound store hook with a selector over a controllable
// state object; keep the real key helpers (fileViewerKey) from the module.
let mockState: FileViewerState;
// Exercise the confirmation's acceptance boundary independently of the
// browser's disabled-button behavior, while keeping the real modal in use.
let mockDiscardConfirmHandler: (() => void) | undefined;
jest.mock('@canopy/ui-shared/components', () => {
  const real = jest.requireActual<typeof SharedComponents>(
    '@canopy/ui-shared/components',
  );
  return {
    ...real,
    ConfirmDialog: (
      props: Parameters<typeof real.ConfirmDialog>[0],
    ): JSX.Element => {
      if (props.dataTestId === 'file-discard-confirm')
        mockDiscardConfirmHandler = props.onConfirm;
      return <real.ConfirmDialog {...props} />;
    },
  };
});
jest.mock('@canopy/app-state', () => {
  const real: Record<string, unknown> = jest.requireActual('@canopy/app-state');
  return {
    __esModule: true,
    ...real,
    useFileViewerStore: <T,>(selector: (state: FileViewerState) => T): T =>
      selector(mockState),
  };
});

import { createFileViewerStore, fileViewerKey } from '@canopy/app-state';
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
import {
  REPLAY_BLOCK_CLASS,
  REPLAY_MASK_CLASS,
} from '@canopy/ui-shared/lib/replay-privacy';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const mockOpenFile = jest.fn<Promise<string>, [PortalFileReadPayload]>();
const mockReloadFromDisk = jest.fn<Promise<boolean>, [string]>();
const mockDismissExternalChange = jest.fn<void, [string]>();
const mockOverwriteWithEdits = jest.fn<Promise<boolean>, [string]>();
const mockSaveFile = jest.fn<Promise<boolean>, [string]>();
const mockChooseOverlapVersion = jest.fn<
  void,
  [string, string, number, 'ours' | 'theirs']
>();

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
    saveFile: mockSaveFile,
    discardEdits: (): void => {},
    setViewMode: (): void => {},
    closeFile: (): void => {},
    openDiff: (): Promise<string> => Promise.resolve(''),
    closeDiff: (): void => {},
    refreshFile: (): Promise<void> => Promise.resolve(),
    markFileChanged: (): void => {},
    reloadFromDisk: mockReloadFromDisk,
    dismissExternalChange: mockDismissExternalChange,
    overwriteWithEdits: mockOverwriteWithEdits,
    chooseOverlapVersion: mockChooseOverlapVersion,
    notifyFileChanged: (): void => {},
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
    canEdit: true,
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
      ...baseState(session({ path: 'src/a.ts', content: 'x', canEdit: false })),
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

  function mountInteractive(element: JSX.Element): {
    host: HTMLDivElement;
    unmount: () => void;
  } {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    act(() => {
      root.render(element);
    });
    return {
      host,
      unmount: (): void => {
        act(() => root.unmount());
        host.remove();
      },
    };
  }

  function segment(
    host: HTMLElement,
    testId: 'file-view-toggle-formatted' | 'file-view-toggle-source',
  ): HTMLButtonElement {
    const button = host.querySelector<HTMLButtonElement>(
      `[data-testid="${testId}"]`,
    );
    if (!button) throw new Error(`${testId} missing`);
    return button;
  }

  it('labels the markdown view selector and presses Formatted', () => {
    mockState = baseState(
      session({ path: 'docs/readme.md', content: '# Hi', viewMode: 'preview' }),
    );
    const { host, unmount } = mountInteractive(
      <FileViewer request={REQUEST} />,
    );
    try {
      const group = host.querySelector('[data-testid="file-view-toggle"]');
      expect(group?.getAttribute('role')).toBe('group');
      expect(group?.getAttribute('aria-label')).toBe('View');
      const formatted = segment(host, 'file-view-toggle-formatted');
      const source = segment(host, 'file-view-toggle-source');
      expect(formatted.textContent).toBe('Formatted');
      expect(source.textContent).toBe('Source');
      expect(formatted.getAttribute('aria-pressed')).toBe('true');
      expect(source.getAttribute('aria-pressed')).toBe('false');
      expect(
        host.querySelector('[data-testid="file-markdown-preview"]'),
      ).not.toBeNull();
    } finally {
      unmount();
    }
  });

  it('updates the shared session and the host once when Source is chosen', () => {
    const setViewMode = jest.fn();
    const onViewModeChange = jest.fn();
    mockState = {
      ...baseState(
        session({
          path: 'docs/readme.md',
          content: '# Hi',
          viewMode: 'preview',
        }),
      ),
      setViewMode,
    };
    const { host, unmount } = mountInteractive(
      <FileViewer request={REQUEST} onViewModeChange={onViewModeChange} />,
    );
    try {
      act(() => {
        segment(host, 'file-view-toggle-source').click();
      });
      expect(setViewMode).toHaveBeenCalledTimes(1);
      expect(setViewMode).toHaveBeenCalledWith(fileViewerKey(REQUEST), 'raw');
      expect(onViewModeChange).toHaveBeenCalledTimes(1);
      expect(onViewModeChange).toHaveBeenCalledWith('raw');
    } finally {
      unmount();
    }
  });

  it('keeps keyboard focus on the chosen segment when switching file views', () => {
    mockState = baseState(
      session({ path: 'docs/readme.md', content: '# Hi', viewMode: 'preview' }),
    );
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const renderMode = (viewMode: FileViewMode): void => {
      act(() =>
        root.render(<FileViewer request={REQUEST} viewMode={viewMode} />),
      );
    };
    try {
      renderMode('preview');
      const source = segment(host, 'file-view-toggle-source');
      source.focus();
      act(() => source.click());
      renderMode('raw');
      expect(document.activeElement).toBe(source);
      expect(source.getAttribute('aria-pressed')).toBe('true');

      const formatted = segment(host, 'file-view-toggle-formatted');
      formatted.focus();
      act(() => formatted.click());
      renderMode('preview');
      expect(document.activeElement).toBe(formatted);
      expect(formatted.getAttribute('aria-pressed')).toBe('true');
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });

  it('presses neither segment over alternate content and leaves it on choice', () => {
    const onViewModeChange = jest.fn();
    mockState = baseState(
      session({ path: 'docs/readme.md', content: '# Hi', viewMode: 'preview' }),
    );
    const { host, unmount } = mountInteractive(
      <FileViewer
        request={{ ...REQUEST, relativePath: 'docs/readme.md' }}
        alternateContent={<div data-testid="host-diff">Diff</div>}
        onViewModeChange={onViewModeChange}
      />,
    );
    try {
      const selectors = host.querySelectorAll(
        '[data-testid="file-view-toggle"]',
      );
      // The inert body keeps its own header; the visible one comes last.
      const header = Array.from(
        host.querySelectorAll('[data-testid="file-viewer-header"]'),
      ).at(-1);
      const formatted = header?.querySelector<HTMLButtonElement>(
        '[data-testid="file-view-toggle-formatted"]',
      );
      expect(selectors.length).toBeGreaterThan(0);
      expect(formatted?.getAttribute('aria-pressed')).toBe('false');
      expect(
        header
          ?.querySelector('[data-testid="file-view-toggle-source"]')
          ?.getAttribute('aria-pressed'),
      ).toBe('false');
      act(() => {
        formatted?.click();
      });
      expect(onViewModeChange).toHaveBeenCalledWith('preview');
    } finally {
      unmount();
    }
  });

  it('offers no view selector for a file without a rendered view', () => {
    mockState = baseState(
      session({ path: 'src/a.ts', content: 'const a = 1;' }),
    );
    expect(render()).not.toContain('data-testid="file-view-toggle"');
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

  it('presses Source in raw mode', () => {
    mockState = baseState(
      session({ path: 'docs/readme.md', content: '# Hi', viewMode: 'raw' }),
    );
    const { host, unmount } = mountInteractive(
      <FileViewer request={REQUEST} />,
    );
    try {
      expect(
        segment(host, 'file-view-toggle-source').getAttribute('aria-pressed'),
      ).toBe('true');
      expect(
        segment(host, 'file-view-toggle-formatted').getAttribute(
          'aria-pressed',
        ),
      ).toBe('false');
    } finally {
      unmount();
    }
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
    const table = mountInteractive(
      <FileViewer request={REQUEST} viewMode="table" />,
    );
    try {
      const formatted = segment(table.host, 'file-view-toggle-formatted');
      expect(formatted.textContent).toBe('Table');
      expect(formatted.getAttribute('aria-pressed')).toBe('true');
      expect(
        table.host.querySelector(
          '[data-testid="file-viewer-csv-table-scroll"]',
        ),
      ).not.toBeNull();
    } finally {
      table.unmount();
    }

    mockState = baseState(
      session({ path: 'data.csv', content: 'name,count\nalpha,2' }),
    );
    const raw = mountInteractive(
      <FileViewer request={REQUEST} viewMode="raw" />,
    );
    try {
      expect(
        segment(raw.host, 'file-view-toggle-source').getAttribute(
          'aria-pressed',
        ),
      ).toBe('true');
      expect(segment(raw.host, 'file-view-toggle-formatted').textContent).toBe(
        'Table',
      );
    } finally {
      raw.unmount();
    }
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

  it('plays video bytes in a native player without the host renderer (CAN-3995)', async () => {
    mockState = baseState(undefined);
    const createObjectURL = jest.fn<string, [Blob]>(() => 'blob:reel');
    const revokeObjectURL = jest.fn();
    const originalUrl = {
      createObjectURL: Object.getOwnPropertyDescriptor(URL, 'createObjectURL'),
      revokeObjectURL: Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL'),
    };
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    try {
      const renderRichDocument = jest.fn();
      const mounted = mountViewer(
        <FileViewer
          request={{ ...REQUEST, relativePath: 'out/reel.mp4' }}
          supportedDocumentKinds={['pdf', 'video']}
          resolveDocumentBytes={jest
            .fn()
            .mockResolvedValue({ status: 'ready', bytes: new ArrayBuffer(4) })}
          renderRichDocument={renderRichDocument}
        />,
      );
      await flushEffects();
      const video = mounted.container.querySelector(
        '[data-testid="file-viewer-video"]',
      );
      expect(video?.getAttribute('src')).toBe('blob:reel');
      expect(createObjectURL.mock.calls[0]?.[0]).toMatchObject({
        type: 'video/mp4',
      });
      expect(video?.hasAttribute('controls')).toBe(true);
      expect(renderRichDocument).not.toHaveBeenCalled();
      expect(mockOpenFile).not.toHaveBeenCalled();

      // A decode error after data loaded keeps the native player.
      if (video === null) throw new Error('Expected the video element');
      Object.defineProperty(video, 'readyState', {
        configurable: true,
        value: HTMLMediaElement.HAVE_ENOUGH_DATA,
      });
      act(() => {
        video.dispatchEvent(new Event('error'));
      });
      expect(
        mounted.container.querySelector('[data-testid="file-viewer-video"]'),
      ).not.toBeNull();

      Object.defineProperty(video, 'readyState', {
        configurable: true,
        value: HTMLMediaElement.HAVE_NOTHING,
      });
      act(() => {
        video.dispatchEvent(new Event('error'));
      });
      const error = mounted.container.querySelector(
        '[data-testid="file-viewer-document-error"]',
      );
      expect(error?.getAttribute('data-error-kind')).toBe('parse-failed');
      expect(error?.textContent).toContain('Video preview unavailable');
      expect(error?.textContent).toContain(
        "reel.mp4 can't be played in the app.",
      );
      expect(revokeObjectURL).not.toHaveBeenCalled();
      mounted.unmount();
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:reel');
    } finally {
      for (const [name, descriptor] of Object.entries(originalUrl)) {
        if (descriptor) Object.defineProperty(URL, name, descriptor);
        else Reflect.deleteProperty(URL, name);
      }
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
    // Host and comparison reveals share one per-viewer revision sequence.
    const passed = renderEditor.mock.lastCall?.[0].reveal;
    expect(passed).toMatchObject({ line: 4, lineEnd: 6 });
    expect(typeof passed?.revision).toBe('number');
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

describe('FileViewer external change notice', () => {
  const editor = (): JSX.Element => <div data-testid="host-editor" />;

  beforeEach(() => {
    mockOpenFile.mockReset();
    mockOpenFile.mockResolvedValue(fileViewerKey(REQUEST));
    mockReloadFromDisk.mockReset();
    mockReloadFromDisk.mockResolvedValue(true);
    mockDismissExternalChange.mockReset();
  });

  it('offers Show latest and Keep my edits in a polite status region', () => {
    mockState = baseState(
      session({
        path: 'src/a.ts',
        content: 'mine',
        dirty: true,
        externalChange: { reloading: false, error: null },
      }),
    );
    const viewer = mountViewer(
      <FileViewer request={REQUEST} renderEditor={editor} />,
    );

    const notice = viewer.container.querySelector(
      '[data-testid="file-external-change-notice"]',
    );
    expect(notice?.getAttribute('role')).toBe('status');
    expect(notice?.getAttribute('aria-live')).toBe('polite');
    expect(notice?.textContent).toContain('Document updated');
    expect(notice?.textContent).toContain(
      "This document changed while you have unsaved edits, and the changes can't be combined automatically. Show latest replaces your edits. Keep my edits keeps them.",
    );
    const keep = viewer.container.querySelector<HTMLButtonElement>(
      '[data-testid="file-external-change-keep"]',
    );
    const showLatest = viewer.container.querySelector<HTMLButtonElement>(
      '[data-testid="file-external-change-show-latest"]',
    );
    expect(keep?.tagName).toBe('BUTTON');
    expect(keep?.textContent).toBe('Keep my edits');
    expect(showLatest?.textContent).toBe('Show latest');
    expect(showLatest?.disabled).toBe(false);
    viewer.unmount();
  });

  it.each(['idle', 'saving'] as const)(
    'keeps focus in the viewer when Keep my edits removes the notice while %s',
    (status) => {
      mockState = baseState(
        session({
          path: 'src/a.ts',
          content: 'mine',
          dirty: true,
          status,
          externalChange: { reloading: false, error: null },
        }),
      );
      const viewer = mountViewer(
        <FileViewer request={REQUEST} renderEditor={editor} />,
      );
      const keep = viewer.container.querySelector<HTMLButtonElement>(
        '[data-testid="file-external-change-keep"]',
      );
      keep?.focus();

      act(() => keep?.click());

      expect(mockDismissExternalChange).toHaveBeenCalledWith(
        fileViewerKey(REQUEST),
      );
      expect(document.activeElement?.getAttribute('data-testid')).toBe(
        status === 'saving' ? 'file-viewer-header' : 'file-save',
      );
      viewer.unmount();
    },
  );

  it('requests the disk version and focuses the header after Show latest', async () => {
    mockState = baseState(
      session({
        path: 'src/a.ts',
        content: 'mine',
        dirty: true,
        externalChange: { reloading: false, error: null },
      }),
    );
    const viewer = mountViewer(
      <FileViewer request={REQUEST} renderEditor={editor} />,
    );

    const button = viewer.container.querySelector<HTMLButtonElement>(
      '[data-testid="file-external-change-show-latest"]',
    );
    button?.focus();
    act(() => button?.click());
    await flushEffects();

    expect(mockReloadFromDisk).toHaveBeenCalledWith(fileViewerKey(REQUEST));
    expect(document.activeElement?.getAttribute('data-testid')).toBe(
      'file-viewer-header',
    );
    viewer.unmount();
  });

  it('does not steal focus when the user moves elsewhere during Show latest', async () => {
    let resolve: (value: boolean) => void = () => {};
    mockReloadFromDisk.mockReturnValue(
      new Promise<boolean>((done) => {
        resolve = done;
      }),
    );
    mockState = baseState(
      session({
        path: 'src/a.ts',
        content: 'mine',
        dirty: true,
        externalChange: { reloading: false, error: null },
      }),
    );
    const viewer = mountViewer(
      <FileViewer request={REQUEST} renderEditor={editor} />,
    );
    const button = viewer.container.querySelector<HTMLButtonElement>(
      '[data-testid="file-external-change-show-latest"]',
    );
    button?.focus();
    act(() => button?.click());
    const elsewhere = document.createElement('button');
    document.body.append(elsewhere);
    elsewhere.focus();
    await act(async () => {
      resolve(true);
      await Promise.resolve();
    });
    expect(document.activeElement).toBe(elsewhere);
    elsewhere.remove();
    viewer.unmount();
  });

  it('disables Show latest while saving or reloading and shows a retryable error', () => {
    mockState = baseState(
      session({
        path: 'src/a.ts',
        content: 'mine',
        dirty: true,
        status: 'saving',
        externalChange: { reloading: false, error: 'File not found: a.ts' },
      }),
    );
    const out = renderToString(
      <FileViewer request={REQUEST} renderEditor={editor} />,
    );
    const host = document.createElement('div');
    host.innerHTML = out;
    expect(
      host.querySelector<HTMLButtonElement>(
        '[data-testid="file-external-change-show-latest"]',
      )?.disabled,
    ).toBe(true);
    expect(out).toContain(
      'Couldn&#x27;t load the latest version. File not found: a.ts',
    );
  });

  it('keeps recovery visible after undo makes an externally changed session clean', () => {
    mockState = baseState(
      session({
        path: 'src/a.ts',
        content: 'same',
        externalChange: { reloading: false, error: null },
      }),
    );
    const viewer = mountViewer(
      <FileViewer request={REQUEST} renderEditor={editor} />,
    );
    expect(
      viewer.container.querySelector(
        '[data-testid="file-external-change-notice"]',
      )?.textContent,
    ).toContain(
      'This document changed. Show latest loads the current version.',
    );
    expect(
      viewer.container.querySelector(
        '[data-testid="file-external-change-keep"]',
      ),
    ).toBeNull();
    const showLatest = viewer.container.querySelector<HTMLButtonElement>(
      '[data-testid="file-external-change-show-latest"]',
    );
    act(() => showLatest?.click());
    expect(mockReloadFromDisk).toHaveBeenCalledWith(fileViewerKey(REQUEST));
    viewer.unmount();
  });

  it('offers a retry after a stale Discard fails to load the disk version', () => {
    mockState = baseState(
      session({
        path: 'src/a.ts',
        content: 'baseline',
        baselineStale: true,
        externalChange: { reloading: false, error: 'File not found: a.ts' },
      }),
    );
    const viewer = mountViewer(
      <FileViewer request={REQUEST} renderEditor={editor} />,
    );
    expect(
      viewer.container.querySelector(
        '[data-testid="file-external-change-notice"]',
      )?.textContent,
    ).toContain("Couldn't load the latest version. File not found: a.ts");
    expect(
      viewer.container.querySelector('[data-testid="file-discard"]'),
    ).toBeNull();
    const showLatest = viewer.container.querySelector<HTMLButtonElement>(
      '[data-testid="file-external-change-show-latest"]',
    );
    expect(showLatest?.disabled).toBe(false);
    act(() => showLatest?.click());
    expect(mockReloadFromDisk).toHaveBeenCalledWith(fileViewerKey(REQUEST));
    viewer.unmount();
  });

  it('names the edits Discard loses while the baseline is stale', () => {
    const discardLabel = (overrides: Partial<FileViewerSession>): string => {
      mockState = baseState(
        session({
          path: 'src/a.ts',
          content: 'mine',
          dirty: true,
          ...overrides,
        }),
      );
      const host = document.createElement('div');
      host.innerHTML = renderToString(
        <FileViewer request={REQUEST} renderEditor={editor} />,
      );
      return (
        host.querySelector('[data-testid="file-discard"]')?.textContent ?? ''
      );
    };

    // Keep my edits dismissed the notice; the baseline is still stale.
    expect(discardLabel({ baselineStale: true, externalChange: null })).toBe(
      'Discard my edits',
    );
    expect(discardLabel({})).toBe('Discard');
    expect(discardLabel({ baselineStale: false })).toBe('Discard');

    mockState = baseState(
      session({
        path: 'src/a.ts',
        content: 'mine',
        dirty: true,
        baselineStale: true,
        canEdit: false,
      }),
    );
    expect(
      renderToString(<FileViewer request={REQUEST} renderEditor={editor} />),
    ).not.toContain('data-testid="file-discard"');
  });

  it('lets the header status text give way before its actions', () => {
    mockState = baseState(
      session({
        path: 'src/a.ts',
        content: 'mine',
        dirty: true,
        baselineStale: true,
        status: 'error',
        error: 'File changed on disk since it was loaded.',
      }),
    );
    const host = document.createElement('div');
    host.innerHTML = renderToString(
      <FileViewer request={REQUEST} renderEditor={editor} />,
    );
    const status = host.querySelector<HTMLElement>(
      '[title="File changed on disk since it was loaded."]',
    );
    expect(status?.classList.contains('truncate')).toBe(true);
    expect(
      host
        .querySelector('[data-testid="file-discard"]')
        ?.classList.contains('shrink-0'),
    ).toBe(true);
  });

  it('disables Discard while a save is in flight', () => {
    mockState = baseState(
      session({
        path: 'src/a.ts',
        content: 'mine',
        dirty: true,
        status: 'saving',
      }),
    );
    const host = document.createElement('div');
    host.innerHTML = renderToString(
      <FileViewer request={REQUEST} renderEditor={editor} />,
    );
    expect(
      host.querySelector<HTMLButtonElement>('[data-testid="file-discard"]')
        ?.disabled,
    ).toBe(true);
  });

  it('shows the notice over alternate content', () => {
    mockState = baseState(
      session({
        path: 'src/a.ts',
        content: 'mine',
        dirty: true,
        externalChange: { reloading: false, error: null },
      }),
    );
    const out = renderToString(
      <FileViewer
        request={REQUEST}
        renderEditor={editor}
        alternateContent={<div data-testid="host-diff">Diff</div>}
      />,
    );
    expect(out.match(/file-external-change-notice/g)).toHaveLength(1);
  });
});

describe('FileViewer discard confirmation (CAN-5365)', () => {
  const mockDiscardEdits = jest.fn<void, [string]>();
  const editor = (): JSX.Element => <textarea data-testid="host-editor" />;
  const OTHER_REQUEST: PortalFileReadPayload = {
    ...REQUEST,
    relativePath: 'src/b.ts',
  };

  beforeEach(() => {
    mockOpenFile.mockReset();
    mockOpenFile.mockResolvedValue(fileViewerKey(REQUEST));
    mockDiscardEdits.mockReset();
    mockDiscardConfirmHandler = undefined;
  });

  const dirty = (
    overrides: Partial<FileViewerSession> = {},
  ): FileViewerSession =>
    session({ path: 'src/a.ts', content: 'mine', dirty: true, ...overrides });
  const withSession = (next: FileViewerSession): void => {
    mockState = { ...baseState(next), discardEdits: mockDiscardEdits };
  };
  const byTestId = <T extends HTMLElement = HTMLElement>(
    testId: string,
  ): T | null => document.body.querySelector<T>(`[data-testid="${testId}"]`);
  const dialog = (): HTMLElement | null => byTestId('file-discard-confirm');
  const openConfirm = (): HTMLButtonElement | null => {
    const trigger = byTestId<HTMLButtonElement>('file-discard');
    trigger?.focus();
    act(() => trigger?.click());
    return trigger;
  };
  const viewerFor = (request: PortalFileReadPayload = REQUEST): JSX.Element => (
    <FileViewer request={request} renderEditor={editor} />
  );
  const overlap: FileOverlapComparison = {
    generation: 0,
    token: 'token-1',
    base: {
      workspaceLocalId: 'w',
      worktreeLocalId: 'wt',
      path: 'src/a.ts',
      content: 'base\n',
      size: 5,
      version: 'v1',
      truncated: false,
    },
    ours: 'mine\n',
    latest: {
      workspaceLocalId: 'w',
      worktreeLocalId: 'wt',
      path: 'src/a.ts',
      content: 'theirs\n',
      size: 7,
      version: 'v2',
      truncated: false,
    },
    regions: [
      {
        index: 0,
        base: 'base\n',
        ours: 'mine\n',
        theirs: 'theirs\n',
        baseLines: { line: 1, lineCount: 1 },
        oursLines: { line: 1, lineCount: 1 },
        theirsLines: { line: 1, lineCount: 1 },
      },
    ],
    choices: [null],
  };

  it.each([
    [
      'the combinable notice is open',
      {
        baselineStale: true,
        combinableChange: { version: 'v2', source: 'agent-edit' },
      },
      'file-combinable-change-notice',
    ],
    [
      'the overlap notice is open',
      {
        baselineStale: true,
        externalChange: { reloading: false, error: null },
        overlap,
      },
      'file-overlap-notice',
    ],
    ['the notice was dismissed', { baselineStale: true }, null],
  ] as const)(
    'asks before a stale Discard my edits while %s',
    (_case, overrides, noticeTestId) => {
      withSession(dirty(overrides));
      const viewer = mountViewer(viewerFor());
      if (noticeTestId) expect(byTestId(noticeTestId)).not.toBeNull();
      expect(byTestId('file-discard')?.textContent).toBe('Discard my edits');

      openConfirm();

      expect(mockDiscardEdits).not.toHaveBeenCalled();
      expect(dialog()?.getAttribute('role')).toBe('dialog');
      expect(dialog()?.textContent).toContain('Discard your edits to “a.ts”?');
      expect(dialog()?.textContent).toContain(
        'Discarding loses the edits you haven’t saved and shows the latest version of the document.',
      );
      expect(
        dialog()?.querySelector(`.${REPLAY_MASK_CLASS}`)?.textContent,
      ).toBe('a.ts');
      viewer.unmount();
    },
  );

  it('asks before an ordinary Discard with the current-baseline sentence', () => {
    withSession(dirty());
    const viewer = mountViewer(viewerFor());
    expect(byTestId('file-discard')?.textContent).toBe('Discard');

    openConfirm();

    expect(mockDiscardEdits).not.toHaveBeenCalled();
    const text = dialog()?.textContent ?? '';
    expect(text).toContain('Discarding loses the edits you haven’t saved.');
    expect(text).not.toContain('latest version');
    expect(byTestId('file-discard-confirm-accept')?.textContent).toBe(
      'Discard edits',
    );
    viewer.unmount();
  });

  it('starts on Cancel, and Cancel, Escape and Enter there keep the edits', () => {
    withSession(dirty({ baselineStale: true }));
    const viewer = mountViewer(viewerFor());

    const trigger = openConfirm();
    const cancel = byTestId<HTMLButtonElement>('file-discard-confirm-cancel');
    expect(document.activeElement).toBe(cancel);
    act(() => {
      cancel?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
    });
    expect(dialog()).not.toBeNull();
    act(() => cancel?.click());
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(trigger);

    openConfirm();
    act(() => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(mockDiscardEdits).not.toHaveBeenCalled();
    expect(byTestId('file-viewer-dirty')).not.toBeNull();
    viewer.unmount();
  });

  it('discards the named file once and leaves focus on the header', () => {
    withSession(dirty({ baselineStale: true }));
    const viewer = mountViewer(viewerFor());

    openConfirm();
    act(() => byTestId('file-discard-confirm-accept')?.click());

    expect(mockDiscardEdits).toHaveBeenCalledTimes(1);
    expect(mockDiscardEdits).toHaveBeenCalledWith(fileViewerKey(REQUEST));
    expect(dialog()).toBeNull();
    // The store's discard leaves the buffer clean, removing the trigger.
    withSession(dirty({ dirty: false }));
    act(() => {
      void viewer.render(viewerFor());
    });
    expect(byTestId('file-discard')).toBeNull();
    expect(document.activeElement?.getAttribute('data-testid')).toBe(
      'file-viewer-header',
    );
    viewer.unmount();
  });

  it('confirms from the alternate header and returns focus there', () => {
    withSession(dirty());
    const viewer = mountViewer(
      <FileViewer
        request={REQUEST}
        renderEditor={editor}
        alternateContent={<div data-testid="host-diff">Diff</div>}
      />,
    );

    openConfirm();
    act(() => byTestId('file-discard-confirm-accept')?.click());

    expect(mockDiscardEdits).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(
      viewer.container.querySelector(
        '[data-testid="file-viewer-header"]:not([inert] *)',
      ),
    );
    viewer.unmount();
  });

  it.each([
    ['the buffer becomes clean', { dirty: false }],
    ['editing is no longer allowed', { canEdit: false }],
  ] as const)('closes when %s and never returns', (_case, overrides) => {
    withSession(dirty());
    const viewer = mountViewer(viewerFor());
    openConfirm();
    expect(dialog()).not.toBeNull();

    withSession(dirty(overrides));
    act(() => {
      void viewer.render(viewerFor());
    });
    expect(dialog()).toBeNull();

    withSession(dirty());
    act(() => {
      void viewer.render(viewerFor());
    });
    expect(dialog()).toBeNull();
    expect(mockDiscardEdits).not.toHaveBeenCalled();
    viewer.unmount();
  });

  it('closes when the session goes missing', () => {
    withSession(dirty());
    const viewer = mountViewer(viewerFor());
    openConfirm();

    mockState = { ...baseState(undefined), discardEdits: mockDiscardEdits };
    act(() => {
      void viewer.render(viewerFor());
    });
    expect(dialog()).toBeNull();
    viewer.unmount();
  });

  it('never carries a confirmation over to another dirty file', () => {
    withSession(dirty());
    const viewer = mountViewer(viewerFor());
    openConfirm();

    const otherKey = fileViewerKey(OTHER_REQUEST);
    mockState = {
      ...baseState(undefined),
      files: {
        [otherKey]: {
          ...dirty(),
          key: otherKey,
          request: OTHER_REQUEST,
        },
      },
      activeFileKey: otherKey,
      discardEdits: mockDiscardEdits,
    };
    act(() => {
      void viewer.render(viewerFor(OTHER_REQUEST));
    });
    expect(dialog()).toBeNull();
    expect(byTestId('file-discard')).not.toBeNull();
    expect(mockDiscardEdits).not.toHaveBeenCalled();
    viewer.unmount();
  });

  it('never carries a confirmation over to a reopened incarnation', () => {
    withSession(dirty());
    const viewer = mountViewer(viewerFor());
    openConfirm();

    withSession(dirty({ generation: 1 }));
    act(() => {
      void viewer.render(viewerFor());
    });
    expect(dialog()).toBeNull();
    viewer.unmount();
  });

  it('cannot discard once a save begins', () => {
    withSession(dirty());
    const viewer = mountViewer(viewerFor());
    openConfirm();

    withSession(dirty({ status: 'saving' }));
    act(() => {
      void viewer.render(viewerFor());
    });
    const accept = byTestId<HTMLButtonElement>('file-discard-confirm-accept');
    expect(accept?.disabled).toBe(true);
    act(() => accept?.click());
    expect(mockDiscardEdits).not.toHaveBeenCalled();
    expect(mockDiscardConfirmHandler).toBeDefined();
    act(() => mockDiscardConfirmHandler?.());
    expect(mockDiscardEdits).not.toHaveBeenCalled();
    expect(dialog()).toBeNull();
    viewer.unmount();
  });

  it('updates the consequence when the file goes stale while open', () => {
    withSession(dirty());
    const viewer = mountViewer(viewerFor());
    openConfirm();
    expect(dialog()?.textContent).not.toContain('latest version');

    withSession(dirty({ baselineStale: true }));
    act(() => {
      void viewer.render(viewerFor());
    });
    expect(dialog()?.textContent).toContain(
      'Discarding loses the edits you haven’t saved and shows the latest version of the document.',
    );
    act(() => byTestId('file-discard-confirm-accept')?.click());
    expect(mockDiscardEdits).toHaveBeenCalledTimes(1);
    viewer.unmount();
  });
});

describe('FileViewer reload announcement', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockOpenFile.mockReset();
    mockOpenFile.mockResolvedValue(fileViewerKey(REQUEST));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const announcement = (container: HTMLElement): string =>
    container.querySelector('[data-testid="file-reload-announcement"]')
      ?.textContent ?? '';

  it('announces stale recovery only after retry succeeds, staying silent while pending or failed', async () => {
    const recovering = session({
      path: 'src/a.ts',
      content: 'six',
      baselineStale: true,
      externalChange: { reloading: true, error: null },
      reloadRevision: 2,
    });
    mockState = baseState(recovering);
    const viewer = mountViewer(<FileViewer request={REQUEST} />);
    act(() => jest.advanceTimersByTime(500));
    expect(announcement(viewer.container)).toBe('');
    expect(
      viewer.container.querySelector<HTMLButtonElement>(
        '[data-testid="file-external-change-show-latest"]',
      )?.disabled,
    ).toBe(true);

    mockState = baseState({
      ...recovering,
      externalChange: { reloading: false, error: 'offline' },
    });
    await viewer.render(<FileViewer request={REQUEST} />);
    act(() => jest.advanceTimersByTime(500));
    expect(announcement(viewer.container)).toBe('');
    const retry = viewer.container.querySelector<HTMLButtonElement>(
      '[data-testid="file-external-change-show-latest"]',
    );
    expect(retry?.disabled).toBe(false);
    act(() => retry?.click());
    expect(mockReloadFromDisk).toHaveBeenCalledWith(fileViewerKey(REQUEST));

    mockState = baseState({
      ...recovering,
      content: 'nine',
      baselineStale: false,
      externalChange: null,
      reloadRevision: (recovering.reloadRevision ?? 0) + 1,
    });
    await viewer.render(<FileViewer request={REQUEST} />);
    act(() => jest.advanceTimersByTime(500));
    expect(announcement(viewer.container)).toBe(
      'Document updated to the latest version.',
    );
    viewer.unmount();
  });

  it('suppresses background reloads and does not announce them on activation', async () => {
    mockState = baseState(
      session({ path: 'src/a.ts', content: 'six', reloadRevision: 0 }),
    );
    const viewer = mountViewer(<FileViewer request={REQUEST} active={false} />);
    mockState = baseState(
      session({ path: 'src/a.ts', content: 'eight', reloadRevision: 1 }),
    );
    await viewer.render(<FileViewer request={REQUEST} active={false} />);
    act(() => jest.advanceTimersByTime(500));
    expect(announcement(viewer.container)).toBe('');
    await viewer.render(<FileViewer request={REQUEST} active />);
    act(() => jest.advanceTimersByTime(500));
    expect(announcement(viewer.container)).toBe('');
    viewer.unmount();
  });

  it('announces reloads in the visible alternate presentation', async () => {
    mockState = baseState(
      session({ path: 'src/a.ts', content: 'six', reloadRevision: 0 }),
    );
    const viewer = mountViewer(
      <FileViewer request={REQUEST} alternateContent={<div>Diff</div>} />,
    );
    mockState = baseState(
      session({ path: 'src/a.ts', content: 'eight', reloadRevision: 1 }),
    );
    await viewer.render(
      <FileViewer request={REQUEST} alternateContent={<div>Diff</div>} />,
    );
    act(() => jest.advanceTimersByTime(500));
    expect(announcement(viewer.container)).toBe(
      'Document updated to the latest version.',
    );
    viewer.unmount();
  });

  it('stays silent on mount and announces each changed reload', async () => {
    mockState = baseState(
      session({ path: 'src/a.ts', content: 'six', reloadRevision: 0 }),
    );
    const viewer = mountViewer(<FileViewer request={REQUEST} />);
    act(() => jest.advanceTimersByTime(500));
    expect(announcement(viewer.container)).toBe('');

    mockState = baseState(
      session({ path: 'src/a.ts', content: 'eight', reloadRevision: 1 }),
    );
    await viewer.render(<FileViewer request={REQUEST} />);
    act(() => jest.advanceTimersByTime(500));
    expect(announcement(viewer.container)).toBe(
      'Document updated to the latest version.',
    );

    mockState = baseState(
      session({ path: 'src/a.ts', content: 'eight more', reloadRevision: 2 }),
    );
    await viewer.render(<FileViewer request={REQUEST} />);
    act(() => jest.advanceTimersByTime(0));
    expect(announcement(viewer.container)).toBe('');
    act(() => jest.advanceTimersByTime(500));
    expect(announcement(viewer.container)).toBe(
      'Document updated to the latest version.',
    );
    viewer.unmount();
  });
});

describe('FileViewer save conflict notice', () => {
  const editor = (): JSX.Element => (
    <textarea data-testid="host-editor" defaultValue="mine" />
  );
  const conflict = (
    overrides: Partial<NonNullable<FileViewerSession['saveConflict']>> = {},
  ): NonNullable<FileViewerSession['saveConflict']> => ({
    reason: 'overlap',
    source: 'agent-edit',
    origin: 'user',
    latest: null,
    resolving: null,
    error: null,
    focusRequest: 1,
    ...overrides,
  });
  const conflicted = (
    overrides: Partial<NonNullable<FileViewerSession['saveConflict']>> = {},
    sessionOverrides: Partial<FileViewerSession> = {},
  ): FileViewerSession =>
    session({
      path: 'notes.md',
      content: 'mine',
      dirty: true,
      saveConflict: conflict(overrides),
      externalChange: { reloading: false, error: null },
      ...sessionOverrides,
    });
  const notice = (container: HTMLElement): HTMLElement | null =>
    container.querySelector('[data-testid="file-save-conflict-notice"]');
  const button = (
    container: HTMLElement,
    id: 'show-latest' | 'save-mine',
  ): HTMLButtonElement | null =>
    container.querySelector(`[data-testid="file-save-conflict-${id}"]`);

  beforeEach(() => {
    mockOpenFile.mockReset();
    mockOpenFile.mockResolvedValue(fileViewerKey(REQUEST));
    mockReloadFromDisk.mockReset();
    mockReloadFromDisk.mockResolvedValue(true);
    mockOverwriteWithEdits.mockReset();
    mockOverwriteWithEdits.mockResolvedValue(true);
    mockSaveFile.mockReset();
    mockSaveFile.mockResolvedValue(false);
  });

  it('announces branded recovery choices and hides the external-change notice', () => {
    mockState = baseState(conflicted());
    const viewer = mountViewer(
      <FileViewer request={REQUEST} renderEditor={editor} appName="Canopy" />,
    );

    const alert = notice(viewer.container);
    expect(alert?.getAttribute('role')).toBe('alert');
    expect(alert?.textContent).toContain('Not saved');
    expect(alert?.textContent).toContain(
      "Canopy changed this document after you started editing. The changes overlap, so they couldn't be combined automatically. Show Canopy's version replaces your unsaved edits. Save my version replaces the newer version.",
    );
    expect(alert?.textContent).not.toMatch(/on disk|loaded/);
    const actions = Array.from(
      alert?.querySelectorAll('button') ?? [],
      (node) => node.textContent,
    );
    expect(actions).toEqual(["Show Canopy's version", 'Save my version']);
    expect(
      viewer.container.querySelector(
        '[data-testid="file-external-change-notice"]',
      ),
    ).toBeNull();
    viewer.unmount();
  });

  it('uses neutral copy for unknown sources and missing branding', () => {
    mockState = baseState(conflicted({ source: null }));
    const unknown = mountViewer(
      <FileViewer request={REQUEST} renderEditor={editor} appName="Canopy" />,
    );
    expect(notice(unknown.container)?.textContent).toContain(
      'This document changed after you started editing.',
    );
    expect(button(unknown.container, 'show-latest')?.textContent).toBe(
      'Show latest version',
    );
    unknown.unmount();

    mockState = baseState(conflicted());
    const unbranded = mountViewer(
      <FileViewer request={REQUEST} renderEditor={editor} />,
    );
    expect(button(unbranded.container, 'show-latest')?.textContent).toBe(
      'Show latest version',
    );
    unbranded.unmount();
  });

  it.each([
    ['merge-skipped', "These changes couldn't be combined automatically."],
    [
      'read-unavailable',
      "Couldn't get the latest version. Try Show latest version again.",
    ],
    [
      'changed-again',
      'The document changed again. Review the choices and try again.',
    ],
    ['newer-edits', 'You have newer unsaved edits. Choose how to continue.'],
  ] as const)('explains the %s reason', (reason, copy) => {
    mockState = baseState(conflicted({ reason, source: null }));
    const viewer = mountViewer(
      <FileViewer request={REQUEST} renderEditor={editor} />,
    );
    expect(notice(viewer.container)?.textContent).toContain(copy);
    expect(notice(viewer.container)?.textContent).not.toContain('overlap');
    viewer.unmount();
  });

  it('maps action errors to recovery copy', () => {
    mockState = baseState(
      conflicted({ error: { kind: 'save-failed', message: 'Disk full.' } }),
    );
    const viewer = mountViewer(
      <FileViewer request={REQUEST} renderEditor={editor} appName="Canopy" />,
    );
    expect(notice(viewer.container)?.textContent).toContain(
      "Couldn't save your version. Disk full.",
    );
    mockState = baseState(
      conflicted({ error: { kind: 'latest-unavailable' } }),
    );
    void viewer.render(
      <FileViewer request={REQUEST} renderEditor={editor} appName="Canopy" />,
    );
    expect(notice(viewer.container)?.textContent).toContain(
      "Couldn't get the latest version. Try Show Canopy's version again.",
    );
    viewer.unmount();
  });

  it('focuses the first action once per explicit save request', async () => {
    mockState = baseState(
      session({ path: 'notes.md', content: 'mine', dirty: true }),
    );
    const viewer = mountViewer(
      <FileViewer request={REQUEST} renderEditor={editor} />,
    );
    const textarea = viewer.container.querySelector<HTMLTextAreaElement>(
      '[data-testid="host-editor"]',
    );
    textarea?.focus();

    // An autosave conflict appears without taking focus.
    mockState = baseState(conflicted({ origin: 'autosave', focusRequest: 0 }));
    await viewer.render(<FileViewer request={REQUEST} renderEditor={editor} />);
    expect(document.activeElement).toBe(textarea);

    // An explicit save on the existing notice focuses its first action.
    mockState = baseState(conflicted({ origin: 'autosave', focusRequest: 1 }));
    await viewer.render(<FileViewer request={REQUEST} renderEditor={editor} />);
    expect(document.activeElement).toBe(
      button(viewer.container, 'show-latest'),
    );

    // Typing (a re-render with the same request) never refocuses.
    textarea?.focus();
    mockState = baseState(
      conflicted({ origin: 'autosave', focusRequest: 1 }, { content: 'mine!' }),
    );
    await viewer.render(<FileViewer request={REQUEST} renderEditor={editor} />);
    expect(document.activeElement).toBe(textarea);

    // Switching presentations does not replay the handled request.
    await viewer.render(
      <FileViewer
        request={REQUEST}
        renderEditor={editor}
        alternateContent={<div>Diff</div>}
      />,
    );
    expect(document.activeElement).not.toBe(
      button(viewer.container, 'show-latest'),
    );
    viewer.unmount();
  });

  it('runs the recovery actions and restores focus after resolution', async () => {
    mockState = baseState(conflicted());
    const viewer = mountViewer(
      <FileViewer request={REQUEST} renderEditor={editor} />,
    );
    const saveMine = button(viewer.container, 'save-mine');
    saveMine?.focus();
    act(() => saveMine?.click());
    expect(mockOverwriteWithEdits).toHaveBeenCalledWith(fileViewerKey(REQUEST));

    mockState = baseState(session({ path: 'notes.md', content: 'mine' }));
    await viewer.render(<FileViewer request={REQUEST} renderEditor={editor} />);
    await flushEffects();
    expect(document.activeElement?.getAttribute('data-testid')).toBe(
      'file-viewer-header',
    );

    mockState = baseState(conflicted());
    await viewer.render(<FileViewer request={REQUEST} renderEditor={editor} />);
    act(() => button(viewer.container, 'show-latest')?.click());
    expect(mockReloadFromDisk).toHaveBeenCalledWith(fileViewerKey(REQUEST));
    viewer.unmount();
  });

  it('disables both actions while a recovery action runs', () => {
    mockState = baseState(conflicted({ resolving: 'overwrite' }));
    const viewer = mountViewer(
      <FileViewer request={REQUEST} renderEditor={editor} />,
    );
    expect(button(viewer.container, 'show-latest')?.disabled).toBe(true);
    expect(button(viewer.container, 'save-mine')?.disabled).toBe(true);
    viewer.unmount();
  });

  it('waits for an enabled recovery action before consuming an explicit focus request', async () => {
    mockState = baseState(conflicted({ resolving: 'reload', focusRequest: 2 }));
    const viewer = mountViewer(
      <FileViewer request={REQUEST} renderEditor={editor} />,
    );
    mockState = baseState(conflicted({ focusRequest: 2 }));
    await viewer.render(<FileViewer request={REQUEST} renderEditor={editor} />);
    expect(document.activeElement).toBe(
      button(viewer.container, 'show-latest'),
    );
    viewer.unmount();
  });

  it('shows exactly one notice over alternate content', () => {
    mockState = baseState(conflicted());
    const out = renderToString(
      <FileViewer
        request={REQUEST}
        renderEditor={editor}
        alternateContent={<div data-testid="host-diff">Diff</div>}
      />,
    );
    expect(out.match(/data-testid="file-save-conflict-notice"/g)).toHaveLength(
      1,
    );
  });

  it('announces generic save errors as alerts', () => {
    mockState = baseState(
      session({
        path: 'notes.md',
        content: 'mine',
        dirty: true,
        status: 'error',
        error: 'Permission denied',
      }),
    );
    const viewer = mountViewer(
      <FileViewer request={REQUEST} renderEditor={editor} />,
    );
    const alert = Array.from(
      viewer.container.querySelectorAll('[role="alert"]'),
    ).find((node) => node.textContent === 'Permission denied');
    expect(alert).toBeDefined();
    viewer.unmount();
  });
});

describe('FileViewer combined save announcement', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockOpenFile.mockReset();
    mockOpenFile.mockResolvedValue(fileViewerKey(REQUEST));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const announcement = (container: HTMLElement): string =>
    container.querySelector('[data-testid="file-reload-announcement"]')
      ?.textContent ?? '';

  it.each([
    [
      'agent-edit',
      'Canopy',
      "Saved. Your edits and Canopy's changes were combined.",
    ],
    [null, 'Canopy', 'Saved. Your edits and the newer changes were combined.'],
    [
      'agent-edit',
      undefined,
      'Saved. Your edits and the newer changes were combined.',
    ],
  ] as const)(
    'announces only the combined outcome (%s, %s)',
    async (source, appName, copy) => {
      mockState = baseState(session({ path: 'notes.md', content: 'six' }));
      const viewer = mountViewer(
        <FileViewer request={REQUEST} appName={appName} />,
      );
      mockState = baseState(
        session({
          path: 'notes.md',
          content: 'eight',
          savedMerge: { revision: 1, source },
        }),
      );
      await viewer.render(<FileViewer request={REQUEST} appName={appName} />);
      act(() => jest.advanceTimersByTime(500));
      expect(announcement(viewer.container)).toBe(copy);
      viewer.unmount();
    },
  );
});

describe('FileViewer combinable change notice', () => {
  beforeEach(() => {
    mockOpenFile.mockReset();
    mockOpenFile.mockResolvedValue(fileViewerKey(REQUEST));
  });

  const pending = (
    overrides: Partial<FileViewerSession> = {},
  ): FileViewerSession => ({
    ...session({ path: 'notes.md', content: 'one' }),
    content: 'ONE',
    dirty: true,
    baselineStale: true,
    combinableChange: { version: 'v2', source: 'agent-edit' },
    ...overrides,
  });
  const notices = (container: HTMLElement): HTMLElement[] =>
    Array.from(
      container.querySelectorAll<HTMLElement>(
        '[data-testid="file-combinable-change-notice"]',
      ),
    );

  it.each([
    [
      'agent-edit',
      'Canopy',
      "Canopy updated this document while you were editing. Save to combine your updates with Canopy's.",
    ],
    [
      null,
      'Canopy',
      'This document was updated while you were editing. Save to combine your updates with the newer changes.',
    ],
    [
      'agent-edit',
      undefined,
      'This document was updated while you were editing. Save to combine your updates with the newer changes.',
    ],
  ] as const)(
    'explains the combine Save will perform (%s, %s)',
    (source, appName, copy) => {
      mockState = baseState(
        pending({ combinableChange: { version: 'v2', source } }),
      );
      const viewer = mountViewer(
        <FileViewer request={REQUEST} appName={appName} />,
      );
      const [notice, ...rest] = notices(viewer.container);
      expect(rest).toHaveLength(0);
      expect(notice?.textContent).toBe(copy);
      expect(notice?.getAttribute('data-notice-intent')).toBe('neutral');
      expect(notice?.getAttribute('role')).toBe('status');
      expect(notice?.querySelectorAll('button')).toHaveLength(0);
      expect(viewer.container.textContent).toContain('ONE');
      viewer.unmount();
    },
  );

  it.each([
    ['a clean buffer', { dirty: false, content: 'one' }],
    ['no combinable change', { combinableChange: null }],
    [
      'an external change notice',
      { externalChange: { reloading: false, error: null } },
    ],
    [
      'a save conflict',
      {
        saveConflict: {
          reason: 'overlap',
          source: 'agent-edit',
          origin: 'user',
          latest: null,
          resolving: null,
          error: null,
          focusRequest: 0,
        },
      },
    ],
  ] as const)('is not shown with %s', (_label, overrides) => {
    mockState = baseState(pending(overrides));
    const viewer = mountViewer(
      <FileViewer request={REQUEST} appName="Canopy" />,
    );
    expect(notices(viewer.container)).toHaveLength(0);
    viewer.unmount();
  });

  it('renders exactly once in the alternate presentation', () => {
    mockState = baseState(pending());
    const viewer = mountViewer(
      <FileViewer
        request={REQUEST}
        appName="Canopy"
        alternateContent={<div data-testid="host-diff">Diff</div>}
      />,
    );
    expect(notices(viewer.container)).toHaveLength(1);
    viewer.unmount();
  });
});

describe('FileViewer combined save confirmation', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockOpenFile.mockReset();
    mockOpenFile.mockResolvedValue(fileViewerKey(REQUEST));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const saved = (
    revision: number,
    overrides: Partial<FileViewerSession> = {},
  ): FileViewerSession =>
    session({
      path: 'notes.md',
      content: 'ONE\nFIVE',
      savedMerge: revision === 0 ? null : { revision, source: 'agent-edit' },
      ...overrides,
    });
  const notices = (container: HTMLElement): HTMLElement[] =>
    Array.from(
      container.querySelectorAll<HTMLElement>(
        '[data-testid="file-combined-save-notice"]',
      ),
    );
  const announcement = (container: HTMLElement): string =>
    container.querySelector('[data-testid="file-reload-announcement"]')
      ?.textContent ?? '';
  const viewerFor = (
    props: { active?: boolean; alternate?: boolean } = {},
  ): JSX.Element => (
    <FileViewer
      request={REQUEST}
      appName="Canopy"
      active={props.active}
      alternateContent={
        props.alternate ? <div data-testid="host-diff">Diff</div> : undefined
      }
    />
  );
  const mountSaved = async (
    props: { active?: boolean; alternate?: boolean } = {},
  ): Promise<ReturnType<typeof mountViewer>> => {
    mockState = baseState(saved(0));
    const viewer = mountViewer(viewerFor(props));
    mockState = baseState(saved(1));
    await viewer.render(viewerFor(props));
    return viewer;
  };

  it('does not show a combined save that happened before mount', () => {
    mockState = baseState(saved(3));
    const viewer = mountViewer(viewerFor());
    act(() => jest.advanceTimersByTime(500));
    expect(notices(viewer.container)).toHaveLength(0);
    viewer.unmount();
    const remounted = mountViewer(viewerFor());
    expect(notices(remounted.container)).toHaveLength(0);
    remounted.unmount();
  });

  it('does not replay history when an existing session arrives after mount', async () => {
    mockState = baseState(undefined);
    const viewer = mountViewer(viewerFor());
    mockState = baseState(saved(3));
    await viewer.render(viewerFor());
    expect(notices(viewer.container)).toHaveLength(0);
    mockState = baseState(saved(4));
    await viewer.render(viewerFor());
    expect(notices(viewer.container)).toHaveLength(1);
    viewer.unmount();
  });

  it.each([
    ['an ordinary save', 'ONE\nFIVE\nmore edits'],
    ['a newer version with identical text', 'ONE\nFIVE'],
  ])(
    'invalidates the previous combine after %s even when intermediate renders batch',
    async (_event, content) => {
      const viewer = await mountSaved();
      const current = saved(1, { content });
      mockState = baseState({
        ...current,
        preview: current.preview
          ? { ...current.preview, version: 'newer-version' }
          : null,
      });
      await viewer.render(viewerFor());
      expect(notices(viewer.container)).toHaveLength(0);
      await viewer.render(viewerFor({ alternate: true }));
      expect(notices(viewer.container)).toHaveLength(0);
      viewer.unmount();
    },
  );

  it('invalidates a combine when editing and undo batch into a clean render', async () => {
    const client: CanopyClient = {
      capabilities: {
        localExecution: true,
        terminalPty: true,
        fileSystemAccess: 'read-write',
        voice: false,
        settingsScope: 'full',
        pipelines: 'execute',
        routing: 'in-memory',
        overviewNotifications: true,
      },
      query: () => Promise.reject(new Error('unexpected read')),
      command: () => Promise.reject(new Error('unexpected write')),
      subscribe: () => () => {},
    };
    const store = createFileViewerStore(client);
    const key = fileViewerKey(REQUEST);
    store.setState({ files: { [key]: saved(0) } });
    mockState = { ...store.getState(), openFile: mockOpenFile };
    const viewer = mountViewer(viewerFor());
    store.setState({ files: { [key]: saved(1) } });
    mockState = { ...store.getState(), openFile: mockOpenFile };
    await viewer.render(viewerFor());
    expect(notices(viewer.container)).toHaveLength(1);
    // Use real store mutations, allowing React to observe only the final
    // clean state as it can for synchronous actions in the same event.
    store.getState().updateContent(key, 'ONE\nFIVE!');
    store.getState().updateContent(key, 'ONE\nFIVE');
    mockState = { ...store.getState(), openFile: mockOpenFile };
    expect(mockState.files[key]?.dirty).toBe(false);
    await viewer.render(viewerFor());
    expect(notices(viewer.container)).toHaveLength(0);
    await viewer.render(viewerFor({ alternate: true }));
    expect(notices(viewer.container)).toHaveLength(0);
    viewer.unmount();
  });

  it.each([
    ['agent-edit', 'Canopy', "Your edits and Canopy's changes were combined."],
    [null, 'Canopy', 'Your edits and the newer changes were combined.'],
    [
      'agent-edit',
      undefined,
      'Your edits and the newer changes were combined.',
    ],
  ] as const)(
    'confirms a new combined save with the announced wording (%s, %s)',
    async (source, appName, copy) => {
      mockState = baseState(saved(0));
      const viewer = mountViewer(
        <FileViewer request={REQUEST} appName={appName} />,
      );
      mockState = baseState(saved(0, { savedMerge: { revision: 1, source } }));
      await viewer.render(<FileViewer request={REQUEST} appName={appName} />);
      act(() => jest.advanceTimersByTime(500));
      const [notice, ...rest] = notices(viewer.container);
      expect(rest).toHaveLength(0);
      expect(notice?.textContent).toBe(`Saved. ${copy}`);
      expect(notice?.getAttribute('data-notice-intent')).toBe('positive');
      expect(notice?.hasAttribute('role')).toBe(false);
      expect(notice?.hasAttribute('aria-live')).toBe(false);
      expect(
        notice
          ?.querySelector('[data-testid="file-combined-save-notice-dismiss"]')
          ?.getAttribute('aria-label'),
      ).toBe('Dismiss saved notice');
      expect(announcement(viewer.container)).toBe(`Saved. ${copy}`);
      expect(
        Array.from(viewer.container.querySelectorAll('[role="status"]')).filter(
          (node) => node.textContent?.includes('were combined'),
        ),
      ).toHaveLength(1);
      viewer.unmount();
    },
  );

  it('expires after eight seconds of active viewing', async () => {
    const viewer = await mountSaved();
    act(() => jest.advanceTimersByTime(7_900));
    expect(notices(viewer.container)).toHaveLength(1);
    act(() => jest.advanceTimersByTime(200));
    expect(notices(viewer.container)).toHaveLength(0);
    viewer.unmount();
  });

  it('stays dismissed and focuses the header', async () => {
    const viewer = await mountSaved();
    const dismiss = viewer.container.querySelector<HTMLButtonElement>(
      '[data-testid="file-combined-save-notice-dismiss"]',
    );
    dismiss?.focus();
    act(() => dismiss?.click());
    expect(notices(viewer.container)).toHaveLength(0);
    expect(document.activeElement?.getAttribute('data-testid')).toBe(
      'file-viewer-header',
    );
    await viewer.render(viewerFor());
    await viewer.render(viewerFor({ alternate: true }));
    expect(notices(viewer.container)).toHaveLength(0);
    viewer.unmount();
  });

  it.each([
    ['new editing', { dirty: true, content: 'ONE\nFIVE!' }],
    [
      'a newer combinable change',
      {
        dirty: true,
        content: 'ONE\nFIVE!',
        combinableChange: { version: 'v4', source: null },
      },
    ],
    [
      'a newer external change',
      { externalChange: { reloading: false, error: null } },
    ],
    ['a reload or discard', { reloadRevision: 1 }],
    [
      'a save conflict',
      {
        dirty: true,
        content: 'ONE\nFIVE!',
        saveConflict: {
          reason: 'overlap',
          source: null,
          origin: 'user',
          latest: null,
          resolving: null,
          error: null,
          focusRequest: 0,
        },
      },
    ],
  ] as const)('is made obsolete for good by %s', async (_label, overrides) => {
    const viewer = await mountSaved();
    mockState = baseState(saved(1, overrides));
    await viewer.render(viewerFor());
    expect(notices(viewer.container)).toHaveLength(0);
    mockState = baseState(saved(1, { reloadRevision: 1 }));
    await viewer.render(viewerFor());
    expect(notices(viewer.container)).toHaveLength(0);
    viewer.unmount();
  });

  it('is made obsolete when the session is replaced', async () => {
    const viewer = await mountSaved();
    mockState = baseState(undefined);
    await viewer.render(viewerFor());
    // A reopened session starts without a saved merge.
    mockState = baseState(saved(0));
    await viewer.render(viewerFor());
    expect(notices(viewer.container)).toHaveLength(0);
    viewer.unmount();
  });

  it('pauses while inactive without granting a new budget', async () => {
    const viewer = await mountSaved();
    act(() => jest.advanceTimersByTime(5_000));
    await viewer.render(viewerFor({ active: false }));
    act(() => jest.advanceTimersByTime(30_000));
    expect(notices(viewer.container)).toHaveLength(1);
    await viewer.render(viewerFor());
    act(() => jest.advanceTimersByTime(2_900));
    expect(notices(viewer.container)).toHaveLength(1);
    act(() => jest.advanceTimersByTime(200));
    expect(notices(viewer.container)).toHaveLength(0);
    viewer.unmount();
  });

  it('starts counting a save observed while inactive on activation', async () => {
    const viewer = await mountSaved({ active: false });
    act(() => jest.advanceTimersByTime(30_000));
    await viewer.render(viewerFor());
    act(() => jest.advanceTimersByTime(7_900));
    expect(notices(viewer.container)).toHaveLength(1);
    act(() => jest.advanceTimersByTime(200));
    expect(notices(viewer.container)).toHaveLength(0);
    viewer.unmount();
  });

  it('replaces an earlier confirmation and resets its budget', async () => {
    const viewer = await mountSaved();
    act(() => jest.advanceTimersByTime(5_000));
    mockState = baseState(
      saved(0, { savedMerge: { revision: 2, source: null } }),
    );
    await viewer.render(viewerFor());
    const [notice, ...rest] = notices(viewer.container);
    expect(rest).toHaveLength(0);
    expect(notice?.textContent).toBe(
      'Saved. Your edits and the newer changes were combined.',
    );
    act(() => jest.advanceTimersByTime(5_000));
    expect(notices(viewer.container)).toHaveLength(1);
    act(() => jest.advanceTimersByTime(3_100));
    expect(notices(viewer.container)).toHaveLength(0);
    viewer.unmount();
  });

  it('keeps its budget and renders once across layout switches', async () => {
    const viewer = await mountSaved();
    act(() => jest.advanceTimersByTime(5_000));
    await viewer.render(viewerFor({ alternate: true }));
    expect(notices(viewer.container)).toHaveLength(1);
    act(() => jest.advanceTimersByTime(2_000));
    await viewer.render(viewerFor());
    expect(notices(viewer.container)).toHaveLength(1);
    act(() => jest.advanceTimersByTime(1_100));
    expect(notices(viewer.container)).toHaveLength(0);
    viewer.unmount();
  });

  it('does not carry a confirmation to another file', async () => {
    const viewer = await mountSaved();
    const other: PortalFileReadPayload = { ...REQUEST, relativePath: 'b.md' };
    const otherKey = fileViewerKey(other);
    mockState = {
      ...baseState(saved(1)),
      files: {
        [otherKey]: {
          ...saved(2),
          key: otherKey,
          request: other,
        },
      },
    };
    await viewer.render(<FileViewer request={other} appName="Canopy" />);
    expect(notices(viewer.container)).toHaveLength(0);
    viewer.unmount();
  });

  it('clears its timer on unmount', async () => {
    const viewer = await mountSaved();
    const clear = jest.spyOn(globalThis, 'clearTimeout');
    viewer.unmount();
    expect(clear).toHaveBeenCalled();
    clear.mockRestore();
    expect(() => jest.runOnlyPendingTimers()).not.toThrow();
  });
});

describe('FileViewer read-only previews (CAN-5004)', () => {
  const editor = (): JSX.Element => <div data-testid="host-editor" />;

  beforeEach(() => {
    mockOpenFile.mockReset();
    mockOpenFile.mockResolvedValue(fileViewerKey(REQUEST));
  });

  function mount(
    element: JSX.Element,
    adopted = false,
  ): {
    host: HTMLDivElement;
    rerender: (next: JSX.Element) => void;
    unmount: () => void;
  } {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    act(() => root.render(element));
    const frame = adopted ? document.createElement('iframe') : null;
    if (frame) {
      document.body.append(frame);
      const auxiliaryDocument = frame.contentDocument;
      if (!auxiliaryDocument) throw new Error('auxiliary document missing');
      auxiliaryDocument.body.append(host);
    }
    return {
      host,
      rerender: (next): void => {
        act(() => root.render(next));
      },
      unmount: (): void => {
        act(() => root.unmount());
        host.remove();
        frame?.remove();
      },
    };
  }

  function byTestId<T extends HTMLElement = HTMLElement>(
    host: ParentNode,
    testId: string,
  ): T | null {
    return host.querySelector<T>(`[data-testid="${testId}"]`);
  }

  function required<T extends HTMLElement = HTMLElement>(
    host: ParentNode,
    testId: string,
  ): T {
    const element = byTestId<T>(host, testId);
    if (!element) throw new Error(`${testId} missing`);
    return element;
  }

  function description(region: HTMLElement): string | null {
    const id = region.getAttribute('aria-describedby');
    return id ? (document.getElementById(id)?.textContent ?? null) : null;
  }

  function keyDown(
    target: Element,
    init: KeyboardEventInit & { key: string },
  ): KeyboardEvent {
    const event = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      ...init,
    });
    act(() => {
      target.dispatchEvent(event);
    });
    return event;
  }

  function markdownState(
    overrides: Partial<FileViewerSession> = {},
  ): FileViewerState {
    return baseState(
      session({
        path: 'docs/readme.md',
        content: '# Hi\n\nSome [link](https://example.com) text',
        viewMode: 'preview',
        ...overrides,
      }),
    );
  }

  it.each([
    ['docs/readme.md', 'preview', 'Formatted'],
    ['docs/page.html', 'preview', 'Formatted'],
    ['data.csv', 'table', 'Table'],
  ] as const)(
    'names the raw segment Edit for an editable Cowork %s and keeps its test ids',
    (path, viewMode, renderedLabel) => {
      mockState = baseState(session({ path, content: 'a,b', viewMode }));
      const viewer = mount(
        <FileViewer
          request={REQUEST}
          renderEditor={editor}
          rawViewLabel="edit"
        />,
      );
      try {
        expect(
          required(viewer.host, 'file-view-toggle-source').textContent,
        ).toBe('Edit');
        expect(
          required(viewer.host, 'file-view-toggle-formatted').textContent,
        ).toBe(renderedLabel);
      } finally {
        viewer.unmount();
      }
    },
  );

  it('keeps Source without editing permission and honors session permission over the store default', () => {
    const cases: [FileViewerState, JSX.Element, string, string][] = [
      [
        markdownState(),
        <FileViewer request={REQUEST} renderEditor={editor} />,
        'Read-only. Switch to Source to change the text.',
        'Source',
      ],
      [
        markdownState(),
        <FileViewer request={REQUEST} rawViewLabel="edit" />,
        'Read-only.',
        'Source',
      ],
      [
        markdownState({ canEdit: false }),
        <FileViewer
          request={REQUEST}
          renderEditor={editor}
          rawViewLabel="edit"
        />,
        'Read-only.',
        'Source',
      ],
      [
        { ...markdownState(), canEdit: false },
        <FileViewer
          request={REQUEST}
          renderEditor={editor}
          rawViewLabel="edit"
        />,
        'Read-only. Switch to Edit to change the text.',
        'Edit',
      ],
    ];
    for (const [state, element, expectedDescription, expectedLabel] of cases) {
      mockState = state;
      const viewer = mount(element);
      try {
        expect(
          required(viewer.host, 'file-view-toggle-source').textContent,
        ).toBe(expectedLabel);
        expect(description(required(viewer.host, 'file-rendered-region'))).toBe(
          expectedDescription,
        );
      } finally {
        viewer.unmount();
      }
    }
  });

  it.each(
    ['docs/readme.md', 'docs/page.html', 'data.csv'].flatMap((path) => [
      { path, adopted: false },
      { path, adopted: true },
    ]),
  )(
    'names the raw segment Edit in the alternate-content header for $path (adopted=$adopted)',
    ({ path, adopted }) => {
      // The alternate header dispatches on the request path, so key the
      // session by a markdown request.
      const request = { ...REQUEST, relativePath: path };
      const key = fileViewerKey(request);
      const setViewMode = jest.fn();
      const onViewModeChange = jest.fn();
      const markdown = {
        ...session({ path, content: '# Hi' }),
        key,
        request,
      };
      mockState = {
        ...baseState(undefined),
        files: { [key]: markdown },
        setViewMode,
      };
      const viewer = mount(
        <FileViewer
          request={request}
          renderEditor={editor}
          rawViewLabel="edit"
          alternateContent={<div data-testid="host-diff">Diff</div>}
          onViewModeChange={onViewModeChange}
        />,
        adopted,
      );
      try {
        const header = Array.from(
          viewer.host.querySelectorAll('[data-testid="file-viewer-header"]'),
        ).at(-1);
        if (!header) throw new Error('alternate header missing');
        expect(required(header, 'file-view-toggle-source').textContent).toBe(
          'Edit',
        );
        const raw = required<HTMLButtonElement>(
          header,
          'file-view-toggle-source',
        );
        act(() => raw.focus());
        act(() => raw.click());
        expect(setViewMode).toHaveBeenCalledTimes(1);
        expect(setViewMode).toHaveBeenCalledWith(key, 'raw');
        expect(onViewModeChange).toHaveBeenCalledTimes(1);
        viewer.rerender(
          <FileViewer
            request={request}
            renderEditor={editor}
            rawViewLabel="edit"
            viewMode="raw"
            onViewModeChange={onViewModeChange}
          />,
        );
        expect(viewer.host.ownerDocument.activeElement).toBe(
          required(viewer.host, 'file-view-toggle-source'),
        );
      } finally {
        viewer.unmount();
      }
    },
  );

  it('cancels an alternate raw focus request superseded by another view', () => {
    const request = { ...REQUEST, relativePath: 'notes.md' };
    const key = fileViewerKey(request);
    mockState = {
      ...markdownState(),
      files: {
        [key]: session({
          path: 'notes.md',
          content: '# Notes',
          viewMode: 'preview',
        }),
      },
    };
    const viewer = mount(
      <FileViewer
        request={request}
        renderEditor={editor}
        alternateContent={<div>Diff</div>}
      />,
    );
    try {
      const headers = viewer.host.querySelectorAll(
        '[data-testid="file-viewer-header"]',
      );
      const header = headers.item(headers.length - 1);
      act(() =>
        required<HTMLButtonElement>(header, 'file-view-toggle-source').click(),
      );
      const formatted = required<HTMLButtonElement>(
        header,
        'file-view-toggle-formatted',
      );
      act(() => formatted.focus());
      act(() => formatted.click());
      viewer.rerender(
        <FileViewer request={request} renderEditor={editor} viewMode="raw" />,
      );
      expect(document.activeElement).not.toBe(
        required(viewer.host, 'file-view-toggle-source'),
      );
    } finally {
      viewer.unmount();
    }
  });

  it('describes the rendered view as a named, focusable read-only region', () => {
    mockState = markdownState();
    const first = mount(
      <FileViewer
        request={REQUEST}
        renderEditor={editor}
        rawViewLabel="edit"
      />,
    );
    const second = mount(
      <FileViewer request={REQUEST} renderEditor={editor} />,
    );
    try {
      const region = required(first.host, 'file-rendered-region');
      const other = required(second.host, 'file-rendered-region');
      expect(region.getAttribute('role')).toBe('region');
      expect(region.getAttribute('aria-label')).toBe('Formatted view');
      expect(region.tabIndex).toBe(0);
      expect(region.hasAttribute('aria-readonly')).toBe(false);
      expect(description(region)).toBe(
        'Read-only. Switch to Edit to change the text.',
      );
      expect(description(other)).toBe(
        'Read-only. Switch to Source to change the text.',
      );
      expect(region.getAttribute('aria-describedby')).not.toBe(
        other.getAttribute('aria-describedby'),
      );
      // The raw view is never wrapped as a preview.
      expect(
        region.querySelector('[data-testid="file-viewer-markdown-scroll"]'),
      ).not.toBeNull();
    } finally {
      first.unmount();
      second.unmount();
    }
  });

  it('names the CSV table region and leaves the raw editor unwrapped', () => {
    mockState = baseState(
      session({ path: 'data.csv', content: 'a,b\n1,2', viewMode: 'table' }),
    );
    const table = mount(
      <FileViewer
        request={REQUEST}
        renderEditor={editor}
        rawViewLabel="edit"
      />,
    );
    try {
      expect(
        required(table.host, 'file-rendered-region').getAttribute('aria-label'),
      ).toBe('Table view');
      table.rerender(
        <FileViewer
          request={REQUEST}
          renderEditor={editor}
          rawViewLabel="edit"
          viewMode="raw"
        />,
      );
      expect(byTestId(table.host, 'file-rendered-region')).toBeNull();
      expect(byTestId(table.host, 'host-editor')).not.toBeNull();
    } finally {
      table.unmount();
    }
  });

  it('describes a truncated preview as read-only without a selector', () => {
    const content = '# Large';
    mockState = baseState(
      session({
        path: 'docs/big.md',
        content,
        viewMode: 'preview',
        preview: {
          workspaceLocalId: 'w',
          worktreeLocalId: 'wt',
          path: 'docs/big.md',
          content,
          size: 6_000_000,
          version: 'v1',
          truncated: true,
        },
      }),
    );
    const viewer = mount(
      <FileViewer
        request={REQUEST}
        renderEditor={editor}
        rawViewLabel="edit"
      />,
    );
    try {
      expect(byTestId(viewer.host, 'file-view-toggle')).toBeNull();
      expect(description(required(viewer.host, 'file-rendered-region'))).toBe(
        'Read-only.',
      );
    } finally {
      viewer.unmount();
    }
  });

  it.each(['big.md', 'big.html', 'big.csv'])(
    'hides both selectors for a truncated %s in alternate content',
    (path) => {
      const request = { ...REQUEST, relativePath: path };
      const key = fileViewerKey(request);
      const loaded = session({ path, content: '# Large' });
      if (!loaded.preview) throw new Error('preview missing');
      mockState = {
        ...baseState(undefined),
        files: {
          [key]: {
            ...loaded,
            key,
            request,
            preview: { ...loaded.preview, truncated: true },
          },
        },
      };
      const viewer = mount(
        <FileViewer
          request={request}
          renderEditor={editor}
          alternateContent={<div>Diff</div>}
        />,
      );
      try {
        expect(byTestId(viewer.host, 'file-view-toggle')).toBeNull();
      } finally {
        viewer.unmount();
      }
    },
  );

  it('points a typing attempt at the raw view and focuses its segment', () => {
    mockState = markdownState();
    const viewer = mount(
      <FileViewer
        request={REQUEST}
        renderEditor={editor}
        rawViewLabel="edit"
      />,
    );
    try {
      const region = required(viewer.host, 'file-rendered-region');
      act(() => region.focus());
      expect(byTestId(viewer.host, 'file-readonly-hint')).toBeNull();

      const event = keyDown(region, { key: 'a' });
      expect(event.defaultPrevented).toBe(true);
      const hint = required(viewer.host, 'file-readonly-hint');
      expect(hint.getAttribute('role')).toBe('status');
      expect(hint.textContent).toContain('Formatted view is read-only.');
      expect(hint.textContent).toContain('Switch to Edit to change the text.');
      expect(
        required(viewer.host, 'file-readonly-hint-switch').textContent,
      ).toBe('Switch to Edit');
      expect(document.activeElement).toBe(
        required(viewer.host, 'file-view-toggle-source'),
      );
      // The preview content and the session are untouched.
      expect(byTestId(viewer.host, 'file-viewer-dirty')).toBeNull();
      expect(region.textContent).toContain('Some link text');
    } finally {
      viewer.unmount();
    }
  });

  it.each([
    ['a command shortcut', { key: 'c', metaKey: true }],
    ['a Ctrl shortcut', { key: 'a', ctrlKey: true }],
    ['an Alt combination', { key: 'x', altKey: true }],
    ['Space', { key: ' ' }],
    ['an arrow key', { key: 'ArrowDown' }],
    ['Escape', { key: 'Escape' }],
    ['a held-key repeat', { key: 'a', repeat: true }],
    ['a composition key', { key: 'a', isComposing: true }],
    ['a dead key', { key: 'Dead' }],
    ['a process key', { key: 'Process' }],
  ])('ignores %s on the rendered view', (_name, init) => {
    mockState = markdownState();
    const viewer = mount(
      <FileViewer
        request={REQUEST}
        renderEditor={editor}
        rawViewLabel="edit"
      />,
    );
    try {
      const event = keyDown(
        required(viewer.host, 'file-rendered-region'),
        init,
      );
      expect(event.defaultPrevented).toBe(false);
      expect(byTestId(viewer.host, 'file-readonly-hint')).toBeNull();
    } finally {
      viewer.unmount();
    }
  });

  it('ignores keys from interactive descendants of the preview', () => {
    mockState = markdownState();
    const viewer = mount(
      <FileViewer
        request={REQUEST}
        renderEditor={editor}
        rawViewLabel="edit"
      />,
    );
    try {
      const link = viewer.host.querySelector(
        '[data-testid="file-rendered-region"] a',
      );
      if (!link) throw new Error('link missing');
      const inner = document.createElement('span');
      link.append(inner);
      const event = keyDown(inner, { key: 'Enter' });
      expect(event.defaultPrevented).toBe(false);
      expect(byTestId(viewer.host, 'file-readonly-hint')).toBeNull();
    } finally {
      viewer.unmount();
    }
  });

  it.each(['keyboard', 'pointer'])(
    'preserves nested-link %s behavior after the preview remounts in another window',
    (interaction) => {
      mockState = markdownState();
      const element = (viewMode: FileViewMode): JSX.Element => (
        <FileViewer
          request={REQUEST}
          renderEditor={editor}
          rawViewLabel="edit"
          viewMode={viewMode}
        />
      );
      const viewer = mount(element('preview'));
      const frame = document.createElement('iframe');
      document.body.append(frame);
      try {
        const auxiliaryDocument = frame.contentDocument;
        if (!auxiliaryDocument) throw new Error('auxiliary document missing');
        auxiliaryDocument.body.append(viewer.host);
        viewer.rerender(element('raw'));
        viewer.rerender(element('preview'));
        const link = viewer.host.querySelector<HTMLAnchorElement>(
          '[data-testid="file-rendered-region"] a',
        );
        if (!link) throw new Error('link missing');
        const inner = auxiliaryDocument.createElement('span');
        link.append(inner);
        // The new descendants use the auxiliary window's DOM constructors.
        expect(inner instanceof Element).toBe(false);
        if (interaction === 'keyboard') {
          expect(keyDown(inner, { key: 'Enter' }).defaultPrevented).toBe(false);
        } else {
          link.addEventListener('click', (event) => event.preventDefault());
          act(() => {
            link.focus();
            inner.click();
          });
          expect(auxiliaryDocument.activeElement).toBe(link);
        }
        expect(byTestId(viewer.host, 'file-readonly-hint')).toBeNull();
      } finally {
        viewer.unmount();
        frame.remove();
      }
    },
  );

  it('offers no editing guidance on a read-only preview', () => {
    mockState = markdownState();
    const viewer = mount(<FileViewer request={REQUEST} rawViewLabel="edit" />);
    try {
      const event = keyDown(required(viewer.host, 'file-rendered-region'), {
        key: 'a',
      });
      expect(event.defaultPrevented).toBe(false);
      expect(byTestId(viewer.host, 'file-readonly-hint')).toBeNull();
    } finally {
      viewer.unmount();
    }
  });

  it.each([
    'button',
    'textbox',
    'listbox',
    'tree',
    'grid',
    'slider',
    'menuitemcheckbox',
    'searchbox',
    'scrollbar',
  ])('preserves nested %s widget keyboard and pointer handling', (role) => {
    mockState = markdownState();
    const viewer = mount(
      <FileViewer request={REQUEST} renderEditor={editor} />,
    );
    try {
      const region = required(viewer.host, 'file-rendered-region');
      const widget = document.createElement('div');
      widget.setAttribute('role', role);
      const nested = document.createElement('span');
      widget.append(nested);
      region.append(widget);
      expect(keyDown(nested, { key: 'x' }).defaultPrevented).toBe(false);
      act(() => nested.click());
      expect(document.activeElement).not.toBe(region);
      expect(byTestId(viewer.host, 'file-readonly-hint')).toBeNull();
    } finally {
      viewer.unmount();
    }
  });

  it('respects prevented events and session permission overriding store permission', () => {
    mockState = { ...markdownState({ canEdit: true }), canEdit: false };
    const viewer = mount(
      <FileViewer
        request={REQUEST}
        renderEditor={editor}
        rawViewLabel="edit"
      />,
    );
    try {
      expect(required(viewer.host, 'file-view-toggle-source').textContent).toBe(
        'Edit',
      );
      const region = required(viewer.host, 'file-rendered-region');
      region.addEventListener('keydown', (event) => event.preventDefault());
      keyDown(region, { key: 'x' });
      expect(byTestId(viewer.host, 'file-readonly-hint')).toBeNull();
    } finally {
      viewer.unmount();
    }
  });

  it.each([false, true])(
    'switches to the raw view exactly once and refocuses its segment (adopted=%s)',
    (adopted) => {
      const setViewMode = jest.fn();
      const onViewModeChange = jest.fn();
      mockState = { ...markdownState(), setViewMode };
      const element = (viewMode: FileViewMode): JSX.Element => (
        <FileViewer
          request={REQUEST}
          renderEditor={editor}
          rawViewLabel="edit"
          viewMode={viewMode}
          onViewModeChange={onViewModeChange}
        />
      );
      const viewer = mount(element('preview'), adopted);
      try {
        keyDown(required(viewer.host, 'file-rendered-region'), { key: 'x' });
        const action = required<HTMLButtonElement>(
          viewer.host,
          'file-readonly-hint-switch',
        );
        act(() => action.focus());
        act(() => action.click());
        expect(setViewMode).toHaveBeenCalledTimes(1);
        expect(setViewMode).toHaveBeenCalledWith(fileViewerKey(REQUEST), 'raw');
        expect(onViewModeChange).toHaveBeenCalledTimes(1);
        expect(onViewModeChange).toHaveBeenCalledWith('raw');

        viewer.rerender(element('raw'));
        expect(byTestId(viewer.host, 'file-readonly-hint')).toBeNull();
        const source = required(viewer.host, 'file-view-toggle-source');
        expect(source.getAttribute('aria-pressed')).toBe('true');
        expect(viewer.host.ownerDocument.activeElement).toBe(source);
        expect(byTestId(viewer.host, 'host-editor')).not.toBeNull();
      } finally {
        viewer.unmount();
      }
    },
  );

  it('keeps the revealing key from activating the focused segment', () => {
    const setViewMode = jest.fn();
    mockState = { ...markdownState(), setViewMode };
    const viewer = mount(
      <FileViewer
        request={REQUEST}
        renderEditor={editor}
        rawViewLabel="edit"
      />,
    );
    try {
      keyDown(required(viewer.host, 'file-rendered-region'), { key: 'Enter' });
      const source = required(viewer.host, 'file-view-toggle-source');
      expect(document.activeElement).toBe(source);
      expect(
        keyDown(source, { key: 'Enter', repeat: true }).defaultPrevented,
      ).toBe(true);
      const keyUp = new KeyboardEvent('keyup', {
        key: 'Enter',
        bubbles: true,
        cancelable: true,
      });
      act(() => {
        source.dispatchEvent(keyUp);
      });
      expect(keyUp.defaultPrevented).toBe(true);
      // A fresh press after release is the user's own.
      expect(keyDown(source, { key: 'Enter' }).defaultPrevented).toBe(false);
      expect(setViewMode).not.toHaveBeenCalled();
    } finally {
      viewer.unmount();
    }
  });

  it.each(['Enter', ' '])(
    'requires a fresh %s press even after the revealing key is released',
    (activationKey) => {
      mockState = markdownState();
      const viewer = mount(
        <FileViewer request={REQUEST} renderEditor={editor} />,
      );
      const keyUp = (target: Element, key: string): KeyboardEvent => {
        const event = new KeyboardEvent('keyup', {
          key,
          bubbles: true,
          cancelable: true,
        });
        act(() => {
          target.dispatchEvent(event);
        });
        return event;
      };
      try {
        keyDown(required(viewer.host, 'file-rendered-region'), { key: 'x' });
        const raw = required(viewer.host, 'file-view-toggle-source');
        keyUp(raw, 'x');
        expect(
          keyDown(raw, { key: activationKey, repeat: true }).defaultPrevented,
        ).toBe(true);
        expect(keyUp(raw, activationKey).defaultPrevented).toBe(true);
        expect(keyDown(raw, { key: activationKey }).defaultPrevented).toBe(
          false,
        );
        expect(keyUp(raw, activationKey).defaultPrevented).toBe(false);
      } finally {
        viewer.unmount();
      }
    },
  );

  it.each([
    ['Escape on the focused segment', 'segment'],
    ['Escape inside the notice', 'notice'],
    ['the dismiss button', 'button'],
  ] as const)(
    'dismisses the notice with %s and returns focus to the preview',
    (_name, via) => {
      mockState = markdownState();
      const viewer = mount(
        <FileViewer
          request={REQUEST}
          renderEditor={editor}
          rawViewLabel="edit"
        />,
      );
      try {
        const region = required(viewer.host, 'file-rendered-region');
        keyDown(region, { key: 'q' });
        if (via === 'segment') {
          keyDown(required(viewer.host, 'file-view-toggle-source'), {
            key: 'Escape',
          });
        } else if (via === 'notice') {
          const action = required(viewer.host, 'file-readonly-hint-switch');
          act(() => action.focus());
          keyDown(action, { key: 'Escape' });
        } else {
          const dismiss = required<HTMLButtonElement>(
            viewer.host,
            'file-readonly-hint-dismiss',
          );
          expect(dismiss.getAttribute('aria-label')).toBe(
            'Dismiss read-only notice',
          );
          act(() => dismiss.click());
        }
        expect(byTestId(viewer.host, 'file-readonly-hint')).toBeNull();
        expect(document.activeElement).toBe(region);
        // A later attempt reveals it again.
        keyDown(region, { key: 'q' });
        expect(byTestId(viewer.host, 'file-readonly-hint')).not.toBeNull();
      } finally {
        viewer.unmount();
      }
    },
  );

  it('removes the guidance when editing becomes unavailable', () => {
    mockState = markdownState();
    const viewer = mount(
      <FileViewer
        request={REQUEST}
        renderEditor={editor}
        rawViewLabel="edit"
      />,
    );
    try {
      keyDown(required(viewer.host, 'file-rendered-region'), { key: 'a' });
      expect(byTestId(viewer.host, 'file-readonly-hint')).not.toBeNull();
      viewer.rerender(<FileViewer request={REQUEST} rawViewLabel="edit" />);
      expect(byTestId(viewer.host, 'file-readonly-hint')).toBeNull();
      expect(required(viewer.host, 'file-view-toggle-source').textContent).toBe(
        'Source',
      );
      expect(description(required(viewer.host, 'file-rendered-region'))).toBe(
        'Read-only.',
      );
      // Restoring the editor does not bring back the old notice.
      viewer.rerender(
        <FileViewer
          request={REQUEST}
          renderEditor={editor}
          rawViewLabel="edit"
        />,
      );
      expect(byTestId(viewer.host, 'file-readonly-hint')).toBeNull();
    } finally {
      viewer.unmount();
    }
  });

  it('keeps the notice beside an external-change notice', () => {
    mockState = markdownState({
      externalChange: { reloading: false, error: null },
    });
    const viewer = mount(
      <FileViewer
        request={REQUEST}
        renderEditor={editor}
        rawViewLabel="edit"
      />,
    );
    try {
      keyDown(required(viewer.host, 'file-rendered-region'), { key: 'a' });
      expect(
        byTestId(viewer.host, 'file-external-change-notice'),
      ).not.toBeNull();
      expect(byTestId(viewer.host, 'file-readonly-hint')).not.toBeNull();
    } finally {
      viewer.unmount();
    }
  });

  it('retires guidance when another file is still loading', () => {
    mockState = markdownState();
    const element = <FileViewer request={REQUEST} renderEditor={editor} />;
    const viewer = mount(element);
    try {
      keyDown(required(viewer.host, 'file-rendered-region'), { key: 'x' });
      expect(byTestId(viewer.host, 'file-readonly-hint')).not.toBeNull();
      viewer.rerender(
        <FileViewer
          request={{ ...REQUEST, relativePath: 'loading.md' }}
          renderEditor={editor}
        />,
      );
      viewer.rerender(element);
      expect(byTestId(viewer.host, 'file-readonly-hint')).toBeNull();
    } finally {
      viewer.unmount();
    }
  });

  it.each(['session', 'store', 'view', 'alternate', 'inactive'] as const)(
    'updates visible guidance on a %s change',
    (change) => {
      mockState = markdownState();
      const viewer = mount(
        <FileViewer
          request={REQUEST}
          renderEditor={editor}
          rawViewLabel="edit"
        />,
      );
      try {
        keyDown(required(viewer.host, 'file-rendered-region'), { key: 'x' });
        if (change === 'session') mockState = markdownState({ canEdit: false });
        if (change === 'store')
          mockState = { ...markdownState(), canEdit: false };
        viewer.rerender(
          <FileViewer
            request={REQUEST}
            renderEditor={editor}
            rawViewLabel="edit"
            active={change !== 'inactive'}
            viewMode={change === 'view' ? 'raw' : 'preview'}
            alternateContent={
              change === 'alternate' ? <div>Diff</div> : undefined
            }
          />,
        );
        if (change === 'store') {
          expect(byTestId(viewer.host, 'file-readonly-hint')).not.toBeNull();
        } else {
          expect(byTestId(viewer.host, 'file-readonly-hint')).toBeNull();
        }
        mockState = markdownState();
        viewer.rerender(
          <FileViewer
            request={REQUEST}
            renderEditor={editor}
            rawViewLabel="edit"
          />,
        );
        if (change === 'store') {
          expect(byTestId(viewer.host, 'file-readonly-hint')).not.toBeNull();
        } else {
          expect(byTestId(viewer.host, 'file-readonly-hint')).toBeNull();
        }
      } finally {
        viewer.unmount();
      }
    },
  );

  it('cancels delayed raw focus when editability changes before the host commits', () => {
    mockState = markdownState();
    const element = (editable: boolean, mode: FileViewMode): JSX.Element => (
      <FileViewer
        request={REQUEST}
        renderEditor={editable ? editor : undefined}
        viewMode={mode}
      />
    );
    const viewer = mount(element(true, 'preview'));
    try {
      keyDown(required(viewer.host, 'file-rendered-region'), { key: 'x' });
      const action = required<HTMLButtonElement>(
        viewer.host,
        'file-readonly-hint-switch',
      );
      act(() => action.focus());
      act(() => action.click());
      viewer.rerender(element(false, 'preview'));
      viewer.rerender(element(true, 'raw'));
      expect(document.activeElement).not.toBe(
        required(viewer.host, 'file-view-toggle-source'),
      );
    } finally {
      viewer.unmount();
    }
  });

  it('does not restore pending focus after unmounting the viewer', () => {
    mockState = markdownState();
    const viewer = mount(
      <FileViewer request={REQUEST} renderEditor={editor} viewMode="preview" />,
    );
    keyDown(required(viewer.host, 'file-rendered-region'), { key: 'x' });
    act(() =>
      required<HTMLButtonElement>(
        viewer.host,
        'file-readonly-hint-switch',
      ).click(),
    );
    const elsewhere = document.createElement('input');
    document.body.append(elsewhere);
    elsewhere.focus();
    viewer.unmount();
    const replacement = mount(
      <FileViewer request={REQUEST} renderEditor={editor} viewMode="raw" />,
    );
    try {
      expect(document.activeElement).toBe(elsewhere);
    } finally {
      replacement.unmount();
      elsewhere.remove();
    }
  });

  it('keeps persistent guidance outside an editable HTML preview', () => {
    mockState = baseState(
      session({
        path: 'docs/page.html',
        content: '<p>Hello</p>',
        viewMode: 'preview',
      }),
    );
    const viewer = mount(
      <FileViewer
        request={REQUEST}
        renderEditor={editor}
        rawViewLabel="edit"
      />,
    );
    try {
      const hint = required(viewer.host, 'file-readonly-hint');
      const region = required(viewer.host, 'file-rendered-region');
      expect(hint.getAttribute('role')).toBeNull();
      expect(region.contains(hint)).toBe(false);
      expect(byTestId(viewer.host, 'file-readonly-hint-dismiss')).toBeNull();
      expect(
        required(viewer.host, 'file-readonly-hint-switch').textContent,
      ).toBe('Switch to Edit');
      expect(viewer.host.contains(document.activeElement)).toBe(false);
      const frame = required(viewer.host, 'html-file-preview-frame');
      expect(frame.getAttribute('sandbox')).not.toContain('allow-same-origin');

      viewer.rerender(<FileViewer request={REQUEST} rawViewLabel="edit" />);
      expect(byTestId(viewer.host, 'file-readonly-hint')).toBeNull();
    } finally {
      viewer.unmount();
    }
  });
});

describe('FileViewer overlap comparison', () => {
  const CONTENT_LINES = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`);
  const MINE = [
    ...CONTENT_LINES.slice(0, 7),
    'Try it free',
    ...CONTENT_LINES.slice(8),
  ]
    .map((line) => `${line}\n`)
    .join('');
  const region = (
    index: number,
    ours: string,
    theirs: string,
    line: number,
  ): OverlapRegion => ({
    index,
    base: 'line 8\n',
    ours,
    theirs,
    baseLines: { line, lineCount: 1 },
    oursLines: { line, lineCount: ours === '' ? 0 : 1 },
    theirsLines: { line, lineCount: theirs === '' ? 0 : 1 },
  });
  const comparison = (
    overrides: Partial<FileOverlapComparison> = {},
  ): FileOverlapComparison => {
    const latest = {
      workspaceLocalId: 'w',
      worktreeLocalId: 'wt',
      path: 'notes.md',
      content: 'agent',
      size: 5,
      version: 'v2',
      truncated: false,
    };
    const regions = overrides.regions ?? [
      region(0, 'Try it free\n', 'Start your trial\n', 8),
    ];
    return {
      generation: 0,
      token: 'token-1',
      base: latest,
      ours: MINE,
      latest,
      regions,
      choices: regions.map(() => null),
      ...overrides,
    };
  };
  const overlapped = (
    overlap: FileOverlapComparison,
    sessionOverrides: Partial<FileViewerSession> = {},
  ): FileViewerSession =>
    session({
      path: 'notes.ts',
      content: MINE,
      dirty: true,
      externalChange: { reloading: false, error: null, source: 'agent-edit' },
      overlap,
      ...sessionOverrides,
    });
  const notice = (container: HTMLElement): HTMLElement | null =>
    container.querySelector('[data-testid="file-overlap-notice"]');
  const editor = jest
    .fn<JSX.Element, [FileEditorSlot]>()
    .mockReturnValue(<textarea data-testid="host-editor" />);

  beforeEach(() => {
    mockOpenFile.mockReset();
    mockOpenFile.mockResolvedValue(fileViewerKey(REQUEST));
    mockChooseOverlapVersion.mockReset();
    mockDismissExternalChange.mockReset();
    editor.mockClear();
  });

  it('shows one attributed comparison with both wordings and equal choices', () => {
    mockState = baseState(overlapped(comparison()));
    const viewer = mountViewer(
      <FileViewer request={REQUEST} renderEditor={editor} appName="Canopy" />,
    );
    const shown = notice(viewer.container);
    expect(shown?.dataset.origin).toBe('refresh');
    expect(shown?.textContent).toContain('Canopy edited text you also changed');
    expect(shown?.textContent).toContain(
      'Pick a version. Everything else is kept.',
    );
    expect(
      viewer.container.querySelector(
        '[data-testid="file-external-change-notice"]',
      ),
    ).toBeNull();
    expect(
      viewer.container.querySelector(
        '[data-testid="file-save-conflict-notice"]',
      ),
    ).toBeNull();
    const ours = shown?.querySelector(
      '[data-testid="file-overlap-quote-ours"]',
    );
    const theirs = shown?.querySelector(
      '[data-testid="file-overlap-quote-theirs"]',
    );
    expect(ours?.textContent).toBe('Try it free');
    expect(theirs?.textContent).toBe('Start your trial');
    expect(ours?.classList.contains(REPLAY_BLOCK_CLASS)).toBe(true);
    expect(theirs?.classList.contains(REPLAY_BLOCK_CLASS)).toBe(true);
    const choices = Array.from(
      shown?.querySelectorAll<HTMLButtonElement>(
        '[data-testid^="file-overlap-choose-"]',
      ) ?? [],
    );
    expect(choices.map((button) => button.textContent)).toEqual([
      'Keep mine',
      "Use Canopy's",
    ]);
    expect(choices.map((button) => button.getAttribute('aria-label'))).toEqual([
      'Keep mine',
      "Use Canopy's",
    ]);
    expect(choices[0]?.className).toBe(choices[1]?.className);
    expect(shown?.textContent).toContain("Canopy's");
    expect(shown?.textContent).not.toContain('Passage 1 of 1');
    // File content never reaches accessible names.
    expect(
      Array.from(shown?.querySelectorAll('[aria-label]') ?? []).some((node) =>
        node.getAttribute('aria-label')?.includes('Try it free'),
      ),
    ).toBe(false);
    viewer.unmount();
  });

  it('uses neutral, plural copy and labels each passage', () => {
    mockState = baseState(
      overlapped(
        comparison({
          regions: [
            region(0, 'Try it free\n', '', 8),
            region(1, 'a\n', 'b\n', 10),
          ],
          choices: ['theirs', null],
        }),
        { externalChange: { reloading: false, error: null, source: null } },
      ),
    );
    const viewer = mountViewer(
      <FileViewer request={REQUEST} renderEditor={editor} appName="Canopy" />,
    );
    const shown = notice(viewer.container);
    expect(shown?.textContent).toContain(
      'This document changed in 2 places you also edited',
    );
    expect(shown?.textContent).toContain(
      'Pick a version for each. Everything else is kept.',
    );
    const groups = Array.from(
      shown?.querySelectorAll('[data-testid="file-overlap-passage"]') ?? [],
    );
    expect(
      groups.map((group) =>
        group.querySelector('[role="group"]')?.getAttribute('aria-label'),
      ),
    ).toEqual(['Passage 1 of 2', 'Passage 2 of 2']);
    expect(groups[0]?.textContent).toContain('Use latest');
    expect(
      groups[0]?.querySelector('[data-testid="file-overlap-quote-theirs"]')
        ?.textContent,
    ).toBe('(nothing)');
    const chosen = groups[0]?.querySelector(
      '[data-testid="file-overlap-choose-theirs"]',
    );
    expect(chosen?.getAttribute('aria-pressed')).toBe('true');
    expect(chosen?.getAttribute('aria-label')).toBe('Use latest for passage 1');
    expect(groups[1]?.getAttribute('data-active-passage')).toBe('true');
    viewer.unmount();
  });

  it('passes the exact token, passage, and side; Decide later dismisses', () => {
    mockState = baseState(overlapped(comparison()));
    const viewer = mountViewer(
      <FileViewer request={REQUEST} renderEditor={editor} />,
    );
    act(() =>
      viewer.container
        .querySelector<HTMLButtonElement>(
          '[data-testid="file-overlap-choose-theirs"]',
        )
        ?.click(),
    );
    expect(mockChooseOverlapVersion).toHaveBeenCalledWith(
      fileViewerKey(REQUEST),
      'token-1',
      0,
      'theirs',
    );
    act(() =>
      viewer.container
        .querySelector<HTMLButtonElement>(
          '[data-testid="file-overlap-decide-later"]',
        )
        ?.click(),
    );
    expect(mockDismissExternalChange).toHaveBeenCalledWith(
      fileViewerKey(REQUEST),
    );
    viewer.unmount();
  });

  it('chooses from anywhere on a row, but not while text is selected', () => {
    mockState = baseState(overlapped(comparison()));
    const viewer = mountViewer(
      <FileViewer request={REQUEST} renderEditor={editor} />,
    );
    const quote = viewer.container.querySelector<HTMLElement>(
      '[data-testid="file-overlap-quote-theirs"]',
    );
    act(() => quote?.click());
    expect(mockChooseOverlapVersion).toHaveBeenCalledWith(
      fileViewerKey(REQUEST),
      'token-1',
      0,
      'theirs',
    );
    mockChooseOverlapVersion.mockClear();
    const range = document.createRange();
    if (quote) range.selectNodeContents(quote);
    // jsdom keeps one range; replace any selection an earlier test left.
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    act(() => quote?.click());
    expect(mockChooseOverlapVersion).not.toHaveBeenCalled();
    window.getSelection()?.removeAllRanges();
    viewer.unmount();
  });

  it('quotes prose in the body font and code in monospace', () => {
    const fontOf = (relativePath: string): string => {
      mockState = baseState(
        overlapped(comparison(), { request: { ...REQUEST, relativePath } }),
      );
      const viewer = mountViewer(
        <FileViewer request={REQUEST} renderEditor={editor} />,
      );
      const quote = viewer.container.querySelector(
        '[data-testid="file-overlap-quote-ours"]',
      );
      const font = quote?.classList.contains('font-sans')
        ? 'sans'
        : quote?.classList.contains('font-mono')
          ? 'mono'
          : 'none';
      viewer.unmount();
      return font;
    };
    expect(fontOf('docs/grant.md')).toBe('sans');
    expect(fontOf('src/a.ts')).toBe('mono');
  });

  it('becomes the save-time alert, focuses the first choice once, and offers no Decide later', async () => {
    const latest = comparison().latest;
    const saveTime = (focusRequest: number): FileViewerSession =>
      overlapped(comparison(), {
        externalChange: null,
        saveConflict: {
          reason: 'overlap',
          source: 'agent-edit',
          origin: 'user',
          latest,
          resolving: null,
          error: null,
          focusRequest,
        },
      });
    mockState = baseState(saveTime(1));
    const viewer = mountViewer(
      <FileViewer request={REQUEST} renderEditor={editor} appName="Canopy" />,
    );
    const shown = notice(viewer.container);
    expect(shown?.dataset.origin).toBe('save');
    expect(shown?.querySelector('[role="alert"]')?.textContent).toContain(
      'Not saved',
    );
    expect(
      shown?.querySelector('[data-testid="file-overlap-decide-later"]'),
    ).toBeNull();
    const first = shown?.querySelector(
      '[data-testid="file-overlap-choose-ours"]',
    );
    expect(document.activeElement).toBe(first);

    (document.activeElement as HTMLElement | null)?.blur();
    await viewer.render(
      <FileViewer request={REQUEST} renderEditor={editor} appName="Canopy" />,
    );
    expect(document.activeElement).toBe(document.body);
    viewer.unmount();
  });

  it('disables choices while a save is in flight', () => {
    mockState = baseState(overlapped(comparison(), { status: 'saving' }));
    const viewer = mountViewer(
      <FileViewer request={REQUEST} renderEditor={editor} />,
    );
    const buttons = Array.from(
      notice(viewer.container)?.querySelectorAll('button') ?? [],
    );
    expect(buttons.every((button) => button.disabled)).toBe(true);
    viewer.unmount();
  });

  // Rosa corrects one Outcomes bullet; Canopy rewrites it.
  const bullet = (
    ours = '- 85% of participants complete the program\n',
    index = 0,
  ): OverlapRegion => ({
    ...region(index, ours, '- Most participants finish the program\n', 9),
    base: '- 80% of participants complete the program\n',
  });
  const testId = (scope: Element | null | undefined, id: string): string =>
    scope?.querySelector(`[data-testid="${id}"]`)?.textContent ?? '';

  it('marks the correction and says the newer wording drops it', () => {
    mockState = baseState(overlapped(comparison({ regions: [bullet()] })));
    const viewer = mountViewer(
      <FileViewer request={REQUEST} renderEditor={editor} appName="Canopy" />,
    );
    const shown = notice(viewer.container);
    // The mark shows the correction, so no note repeats it.
    expect(
      shown?.querySelector('[data-testid="file-overlap-your-change"]'),
    ).toBeNull();
    expect(testId(shown, 'file-overlap-consequence-theirs')).toBe(
      'Drops your change: 80% → 85%',
    );
    expect(testId(shown, 'file-overlap-consequence-ours')).toMatch(
      /^Drops Canopy's changes: /,
    );
    // Each choice is described by what it drops.
    const useTheirs = shown?.querySelector(
      '[data-testid="file-overlap-choose-theirs"]',
    );
    const describedBy = useTheirs?.getAttribute('aria-describedby') ?? '';
    expect(document.getElementById(describedBy)?.textContent).toBe(
      'Drops your change: 80% → 85%',
    );
    // The newer wording marks its own edits too.
    expect(
      shown
        ?.querySelector('[data-testid="file-overlap-quote-theirs"]')
        ?.querySelector('mark'),
    ).not.toBeNull();
    const quote = shown?.querySelector(
      '[data-testid="file-overlap-quote-ours"]',
    );
    // Marking keeps the quote text exact and inside the replay block.
    expect(quote?.textContent).toBe(
      '- 85% of participants complete the program',
    );
    expect(
      Array.from(quote?.querySelectorAll('mark') ?? []).map(
        (mark) => mark.textContent,
      ),
    ).toEqual(['85%']);
    for (const note of Array.from(
      shown?.querySelectorAll('[data-testid^="file-overlap-consequence-"]') ??
        [],
    )) {
      expect(note.querySelector(`.${REPLAY_BLOCK_CLASS}`)).not.toBeNull();
    }
    expect(
      Array.from(shown?.querySelectorAll('[aria-label]') ?? []).some((node) =>
        node.getAttribute('aria-label')?.includes('85%'),
      ),
    ).toBe(false);
    viewer.unmount();
  });

  it('invites comparison when newer wording replaces words the user deleted', () => {
    mockState = baseState(
      overlapped(
        comparison({
          regions: [
            {
              ...region(0, 'A long day.\n', 'A really long day.\n', 9),
              base: 'A very long day.\n',
            },
          ],
        }),
      ),
    );
    const viewer = mountViewer(
      <FileViewer request={REQUEST} renderEditor={editor} appName="Canopy" />,
    );
    const shown = notice(viewer.container);
    // The deleted word stays visible, struck, in the user's wording.
    const quote = shown?.querySelector(
      '[data-testid="file-overlap-quote-ours"]',
    );
    expect(quote?.querySelector('del')?.textContent?.trim()).toBe('very');
    expect(testId(shown, 'file-overlap-consequence-theirs')).toBe(
      'May drop your change: removed “very”',
    );
    viewer.unmount();
  });

  it('does not warn about a correction the newer wording also made', () => {
    mockState = baseState(
      overlapped(
        comparison({
          regions: [
            {
              ...region(
                0,
                'We serve 1,350 families in the county.\n',
                'We serve 1,350 families countywide.\n',
                9,
              ),
              base: 'We serve 1,200 families in the county.\n',
            },
          ],
        }),
      ),
    );
    const viewer = mountViewer(
      <FileViewer request={REQUEST} renderEditor={editor} appName="Canopy" />,
    );
    const shown = notice(viewer.container);
    expect(
      shown?.querySelector('[data-testid="file-overlap-quote-ours"] mark')
        ?.textContent,
    ).toBe('1,350');
    expect(
      shown?.querySelector('[data-testid="file-overlap-consequence-theirs"]'),
    ).toBeNull();
    viewer.unmount();
  });

  it('keeps the change summary visible while a long quote is collapsed', () => {
    const lines = Array.from({ length: 9 }, (_, i) => `line ${i}\n`);
    const base = lines.join('');
    const ours = base.replace('line 4', 'line 40');
    mockState = baseState(
      overlapped(
        comparison({
          regions: [{ ...region(0, ours, 'short\n', 8), base }],
        }),
      ),
    );
    const viewer = mountViewer(
      <FileViewer request={REQUEST} renderEditor={editor} />,
    );
    const shown = notice(viewer.container);
    expect(
      shown
        ?.querySelector('[data-testid="file-overlap-expand-ours"]')
        ?.getAttribute('aria-expanded'),
    ).toBe('false');
    expect(testId(shown, 'file-overlap-your-change')).toBe(
      'Your change: 4 → 40',
    );
    // Neutral copy names the newer version without attribution.
    expect(testId(shown, 'file-overlap-consequence-ours')).toMatch(
      /^Drops the latest change/,
    );
    viewer.unmount();
  });

  it('prepares a follow-up draft without choosing, dismissing, or editing', () => {
    const onAskToKeepEdits = jest.fn<void, [string]>();
    mockState = baseState(
      overlapped(comparison({ regions: [bullet(), bullet(undefined, 1)] })),
    );
    const viewer = mountViewer(
      <FileViewer
        request={REQUEST}
        renderEditor={editor}
        appName="Canopy"
        onAskToKeepEdits={onAskToKeepEdits}
      />,
    );
    const asks = Array.from(
      notice(viewer.container)?.querySelectorAll<HTMLButtonElement>(
        '[data-testid="file-overlap-ask-keep"]',
      ) ?? [],
    );
    expect(asks.map((button) => button.textContent)).toEqual([
      'Combine with AI',
      'Combine with AI',
    ]);
    expect(asks[1]?.getAttribute('aria-label')).toBe(
      'Combine with AI for passage 2',
    );
    act(() => asks[1]?.click());
    expect(onAskToKeepEdits).toHaveBeenCalledTimes(1);
    const prompt = onAskToKeepEdits.mock.calls[0]?.[0] ?? '';
    expect(prompt).toContain('In src/a.ts');
    expect(prompt).toContain('passage 2 of 2');
    expect(prompt).toContain('- 80% → 85%');
    expect(mockChooseOverlapVersion).not.toHaveBeenCalled();
    expect(mockDismissExternalChange).not.toHaveBeenCalled();
    expect(notice(viewer.container)).not.toBeNull();
    viewer.unmount();
  });

  it('offers the follow-up only for attributed changes with a host callback, and not while busy', () => {
    const onAskToKeepEdits = jest.fn<void, [string]>();
    const ask = (container: HTMLElement): HTMLButtonElement | null =>
      container.querySelector('[data-testid="file-overlap-ask-keep"]');

    mockState = baseState(
      overlapped(comparison({ regions: [bullet()] }), {
        externalChange: { reloading: false, error: null, source: null },
      }),
    );
    let viewer = mountViewer(
      <FileViewer
        request={REQUEST}
        renderEditor={editor}
        appName="Canopy"
        onAskToKeepEdits={onAskToKeepEdits}
      />,
    );
    expect(ask(viewer.container)).toBeNull();
    expect(
      viewer.container.querySelector(
        '[data-testid="file-overlap-choose-theirs"]',
      )?.textContent,
    ).toBe('Use latest');
    viewer.unmount();

    mockState = baseState(overlapped(comparison({ regions: [bullet()] })));
    viewer = mountViewer(
      <FileViewer request={REQUEST} renderEditor={editor} appName="Canopy" />,
    );
    expect(ask(viewer.container)).toBeNull();
    viewer.unmount();

    mockState = baseState(
      overlapped(comparison({ regions: [bullet()] }), { status: 'saving' }),
    );
    viewer = mountViewer(
      <FileViewer
        request={REQUEST}
        renderEditor={editor}
        appName="Canopy"
        onAskToKeepEdits={onAskToKeepEdits}
      />,
    );
    expect(ask(viewer.container)?.disabled).toBe(true);
    viewer.unmount();

    // The alternate presentation threads the same callback.
    mockState = baseState(overlapped(comparison({ regions: [bullet()] })));
    const out = renderToString(
      <FileViewer
        request={REQUEST}
        renderEditor={editor}
        appName="Canopy"
        onAskToKeepEdits={onAskToKeepEdits}
        alternateContent={<div data-testid="host-diff">Diff</div>}
      />,
    );
    expect(out).toContain('data-testid="file-overlap-ask-keep"');
  });

  it('collapses long quotes behind an accessible expand control', () => {
    const long = Array.from({ length: 9 }, (_, i) => `mine ${i}\n`).join('');
    mockState = baseState(
      overlapped(comparison({ regions: [region(0, long, 'short\n', 8)] })),
    );
    const viewer = mountViewer(
      <FileViewer request={REQUEST} renderEditor={editor} />,
    );
    const toggle = viewer.container.querySelector<HTMLButtonElement>(
      '[data-testid="file-overlap-expand-ours"]',
    );
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    expect(toggle?.getAttribute('aria-label')).toBe(
      'Show all of your wording for passage 1',
    );
    expect(
      viewer.container.querySelector(
        '[data-testid="file-overlap-expand-theirs"]',
      ),
    ).toBeNull();
    act(() => toggle?.click());
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
    expect(
      viewer.container.querySelector('[data-testid="file-overlap-quote-ours"]')
        ?.textContent,
    ).toBe(long.slice(0, -1));
    viewer.unmount();
  });

  it('shows exactly one notice over alternate content', () => {
    mockState = baseState(
      overlapped(comparison(), {
        saveConflict: {
          reason: 'overlap',
          source: null,
          origin: 'autosave',
          latest: null,
          resolving: null,
          error: null,
          focusRequest: 0,
        },
      }),
    );
    const out = renderToString(
      <FileViewer
        request={REQUEST}
        renderEditor={editor}
        alternateContent={<div data-testid="host-diff">Diff</div>}
      />,
    );
    expect(out.match(/data-testid="file-overlap-notice"/g)).toHaveLength(1);
    expect(out).not.toContain('file-save-conflict-notice');
  });

  it('reveals the active passage, keeps its revision while typing, and never replays an older host link', async () => {
    const hostLink: FileLineReveal = { line: 2, revision: 5 };
    mockState = baseState(overlapped(comparison()));
    const viewer = mountViewer(
      <FileViewer
        request={REQUEST}
        renderEditor={editor}
        revealLine={hostLink}
      />,
    );
    await flushEffects();
    const first = editor.mock.lastCall?.[0];
    expect(first?.reveal).toMatchObject({ line: 8, lineEnd: 8 });
    expect(first?.revealReady).toBe(true);
    const revision = first?.reveal?.revision;

    // Typing elsewhere re-analyzes with the same target: no new reveal.
    mockState = baseState(
      overlapped(comparison({ token: 'token-2' }), {
        content: `${MINE}x`,
      }),
    );
    await viewer.render(
      <FileViewer
        request={REQUEST}
        renderEditor={editor}
        revealLine={hostLink}
      />,
    );
    expect(editor.mock.lastCall?.[0].reveal?.revision).toBe(revision);

    // The next passage moves the target.
    mockState = baseState(
      overlapped(
        comparison({
          regions: [
            region(0, 'Try it free\n', 'Start\n', 8),
            region(1, 'line 11\n', 'eleven\n', 11),
          ],
          choices: ['ours', null],
        }),
      ),
    );
    await viewer.render(
      <FileViewer
        request={REQUEST}
        renderEditor={editor}
        revealLine={hostLink}
      />,
    );
    const moved = editor.mock.lastCall?.[0].reveal;
    expect(moved).toMatchObject({ line: 11 });
    expect(moved?.revision).not.toBe(revision);

    // Resolution clears the comparison: the older host link is not replayed.
    mockState = baseState(
      session({ path: 'notes.ts', content: MINE, dirty: true }),
    );
    await viewer.render(
      <FileViewer
        request={REQUEST}
        renderEditor={editor}
        revealLine={hostLink}
      />,
    );
    expect(editor.mock.lastCall?.[0].reveal).toBeUndefined();

    // A fresh host request after resolution works normally.
    await viewer.render(
      <FileViewer
        request={REQUEST}
        renderEditor={editor}
        revealLine={{ line: 3, revision: 6 }}
      />,
    );
    await flushEffects();
    const fresh = editor.mock.lastCall?.[0].reveal;
    expect(fresh).toMatchObject({ line: 3 });
    expect(fresh?.revision).not.toBe(moved?.revision);
    viewer.unmount();
  });

  it('clamps an end-of-file deletion anchor to the last line', async () => {
    mockState = baseState(
      overlapped(comparison({ regions: [region(0, '', 'gone\n', 40)] })),
    );
    const viewer = mountViewer(
      <FileViewer request={REQUEST} renderEditor={editor} />,
    );
    await flushEffects();
    expect(editor.mock.lastCall?.[0].reveal).toMatchObject({
      line: 12,
      lineEnd: 12,
    });
    viewer.unmount();
  });
  it('waits for an opening read before revealing an existing comparison after remount', async () => {
    let finish: ((key: string) => void) | undefined;
    mockOpenFile.mockReturnValueOnce(
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
    );
    mockState = baseState(overlapped(comparison()));
    const viewer = mountViewer(
      <FileViewer request={REQUEST} renderEditor={editor} />,
    );
    expect(editor.mock.lastCall?.[0].revealReady).toBe(false);
    await act(async () => {
      finish?.(fileViewerKey(REQUEST));
      await Promise.resolve();
    });
    expect(editor.mock.lastCall?.[0].revealReady).toBe(true);
    expect(editor.mock.lastCall?.[0].reveal).toMatchObject({ line: 8 });
    viewer.unmount();
  });

  it('reveals again when a replacement session compares the same version and coordinates', async () => {
    mockState = baseState(overlapped(comparison({ token: '0:1' })));
    const viewer = mountViewer(
      <FileViewer request={REQUEST} renderEditor={editor} />,
    );
    await flushEffects();
    const first = editor.mock.lastCall?.[0].reveal?.revision;
    mockState = baseState(
      overlapped(comparison({ token: '1:2', generation: 1 })),
    );
    await viewer.render(<FileViewer request={REQUEST} renderEditor={editor} />);
    expect(editor.mock.lastCall?.[0].reveal?.revision).not.toBe(first);
    viewer.unmount();
  });
  it('suppresses every old host request observed while a comparison was active', async () => {
    mockState = baseState(overlapped(comparison()));
    const view = (revision: number): JSX.Element => (
      <FileViewer
        request={REQUEST}
        renderEditor={editor}
        revealLine={{ line: revision, revision }}
      />
    );
    const viewer = mountViewer(view(2));
    await flushEffects();
    await viewer.render(view(3));
    mockState = baseState(
      session({ path: 'notes.ts', content: MINE, dirty: true }),
    );
    await viewer.render(view(2));
    expect(editor.mock.lastCall?.[0].reveal).toBeUndefined();
    await viewer.render(view(4));
    await flushEffects();
    expect(editor.mock.lastCall?.[0].reveal).toMatchObject({ line: 4 });
    viewer.unmount();
  });
  it('resets suppressed navigation when the same file reopens without a comparison', async () => {
    const view = (): JSX.Element => (
      <FileViewer
        request={REQUEST}
        renderEditor={editor}
        revealLine={{ line: 2, revision: 1 }}
      />
    );
    mockState = baseState(overlapped(comparison()));
    const viewer = mountViewer(view());
    await flushEffects();
    mockState = baseState(
      session({ path: 'notes.ts', content: MINE, generation: 1 }),
    );
    await viewer.render(view());
    await flushEffects();
    expect(editor.mock.lastCall?.[0].reveal).toMatchObject({ line: 2 });
    viewer.unmount();
  });
});
