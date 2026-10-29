/** @jest-environment jsdom */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { FileViewerProps } from '../../code/file/FileViewer';
import { useSurfaceFindStore } from '../surface-find-store';
import { FindableFileViewer } from '../FindableFileViewer';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let viewerProps: FileViewerProps | null = null;

jest.mock('../../code/file/FileViewer', () => ({
  FileViewer: (props: FileViewerProps): JSX.Element => {
    viewerProps = props;
    return <div data-testid="file-viewer-stub" />;
  },
}));

describe('FindableFileViewer', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    viewerProps = null;
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    const store = useSurfaceFindStore.getState();
    store.close();
    for (const entry of Object.values(store.controllers)) {
      store.unregisterController(entry.controller);
    }
    host.remove();
  });

  it('marks the preview as a file scope named after the file and registers it once searchable', () => {
    act(() => {
      root.render(
        <FindableFileViewer
          findScope={{ key: 'docs/guide/README.md' }}
          request={{
            projectId: 'p',
            worktreeId: 'w',
            relativePath: 'docs/guide/README.md',
          }}
        />,
      );
    });

    const surface = host.querySelector('[data-find-surface="file"]');
    expect(surface?.getAttribute('data-find-scope')).toBe(
      'docs/guide/README.md',
    );
    expect(viewerProps?.previewSearchPresentation).toBe('headless');
    expect(viewerProps?.request.relativePath).toBe('docs/guide/README.md');
    expect(
      useSurfaceFindStore
        .getState()
        .hasController('file', 'docs/guide/README.md'),
    ).toBe(false);

    act(() => {
      viewerProps?.onPreviewSearchStateChange?.({
        enabled: true,
        open: false,
        queryPresent: false,
        currentIndex: 0,
        totalCount: 0,
      });
    });
    const store = useSurfaceFindStore.getState();
    expect(store.hasController('file', 'docs/guide/README.md')).toBe(true);
    expect(store.controllers['file:docs/guide/README.md']?.title).toBe(
      'README.md',
    );
  });
});
