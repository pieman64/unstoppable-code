/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { bindTerminalClient } from '@canopy/app-state/terminal';
import type {
  TerminalAttachResponse,
  TerminalSession,
} from '@canopy/protocol/terminal';
import {
  createFakeTerminalClient,
  type FakeTerminalClient,
} from '../../../../../app-state/src/terminal/__tests__/fake-terminal-client';
import {
  requestTerminalFocus,
  __resetTerminalFocusIntentForTests,
} from '../terminal-focus-intent';
import {
  dataTransferHasFiles,
  formatFilePathsForTerminalPaste,
  resolveDroppedFilePaths,
} from '../terminal-file-drop';
import { useSurfaceFindStore } from '../../../find/surface-find-store';
import { peekInstance } from '../terminal-instances';
import { TerminalPane } from '../TerminalPane';

let inputListener: ((data: string) => void) | null = null;
let selectionListener: (() => void) | null = null;
let searchResultsListener:
  | ((event: { resultIndex: number; resultCount: number }) => void)
  | null = null;
const replayWrite = jest.fn(
  (_data: Uint8Array, callback?: () => void): void => {
    inputListener?.('\x1b]10;rgb:0000/0000/0000\x07');
    callback?.();
  },
);
// Stand-in for xterm's own textarea: `term.focus()`/`term.blur()` move REAL
// DOM focus inside the cached container, so caret-ownership assertions
// (CAN-2309) exercise the same `document.activeElement` logic production does.
const termTextarea = document.createElement('textarea');
const entry = {
  term: {
    cols: 80,
    rows: 24,
    element: undefined,
    options: {
      disableStdin: false,
      cursorBlink: true,
      cursorInactiveStyle: 'outline',
    },
    buffer: { active: { viewportY: 0, length: 0 } },
    open: jest.fn(),
    resize: jest.fn(),
    write: replayWrite,
    onData: jest.fn((listener: (data: string) => void) => {
      inputListener = listener;
      return {
        dispose: jest.fn((): void => {
          if (inputListener === listener) inputListener = null;
        }),
      };
    }),
    onSelectionChange: jest.fn((listener: () => void) => {
      selectionListener = listener;
      return { dispose: jest.fn() };
    }),
    onScroll: jest.fn(() => ({ dispose: jest.fn() })),
    getSelection: jest.fn(() => ''),
    getSelectionPosition: jest.fn<
      | {
          start: { x: number; y: number };
          end: { x: number; y: number };
        }
      | undefined,
      []
    >(() => undefined),
    clearSelection: jest.fn(),
    paste: jest.fn(),
    blur: jest.fn((): void => termTextarea.blur()),
    focus: jest.fn((): void => termTextarea.focus()),
  },
  fit: {
    proposeDimensions: jest.fn<{ cols: number; rows: number } | undefined, []>(
      () => undefined,
    ),
  },
  search: {
    findNext: jest.fn((): boolean => {
      // The addon selects the match, then reports the results.
      selectionListener?.();
      searchResultsListener?.({ resultIndex: 0, resultCount: 2 });
      return true;
    }),
    findPrevious: jest.fn((): boolean => true),
    clearDecorations: jest.fn(),
    onDidChangeResults: jest.fn(
      (
        listener: (event: { resultIndex: number; resultCount: number }) => void,
      ) => {
        searchResultsListener = listener;
        return {
          dispose: jest.fn((): void => {
            if (searchResultsListener === listener) {
              searchResultsListener = null;
            }
          }),
        };
      },
    ),
  },
  findShortcutClaimed: false,
  disposed: false,
  container: document.createElement('div'),
  lastReplayedSeq: -1,
  pendingReplayWrites: 0,
  attached: false,
  inputDisposable: null,
  outputDisposable: null,
};

jest.mock('../terminal-instances', () => ({
  TERMINAL_BG_COLOR: '#0b0c10',
  TERMINAL_FIND_DECORATIONS: {
    matchOverviewRuler: '#2b3a2b',
    activeMatchColorOverviewRuler: '#7a5a14',
  },
  getOrCreateInstance: jest.fn(() => entry),
  peekInstance: jest.fn(() => entry),
}));
jest.mock('../terminal-links', () => ({
  installTerminalLinks: jest.fn(() => jest.fn()),
}));
jest.mock('../terminal-file-drop', () => ({
  dataTransferHasFiles: jest.fn(() => false),
  formatFilePathsForTerminalPaste: jest.fn(() => ''),
  resolveDroppedFilePaths: jest.fn(() => Promise.resolve([])),
}));

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});
Object.defineProperty(globalThis, 'ResizeObserver', {
  configurable: true,
  value: class {
    observe(): void {}
    disconnect(): void {}
  },
});

describe('TerminalPane', () => {
  let container: HTMLDivElement;
  let root: Root | null;
  let fake: FakeTerminalClient;
  let disposeBinding: () => void;
  let resolveAttach: ((response: TerminalAttachResponse) => void) | undefined;
  let rejectAttach: ((error: Error) => void) | undefined;

  beforeEach(() => {
    inputListener = null;
    selectionListener = null;
    resolveAttach = undefined;
    rejectAttach = undefined;
    replayWrite.mockClear();
    entry.attached = false;
    entry.lastReplayedSeq = -1;
    entry.pendingReplayWrites = 0;
    entry.inputDisposable = null;
    entry.outputDisposable = null;
    entry.container.replaceChildren(termTextarea);
    entry.term.focus.mockClear();
    entry.term.blur.mockClear();
    entry.term.getSelection.mockReset();
    entry.term.getSelection.mockReturnValue('');
    entry.term.getSelectionPosition.mockReset();
    entry.term.getSelectionPosition.mockReturnValue(undefined);
    entry.term.onSelectionChange.mockClear();
    __resetTerminalFocusIntentForTests();
    fake = createFakeTerminalClient();
    fake.calls.commands['terminal.attach'].mockImplementation(
      () =>
        new Promise<TerminalAttachResponse>((resolve, reject) => {
          resolveAttach = resolve;
          rejectAttach = reject;
        }),
    );
    disposeBinding = bindTerminalClient(fake.client);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    if (root) act(() => root?.unmount());
    disposeBinding();
    container.remove();
    jest.restoreAllMocks();
  });

  async function renderSelectionPane(
    onSendToChat?: (text: string) => void,
  ): Promise<void> {
    entry.term.getSelection.mockReturnValue('selected terminal text');
    entry.term.getSelectionPosition.mockReturnValue({
      start: { x: 0, y: 0 },
      end: { x: 4, y: 0 },
    });
    const rect = {
      bottom: 400,
      height: 400,
      left: 0,
      right: 800,
      top: 0,
      width: 800,
      x: 0,
      y: 0,
      toJSON: (): Record<string, never> => ({}),
    };
    jest
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockReturnValue(rect);
    await act(async () => {
      root?.render(
        <TerminalPane
          terminalId="terminal-preset"
          live
          restoreOnMount={false}
          readOnlyMessage={null}
          focused
          onFocus={jest.fn()}
          onSendToChat={onSendToChat}
        />,
      );
      await Promise.resolve();
    });
    act(() => {
      selectionListener?.();
    });
  }

  describe('dropped files', () => {
    const file = new File(['x'], 'notes.md');
    let resolvePaths: ((paths: string[]) => void) | undefined;

    beforeEach(() => {
      entry.term.paste.mockClear();
      jest.mocked(dataTransferHasFiles).mockReturnValue(true);
      jest
        .mocked(formatFilePathsForTerminalPaste)
        .mockImplementation((paths: string[]) => `${paths.join(' ')} `);
      jest.mocked(resolveDroppedFilePaths).mockImplementation(
        () =>
          new Promise<string[]>((resolve) => {
            resolvePaths = resolve;
          }),
      );
    });

    afterEach(() => {
      jest.mocked(dataTransferHasFiles).mockReturnValue(false);
      jest.mocked(formatFilePathsForTerminalPaste).mockReturnValue('');
    });

    async function renderDropPane(
      live: boolean,
      terminalId = 'terminal-drop',
    ): Promise<void> {
      await act(async () => {
        root?.render(
          <TerminalPane
            terminalId={terminalId}
            live={live}
            restoreOnMount={false}
            readOnlyMessage={null}
            focused
            onFocus={jest.fn()}
            pasteDroppedFiles
            getPathsForFiles={(): Promise<string[]> => Promise.resolve([])}
          />,
        );
        await Promise.resolve();
      });
    }

    function drop(): void {
      const pane = container.querySelector('[data-testid="terminal-pane"]');
      if (!(pane instanceof HTMLDivElement)) {
        throw new Error('Expected terminal pane');
      }
      const event = new Event('drop', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'dataTransfer', {
        value: { types: ['Files'], files: [file] },
      });
      act(() => {
        pane.dispatchEvent(event);
      });
    }

    it('pastes the paths once the host has resolved them', async () => {
      await renderDropPane(true);
      drop();
      expect(entry.term.paste).not.toHaveBeenCalled();

      await act(async () => {
        resolvePaths?.(['/remote/uploads/notes.md']);
        await Promise.resolve();
      });

      expect(entry.term.paste).toHaveBeenCalledWith(
        '/remote/uploads/notes.md ',
      );
    });

    it('does not paste into another terminal shown while files uploaded', async () => {
      await renderDropPane(true);
      drop();
      await renderDropPane(true, 'terminal-other');

      await act(async () => {
        resolvePaths?.(['/remote/uploads/notes.md']);
        await Promise.resolve();
      });

      expect(entry.term.paste).not.toHaveBeenCalled();
    });

    it('does not paste after the pane unmounted while files uploaded', async () => {
      await renderDropPane(true);
      drop();
      act(() => root?.unmount());
      root = null;

      await act(async () => {
        resolvePaths?.(['/remote/uploads/notes.md']);
        await Promise.resolve();
      });

      expect(entry.term.paste).not.toHaveBeenCalled();
    });

    it('does not paste into a terminal that exited while files uploaded', async () => {
      await renderDropPane(true);
      drop();
      await renderDropPane(false);

      await act(async () => {
        resolvePaths?.(['/remote/uploads/notes.md']);
        await Promise.resolve();
      });

      expect(entry.term.paste).not.toHaveBeenCalled();
    });
  });

  describe('find bar', () => {
    const findStore = (): ReturnType<typeof useSurfaceFindStore.getState> =>
      useSurfaceFindStore.getState();

    afterEach(() => {
      findStore().close();
      for (const registered of Object.values(findStore().controllers)) {
        findStore().unregisterController(registered.controller);
      }
      useSurfaceFindStore.setState({ rememberedQueries: {} });
      entry.findShortcutClaimed = false;
    });

    async function renderFindPane(findTitle?: string): Promise<void> {
      await act(async () => {
        root?.render(
          <TerminalPane
            terminalId="terminal-find"
            live
            restoreOnMount={false}
            readOnlyMessage={null}
            focused
            onFocus={jest.fn()}
            findTitle={findTitle}
          />,
        );
        await Promise.resolve();
      });
    }

    function pane(): Element | null {
      return container.querySelector('[data-testid="terminal-pane"]');
    }

    it('marks the pane as a find surface only with a find title', async () => {
      await renderFindPane();
      expect(pane()?.hasAttribute('data-find-surface')).toBe(false);
      expect(pane()?.hasAttribute('tabindex')).toBe(false);
      expect(findStore().hasController('terminal', 'terminal-find')).toBe(
        false,
      );
      expect(entry.findShortcutClaimed).toBe(false);

      await renderFindPane('zsh');
      expect(pane()?.getAttribute('data-find-surface')).toBe('terminal');
      expect(pane()?.getAttribute('data-find-scope')).toBe('terminal-find');
      expect(pane()?.getAttribute('tabindex')).toBe('-1');
    });

    it('registers its controller after the mount effect sets the entry', async () => {
      await renderFindPane('zsh');

      expect(findStore().hasController('terminal', 'terminal-find')).toBe(true);
      expect(findStore().controllers['terminal:terminal-find']?.title).toBe(
        'zsh',
      );
      expect(entry.findShortcutClaimed).toBe(true);

      act(() => root?.unmount());
      root = null;
      expect(findStore().hasController('terminal', 'terminal-find')).toBe(
        false,
      );
      expect(entry.findShortcutClaimed).toBe(false);
    });

    it('hides the selection pill while a query selects matches', async () => {
      entry.term.getSelection.mockReturnValue('needle');
      entry.term.getSelectionPosition.mockReturnValue({
        start: { x: 0, y: 0 },
        end: { x: 6, y: 0 },
      });
      jest
        .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
        .mockReturnValue({
          bottom: 400,
          height: 400,
          left: 0,
          right: 800,
          top: 0,
          width: 800,
          x: 0,
          y: 0,
          toJSON: (): Record<string, never> => ({}),
        });
      await renderFindPane('zsh');
      const pill = (): Element | null =>
        container.querySelector('[data-testid="terminal-selection-copy"]');

      act(() => {
        findStore().openFor('terminal', 'terminal-find');
        findStore().setQuery('needle');
      });
      // Enter runs the pending search at once.
      act(() => findStore().next());
      expect(entry.search.findNext).toHaveBeenCalled();
      expect(pill()).toBeNull();
      expect(findStore().controllerStates['terminal:terminal-find']).toEqual({
        currentIndex: 0,
        totalCount: 2,
        error: null,
      });

      act(() => findStore().close());
      act(() => {
        selectionListener?.();
      });
      expect(pill()).not.toBeNull();
    });
  });

  it('sends selected text through the host callback from the menu', async () => {
    const onSendToChat = jest.fn<void, [string]>();
    await renderSelectionPane(onSendToChat);

    const button = container.querySelector(
      '[data-testid="terminal-selection-add-to-chat"]',
    );
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error('Expected terminal selection Add to chat button');
    }
    act(() => {
      button.click();
    });

    expect(onSendToChat).toHaveBeenCalledWith('selected terminal text');
  });

  it('sends selected text through the host callback from Cmd/Ctrl+L', async () => {
    const onSendToChat = jest.fn<void, [string]>();
    await renderSelectionPane(onSendToChat);
    const pane = container.querySelector('[data-testid="terminal-pane"]');
    if (!(pane instanceof HTMLDivElement)) {
      throw new Error('Expected terminal pane');
    }

    act(() => {
      pane.dispatchEvent(
        new KeyboardEvent('keydown', {
          bubbles: true,
          cancelable: true,
          key: 'l',
          metaKey: true,
        }),
      );
    });

    expect(onSendToChat).toHaveBeenCalledWith('selected terminal text');
  });

  it('hides Add to chat without a host callback but still owns selected Cmd/Ctrl+L', async () => {
    await renderSelectionPane();
    expect(
      container.querySelector('[data-testid="terminal-selection-add-to-chat"]'),
    ).toBeNull();
    const pane = container.querySelector('[data-testid="terminal-pane"]');
    if (!(pane instanceof HTMLDivElement)) {
      throw new Error('Expected terminal pane');
    }
    const parentKeyDown = jest.fn();
    container.addEventListener('keydown', parentKeyDown);
    const event = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
      key: 'L',
    });

    act(() => {
      pane.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(true);
    expect(parentKeyDown).not.toHaveBeenCalled();
  });

  describe('native context menu', () => {
    async function renderPane(
      suppressNativeContextMenu?: boolean,
    ): Promise<void> {
      await act(async () => {
        root?.render(
          <TerminalPane
            terminalId="terminal-preset"
            live
            restoreOnMount={false}
            readOnlyMessage={null}
            focused
            onFocus={jest.fn()}
            suppressNativeContextMenu={suppressNativeContextMenu}
          />,
        );
        await Promise.resolve();
      });
    }

    // xterm moves its helper textarea under the pointer on right-click, so
    // the menu request comes from that textarea.
    function rightClickTerminalTextarea(): MouseEvent {
      const event = new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        button: 2,
      });
      act(() => {
        termTextarea.dispatchEvent(event);
      });
      return event;
    }

    it('cancels the native menu when the desktop host opts out', async () => {
      await renderPane(true);
      expect(
        container
          .querySelector('[data-testid="terminal-pane"]')
          ?.contains(termTextarea),
      ).toBe(true);

      expect(rightClickTerminalTextarea().defaultPrevented).toBe(true);
    });

    it('keeps the browser menu without the opt-out (web portal)', async () => {
      await renderPane();

      expect(rightClickTerminalTextarea().defaultPrevented).toBe(false);
    });
  });

  it('does not forward terminal query responses produced while replaying history', async () => {
    await act(async () => {
      root?.render(
        <TerminalPane
          terminalId="terminal-preset"
          live
          restoreOnMount={false}
          readOnlyMessage={null}
          focused
          onFocus={jest.fn()}
        />,
      );
      await Promise.resolve();
    });

    await act(async () => {
      resolveAttach?.({
        session: {
          id: 'terminal-preset',
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          shell: '/bin/zsh',
          shellBasename: 'zsh',
          cwd: '/tmp',
          createdAt: 1,
        },
        replay: Uint8Array.from(Buffer.from('\x1b]10;?\x07')),
        seq: 7,
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fake.calls.commands['terminal.write']).not.toHaveBeenCalled();
    inputListener?.('user input');
    expect(fake.calls.commands['terminal.write']).toHaveBeenCalledWith({
      terminalId: 'terminal-preset',
      data: 'user input',
    });
  });

  it('keeps suppressing replay-generated responses after the pane remounts', async () => {
    await act(async () => {
      root?.render(
        <TerminalPane
          terminalId="terminal-preset"
          live
          restoreOnMount={false}
          readOnlyMessage={null}
          focused
          onFocus={jest.fn()}
        />,
      );
      await Promise.resolve();
    });

    await act(async () => {
      resolveAttach?.({
        session: {
          id: 'terminal-preset',
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          shell: '/bin/zsh',
          shellBasename: 'zsh',
          cwd: '/tmp',
          createdAt: 1,
        },
        replay: Uint8Array.from(Buffer.from('initial history')),
        seq: 1,
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    fake.calls.commands['terminal.write'].mockClear();
    act(() => {
      root?.unmount();
      root = createRoot(container);
    });

    await act(async () => {
      root?.render(
        <TerminalPane
          terminalId="terminal-preset"
          live
          restoreOnMount={false}
          readOnlyMessage={null}
          focused
          onFocus={jest.fn()}
        />,
      );
      await Promise.resolve();
    });

    await act(async () => {
      resolveAttach?.({
        session: {
          id: 'terminal-preset',
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          shell: '/bin/zsh',
          shellBasename: 'zsh',
          cwd: '/tmp',
          createdAt: 1,
        },
        replay: Uint8Array.from(Buffer.from('\x1b]10;?\x07')),
        seq: 7,
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fake.calls.commands['terminal.write']).not.toHaveBeenCalled();
  });

  it('forwards user input while attach is still pending', async () => {
    await act(async () => {
      root?.render(
        <TerminalPane
          terminalId="terminal-preset"
          live
          restoreOnMount={false}
          readOnlyMessage={null}
          focused
          onFocus={jest.fn()}
        />,
      );
      await Promise.resolve();
    });

    inputListener?.('typed before attach');

    expect(fake.calls.commands['terminal.write']).toHaveBeenCalledWith({
      terminalId: 'terminal-preset',
      data: 'typed before attach',
    });
  });

  describe('cached input ownership', () => {
    async function renderLivePane(target: Root | null = root): Promise<void> {
      await act(async () => {
        target?.render(
          <TerminalPane
            terminalId="terminal-preset"
            live
            restoreOnMount={false}
            readOnlyMessage={null}
            focused={false}
            onFocus={jest.fn()}
          />,
        );
        await Promise.resolve();
      });
    }

    function currentInput(): (data: string) => void {
      if (inputListener === null) throw new Error('Expected active input');
      return inputListener;
    }

    it('routes a cached remount to the replacement client and retains scrollback', async () => {
      await renderLivePane();
      currentInput()('before remount');
      entry.lastReplayedSeq = 7;
      entry.attached = true;
      const cachedContainer = entry.container;
      act(() => {
        root?.unmount();
        root = null;
      });
      disposeBinding();
      const replacement = createFakeTerminalClient();
      disposeBinding = bindTerminalClient(replacement.client);
      root = createRoot(container);

      await renderLivePane();
      currentInput()('after remount');
      expect(entry.lastReplayedSeq).toBe(7);
      replayWrite.mockImplementationOnce((): void => {});
      const frame = Uint8Array.from([65, 66]);
      replacement.emit('terminal.output', {
        terminalId: 'terminal-preset',
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        data: frame,
        seq: 9,
      });

      expect(fake.calls.commands['terminal.write'].mock.calls).toEqual([
        [{ terminalId: 'terminal-preset', data: 'before remount' }],
      ]);
      expect(replacement.calls.commands['terminal.write']).toHaveBeenCalledWith(
        {
          terminalId: 'terminal-preset',
          data: 'after remount',
        },
      );
      expect(
        replacement.calls.commands['terminal.attach'],
      ).toHaveBeenCalledWith({
        terminalId: 'terminal-preset',
      });
      expect(entry.container).toBe(cachedContainer);
      expect(entry.lastReplayedSeq).toBe(9);
      expect(replayWrite.mock.calls.at(-1)?.[0]).toBe(frame);
    });

    it('reconnects output while mounted and ignores a stale attach response', async () => {
      await renderLivePane();
      const obsoleteAttach = resolveAttach;
      const replacement = createFakeTerminalClient();
      await act(async () => {
        await Promise.resolve();
        disposeBinding = bindTerminalClient(replacement.client);
      });
      expect(fake.listenerCount('terminal.output')).toBe(0);
      expect(replacement.listenerCount('terminal.output')).toBe(1);
      expect(
        replacement.calls.commands['terminal.attach'],
      ).toHaveBeenCalledWith({
        terminalId: 'terminal-preset',
      });

      const frame = Uint8Array.from([65, 66]);
      replacement.emit('terminal.output', {
        terminalId: 'terminal-preset',
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        data: frame,
        seq: 2,
      });
      await act(async () => {
        await Promise.resolve();
        obsoleteAttach?.({
          session: {
            id: 'terminal-preset',
            projectId: 'project-1',
            worktreeId: 'worktree-1',
            shell: '/bin/zsh',
            shellBasename: 'zsh',
            cwd: '/tmp',
            createdAt: 1,
          },
          replay: Uint8Array.from([88]),
          seq: 100,
        });
      });
      expect(replayWrite.mock.calls.map(([data]) => data)).toEqual([frame]);
      expect(entry.lastReplayedSeq).toBe(2);
    });

    it('queues replacement output until replay fills the gap and trims overlapping bytes', async () => {
      await renderLivePane();
      entry.attached = true;
      entry.lastReplayedSeq = 2;
      const replacement = createFakeTerminalClient();
      let finishAttach:
        | ((response: TerminalAttachResponse) => void)
        | undefined;
      replacement.calls.commands['terminal.attach'].mockImplementation(
        () =>
          new Promise((resolve) => {
            finishAttach = resolve;
          }),
      );
      await act(async () => {
        await Promise.resolve();
        disposeBinding = bindTerminalClient(replacement.client);
      });
      replacement.emit('terminal.output', {
        terminalId: 'terminal-preset',
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        data: Uint8Array.from([68, 69, 70]),
        seq: 6,
      });
      expect(replayWrite).not.toHaveBeenCalled();
      await act(async () => {
        await Promise.resolve();
        finishAttach?.({
          session: {
            id: 'terminal-preset',
            projectId: 'project-1',
            worktreeId: 'worktree-1',
            shell: '/bin/zsh',
            shellBasename: 'zsh',
            cwd: '/tmp',
            createdAt: 1,
          },
          replay: Uint8Array.from([65, 66, 67, 68]),
          seq: 4,
        });
      });
      expect(replayWrite.mock.calls.map(([data]) => Array.from(data))).toEqual([
        [67, 68],
        [69, 70],
      ]);
      expect(entry.lastReplayedSeq).toBe(6);
    });

    it('suppresses queued replay responses after output ownership changes', async () => {
      let finishReplay: (() => void) | undefined;
      replayWrite.mockImplementationOnce((_data, callback): void => {
        finishReplay = callback;
      });
      await renderLivePane();
      await act(async () => {
        await Promise.resolve();
        resolveAttach?.({
          session: {
            id: 'terminal-preset',
            projectId: 'project-1',
            worktreeId: 'worktree-1',
            shell: '/bin/zsh',
            shellBasename: 'zsh',
            cwd: '/tmp',
            createdAt: 1,
          },
          replay: Uint8Array.from([65]),
          seq: 1,
        });
      });
      const replacement = createFakeTerminalClient();
      await act(async () => {
        await Promise.resolve();
        disposeBinding = bindTerminalClient(replacement.client);
      });
      currentInput()('\x1b]10;rgb:0000/0000/0000\x07');
      currentInput()('user input');
      expect(replacement.calls.commands['terminal.write'].mock.calls).toEqual([
        [{ terminalId: 'terminal-preset', data: 'user input' }],
      ]);
      await act(async () => {
        await Promise.resolve();
        finishReplay?.();
      });
      expect(entry.pendingReplayWrites).toBe(0);
    });

    it('tells the host why automatic restore failed and stays read-only', async () => {
      const failure = new Error('Terminal shell unavailable: gone');
      fake.calls.commands['terminal.restore'].mockRejectedValue(failure);
      const onRestoreFailed = jest.fn();
      await act(async () => {
        root?.render(
          <TerminalPane
            terminalId="terminal-preset"
            live={false}
            restoreOnMount
            readOnlyMessage="Ended"
            onRestoreFailed={onRestoreFailed}
            focused={false}
            onFocus={jest.fn()}
          />,
        );
        await Promise.resolve();
      });
      await act(async () => {
        await Promise.resolve();
      });
      expect(onRestoreFailed).toHaveBeenCalledTimes(1);
      expect(onRestoreFailed).toHaveBeenCalledWith(failure);
    });

    it('does not attach through an obsolete client after restore finishes', async () => {
      let finishRestore: ((session: TerminalSession) => void) | undefined;
      fake.calls.commands['terminal.restore'].mockImplementation(
        () =>
          new Promise((resolve) => {
            finishRestore = resolve;
          }),
      );
      await act(async () => {
        await Promise.resolve();
        root?.render(
          <TerminalPane
            terminalId="terminal-preset"
            live
            restoreOnMount
            readOnlyMessage={null}
            focused={false}
            onFocus={jest.fn()}
          />,
        );
      });
      await act(async () => {
        await Promise.resolve();
        disposeBinding = bindTerminalClient(createFakeTerminalClient().client);
        finishRestore?.({
          id: 'terminal-preset',
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          shell: '/bin/zsh',
          shellBasename: 'zsh',
          cwd: '/tmp',
          createdAt: 1,
        });
      });
      expect(fake.calls.commands['terminal.attach']).not.toHaveBeenCalled();
    });

    it('cancels pending resize work on disposal and resizes only the new binding', async () => {
      jest.useFakeTimers();
      const rect = {
        width: 800,
        height: 400,
        top: 0,
        bottom: 400,
        left: 0,
        right: 800,
        x: 0,
        y: 0,
        toJSON: (): Record<string, never> => ({}),
      };
      jest
        .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
        .mockReturnValue(rect);
      const dimensions = jest.spyOn(entry.fit, 'proposeDimensions');
      dimensions.mockReturnValue({ cols: 100, rows: 30 });
      try {
        await renderLivePane();
        const sentBeforeDisposal =
          fake.calls.commands['terminal.resize'].mock.calls.length;
        expect(sentBeforeDisposal).toBeGreaterThan(0);
        act(() => {
          window.dispatchEvent(new Event('resize'));
          disposeBinding();
        });
        act(() => {
          jest.runOnlyPendingTimers();
        });
        expect(fake.calls.commands['terminal.resize']).toHaveBeenCalledTimes(
          sentBeforeDisposal,
        );
        const replacement = createFakeTerminalClient();
        await act(async () => {
          await Promise.resolve();
          disposeBinding = bindTerminalClient(replacement.client);
        });
        expect(
          replacement.calls.commands['terminal.resize'],
        ).toHaveBeenCalledWith({
          terminalId: 'terminal-preset',
          cols: 100,
          rows: 30,
        });
      } finally {
        dimensions.mockRestore();
        jest.useRealTimers();
      }
    });

    it('exposes the fitted size on the pane only after a usable fit', async () => {
      const rect = {
        width: 800,
        height: 400,
        top: 0,
        bottom: 400,
        left: 0,
        right: 800,
        x: 0,
        y: 0,
        toJSON: (): Record<string, never> => ({}),
      };
      const bounds = jest
        .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
        .mockReturnValue({ ...rect, width: 0, height: 0, right: 0, bottom: 0 });
      const dimensions = jest.spyOn(entry.fit, 'proposeDimensions');
      dimensions.mockReturnValue({ cols: 2, rows: 1 });
      try {
        await renderLivePane();
        const pane = container.querySelector('[data-testid="terminal-pane"]');
        // A hidden pane proposes a transient size the guard rejects.
        expect(pane?.hasAttribute('data-terminal-cols')).toBe(false);
        expect(pane?.hasAttribute('data-terminal-rows')).toBe(false);

        bounds.mockReturnValue(rect);
        dimensions.mockReturnValue({ cols: 101, rows: 29 });
        act(() => {
          window.dispatchEvent(new Event('resize'));
        });
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 60));
        });
        expect(pane?.getAttribute('data-terminal-cols')).toBe('101');
        expect(pane?.getAttribute('data-terminal-rows')).toBe('29');
      } finally {
        dimensions.mockRestore();
      }
    });

    it('keeps exactly one output subscription across overlapping cached panes', async () => {
      await renderLivePane();
      const replacementContainer = document.createElement('div');
      document.body.append(replacementContainer);
      const replacementRoot = createRoot(replacementContainer);
      try {
        await renderLivePane(replacementRoot);
        expect(fake.listenerCount('terminal.output')).toBe(1);
        await act(async () => {
          await Promise.resolve();
          disposeBinding = bindTerminalClient(fake.client);
        });
        expect(fake.listenerCount('terminal.output')).toBe(1);
        act(() => {
          root?.unmount();
          root = null;
        });
        expect(fake.listenerCount('terminal.output')).toBe(1);
      } finally {
        act(() => replacementRoot.unmount());
        replacementContainer.remove();
      }
      expect(fake.listenerCount('terminal.output')).toBe(0);
    });

    it('releases input on unmount and fences a retained callback', async () => {
      await renderLivePane();
      const obsoleteInput = currentInput();
      act(() => {
        root?.unmount();
        root = null;
      });
      obsoleteInput('after unmount');

      expect(fake.calls.commands['terminal.write']).not.toHaveBeenCalled();
      expect(entry.inputDisposable).toBeNull();
      expect(inputListener).toBeNull();
    });

    it('releases input on binding disposal and fences same-client rebinding', async () => {
      await renderLivePane();
      const obsoleteInput = currentInput();
      disposeBinding();
      obsoleteInput('after disposal');
      expect(fake.calls.commands['terminal.write']).not.toHaveBeenCalled();
      expect(entry.inputDisposable).toBeNull();
      expect(inputListener).toBeNull();

      disposeBinding = bindTerminalClient(fake.client);
      obsoleteInput('after same-client rebind');
      currentInput()('current binding');

      expect(fake.calls.commands['terminal.write'].mock.calls).toEqual([
        [{ terminalId: 'terminal-preset', data: 'current binding' }],
      ]);
    });

    it('keeps replacement input when an overlapping old pane unmounts', async () => {
      await renderLivePane();
      const obsoleteInput = currentInput();
      const replacementContainer = document.createElement('div');
      document.body.append(replacementContainer);
      const replacementRoot = createRoot(replacementContainer);
      try {
        await renderLivePane(replacementRoot);
        obsoleteInput('after ownership transfer');
        act(() => {
          root?.unmount();
          root = null;
        });
        currentInput()('replacement pane');

        expect(fake.calls.commands['terminal.write'].mock.calls).toEqual([
          [{ terminalId: 'terminal-preset', data: 'replacement pane' }],
        ]);
      } finally {
        act(() => replacementRoot.unmount());
        replacementContainer.remove();
      }
    });
  });

  it('keeps forwarding user input after attach fails', async () => {
    await act(async () => {
      root?.render(
        <TerminalPane
          terminalId="terminal-preset"
          live
          restoreOnMount={false}
          readOnlyMessage={null}
          focused
          onFocus={jest.fn()}
        />,
      );
      await Promise.resolve();
      rejectAttach?.(new Error('attach failed'));
      await Promise.resolve();
    });

    inputListener?.('typed after failure');

    expect(fake.calls.commands['terminal.write']).toHaveBeenCalledWith({
      terminalId: 'terminal-preset',
      data: 'typed after failure',
    });
  });

  it('accounts for replay bytes written just before the pane unmounts', async () => {
    let finishReplay: (() => void) | undefined;
    let markReplayStarted: (() => void) | undefined;
    const replayStarted = new Promise<void>((resolve) => {
      markReplayStarted = resolve;
    });
    replayWrite.mockImplementationOnce(
      (_data: Uint8Array, callback?: () => void): void => {
        finishReplay = callback;
        markReplayStarted?.();
      },
    );

    await act(async () => {
      root?.render(
        <TerminalPane
          terminalId="terminal-preset"
          live
          restoreOnMount={false}
          readOnlyMessage={null}
          focused
          onFocus={jest.fn()}
        />,
      );
      await Promise.resolve();
    });

    await act(async () => {
      if (!resolveAttach) throw new Error('Expected attach to start');
      resolveAttach({
        session: {
          id: 'terminal-preset',
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          shell: '/bin/zsh',
          shellBasename: 'zsh',
          cwd: '/tmp',
          createdAt: 1,
        },
        replay: Uint8Array.from(Buffer.from('history')),
        seq: 7,
      });
      await replayStarted;
    });

    act(() => {
      root?.unmount();
      root = null;
    });
    await act(async () => {
      finishReplay?.();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(entry.lastReplayedSeq).toBe(7);
  });

  // CAN-2309 — a terminal may take the caret only when the user put it there.
  describe('caret ownership', () => {
    async function renderPane(props: {
      focused: boolean;
      live?: boolean;
      terminalId?: string;
    }): Promise<void> {
      await act(async () => {
        root?.render(
          <TerminalPane
            terminalId={props.terminalId ?? 'terminal-preset'}
            live={props.live ?? true}
            restoreOnMount={false}
            readOnlyMessage={null}
            focused={props.focused}
            onFocus={jest.fn()}
          />,
        );
        await Promise.resolve();
      });
    }

    it('does not take the caret merely by becoming the active visible pane', async () => {
      await renderPane({ focused: true });

      expect(entry.term.focus).not.toHaveBeenCalled();
    });

    it('does not take the caret when a cached pane remounts while selected', async () => {
      await renderPane({ focused: true });
      act(() => {
        root?.unmount();
        root = createRoot(container);
      });
      entry.term.focus.mockClear();

      await renderPane({ focused: true });

      expect(entry.term.focus).not.toHaveBeenCalled();
    });

    it('does not take the caret merely because a restarted session gets a new id', async () => {
      await renderPane({ focused: true, terminalId: 'terminal-preset' });

      await renderPane({ focused: true, terminalId: 'terminal-restarted' });

      expect(entry.term.focus).not.toHaveBeenCalled();
    });

    it('takes the caret for a recorded user gesture', async () => {
      requestTerminalFocus('terminal-preset');

      await renderPane({ focused: true });

      expect(entry.term.focus).toHaveBeenCalledTimes(1);
    });

    it('consumes the gesture once, so a later re-render does not re-claim', async () => {
      requestTerminalFocus('terminal-preset');
      await renderPane({ focused: true });
      entry.term.focus.mockClear();

      await renderPane({ focused: true });

      expect(entry.term.focus).not.toHaveBeenCalled();
    });

    it('reacts to a reveal that arrives after the pane is already mounted', async () => {
      await renderPane({ focused: true });
      expect(entry.term.focus).not.toHaveBeenCalled();

      await act(async () => {
        requestTerminalFocus('terminal-preset');
        await Promise.resolve();
      });

      expect(entry.term.focus).toHaveBeenCalledTimes(1);
    });

    it('ignores a gesture for a pane that is not the selected one', async () => {
      requestTerminalFocus('terminal-preset');

      await renderPane({ focused: false });

      expect(entry.term.focus).not.toHaveBeenCalled();

      await renderPane({ focused: true });

      expect(entry.term.focus).not.toHaveBeenCalled();
    });

    it('never takes the caret for a gesture the app backgrounded before honoring', async () => {
      requestTerminalFocus('terminal-preset');
      act(() => {
        window.dispatchEvent(new Event('blur'));
      });

      await renderPane({ focused: true });

      expect(entry.term.focus).not.toHaveBeenCalled();
    });

    it('never records a focus claim that arrives after the app is already backgrounded', async () => {
      await renderPane({ focused: true });
      act(() => {
        window.dispatchEvent(new Event('blur'));
        // Terminal spawn/managed-Claude launch is asynchronous: its focus
        // request can arrive after the user has already left the app.
        requestTerminalFocus('terminal-preset');
      });

      await renderPane({ focused: true });

      expect(entry.term.focus).not.toHaveBeenCalled();
    });

    it('does not claim on refocus after the app was backgrounded', async () => {
      await renderPane({ focused: true });
      act(() => {
        requestTerminalFocus('terminal-preset');
        window.dispatchEvent(new Event('blur'));
      });
      entry.term.focus.mockClear();

      act(() => {
        window.dispatchEvent(new Event('focus'));
      });
      await renderPane({ focused: true });

      expect(entry.term.focus).not.toHaveBeenCalled();
    });

    it('releases the caret and restores the predecessor when deselected', async () => {
      const composer = document.createElement('input');
      document.body.append(composer);
      composer.focus();
      requestTerminalFocus('terminal-preset');
      await renderPane({ focused: true });
      expect(entry.term.focus).toHaveBeenCalledTimes(1);

      await renderPane({ focused: false });

      expect(entry.term.blur).toHaveBeenCalledTimes(1);
      expect(document.activeElement).toBe(composer);
      composer.remove();
    });

    it('releases the caret when the app window loses focus', async () => {
      const composer = document.createElement('input');
      document.body.append(composer);
      composer.focus();
      requestTerminalFocus('terminal-preset');
      await renderPane({ focused: true });

      act(() => {
        window.dispatchEvent(new Event('blur'));
      });

      expect(entry.term.blur).toHaveBeenCalledTimes(1);
      expect(document.activeElement).toBe(composer);
      composer.remove();
    });

    it('refreshes the predecessor when a selected terminal is clicked again', async () => {
      const firstComposer = document.createElement('input');
      const secondComposer = document.createElement('input');
      document.body.append(firstComposer, secondComposer);
      firstComposer.focus();
      requestTerminalFocus('terminal-preset');
      await renderPane({ focused: true });
      expect(document.activeElement).toBe(termTextarea);

      secondComposer.focus();
      const pane = container.querySelector('[data-testid="terminal-pane"]');
      if (pane === null) throw new Error('Expected terminal pane');
      act(() => {
        pane.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        termTextarea.focus();
        window.dispatchEvent(new Event('blur'));
      });

      expect(document.activeElement).toBe(secondComposer);
      firstComposer.remove();
      secondComposer.remove();
    });

    it('never restores the caret to an inactive terminal after window blur', async () => {
      const siblingTerminal = document.createElement('div');
      siblingTerminal.className = 'xterm';
      const siblingTextarea = document.createElement('textarea');
      siblingTerminal.append(siblingTextarea);
      document.body.append(siblingTerminal);
      siblingTextarea.focus();

      requestTerminalFocus('terminal-preset');
      await renderPane({ focused: true });
      expect(document.activeElement).toBe(termTextarea);

      act(() => {
        window.dispatchEvent(new Event('blur'));
      });

      expect(document.activeElement).not.toBe(siblingTextarea);
      siblingTerminal.remove();
    });

    it('releases only once across repeated window blurs', async () => {
      requestTerminalFocus('terminal-preset');
      await renderPane({ focused: true });

      act(() => {
        window.dispatchEvent(new Event('blur'));
        window.dispatchEvent(new Event('blur'));
      });

      expect(entry.term.blur).toHaveBeenCalledTimes(1);
    });

    it('does not blur a pane that never held the caret', async () => {
      await renderPane({ focused: true });

      await renderPane({ focused: false });

      expect(entry.term.blur).not.toHaveBeenCalled();
    });

    it('does not yank the caret back when a sibling pane already took it', async () => {
      const composer = document.createElement('input');
      document.body.append(composer);
      composer.focus();
      requestTerminalFocus('terminal-preset');
      await renderPane({ focused: true });
      expect(document.activeElement).toBe(termTextarea);

      // A sibling pane's xterm focuses on mousedown, BEFORE this pane
      // re-renders as deselected.
      const sibling = document.createElement('textarea');
      document.body.append(sibling);
      sibling.focus();
      await renderPane({ focused: false });

      expect(document.activeElement).toBe(sibling);
      expect(entry.term.blur).not.toHaveBeenCalled();
      sibling.remove();
      composer.remove();
    });

    it('releases the caret on unmount while selected', async () => {
      const composer = document.createElement('input');
      document.body.append(composer);
      composer.focus();
      requestTerminalFocus('terminal-preset');
      await renderPane({ focused: true });

      act(() => {
        root?.unmount();
        root = null;
      });

      expect(entry.term.blur).toHaveBeenCalledTimes(1);
      expect(document.activeElement).toBe(composer);
      composer.remove();
    });

    // A split-pane sibling gets mousedowns while `focused` is false
    // (TerminalPanelSurface passes a no-op `onFocus`). The release effect only
    // returns a cleanup on its `focused && live` branch, so without an
    // unmount-time release that pane leaves a window `blur` listener attached
    // to a caretOwnerRef that outlived its component.
    it('releases the caret on unmount after a mousedown while unselected', async () => {
      const composer = document.createElement('input');
      document.body.append(composer);
      composer.focus();
      await renderPane({ focused: false });

      const pane = container.querySelector('[data-testid="terminal-pane"]');
      if (pane === null) throw new Error('Expected terminal pane');
      act(() => {
        pane.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        termTextarea.focus();
      });
      expect(document.activeElement).toBe(termTextarea);

      act(() => {
        root?.unmount();
        root = null;
      });

      expect(document.activeElement).toBe(composer);

      // The window blur listener went with it — a later blur must not reach a
      // stale owner and move the caret again.
      composer.focus();
      act(() => {
        window.dispatchEvent(new Event('blur'));
      });
      expect(document.activeElement).toBe(composer);
      composer.remove();
    });

    // An exited/read-only pane still focuses xterm's helper textarea on
    // mousedown even with `disableStdin`, so it has to participate in the
    // ownership lifecycle or it holds the caret with nothing to hand it back.
    it('releases the caret a read-only pane took on mousedown', async () => {
      const composer = document.createElement('input');
      document.body.append(composer);
      composer.focus();
      await renderPane({ focused: true, live: false });

      const pane = container.querySelector('[data-testid="terminal-pane"]');
      if (pane === null) throw new Error('Expected terminal pane');
      act(() => {
        pane.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        termTextarea.focus();
      });
      expect(document.activeElement).toBe(termTextarea);

      await renderPane({ focused: false, live: false });

      expect(document.activeElement).toBe(composer);
      composer.remove();
    });

    // Closing a terminal tab disposes the xterm entry before the pane
    // unmounts. Re-resolving the container from the registry at release time
    // then failed to recognise this pane's own detached textarea, so the
    // "caret already moved on" guard fired and the predecessor was stranded.
    it('restores the predecessor even when the instance is already disposed', async () => {
      const composer = document.createElement('input');
      document.body.append(composer);
      composer.focus();
      requestTerminalFocus('terminal-preset');
      await renderPane({ focused: true });
      expect(document.activeElement).toBe(termTextarea);

      const peek = jest.mocked(peekInstance);
      peek.mockReturnValueOnce(undefined);

      await renderPane({ focused: false });

      expect(document.activeElement).toBe(composer);
      composer.remove();
    });

    // A PTY exiting is not the user choosing a different surface. The pane
    // stays mounted and still selected, so releasing on that edge handed the
    // caret to the predecessor — typically the chat composer, which sends on
    // Enter — purely because a shell exited. The pane blurs its own textarea
    // when it goes read-only, so the caret parks on `body`; what matters is
    // that it does NOT jump into the composer.
    it('does not hand the caret to the composer when the PTY exits', async () => {
      const composer = document.createElement('input');
      document.body.append(composer);
      composer.focus();
      requestTerminalFocus('terminal-preset');
      await renderPane({ focused: true });
      expect(document.activeElement).toBe(termTextarea);

      await renderPane({ focused: true, live: false });

      expect(document.activeElement).not.toBe(composer);
      expect(document.activeElement).toBe(document.body);
      composer.remove();
    });

    // Ownership survives the PTY exit, so the ordinary deselect path still
    // hands the caret back rather than stranding it.
    it('still restores the predecessor when an exited pane is deselected', async () => {
      const composer = document.createElement('input');
      document.body.append(composer);
      composer.focus();
      requestTerminalFocus('terminal-preset');
      await renderPane({ focused: true });
      await renderPane({ focused: true, live: false });
      expect(document.activeElement).not.toBe(composer);

      await renderPane({ focused: false, live: false });

      expect(document.activeElement).toBe(composer);
      composer.remove();
    });

    it('restores the caret from a read-only pane when the window blurs', async () => {
      const composer = document.createElement('input');
      document.body.append(composer);
      composer.focus();
      await renderPane({ focused: true, live: false });

      const pane = container.querySelector('[data-testid="terminal-pane"]');
      if (pane === null) throw new Error('Expected terminal pane');
      act(() => {
        pane.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        termTextarea.focus();
      });

      act(() => {
        window.dispatchEvent(new Event('blur'));
      });

      expect(document.activeElement).toBe(composer);
      composer.remove();
    });
  });
});
