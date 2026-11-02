/**
 * @jest-environment jsdom
 */
import { act, useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import type { JSX } from 'react';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { MonacoFileEditor } from '../MonacoFileEditor';
import { getEditorScrollPosition } from '@/lib/tab-scroll-positions';
import { rootClassList } from '@/test-utils/replay';

let mockLineCount = 200;
let mockModelPath = '/repo/src/secret.ts';
let mockModelChanged: (() => void) | undefined;
let mockEditorOptions: unknown;
const mockClears: jest.Mock[] = [];
const mockEditor = {
  getModel: (): {
    getLineCount: () => number;
    uri: { toString: () => string };
  } => ({
    getLineCount: (): number => mockLineCount,
    uri: { toString: (): string => mockModelPath },
  }),
  deltaDecorations: jest.fn(() => []),
  layout: jest.fn(),
  revealLineInCenter: jest.fn(),
  revealLineInCenterIfOutsideViewport: jest.fn(),
  hasTextFocus: jest.fn((): boolean => false),
  setPosition: jest.fn(),
  setScrollTop: jest.fn(),
  setScrollLeft: jest.fn(),
  createDecorationsCollection: jest.fn(() => {
    const clear = jest.fn();
    mockClears.push(clear);
    return { clear };
  }),
  onDidChangeModel: jest.fn((callback: () => void) => {
    mockModelChanged = callback;
    return { dispose: jest.fn() };
  }),
  onDidDispose: jest.fn(),
  onMouseUp: jest.fn(),
  onMouseDown: jest.fn(),
  onDidScrollChange: jest.fn(),
  addAction: jest.fn(),
  getDomNode: (): null => null,
};
jest.mock('@monaco-editor/react', () => ({
  __esModule: true,
  default: function MockMonacoEditor({
    onMount,
    options,
  }: {
    options?: unknown;
    onMount: (
      editor: typeof mockEditor,
      api: {
        KeyMod: { CtrlCmd: number };
        KeyCode: { KeyL: number };
        Uri: { parse: (path: string) => { toString: () => string } };
      },
    ) => void;
  }): JSX.Element {
    const mount = useRef(onMount);
    mockEditorOptions = options;
    useEffect(() => {
      mount.current(mockEditor, {
        KeyMod: { CtrlCmd: 1 },
        KeyCode: { KeyL: 2 },
        Uri: {
          parse: (path: string): { toString: () => string } => ({
            toString: (): string => path,
          }),
        },
      });
    }, []);
    return <div data-testid="monaco-editor" />;
  },
}));
jest.mock('@/lib/tab-scroll-positions', () => ({
  getEditorScrollPosition: jest.fn(),
  saveEditorScrollPosition: jest.fn(),
}));
jest.mock('monaco-editor', () => ({}), { virtual: true });
jest.mock('@/lib/monaco-setup', () => ({
  configureMonaco: (): void => {},
}));

describe('MonacoFileEditor', () => {
  it('blocks the editor root from session replay', (): void => {
    const markup = renderToStaticMarkup(
      <MonacoFileEditor
        tabId="tab-1"
        filePath="/repo/src/secret.ts"
        language="typescript"
        value="const secret = 1;"
        onChange={jest.fn()}
      />,
    );

    // The root mounts with the editor and its selection confirmation chip.
    expect(rootClassList(markup)).toEqual([
      POSTHOG_REPLAY_BLOCK_CLASS,
      'relative',
      'min-h-0',
      'flex-1',
    ]);
    expect(markup).toContain('data-testid="monaco-editor"');
  });
});

describe('MonacoFileEditor language options', () => {
  beforeAll(() => {
    Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
      value: true,
      configurable: true,
    });
  });

  it('switches a reused editor between prose and code options', () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    const renderLanguage = (filePath: string, language: string): void => {
      act(() => {
        root.render(
          <MonacoFileEditor
            tabId="tab-1"
            filePath={filePath}
            language={language}
            value="Participants P1–P8 — “quoted”"
            onChange={jest.fn()}
          />,
        );
      });
    };
    try {
      renderLanguage('/repo/src/index.ts', 'typescript');
      expect(mockEditorOptions).toMatchObject({
        wordWrap: 'off',
        unicodeHighlight: { ambiguousCharacters: true },
      });
      renderLanguage('/repo/docs/findings.md', 'markdown');
      expect(mockEditorOptions).toMatchObject({
        wordWrap: 'on',
        unicodeHighlight: { ambiguousCharacters: false },
      });
      renderLanguage('/repo/src/index.ts', 'typescript');
      expect(mockEditorOptions).toMatchObject({
        wordWrap: 'off',
        unicodeHighlight: { ambiguousCharacters: true },
      });
    } finally {
      act(() => root.unmount());
    }
  });
});

describe('Monaco file-link presentation', () => {
  beforeAll(() => {
    Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
      value: true,
      configurable: true,
    });
  });
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    mockClears.length = 0;
    jest.mocked(getEditorScrollPosition).mockReturnValue(undefined);
    mockLineCount = 200;
    mockModelPath = '/repo/src/secret.ts';
  });
  afterEach(() => jest.useRealTimers());

  it('waits for refreshed bytes before consuming a reveal and does not replay on edits', () => {
    const root = createRoot(document.createElement('div'));
    const render = (revealReady: boolean, value: string): void => {
      act(() =>
        root.render(
          <MonacoFileEditor
            tabId="file"
            filePath="/repo/src/secret.ts"
            language="typescript"
            value={value}
            onChange={jest.fn()}
            presentation={{ line: 150, lineEnd: 160, revision: 1 }}
            revealReady={revealReady}
          />,
        ),
      );
    };
    try {
      mockLineCount = 10;
      render(false, 'cached');
      expect(mockEditor.revealLineInCenter).not.toHaveBeenCalled();
      mockLineCount = 200;
      render(true, 'refreshed');
      expect(mockEditor.revealLineInCenter).toHaveBeenLastCalledWith(150);
      render(true, 'edited');
      expect(mockEditor.revealLineInCenter).toHaveBeenCalledTimes(1);
    } finally {
      act(() => root.unmount());
    }
  });

  it('reveals the first line, flashes whole lines, and replaces range/single/plain requests', () => {
    const root = createRoot(document.createElement('div'));
    const render = (
      presentation: { revision: number; line?: number; lineEnd?: number },
      value = 'loaded',
    ): void => {
      act(() =>
        root.render(
          <MonacoFileEditor
            tabId="file"
            filePath="/repo/src/secret.ts"
            language="typescript"
            value={value}
            onChange={jest.fn()}
            presentation={presentation}
          />,
        ),
      );
    };
    try {
      render({ revision: 1, line: 150, lineEnd: 160 });
      expect(mockEditor.revealLineInCenter).toHaveBeenLastCalledWith(150);
      expect(mockEditor.setPosition).toHaveBeenLastCalledWith({
        lineNumber: 150,
        column: 1,
      });
      expect(mockEditor.createDecorationsCollection).toHaveBeenLastCalledWith([
        expect.objectContaining({
          range: {
            startLineNumber: 150,
            startColumn: 1,
            endLineNumber: 160,
            endColumn: 1,
          },
          options: {
            className: 'canopy-editor-reveal-flash',
            isWholeLine: true,
          },
        }),
      ]);
      render({ revision: 1, line: 150, lineEnd: 160 }, 'edited');
      expect(mockEditor.revealLineInCenter).toHaveBeenCalledTimes(1);
      act(() => jest.advanceTimersByTime(800));
      render({ revision: 2, line: 150, lineEnd: 160 });
      act(() => jest.advanceTimersByTime(800));
      expect(mockClears[1]).not.toHaveBeenCalled();
      expect(mockClears[0]).toHaveBeenCalled();
      expect(mockEditor.revealLineInCenter).toHaveBeenCalledTimes(2);
      render({ revision: 3, line: 999, lineEnd: 1000 });
      expect(mockEditor.setPosition).toHaveBeenLastCalledWith({
        lineNumber: 200,
        column: 1,
      });
      render({ revision: 4, line: 155, lineEnd: 120 });
      expect(mockEditor.createDecorationsCollection).toHaveBeenLastCalledWith([
        expect.objectContaining({
          range: {
            startLineNumber: 155,
            startColumn: 1,
            endLineNumber: 155,
            endColumn: 1,
          },
        }),
      ]);
      render({ revision: 5 });
      expect(mockClears.at(-1)).toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(0);
      expect(mockEditor.revealLineInCenter).toHaveBeenCalledTimes(4);
    } finally {
      act(() => root.unmount());
    }
  });

  it('reveals and highlights without moving the caret of a focused editor', () => {
    mockEditor.hasTextFocus.mockReturnValue(true);
    const root = createRoot(document.createElement('div'));
    try {
      act(() =>
        root.render(
          <MonacoFileEditor
            tabId="file"
            filePath="/repo/src/secret.ts"
            language="typescript"
            value="loaded"
            onChange={jest.fn()}
            presentation={{ revision: 1, line: 150, lineEnd: 151 }}
          />,
        ),
      );
      expect(
        mockEditor.revealLineInCenterIfOutsideViewport,
      ).toHaveBeenCalledWith(150);
      expect(mockEditor.revealLineInCenter).not.toHaveBeenCalled();
      expect(mockEditor.setPosition).not.toHaveBeenCalled();
      expect(mockEditor.createDecorationsCollection).toHaveBeenLastCalledWith([
        expect.objectContaining({
          range: {
            startLineNumber: 150,
            startColumn: 1,
            endLineNumber: 151,
            endColumn: 1,
          },
        }),
      ]);
    } finally {
      mockEditor.hasTextFocus.mockReturnValue(false);
      act(() => root.unmount());
    }
  });

  it('waits for the matching model, clears on model change/unmount, and expires the latest flash only', () => {
    mockModelPath = '/repo/old.ts';
    const root = createRoot(document.createElement('div'));
    act(() =>
      root.render(
        <MonacoFileEditor
          tabId="file"
          filePath="/repo/src/secret.ts"
          language="typescript"
          value="loaded"
          onChange={jest.fn()}
          presentation={{ revision: 1, line: 150, lineEnd: 160 }}
        />,
      ),
    );
    expect(mockEditor.revealLineInCenter).not.toHaveBeenCalled();
    mockModelPath = '/repo/src/secret.ts';
    act(() => mockModelChanged?.());
    expect(mockEditor.revealLineInCenter).toHaveBeenLastCalledWith(150);
    act(() => jest.advanceTimersByTime(1600));
    expect(mockClears[0]).toHaveBeenCalledTimes(1);
    act(() => mockModelChanged?.());
    expect(mockEditor.revealLineInCenter).toHaveBeenCalledTimes(2);
    act(() => root.unmount());
    expect(mockClears.at(-1)).toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });
  it('does not let a deferred remembered scroll override a newer line request', () => {
    jest.mocked(getEditorScrollPosition).mockReturnValue({ top: 40, left: 8 });
    const root = createRoot(document.createElement('div'));
    const render = (presentation?: {
      revision: number;
      line: number;
    }): void => {
      act(() =>
        root.render(
          <MonacoFileEditor
            tabId="file"
            filePath="/repo/src/secret.ts"
            language="typescript"
            value="loaded"
            onChange={jest.fn()}
            presentation={presentation}
          />,
        ),
      );
    };
    try {
      render();
      render({ revision: 1, line: 150 });
      act(() => jest.advanceTimersByTime(16));
      expect(mockEditor.revealLineInCenter).toHaveBeenLastCalledWith(150);
      expect(mockEditor.setScrollTop).not.toHaveBeenCalled();
      expect(mockEditor.setScrollLeft).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
    }
  });

  it('restores remembered scrolling for a plain request without revealing a line', () => {
    jest.mocked(getEditorScrollPosition).mockReturnValue({ top: 40, left: 8 });
    const root = createRoot(document.createElement('div'));
    try {
      act(() =>
        root.render(
          <MonacoFileEditor
            tabId="file"
            filePath="/repo/src/secret.ts"
            language="typescript"
            value="loaded"
            onChange={jest.fn()}
            presentation={{ revision: 1 }}
          />,
        ),
      );
      act(() => jest.advanceTimersByTime(16));
      expect(mockEditor.setScrollTop).toHaveBeenCalledWith(40);
      expect(mockEditor.setScrollLeft).toHaveBeenCalledWith(8);
      expect(mockEditor.revealLineInCenter).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
    }
  });
});
