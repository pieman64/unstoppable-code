/** @jest-environment jsdom */
import { act, useRef, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { PreviewSearchState } from '../../code/file/FilePreviewSearch';
import {
  PanelHostContext,
  PanelVisibilityContext,
} from '../../code/panels/panel-contexts';
import { useSurfaceFindStore } from '../surface-find-store';
import {
  useFilePreviewFindController,
  type FilePreviewFind,
} from '../useFilePreviewFindController';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let latest: FilePreviewFind | null = null;

function Surface({ enabled }: { enabled: boolean }): JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null);
  const find = useFilePreviewFindController({
    enabled,
    scopeKey: 'tab-1',
    title: 'README.md',
    rootRef,
  });
  latest = find;
  return <div ref={rootRef} {...find.surfaceProps} data-testid="surface" />;
}

const store = (): ReturnType<typeof useSurfaceFindStore.getState> =>
  useSurfaceFindStore.getState();

function report(state: Partial<PreviewSearchState>): void {
  act(() => {
    latest?.viewerProps.onPreviewSearchStateChange?.({
      enabled: true,
      open: false,
      queryPresent: false,
      currentIndex: 0,
      totalCount: 0,
      ...state,
    });
  });
}

describe('useFilePreviewFindController', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    latest = null;
  });

  afterEach(() => {
    act(() => root.unmount());
    store().close();
    for (const entry of Object.values(store().controllers)) {
      store().unregisterController(entry.controller);
    }
    useSurfaceFindStore.setState({ rememberedQueries: {} });
    host.remove();
  });

  function render(enabled: boolean): void {
    act(() => root.render(<Surface enabled={enabled} />));
  }

  it('hands the preview search to the bar and registers searchable previews only', () => {
    render(true);
    expect(latest?.viewerProps.previewSearchPresentation).toBe('headless');
    expect(
      host
        .querySelector('[data-find-surface="file"]')
        ?.getAttribute('data-find-scope'),
    ).toBe('tab-1');
    expect(store().hasController('file', 'tab-1')).toBe(false);

    report({ enabled: true });
    expect(store().hasController('file', 'tab-1')).toBe(true);
    expect(store().controllers['file:tab-1']?.title).toBe('README.md');

    report({ enabled: false });
    expect(store().hasController('file', 'tab-1')).toBe(false);

    report({ enabled: true });
    render(false);
    expect(store().hasController('file', 'tab-1')).toBe(false);
  });

  it('drives the controlled query and index from the bar and reports counts back', () => {
    render(true);
    report({ enabled: true });
    act(() => {
      store().openFor('file', 'tab-1');
      store().setQuery('needle');
    });
    expect(latest?.viewerProps.previewSearchControlled).toEqual({
      open: true,
      query: 'needle',
      index: 0,
    });

    report({ enabled: true, currentIndex: 0, totalCount: 3 });
    expect(store().controllerStates['file:tab-1']).toMatchObject({
      currentIndex: 0,
      totalCount: 3,
    });
    act(() => store().next());
    expect(latest?.viewerProps.previewSearchControlled?.index).toBe(1);
    act(() => store().previous());
    act(() => store().previous());
    expect(latest?.viewerProps.previewSearchControlled?.index).toBe(2);

    // Stepping from a stored index past a shrunken count starts over.
    report({ enabled: true, currentIndex: 0, totalCount: 1 });
    act(() => store().next());
    expect(latest?.viewerProps.previewSearchControlled?.index).toBe(0);

    act(() => store().close());
    expect(latest?.viewerProps.previewSearchControlled).toEqual({
      open: false,
      query: '',
      index: 0,
    });
  });

  it('returns focus to the surface root when the bar closes without an opener', () => {
    render(true);
    report({ enabled: true });
    const surface = host.querySelector('[data-find-surface="file"]');
    act(() => store().openFor('file', 'tab-1'));
    act(() => store().close());
    expect(document.activeElement).toBe(surface);
  });

  it('unregisters while its panel tab or page host is hidden', () => {
    const renderIn = (hostVisible: boolean, tabVisible: boolean): void => {
      act(() =>
        root.render(
          <PanelHostContext.Provider
            value={{
              viewMode: 'list',
              viewModeReady: true,
              visible: hostVisible,
            }}
          >
            <PanelVisibilityContext.Provider value={tabVisible}>
              <Surface enabled />
            </PanelVisibilityContext.Provider>
          </PanelHostContext.Provider>,
        ),
      );
    };
    renderIn(true, true);
    report({ enabled: true });
    expect(store().hasController('file', 'tab-1')).toBe(true);
    act(() => store().openFor('file', 'tab-1'));

    renderIn(true, false);
    expect(store().hasController('file', 'tab-1')).toBe(false);
    expect(store().open).toBe(false);

    renderIn(true, true);
    expect(store().hasController('file', 'tab-1')).toBe(true);

    renderIn(false, true);
    expect(store().hasController('file', 'tab-1')).toBe(false);
  });

  it('opens and closes the bar from the preview itself', () => {
    render(true);
    report({ enabled: true });
    act(() => latest?.viewerProps.onPreviewSearchRequest?.('open'));
    expect(store().open).toBe(true);
    expect(store().mode).toBe('file');

    act(() => latest?.viewerProps.onPreviewSearchRequest?.('close'));
    expect(store().open).toBe(false);
  });
});
