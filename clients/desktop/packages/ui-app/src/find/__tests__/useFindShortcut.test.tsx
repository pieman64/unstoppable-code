/** @jest-environment jsdom */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  useSurfaceFindStore,
  type FindController,
  type FindSurfaceMode,
} from '../surface-find-store';
import { useFindShortcut } from '../useFindShortcut';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function Shell(): JSX.Element {
  useFindShortcut();
  return <div />;
}

function register(
  scopeKey: string,
  anchor: HTMLElement,
  mode: FindSurfaceMode = 'chat',
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

function cmdF(target: Element): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key: 'f',
    metaKey: true,
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(event);
  return event;
}

describe('useFindShortcut', () => {
  let host: HTMLDivElement;
  let root: Root;
  const platform = Object.getOwnPropertyDescriptor(navigator, 'platform');

  beforeEach(() => {
    Object.defineProperty(navigator, 'platform', {
      configurable: true,
      value: 'MacIntel',
    });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    act(() => root.render(<Shell />));
  });

  afterEach(() => {
    act(() => root.unmount());
    const store = useSurfaceFindStore.getState();
    store.close();
    for (const entry of Object.values(store.controllers)) {
      store.unregisterController(entry.controller);
    }
    host.remove();
    document.body.replaceChildren();
    if (platform) Object.defineProperty(navigator, 'platform', platform);
  });

  it('opens the bar for the marked surface under the key press', () => {
    const surface = document.createElement('div');
    surface.setAttribute('data-find-surface', 'chat');
    surface.setAttribute('data-find-scope', 'c1');
    const inner = document.createElement('p');
    surface.append(inner);
    document.body.append(surface);
    register('c1', surface);

    const event = cmdF(inner);

    expect(event.defaultPrevented).toBe(true);
    expect(useSurfaceFindStore.getState().open).toBe(true);
    expect(useSurfaceFindStore.getState().activeScope.chat).toBe('c1');
  });

  it('falls back to the only registered surface when page chrome has focus', () => {
    const surface = document.createElement('div');
    surface.setAttribute('data-find-surface', 'chat');
    surface.setAttribute('data-find-scope', 'c1');
    document.body.append(surface);
    register('c1', surface);

    const event = cmdF(document.body);

    expect(event.defaultPrevented).toBe(true);
    expect(useSurfaceFindStore.getState().activeScope.chat).toBe('c1');
  });

  it('leaves the chord to a focused terminal even when a surface could take it', () => {
    const surface = document.createElement('div');
    surface.setAttribute('data-find-surface', 'chat');
    surface.setAttribute('data-find-scope', 'c1');
    document.body.append(surface);
    register('c1', surface);
    const terminal = document.createElement('div');
    terminal.className = 'xterm';
    document.body.append(terminal);

    const event = cmdF(terminal);

    expect(event.defaultPrevented).toBe(false);
    expect(useSurfaceFindStore.getState().open).toBe(false);
  });

  /** A pane marked as a terminal find surface, holding xterm's textarea. */
  function terminalPane(scopeKey: string): {
    pane: HTMLDivElement;
    textarea: HTMLTextAreaElement;
  } {
    const pane = document.createElement('div');
    pane.setAttribute('data-find-surface', 'terminal');
    pane.setAttribute('data-find-scope', scopeKey);
    const xterm = document.createElement('div');
    xterm.className = 'xterm';
    const textarea = document.createElement('textarea');
    xterm.append(textarea);
    pane.append(xterm);
    document.body.append(pane);
    return { pane, textarea };
  }

  it('opens terminal mode from a terminal with a registered controller', () => {
    const chat = document.createElement('div');
    chat.setAttribute('data-find-surface', 'chat');
    chat.setAttribute('data-find-scope', 'c1');
    document.body.append(chat);
    register('c1', chat);
    const { pane, textarea } = terminalPane('t1');
    register('t1', pane, 'terminal');

    const event = cmdF(textarea);

    expect(event.defaultPrevented).toBe(true);
    expect(useSurfaceFindStore.getState().mode).toBe('terminal');
    expect(useSurfaceFindStore.getState().activeScope.terminal).toBe('t1');
  });

  it('opens nothing from a marked terminal whose controller is not registered', () => {
    const chat = document.createElement('div');
    chat.setAttribute('data-find-surface', 'chat');
    chat.setAttribute('data-find-scope', 'c1');
    document.body.append(chat);
    register('c1', chat);
    const { textarea } = terminalPane('t1');

    const event = cmdF(textarea);

    expect(event.defaultPrevented).toBe(false);
    expect(useSurfaceFindStore.getState().open).toBe(false);
  });

  it('leaves a key press another handler already claimed, and one with no surface', () => {
    const surface = document.createElement('div');
    surface.setAttribute('data-find-surface', 'chat');
    surface.setAttribute('data-find-scope', 'c1');
    document.body.append(surface);
    register('c1', surface);
    surface.addEventListener('keydown', (event) => event.preventDefault());

    cmdF(surface);
    expect(useSurfaceFindStore.getState().open).toBe(false);

    act(() => {
      useSurfaceFindStore
        .getState()
        .unregisterController(
          useSurfaceFindStore.getState().controllers['chat:c1'].controller,
        );
    });
    const unclaimed = cmdF(document.body);
    expect(unclaimed.defaultPrevented).toBe(false);
    expect(useSurfaceFindStore.getState().open).toBe(false);
  });
});
