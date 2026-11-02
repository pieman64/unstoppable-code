/** @jest-environment jsdom */
import { act, useState, type JSX } from 'react';
import { createRoot } from 'react-dom/client';
import type {
  FileViewerSession,
  FileViewerState,
  FileViewMode,
} from '@canopy/app-state';
import type { PortalFileReadPayload } from '@canopy/protocol/portal';

// Same controllable store seam as FileViewer.test.tsx.
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
import { FileViewer, type FileDocumentBytesResult } from '../FileViewer';

// jsdom omits the browser's TextDecoder, which the notebook loader uses to
// read resolved bytes. The fixtures are ASCII, so a byte-per-char decoder is
// exact here.
Object.assign(globalThis, {
  IS_REACT_ACT_ENVIRONMENT: true,
  TextDecoder: class AsciiTextDecoder {
    decode(input: ArrayBuffer): string {
      return String.fromCharCode(...new Uint8Array(input));
    }
  },
});

const REQUEST: PortalFileReadPayload = {
  projectId: 'p1',
  worktreeId: 'w1',
  relativePath: 'notebooks/analysis.ipynb',
};

const NOTEBOOK = JSON.stringify({
  nbformat: 4,
  nbformat_minor: 5,
  metadata: { language_info: { name: 'python' } },
  cells: [
    { cell_type: 'markdown', metadata: {}, source: ['# Results\n', 'Done.'] },
    {
      cell_type: 'code',
      metadata: {},
      execution_count: 1,
      source: 'print("hi")',
      outputs: [{ output_type: 'stream', name: 'stdout', text: 'hi\n' }],
    },
  ],
});

function baseState(session: FileViewerSession): FileViewerState {
  const key = fileViewerKey(REQUEST);
  return {
    files: { [key]: session },
    diffs: {},
    activeFileKey: key,
    activeDiffKey: null,
    canEdit: false,
    openFile: (): Promise<string> => Promise.resolve(key),
    updateContent: (): void => {},
    saveFile: (): Promise<boolean> => Promise.resolve(true),
    discardEdits: (): void => {},
    setViewMode: (): void => {},
    closeFile: (): void => {},
    openDiff: (): Promise<string> => Promise.resolve(''),
    closeDiff: (): void => {},
    refreshFile: (): Promise<void> => Promise.resolve(),
    markFileChanged: (): void => {},
    reloadFromDisk: (): Promise<boolean> => Promise.resolve(true),
    dismissExternalChange: (): void => {},
    overwriteWithEdits: (): Promise<boolean> => Promise.resolve(true),
    chooseOverlapVersion: (): void => {},
    notifyFileChanged: (): void => {},
  };
}

function session(
  content: string,
  options: { readonly truncated?: boolean } = {},
): FileViewerSession {
  return {
    key: fileViewerKey(REQUEST),
    request: REQUEST,
    preview: {
      workspaceLocalId: 'w',
      worktreeLocalId: 'wt',
      path: REQUEST.relativePath,
      content,
      size: content.length,
      version: 'v1',
      truncated: options.truncated === true,
    },
    content,
    dirty: false,
    viewMode: 'preview',
    status: 'idle',
    error: null,
    canEdit: false,
  };
}

/** A host that owns the view mode, like desktop's persisted file tabs. */
function ControlledViewer(props: {
  readonly initialMode: FileViewMode;
  readonly resolveDocumentBytes?: (
    request: PortalFileReadPayload,
    signal: AbortSignal,
  ) => Promise<FileDocumentBytesResult>;
}): JSX.Element {
  const [mode, setMode] = useState<FileViewMode>(props.initialMode);
  return (
    <FileViewer
      request={REQUEST}
      viewMode={mode}
      onViewModeChange={setMode}
      resolveDocumentBytes={props.resolveDocumentBytes}
    />
  );
}

function mount(element: JSX.Element): {
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

function byTestId(host: HTMLElement, testId: string): HTMLElement | null {
  return host.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
}

function click(host: HTMLElement, testId: string): void {
  const element = byTestId(host, testId);
  if (!element) throw new Error(`${testId} missing`);
  act(() => {
    element.click();
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function bytesOf(text: string): ArrayBuffer {
  // ASCII fixtures only (see the decoder above).
  const buffer = new ArrayBuffer(text.length);
  const view = new Uint8Array(buffer);
  for (let index = 0; index < text.length; index += 1) {
    view[index] = text.charCodeAt(index);
  }
  return buffer;
}

describe('FileViewer notebooks (CAN-5012)', () => {
  it('renders the notebook, switches to Source, and back to Formatted', () => {
    mockState = baseState(session(NOTEBOOK));
    const { host, unmount } = mount(<ControlledViewer initialMode="preview" />);
    try {
      expect(
        byTestId(host, 'file-view-toggle-formatted')?.getAttribute(
          'aria-pressed',
        ),
      ).toBe('true');
      const notebook = byTestId(host, 'file-notebook-preview');
      expect(notebook?.textContent).toContain('Results');
      expect(notebook?.textContent).toContain('print("hi")');
      expect(byTestId(host, 'file-viewer-raw-text-scroll')).toBeNull();

      click(host, 'file-view-toggle-source');
      expect(byTestId(host, 'file-notebook-preview')).toBeNull();
      expect(byTestId(host, 'file-viewer-raw-text-scroll')?.textContent).toBe(
        NOTEBOOK,
      );

      click(host, 'file-view-toggle-formatted');
      expect(byTestId(host, 'file-notebook-preview')).not.toBeNull();
      expect(byTestId(host, 'file-notebook-notice')).toBeNull();
    } finally {
      unmount();
    }
  });

  it('shows malformed JSON as source with a notice and no Formatted view', () => {
    const broken = '{"nbformat": 4, "cells": [';
    mockState = baseState(session(broken));
    const { host, unmount } = mount(<ControlledViewer initialMode="preview" />);
    try {
      expect(byTestId(host, 'file-notebook-preview')).toBeNull();
      expect(byTestId(host, 'file-view-toggle')).toBeNull();
      expect(byTestId(host, 'file-viewer-raw-text-scroll')?.textContent).toBe(
        broken,
      );
      expect(byTestId(host, 'file-notebook-notice')?.textContent).toBe(
        "This notebook can't be formatted. Showing its source.",
      );
    } finally {
      unmount();
    }
  });

  it('names the supported format for an older notebook', () => {
    const v3 = JSON.stringify({ nbformat: 3, worksheets: [] });
    mockState = baseState(session(v3));
    const { host, unmount } = mount(<ControlledViewer initialMode="preview" />);
    try {
      expect(byTestId(host, 'file-notebook-notice')?.textContent).toBe(
        'Only notebook format 4 can be formatted. Showing its source.',
      );
      expect(byTestId(host, 'file-viewer-raw-text-scroll')).not.toBeNull();
    } finally {
      unmount();
    }
  });

  it('loads the complete file for a truncated notebook when the host can read bytes', async () => {
    const partial = NOTEBOOK.slice(0, 40);
    mockState = baseState(session(partial, { truncated: true }));
    const resolveDocumentBytes = jest.fn<
      Promise<FileDocumentBytesResult>,
      [PortalFileReadPayload]
    >(
      (): Promise<FileDocumentBytesResult> =>
        Promise.resolve({ status: 'ready', bytes: bytesOf(NOTEBOOK) }),
    );
    const { host, unmount } = mount(
      <ControlledViewer
        initialMode="preview"
        resolveDocumentBytes={resolveDocumentBytes}
      />,
    );
    try {
      await flush();
      expect(resolveDocumentBytes).toHaveBeenCalledTimes(1);
      expect(resolveDocumentBytes.mock.calls[0]?.[0]).toEqual(REQUEST);
      const notebook = byTestId(host, 'file-notebook-preview');
      expect(notebook?.textContent).toContain('Results');
      // The complete notebook is on screen, so no "first N MB" banner.
      expect(host.textContent).not.toContain('File too large to edit');
      expect(byTestId(host, 'file-notebook-notice')).toBeNull();

      // Source shows the truncated text with the usual banner.
      click(host, 'file-view-toggle-source');
      expect(byTestId(host, 'file-viewer-raw-text-scroll')?.textContent).toBe(
        partial,
      );
      expect(host.textContent).toContain('File too large to edit');
    } finally {
      unmount();
    }
  });

  it('reloads a truncated notebook when the file version changes past its head', async () => {
    const partial = NOTEBOOK.slice(0, 40);
    const updated = NOTEBOOK.replace('Done.', 'Updated later.');
    mockState = baseState(session(partial, { truncated: true }));
    const resolveDocumentBytes = jest
      .fn<Promise<FileDocumentBytesResult>, []>()
      .mockResolvedValueOnce({ status: 'ready', bytes: bytesOf(NOTEBOOK) })
      .mockResolvedValueOnce({ status: 'ready', bytes: bytesOf(updated) });
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const render = (): void =>
      act(() => {
        root.render(
          <ControlledViewer
            initialMode="preview"
            resolveDocumentBytes={resolveDocumentBytes}
          />,
        );
      });
    try {
      render();
      await flush();
      expect(byTestId(host, 'file-notebook-preview')?.textContent).toContain(
        'Done.',
      );

      // Same readable head, new version: only the later cells changed.
      const changed = session(partial, { truncated: true });
      mockState = baseState({
        ...changed,
        preview: {
          ...changed.preview,
          workspaceLocalId: 'w',
          worktreeLocalId: 'wt',
          path: REQUEST.relativePath,
          content: partial,
          size: partial.length,
          truncated: true,
          version: 'v2',
        },
      });
      render();
      await flush();
      expect(resolveDocumentBytes).toHaveBeenCalledTimes(2);
      expect(byTestId(host, 'file-notebook-preview')?.textContent).toContain(
        'Updated later.',
      );
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });

  it('keeps the source with a notice when the complete notebook is over the limit', async () => {
    mockState = baseState(session('{"nb', { truncated: true }));
    const { host, unmount } = mount(
      <ControlledViewer
        initialMode="preview"
        resolveDocumentBytes={(): Promise<FileDocumentBytesResult> =>
          Promise.resolve({ status: 'too-large', maxBytes: 25 * 1024 * 1024 })
        }
      />,
    );
    try {
      await flush();
      expect(byTestId(host, 'file-notebook-preview')).toBeNull();
      expect(byTestId(host, 'file-notebook-notice')?.textContent).toBe(
        'This notebook exceeds the 25 MB preview limit. Showing the start of its source.',
      );
      expect(byTestId(host, 'file-viewer-raw-text-scroll')).not.toBeNull();
    } finally {
      unmount();
    }
  });

  it('says the source is partial when the complete notebook fails to load', async () => {
    mockState = baseState(session('{"nb', { truncated: true }));
    const { host, unmount } = mount(
      <ControlledViewer
        initialMode="preview"
        resolveDocumentBytes={(): Promise<FileDocumentBytesResult> =>
          Promise.resolve({ status: 'failed' })
        }
      />,
    );
    try {
      await flush();
      expect(byTestId(host, 'file-notebook-notice')?.textContent).toBe(
        "This notebook couldn't be loaded for preview. Showing the start of its source.",
      );
    } finally {
      unmount();
    }
  });

  it('shows a truncated notebook as source with a notice when the host cannot read bytes', () => {
    mockState = baseState(session(NOTEBOOK.slice(0, 40), { truncated: true }));
    const { host, unmount } = mount(<ControlledViewer initialMode="preview" />);
    try {
      expect(byTestId(host, 'file-notebook-preview')).toBeNull();
      expect(byTestId(host, 'file-view-toggle')).toBeNull();
      expect(byTestId(host, 'file-viewer-raw-text-scroll')).not.toBeNull();
      expect(byTestId(host, 'file-notebook-notice')?.textContent).toBe(
        'This notebook is too large to preview here. Showing the start of its source.',
      );
      // One banner, not the generic truncation banner as well.
      expect(host.textContent).not.toContain('File too large to edit');
    } finally {
      unmount();
    }
  });
});
