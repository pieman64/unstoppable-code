/**
 * @jest-environment jsdom
 */
import { act, useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import type { JSX } from 'react';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { MonacoFileDiff } from '../MonacoFileDiff';
import type { FileDiffSnapshot } from '../useFileDiffSnapshot';
import { rootClassList } from '@/test-utils/replay';

const mockInnerEditorDisposeListeners: Array<() => void> = [];
const mockCreateEditor = jest.fn<{ dispose: () => void }, [HTMLElement]>();
const mockPane = (): Record<string, unknown> => ({
  onDidScrollChange: () => ({ dispose: jest.fn() }),
  addAction: () => ({ dispose: jest.fn() }),
  onMouseUp: () => ({ dispose: jest.fn() }),
  createDecorationsCollection: () => ({ clear: jest.fn() }),
  getModel: () => null,
  onDidDispose: (listener: () => void) => {
    mockInnerEditorDisposeListeners.push(listener);
    return { dispose: jest.fn() };
  },
});
const mockDiffInstance = {
  getOriginalEditor: mockPane,
  getModifiedEditor: mockPane,
  saveViewState: (): null => null,
  restoreViewState: jest.fn(),
};

jest.mock('@monaco-editor/react', () => ({
  DiffEditor: ({
    onMount,
  }: {
    onMount?: (instance: typeof mockDiffInstance) => void;
  }): JSX.Element => {
    // Like `@monaco-editor/react`, call the first `onMount` once.
    const mount = useRef(onMount);
    useEffect(() => mount.current?.(mockDiffInstance), []);
    return <div data-testid="diff-editor" />;
  },
}));
jest.mock(
  'monaco-editor',
  () => ({
    editor: {
      create: (element: HTMLElement): { dispose: () => void } =>
        mockCreateEditor(element),
      MouseTargetType: { GUTTER_GLYPH_MARGIN: 2 },
    },
  }),
  { virtual: true },
);
jest.mock('@/lib/monaco-setup', () => ({
  configureMonaco: (): void => {},
}));

const snapshot: FileDiffSnapshot = {
  data: {
    oldValue: 'const secret = 1;',
    newValue: 'const secret = 2;',
    filePath: 'src/secret.ts',
    source: 'uncommitted',
    truncated: true,
    binary: false,
  },
  identity: { source: 'uncommitted', snapshotId: 'snapshot-1' },
};

describe('MonacoFileDiff', () => {
  it('blocks the diff editor root from session replay', (): void => {
    const markup = renderToStaticMarkup(
      <MonacoFileDiff
        split={false}
        onSplitChange={jest.fn()}
        tabId="tab-1"
        filePath="src/secret.ts"
        snapshot={snapshot}
        threads={[]}
        annotations={[]}
        onOpenLine={jest.fn()}
        onComment={jest.fn()}
        viewState={{ current: { split: false } }}
      />,
    );

    expect(rootClassList(markup)).toEqual([
      POSTHOG_REPLAY_BLOCK_CLASS,
      'canopy-monaco-file-editor',
      'flex',
      'min-h-0',
      'flex-1',
      'flex-col',
    ]);
    expect(markup).toContain('data-testid="diff-editor"');
  });

  it('marks a cut diff with the shared notice the web shows (REG-3024)', (): void => {
    const markup = renderToStaticMarkup(
      <MonacoFileDiff
        split={false}
        onSplitChange={jest.fn()}
        tabId="tab-1"
        filePath="src/secret.ts"
        snapshot={snapshot}
        threads={[]}
        annotations={[]}
        onOpenLine={jest.fn()}
        onComment={jest.fn()}
        viewState={{ current: { split: false } }}
      />,
    );

    expect(markup).toContain('data-testid="diff-viewer-notice-oversized"');
    expect(markup).toContain(
      'This diff is too large to show in full. Showing the beginning.',
    );
    expect(markup).not.toContain('Diff truncated');
    expect(markup).not.toContain('fg-warning');
  });

  it('rebinds Monaco hover widgets to live services when the diff editor is disposed', (): void => {
    // A diff editor's inner editors bind Monaco's global hover-delegate factory
    // to services disposed with the diff; without a rebind, the next suggest,
    // context-menu or find widget in any editor throws "InstantiationService
    // has been disposed" and crashes the renderer.
    Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
      value: true,
      configurable: true,
    });
    const dispose = jest.fn();
    mockCreateEditor.mockReturnValue({ dispose });
    const container = document.createElement('div');
    const root = createRoot(container);
    act(() => {
      root.render(
        <MonacoFileDiff
          split={false}
          onSplitChange={jest.fn()}
          tabId="tab-1"
          filePath="src/secret.ts"
          snapshot={snapshot}
          threads={[]}
          annotations={[]}
          onOpenLine={jest.fn()}
          onComment={jest.fn()}
          viewState={{ current: { split: false } }}
        />,
      );
    });
    expect(mockCreateEditor).not.toHaveBeenCalled();

    mockInnerEditorDisposeListeners.forEach((listener) => listener());

    expect(mockCreateEditor).toHaveBeenCalledTimes(1);
    expect(mockCreateEditor.mock.calls[0]?.[0]).toBeInstanceOf(HTMLElement);
    expect(dispose).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
  });
});
