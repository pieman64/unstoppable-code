/** @jest-environment jsdom */

/**
 * Locks the chat read-state item in the shared PanelTabContextMenu: it shows
 * only on chat panels whose host passes both hooks and knows the chat's read
 * state, its label follows that state, and it stays out of close-only menus.
 */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { PanelTabContextMenu } from '../PanelTabContextMenu';
import {
  makeWorktreePanelKey,
  usePanelLayoutStore,
  type DefaultLayoutDescriptor,
} from '../panel-layout-store';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

const CHAT_LAYOUT: DefaultLayoutDescriptor = {
  orientation: 'horizontal',
  groups: [
    {
      kind: 'chat',
      groupId: 'group-a',
      panelId: 'panel-a',
      instance: { chatTabId: 'chat-a' },
    },
  ],
  containerSize: { width: 800, height: 600 },
};

const FILE_LAYOUT: DefaultLayoutDescriptor = {
  orientation: 'horizontal',
  groups: [
    {
      kind: 'file-diff',
      groupId: 'group-f',
      panelId: 'panel-f',
      instance: { filePath: '/repo/readme.md' },
    },
  ],
  containerSize: { width: 800, height: 600 },
};

const MARK_UNREAD = 'panel-tab-context-mark-unread';
const MARK_READ = 'panel-tab-context-mark-read';
const CHAT_TARGET = { groupId: 'group-a', panelId: 'panel-a', x: 10, y: 10 };

let keyCounter = 0;

function seededKey(layout: DefaultLayoutDescriptor): string {
  keyCounter += 1;
  const key = makeWorktreePanelKey('project', `read-state-${keyCounter}`);
  usePanelLayoutStore.getState().initializeLayout(key, layout);
  return key;
}

function render(node: JSX.Element): Root {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(node);
  });
  return root;
}

function byTestId(testId: string): Element | null {
  return document.body.querySelector(`[data-testid="${testId}"]`);
}

function clickButton(testId: string): void {
  const element = byTestId(testId);
  if (!(element instanceof HTMLButtonElement)) {
    throw new Error(`Expected button with data-testid ${testId}`);
  }
  act(() => {
    element.click();
  });
}

let roots: Root[] = [];

function mount(node: JSX.Element): void {
  roots.push(render(node));
}

afterEach(() => {
  act(() => {
    for (const root of roots) root.unmount();
  });
  roots = [];
  const store = usePanelLayoutStore.getState();
  for (const key of Object.keys(store.layouts)) {
    store.disposeLayout(key);
  }
  document.body.replaceChildren();
});

describe('PanelTabContextMenu chat read state', () => {
  test('a read chat offers Mark as unread, which marks it unread', () => {
    const key = seededKey(CHAT_LAYOUT);
    const onSetChatUnread = jest.fn();
    mount(
      <PanelTabContextMenu
        layoutKey={key}
        target={CHAT_TARGET}
        onClose={jest.fn()}
        getChatReadState={() => 'read'}
        onSetChatUnread={onSetChatUnread}
      />,
    );

    expect(byTestId(MARK_READ)).toBeNull();
    expect(byTestId(MARK_UNREAD)?.textContent).toContain('Mark as unread');
    clickButton(MARK_UNREAD);
    expect(onSetChatUnread).toHaveBeenCalledWith('chat-a', true);
  });

  test('an unread chat offers Mark as read, which marks it read', () => {
    const key = seededKey(CHAT_LAYOUT);
    const onSetChatUnread = jest.fn();
    mount(
      <PanelTabContextMenu
        layoutKey={key}
        target={CHAT_TARGET}
        onClose={jest.fn()}
        getChatReadState={() => 'unread'}
        onSetChatUnread={onSetChatUnread}
      />,
    );

    expect(byTestId(MARK_UNREAD)).toBeNull();
    expect(byTestId(MARK_READ)?.textContent).toContain('Mark as read');
    clickButton(MARK_READ);
    expect(onSetChatUnread).toHaveBeenCalledWith('chat-a', false);
  });

  test('reads the state for the clicked chat when the menu opens', () => {
    const key = seededKey(CHAT_LAYOUT);
    const getChatReadState = jest.fn(() => 'read' as const);
    mount(
      <PanelTabContextMenu
        layoutKey={key}
        target={CHAT_TARGET}
        onClose={jest.fn()}
        getChatReadState={getChatReadState}
        onSetChatUnread={jest.fn()}
      />,
    );

    expect(getChatReadState).toHaveBeenCalledWith('chat-a');
  });

  test('hidden when the host passes neither hook', () => {
    const key = seededKey(CHAT_LAYOUT);
    mount(
      <PanelTabContextMenu
        layoutKey={key}
        target={CHAT_TARGET}
        onClose={jest.fn()}
      />,
    );

    expect(byTestId(MARK_UNREAD)).toBeNull();
    expect(byTestId(MARK_READ)).toBeNull();
  });

  test('hidden without onSetChatUnread, and the state is not read', () => {
    const key = seededKey(CHAT_LAYOUT);
    const getChatReadState = jest.fn(() => 'read' as const);
    mount(
      <PanelTabContextMenu
        layoutKey={key}
        target={CHAT_TARGET}
        onClose={jest.fn()}
        getChatReadState={getChatReadState}
      />,
    );

    expect(byTestId(MARK_UNREAD)).toBeNull();
    expect(getChatReadState).not.toHaveBeenCalled();
  });

  test('hidden when the host has no read state for the chat', () => {
    const key = seededKey(CHAT_LAYOUT);
    mount(
      <PanelTabContextMenu
        layoutKey={key}
        target={CHAT_TARGET}
        onClose={jest.fn()}
        getChatReadState={() => undefined}
        onSetChatUnread={jest.fn()}
      />,
    );

    expect(byTestId(MARK_UNREAD)).toBeNull();
    expect(byTestId(MARK_READ)).toBeNull();
  });

  test('hidden on non-chat tabs', () => {
    const key = seededKey(FILE_LAYOUT);
    const getChatReadState = jest.fn(() => 'read' as const);
    mount(
      <PanelTabContextMenu
        layoutKey={key}
        target={{ groupId: 'group-f', panelId: 'panel-f', x: 10, y: 10 }}
        onClose={jest.fn()}
        getChatReadState={getChatReadState}
        onSetChatUnread={jest.fn()}
      />,
    );

    expect(byTestId('panel-tab-context-menu')).not.toBeNull();
    expect(byTestId(MARK_UNREAD)).toBeNull();
    expect(getChatReadState).not.toHaveBeenCalled();
  });

  test('hidden in the close-only menu of a locked classic layout', () => {
    const key = seededKey(CHAT_LAYOUT);
    mount(
      <PanelTabContextMenu
        layoutKey={key}
        target={CHAT_TARGET}
        onClose={jest.fn()}
        layoutLocked
        tabStyle="classic"
        getChatReadState={() => 'read'}
        onSetChatUnread={jest.fn()}
      />,
    );

    expect(byTestId('panel-tab-context-close')).not.toBeNull();
    expect(byTestId(MARK_UNREAD)).toBeNull();
  });

  test('sits in the first group, after Rename', () => {
    const key = seededKey(CHAT_LAYOUT);
    mount(
      <PanelTabContextMenu
        layoutKey={key}
        target={CHAT_TARGET}
        onClose={jest.fn()}
        onRenameChat={jest.fn()}
        getChatReadState={() => 'read'}
        onSetChatUnread={jest.fn()}
      />,
    );

    const ids = Array.from(
      document.body.querySelectorAll(
        '[data-testid="panel-tab-context-menu"] [data-testid^="panel-tab-context-"]',
      ),
      (element) => element.getAttribute('data-testid'),
    );
    expect(ids.slice(0, 3)).toEqual([
      'panel-tab-context-pin',
      'panel-tab-context-rename',
      MARK_UNREAD,
    ]);
  });
});
