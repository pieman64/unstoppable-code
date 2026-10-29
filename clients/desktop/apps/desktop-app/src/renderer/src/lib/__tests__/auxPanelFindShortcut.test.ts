/** @jest-environment jsdom */
import { handleAuxPanelFindShortcut } from '../auxPanelShortcuts';
import type { FindShortcutEvent } from '../find/findShortcut';
import {
  useSurfaceFindStore,
  type FindController,
  type FindSurfaceMode,
} from '@/stores/surfaceFindStore';

function register(
  mode: FindSurfaceMode,
  scopeKey: string,
  anchor: HTMLElement,
): FindController {
  const controller: FindController = {
    mode,
    scopeKey,
    title: scopeKey,
    anchor,
    setQuery: jest.fn(),
    next: jest.fn(),
    previous: jest.fn(),
    close: jest.fn(),
  };
  useSurfaceFindStore.getState().registerController(controller);
  return controller;
}

function cmdF(
  target: EventTarget | null,
): FindShortcutEvent & { preventDefault: jest.Mock } {
  // jsdom reports a non-mac platform, so the primary modifier is Ctrl.
  return {
    key: 'f',
    metaKey: false,
    ctrlKey: true,
    altKey: false,
    shiftKey: false,
    isComposing: false,
    target,
    preventDefault: jest.fn(),
  };
}

function childSurface(
  doc: Document,
  mode: FindSurfaceMode,
  scope: string,
): HTMLDivElement {
  const element = doc.createElement('div');
  element.setAttribute('data-find-surface', mode);
  element.setAttribute('data-find-scope', scope);
  return element;
}

afterEach(() => {
  const store = useSurfaceFindStore.getState();
  store.close();
  for (const entry of Object.values(store.controllers)) {
    store.unregisterController(entry.controller);
  }
});

describe('handleAuxPanelFindShortcut (CAN-3048)', () => {
  it('opens the find bar for a chat focused in the child window', () => {
    const childDocument = document.implementation.createHTMLDocument('aux');
    const chat = childSurface(childDocument, 'chat', 'c1');
    const composer = childDocument.createElement('textarea');
    chat.append(composer);
    childDocument.body.append(chat);
    composer.focus();
    const controller = register('chat', 'c1', chat);
    const readActiveGroupId = jest.fn(() => null);

    const event = cmdF(composer);
    expect(
      handleAuxPanelFindShortcut({ event, childDocument, readActiveGroupId }),
    ).toBe(true);

    expect(event.preventDefault).toHaveBeenCalled();
    const state = useSurfaceFindStore.getState();
    expect(state.mode).toBe('chat');
    expect(state.activeScope.chat).toBe('c1');
    // jsdom keeps focus out of a document without a browsing context, so
    // assert the opener is read from the child document, not the main one.
    expect(state.returnFocus).toBe(childDocument.activeElement);
    expect(state.returnFocus).not.toBe(document.activeElement);
    expect(controller.setQuery).toHaveBeenCalledWith('');
    expect(readActiveGroupId).not.toHaveBeenCalled();
  });

  it("falls back to the child window's active group", () => {
    const childDocument = document.implementation.createHTMLDocument('aux');
    const group = childDocument.createElement('div');
    group.setAttribute('data-testid', 'panel-group-g2');
    const file = childSurface(childDocument, 'file', 'tab-1');
    group.append(file);
    const otherGroup = childDocument.createElement('div');
    otherGroup.setAttribute('data-testid', 'panel-group-g1');
    const otherChat = childSurface(childDocument, 'chat', 'c1');
    otherGroup.append(otherChat);
    childDocument.body.append(otherGroup, group);
    register('file', 'tab-1', file);
    register('chat', 'c1', otherChat);

    const event = cmdF(childDocument.body);
    expect(
      handleAuxPanelFindShortcut({
        event,
        childDocument,
        readActiveGroupId: () => 'g2',
      }),
    ).toBe(true);

    const state = useSurfaceFindStore.getState();
    expect(state.mode).toBe('file');
    expect(state.activeScope.file).toBe('tab-1');
  });

  it('leaves the chord alone when nothing in the child window is searchable', () => {
    const childDocument = document.implementation.createHTMLDocument('aux');
    const event = cmdF(childDocument.body);

    expect(
      handleAuxPanelFindShortcut({
        event,
        childDocument,
        readActiveGroupId: () => null,
      }),
    ).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(useSurfaceFindStore.getState().open).toBe(false);
  });

  it('leaves terminal Ctrl+F to the shell', () => {
    const childDocument = document.implementation.createHTMLDocument('aux');
    const group = childDocument.createElement('div');
    group.setAttribute('data-testid', 'panel-group-g1');
    const chat = childSurface(childDocument, 'chat', 'c1');
    const terminal = childDocument.createElement('div');
    terminal.className = 'xterm';
    group.append(chat, terminal);
    childDocument.body.append(group);
    register('chat', 'c1', chat);

    const event = cmdF(terminal);
    expect(
      handleAuxPanelFindShortcut({
        event,
        childDocument,
        readActiveGroupId: () => 'g1',
      }),
    ).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(useSurfaceFindStore.getState().open).toBe(false);
  });

  /** A marked terminal pane holding xterm's helper textarea, in a group. */
  function terminalGroup(childDocument: Document): {
    pane: HTMLDivElement;
    textarea: HTMLTextAreaElement;
  } {
    const group = childDocument.createElement('div');
    group.setAttribute('data-testid', 'panel-group-g1');
    const chat = childSurface(childDocument, 'chat', 'c1');
    const pane = childSurface(childDocument, 'terminal', 't1');
    const xterm = childDocument.createElement('div');
    xterm.className = 'xterm';
    const textarea = childDocument.createElement('textarea');
    xterm.append(textarea);
    pane.append(xterm);
    group.append(chat, pane);
    childDocument.body.append(group);
    register('chat', 'c1', chat);
    return { pane, textarea };
  }

  function keyFrom(
    target: EventTarget,
    key: string,
    modifier: 'ctrl' | 'meta' = 'ctrl',
  ): FindShortcutEvent & { preventDefault: jest.Mock } {
    return {
      ...cmdF(target),
      key,
      ctrlKey: modifier === 'ctrl',
      metaKey: modifier === 'meta',
    };
  }

  it('opens terminal mode for Ctrl+F from a terminal with a registered controller', () => {
    const childDocument = document.implementation.createHTMLDocument('aux');
    const { pane, textarea } = terminalGroup(childDocument);
    register('terminal', 't1', pane);

    const event = cmdF(textarea);
    expect(
      handleAuxPanelFindShortcut({
        event,
        childDocument,
        readActiveGroupId: () => 'g1',
      }),
    ).toBe(true);

    expect(event.preventDefault).toHaveBeenCalled();
    const state = useSurfaceFindStore.getState();
    expect(state.mode).toBe('terminal');
    expect(state.activeScope.terminal).toBe('t1');
  });

  it('opens nothing from a marked terminal without a controller beside a registered chat', () => {
    const childDocument = document.implementation.createHTMLDocument('aux');
    const { textarea } = terminalGroup(childDocument);

    const event = cmdF(textarea);
    expect(
      handleAuxPanelFindShortcut({
        event,
        childDocument,
        readActiveGroupId: () => 'g1',
      }),
    ).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(useSurfaceFindStore.getState().open).toBe(false);
  });

  it('never falls back to a sibling chat for Cmd+F from an unmarked terminal on macOS', () => {
    const platform = jest
      .spyOn(navigator, 'platform', 'get')
      .mockReturnValue('MacIntel');
    const childDocument = document.implementation.createHTMLDocument('aux');
    const group = childDocument.createElement('div');
    group.setAttribute('data-testid', 'panel-group-g1');
    const chat = childSurface(childDocument, 'chat', 'c1');
    const terminal = childDocument.createElement('div');
    terminal.className = 'xterm';
    group.append(chat, terminal);
    childDocument.body.append(group);
    register('chat', 'c1', chat);

    const event = keyFrom(terminal, 'f', 'meta');
    expect(
      handleAuxPanelFindShortcut({
        event,
        childDocument,
        readActiveGroupId: () => 'g1',
      }),
    ).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(useSurfaceFindStore.getState().open).toBe(false);
    platform.mockRestore();
  });

  it.each(['b', 'r'])(
    'leaves Ctrl+%s in a registered terminal to the shell',
    (key) => {
      const childDocument = document.implementation.createHTMLDocument('aux');
      const { pane, textarea } = terminalGroup(childDocument);
      register('terminal', 't1', pane);

      const event = keyFrom(textarea, key);
      expect(
        handleAuxPanelFindShortcut({
          event,
          childDocument,
          readActiveGroupId: () => 'g1',
        }),
      ).toBe(false);
      expect(event.preventDefault).not.toHaveBeenCalled();
    },
  );
});
