/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { SurfaceFindHost } from '../SurfaceFindHost';
import {
  useSurfaceFindStore,
  type FindController,
} from '../surface-find-store';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function register(
  mode: FindController['mode'],
  scopeKey: string,
  anchor: HTMLElement,
  title: string = scopeKey,
): FindController {
  const controller: FindController = {
    mode,
    scopeKey,
    title,
    anchor,
    setQuery: jest.fn(),
    next: jest.fn(),
    previous: jest.fn(),
    close: jest.fn(),
  };
  useSurfaceFindStore.getState().registerController(controller);
  return controller;
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('SurfaceFindHost', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => {
      const store = useSurfaceFindStore.getState();
      store.close();
      for (const entry of Object.values(store.controllers)) {
        store.unregisterController(entry.controller);
      }
      useSurfaceFindStore.setState({ rememberedQueries: {} });
    });
    act(() => root.unmount());
    document.body.replaceChildren();
  });

  it('renders nothing while closed', async () => {
    register('chat', 'c1', document.body);
    act(() => root.render(<SurfaceFindHost />));
    await settle();

    expect(
      document.querySelector('[data-testid="surface-find-bar"]'),
    ).toBeNull();
  });

  it('shows the active mode, counts, and available modes', async () => {
    register('chat', 'c1', document.body);
    register('file', 't1', document.body);
    act(() => root.render(<SurfaceFindHost />));
    act(() => {
      useSurfaceFindStore.getState().openFor('file', 't1');
      useSurfaceFindStore.getState().setQuery('needle');
      useSurfaceFindStore.getState().updateControllerState('file', 't1', {
        currentIndex: 1,
        totalCount: 3,
        error: null,
      });
    });
    await settle();

    const input = document.querySelector<HTMLInputElement>(
      '[data-testid="surface-find-bar"] input',
    );
    expect(input?.placeholder).toBe('Search the file.');
    expect(input?.value).toBe('needle');
    expect(document.body.textContent).toContain('2 of 3');
    expect(
      document.querySelector('[data-testid="surface-find-mode-chat"]'),
    ).not.toBeNull();
    expect(
      document.querySelector('[data-testid="surface-find-mode-browser"]'),
    ).toBeNull();

    act(() => {
      document
        .querySelector('[data-testid="surface-find-mode-chat"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(useSurfaceFindStore.getState().mode).toBe('chat');
    expect(input?.placeholder).toBe('Search the chat history.');
  });

  it('keeps a modal file search inside its focus trap and excludes background scopes', async () => {
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    const anchor = document.createElement('div');
    dialog.append(anchor);
    document.body.append(dialog);
    register('chat', 'background', document.body);
    register('file', 'pdf', anchor);
    act(() => root.render(<SurfaceFindHost />));
    act(() => useSurfaceFindStore.getState().openFor('file', 'pdf'));
    await settle();
    expect(
      dialog.querySelector('[data-testid="surface-find-bar"]'),
    ).not.toBeNull();
    expect(
      document.querySelector('[data-testid="surface-find-mode-chat"]'),
    ).toBeNull();
  });

  it('lets the user pick which browser tab the bar searches', async () => {
    register('browser', 'b1', document.body, 'Docs');
    register('browser', 'b2', document.body, 'Local');
    act(() => root.render(<SurfaceFindHost />));
    act(() => useSurfaceFindStore.getState().openFor('browser', 'b1'));
    await settle();

    act(() => {
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="surface-find-scope-browser-b2"]',
        )
        ?.click();
    });

    expect(useSurfaceFindStore.getState().activeScope.browser).toBe('b2');
  });

  it("portals into the searched surface's own document", async () => {
    const other = document.implementation.createHTMLDocument('aux');
    const anchor = other.createElement('div');
    other.body.append(anchor);
    register('chat', 'c1', anchor);
    act(() => root.render(<SurfaceFindHost />));
    act(() => useSurfaceFindStore.getState().openFor('chat', 'c1'));
    await settle();

    expect(
      document.querySelector('[data-testid="surface-find-bar"]'),
    ).toBeNull();
    expect(
      other.querySelector('[data-testid="surface-find-bar"]'),
    ).not.toBeNull();
  });
});
