/** @jest-environment jsdom */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  INSERT_CHAT_TEXT_EVENT,
  type InsertChatTextDetail,
} from '@/lib/editorSelectionContext';
import { TerminalPane } from '../TerminalPane';

interface SharedTerminalPaneProps {
  terminalId: string;
  onSendToChat?: (text: string) => void;
  getPathsForFiles?: (files: ReadonlyArray<File>) => Promise<string[]>;
  onOpenLink?: (url: string) => void;
}

let mockSharedPaneProps: SharedTerminalPaneProps | undefined;
let mockWorktreeChats: Record<
  string,
  {
    tabs: Array<{ id: string; kind?: string; readOnly?: boolean }>;
    activeTabId: string;
    lastActiveEditableChatId?: string;
  }
> = {};

jest.mock('@canopy/ui-app/terminal', () => ({
  TerminalPane: (props: SharedTerminalPaneProps): JSX.Element => {
    mockSharedPaneProps = props;
    return <div data-testid="shared-terminal-pane" />;
  },
}));

jest.mock('@/stores/chatStore', () => ({
  useChatStore: {
    getState: (): unknown => ({ worktreeChats: mockWorktreeChats }),
  },
}));

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

describe('desktop TerminalPane host adapter', () => {
  let container: HTMLDivElement;
  let root: Root;
  let received: InsertChatTextDetail[];
  let handleInsert: (event: Event) => void;
  const getPathsForFiles = jest.fn(
    (files: ReadonlyArray<File>): Promise<string[]> =>
      Promise.resolve(files.map((file) => `/native/${file.name}`)),
  );
  const openExternal = jest.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    mockSharedPaneProps = undefined;
    mockWorktreeChats = {};
    received = [];
    handleInsert = (event: Event): void => {
      if (event instanceof CustomEvent) {
        const detail: unknown = event.detail;
        if (
          typeof detail === 'object' &&
          detail !== null &&
          'text' in detail &&
          typeof detail.text === 'string' &&
          'targetTabId' in detail &&
          typeof detail.targetTabId === 'string'
        ) {
          received.push({
            text: detail.text,
            targetTabId: detail.targetTabId,
          });
        }
      }
    };
    document.addEventListener(INSERT_CHAT_TEXT_EVENT, handleInsert);
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { getPathsForFiles, browser: { openExternal } },
    });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.removeEventListener(INSERT_CHAT_TEXT_EVENT, handleInsert);
    container.remove();
    getPathsForFiles.mockClear();
    openExternal.mockClear();
  });

  function renderPane(): void {
    act(() => {
      root.render(
        <TerminalPane
          terminalId="terminal-1"
          projectId="project-1"
          worktreeId="worktree-1"
          live
          restoreOnMount={false}
          readOnlyMessage={null}
          focused
          onFocus={jest.fn()}
        />,
      );
    });
  }

  it('routes selection text to the current editable chat tab', () => {
    mockWorktreeChats = {
      'project-1/worktree-1': {
        tabs: [
          { id: 'chat-1', kind: 'chat' },
          { id: 'chat-2', kind: 'chat' },
        ],
        activeTabId: 'chat-2',
      },
    };
    renderPane();

    mockSharedPaneProps?.onSendToChat?.('selected output');

    expect(received).toEqual([
      { text: 'selected output', targetTabId: 'chat-2' },
    ]);
  });

  it('uses the latest remembered editable chat when the active tab is a file', () => {
    mockWorktreeChats = {
      'project-1/worktree-1': {
        tabs: [
          { id: 'chat-1', kind: 'chat' },
          { id: 'file-1', kind: 'file' },
        ],
        activeTabId: 'file-1',
        lastActiveEditableChatId: 'chat-1',
      },
    };
    renderPane();

    mockSharedPaneProps?.onSendToChat?.('selected output');

    expect(received).toEqual([
      { text: 'selected output', targetTabId: 'chat-1' },
    ]);
  });

  it('does not dispatch when the worktree has no editable chat', () => {
    mockWorktreeChats = {
      'project-1/worktree-1': {
        tabs: [{ id: 'file-1', kind: 'file' }],
        activeTabId: 'file-1',
      },
    };
    renderPane();

    mockSharedPaneProps?.onSendToChat?.('selected output');

    expect(received).toEqual([]);
  });

  it('resolves dropped file paths lazily through the desktop bridge', async () => {
    renderPane();
    const file = new File([], 'notes.md');

    await expect(
      mockSharedPaneProps?.getPathsForFiles?.([file]),
    ).resolves.toEqual(['/native/notes.md']);
    expect(getPathsForFiles).toHaveBeenCalledWith([file]);
  });

  it('opens a clicked terminal link through the external browser bridge', () => {
    renderPane();
    mockSharedPaneProps?.onOpenLink?.('https://example.com/terminal-help');
    expect(openExternal).toHaveBeenCalledWith({
      url: 'https://example.com/terminal-help',
    });
  });
});
